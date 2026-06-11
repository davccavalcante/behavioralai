/**
 * Two-sided Page-Hinkley test for sequential mean-shift detection, with an
 * exponential forgetting factor on the cumulative statistics.
 *
 * Complements the per-observation z-score: the z-score catches single
 * outliers, Page-Hinkley accumulates small persistent deviations and fires
 * when the mean has genuinely shifted, even if no single observation looks
 * extreme on its own. Without forgetting, the cumulative sum is a recurrent
 * random walk that eventually crosses any threshold on stationary data; the
 * discount bounds it (Ornstein-Uhlenbeck-like), keeping the false-positive
 * rate flat over arbitrarily long streams.
 */
const FORGETTING = 0.999;

export class PageHinkley {
  private n = 0;
  private mean = 0;
  private cumUp = 0;
  private minUp = 0;
  private cumDown = 0;
  private maxDown = 0;

  /**
   * @param delta tolerated drift per step, in feature units.
   * @param lambda cumulative deviation that confirms a shift, in feature units.
   */
  constructor(
    private readonly delta: number,
    private readonly lambda: number,
  ) {
    if (delta < 0) throw new RangeError(`PageHinkley delta must be >= 0, got ${delta}`);
    if (lambda <= 0) throw new RangeError(`PageHinkley lambda must be > 0, got ${lambda}`);
  }

  /**
   * Absorb one sample and report whether a sustained mean shift is active.
   * Returns 'up', 'down', or undefined when no shift is confirmed.
   */
  push(x: number): 'up' | 'down' | undefined {
    this.n += 1;
    this.mean += (x - this.mean) / this.n;

    this.cumUp = FORGETTING * this.cumUp + (x - this.mean - this.delta);
    if (this.cumUp < this.minUp) this.minUp = this.cumUp;

    this.cumDown = FORGETTING * this.cumDown + (x - this.mean + this.delta);
    if (this.cumDown > this.maxDown) this.maxDown = this.cumDown;

    if (this.cumUp - this.minUp > this.lambda) return 'up';
    if (this.maxDown - this.cumDown > this.lambda) return 'down';
    return undefined;
  }

  /** Reset the cumulative statistics, keeping the running mean. */
  reset(): void {
    this.cumUp = 0;
    this.minUp = 0;
    this.cumDown = 0;
    this.maxDown = 0;
  }

  toJSON(): {
    n: number;
    mean: number;
    cumUp: number;
    minUp: number;
    cumDown: number;
    maxDown: number;
    delta: number;
    lambda: number;
  } {
    return {
      n: this.n,
      mean: this.mean,
      cumUp: this.cumUp,
      minUp: this.minUp,
      cumDown: this.cumDown,
      maxDown: this.maxDown,
      delta: this.delta,
      lambda: this.lambda,
    };
  }

  static fromJSON(data: ReturnType<PageHinkley['toJSON']>): PageHinkley {
    const ph = new PageHinkley(data.delta, data.lambda);
    ph.n = data.n;
    ph.mean = data.mean;
    ph.cumUp = data.cumUp;
    ph.minUp = data.minUp;
    ph.cumDown = data.cumDown;
    ph.maxDown = data.maxDown;
    return ph;
  }
}
