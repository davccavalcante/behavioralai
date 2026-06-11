import { AlertDispatcher } from '../alerting/dispatcher.js';
import { buildAttributions } from '../drift/Attribution.js';
import { resolveSensitivity } from '../drift/sensitivity.js';
import { ClosedError, ConfigurationError, StateError } from '../errors.js';
import { extractFeatures } from '../fingerprint/FeatureExtractor.js';
import { Fingerprint } from '../fingerprint/Fingerprint.js';
import type {
  Alert,
  AlertKind,
  AlertPolicy,
  BehavioralAI,
  BehavioralAIOptions,
  DriftReport,
  FeatureName,
  FingerprintSnapshot,
  RadarSnapshot,
  SensitivityConfig,
  Severity,
  StateSnapshot,
  TelemetryListener,
  TrendForecast,
  TurnObservation,
  WarmupConfig,
} from '../types.js';
import { AlertGovernor } from './AlertGovernor.js';
import { Telemetry } from './Telemetry.js';

const DEFAULT_WARMUP: WarmupConfig = { minObservations: 50 };
const DEFAULT_WINDOW_SIZE = 50;
const DEFAULT_MAX_AGENTS = 1000;
const DEFAULT_ALERT_POLICY: AlertPolicy = {
  cooldownMs: 300_000,
  minSeverity: 'warning',
  canary: false,
  notifyRecovery: true,
  notifyForecast: true,
};

const SEVERITY_RANK: Record<Severity, number> = { info: 1, warning: 2, critical: 3 };

/**
 * Create a behavioral observability engine.
 *
 * The engine is a passive observer: `observe()` is synchronous and never
 * performs I/O; alert delivery and state persistence run in the background
 * and surface their outcomes as telemetry events. Nothing this engine does
 * can block, crash, or slow down the agent under observation.
 */
export function createBehavioralAI(options: BehavioralAIOptions = {}): BehavioralAI {
  return new Engine(options);
}

class Engine implements BehavioralAI {
  private readonly sensitivity: SensitivityConfig;
  private readonly warmup: WarmupConfig;
  private readonly windowSize: number;
  private readonly maxAgents: number;
  private readonly policy: AlertPolicy;
  private readonly telemetry = new Telemetry();
  private readonly governor: AlertGovernor;
  private readonly dispatcher: AlertDispatcher;
  private readonly state: BehavioralAIOptions['state'];
  private readonly now: () => number;

  private readonly fingerprints = new Map<string, Fingerprint>();
  private readonly lastReports = new Map<string, DriftReport>();
  private readonly previousForecasts = new Map<string, ReadonlySet<FeatureName>>();
  private readonly createdAt: number;
  private readonly hydration: Promise<void>;
  private observationCount = 0;
  private alertCounter = 0;
  private closed = false;

  constructor(options: BehavioralAIOptions) {
    this.sensitivity = resolveSensitivity(options.sensitivity);
    this.warmup = { ...DEFAULT_WARMUP, ...options.warmup };
    if (this.warmup.minObservations < 1) {
      throw new ConfigurationError('warmup.minObservations must be at least 1.');
    }
    this.windowSize = options.windowSize ?? DEFAULT_WINDOW_SIZE;
    if (!Number.isInteger(this.windowSize) || this.windowSize < 5) {
      throw new ConfigurationError('windowSize must be an integer of at least 5.');
    }
    this.maxAgents = options.maxAgents ?? DEFAULT_MAX_AGENTS;
    if (!Number.isInteger(this.maxAgents) || this.maxAgents < 1) {
      throw new ConfigurationError('maxAgents must be an integer of at least 1.');
    }
    this.policy = { ...DEFAULT_ALERT_POLICY, ...options.alerts };
    this.governor = new AlertGovernor(this.policy);
    this.now = options.now ?? Date.now;
    this.dispatcher = new AlertDispatcher(
      options.channels ?? [],
      this.telemetry,
      options.enrich,
      this.now,
    );
    this.state = options.state;
    this.createdAt = this.now();
    this.hydration = this.hydrate();
  }

