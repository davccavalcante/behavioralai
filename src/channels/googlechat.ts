/**
 * Google Chat alert delivery via space webhook (plain-text payload).
 *
 * @module
 */

import type { Alert, AlertChannel, ChannelResult } from '../types.js';
import {
  alertText,
  type BaseChannelOptions,
  channelFailure,
  postJson,
  resolveToken,
  type TokenSource,
} from './shared.js';

/** Options for {@link googleChatChannel}. */
export interface GoogleChatChannelOptions extends BaseChannelOptions {
  /** Google Chat incoming webhook URL. */
  webhookUrl: TokenSource;
}

/**
 * Creates an alert channel that posts the plain-text alert rendering to a
 * Google Chat space webhook.
 */
export function googleChatChannel(options: GoogleChatChannelOptions): AlertChannel {
  const name = options.name ?? 'googlechat';
  return {
    name,
    async send(alert: Alert): Promise<ChannelResult> {
      try {
        const url = await resolveToken(options.webhookUrl);
        return await postJson({
          name,
          url,
          body: { text: alertText(alert) },
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        });
      } catch (error) {
        return channelFailure(name, error);
      }
    },
  };
}
