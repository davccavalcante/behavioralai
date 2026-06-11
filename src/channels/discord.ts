/**
 * Discord alert delivery via webhook (embed payload).
 *
 * @module
 */

import type { Alert, AlertChannel, ChannelResult } from '../types.js';
import {
  alertCompact,
  type BaseChannelOptions,
  channelFailure,
  postJson,
  resolveToken,
  severityColorHex,
  type TokenSource,
  truncate,
} from './shared.js';

/** Options for {@link discordChannel}. */
export interface DiscordChannelOptions extends BaseChannelOptions {
  /** Discord webhook URL. */
  webhookUrl: TokenSource;
}

/**
 * Creates an alert channel that posts to a Discord webhook. The payload
 * contains a compact content line plus one embed with title, description,
 * severity color, up to five attribution fields, and the alert timestamp.
 */
export function discordChannel(options: DiscordChannelOptions): AlertChannel {
  const name = options.name ?? 'discord';
  return {
    name,
    async send(alert: Alert): Promise<ChannelResult> {
      try {
        const url = await resolveToken(options.webhookUrl);
        return await postJson({
          name,
          url,
          body: {
            content: alertCompact(alert),
            embeds: [
              {
                title: truncate(alert.title, 256),
                description: truncate(alert.message, 4000),
                color: Number.parseInt(severityColorHex(alert.severity).slice(1), 16),
                fields: alert.attributions.slice(0, 5).map((attribution) => ({
                  name: truncate(attribution.feature, 256),
                  value: truncate(attribution.summary, 1024),
                })),
                timestamp: new Date(alert.timestamp).toISOString(),
              },
            ],
          },
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        });
      } catch (error) {
        return channelFailure(name, error);
      }
    },
  };
}
