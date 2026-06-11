/**
 * Welford's online algorithm for numerically stable streaming mean and
 * variance. O(1) memory, one pass, no stored samples.
 */
export class Welford {
  private n = 0;
  private meanValue = 0;
  private m2 = 0;
  private minValue = Number.POSITIVE_INFINITY;
  private maxValue = Number.NEGATIVE_INFINITY;

  /** Absorb one sample. */
  push(x: number): void {
    this.n += 1;
    const delta = x - this.meanValue;
    this.meanValue += delta / this.n;
    this.m2 += delta * (x - this.meanValue);
    if (x < this.minValue) this.minValue = x;
    if (x > this.maxValue) this.maxValue = x;
  }

  get count(): number {
    return this.n;
  }

  get mean(): number {
    return this.n === 0 ? 0 : this.meanValue;
  }

  /** Population variance. Zero until two samples exist. */
  get variance(): number {
    return this.n < 2 ? 0 : this.m2 / this.n;
  }

  get stdDev(): number {
    return Math.sqrt(this.variance);
  }

  get min(): number {
    return this.n === 0 ? 0 : this.minValue;
  }

  get max(): number {
    return this.n === 0 ? 0 : this.maxValue;
  }

  /** Serialize for state persistence. */
  toJSON(): { n: number; mean: number; m2: number; min: number; max: number } {
    return { n: this.n, mean: this.meanValue, m2: this.m2, min: this.minValue, max: this.maxValue };
  }

  static fromJSON(data: {
    n: number;
    mean: number;
    m2: number;
    min: number;
    max: number;
  }): Welford {
    const w = new Welford();
    w.n = data.n;
    w.meanValue = data.mean;
    w.m2 = data.m2;
    w.minValue = data.min;
    w.maxValue = data.max;
    return w;
  }
}
