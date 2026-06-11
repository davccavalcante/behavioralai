/**
 * @takk/behavioralai - public type contracts.
 *
 * Behavioral AI learns a per-agent behavioral fingerprint from production
 * observations and detects statistical drift in real time, before any
 * visible failure. These types are the stable public surface documented
 * in SPEC.md; SemVer applies to every exported name in this file.
 *
 * @module
 */

/** Opaque identifier of an observed unit (agent, skill, gateway, MCP server). */
export type AgentId = string;

/** One tool invocation inside a turn. */
export interface ToolCallRecord {
  /** Tool name as invoked, for example "web_search" or "mcp:filesystem/read". */
  readonly name: string;
  /** Whether the call completed without error. */
  readonly ok: boolean;
  /** Wall-clock duration of the call, milliseconds. */
  readonly latencyMs?: number;
}

/**
 * One observed turn of one agent. Every field except `agentId` is optional:
 * the engine fingerprints whatever dimensions you provide and ignores the
 * rest. Provide the same dimensions consistently for the baseline to learn.
 */
export interface TurnObservation {
  /**
   * Which behavioral profile this observation belongs to. Use plain agent
   * names ("support-agent") or namespaced units ("skill:summarize",
   * "gateway:openrouter", "mcp:filesystem") to fingerprint skills, gateways,
   * and MCP servers as first-class observed entities.
   */
  readonly agentId: AgentId;
  /** Epoch milliseconds. Defaults to the current clock. */
  readonly timestamp?: number;
  /** End-to-end turn latency, milliseconds. */
  readonly latencyMs?: number;
  /** Cost attributed to this turn, US dollars. */
  readonly costUsd?: number;
  /** Prompt-side token count. */
  readonly inputTokens?: number;
  /** Completion-side token count. */
  readonly outputTokens?: number;
  /** Tokens occupied by the context window at request time. */
  readonly contextTokens?: number;
  /** Number of retrieval chunks injected into the context. */
  readonly retrievalChunks?: number;
  /** Tool invocations made during the turn. */
  readonly toolCalls?: readonly ToolCallRecord[];
  /** Zero-based index of the turn inside its task or session. */
  readonly turnIndex?: number;
  /** Task or session correlation id. */
  readonly taskId?: string;
  /** Provider finish reason, for example "stop", "length", "tool-calls". */
  readonly finishReason?: string;
  /** Marks the turn as failed; a string carries the error class. */
  readonly error?: boolean | string;
  /** Free-form string metadata, copied into alerts. */
  readonly metadata?: Readonly<Record<string, string>>;
}

/** Numeric behavioral dimensions derived from a {@link TurnObservation}. */
export type NumericFeatureName =
  | 'latencyMs'
  | 'costUsd'
  | 'inputTokens'
  | 'outputTokens'
  | 'totalTokens'
  | 'contextTokens'
  | 'contextSnr'
  | 'retrievalChunks'
  | 'toolCallCount'
  | 'toolFailureRate'
  | 'turnIndex'
  | 'errorRate';

/** Categorical behavioral dimensions derived from a {@link TurnObservation}. */
export type CategoricalFeatureName = 'toolSelection' | 'finishReason';

/** Every feature the engine can fingerprint. */
export type FeatureName = NumericFeatureName | CategoricalFeatureName;

/** Learning status of one agent fingerprint. */
export type BaselineStatus = 'learning' | 'ready';

/** Severity ladder used across drift findings and alerts. */
export type Severity = 'info' | 'warning' | 'critical';

/** Why an alert was emitted. */
export type AlertKind = 'drift' | 'recovery' | 'forecast';

/** Direction of a drifted feature relative to its learned baseline. */
export type DriftDirection = 'above' | 'below' | 'shifted';

/** Learned statistics for one numeric feature. */
export interface NumericFeatureSnapshot {
  readonly feature: NumericFeatureName;
  /** Observations absorbed into this baseline. */
  readonly count: number;
  /** Long-run mean (Welford). */
  readonly mean: number;
  /** Long-run standard deviation (Welford). */
  readonly stdDev: number;
  /** Recency-weighted mean (EWMA). */
  readonly ewmaMean: number;
  /** Recency-weighted standard deviation. */
  readonly ewmaStdDev: number;
  /** Streaming quantile estimates (P-square). */
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  /** Minimum and maximum ever observed. */
  readonly min: number;
  readonly max: number;
}

/** Learned distribution for one categorical feature. */
export interface CategoricalFeatureSnapshot {
  readonly feature: CategoricalFeatureName;
  readonly count: number;
  /** Category frequencies in the learned baseline, normalized to 1. */
  readonly baseline: Readonly<Record<string, number>>;
  /** Category frequencies in the recent window, normalized to 1. */
  readonly recent: Readonly<Record<string, number>>;
  /** Jensen-Shannon divergence between recent window and baseline, 0..1. */
  readonly divergence: number;
}

