import { CategoricalDistribution } from '../stats/CategoricalDistribution.js';
import { Ewma } from '../stats/Ewma.js';
import { P2Quantile } from '../stats/P2Quantile.js';
import { PageHinkley } from '../stats/PageHinkley.js';
import { rateShiftZ } from '../stats/RateTest.js';
import { RingBuffer } from '../stats/RingBuffer.js';
import {
  estimateTrend,
  observationsToThreshold,
  type TrendPoint,
} from '../stats/TrendForecaster.js';
import { Welford } from '../stats/Welford.js';
import type {
  AgentId,
  BaselineStatus,
  CategoricalFeatureName,
  CategoricalFeatureSnapshot,
  DriftDirection,
  DriftFinding,
  FeatureName,
  FingerprintSnapshot,
  NumericFeatureName,
  NumericFeatureSnapshot,
  SensitivityConfig,
  Severity,
  TrendForecast,
  WarmupConfig,
} from '../types.js';
import type { ExtractedFeatures } from './FeatureExtractor.js';

/** Consecutive in-range evaluations required before a drifted feature recovers. */
const RECOVERY_STREAK = 5;
/**
 * Consecutive out-of-range evaluations required before a finding opens.
 * Suppresses single-observation blips (a 3-sigma turn happens by chance
 * roughly every four hundred evaluations). There is no single-observation
 * bypass: even extreme one-turn outliers wait for the second evaluation,
 * which keeps heavy-tailed features (real latency) from paging anyone on
 * one sample. A Page-Hinkley confirmed shift opens immediately because the
 * detector itself integrates evidence across many observations.
 */
const OPEN_STREAK = 2;
/**
 * Bounded-rate features (values in [0, 1] dominated by rare events). A point
 * z-score is meaningless for these: one error against a 2 percent baseline
 * looks like a 7-sigma outlier. They are evaluated with an exact one-sided
 * binomial tail test on the window count instead (see stats/RateTest).
 */
const RATE_FEATURES: ReadonlySet<NumericFeatureName> = new Set(['errorRate', 'toolFailureRate']);
/** Hard cap applied to every z-score so near-constant baselines stay bounded. */
const Z_CAP = 50;
/** Minimum window points before a trend is estimated. */
const MIN_TREND_POINTS = 8;
/** Forecast horizon: only projections within this many hours are reported. */
const FORECAST_HORIZON_HOURS = 24;
/** Minimum trend significance (|slope| / slope standard error) to forecast. */
const FORECAST_MIN_T = 4;
/** Recovery hysteresis: in-range evaluations count only below this fraction of warning. */
const RECOVERY_BAND = 0.7;
/** Smoothing factor for the published behavior score. */
const SCORE_ALPHA = 0.2;

type ActiveSeverity = Severity | 'none';

const SEVERITY_RANK: Record<ActiveSeverity, number> = {
  none: 0,
  info: 1,
  warning: 2,
  critical: 3,
};

interface NumericTrack {
  readonly welford: Welford;
  readonly ewma: Ewma;
  readonly p50: P2Quantile;
  readonly p95: P2Quantile;
  readonly p99: P2Quantile;
  readonly pageHinkley: PageHinkley;
  readonly window: RingBuffer<TrendPoint>;
  severity: ActiveSeverity;
  consecutiveNormal: number;
  pendingStreak: number;
  frozen: boolean;
}

interface CategoricalTrack {
  readonly dist: CategoricalDistribution;
  severity: ActiveSeverity;
  consecutiveNormal: number;
  pendingStreak: number;
  frozen: boolean;
}

/** A feature-level state transition produced by one evaluation. */
export interface FeatureTransition {
  readonly feature: FeatureName;
  readonly from: ActiveSeverity;
  readonly to: ActiveSeverity;
}

/** Outcome of evaluating one observation against the fingerprint. */
export interface EvaluationOutcome {
  readonly status: BaselineStatus;
  readonly findings: readonly DriftFinding[];
  readonly transitions: readonly FeatureTransition[];
  readonly forecasts: readonly TrendForecast[];
  /** Per-feature normalized deviations used for the behavior score. */
  readonly deviations: ReadonlyMap<FeatureName, number>;
  readonly behaviorScore: number;
}

