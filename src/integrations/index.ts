/**
 * Optional adapters for the sibling packages `@takk/keymesh` and
 * `@takk/modelchain`. Both packages are OPTIONAL peers; nothing in this
 * module imports them, at build time or at runtime. The adapters accept
 * already-constructed instances and bind to them through minimal structural
 * interfaces, so consumers without these packages pay nothing.
 *
 * Structural compatibility is pinned to the published 1.0.0 type
 * declarations of both packages and proven by an integration test that
 * imports the real packages.
 *
 * @module
 */

import type { Alert, AlertEnricher, TurnObservation } from '../types.js';

/** Minimal engine surface required by the bridges; satisfied by `BehavioralAI`. */
export interface BehavioralObserverLike {
  /** Ingest one turn observation. The return value is ignored by the bridges. */
  observe(turn: TurnObservation): unknown;
}

/** Telemetry event names the keymesh bridge subscribes to. */
export type KeymeshBridgeEventName =
  | 'request.success'
  | 'request.fail'
  | 'circuit.open'
  | 'all.exhausted';

/**
 * Structural supertype of every member of keymesh's telemetry event union.
 * Only `type` and `timestamp` are common to all events; the remaining
 * fields are optional and present on the events the bridge subscribes to.
 */
export interface KeymeshTelemetryEventLike {
  /** Event discriminator, for example "request.success" or "circuit.open". */
  readonly type: string;
  /** Epoch milliseconds. */
  readonly timestamp: number;
  /** Hashed identifier of the key the event refers to, when key-scoped. */
  readonly keyId?: string;
  /** Wall-clock duration of the request, milliseconds. */
  readonly elapsedMs?: number;
  /** Human-readable error message on failure events. */
  readonly error?: string;
  /** HTTP status on failure events, when known. */
  readonly status?: number | undefined;
  /** Reason string on rotation and exhaustion events. */
  readonly reason?: string;
}

/**
 * Structural subset of keymesh's `KeymeshExtras` (the `on`/`off` telemetry
 * surface attached to every keymesh client). The published generic
 * `on<T>(event, handler)` and `off<T>(event, handler)` signatures satisfy
 * this interface.
 */
export interface KeymeshExtrasLike {
  /** Subscribe to a telemetry event. */
  on(event: KeymeshBridgeEventName, handler: (event: KeymeshTelemetryEventLike) => void): void;
  /** Unsubscribe a previously attached telemetry handler. */
  off(event: KeymeshBridgeEventName, handler: (event: KeymeshTelemetryEventLike) => void): void;
}

/** Options accepted by {@link keymeshBridge}. */
export interface KeymeshBridgeOptions {
  /** Fixed agent id for every observation. Overrides the defaults below. */
  readonly agentId?: string;
  /**
   * Fingerprint each credential separately under `keymesh:<keyId>` instead
   * of the pool-wide `keymesh:pool` profile. Default false.
   */
  readonly perKey?: boolean;
}

/**
 * Subscribe to keymesh telemetry and translate it into Behavioral AI
 * {@link TurnObservation}s so the engine fingerprints the credential pool:
 * `request.success` and `request.fail` become turns with latency, error
 * flag, and a `key:<keyId>` tool call; `circuit.open` and `all.exhausted`
 * become error turns with `finishReason` set to the event kind.
 *
 * @param client Any keymesh client (it exposes the `KeymeshExtras` surface).
 * @param engine The Behavioral AI engine (or anything with `observe`).
 * @param options Agent id resolution options.
 * @returns An unsubscribe function that detaches every handler it attached.
 */