/** Full learned fingerprint of one agent. */
export interface FingerprintSnapshot {
  readonly agentId: AgentId;
  readonly status: BaselineStatus;
  /** Total observations ingested for this agent. */
  readonly observations: number;
  /** Epoch ms of the first and the most recent observation. */
  readonly firstSeen: number;
  readonly lastSeen: number;
  readonly numeric: readonly NumericFeatureSnapshot[];
  readonly categorical: readonly CategoricalFeatureSnapshot[];
  /** Features currently frozen against baseline absorption (active drift). */
  readonly frozen: readonly FeatureName[];
}

/** Contribution of one feature to a detected deviation. */
export interface FeatureAttribution {
  readonly feature: FeatureName;
  /** Normalized contribution to the overall deviation, 0..1. */
  readonly contribution: number;
  /** Robust z-score for numeric features; scaled divergence for categorical. */
  readonly score: number;
  readonly direction: DriftDirection;
  /** Observed recent value (numeric features). */
  readonly observed?: number;
  /** Learned baseline value the observation deviated from. */
  readonly expected?: number;
  /** Human-readable one-line explanation. */
  readonly summary: string;
}

/** Linear-trend projection for one feature (predictive alerting). */
export interface TrendForecast {
  readonly feature: NumericFeatureName;
  /** Estimated change per observation (least-squares slope). */
  readonly slopePerObservation: number;
  /** Estimated change per hour, derived from observed throughput. */
  readonly slopePerHour: number;
  /**
   * Estimated number of observations until the feature crosses the critical
   * threshold if the current trend continues; undefined when the trend does
   * not point at the threshold.
   */
  readonly observationsToCritical?: number;
  /** Same projection expressed in hours; undefined when not applicable. */
  readonly hoursToCritical?: number;
  readonly summary: string;
}

/** One drifted (or recovered) feature inside a report. */
export interface DriftFinding {
  readonly feature: FeatureName;
  readonly severity: Severity;
  readonly direction: DriftDirection;
  /** Robust z-score (numeric) or scaled Jensen-Shannon divergence (categorical). */
  readonly score: number;
  readonly observed?: number;
  readonly expected?: number;
  readonly summary: string;
}

/** Result of evaluating one observation against the learned fingerprint. */
export interface DriftReport {
  readonly agentId: AgentId;
  readonly timestamp: number;
  readonly status: BaselineStatus;
  /**
   * Composite behavior health, 0..100. 100 means indistinguishable from the
   * learned baseline; lower values mean stronger multivariate deviation.
   */
  readonly behaviorScore: number;
  readonly severity: Severity | 'none';
  readonly findings: readonly DriftFinding[];
  readonly attributions: readonly FeatureAttribution[];
  readonly forecasts: readonly TrendForecast[];
}

/** Alert payload delivered to channels. */
export interface Alert {
  /** Stable identifier, suitable for deduplication on the receiving side. */
  readonly id: string;
  readonly agentId: AgentId;
  readonly kind: AlertKind;
  readonly severity: Severity;
  readonly title: string;
  readonly message: string;
  readonly behaviorScore: number;
  readonly attributions: readonly FeatureAttribution[];
  readonly timestamp: number;
  readonly metadata?: Readonly<Record<string, string>>;
}

/** Outcome of one channel delivery attempt. */
export interface ChannelResult {
  readonly channel: string;
  readonly ok: boolean;
  /** HTTP status or transport code when available. */
  readonly status?: number;
  readonly error?: string;
}

/** A delivery target for alerts. Implementations live in `/channels` and `/smtp`. */
export interface AlertChannel {
  /** Stable channel name used in telemetry and results, e.g. "slack". */
  readonly name: string;
  /** Deliver one alert. Must never throw; report failure via the result. */
  send(alert: Alert): Promise<ChannelResult>;
}

/** Optional asynchronous alert transformer (used by `/integrations`). */
export type AlertEnricher = (alert: Alert) => Promise<Alert>;

/** Sensitivity presets mapping to statistical thresholds. */
export type SensitivityPreset = 'strict' | 'balanced' | 'relaxed';

/** Fully resolved sensitivity thresholds. */
export interface SensitivityConfig {
  /** Robust z-score that opens a warning finding. */
  readonly warningZ: number;
  /** Robust z-score that opens a critical finding. */
  readonly criticalZ: number;
  /** Jensen-Shannon divergence (0..1) that opens a warning finding. */
  readonly warningDivergence: number;
  /** Jensen-Shannon divergence (0..1) that opens a critical finding. */
  readonly criticalDivergence: number;
  /** EWMA smoothing factor for the recency-weighted baseline, 0..1. */
  readonly ewmaAlpha: number;
  /** Page-Hinkley delta (tolerated drift per step). */
  readonly pageHinkleyDelta: number;
  /** Page-Hinkley lambda (cumulative deviation that confirms a mean shift). */
  readonly pageHinkleyLambda: number;
}

/** Warmup policy before drift evaluation starts. */
export interface WarmupConfig {
  /** Observations required per agent before findings are emitted. */
  readonly minObservations: number;
}