/**
 * Per-agent learned behavioral profile: one statistical track per observed
 * feature, drift state machines with hysteresis, baseline freezing under
 * critical drift (so anomalies never poison the baseline), and linear trend
 * projection for predictive alerts.
 */
export class Fingerprint {
  private readonly numeric = new Map<NumericFeatureName, NumericTrack>();
  private readonly categorical = new Map<CategoricalFeatureName, CategoricalTrack>();
  /** EWMA of the per-evaluation deviation index backing the behavior score. */
  private scoreIndex = 0;
  private observationCount = 0;
  private firstSeenAt = 0;
  private lastSeenAt = 0;

  constructor(
    readonly agentId: AgentId,
    private readonly sensitivity: SensitivityConfig,
    private readonly warmup: WarmupConfig,
    private readonly windowSize: number,
  ) {}

  get observations(): number {
    return this.observationCount;
  }

  get status(): BaselineStatus {
    return this.observationCount >= this.warmup.minObservations ? 'ready' : 'learning';
  }

  /** Ingest one extracted feature vector and evaluate drift. */
  evaluate(features: ExtractedFeatures, timestamp: number): EvaluationOutcome {
    if (this.observationCount === 0) this.firstSeenAt = timestamp;
    this.lastSeenAt = timestamp;
    this.observationCount += 1;
    // Status is computed after ingestion so the warmup boundary observation
    // is the first one evaluated against the completed baseline.
    const learning = this.observationCount <= this.warmup.minObservations;

    const findings: DriftFinding[] = [];
    const transitions: FeatureTransition[] = [];
    const deviations = new Map<FeatureName, number>();

    for (const [feature, value] of features.numeric) {
      const track = this.numericTrack(feature);
      if (learning) {
        this.absorbNumeric(track, value, timestamp);
        continue;
      }
      this.evaluateNumeric(feature, track, value, timestamp, findings, transitions, deviations);
    }

    this.evaluateCategorical(
      'toolSelection',
      features.toolSelection,
      learning,
      findings,
      transitions,
      deviations,
    );
    this.evaluateCategorical(
      'finishReason',
      features.finishReason === undefined ? [] : [features.finishReason],
      learning,
      findings,
      transitions,
      deviations,
    );

    const forecasts = learning ? [] : this.buildForecasts();
    // The published score smooths the instantaneous deviation index so a
    // single noisy turn cannot crater an otherwise healthy reading, while
    // genuine drift (sustained, multi-feature) pulls it down within one or
    // two evaluations.
    let sumSquares = 0;
    for (const value of deviations.values()) sumSquares += value * value;
    const instantIndex = deviations.size === 0 ? 0 : Math.sqrt(sumSquares / deviations.size);
    this.scoreIndex += SCORE_ALPHA * (instantIndex - this.scoreIndex);
    const behaviorScore = Math.round(100 * Math.exp(-this.scoreIndex));

    return {
      status: learning ? 'learning' : 'ready',
      findings,
      transitions,
      forecasts,
      deviations,
      behaviorScore,
    };
  }

  /** Accept current behavior as the new normal for one or all features. */
  absorb(feature?: FeatureName): void {
    if (feature === undefined) {
      for (const name of this.numeric.keys()) this.absorbNumericWindow(name);
      for (const name of this.categorical.keys()) this.absorbCategoricalWindow(name);
      return;
    }
    if (isCategorical(feature)) {
      this.absorbCategoricalWindow(feature);
    } else {
      this.absorbNumericWindow(feature);
    }
  }

  snapshot(): FingerprintSnapshot {
    const numeric: NumericFeatureSnapshot[] = [];
    for (const [feature, track] of this.numeric) {
      numeric.push({
        feature,
        count: track.welford.count,
        mean: track.welford.mean,
        stdDev: track.welford.stdDev,
        ewmaMean: track.ewma.mean,
        ewmaStdDev: track.ewma.stdDev,
        p50: track.p50.value,
        p95: track.p95.value,
        p99: track.p99.value,
        min: track.welford.min,
        max: track.welford.max,
      });
    }
    const categorical: CategoricalFeatureSnapshot[] = [];
    for (const [feature, track] of this.categorical) {
      categorical.push({
        feature,
        count: track.dist.baselineSamples,
        baseline: track.dist.baseline(),
        recent: track.dist.recent(),
        divergence: track.dist.divergence(),
      });
    }
    const frozen: FeatureName[] = [];
    for (const [feature, track] of this.numeric) if (track.frozen) frozen.push(feature);
    for (const [feature, track] of this.categorical) if (track.frozen) frozen.push(feature);

    return {
      agentId: this.agentId,
      status: this.status,
      observations: this.observationCount,
      firstSeen: this.firstSeenAt,
      lastSeen: this.lastSeenAt,
      numeric,
      categorical,
      frozen,
    };
  }

