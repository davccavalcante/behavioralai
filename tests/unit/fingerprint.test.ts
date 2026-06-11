import { describe, expect, it } from 'vitest';
import { resolveSensitivity } from '../../src/drift/sensitivity.js';
import { extractFeatures } from '../../src/fingerprint/FeatureExtractor.js';
import { computeBehaviorScore, Fingerprint } from '../../src/fingerprint/Fingerprint.js';
import type { TurnObservation } from '../../src/types.js';

const SENSITIVITY = resolveSensitivity('balanced');
const WARMUP = { minObservations: 40 };
const WINDOW = 20;
const EPOCH = 1_750_000_000_000;
const STEP = 30_000;

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function gauss(rand: () => number): number {
  const u1 = Math.max(rand(), 1e-12);
  const u2 = rand();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function healthyTurn(rand: () => number, index: number): TurnObservation {
  const tools = ['web_search', 'db_query', 'calculator'] as const;
  const pick = rand();
  const tool = pick < 0.5 ? tools[0] : pick < 0.8 ? tools[1] : tools[2];
  return {
    agentId: 'agent-x',
    timestamp: EPOCH + index * STEP,
    latencyMs: 800 + gauss(rand) * 60,
    costUsd: 0.002 + rand() * 0.0004,
    toolCalls: [{ name: tool, ok: rand() > 0.02 }],
    finishReason: rand() < 0.95 ? 'stop' : 'length',
  };
}

function feedHealthy(fp: Fingerprint, rand: () => number, count: number, offset = 0): void {
  for (let i = 0; i < count; i += 1) {
    const turn = healthyTurn(rand, offset + i);
    fp.evaluate(extractFeatures(turn), turn.timestamp ?? EPOCH);
  }
}

describe('Fingerprint', () => {
  it('emits no findings during warmup and flips to ready at the boundary', () => {
    const fp = new Fingerprint('agent-x', SENSITIVITY, WARMUP, WINDOW);
    const rand = lcg(1);
    for (let i = 0; i < WARMUP.minObservations; i += 1) {
      const turn = healthyTurn(rand, i);
      const outcome = fp.evaluate(extractFeatures(turn), turn.timestamp ?? EPOCH);
      expect(outcome.status).toBe('learning');
      expect(outcome.findings).toHaveLength(0);
    }
    expect(fp.status).toBe('ready');
  });

  it('stays quiet on stationary behavior after warmup', () => {
    const fp = new Fingerprint('agent-x', SENSITIVITY, WARMUP, WINDOW);
    const rand = lcg(2);
    feedHealthy(fp, rand, WARMUP.minObservations);
    let findings = 0;
    for (let i = 0; i < 200; i += 1) {
      const turn = healthyTurn(rand, WARMUP.minObservations + i);
      findings += fp.evaluate(extractFeatures(turn), turn.timestamp ?? EPOCH).findings.length;
    }
    expect(findings).toBe(0);
  });

  it('detects an abrupt latency shift, freezes the baseline, and recovers after the streak', () => {
    const fp = new Fingerprint('agent-x', SENSITIVITY, WARMUP, WINDOW);
    const rand = lcg(3);
    feedHealthy(fp, rand, WARMUP.minObservations + 50);

    const baselineMean = fp
      .snapshot()
      .numeric.find((feature) => feature.feature === 'latencyMs')?.mean;
    expect(baselineMean).toBeDefined();

    // Inject a 4x latency spike sustained over several turns.
    let criticalSeen = false;
    let frozenSeen = false;
    for (let i = 0; i < 10; i += 1) {
      const base = healthyTurn(rand, 100 + i);
      const turn = { ...base, latencyMs: 3400 + gauss(rand) * 60 };
      const outcome = fp.evaluate(extractFeatures(turn), turn.timestamp ?? EPOCH);
      const latencyFinding = outcome.findings.find((f) => f.feature === 'latencyMs');
      if (latencyFinding?.severity === 'critical') criticalSeen = true;
      if (fp.snapshot().frozen.includes('latencyMs')) frozenSeen = true;
    }
    expect(criticalSeen).toBe(true);
    expect(frozenSeen).toBe(true);

    // Frozen baseline must not absorb the anomaly.
    const meanDuringFreeze = fp
      .snapshot()
      .numeric.find((feature) => feature.feature === 'latencyMs')?.mean;
    expect(meanDuringFreeze).toBeLessThan(1200);

    // Return to normal: recovery transition after the streak unfreezes.
    let recovered = false;
    for (let i = 0; i < 12; i += 1) {
      const turn = healthyTurn(rand, 200 + i);
      const outcome = fp.evaluate(extractFeatures(turn), turn.timestamp ?? EPOCH);
      if (
        outcome.transitions.some(
          (transition) => transition.feature === 'latencyMs' && transition.to === 'none',
        )
      ) {
        recovered = true;
      }
    }
    expect(recovered).toBe(true);
    expect(fp.snapshot().frozen).not.toContain('latencyMs');
  });

  it('detects a categorical tool-selection shift', () => {
    const fp = new Fingerprint('agent-x', SENSITIVITY, WARMUP, WINDOW);
    const rand = lcg(4);
    feedHealthy(fp, rand, WARMUP.minObservations + 60);

    let categoricalFinding = false;
    for (let i = 0; i < 40 && !categoricalFinding; i += 1) {
      const base = healthyTurn(rand, 200 + i);
      const turn: TurnObservation = {
        ...base,
        toolCalls: [{ name: 'shell_exec', ok: true }],
      };
      const outcome = fp.evaluate(extractFeatures(turn), turn.timestamp ?? EPOCH);
      categoricalFinding = outcome.findings.some((f) => f.feature === 'toolSelection');
    }
    expect(categoricalFinding).toBe(true);
  });

  it('accepts a new normal through absorb()', () => {
    const fp = new Fingerprint('agent-x', SENSITIVITY, WARMUP, WINDOW);
    const rand = lcg(5);
    feedHealthy(fp, rand, WARMUP.minObservations + 30);

    // Shift latency up and keep it there; absorb the window as the new normal.
    for (let i = 0; i < WINDOW; i += 1) {
      const base = healthyTurn(rand, 100 + i);
      fp.evaluate(extractFeatures({ ...base, latencyMs: 2600 + gauss(rand) * 50 }), EPOCH + i);
    }
    fp.absorb('latencyMs');
    expect(fp.snapshot().frozen).not.toContain('latencyMs');

    let findingsAfterAbsorb = 0;
    for (let i = 0; i < 20; i += 1) {
      const base = healthyTurn(rand, 200 + i);
      const outcome = fp.evaluate(
        extractFeatures({ ...base, latencyMs: 2600 + gauss(rand) * 50 }),
        EPOCH + (200 + i) * STEP,
      );
      findingsAfterAbsorb += outcome.findings.filter((f) => f.feature === 'latencyMs').length;
    }
    expect(findingsAfterAbsorb).toBe(0);
  });

  it('produces trend forecasts for a steady ramp before it turns critical', () => {
    const fp = new Fingerprint('agent-x', SENSITIVITY, WARMUP, WINDOW);
    const rand = lcg(6);
    feedHealthy(fp, rand, WARMUP.minObservations + WINDOW);

    let sawForecast = false;
    for (let i = 0; i < 60 && !sawForecast; i += 1) {
      const base = healthyTurn(rand, 100 + i);
      const ramped = { ...base, latencyMs: 820 + i * 6 + gauss(rand) * 20 };
      const outcome = fp.evaluate(extractFeatures(ramped), ramped.timestamp ?? EPOCH);
      sawForecast = outcome.forecasts.some((forecast) => forecast.feature === 'latencyMs');
    }
    expect(sawForecast).toBe(true);
  });

  it('round-trips its full state through JSON', () => {
    const fp = new Fingerprint('agent-x', SENSITIVITY, WARMUP, WINDOW);
    const rand = lcg(7);
    feedHealthy(fp, rand, WARMUP.minObservations + 25);

    const restored = Fingerprint.fromJSON(fp.toJSON(), SENSITIVITY, WARMUP, WINDOW);
    const a = fp.snapshot();
    const b = restored.snapshot();
    expect(b.observations).toBe(a.observations);
    expect(b.status).toBe(a.status);
    expect(b.numeric).toEqual(a.numeric);
    expect(b.categorical).toEqual(a.categorical);
  });
});

describe('computeBehaviorScore', () => {
  it('is 100 with no deviations and decreases with deviation', () => {
    expect(computeBehaviorScore(new Map())).toBe(100);
    const low = computeBehaviorScore(new Map([['latencyMs', 0.2]]));
    const high = computeBehaviorScore(new Map([['latencyMs', 1.5]]));
    expect(low).toBeGreaterThan(high);
    expect(low).toBeLessThanOrEqual(100);
    expect(high).toBeGreaterThanOrEqual(0);
  });
});
