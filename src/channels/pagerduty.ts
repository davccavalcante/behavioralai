/**
 * PagerDuty alert delivery via the Events API v2 enqueue endpoint.
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
  truncate,
} from './shared.js';

/** Options for {@link pagerdutyChannel}. */
export interface PagerdutyChannelOptions extends BaseChannelOptions {
  /** Events API v2 integration routing key. */
  routingKey: TokenSource;
}

/**
 * Creates an alert channel that triggers a PagerDuty event. The alert id is
 * used as the deduplication key and the severity maps one to one onto the
 * PagerDuty severity ladder (info, warning, critical).
 */
export function pagerdutyChannel(options: PagerdutyChannelOptions): AlertChannel {
  const name = options.name ?? 'pagerduty';
  return {
    name,
    async send(alert: Alert): Promise<ChannelResult> {
      try {
        const routingKey = await resolveToken(options.routingKey);
        return await postJson({
          name,
          url: 'https://events.pagerduty.com/v2/enqueue',
          body: {
            routing_key: routingKey,
            event_action: 'trigger',
            dedup_key: alert.id,
            payload: {
              summary: truncate(alertCompact(alert), 1024),
              source: alert.agentId,
              severity: alert.severity,
              timestamp: new Date(alert.timestamp).toISOString(),
              custom_details: {
                behaviorScore: alert.behaviorScore,
                kind: alert.kind,
                attributions: alert.attributions.map((attribution) => attribution.summary),
              },
            },
          },
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        });
      } catch (error) {
        return channelFailure(name, error);
      }
    },
  };
}