  toJSON(): Record<string, unknown> {
    const numeric: Record<string, unknown> = {};
    for (const [feature, track] of this.numeric) {
      numeric[feature] = {
        welford: track.welford.toJSON(),
        ewma: track.ewma.toJSON(),
        p50: track.p50.toJSON(),
        p95: track.p95.toJSON(),
        p99: track.p99.toJSON(),
        pageHinkley: track.pageHinkley.toJSON(),
        window: track.window.toArray(),
        severity: track.severity,
        consecutiveNormal: track.consecutiveNormal,
        pendingStreak: track.pendingStreak,
        frozen: track.frozen,
      };
    }
    const categorical: Record<string, unknown> = {};
    for (const [feature, track] of this.categorical) {
      categorical[feature] = {
        dist: track.dist.toJSON(),
        severity: track.severity,
        consecutiveNormal: track.consecutiveNormal,
        pendingStreak: track.pendingStreak,
        frozen: track.frozen,
      };
    }
    return {
      agentId: this.agentId,
      observations: this.observationCount,
      firstSeen: this.firstSeenAt,
      lastSeen: this.lastSeenAt,
      scoreIndex: this.scoreIndex,
      numeric,
      categorical,
    };
  }

  static fromJSON(
    data: Record<string, unknown>,
    sensitivity: SensitivityConfig,
    warmup: WarmupConfig,
    windowSize: number,
  ): Fingerprint {
    const fp = new Fingerprint(String(data.agentId), sensitivity, warmup, windowSize);
    fp.observationCount = Number(data.observations ?? 0);
    fp.firstSeenAt = Number(data.firstSeen ?? 0);
    fp.lastSeenAt = Number(data.lastSeen ?? 0);
    fp.scoreIndex = Number(data.scoreIndex ?? 0);

    const numeric = (data.numeric ?? {}) as Record<
      string,
      {
        welford: ReturnType<Welford['toJSON']>;
        ewma: ReturnType<Ewma['toJSON']>;
        p50: ReturnType<P2Quantile['toJSON']>;
        p95: ReturnType<P2Quantile['toJSON']>;
        p99: ReturnType<P2Quantile['toJSON']>;
        pageHinkley: ReturnType<PageHinkley['toJSON']>;
        window: TrendPoint[];
        severity: ActiveSeverity;
        consecutiveNormal: number;
        pendingStreak?: number;
        frozen: boolean;
      }
    >;
    for (const [feature, raw] of Object.entries(numeric)) {
      const track: NumericTrack = {
        welford: Welford.fromJSON(raw.welford),
        ewma: Ewma.fromJSON(raw.ewma),
        p50: P2Quantile.fromJSON(raw.p50),
        p95: P2Quantile.fromJSON(raw.p95),
        p99: P2Quantile.fromJSON(raw.p99),
        pageHinkley: PageHinkley.fromJSON(raw.pageHinkley),
        window: new RingBuffer<TrendPoint>(windowSize),
        severity: raw.severity,
        consecutiveNormal: raw.consecutiveNormal,
        pendingStreak: raw.pendingStreak ?? 0,
        frozen: raw.frozen,
      };
      for (const point of raw.window) track.window.push(point);
      fp.numeric.set(feature as NumericFeatureName, track);
    }

    const categorical = (data.categorical ?? {}) as Record<
      string,
      {
        dist: ReturnType<CategoricalDistribution['toJSON']>;
        severity: ActiveSeverity;
        consecutiveNormal: number;
        pendingStreak?: number;
        frozen: boolean;
      }
    >;
    for (const [feature, raw] of Object.entries(categorical)) {
      fp.categorical.set(feature as CategoricalFeatureName, {
        dist: CategoricalDistribution.fromJSON(raw.dist),
        severity: raw.severity,
        consecutiveNormal: raw.consecutiveNormal,
        pendingStreak: raw.pendingStreak ?? 0,
        frozen: raw.frozen,
      });
    }

    return fp;
  }

