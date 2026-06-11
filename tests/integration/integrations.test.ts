/**
 * Integration tests for src/integrations: structural compatibility with the
 * REAL published @takk/keymesh and @takk/modelchain type surfaces, plus the
 * runtime behavior of both bridges and the alert summarizer. The packages are
 * imported as types only, so no provider code runs and no network is touched.
 */

import type {
  AllExhaustedEvent,
  CircuitOpenEvent,
  KeymeshExtras,
  TelemetryEvent as KeymeshTelemetryEvent,
  RequestFailEvent,
  RequestSuccessEvent,
} from '@takk/keymesh';
import type {
  ModelchainRouter,
  TelemetryEvent as ModelchainTelemetryEvent,
} from '@takk/modelchain';
import { describe, expect, it } from 'vitest';
import {
  type BehavioralObserverLike,
  type KeymeshBridgeEventName,
  type KeymeshExtrasLike,
  type KeymeshTelemetryEventLike,
  keymeshBridge,
  type ModelchainCompleteLike,
  type ModelchainCompletionRequestLike,
  type ModelchainRouterTelemetryLike,
  type ModelchainTelemetryEventLike,
  modelchainAlertSummarizer,
  modelchainBridge,
} from '../../src/integrations/index.js';
import type { Alert, TurnObservation } from '../../src/types.js';

const EPOCH = 1_750_000_000_000;
const STEP = 30_000;

const ALERT = {
  id: 'agent-x-drift-1750000000000-1',
  agentId: 'agent-x',
  kind: 'drift',
  severity: 'critical',
  title: 'Behavioral drift detected: agent-x',
  message: 'Behavior score 41/100. latencyMs is above baseline',
  behaviorScore: 41,
  attributions: [
    {
      feature: 'latencyMs',
      contribution: 1,
      score: 5.2,
      direction: 'above',
      observed: 3400,
      expected: 800,
      summary: 'latencyMs is above baseline: observed 3400 vs expected 800 (z=5.2)',
    },
  ],
  timestamp: 1_750_000_000_000,
} as const satisfies Alert;

/**
 * Compile-time proof that the published package types satisfy the structural
 * interfaces this module binds to. If any of these arrows stops compiling,
 * the structural pins in src/integrations/index.ts have drifted from the
 * published 1.0.0 declarations.
 */
const keymeshAssign = (extras: KeymeshExtras): KeymeshExtrasLike => extras;
const keymeshEventAssign = (event: KeymeshTelemetryEvent): KeymeshTelemetryEventLike => event;
const routerAssign = (router: ModelchainRouter): ModelchainRouterTelemetryLike => router;
const completeAssign = (router: ModelchainRouter): ModelchainCompleteLike => router;
const modelchainEventAssign = (event: ModelchainTelemetryEvent): ModelchainTelemetryEventLike =>
  event;

/** Records every observation handed to it. */
class RecordingEngine implements BehavioralObserverLike {
  readonly turns: TurnObservation[] = [];

  observe(turn: TurnObservation): unknown {
    this.turns.push(turn);
    return undefined;
  }
}

/** Minimal keymesh-shaped emitter satisfying the structural on/off surface. */
class FakeKeymeshClient implements KeymeshExtrasLike {
  private readonly handlers = new Map<
    KeymeshBridgeEventName,
    Set<(event: KeymeshTelemetryEventLike) => void>
  >();

  on(event: KeymeshBridgeEventName, handler: (event: KeymeshTelemetryEventLike) => void): void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler);
    this.handlers.set(event, set);
  }

  off(event: KeymeshBridgeEventName, handler: (event: KeymeshTelemetryEventLike) => void): void {
    this.handlers.get(event)?.delete(handler);
  }

  emit(event: KeymeshBridgeEventName, payload: KeymeshTelemetryEventLike): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(payload);
    }
  }

  handlerCount(event: KeymeshBridgeEventName): number {
    return this.handlers.get(event)?.size ?? 0;
  }
}

