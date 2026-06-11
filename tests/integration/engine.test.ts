import { describe, expect, it } from 'vitest';
import { createBehavioralAI } from '../../src/core/createBehavioralAI.js';
import { ClosedError, ConfigurationError } from '../../src/errors.js';
import { memoryState } from '../../src/state/memory.js';
import type {
  Alert,
  AlertChannel,
  ChannelResult,
  TelemetryEvent,
  TurnObservation,
} from '../../src/types.js';

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

function healthyTurn(rand: () => number, index: number, agentId = 'agent-x'): TurnObservation {
  return {
    agentId,
    timestamp: EPOCH + index * STEP,
    latencyMs: 800 + gauss(rand) * 60,
    costUsd: 0.002 + rand() * 0.0004,
    toolCalls: [{ name: rand() < 0.6 ? 'web_search' : 'db_query', ok: rand() > 0.02 }],
    finishReason: rand() < 0.95 ? 'stop' : 'length',
  };
}

class FakeChannel implements AlertChannel {
  readonly name: string;
  readonly sent: Alert[] = [];
  private readonly fail: boolean;

  constructor(name = 'fake', fail = false) {
    this.name = name;
    this.fail = fail;
  }

  send(alert: Alert): Promise<ChannelResult> {
    if (this.fail) {
      return Promise.resolve({ channel: this.name, ok: false, error: 'simulated failure' });
    }
    this.sent.push(alert);
    return Promise.resolve({ channel: this.name, ok: true, status: 200 });
  }
}