  private numericTrack(feature: NumericFeatureName): NumericTrack {
    let track = this.numeric.get(feature);
    if (track === undefined) {
      track = {
        welford: new Welford(),
        ewma: new Ewma(this.sensitivity.ewmaAlpha),
        p50: new P2Quantile(0.5),
        p95: new P2Quantile(0.95),
        p99: new P2Quantile(0.99),
        pageHinkley: new PageHinkley(
          this.sensitivity.pageHinkleyDelta,
          this.sensitivity.pageHinkleyLambda,
        ),
        window: new RingBuffer<TrendPoint>(this.windowSize),
        severity: 'none',
        consecutiveNormal: 0,
        pendingStreak: 0,
        frozen: false,
      };
      this.numeric.set(feature, track);
    }
    return track;
  }

  private categoricalTrack(feature: CategoricalFeatureName): CategoricalTrack {
    let track = this.categorical.get(feature);
    if (track === undefined) {
      track = {
        dist: new CategoricalDistribution(this.windowSize),
        severity: 'none',
        consecutiveNormal: 0,
        pendingStreak: 0,
        frozen: false,
      };
      this.categorical.set(feature, track);
    }
    return track;
  }

  private absorbNumeric(track: NumericTrack, value: number, timestamp: number): void {
    track.welford.push(value);
    track.ewma.push(value);
    track.p50.push(value);
    track.p95.push(value);
    track.p99.push(value);
    track.window.push({ t: timestamp, value });
  }

