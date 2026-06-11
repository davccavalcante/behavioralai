import type { NumericFeatureName, TurnObservation } from '../types.js';

/** Features derived from one observation. */
export interface ExtractedFeatures {
  readonly numeric: ReadonlyMap<NumericFeatureName, number>;
  /** Tool names invoked this turn (one categorical sample per call). */
  readonly toolSelection: readonly string[];
  readonly finishReason: string | undefined;
}

/**
 * Derive the multi-dimensional behavioral feature vector from a raw turn.
 * Only dimensions present on the observation are extracted; the fingerprint
 * learns whatever the caller consistently provides. `errorRate` is always
 * extracted (absent error field means a healthy turn) so silent failure
 * onset is always observable.
 */
export function extractFeatures(turn: TurnObservation): ExtractedFeatures {
  const numeric = new Map<NumericFeatureName, number>();

  if (isFiniteNumber(turn.latencyMs)) numeric.set('latencyMs', turn.latencyMs);
  if (isFiniteNumber(turn.costUsd)) numeric.set('costUsd', turn.costUsd);
  if (isFiniteNumber(turn.inputTokens)) numeric.set('inputTokens', turn.inputTokens);
  if (isFiniteNumber(turn.outputTokens)) numeric.set('outputTokens', turn.outputTokens);

  if (isFiniteNumber(turn.inputTokens) || isFiniteNumber(turn.outputTokens)) {
    numeric.set('totalTokens', (turn.inputTokens ?? 0) + (turn.outputTokens ?? 0));
  }

  if (isFiniteNumber(turn.contextTokens)) {
    numeric.set('contextTokens', turn.contextTokens);
    if (isFiniteNumber(turn.outputTokens) && turn.contextTokens > 0) {
      // Context signal-to-noise: how much completion each context token buys.
      numeric.set('contextSnr', turn.outputTokens / turn.contextTokens);
    }
  }

  if (isFiniteNumber(turn.retrievalChunks)) numeric.set('retrievalChunks', turn.retrievalChunks);
  if (isFiniteNumber(turn.turnIndex)) numeric.set('turnIndex', turn.turnIndex);

  const toolSelection: string[] = [];
  if (turn.toolCalls !== undefined) {
    numeric.set('toolCallCount', turn.toolCalls.length);
    if (turn.toolCalls.length > 0) {
      let failures = 0;
      for (const call of turn.toolCalls) {
        toolSelection.push(call.name);
        if (!call.ok) failures += 1;
      }
      numeric.set('toolFailureRate', failures / turn.toolCalls.length);
    }
  }

  numeric.set('errorRate', turn.error !== undefined && turn.error !== false ? 1 : 0);

  return {
    numeric,
    toolSelection,
    finishReason: turn.finishReason,
  };
}

function isFiniteNumber(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
