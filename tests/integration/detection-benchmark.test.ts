import { describe, expect, it } from 'vitest';
import { createBehavioralAI } from '../../src/core/createBehavioralAI.js';
import type { BehavioralAI, TelemetryEvent, TurnObservation } from '../../src/types.js';

/**
 * Detection-quality benchmark: labeled drift scenarios with hard acceptance
 * bounds. Mechanism tests prove the statistics are implemented correctly;
 * THIS suite proves the assembled detector actually catches what the
 * product claims to catch, within how many turns, and stays silent on
 * healthy traffic. Every scenario is fully deterministic (seeded LCG,
 * simulated clock), so any regression in detection quality fails CI.
 *
 * These scenarios encode the falsification experiments from the 1.0.0
 * pre-publication review: a sustained +2.5 sigma shift used to produce
 * ZERO findings, the 3-4 sigma band was a dead zone, stationary traffic
 * produced a forecast flood, and the error-rate baseline self-poisoned
 * during incidents.
 */

const EPOCH = 1_750_000_000_000;
const STEP = 30_000;
const WARMUP = 60;

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

interface ScenarioContext {
  readonly engine: BehavioralAI;
  readonly events: TelemetryEvent[];
  observe(turn: TurnObservation): void;
}

function scenario(): ScenarioContext {
  let clock = EPOCH;
  const events: TelemetryEvent[] = [];
  const engine = createBehavioralAI({
    warmup: { minObservations: WARMUP },
    windowSize: 30,
    now: () => clock,
  });
  engine.on((event) => {
    events.push(event);
  });
  return {
    engine,
    events,
    observe(turn: TurnObservation) {
      engine.observe({ ...turn, timestamp: clock });
      clock += STEP;
    },
  };
}

/** Healthy turn: latency N(800, 60), 2 percent error rate, stable tools. */
function healthyTurn(
  rand: () => number,
  latencyShiftSigma = 0,
  lengthShare = 0.05,
): TurnObservation {
  const pick = rand();
  const tool = pick < 0.5 ? 'web_search' : pick < 0.8 ? 'db_query' : 'calculator';
  return {
    agentId: 'bench-agent',
    latencyMs: 800 + latencyShiftSigma * 60 + gauss(rand) * 60,
    costUsd: 0.002 + rand() * 0.0004,
    toolCalls: [{ name: tool, ok: rand() > 0.02 }],
    error: rand() < 0.02,
    finishReason: rand() < 1 - lengthShare ? 'stop' : 'length',
  };
}