function makeClock(): { now: () => number; advance: (ms: number) => void } {
  let current = EPOCH;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('createBehavioralAI end to end', () => {
  it('validates options and observations', () => {
    expect(() => createBehavioralAI({ warmup: { minObservations: 0 } })).toThrow(
      ConfigurationError,
    );
    expect(() => createBehavioralAI({ windowSize: 2 })).toThrow(ConfigurationError);
    const engine = createBehavioralAI();
    expect(() => engine.observe({ agentId: '' })).toThrow(ConfigurationError);
  });

  it('learns, detects drift, alerts once per cooldown, and recovers', async () => {
    const rand = lcg(21);
    const clock = makeClock();
    const channel = new FakeChannel();
    const events: TelemetryEvent[] = [];

    const engine = createBehavioralAI({
      warmup: { minObservations: 40 },
      windowSize: 20,
      channels: [channel],
      now: clock.now,
    });
    engine.on((event) => {
      events.push(event);
    });

    let index = 0;
    for (; index < 120; index += 1) {
      engine.observe(healthyTurn(rand, index));
      clock.advance(STEP);
    }
    expect(events.some((event) => event.kind === 'baseline.ready')).toBe(true);
    expect(events.filter((event) => event.kind === 'drift.detected')).toHaveLength(0);

    // Sustained 4x latency regression.
    for (let i = 0; i < 10; i += 1, index += 1) {
      const base = healthyTurn(rand, index);
      engine.observe({ ...base, latencyMs: 3400 + gauss(rand) * 80 });
      clock.advance(STEP);
    }
    const driftEvents = events.filter((event) => event.kind === 'drift.detected');
    expect(driftEvents.length).toBeGreaterThan(0);
    expect(driftEvents.some((event) => event.feature === 'latencyMs')).toBe(true);

    await engine.flush();
    // Cooldown collapses repeated drift alerts: at least one delivery, far
    // fewer deliveries than drift evaluations, plus suppression telemetry.
    expect(channel.sent.length).toBeGreaterThan(0);
    expect(channel.sent.length).toBeLessThan(driftEvents.length);
    expect(events.some((event) => event.kind === 'alert.suppressed')).toBe(true);
    expect(events.some((event) => event.kind === 'alert.dispatched')).toBe(true);
    const driftAlert = channel.sent.find((alert) => alert.kind === 'drift');
    expect(driftAlert).toBeDefined();
    expect(driftAlert?.attributions[0]?.feature).toBe('latencyMs');
    expect(driftAlert?.behaviorScore).toBeLessThan(70);

    // Recovery: back to normal long enough for the streak plus report settling.
    for (let i = 0; i < 15; i += 1, index += 1) {
      engine.observe(healthyTurn(rand, index));
      clock.advance(STEP);
    }
    expect(events.some((event) => event.kind === 'drift.recovered')).toBe(true);
    await engine.flush();
    expect(channel.sent.some((alert) => alert.kind === 'recovery')).toBe(true);

    await engine.close();
  });

  it('canary mode suppresses channel delivery but keeps telemetry', async () => {
    const rand = lcg(22);
    const clock = makeClock();
    const channel = new FakeChannel();
    const events: TelemetryEvent[] = [];

    const engine = createBehavioralAI({
      warmup: { minObservations: 30 },
      channels: [channel],
      alerts: { canary: true },
      now: clock.now,
    });
    engine.on((event) => {
      events.push(event);
    });

    let index = 0;
    for (; index < 80; index += 1) {
      engine.observe(healthyTurn(rand, index));
      clock.advance(STEP);
    }
    for (let i = 0; i < 8; i += 1, index += 1) {
      const base = healthyTurn(rand, index);
      engine.observe({ ...base, latencyMs: 4000 });
      clock.advance(STEP);
    }

    await engine.flush();
    expect(channel.sent).toHaveLength(0);
    const suppressed = events.filter((event) => event.kind === 'alert.suppressed');
    expect(suppressed.length).toBeGreaterThan(0);
    expect(suppressed[0]?.message).toBe('canary');
  });

  it('reports channel failures as telemetry, never as exceptions', async () => {
    const rand = lcg(23);
    const clock = makeClock();
    const events: TelemetryEvent[] = [];
    const engine = createBehavioralAI({
      warmup: { minObservations: 30 },
      channels: [new FakeChannel('broken', true)],
      now: clock.now,
    });
    engine.on((event) => {
      events.push(event);
    });

    let index = 0;
    for (; index < 80; index += 1) {
      engine.observe(healthyTurn(rand, index));
      clock.advance(STEP);
    }
    for (let i = 0; i < 8; i += 1, index += 1) {
      const base = healthyTurn(rand, index);
      engine.observe({ ...base, latencyMs: 4000 });
      clock.advance(STEP);
    }
    await engine.flush();
    expect(events.some((event) => event.kind === 'alert.failed')).toBe(true);
  });

  it('applies the enricher before dispatch', async () => {
    const rand = lcg(24);
    const clock = makeClock();
    const channel = new FakeChannel();
    const engine = createBehavioralAI({
      warmup: { minObservations: 30 },
      channels: [channel],
      enrich: (alert) => Promise.resolve({ ...alert, message: `${alert.message} [enriched]` }),
      now: clock.now,
    });

    let index = 0;
    for (; index < 80; index += 1) {
      engine.observe(healthyTurn(rand, index));
      clock.advance(STEP);
    }
    for (let i = 0; i < 8; i += 1, index += 1) {
      const base = healthyTurn(rand, index);
      engine.observe({ ...base, latencyMs: 4000 });
      clock.advance(STEP);
    }
    await engine.flush();
    expect(channel.sent.length).toBeGreaterThan(0);
    expect(channel.sent[0]?.message).toContain('[enriched]');
  });

  it('persists state and hydrates a fresh engine from it', async () => {
    const rand = lcg(25);
    const clock = makeClock();
    const backend = memoryState();

    const first = createBehavioralAI({
      warmup: { minObservations: 30 },
      state: backend,
      now: clock.now,
    });
    for (let index = 0; index < 60; index += 1) {
      first.observe(healthyTurn(rand, index));
      clock.advance(STEP);
    }
    const before = first.fingerprintOf('agent-x');
    await first.close();

    const second = createBehavioralAI({
      warmup: { minObservations: 30 },
      state: backend,
      now: clock.now,
    });
    await second.ready();
    const after = second.fingerprintOf('agent-x');
    expect(after?.observations).toBe(before?.observations);
    expect(after?.status).toBe('ready');
    expect(after?.numeric).toEqual(before?.numeric);
    expect(second.agents()).toEqual(['agent-x']);
  });

  it('exposes snapshots, reports, absorb, and close semantics', async () => {
    const rand = lcg(26);
    const clock = makeClock();
    const engine = createBehavioralAI({
      warmup: { minObservations: 10 },
      now: clock.now,
    });

    for (let index = 0; index < 20; index += 1) {
      engine.observe(healthyTurn(rand, index));
      clock.advance(STEP);
    }
    expect(engine.agents()).toEqual(['agent-x']);
    expect(engine.reportOf('agent-x')?.agentId).toBe('agent-x');
    expect(engine.inspect().observations).toBe(20);
    expect(engine.inspect().agents[0]?.numeric.length).toBeGreaterThan(0);

    expect(() => engine.absorb('unknown')).toThrow(ConfigurationError);
    engine.absorb('agent-x');

    await engine.close();
    expect(() => engine.observe(healthyTurn(rand, 99))).toThrow(ClosedError);
  });

  it('emits forecast telemetry on a steady ramp', async () => {
    const rand = lcg(27);
    const clock = makeClock();
    const events: TelemetryEvent[] = [];
    const channel = new FakeChannel();
    const engine = createBehavioralAI({
      warmup: { minObservations: 40 },
      windowSize: 20,
      channels: [channel],
      now: clock.now,
    });
    engine.on((event) => {
      events.push(event);
    });

    let index = 0;
    for (; index < 80; index += 1) {
      engine.observe(healthyTurn(rand, index));
      clock.advance(STEP);
    }
    for (let i = 0; i < 60; i += 1, index += 1) {
      const base = healthyTurn(rand, index);
      engine.observe({ ...base, latencyMs: 820 + i * 6 + gauss(rand) * 20 });
      clock.advance(STEP);
    }
    expect(events.some((event) => event.kind === 'forecast.detected')).toBe(true);
    await engine.flush();
    expect(channel.sent.some((alert) => alert.kind === 'forecast')).toBe(true);
    await engine.close();
  });
});
