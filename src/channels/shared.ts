/**
 * Shared helpers for the fetch-based alert delivery channels.
 *
 * Everything here relies only on web-standard APIs (fetch, AbortSignal.timeout,
 * URLSearchParams), so it runs unchanged on Node 20+, browsers, and edge runtimes.
 *
 * @module
 */

import type { Alert, ChannelResult, Severity } from '../types.js';

/** A static secret, or a function resolving the current secret (supports rotation sources). */
export type TokenSource = string | (() => string | Promise<string>);

/** Resolves a {@link TokenSource} to its current string value. */
export async function resolveToken(source: TokenSource): Promise<string> {
  if (typeof source === 'string') {
    return source;
  }
  return source();
}

/** Default request timeout applied to channel deliveries, milliseconds. */
const DEFAULT_TIMEOUT_MS = 10000;

/** Options accepted by every channel factory. */
export interface BaseChannelOptions {
  /** Override for the channel name reported in {@link ChannelResult}. */
  name?: string;
  /** Request timeout in milliseconds. Default 10000. */
  timeoutMs?: number;
}

/** Truncates `text` to at most `max` characters, appending "..." when cut. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  if (max <= 3) {
    return text.slice(0, max);
  }
  return `${text.slice(0, max - 3)}...`;
}

/** Hex color per severity. */
const SEVERITY_HEX: Record<Severity, string> = {
  info: '#439fe0',
  warning: '#f2c744',
  critical: '#e01e5a',
};

/** Returns the hex color (with leading "#") associated with a severity. */
export function severityColorHex(severity: Severity): string {
  return SEVERITY_HEX[severity];
}

/**
 * Renders an alert as multiline plain text: title, agent, severity, kind,
 * behavior score, ISO timestamp, a blank line, the message, and up to five
 * attribution summaries as list items.
 */
export function alertText(alert: Alert): string {
  const lines: string[] = [
    alert.title,
    `Agent: ${alert.agentId}`,
    `Severity: ${alert.severity}`,
    `Kind: ${alert.kind}`,
    `Behavior score: ${alert.behaviorScore}/100`,
    new Date(alert.timestamp).toISOString(),
    '',
    alert.message,
  ];
  for (const attribution of alert.attributions.slice(0, 5)) {
    lines.push(`- ${attribution.summary}`);
  }
  return lines.join('\n');
}

/** Renders an alert as a single "[SEVERITY] title: message" line, truncated to 240 characters. */
export function alertCompact(alert: Alert): string {
  return truncate(`[${alert.severity.toUpperCase()}] ${alert.title}: ${alert.message}`, 240);
}

/** Builds a failed {@link ChannelResult} from a thrown value. */
export function channelFailure(channel: string, error: unknown): ChannelResult {
  const message = error instanceof Error ? error.message : String(error);
  return { channel, ok: false, error: truncate(message, 200) };
}

/** Encodes a Record-like body as application/x-www-form-urlencoded. */
function encodeFormBody(body: unknown): string {
  const params = new URLSearchParams();
  if (body !== null && typeof body === 'object') {
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      params.set(key, typeof value === 'string' ? value : String(value));
    }
  }
  return params.toString();
}

/**
 * Sends one HTTP request and converts the outcome into a {@link ChannelResult}.
 * Never throws and never rejects. With `form: true` the body must be a
 * Record of strings and is sent URL-encoded; otherwise the body is sent as
 * JSON. On a non-2xx response the response text (truncated to 200 characters)
 * is placed into the `error` field.
 */
export async function postJson(input: {
  name: string;
  url: string;
  body: unknown;
  headers?: Record<string, string>;
  method?: string;
  timeoutMs?: number;
  form?: boolean;
}): Promise<ChannelResult> {
  const {
    name,
    url,
    body,
    headers = {},
    method = 'POST',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    form = false,
  } = input;
  try {
    const response = await fetch(url, {
      method,
      headers: {
        'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json',
        ...headers,
      },
      body: form ? encodeFormBody(body) : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) {
      return { channel: name, ok: true, status: response.status };
    }
    const detail = (await response.text().catch(() => '')).trim();
    return {
      channel: name,
      ok: false,
      status: response.status,
      error: truncate(detail.length > 0 ? detail : `HTTP ${response.status}`, 200),
    };
  } catch (error) {
    return channelFailure(name, error);
  }
}