  private evaluateNumeric(
    feature: NumericFeatureName,
    track: NumericTrack,
    value: number,
    timestamp: number,
    findings: DriftFinding[],
    transitions: FeatureTransition[],
    deviations: Map<FeatureName, number>,
  ): void {
    const isRate = RATE_FEATURES.has(feature);
    let z: number;
    let observed = value;
    let expected: number;

    if (isRate) {
      // Exact binomial tail test (one-sided, harmful direction only): the
      // classic p-chart normal approximation is invalid at np < 5, which is
      // exactly where healthy agents live (a couple of failures per window),
      // and fires on pure chance. The Laplace-smoothed baseline rate keeps a
      // clean (zero-failure) warmup from producing a zero-probability model.
      track.window.push({ t: timestamp, value });
      const points = track.window.toArray();
      let sum = 0;
      for (const point of points) sum += point.value;
      const windowMean = sum / points.length;
      const baseRate = clamp(track.welford.mean, 0, 1);
      const smoothedRate = Math.max(baseRate, 1 / (track.welford.count + 2));
      z = clamp(rateShiftZ(sum, points.length, smoothedRate), 0, Z_CAP);
      observed = windowMean;
      expected = baseRate;
    } else {
      const effStd = effectiveStd(track);
      z = clamp((value - track.ewma.mean) / effStd, -Z_CAP, Z_CAP);
      expected = track.ewma.mean;
    }

    // Sustained-shift detector consumes baseline-standardized samples.
    const longStd = isRate
      ? Math.max(
          Math.sqrt(
            Math.max(track.welford.mean, 1 / (track.welford.count + 2)) *
              (1 - Math.min(track.welford.mean, 1 - 1e-6)),
          ),
          1e-9,
        )
      : Math.max(track.welford.stdDev, 1e-9);
    const zLong = clamp((value - track.welford.mean) / longStd, -Z_CAP, Z_CAP);
    const shift = track.pageHinkley.push(zLong);
    // A Page-Hinkley firing is a confirmed multi-observation changepoint
    // EPISODE: it opens a finding immediately (the detector already
    // integrated evidence across dozens of turns, so the 2-evaluation gate
    // does not apply) and then re-arms. While the baseline keeps absorbing
    // the new level, residual shift re-fires after another accumulation,
    // producing a bounded reminder cadence instead of either silence or a
    // permanent latch.
    if (shift !== undefined) track.pageHinkley.reset();

    const absZ = Math.abs(z);
    let zSeverity: ActiveSeverity = 'none';
    if (absZ >= this.sensitivity.criticalZ) zSeverity = 'critical';
    else if (absZ >= this.sensitivity.warningZ) zSeverity = 'warning';

    let direction: DriftDirection;
    if (z > 0) direction = 'above';
    else if (z < 0) direction = 'below';
    else direction = shift === 'down' ? 'below' : 'above';

    // Score contributions follow the same confirmation philosophy as
    // findings: sub-warning noise is normal behavior and reads as 100;
    // warning-level deviation and above pulls the score down (capped so a
    // single extreme z cannot push the index into absurd territory).
    deviations.set(
      feature,
      zSeverity === 'none'
        ? 0
        : Math.min(3, normalizedDeviation(absZ, 1, this.sensitivity.criticalZ)),
    );

    const previous = track.severity;
    let emitFinding = false;
    let findingSeverity: ActiveSeverity = 'none';
    if (zSeverity !== 'none') {
      track.consecutiveNormal = 0;
      track.pendingStreak += 1;
      // Confirmation: an already-open finding continues; otherwise two
      // consecutive out-of-range evaluations are required (there is no
      // single-observation bypass, so one-sample outliers never open).
      const confirmed = previous !== 'none' || track.pendingStreak >= OPEN_STREAK;
      if (confirmed) {
        emitFinding = true;
        findingSeverity = zSeverity;
        if (SEVERITY_RANK[zSeverity] > SEVERITY_RANK[previous]) {
          track.severity = zSeverity;
          transitions.push({ feature, from: previous, to: zSeverity });
          // Freeze baseline absorption while ANY finding is open (warning
          // included): a drifting agent must not retrain its own normal.
          track.frozen = true;
        }
      }
    } else {
      track.pendingStreak = 0;
      if (previous !== 'none') {
        // Schmitt-trigger hysteresis: recovery only counts evaluations
        // comfortably back inside the band (0.7x warning), so a shift
        // hovering at the threshold cannot flip-flop between open and
        // recovered.
        if (absZ < this.sensitivity.warningZ * RECOVERY_BAND) {
          track.consecutiveNormal += 1;
        } else {
          track.consecutiveNormal = 0;
        }
        if (track.consecutiveNormal >= RECOVERY_STREAK) {
          track.severity = 'none';
          track.consecutiveNormal = 0;
          track.frozen = false;
          track.pageHinkley.reset();
          transitions.push({ feature, from: previous, to: 'none' });
        }
      }
    }
    // A Page-Hinkley episode emits a finding even when the point z-score is
    // unremarkable: the shift was confirmed by accumulation, not by one
    // sample. It deliberately does NOT touch the state machine, so the
    // recency baseline keeps absorbing the new level (adaptive semantics)
    // and no false recovery events are produced; residual shift re-fires
    // after the detector re-accumulates, as a bounded reminder.
    if (shift !== undefined && !emitFinding) {
      emitFinding = true;
      findingSeverity = 'warning';
      deviations.set(
        feature,
        Math.max(
          deviations.get(feature) ?? 0,
          normalizedDeviation(this.sensitivity.warningZ, 1, this.sensitivity.criticalZ),
        ),
      );
    }

    // Baseline absorption: in-band values always absorb (sub-warning blips
    // are part of the real distribution; dropping them would bias variance
    // low). Values at warning level or above never absorb: they are either
    // the start of an incident (freeze imminent) or 1-in-400 outliers whose
    // exclusion is statistically negligible, while absorbing them would
    // pump the EWMA variance and mask the very shift under confirmation.
    if (!track.frozen && zSeverity === 'none') {
      track.welford.push(value);
      track.ewma.push(value);
      track.p50.push(value);
      track.p95.push(value);
      track.p99.push(value);
    }
    // Rate features already pushed their window sample before evaluation.
    if (!isRate) track.window.push({ t: timestamp, value });

    if (emitFinding && findingSeverity !== 'none') {
      findings.push({
        feature,
        severity: findingSeverity as Severity,
        direction,
        score: z,
        observed,
        expected,
        summary: numericSummary(feature, observed, expected, z, direction, shift),
      });
    }
  }

