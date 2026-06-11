import { describe, expect, it } from 'vitest';
import { CategoricalDistribution, jensenShannon } from '../../src/stats/CategoricalDistribution.js';
import { Ewma } from '../../src/stats/Ewma.js';
import { P2Quantile } from '../../src/stats/P2Quantile.js';
import { PageHinkley } from '../../src/stats/PageHinkley.js';
import { RingBuffer } from '../../src/stats/RingBuffer.js';
import {
  estimateTrend,
  observationsToThreshold,
  type TrendPoint,
} from '../../src/stats/TrendForecaster.js';
import { Welford } from '../../src/stats/Welford.js';

/** Deterministic LCG in [0, 1). */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describe('Welford', () => {
  it('matches the naive mean and population variance', () => {
    const values = [4, 7, 13, 16, 1, 9, 22, 5];
    const w = new Welford();
    for (const value of values) w.push(value);

    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;

    expect(w.count).toBe(values.length);
    expect(w.mean).toBeCloseTo(mean, 10);
    expect(w.variance).toBeCloseTo(variance, 10);
    expect(w.min).toBe(1);
    expect(w.max).toBe(22);
  });

  it('is zero-safe before any sample', () => {
    const w = new Welford();
    expect(w.count).toBe(0);
    expect(w.mean).toBe(0);
    expect(w.variance).toBe(0);
    expect(w.stdDev).toBe(0);
  });

  it('round-trips through JSON', () => {
    const w = new Welford();
    for (const value of [1, 2, 3, 4, 5]) w.push(value);
    const restored = Welford.fromJSON(w.toJSON());
    expect(restored.mean).toBe(w.mean);
    expect(restored.variance).toBe(w.variance);
    expect(restored.count).toBe(w.count);
  });
});

describe('Ewma', () => {
  it('rejects alpha outside (0, 1)', () => {
    expect(() => new Ewma(0)).toThrow(RangeError);
    expect(() => new Ewma(1)).toThrow(RangeError);
  });

  it('initializes on the first sample and tracks shifts faster than Welford', () => {
    const ewma = new Ewma(0.2);
    const welford = new Welford();
    for (let i = 0; i < 100; i += 1) {
      ewma.push(10);
      welford.push(10);
    }
    for (let i = 0; i < 30; i += 1) {
      ewma.push(20);
      welford.push(20);
    }
    expect(ewma.mean).toBeGreaterThan(welford.mean);
    expect(ewma.mean).toBeGreaterThan(19);
  });

  it('round-trips through JSON', () => {
    const ewma = new Ewma(0.1);
    for (const value of [5, 6, 7]) ewma.push(value);
    const restored = Ewma.fromJSON(ewma.toJSON());
    expect(restored.mean).toBe(ewma.mean);
    expect(restored.variance).toBe(ewma.variance);
  });
});

describe('P2Quantile', () => {
  it('is exact for five or fewer samples', () => {
    const p50 = new P2Quantile(0.5);
    for (const value of [9, 1, 5]) p50.push(value);
    expect(p50.value).toBe(5);
  });

  it('approximates the median of a deterministic stream', () => {
    const rand = lcg(42);
    const p50 = new P2Quantile(0.5);
    const all: number[] = [];
    for (let i = 0; i < 5000; i += 1) {
      const value = rand() * 100;
      all.push(value);
      p50.push(value);
    }
    all.sort((a, b) => a - b);
    const exact = all[Math.floor(all.length / 2)] as number;
    expect(Math.abs(p50.value - exact)).toBeLessThan(2);
  });

  it('approximates a high quantile of a skewed stream', () => {
    const rand = lcg(7);
    const p95 = new P2Quantile(0.95);
    const all: number[] = [];
    for (let i = 0; i < 8000; i += 1) {
      const value = -Math.log(1 - rand()) * 100; // exponential
      all.push(value);
      p95.push(value);
    }
    all.sort((a, b) => a - b);
    const exact = all[Math.floor(all.length * 0.95)] as number;
    expect(Math.abs(p95.value - exact) / exact).toBeLessThan(0.15);
  });

  it('round-trips through JSON', () => {
    const rand = lcg(3);
    const q = new P2Quantile(0.5);
    for (let i = 0; i < 100; i += 1) q.push(rand());
    const restored = P2Quantile.fromJSON(q.toJSON());
    expect(restored.value).toBe(q.value);
    expect(restored.samples).toBe(q.samples);
  });
});

describe('RingBuffer', () => {
  it('keeps the most recent items in order', () => {
    const ring = new RingBuffer<number>(3);
    for (const value of [1, 2, 3, 4, 5]) ring.push(value);
    expect(ring.toArray()).toEqual([3, 4, 5]);
    expect(ring.isFull).toBe(true);
    expect(ring.size).toBe(3);
  });

  it('rejects non-positive capacity', () => {
    expect(() => new RingBuffer(0)).toThrow(RangeError);
  });

  it('clears', () => {
    const ring = new RingBuffer<number>(2);
    ring.push(1);
    ring.clear();
    expect(ring.size).toBe(0);
    expect(ring.toArray()).toEqual([]);
  });
});