export function keymeshBridge(
  client: KeymeshExtrasLike,
  engine: BehavioralObserverLike,
  options: KeymeshBridgeOptions = {},
): () => void {
  const perKey = options.perKey === true;
  const resolveAgentId = (keyId?: string): string => {
    if (options.agentId !== undefined) {
      return options.agentId;
    }
    if (perKey && keyId !== undefined) {
      return `keymesh:${keyId}`;
    }
    return 'keymesh:pool';
  };

  const onSuccess = (event: KeymeshTelemetryEventLike): void => {
    engine.observe({
      agentId: resolveAgentId(event.keyId),
      timestamp: event.timestamp,
      error: false,
      ...(event.elapsedMs !== undefined ? { latencyMs: event.elapsedMs } : {}),
      ...(event.keyId !== undefined
        ? { toolCalls: [{ name: `key:${event.keyId}`, ok: true }] }
        : {}),
    });
  };
  const onFail = (event: KeymeshTelemetryEventLike): void => {
    engine.observe({
      agentId: resolveAgentId(event.keyId),
      timestamp: event.timestamp,
      error: true,
      ...(event.elapsedMs !== undefined ? { latencyMs: event.elapsedMs } : {}),
      ...(event.keyId !== undefined
        ? { toolCalls: [{ name: `key:${event.keyId}`, ok: false }] }
        : {}),
    });
  };
  const onCircuitOpen = (event: KeymeshTelemetryEventLike): void => {
    engine.observe({
      agentId: resolveAgentId(event.keyId),
      timestamp: event.timestamp,
      error: true,
      finishReason: 'circuit.open',
    });
  };
  const onAllExhausted = (event: KeymeshTelemetryEventLike): void => {
    engine.observe({
      agentId: resolveAgentId(),
      timestamp: event.timestamp,
      error: true,
      finishReason: 'all.exhausted',
    });
  };

  client.on('request.success', onSuccess);
  client.on('request.fail', onFail);
  client.on('circuit.open', onCircuitOpen);
  client.on('all.exhausted', onAllExhausted);

  return () => {
    client.off('request.success', onSuccess);
    client.off('request.fail', onFail);
    client.off('circuit.open', onCircuitOpen);
    client.off('all.exhausted', onAllExhausted);
  };
}

/** Structural subset of modelchain's `TokenUsage`. */
export interface ModelchainTokenUsageLike {
  /** Prompt-side token count. */
  readonly inputTokens: number;
  /** Completion-side token count. */
  readonly outputTokens: number;
}

/**
 * Structural supertype of every member of modelchain's telemetry event
 * union. Only `type` and `timestamp` are common to all events; the
 * remaining fields are optional and present on the completion lifecycle
 * events (`request.success`, `stream.finish`, `request.fail`).
 */
export interface ModelchainTelemetryEventLike {
  /** Event discriminator, for example "request.success" or "request.fail". */
  readonly type: string;
  /** Epoch milliseconds. */
  readonly timestamp: number;
  /** Model that served the request, when the event is model-scoped. */
  readonly modelId?: string;
  /** End-to-end completion latency, milliseconds. */
  readonly latencyMs?: number;
  /** Cost of the completion, US dollars. */
  readonly costUsd?: number;
  /** Token usage of the completion. */
  readonly usage?: ModelchainTokenUsageLike;
  /** Provider finish reason, for example "stop" or "length". */
  readonly finishReason?: string;
  /** Error message on failure events. */
  readonly message?: string;
  /** Normalized error classification on failure events. */
  readonly classification?: string;
  /** HTTP status on failure events, when known. */
  readonly status?: number;
}

/**
 * Structural subset of modelchain's `ModelchainRouter`: the single
 * telemetry bus. `on(listener)` returns an unsubscribe function.
 */
export interface ModelchainRouterTelemetryLike {
  /** Subscribe to telemetry events. Returns an unsubscribe function. */
  readonly on: (listener: (event: ModelchainTelemetryEventLike) => void) => () => void;
}

/** Options accepted by {@link modelchainBridge}. */
export interface ModelchainBridgeOptions {
  /** Fixed agent id for every observation. Overrides the defaults below. */
  readonly agentId?: string;
  /**
   * Fingerprint each model separately under `modelchain:<modelId>` instead
   * of the router-wide `modelchain:router` profile. Default false.
   */
  readonly perModel?: boolean;
}

/**
 * Subscribe to modelchain router telemetry and translate completion
 * lifecycle events into Behavioral AI {@link TurnObservation}s:
 * `request.success` and `stream.finish` become turns carrying latency,
 * cost, token usage, and finish reason; `request.fail` becomes an error
 * turn. All other event kinds are ignored.
 *
 * @param router The modelchain router (or anything with its `on` bus).
 * @param engine The Behavioral AI engine (or anything with `observe`).
 * @param options Agent id resolution options.
 * @returns An unsubscribe function that detaches the listener.
 */