  observe(turn: TurnObservation): DriftReport {
    if (this.closed) throw new ClosedError('observe() called after close().');
    if (typeof turn.agentId !== 'string' || turn.agentId.length === 0) {
      throw new ConfigurationError('observe(): `agentId` must be a non-empty string.');
    }

    const timestamp = turn.timestamp ?? this.now();
    let fingerprint = this.fingerprints.get(turn.agentId);
    if (fingerprint === undefined) {
      if (this.fingerprints.size >= this.maxAgents) {
        this.telemetry.emit({
          kind: 'error',
          timestamp,
          agentId: turn.agentId,
          message: `maxAgents (${this.maxAgents}) reached; observation for new agent ignored`,
        });
        return {
          agentId: turn.agentId,
          timestamp,
          status: 'learning',
          behaviorScore: 100,
          severity: 'none',
          findings: [],
          attributions: [],
          forecasts: [],
        };
      }
      fingerprint = new Fingerprint(turn.agentId, this.sensitivity, this.warmup, this.windowSize);
      this.fingerprints.set(turn.agentId, fingerprint);
      this.telemetry.emit({
        kind: 'agent.registered',
        timestamp,
        agentId: turn.agentId,
      });
    }

    const statusBefore = this.lastReports.get(turn.agentId)?.status ?? 'learning';
    const outcome = fingerprint.evaluate(extractFeatures(turn), timestamp);
    this.observationCount += 1;

    const severity = outcome.findings.reduce<Severity | 'none'>((acc, finding) => {
      if (acc === 'none') return finding.severity;
      return SEVERITY_RANK[finding.severity] > SEVERITY_RANK[acc] ? finding.severity : acc;
    }, 'none');

    const report: DriftReport = {
      agentId: turn.agentId,
      timestamp,
      status: outcome.status,
      behaviorScore: outcome.behaviorScore,
      severity,
      findings: outcome.findings,
      attributions: buildAttributions(outcome.deviations, outcome.findings),
      forecasts: outcome.forecasts,
    };
    this.lastReports.set(turn.agentId, report);

    this.telemetry.emit({
      kind: 'observation.recorded',
      timestamp,
      agentId: turn.agentId,
    });
    if (statusBefore === 'learning' && outcome.status === 'ready') {
      this.telemetry.emit({ kind: 'baseline.ready', timestamp, agentId: turn.agentId });
    } else if (outcome.status === 'learning') {
      this.telemetry.emit({ kind: 'baseline.learning', timestamp, agentId: turn.agentId });
    }

    this.processTransitions(report, turn, outcome.findings.length > 0);
    this.processForecasts(report, turn);

    return report;
  }

  fingerprintOf(agentId: string): FingerprintSnapshot | undefined {
    return this.fingerprints.get(agentId)?.snapshot();
  }

  reportOf(agentId: string): DriftReport | undefined {
    return this.lastReports.get(agentId);
  }

  agents(): readonly string[] {
    return [...this.fingerprints.keys()];
  }

  inspect(): RadarSnapshot {
    return {
      createdAt: this.createdAt,
      observations: this.observationCount,
      agents: [...this.fingerprints.values()].map((fingerprint) => fingerprint.snapshot()),
      lastReports: [...this.lastReports.values()],
    };
  }

  on(listener: TelemetryListener): () => void {
    return this.telemetry.on(listener);
  }

  ready(): Promise<void> {
    return this.hydration;
  }

  absorb(agentId: string, feature?: FeatureName): void {
    if (this.closed) throw new ClosedError('absorb() called after close().');
    const fingerprint = this.fingerprints.get(agentId);
    if (fingerprint === undefined) {
      throw new ConfigurationError(`absorb(): unknown agent "${agentId}".`);
    }
    fingerprint.absorb(feature);
    this.telemetry.emit({
      kind: 'baseline.absorbed',
      timestamp: this.now(),
      agentId,
      ...(feature !== undefined ? { feature } : {}),
    });
  }

