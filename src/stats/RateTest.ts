/**
 * Exact one-sided binomial tail test for bounded-rate features, expressed
 * as an equivalent z-score. The normal approximation behind a classic
 * p-chart is invalid in the regime agents actually live in (np < 5: a few
 * errors in a 30-turn window), where it fires on pure chance; the exact
 * tail is correct at any n and p.
 */

/** Natural log of n choose k. */
function logChoose(n: number, k: number): number {
  let sum = 0;
  for (let i = 1; i <= k; i += 1) {
    sum += Math.log(n - k + i) - Math.log(i);
  }
  return sum;
}

/** P(X >= k) for X ~ Binomial(n, p), exact summation. */
export function binomialUpperTail(k: number, n: number, p: number): number {
  if (k <= 0) return 1;
  if (k > n) return 0;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let tail = 0;
  const logP = Math.log(p);
  const logQ = Math.log(1 - p);
  for (let i = k; i <= n; i += 1) {
    tail += Math.exp(logChoose(n, i) + i * logP + (n - i) * logQ);
  }
  return Math.min(1, tail);
}

/**
 * Inverse standard normal CDF (Acklam's rational approximation, absolute
 * error below 1.15e-9), used to express a binomial tail probability as the
 * equivalent z-score so rate features share thresholds with everything
 * else.
 */
export function inverseNormalCdf(prob: number): number {
  const p = Math.min(Math.max(prob, 1e-300), 1 - 1e-16);
  const a = [
    -39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472,
    2.50662827745924,
  ];
  const b = [
    -54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857,
  ];
  const c = [
    -0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373,
    4.37466414146497, 2.93816398269878,
  ];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const low = 0.02425;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      ((((((c[0] as number) * q + (c[1] as number)) * q + (c[2] as number)) * q +
        (c[3] as number)) *
        q +
        (c[4] as number)) *
        q +
        (c[5] as number)) /
      (((((d[0] as number) * q + (d[1] as number)) * q + (d[2] as number)) * q + (d[3] as number)) *
        q +
        1)
    );
  }
  if (p > 1 - low) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(
      ((((((c[0] as number) * q + (c[1] as number)) * q + (c[2] as number)) * q +
        (c[3] as number)) *
        q +
        (c[4] as number)) *
        q +
        (c[5] as number)) /
      (((((d[0] as number) * q + (d[1] as number)) * q + (d[2] as number)) * q + (d[3] as number)) *
        q +
        1)
    );
  }
  const q = p - 0.5;
  const r = q * q;
  return (
    (((((((a[0] as number) * r + (a[1] as number)) * r + (a[2] as number)) * r + (a[3] as number)) *
      r +
      (a[4] as number)) *
      r +
      (a[5] as number)) *
      q) /
    ((((((b[0] as number) * r + (b[1] as number)) * r + (b[2] as number)) * r + (b[3] as number)) *
      r +
      (b[4] as number)) *
      r +
      1)
  );
}

/**
 * Equivalent z for an observed failure count in a window against a baseline
 * rate: z = Phi^-1(1 - P(X >= k)). Returns 0 when the observation is at or
 * below expectation (rates are alerted on the harmful direction only).
 */
export function rateShiftZ(observedCount: number, windowSize: number, baseRate: number): number {
  const k = Math.ceil(observedCount - 1e-9);
  if (k <= 0) return 0;
  const expected = windowSize * baseRate;
  if (observedCount <= expected) return 0;
  const tail = binomialUpperTail(k, windowSize, baseRate);
  if (tail >= 0.5) return 0;
  return Math.max(0, -inverseNormalCdf(tail));
}