  private evaluateCategorical(
    feature: CategoricalFeatureName,
    samples: readonly string[],
    learning: boolean,
    findings: DriftFinding[],
    transitions: FeatureTransition[],
    deviations: Map<FeatureName, number>,
  ): void {
    if (samples.length === 0) return;
    const track = this.categoricalTrack(feature);

    for (const sample of samples) {
      track.dist.pushRecent(sample);
      if (learning || !track.frozen) track.dist.pushBaseline(sample);
    }
    if (learning) return;

    // Finite-sample bias correction: the expected Jensen-Shannon divergence
    // of a k-category window of n samples drawn from the baseline itself is
    // approximately (k - 1) / (4 n ln 2). Without the correction, agents
    // with many tools eat the warning budget in pure sampling noise, while
    // the thresholds stay comparable across category counts.
    const raw = track.dist.divergence();
    const categories = new Set([
      ...Object.keys(track.dist.baseline()),
      ...Object.keys(track.dist.recent()),
    ]).size;
    const windowSamples = Math.max(track.dist.windowSamples, 1);
    const bias = (categories - 1) / (4 * windowSamples * Math.LN2);
    const divergence = Math.max(0, raw - bias);
    deviations.set(
      feature,
      divergence < this.sensitivity.warningDivergence
        ? 0
        : Math.min(
            3,
            normalizedDeviation(
              divergence,
              this.sensitivity.warningDivergence / 2,
              this.sensitivity.criticalDivergence,
            ),
          ),
    );

    let severity: ActiveSeverity = 'none';
    if (divergence >= this.sensitivity.criticalDivergence) severity = 'critical';
    else if (divergence >= this.sensitivity.warningDivergence) severity = 'warning';

    const previous = track.severity;
    if (severity !== 'none') {
      track.consecutiveNormal = 0;
      track.pendingStreak += 1;
      const confirmed = previous !== 'none' || track.pendingStreak >= OPEN_STREAK;
      if (!confirmed) return;
      if (SEVERITY_RANK[severity] > SEVERITY_RANK[previous]) {
        track.severity = severity;
        transitions.push({ feature, from: previous, to: severity });
        // Freeze baseline absorption while ANY finding is open.
        track.frozen = true;
      }
      findings.push({
        feature,
        severity: severity as Severity,
        direction: 'shifted',
        score: divergence,
        summary: categoricalSummary(feature, divergence, track.dist),
      });
    } else {
      track.pendingStreak = 0;
      if (previous !== 'none') {
        if (divergence < this.sensitivity.warningDivergence * RECOVERY_BAND) {
          track.consecutiveNormal += 1;
        } else {
          track.consecutiveNormal = 0;
        }
        if (track.consecutiveNormal >= RECOVERY_STREAK) {
          track.severity = 'none';
          track.consecutiveNormal = 0;
          track.frozen = false;
          transitions.push({ feature, from: previous, to: 'none' });
        }
      }
    }
  }

  private buildForecasts(): TrendForecast[] {
    const forecasts: TrendForecast[] = [];
    for (const [feature, track] of this.numeric) {
      if (track.severity !== 'none') continue;
      if (track.window.size < MIN_TREND_POINTS) continue;

      const points = track.window.toArray();
      const trend = estimateTrend(points);
      if (trend === undefined || trend.slopePerObservation === 0) continue;
      // Significance gate: stationary noise fits nonzero slopes constantly;
      // only a trend at least four standard errors away from zero is worth
      // a projection. This bounds false forecasts on healthy traffic to a
      // negligible rate while clean ramps (high t) pass immediately.
      if (trend.tStatistic < FORECAST_MIN_T) continue;

      const effStd = effectiveStd(track);
      let threshold =
        trend.slopePerObservation > 0
          ? track.ewma.mean + this.sensitivity.criticalZ * effStd
          : track.ewma.mean - this.sensitivity.criticalZ * effStd;
      // Domain clamps: every current numeric feature is non-negative, and
      // rate features live in [0, 1]. A projection toward an impossible
      // threshold (negative latency, error rate above 1) is meaningless.
      if (RATE_FEATURES.has(feature)) threshold = clamp(threshold, 0, 1);
      if (threshold < 0) continue;
      const last = points[points.length - 1] as TrendPoint;
      if (trend.slopePerObservation > 0 ? last.value >= threshold : last.value <= threshold) {
        continue;
      }
      const steps = observationsToThreshold(last.value, threshold, trend.slopePerObservation);
      if (steps === undefined || steps < 1) continue;

      const hours =
        trend.slopePerHour !== 0 ? (threshold - last.value) / trend.slopePerHour : undefined;
      if (hours === undefined || !Number.isFinite(hours) || hours <= 0) continue;
      if (hours > FORECAST_HORIZON_HOURS) continue;

      forecasts.push({
        feature,
        slopePerObservation: trend.slopePerObservation,
        slopePerHour: trend.slopePerHour,
        observationsToCritical: Math.round(steps),
        hoursToCritical: round2(hours),
        summary: `${feature} is trending ${trend.slopePerObservation > 0 ? 'up' : 'down'} and is projected to cross its critical threshold (${round2(threshold)}) in about ${round2(hours)} h (${Math.round(steps)} observations) if the trend continues`,
      });
    }
    return forecasts;
  }