describe('PageHinkley', () => {
  it('stays silent on stationary data', () => {
    const rand = lcg(11);
    const ph = new PageHinkley(0.02, 75);
    let fired: string | undefined;
    for (let i = 0; i < 2000; i += 1) {
      const result = ph.push((rand() - 0.5) * 2);
      if (result !== undefined) fired = result;
    }
    expect(fired).toBeUndefined();
  });

  it('detects a sustained upward mean shift', () => {
    const rand = lcg(13);
    const ph = new PageHinkley(0.02, 75);
    for (let i = 0; i < 500; i += 1) ph.push((rand() - 0.5) * 2);
    let detected: 'up' | 'down' | undefined;
    for (let i = 0; i < 200 && detected === undefined; i += 1) {
      detected = ph.push((rand() - 0.5) * 2 + 1.5);
    }
    expect(detected).toBe('up');
  });

  it('detects a sustained downward mean shift', () => {
    const rand = lcg(17);
    const ph = new PageHinkley(0.02, 75);
    for (let i = 0; i < 500; i += 1) ph.push((rand() - 0.5) * 2);
    let detected: 'up' | 'down' | undefined;
    for (let i = 0; i < 200 && detected === undefined; i += 1) {
      detected = ph.push((rand() - 0.5) * 2 - 1.5);
    }
    expect(detected).toBe('down');
  });

  it('round-trips through JSON', () => {
    const ph = new PageHinkley(0.02, 75);
    for (const value of [0.5, -0.2, 0.9]) ph.push(value);
    const restored = PageHinkley.fromJSON(ph.toJSON());
    expect(restored.toJSON()).toEqual(ph.toJSON());
  });
});

describe('TrendForecaster', () => {
  it('needs at least three points', () => {
    const points: TrendPoint[] = [
      { t: 0, value: 1 },
      { t: 1000, value: 2 },
    ];
    expect(estimateTrend(points)).toBeUndefined();
  });

  it('recovers the slope of a perfect line', () => {
    const points: TrendPoint[] = [];
    for (let i = 0; i < 10; i += 1) {
      points.push({ t: i * 60_000, value: 100 + 5 * i });
    }
    const trend = estimateTrend(points);
    expect(trend).toBeDefined();
    expect(trend?.slopePerObservation).toBeCloseTo(5, 8);
    // 5 units per minute means 300 units per hour.
    expect(trend?.slopePerHour).toBeCloseTo(300, 6);
    expect(trend?.next).toBeCloseTo(150, 8);
  });

  it('projects observations to a threshold only when the trend points at it', () => {
    expect(observationsToThreshold(100, 200, 5)).toBeCloseTo(20, 8);
    expect(observationsToThreshold(100, 200, -5)).toBeUndefined();
    expect(observationsToThreshold(100, 200, 0)).toBeUndefined();
  });
});

describe('CategoricalDistribution and Jensen-Shannon', () => {
  it('is zero for identical distributions and one for disjoint ones', () => {
    expect(jensenShannon({ a: 0.5, b: 0.5 }, { a: 0.5, b: 0.5 })).toBeCloseTo(0, 10);
    expect(jensenShannon({ a: 1 }, { b: 1 })).toBeCloseTo(1, 10);
  });

  it('reports divergence when the recent mix shifts', () => {
    const dist = new CategoricalDistribution(20);
    for (let i = 0; i < 200; i += 1) {
      dist.pushBaseline(i % 2 === 0 ? 'search' : 'calc');
    }
    for (let i = 0; i < 20; i += 1) dist.pushRecent('search');
    for (let i = 0; i < 20; i += 1) dist.pushRecent('shell');
    expect(dist.divergence()).toBeGreaterThan(0.5);
  });

  it('absorbs the window into the baseline', () => {
    const dist = new CategoricalDistribution(10);
    for (let i = 0; i < 50; i += 1) dist.pushBaseline('a');
    for (let i = 0; i < 10; i += 1) dist.pushRecent('b');
    const before = dist.divergence();
    dist.absorbWindow();
    expect(dist.baselineSamples).toBe(60);
    expect(dist.divergence()).toBeLessThan(before);
  });

  it('round-trips through JSON', () => {
    const dist = new CategoricalDistribution(5);
    dist.pushBaseline('x');
    dist.pushRecent('y');
    const restored = CategoricalDistribution.fromJSON(dist.toJSON());
    expect(restored.baseline()).toEqual(dist.baseline());
    expect(restored.recent()).toEqual(dist.recent());
  });
});