/** Minimal modelchain-shaped telemetry bus with an unsubscribing `on`. */
class FakeRouterBus implements ModelchainRouterTelemetryLike {
  private readonly listeners = new Set<(event: ModelchainTelemetryEventLike) => void>();

  readonly on = (listener: (event: ModelchainTelemetryEventLike) => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  emit(event: ModelchainTelemetryEventLike): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}

describe('structural compatibility with the published packages', () => {
  it('accepts the real keymesh and modelchain type surfaces without casts', () => {
    expect(typeof keymeshAssign).toBe('function');
    expect(typeof keymeshEventAssign).toBe('function');
    expect(typeof routerAssign).toBe('function');
    expect(typeof completeAssign).toBe('function');
    expect(typeof modelchainEventAssign).toBe('function');
  });
});

describe('keymeshBridge', () => {
  it('maps request.success to a non-error turn under the pool agent id', () => {
    const client = new FakeKeymeshClient();
    const engine = new RecordingEngine();
    keymeshBridge(client, engine);

    const event: RequestSuccessEvent = {
      type: 'request.success',
      keyId: 'k1',
      path: ['chat', 'completions', 'create'],
      elapsedMs: 123,
      timestamp: EPOCH,
    };
    client.emit('request.success', event);

    expect(engine.turns).toStrictEqual([
      {
        agentId: 'keymesh:pool',
        timestamp: EPOCH,
        error: false,
        latencyMs: 123,
        toolCalls: [{ name: 'key:k1', ok: true }],
      },
    ]);
  });

  it('maps request.fail to an error turn with a failed key tool call', () => {
    const client = new FakeKeymeshClient();
    const engine = new RecordingEngine();
    keymeshBridge(client, engine);

    const event: RequestFailEvent = {
      type: 'request.fail',
      keyId: 'k2',
      path: ['chat', 'completions', 'create'],
      status: 429,
      error: 'rate limited',
      elapsedMs: 45,
      timestamp: EPOCH + STEP,
    };
    client.emit('request.fail', event);

    expect(engine.turns).toStrictEqual([
      {
        agentId: 'keymesh:pool',
        timestamp: EPOCH + STEP,
        error: true,
        latencyMs: 45,
        toolCalls: [{ name: 'key:k2', ok: false }],
      },
    ]);
  });

  it('maps circuit.open and all.exhausted to error turns with finish reasons', () => {
    const client = new FakeKeymeshClient();
    const engine = new RecordingEngine();
    keymeshBridge(client, engine);

    const open: CircuitOpenEvent = {
      type: 'circuit.open',
      keyId: 'k3',
      consecutiveFailures: 5,
      cooldownUntil: EPOCH + 60_000,
      timestamp: EPOCH,
    };
    const exhausted: AllExhaustedEvent = {
      type: 'all.exhausted',
      reason: 'every key is cooling down',
      timestamp: EPOCH + STEP,
    };
    client.emit('circuit.open', open);
    client.emit('all.exhausted', exhausted);

    expect(engine.turns).toStrictEqual([
      { agentId: 'keymesh:pool', timestamp: EPOCH, error: true, finishReason: 'circuit.open' },
      {
        agentId: 'keymesh:pool',
        timestamp: EPOCH + STEP,
        error: true,
        finishReason: 'all.exhausted',
      },
    ]);
  });

  it('omits latencyMs and toolCalls when the event carries no elapsedMs or keyId', () => {
    const client = new FakeKeymeshClient();
    const engine = new RecordingEngine();
    keymeshBridge(client, engine);

    client.emit('request.success', { type: 'request.success', timestamp: EPOCH });

    expect(engine.turns).toStrictEqual([
      { agentId: 'keymesh:pool', timestamp: EPOCH, error: false },
    ]);
  });

  it('resolves per-key agent ids and falls back to the pool for all.exhausted', () => {
    const client = new FakeKeymeshClient();
    const engine = new RecordingEngine();
    keymeshBridge(client, engine, { perKey: true });

    const success: RequestSuccessEvent = {
      type: 'request.success',
      keyId: 'aa11',
      path: ['embeddings', 'create'],
      elapsedMs: 60,
      timestamp: EPOCH,
    };
    const open: CircuitOpenEvent = {
      type: 'circuit.open',
      keyId: 'bb22',
      consecutiveFailures: 3,
      cooldownUntil: EPOCH + 30_000,
      timestamp: EPOCH + STEP,
    };
    const exhausted: AllExhaustedEvent = {
      type: 'all.exhausted',
      reason: 'retry budget spent',
      timestamp: EPOCH + 2 * STEP,
    };
    client.emit('request.success', success);
    client.emit('circuit.open', open);
    client.emit('all.exhausted', exhausted);

    expect(engine.turns.map((turn) => turn.agentId)).toStrictEqual([
      'keymesh:aa11',
      'keymesh:bb22',
      'keymesh:pool',
    ]);
  });

  it('uses a fixed agentId override for every event, beating perKey', () => {
    const client = new FakeKeymeshClient();
    const engine = new RecordingEngine();
    keymeshBridge(client, engine, { agentId: 'credentials', perKey: true });

    const fail: RequestFailEvent = {
      type: 'request.fail',
      keyId: 'k9',
      path: ['chat'],
      error: 'boom',
      elapsedMs: 10,
      timestamp: EPOCH,
    };
    const exhausted: AllExhaustedEvent = {
      type: 'all.exhausted',
      reason: 'no candidate left',
      timestamp: EPOCH + STEP,
    };
    client.emit('request.fail', fail);
    client.emit('all.exhausted', exhausted);

    expect(engine.turns.map((turn) => turn.agentId)).toStrictEqual(['credentials', 'credentials']);
  });

  it('returns an unsubscribe that detaches every handler', () => {
    const client = new FakeKeymeshClient();
    const engine = new RecordingEngine();
    const unsubscribe = keymeshBridge(client, engine);

    const eventNames: readonly KeymeshBridgeEventName[] = [
      'request.success',
      'request.fail',
      'circuit.open',
      'all.exhausted',
    ];
    for (const name of eventNames) {
      expect(client.handlerCount(name)).toBe(1);
    }

    client.emit('request.success', { type: 'request.success', timestamp: EPOCH });
    expect(engine.turns).toHaveLength(1);

    unsubscribe();

    for (const name of eventNames) {
      expect(client.handlerCount(name)).toBe(0);
    }
    for (const name of eventNames) {
      client.emit(name, { type: name, timestamp: EPOCH + STEP });
    }
    expect(engine.turns).toHaveLength(1);
  });
});

describe('modelchainBridge', () => {
  it('maps request.success to a turn with latency, cost, tokens, and finish reason', () => {
    const bus = new FakeRouterBus();
    const engine = new RecordingEngine();
    modelchainBridge(bus, engine);

    const event: ModelchainTelemetryEvent = {
      type: 'request.success',
      modelId: 'haiku-4',
      latencyMs: 950,
      costUsd: 0.0042,
      usage: { inputTokens: 200, outputTokens: 80, totalTokens: 280 },
      finishReason: 'stop',
      toolCallCount: 0,
      timestamp: EPOCH,
    };
    bus.emit(event);

    expect(engine.turns).toStrictEqual([
      {
        agentId: 'modelchain:router',
        timestamp: EPOCH,
        error: false,
        latencyMs: 950,
        costUsd: 0.0042,
        inputTokens: 200,
        outputTokens: 80,
        finishReason: 'stop',
      },
    ]);
  });

  it('maps stream.finish exactly like request.success', () => {
    const bus = new FakeRouterBus();
    const engine = new RecordingEngine();
    modelchainBridge(bus, engine);

    const event: ModelchainTelemetryEvent = {
      type: 'stream.finish',
      modelId: 'haiku-4',
      latencyMs: 1800,
      costUsd: 0.009,
      usage: { inputTokens: 500, outputTokens: 240, totalTokens: 740 },
      finishReason: 'length',
      toolCallCount: 1,
      timestamp: EPOCH + STEP,
    };
    bus.emit(event);

    expect(engine.turns).toStrictEqual([
      {
        agentId: 'modelchain:router',
        timestamp: EPOCH + STEP,
        error: false,
        latencyMs: 1800,
        costUsd: 0.009,
        inputTokens: 500,
        outputTokens: 240,
        finishReason: 'length',
      },
    ]);
  });

  it('maps request.fail to a minimal error turn without copying error details', () => {
    const bus = new FakeRouterBus();
    const engine = new RecordingEngine();
    modelchainBridge(bus, engine);

    const event: ModelchainTelemetryEvent = {
      type: 'request.fail',
      modelId: 'haiku-4',
      status: 500,
      classification: 'server-error',
      message: 'upstream exploded',
      timestamp: EPOCH,
    };
    bus.emit(event);

    expect(engine.turns).toStrictEqual([
      { agentId: 'modelchain:router', timestamp: EPOCH, error: true },
    ]);
  });

  it('ignores event kinds outside the completion lifecycle', () => {
    const bus = new FakeRouterBus();
    const engine = new RecordingEngine();
    modelchainBridge(bus, engine);

    const selected: ModelchainTelemetryEvent = {
      type: 'model.selected',
      modelId: 'haiku-4',
      reason: 'round-robin',
      timestamp: EPOCH,
    };
    const start: ModelchainTelemetryEvent = {
      type: 'request.start',
      attempt: 1,
      timestamp: EPOCH,
    };
    const open: ModelchainTelemetryEvent = {
      type: 'circuit.open',
      modelId: 'haiku-4',
      cooldownUntil: EPOCH + 60_000,
      timestamp: EPOCH,
    };
    bus.emit(selected);
    bus.emit(start);
    bus.emit(open);

    expect(engine.turns).toStrictEqual([]);
  });

  it('resolves per-model agent ids, falling back to the router profile', () => {
    const bus = new FakeRouterBus();
    const engine = new RecordingEngine();
    modelchainBridge(bus, engine, { perModel: true });

    const success: ModelchainTelemetryEvent = {
      type: 'request.success',
      modelId: 'haiku-4',
      latencyMs: 700,
      costUsd: 0.001,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      finishReason: 'stop',
      toolCallCount: 0,
      timestamp: EPOCH,
    };
    bus.emit(success);
    bus.emit({ type: 'request.fail', timestamp: EPOCH + STEP });

    expect(engine.turns.map((turn) => turn.agentId)).toStrictEqual([
      'modelchain:haiku-4',
      'modelchain:router',
    ]);
  });

  it('uses a fixed agentId override, beating perModel', () => {
    const bus = new FakeRouterBus();
    const engine = new RecordingEngine();
    modelchainBridge(bus, engine, { agentId: 'llm', perModel: true });

    const fail: ModelchainTelemetryEvent = {
      type: 'request.fail',
      modelId: 'haiku-4',
      classification: 'timeout',
      message: 'deadline',
      timestamp: EPOCH,
    };
    bus.emit(fail);

    expect(engine.turns.map((turn) => turn.agentId)).toStrictEqual(['llm']);
  });

  it('returns the unsubscribe from the router bus and stops observing', () => {
    const bus = new FakeRouterBus();
    const engine = new RecordingEngine();
    const unsubscribe = modelchainBridge(bus, engine);
    expect(bus.listenerCount()).toBe(1);

    const event: ModelchainTelemetryEvent = {
      type: 'request.success',
      modelId: 'haiku-4',
      latencyMs: 100,
      costUsd: 0.0001,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: 'stop',
      toolCallCount: 0,
      timestamp: EPOCH,
    };
    bus.emit(event);
    expect(engine.turns).toHaveLength(1);

    unsubscribe();
    expect(bus.listenerCount()).toBe(0);
    bus.emit(event);
    expect(engine.turns).toHaveLength(1);
  });
});

describe('modelchainAlertSummarizer', () => {
  it('appends a trimmed incident summary to a new alert, preserving other fields', async () => {
    const router: ModelchainCompleteLike = {
      complete: () => Promise.resolve({ text: ' Latency doubled. Check the provider. ' }),
    };
    const enrich = modelchainAlertSummarizer({ router });

    const result = await enrich(ALERT);

    expect(result).not.toBe(ALERT);
    expect(result.message).toBe(
      `${ALERT.message}\n\nIncident summary: Latency doubled. Check the provider.`,
    );
    expect(result.message.endsWith('Incident summary: Latency doubled. Check the provider.')).toBe(
      true,
    );
    expect(result.id).toBe(ALERT.id);
    expect(result.agentId).toBe(ALERT.agentId);
    expect(result.kind).toBe(ALERT.kind);
    expect(result.severity).toBe(ALERT.severity);
    expect(result.title).toBe(ALERT.title);
    expect(result.behaviorScore).toBe(ALERT.behaviorScore);
    expect(result.attributions).toBe(ALERT.attributions);
    expect(result.timestamp).toBe(ALERT.timestamp);
  });

  it('sends a prompt carrying agent, severity, score, attributions, and defaults', async () => {
    const requests: ModelchainCompletionRequestLike[] = [];
    const router: ModelchainCompleteLike = {
      complete: (request) => {
        requests.push(request);
        return Promise.resolve({ text: 'Summary.' });
      },
    };
    const enrich = modelchainAlertSummarizer({ router });

    await enrich(ALERT);

    expect(requests).toHaveLength(1);
    const request = requests[0];
    if (request === undefined) {
      throw new Error('expected exactly one completion request');
    }
    expect(request.prompt).toContain('Alert: Behavioral drift detected: agent-x');
    expect(request.prompt).toContain('Agent: agent-x');
    expect(request.prompt).toContain('Severity: critical');
    expect(request.prompt).toContain('Behavior score: 41');
    expect(request.prompt).toContain('Attributions:');
    expect(request.prompt).toContain(
      '- latencyMs is above baseline: observed 3400 vs expected 800 (z=5.2)',
    );
    expect(request.maxTokens).toBe(120);
    expect(request.system).toContain('SRE assistant');
  });

  it('plumbs system and maxTokens overrides through to the router', async () => {
    const requests: ModelchainCompletionRequestLike[] = [];
    const router: ModelchainCompleteLike = {
      complete: (request) => {
        requests.push(request);
        return Promise.resolve({ text: 'Summary.' });
      },
    };
    const enrich = modelchainAlertSummarizer({
      router,
      maxTokens: 64,
      system: 'Reply with one short sentence.',
    });

    await enrich(ALERT);

    expect(requests).toHaveLength(1);
    const request = requests[0];
    if (request === undefined) {
      throw new Error('expected exactly one completion request');
    }
    expect(request.maxTokens).toBe(64);
    expect(request.system).toBe('Reply with one short sentence.');
  });

  it('omits the attributions section when the alert has none', async () => {
    const requests: ModelchainCompletionRequestLike[] = [];
    const router: ModelchainCompleteLike = {
      complete: (request) => {
        requests.push(request);
        return Promise.resolve({ text: 'Summary.' });
      },
    };
    const enrich = modelchainAlertSummarizer({ router });

    await enrich({ ...ALERT, attributions: [] });

    expect(requests).toHaveLength(1);
    const request = requests[0];
    if (request === undefined) {
      throw new Error('expected exactly one completion request');
    }
    expect(request.prompt).not.toContain('Attributions:');
  });

  it('returns the original alert object when the router rejects', async () => {
    const router: ModelchainCompleteLike = {
      complete: () => Promise.reject(new Error('provider down')),
    };
    const enrich = modelchainAlertSummarizer({ router });

    const result = await enrich(ALERT);

    expect(result).toBe(ALERT);
  });

  it('returns the original alert object when the router returns blank text', async () => {
    const router: ModelchainCompleteLike = {
      complete: () => Promise.resolve({ text: '   ' }),
    };
    const enrich = modelchainAlertSummarizer({ router });

    const result = await enrich(ALERT);

    expect(result).toBe(ALERT);
  });
});