describe('detection-quality benchmark (labeled scenarios)', () => {
  it('S1 stationary control: no drift findings, at most 2 forecast events, healthy score', () => {
    const ctx = scenario();
    const rand = lcg(101);
    const scores: number[] = [];
    for (let i = 0; i < 2000; i += 1) {
      ctx.observe(healthyTurn(rand));
      const report = ctx.engine.reportOf('bench-agent');
      if (report !== undefined && report.status === 'ready') scores.push(report.behaviorScore);
    }
    const driftEvents = ctx.events.filter((event) => event.kind === 'drift.detected');
    const forecastEvents = ctx.events.filter((event) => event.kind === 'forecast.detected');
    expect(driftEvents).toHaveLength(0);
    expect(forecastEvents.length).toBeLessThanOrEqual(2);
    scores.sort((a, b) => a - b);
    const p5 = scores[Math.floor(scores.length * 0.05)] ?? 0;
    expect(p5).toBeGreaterThanOrEqual(99);
  });

  it('S2 sustained +2.5 sigma latency shift (below warningZ): Page-Hinkley episode within 80 turns', () => {
    const ctx = scenario();
    const rand = lcg(102);
    for (let i = 0; i < 600; i += 1) ctx.observe(healthyTurn(rand));
    let detectedAfter = -1;
    for (let i = 0; i < 200; i += 1) {
      ctx.observe(healthyTurn(rand, 2.5));
      const latencyDrift = ctx.events.some(
        (event) => event.kind === 'drift.detected' && event.feature === 'latencyMs',
      );
      if (latencyDrift) {
        detectedAfter = i + 1;
        break;
      }
    }
    expect(detectedAfter).toBeGreaterThan(0);
    expect(detectedAfter).toBeLessThanOrEqual(80);
  });

  it('S3 sustained +3.2 sigma latency shift (the former dead zone): state machine opens and holds without false recovery', () => {
    const ctx = scenario();
    const rand = lcg(103);
    for (let i = 0; i < 600; i += 1) ctx.observe(healthyTurn(rand));
    const eventsBeforeShift = ctx.events.length;
    let openedAfter = -1;
    for (let i = 0; i < 120; i += 1) {
      ctx.observe(healthyTurn(rand, 3.2));
      if (openedAfter < 0) {
        const opened = ctx.events.some(
          (event) =>
            event.kind === 'drift.detected' &&
            event.feature === 'latencyMs' &&
            event.severity !== undefined,
        );
        if (opened) openedAfter = i + 1;
      }
    }
    expect(openedAfter).toBeGreaterThan(0);
    expect(openedAfter).toBeLessThanOrEqual(15);
    // The baseline froze, so the shift cannot be absorbed into a false
    // normal, and no latency recovery is reported while the shift persists
    // (transient unrelated episodes from the healthy phase do not count).
    // The latency track itself must still be open and frozen at the end of
    // the shift window: no false recovery absorbed the regression.
    expect(ctx.engine.fingerprintOf('bench-agent')?.frozen).toContain('latencyMs');
    expect(ctx.events.slice(eventsBeforeShift).length).toBeGreaterThan(0);
  });

  it('S4 abrupt +6 sigma latency regression: critical within 2 evaluations of the shift', () => {
    const ctx = scenario();
    const rand = lcg(104);
    for (let i = 0; i < 600; i += 1) ctx.observe(healthyTurn(rand));
    let criticalAfter = -1;
    for (let i = 0; i < 10; i += 1) {
      ctx.observe(healthyTurn(rand, 6));
      const critical = ctx.events.some(
        (event) =>
          event.kind === 'drift.detected' &&
          event.feature === 'latencyMs' &&
          event.severity === 'critical',
      );
      if (critical) {
        criticalAfter = i + 1;
        break;
      }
    }
    expect(criticalAfter).toBe(2);
  });

  it('S5 error-rate spike 0.02 to 0.15: detected within 30 turns and the baseline is not poisoned', () => {
    const ctx = scenario();
    const rand = lcg(105);
    for (let i = 0; i < 600; i += 1) ctx.observe(healthyTurn(rand));
    let detectedAfter = -1;
    for (let i = 0; i < 60; i += 1) {
      const base = healthyTurn(rand);
      ctx.observe({ ...base, error: rand() < 0.15 });
      if (detectedAfter < 0) {
        const hit = ctx.events.some(
          (event) => event.kind === 'drift.detected' && event.feature === 'errorRate',
        );
        if (hit) detectedAfter = i + 1;
      }
    }
    expect(detectedAfter).toBeGreaterThan(0);
    expect(detectedAfter).toBeLessThanOrEqual(30);
    // Anti-poisoning: the learned baseline rate must stay near the true
    // healthy 2 percent, not chase the incident upward.
    const errorTrack = ctx.engine
      .fingerprintOf('bench-agent')
      ?.numeric.find((feature) => feature.feature === 'errorRate');
    expect(errorTrack?.mean ?? 1).toBeLessThanOrEqual(0.04);
  });

  it('S6 finish-reason mix shift 5 to 40 percent: categorical finding within 80 turns', () => {
    const ctx = scenario();
    const rand = lcg(106);
    for (let i = 0; i < 600; i += 1) ctx.observe(healthyTurn(rand));
    let detectedAfter = -1;
    for (let i = 0; i < 120; i += 1) {
      ctx.observe(healthyTurn(rand, 0, 0.4));
      if (detectedAfter < 0) {
        const hit = ctx.events.some(
          (event) => event.kind === 'drift.detected' && event.feature === 'finishReason',
        );
        if (hit) detectedAfter = i + 1;
      }
    }
    expect(detectedAfter).toBeGreaterThan(0);
    expect(detectedAfter).toBeLessThanOrEqual(80);
  });

  it('S7 clean latency ramp: a significant forecast fires before the critical threshold is crossed', () => {
    const ctx = scenario();
    const rand = lcg(107);
    for (let i = 0; i < 600; i += 1) ctx.observe(healthyTurn(rand));
    let forecastAt = -1;
    let criticalAt = -1;
    for (let i = 0; i < 150; i += 1) {
      const base = healthyTurn(rand);
      ctx.observe({ ...base, latencyMs: 800 + i * 6 + gauss(rand) * 25 });
      if (forecastAt < 0) {
        const f = ctx.events.some(
          (event) => event.kind === 'forecast.detected' && event.feature === 'latencyMs',
        );
        if (f) forecastAt = i + 1;
      }
      if (criticalAt < 0) {
        const c = ctx.events.some(
          (event) =>
            event.kind === 'drift.detected' &&
            event.feature === 'latencyMs' &&
            event.severity === 'critical',
        );
        if (c) criticalAt = i + 1;
      }
    }
    expect(forecastAt).toBeGreaterThan(0);
    if (criticalAt > 0) {
      expect(forecastAt).toBeLessThan(criticalAt);
    }
  });
});