export function modelchainBridge(
  router: ModelchainRouterTelemetryLike,
  engine: BehavioralObserverLike,
  options: ModelchainBridgeOptions = {},
): () => void {
  const perModel = options.perModel === true;
  const resolveAgentId = (modelId?: string): string => {
    if (options.agentId !== undefined) {
      return options.agentId;
    }
    if (perModel && modelId !== undefined) {
      return `modelchain:${modelId}`;
    }
    return 'modelchain:router';
  };

  const listener = (event: ModelchainTelemetryEventLike): void => {
    if (event.type === 'request.success' || event.type === 'stream.finish') {
      engine.observe({
        agentId: resolveAgentId(event.modelId),
        timestamp: event.timestamp,
        error: false,
        ...(event.latencyMs !== undefined ? { latencyMs: event.latencyMs } : {}),
        ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
        ...(event.usage !== undefined
          ? { inputTokens: event.usage.inputTokens, outputTokens: event.usage.outputTokens }
          : {}),
        ...(event.finishReason !== undefined ? { finishReason: event.finishReason } : {}),
      });
      return;
    }
    if (event.type === 'request.fail') {
      engine.observe({
        agentId: resolveAgentId(event.modelId),
        timestamp: event.timestamp,
        error: true,
      });
    }
  };

  return router.on(listener);
}

/** Structural subset of modelchain's `CompletionRequest` used by the summarizer. */
export interface ModelchainCompletionRequestLike {
  /** User prompt text. */
  readonly prompt: string;
  /** System prompt. */
  readonly system?: string;
  /** Completion-side token cap. */
  readonly maxTokens?: number;
}

/** Structural subset of modelchain's `CompletionResponse` used by the summarizer. */
export interface ModelchainCompletionResponseLike {
  /** Free-text content of the completion. */
  readonly text: string;
}

/** Structural subset of modelchain's `ModelchainRouter`: the `complete` call. */
export interface ModelchainCompleteLike {
  /** Execute one completion request. */
  readonly complete: (
    request: ModelchainCompletionRequestLike,
  ) => Promise<ModelchainCompletionResponseLike>;
}

/** Options accepted by {@link modelchainAlertSummarizer}. */
export interface ModelchainAlertSummarizerOptions {
  /** A modelchain router (or anything exposing its `complete` call). */
  readonly router: ModelchainCompleteLike;
  /** Completion-side token cap for the summary. Default 120. */
  readonly maxTokens?: number;
  /** System prompt override. */
  readonly system?: string;
}

/** Default system prompt used by {@link modelchainAlertSummarizer}. */
const DEFAULT_SUMMARIZER_SYSTEM =
  'You are an SRE assistant. Summarize the behavioral incident in two sentences: what changed and what to check first. Plain text.';

/** Default completion-side token cap for the incident summary. */
const DEFAULT_SUMMARIZER_MAX_TOKENS = 120;

/** Builds the plain-text incident prompt sent to the router. */
function buildIncidentPrompt(alert: Alert): string {
  const lines = [
    `Alert: ${alert.title}`,
    `Agent: ${alert.agentId}`,
    `Severity: ${alert.severity}`,
    `Behavior score: ${alert.behaviorScore}`,
  ];
  if (alert.attributions.length > 0) {
    lines.push('Attributions:');
    for (const attribution of alert.attributions) {
      lines.push(`- ${attribution.summary}`);
    }
  }
  return lines.join('\n');
}

/**
 * Build an {@link AlertEnricher} that asks a modelchain router for a concise
 * incident summary and appends it to the alert message. On any failure, or
 * when the router returns empty text, the original alert is returned
 * unchanged. The enricher never throws.
 */
export function modelchainAlertSummarizer(
  options: ModelchainAlertSummarizerOptions,
): AlertEnricher {
  const system = options.system ?? DEFAULT_SUMMARIZER_SYSTEM;
  const maxTokens = options.maxTokens ?? DEFAULT_SUMMARIZER_MAX_TOKENS;
  return async (alert: Alert): Promise<Alert> => {
    try {
      const response = await options.router.complete({
        prompt: buildIncidentPrompt(alert),
        system,
        maxTokens,
      });
      const text = response.text.trim();
      if (text.length === 0) {
        return alert;
      }
      return { ...alert, message: `${alert.message}\n\nIncident summary: ${text}` };
    } catch {
      return alert;
    }
  };
}
