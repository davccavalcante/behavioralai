import { RingBuffer } from './RingBuffer.js';

/**
 * Streaming categorical distribution with Jensen-Shannon divergence between
 * the long-run baseline and a recent window. Powers tool-selection and
 * finish-reason drift: an agent that suddenly prefers different tools, or
 * starts hitting "length" instead of "stop", diverges here even when every
 * numeric feature still looks normal.
 */
export class CategoricalDistribution {
  private readonly baselineCounts = new Map<string, number>();
  private baselineTotal = 0;
  private readonly window: RingBuffer<string>;

  constructor(windowSize: number) {
    this.window = new RingBuffer<string>(windowSize);
  }

  /** Absorb one categorical sample into the recent window. */
  pushRecent(category: string): void {
    this.window.push(category);
  }

  /** Absorb one categorical sample into the learned baseline. */
  pushBaseline(category: string): void {
    this.baselineCounts.set(category, (this.baselineCounts.get(category) ?? 0) + 1);
    this.baselineTotal += 1;
  }

  /** Fold the entire recent window into the baseline (used by absorb()). */
  absorbWindow(): void {
    for (const category of this.window.toArray()) {
      this.pushBaseline(category);
    }
  }

  get baselineSamples(): number {
    return this.baselineTotal;
  }

  get windowSamples(): number {
    return this.window.size;
  }

  /** Normalized baseline frequencies. */
  baseline(): Record<string, number> {
    return normalize(this.baselineCounts, this.baselineTotal);
  }

  /** Normalized recent-window frequencies. */
  recent(): Record<string, number> {
    const counts = new Map<string, number>();
    const items = this.window.toArray();
    for (const item of items) {
      counts.set(item, (counts.get(item) ?? 0) + 1);
    }
    return normalize(counts, items.length);
  }

  /**
   * Jensen-Shannon divergence (base-2 logarithm, bounded to [0, 1]) between
   * the recent window and the learned baseline. Returns 0 until both sides
   * have samples.
   */
  divergence(): number {
    if (this.baselineTotal === 0 || this.window.size === 0) return 0;
    return jensenShannon(this.baseline(), this.recent());
  }

  toJSON(): { baseline: Record<string, number>; window: string[]; windowSize: number } {
    return {
      baseline: Object.fromEntries(this.baselineCounts),
      window: this.window.toArray(),
      windowSize: this.window.capacity,
    };
  }

  static fromJSON(data: {
    baseline: Record<string, number>;
    window: string[];
    windowSize: number;
  }): CategoricalDistribution {
    const dist = new CategoricalDistribution(data.windowSize);
    for (const [category, count] of Object.entries(data.baseline)) {
      dist.baselineCounts.set(category, count);
      dist.baselineTotal += count;
    }
    for (const item of data.window) {
      dist.window.push(item);
    }
    return dist;
  }
}

function normalize(counts: Map<string, number>, total: number): Record<string, number> {
  const out: Record<string, number> = {};
  if (total === 0) return out;
  for (const [category, count] of counts) {
    out[category] = count / total;
  }
  return out;
}

/** Jensen-Shannon divergence with base-2 logarithm; symmetric, in [0, 1]. */
export function jensenShannon(
  p: Readonly<Record<string, number>>,
  q: Readonly<Record<string, number>>,
): number {
  const keys = new Set([...Object.keys(p), ...Object.keys(q)]);
  let divergence = 0;
  for (const key of keys) {
    const pi = p[key] ?? 0;
    const qi = q[key] ?? 0;
    const mi = (pi + qi) / 2;
    if (pi > 0) divergence += 0.5 * pi * Math.log2(pi / mi);
    if (qi > 0) divergence += 0.5 * qi * Math.log2(qi / mi);
  }
  return Math.min(1, Math.max(0, divergence));
}
