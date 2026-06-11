/**
 * Exponentially weighted moving average and variance (West, 1979 update
 * form). The recency-weighted counterpart to {@link Welford}: tracks where
 * the behavior is now, while Welford tracks where it has been overall.
 */
export class Ewma {
  private initialized = false;
  private meanValue = 0;
  private varValue = 0;

  constructor(private readonly alpha: number) {
    if (!(alpha > 0 && alpha < 1)) {
      throw new RangeError(`Ewma alpha must be in (0, 1), got ${alpha}`);
    }
  }

  /** Absorb one sample. */
  push(x: number): void {
    if (!this.initialized) {
      this.initialized = true;
      this.meanValue = x;
      this.varValue = 0;
      return;
    }
    const diff = x - this.meanValue;
    const incr = this.alpha * diff;
    this.meanValue += incr;
    this.varValue = (1 - this.alpha) * (this.varValue + diff * incr);
  }

  get mean(): number {
    return this.meanValue;
  }

  get variance(): number {
    return this.varValue;
  }

  get stdDev(): number {
    return Math.sqrt(this.varValue);
  }

  toJSON(): { initialized: boolean; mean: number; variance: number; alpha: number } {
    return {
      initialized: this.initialized,
      mean: this.meanValue,
      variance: this.varValue,
      alpha: this.alpha,
    };
  }

  static fromJSON(data: {
    initialized: boolean;
    mean: number;
    variance: number;
    alpha: number;
  }): Ewma {
    const e = new Ewma(data.alpha);
    e.initialized = data.initialized;
    e.meanValue = data.mean;
    e.varValue = data.variance;
    return e;
  }
}