/** Alert governor policy. */
export interface AlertPolicy {
  /** Minimum interval between alerts for the same agent and feature, ms. */
  readonly cooldownMs: number;
  /** Lowest severity that is dispatched to channels. */
  readonly minSeverity: Severity;
  /**
   * Canary mode: evaluate and record everything, emit telemetry, but never
   * dispatch to external channels. Recommended for the first days in
   * production while sensitivity is tuned.
   */
  readonly canary: boolean;
  /** Emit recovery alerts when a previously drifted feature normalizes. */
  readonly notifyRecovery: boolean;
  /** Emit forecast alerts when a trend projects a critical crossing. */
  readonly notifyForecast: boolean;
}

/** Persisted state snapshot, versioned for forward migration. */
export interface StateSnapshot {
  readonly version: 1;
  readonly savedAt: number;
  readonly agents: Readonly<Record<string, unknown>>;
}

/** Pluggable persistence for learned baselines. */
export interface StateBackend {
  load(): Promise<StateSnapshot | undefined>;
  save(snapshot: StateSnapshot): Promise<void>;
  close(): Promise<void>;
}

/** Telemetry event kinds emitted by the engine. */
export type TelemetryEventKind =
  | 'observation.recorded'
  | 'agent.registered'
  | 'baseline.learning'
  | 'baseline.ready'
  | 'baseline.frozen'
  | 'baseline.absorbed'
  | 'drift.detected'
  | 'drift.recovered'
  | 'forecast.detected'
  | 'alert.dispatched'
  | 'alert.suppressed'
  | 'alert.failed'
  | 'state.loaded'
  | 'state.persisted'
  | 'error';

/** Discriminated telemetry event. */
export interface TelemetryEvent {
  readonly kind: TelemetryEventKind;
  readonly timestamp: number;
  readonly agentId?: AgentId;
  readonly feature?: FeatureName;
  readonly severity?: Severity;
  readonly channel?: string;
  readonly message?: string;
  readonly report?: DriftReport;
  readonly alert?: Alert;
}

/** Telemetry listener; returns nothing, must not throw. */
export type TelemetryListener = (event: TelemetryEvent) => void;

/** Options accepted by {@link createBehavioralAI}. */
export interface BehavioralAIOptions {
  /** Sensitivity preset or fully resolved thresholds. Default "balanced". */
  readonly sensitivity?: SensitivityPreset | Partial<SensitivityConfig>;
  /** Warmup policy. Default 50 observations per agent. */
  readonly warmup?: Partial<WarmupConfig>;
  /** Alert governor policy overrides. */
  readonly alerts?: Partial<AlertPolicy>;
  /** Delivery channels for alerts. Default none (telemetry only). */
  readonly channels?: readonly AlertChannel[];
  /** Optional alert enricher applied before dispatch. */
  readonly enrich?: AlertEnricher;
  /** Persistence backend for baselines. Default in-memory only. */
  readonly state?: StateBackend;
  /** Size of the recent window used for categorical and trend analysis. */
  readonly windowSize?: number;
  /**
   * Cardinality guard: maximum number of distinct agent profiles. Above the
   * cap, observations for NEW agents are ignored (an `error` telemetry
   * event is emitted and a learning-status report returned) so unbounded
   * id spaces (for example auto-created `tool:` profiles from spans) cannot
   * grow memory forever. Default 1000.
   */
  readonly maxAgents?: number;
  /** Clock override for deterministic tests. */
  readonly now?: () => number;
}

/** Engine-wide introspection snapshot. */
export interface RadarSnapshot {
  readonly createdAt: number;
  readonly observations: number;
  readonly agents: readonly FingerprintSnapshot[];
  readonly lastReports: readonly DriftReport[];
}

/** The behavioral observability engine. */
export interface BehavioralAI {
  /**
   * Ingest one turn observation and synchronously evaluate it against the
   * agent's learned fingerprint. Alert dispatch happens asynchronously.
   */
  observe(turn: TurnObservation): DriftReport;
  /** Learned fingerprint of one agent, if it exists. */
  fingerprintOf(agentId: AgentId): FingerprintSnapshot | undefined;
  /** Most recent drift report of one agent, if any. */
  reportOf(agentId: AgentId): DriftReport | undefined;
  /** All known agent ids. */
  agents(): readonly AgentId[];
  /** Full engine snapshot. */
  inspect(): RadarSnapshot;
  /** Subscribe to telemetry. Returns an unsubscribe function. */
  on(listener: TelemetryListener): () => void;
  /**
   * Resolves once state hydration from the configured backend completed.
   * Immediate no-op when no backend is configured. Observations made before
   * hydration are preserved; hydration only restores agents not yet seen.
   */
  ready(): Promise<void>;
  /**
   * Accept the current behavior as the new normal: unfreeze and fold the
   * recent window into the baseline for one feature or for all features.
   */
  absorb(agentId: AgentId, feature?: FeatureName): void;
  /** Persist state (if a backend is configured) and flush pending alerts. */
  flush(): Promise<void>;
  /** Flush and release resources. */
  close(): Promise<void>;
}
