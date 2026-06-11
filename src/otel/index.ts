/**
 * OpenTelemetry GenAI span ingestion for @takk/behavioralai.
 *
 * Maps plain, duck-typed span data onto {@link TurnObservation} without any
 * OpenTelemetry runtime dependency. The expectation is one span per agent
 * turn: each model or agent span becomes one observation, and each tool
 * execution span becomes one observation with a single tool call record.
 *
 * Supported conventions are the OpenTelemetry GenAI semantic conventions
 * (`gen_ai.*` attributes), including both the current token attribute names
 * (`gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens`) and the legacy
 * names (`gen_ai.usage.prompt_tokens` / `gen_ai.usage.completion_tokens`).
 *
 * Tool spans (operation `execute_tool` or `tool`, or a `gen_ai.tool.name`
 * attribute without usage tokens) are profiled as first-class observed units
 * under a `tool:<name>` fingerprint, so each tool develops its own behavioral
 * baseline independently of the calling agent.
 *
 * Any OTLP pipeline that can hand over span exports as plain JSON can feed
 * this mapper, including the community hermes-otel plugin for Hermes Agent;
 * no SDK types are required, only the duck-typed {@link OtelSpanData} shape.
 *
 * @module
 */

import type { ToolCallRecord, TurnObservation } from '../types.js';

/**
 * Duck-typed span data accepted by {@link turnFromSpan}. Compatible with
 * OTLP JSON span exports, OpenTelemetry JS `ReadableSpan` shapes (hrtime
 * tuples), and hand-built objects. All fields are optional; the mapper uses
 * whatever is present.
 */
export interface OtelSpanData {
  /** Span name, used as a tool-name fallback for tool spans. */
  name?: string;
  /** Span attributes keyed by semantic-convention attribute name. */
  attributes?: Readonly<Record<string, unknown>>;
  /** OTLP start timestamp in nanoseconds since the Unix epoch. */
  startTimeUnixNano?: string | number;
  /** OTLP end timestamp in nanoseconds since the Unix epoch. */
  endTimeUnixNano?: string | number;
  /** Start time as epoch milliseconds or an hrtime `[seconds, nanos]` tuple. */
  startTime?: number | readonly [number, number];
  /** End time as epoch milliseconds or an hrtime `[seconds, nanos]` tuple. */
  endTime?: number | readonly [number, number];
  /** Precomputed span duration in milliseconds; wins over timestamps. */
  durationMs?: number;
  /** Span status; code 2, "ERROR", or "STATUS_CODE_ERROR" marks a failure. */
  status?: { readonly code?: number | string };
  /** Span kind; accepted for shape compatibility, not used by the mapper. */
  kind?: number | string;
}

/** Options accepted by {@link turnFromSpan} and {@link observeSpan}. */
export interface TurnFromSpanOptions {
  /** Fixed agent id; overrides any id resolved from span attributes. */
  agentId?: string;
  /**
   * Attribute names probed in order to resolve the agent id of model and
   * agent spans. Defaults to `gen_ai.agent.id`, `gen_ai.agent.name`,
   * `agent.id`, `service.name`.
   */
  agentIdAttributes?: readonly string[];
  /** Prefix for tool-span fingerprint ids. Default `tool:`. */
  toolProfilePrefix?: string;
}

/** Default attribute probe order for resolving the agent id. */
const DEFAULT_AGENT_ID_ATTRIBUTES: readonly string[] = [
  'gen_ai.agent.id',
  'gen_ai.agent.name',
  'agent.id',
  'service.name',
];

/** Default fingerprint prefix for tool spans. */
const DEFAULT_TOOL_PROFILE_PREFIX = 'tool:';

/**
 * Returns the first string value found under the given attribute keys. When
 * the value is an array, its first element is returned if it is a string.
 */
function attrString(
  attrs: Readonly<Record<string, unknown>> | undefined,
  ...keys: readonly string[]
): string | undefined {
  if (attrs === undefined) {
    return undefined;
  }
  for (const key of keys) {
    const value = attrs[key];
    if (typeof value === 'string') {
      return value;
    }
    if (Array.isArray(value)) {
      const first: unknown = value[0];
      if (typeof first === 'string') {
        return first;
      }
    }
  }
  return undefined;
}

/**
 * Returns the first finite number found under the given attribute keys.
 * Numeric strings are parsed; non-finite values are skipped.
 */
