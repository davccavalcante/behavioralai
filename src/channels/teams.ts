/**
 * Microsoft Teams alert delivery via a Workflows incoming webhook
 * (Adaptive Card payload).
 *
 * @module
 */

import type { Alert, AlertChannel, ChannelResult, Severity } from '../types.js';
import {
  type BaseChannelOptions,
  channelFailure,
  postJson,
  resolveToken,
  type TokenSource,
} from './shared.js';

/** Adaptive Card color token per severity. */
const ADAPTIVE_CARD_COLOR: Record<Severity, string> = {
  info: 'Good',
  warning: 'Warning',
  critical: 'Attention',
};

/** Options for {@link teamsChannel}. */
export interface TeamsChannelOptions extends BaseChannelOptions {
  /** Microsoft Teams Workflows incoming webhook URL. */
  webhookUrl: TokenSource;
}

/**
 * Creates an alert channel that posts to a Microsoft Teams Workflows incoming
 * webhook. The payload is a message attachment carrying an Adaptive Card 1.4
 * with the title, the message, and an agent/severity/score fact set.
 */
export function teamsChannel(options: TeamsChannelOptions): AlertChannel {
  const name = options.name ?? 'teams';
  return {
    name,
    async send(alert: Alert): Promise<ChannelResult> {
      try {
        const url = await resolveToken(options.webhookUrl);
        return await postJson({
          name,
          url,
          body: {
            type: 'message',
            attachments: [
              {
                contentType: 'application/vnd.microsoft.card.adaptive',
                content: {
                  type: 'AdaptiveCard',
                  version: '1.4',
                  $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
                  body: [
                    {
                      type: 'TextBlock',
                      text: alert.title,
                      weight: 'Bolder',
                      size: 'Medium',
                      color: ADAPTIVE_CARD_COLOR[alert.severity],
                      wrap: true,
                    },
                    { type: 'TextBlock', text: alert.message, wrap: true },
                    {
                      type: 'FactSet',
                      facts: [
                        { title: 'Agent', value: alert.agentId },
                        { title: 'Severity', value: alert.severity },
                        { title: 'Score', value: `${alert.behaviorScore}/100` },
                      ],
                    },
                  ],
                },
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
