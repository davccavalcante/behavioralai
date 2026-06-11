/**
 * Generic webhook alert delivery: sends the full Alert object as JSON.
 *
 * @module
 */

import type { Alert, AlertChannel, ChannelResult } from '../types.js';
import {
  type BaseChannelOptions,
  channelFailure,
  postJson,
  resolveToken,
  type TokenSource,
} from './shared.js';

/** Options for {@link webhookChannel}. */
export interface WebhookChannelOptions extends BaseChannelOptions {
  /** Target URL receiving the alert JSON. */
  url: TokenSource;
  /** HTTP method. Default "POST". */
  method?: string;
  /** Extra request headers, for example an authorization header. */
  headers?: Record<string, string>;
}

/**
 * Creates an alert channel that sends the complete {@link Alert} object as a
 * JSON body to an arbitrary HTTP endpoint.
 */
export function webhookChannel(options: WebhookChannelOptions): AlertChannel {
  const name = options.name ?? 'webhook';
  return {
    name,
    async send(alert: Alert): Promise<ChannelResult> {
      try {
        const url = await resolveToken(options.url);
        return await postJson({
          name,
          url,
          body: alert,
          ...(options.method !== undefined ? { method: options.method } : {}),
          ...(options.headers !== undefined ? { headers: options.headers } : {}),
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        });
      } catch (error) {
        return channelFailure(name, error);
      }
    },
  };
}
