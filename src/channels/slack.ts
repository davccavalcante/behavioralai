/**
 * Slack alert delivery via incoming webhook (Block Kit payload).
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
  type TokenSource,
} from './shared.js';

/** Options for {@link slackChannel}. */
export interface SlackChannelOptions extends BaseChannelOptions {
  /** Slack incoming webhook URL. */
  webhookUrl: TokenSource;
}

/**
 * Creates an alert channel that posts to a Slack incoming webhook. The payload
 * contains a plain-text fallback plus one section block (title and message)
 * and one context block (agent, severity, behavior score).
 */
export function slackChannel(options: SlackChannelOptions): AlertChannel {
  const name = options.name ?? 'slack';
  return {
    name,
    async send(alert: Alert): Promise<ChannelResult> {
      try {
        const url = await resolveToken(options.webhookUrl);
        return await postJson({
          name,
          url,
          body: {
            text: alertCompact(alert),
            blocks: [
              {
                type: 'section',
                text: { type: 'mrkdwn', text: `*${alert.title}*\n${alert.message}` },
              },
              {
                type: 'context',
                elements: [
                  {
                    type: 'mrkdwn',
                    text: `agent ${alert.agentId} | severity ${alert.severity} | score ${alert.behaviorScore}/100`,
                  },
                ],
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
