/**
 * P-square (P2) streaming quantile estimator (Jain and Chlamtac, 1985).
 * Estimates one quantile with five markers, O(1) memory, no stored samples.
 * Exact for the first five observations, asymptotically accurate afterwards.
 */
export class P2Quantile {
  /** Marker heights. */
  private readonly q: number[] = [];
  /** Marker positions (1-based). */
  private readonly n: number[] = [1, 2, 3, 4, 5];
  /** Desired marker positions. */
  private readonly np: number[];
  /** Desired position increments. */
  private readonly dn: number[];
  private count = 0;

  constructor(private readonly p: number) {
    if (!(p > 0 && p < 1)) {
      throw new RangeError(`P2Quantile p must be in (0, 1), got ${p}`);
    }
    this.np = [1, 1 + 2 * p, 1 + 4 * p, 3 + 2 * p, 5];
    this.dn = [0, p / 2, p, (1 + p) / 2, 1];
  }

  /** Absorb one sample. */
  push(x: number): void {
    this.count += 1;

    if (this.q.length < 5) {
      this.q.push(x);
      if (this.q.length === 5) {
        this.q.sort((a, b) => a - b);
      }
      return;
    }

    // Locate the cell containing x and adjust extreme markers.
    let k: number;
    const q0 = this.q[0] as number;
    const q4 = this.q[4] as number;
    if (x < q0) {
      this.q[0] = x;
      k = 0;
    } else if (x >= q4) {
      this.q[4] = x;
      k = 3;
    } else {
      k = 0;
      for (let i = 1; i < 5; i += 1) {
        if (x < (this.q[i] as number)) {
          k = i - 1;
          break;
        }
      }
    }

    // Shift positions of markers above the cell.
    for (let i = k + 1; i < 5; i += 1) {
      this.n[i] = (this.n[i] as number) + 1;
    }
    for (let i = 0; i < 5; i += 1) {
      this.np[i] = (this.np[i] as number) + (this.dn[i] as number);
    }

    // Adjust interior markers via parabolic (or linear) interpolation.
    for (let i = 1; i <= 3; i += 1) {
      const ni = this.n[i] as number;
      const d = (this.np[i] as number) - ni;
      const nNext = this.n[i + 1] as number;
      const nPrev = this.n[i - 1] as number;
      if ((d >= 1 && nNext - ni > 1) || (d <= -1 && nPrev - ni < -1)) {
        const sign = d >= 1 ? 1 : -1;
        const parabolic = this.parabolic(i, sign);
        const qPrev = this.q[i - 1] as number;
        const qNext = this.q[i + 1] as number;
        if (qPrev < parabolic && parabolic < qNext) {
          this.q[i] = parabolic;
        } else {
          this.q[i] = this.linear(i, sign);
        }
        this.n[i] = ni + sign;
      }
    }
  }

  private parabolic(i: number, d: number): number {
    const qi = this.q[i] as number;
    const qPrev = this.q[i - 1] as number;
    const qNext = this.q[i + 1] as number;
    const ni = this.n[i] as number;
    const nPrev = this.n[i - 1] as number;
    const nNext = this.n[i + 1] as number;
    return (
      qi +
      (d / (nNext - nPrev)) *
        ((ni - nPrev + d) * ((qNext - qi) / (nNext - ni)) +
          (nNext - ni - d) * ((qi - qPrev) / (ni - nPrev)))
    );
  }

  private linear(i: number, d: number): number {
    const qi = this.q[i] as number;
    const qd = this.q[i + d] as number;
    const ni = this.n[i] as number;
    const nd = this.n[i + d] as number;
    return qi + (d * (qd - qi)) / (nd - ni);
  }

  /** Current quantile estimate. */
  get value(): number {
    if (this.count === 0) return 0;
    if (this.q.length < 5) {
      const sorted = [...this.q].sort((a, b) => a - b);
      const idx = Math.min(sorted.length - 1, Math.floor(this.p * sorted.length));
      return sorted[idx] as number;
    }
    return this.q[2] as number;
  }

  get samples(): number {
    return this.count;
  }

  toJSON(): { p: number; q: number[]; n: number[]; np: number[]; count: number } {
    return { p: this.p, q: [...this.q], n: [...this.n], np: [...this.np], count: this.count };
  }

  static fromJSON(data: {
    p: number;
    q: number[];
    n: number[];
    np: number[];
    count: number;
  }): P2Quantile {
    const est = new P2Quantile(data.p);
    est.q.length = 0;
    est.q.push(...data.q);
    for (let i = 0; i < 5; i += 1) {
      est.n[i] = data.n[i] ?? est.n[i] ?? 1;
      est.np[i] = data.np[i] ?? est.np[i] ?? 1;
    }
    est.count = data.count;
    return est;
  }
}