  async flush(): Promise<void> {
    await this.hydration;
    await this.dispatcher.drain();
    if (this.state !== undefined) {
      const agents: Record<string, unknown> = {};
      for (const [agentId, fingerprint] of this.fingerprints) {
        agents[agentId] = fingerprint.toJSON();
      }
      const snapshot: StateSnapshot = { version: 1, savedAt: this.now(), agents };
      await this.state.save(snapshot);
      this.telemetry.emit({ kind: 'state.persisted', timestamp: this.now() });
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.flush();
    if (this.state !== undefined) await this.state.close();
    this.closed = true;
  }

  private async hydrate(): Promise<void> {
    if (this.state === undefined) return;
    try {
      const snapshot = await this.state.load();
      if (snapshot === undefined) return;
      for (const [agentId, raw] of Object.entries(snapshot.agents)) {
        if (this.fingerprints.has(agentId)) continue;
        this.fingerprints.set(
          agentId,
          Fingerprint.fromJSON(
            raw as Record<string, unknown>,
            this.sensitivity,
            this.warmup,
            this.windowSize,
          ),
        );
      }
      this.telemetry.emit({ kind: 'state.loaded', timestamp: this.now() });
    } catch (cause) {
      this.telemetry.emit({
        kind: 'error',
        timestamp: this.now(),
        message: `state hydration failed: ${cause instanceof StateError ? cause.message : String(cause)}`,
      });
    }
  }

  private processTransitions(
    report: DriftReport,
    turn: TurnObservation,
    hasFindings: boolean,
  ): void {
    let drifted = false;
    let recovered = false;
    const fingerprint = this.fingerprints.get(turn.agentId);
    if (fingerprint === undefined) return;

    // Transitions were computed during evaluate(); re-derive them from the
    // report findings plus the recovery bookkeeping below.
    for (const finding of report.findings) {
      this.telemetry.emit({
        kind: 'drift.detected',
        timestamp: report.timestamp,
        agentId: report.agentId,
        feature: finding.feature,
        severity: finding.severity,
        report,
      });
      if (finding.severity === 'critical') {
        this.telemetry.emit({
          kind: 'baseline.frozen',
          timestamp: report.timestamp,
          agentId: report.agentId,
          feature: finding.feature,
        });
      }
      drifted = true;
    }

    const previous = this.previousSeverityOf(report.agentId);
    if (
      !hasFindings &&
      previous !== undefined &&
      previous !== 'none' &&
      report.severity === 'none'
    ) {
      recovered = true;
      this.telemetry.emit({
        kind: 'drift.recovered',
        timestamp: report.timestamp,
        agentId: report.agentId,
        report,
      });
    }
    this.rememberSeverity(report.agentId, report.severity);

    if (drifted && report.severity !== 'none') {
      this.emitAlert('drift', report.severity, report, turn);
    }
    if (recovered && this.policy.notifyRecovery) {
      this.emitAlert('recovery', 'info', report, turn);
    }
  }

  private processForecasts(report: DriftReport, turn: TurnObservation): void {
    if (report.forecasts.length === 0) {
      this.previousForecasts.set(report.agentId, new Set());
      return;
    }
    const previous = this.previousForecasts.get(report.agentId) ?? new Set<FeatureName>();
    const current = new Set<FeatureName>();
    const fresh: TrendForecast[] = [];
    for (const forecast of report.forecasts) {
      current.add(forecast.feature);
      if (!previous.has(forecast.feature)) fresh.push(forecast);
    }
    this.previousForecasts.set(report.agentId, current);

    if (fresh.length === 0) return;
    for (const forecast of fresh) {
      this.telemetry.emit({
        kind: 'forecast.detected',
        timestamp: report.timestamp,
        agentId: report.agentId,
        feature: forecast.feature,
        report,
      });
    }
    if (this.policy.notifyForecast) {
      this.emitAlert('forecast', 'warning', report, turn);
    }
  }

  private readonly severityMemory = new Map<string, Severity | 'none'>();

  private previousSeverityOf(agentId: string): Severity | 'none' | undefined {
    return this.severityMemory.get(agentId);
  }

  private rememberSeverity(agentId: string, severity: Severity | 'none'): void {
    this.severityMemory.set(agentId, severity);
  }

  private emitAlert(
    kind: AlertKind,
    severity: Severity,
    report: DriftReport,
    turn: TurnObservation,
  ): void {
    this.alertCounter += 1;
    const alert: Alert = {
      id: `${report.agentId}-${kind}-${report.timestamp}-${this.alertCounter}`,
      agentId: report.agentId,
      kind,
      severity,
      title: alertTitle(kind, report.agentId),
      message: alertMessage(kind, report),
      behaviorScore: report.behaviorScore,
      attributions: report.attributions,
      timestamp: report.timestamp,
      ...(turn.metadata !== undefined ? { metadata: turn.metadata } : {}),
    };

    const decision = this.governor.decide(alert, this.now());
    if (!decision.allow) {
      this.telemetry.emit({
        kind: 'alert.suppressed',
        timestamp: report.timestamp,
        agentId: report.agentId,
        severity,
        alert,
        ...(decision.reason !== undefined ? { message: decision.reason } : {}),
      });
      return;
    }
    this.dispatcher.dispatch(alert);
  }
}

function alertTitle(kind: AlertKind, agentId: string): string {
  switch (kind) {
    case 'drift':
      return `Behavioral drift detected: ${agentId}`;
    case 'recovery':
      return `Behavior recovered: ${agentId}`;
    case 'forecast':
      return `Behavioral trend warning: ${agentId}`;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function alertMessage(kind: AlertKind, report: DriftReport): string {
  if (kind === 'recovery') {
    return `Agent "${report.agentId}" returned to its learned baseline (behavior score ${report.behaviorScore}/100).`;
  }
  if (kind === 'forecast') {
    const lines = report.forecasts.map((forecast) => forecast.summary);
    return lines.join(' | ');
  }
  const lines = report.attributions.slice(0, 3).map((attribution) => attribution.summary);
  const header = `Behavior score ${report.behaviorScore}/100.`;
  return lines.length === 0 ? header : `${header} ${lines.join(' | ')}`;
}