function attrNumber(
  attrs: Readonly<Record<string, unknown>> | undefined,
  ...keys: readonly string[]
): number | undefined {
  if (attrs === undefined) {
    return undefined;
  }
  for (const key of keys) {
    const value = attrs[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

/** A timestamp resolved to milliseconds plus whether it is epoch-based. */
interface ResolvedTime {
  readonly ms: number;
  /** True for UnixNano fields and plain numbers; false for hrtime tuples. */
  readonly epoch: boolean;
}

/**
 * Resolves one span timestamp to milliseconds. UnixNano fields (string or
 * number) divide by 1e6, hrtime `[seconds, nanos]` tuples combine both parts,
 * and plain numbers are treated as epoch milliseconds.
 */
function resolveTime(
  unixNano: string | number | undefined,
  time: number | readonly [number, number] | undefined,
): ResolvedTime | undefined {
  if (typeof unixNano === 'number' && Number.isFinite(unixNano)) {
    return { ms: unixNano / 1e6, epoch: true };
  }
  if (typeof unixNano === 'string' && unixNano.trim() !== '') {
    const nanos = Number(unixNano);
    if (Number.isFinite(nanos)) {
      return { ms: nanos / 1e6, epoch: true };
    }
  }
  if (Array.isArray(time)) {
    const seconds: unknown = time[0];
    const nanos: unknown = time[1];
    if (
      typeof seconds === 'number' &&
      Number.isFinite(seconds) &&
      typeof nanos === 'number' &&
      Number.isFinite(nanos)
    ) {
      return { ms: seconds * 1000 + nanos / 1e6, epoch: false };
    }
    return undefined;
  }
  if (typeof time === 'number' && Number.isFinite(time)) {
    return { ms: time, epoch: true };
  }
  return undefined;
}

/** True when the span status marks a failure per OTel status conventions. */
function isErrorStatus(status: OtelSpanData['status']): boolean {
  const code = status?.code;
  if (typeof code === 'number') {
    return code === 2;
  }
  if (typeof code === 'string') {
    const upper = code.toUpperCase();
    return upper === 'ERROR' || upper === 'STATUS_CODE_ERROR';
  }
  return false;
}

/**
 * Maps one OpenTelemetry GenAI span onto a {@link TurnObservation}.
 *
 * Tool spans (operation name `execute_tool` or `tool`, or a `gen_ai.tool.name`
 * attribute without usage tokens) map to a `tool:<name>` fingerprint with a
 * single tool call record. All other spans map to a model or agent
 * observation whose id resolves from `options.agentId`, then the configured
 * or default agent id attributes. Returns undefined when no agent id (or, for
 * tool spans, no tool name) can be resolved.
 */
export function turnFromSpan(
  span: OtelSpanData,
  options?: TurnFromSpanOptions,
): TurnObservation | undefined {
  const attrs = span.attributes;
  const start = resolveTime(span.startTimeUnixNano, span.startTime);
  const end = resolveTime(span.endTimeUnixNano, span.endTime);

  let latencyMs: number | undefined;
  if (typeof span.durationMs === 'number' && Number.isFinite(span.durationMs)) {
    latencyMs = span.durationMs;
  } else if (start !== undefined && end !== undefined) {
    const delta = end.ms - start.ms;
    if (Number.isFinite(delta)) {
      latencyMs = delta;
    }
  }

  const timestamp = end?.epoch === true ? end.ms : undefined;
  const error = isErrorStatus(span.status);

  const operation = attrString(attrs, 'gen_ai.operation.name');
  const toolAttr = attrString(attrs, 'gen_ai.tool.name');
  const inputTokens = attrNumber(attrs, 'gen_ai.usage.input_tokens', 'gen_ai.usage.prompt_tokens');
  const outputTokens = attrNumber(
    attrs,
    'gen_ai.usage.output_tokens',
    'gen_ai.usage.completion_tokens',
  );

  const isToolSpan =
    operation === 'execute_tool' ||
    operation === 'tool' ||
    (toolAttr !== undefined && inputTokens === undefined && outputTokens === undefined);

  if (isToolSpan) {
    const toolName = toolAttr ?? span.name;
    if (toolName === undefined || toolName === '') {
      return undefined;
    }
    const prefix = options?.toolProfilePrefix ?? DEFAULT_TOOL_PROFILE_PREFIX;
    const toolCall: ToolCallRecord = {
      name: toolName,
      ok: !error,
      ...(latencyMs !== undefined ? { latencyMs } : {}),
    };
    return {
      agentId: options?.agentId ?? `${prefix}${toolName}`,
      ...(timestamp !== undefined ? { timestamp } : {}),
      ...(latencyMs !== undefined ? { latencyMs } : {}),
      ...(error ? { error: true } : {}),
      toolCalls: [toolCall],
    };
  }

  const agentId =
    options?.agentId ??
    attrString(attrs, ...(options?.agentIdAttributes ?? DEFAULT_AGENT_ID_ATTRIBUTES));
  if (agentId === undefined) {
    return undefined;
  }

  const costUsd = attrNumber(attrs, 'gen_ai.usage.cost', 'llm.usage.total_cost');
  const finishReason = attrString(
    attrs,
    'gen_ai.response.finish_reasons',
    'gen_ai.response.finish_reason',
  );

  return {
    agentId,
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(finishReason !== undefined ? { finishReason } : {}),
    ...(error ? { error: true } : {}),
  };
}

/**
 * Maps one span via {@link turnFromSpan} and feeds it to the engine. Returns
 * false when the span is not mappable, true after a successful observe call.
 */
export function observeSpan(
  engine: { observe(turn: TurnObservation): unknown },
  span: OtelSpanData,
  options?: TurnFromSpanOptions,
): boolean {
  const turn = turnFromSpan(span, options);
  if (turn === undefined) {
    return false;
  }
  engine.observe(turn);
  return true;
}
