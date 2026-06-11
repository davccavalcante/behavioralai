/**
 * Least-squares linear trend over a recent window of (timestamp, value)
 * points. Powers predictive alerts: "if the current trend continues, this
 * feature crosses its critical threshold in N observations / H hours".
 */

export interface TrendPoint {
  /** Epoch milliseconds. */
  readonly t: number;
  readonly value: number;
}

export interface TrendEstimate {
  /** Change per observation. */
  readonly slopePerObservation: number;
  /** Change per hour of wall-clock time. */
  readonly slopePerHour: number;
  /** Value predicted for the next observation. */
  readonly next: number;
  /** Least-squares standard error of the slope (0 for a perfect fit). */
  readonly slopeStdError: number;
  /** |slope| / max(slopeStdError, tiny): significance of the trend. */
  readonly tStatistic: number;
}

/**
 * Fit a least-squares line over the window. Returns undefined with fewer
 * than three points (a trend needs more than a segment).
 */
export function estimateTrend(points: readonly TrendPoint[]): TrendEstimate | undefined {
  const n = points.length;
  if (n < 3) return undefined;

  // Slope per observation index (robust against irregular sampling).
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i += 1) {
    const y = (points[i] as TrendPoint).value;
    sumX += i;
    sumY += y;
    sumXY += i * y;
    sumXX += i * i;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return undefined;
  const slopePerObservation = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slopePerObservation * sumX) / n;
  const next = intercept + slopePerObservation * n;

  // Slope standard error from the residual variance: a trend is only as
  // real as it is distinguishable from the noise around the fitted line.
  const meanX = sumX / n;
  let residualSS = 0;
  let sxx = 0;
  for (let i = 0; i < n; i += 1) {
    const y = (points[i] as TrendPoint).value;
    const fitted = intercept + slopePerObservation * i;
    residualSS += (y - fitted) ** 2;
    sxx += (i - meanX) ** 2;
  }
  const slopeStdError = n > 2 && sxx > 0 ? Math.sqrt(residualSS / (n - 2) / sxx) : 0;
  const tStatistic = Math.abs(slopePerObservation) / Math.max(slopeStdError, 1e-12);

  // Convert to wall-clock rate using the observed window span.
  const first = points[0] as TrendPoint;
  const last = points[n - 1] as TrendPoint;
  const spanMs = last.t - first.t;
  const slopePerHour = spanMs > 0 ? (slopePerObservation * (n - 1) * 3_600_000) / spanMs : 0;

  return { slopePerObservation, slopePerHour, next, slopeStdError, tStatistic };
}

/**
 * Number of observations until `current` reaches `threshold` at the given
 * slope. Undefined when the trend does not point at the threshold.
 */
export function observationsToThreshold(
  current: number,
  threshold: number,
  slopePerObservation: number,
): number | undefined {
  const gap = threshold - current;
  if (slopePerObservation === 0) return undefined;
  const steps = gap / slopePerObservation;
  if (!Number.isFinite(steps) || steps <= 0) return undefined;
  return steps;
}