  private absorbNumericWindow(feature: NumericFeatureName): void {
    const track = this.numeric.get(feature);
    if (track === undefined) return;
    // "Accept the new normal" means the recent window IS the new baseline:
    // rebuild the statistics from scratch so the old regime cannot keep the
    // expected value anchored halfway between the two behaviors.
    const rebuilt: NumericTrack = {
      welford: new Welford(),
      ewma: new Ewma(this.sensitivity.ewmaAlpha),
      p50: new P2Quantile(0.5),
      p95: new P2Quantile(0.95),
      p99: new P2Quantile(0.99),
      pageHinkley: new PageHinkley(
        this.sensitivity.pageHinkleyDelta,
        this.sensitivity.pageHinkleyLambda,
      ),
      window: track.window,
      severity: 'none',
      consecutiveNormal: 0,
      pendingStreak: 0,
      frozen: false,
    };
    for (const point of track.window.toArray()) {
      rebuilt.welford.push(point.value);
      rebuilt.ewma.push(point.value);
      rebuilt.p50.push(point.value);
      rebuilt.p95.push(point.value);
      rebuilt.p99.push(point.value);
    }
    this.numeric.set(feature, rebuilt);
  }

  private absorbCategoricalWindow(feature: CategoricalFeatureName): void {
    const track = this.categorical.get(feature);
    if (track === undefined) return;
    track.dist.absorbWindow();
    track.severity = 'none';
    track.consecutiveNormal = 0;
    track.frozen = false;
  }
}

function effectiveStd(track: NumericTrack): number {
  return Math.max(track.ewma.stdDev, track.welford.stdDev * 0.25, 1e-9);
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function isCategorical(feature: FeatureName): feature is CategoricalFeatureName {
  return feature === 'toolSelection' || feature === 'finishReason';
}

/**
 * Composite health: 100 at baseline, decaying with multivariate deviation.
 * Inputs are deviations normalized by the critical threshold AFTER a noise
 * deadband (see {@link normalizedDeviation}), so ordinary statistical noise
 * (sub-sigma fluctuation on every feature) reads as 100, not as a permanent
 * 80-90 (expected |z| of healthy gaussian noise is about 0.8).
 */
export function computeBehaviorScore(deviations: ReadonlyMap<FeatureName, number>): number {
  if (deviations.size === 0) return 100;
  let sumSquares = 0;
  for (const value of deviations.values()) {
    sumSquares += value * value;
  }
  const index = Math.sqrt(sumSquares / deviations.size);
  return Math.round(100 * Math.exp(-index));
}

/**
 * Deadband-normalized deviation: zero below one sigma (or below half the
 * categorical warning divergence), then linear so the critical threshold
 * maps to 1.
 */
export function normalizedDeviation(raw: number, deadband: number, critical: number): number {
  if (critical <= deadband) return raw >= critical ? 1 : 0;
  return Math.max(0, (raw - deadband) / (critical - deadband));
}

function numericSummary(
  feature: NumericFeatureName,
  observed: number,
  expected: number,
  z: number,
  direction: DriftDirection,
  shift: 'up' | 'down' | undefined,
): string {
  const base = `${feature} is ${direction} baseline: observed ${round2(observed)} vs expected ${round2(expected)} (z=${round2(z)})`;
  return shift === undefined ? base : `${base}, sustained mean shift confirmed`;
}

function categoricalSummary(
  feature: CategoricalFeatureName,
  divergence: number,
  dist: CategoricalDistribution,
): string {
  const recent = Object.entries(dist.recent())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, share]) => `${name} ${Math.round(share * 100)}%`)
    .join(', ');
  return `${feature} distribution shifted (JSD=${round2(divergence)}); recent mix: ${recent}`;
}
