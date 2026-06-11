/**
 * Notion alert delivery: creates one page per alert in a Notion database.
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
  truncate,
} from './shared.js';

/** Options for {@link notionChannel}. */
export interface NotionChannelOptions extends BaseChannelOptions {
  /** Notion integration token. */
  token: TokenSource;
  /** Target database id; the integration must be shared with the database. */
  databaseId: string;
  /** Property name overrides matching the target database schema. */
  properties?: {
    /** Title property name. Default "Name". */
    title?: string;
    /** Select property name for the severity. Default "Severity". */
    severity?: string;
    /** Rich text property name for the agent id. Default "Agent". */
    agent?: string;
    /** Number property name for the behavior score. Default "Score". */
    score?: string;
    /** Rich text property name for the message. Default "Message". */
    message?: string;
  };
}

/**
 * Creates an alert channel that inserts one page per alert into a Notion
 * database through the Notion REST API (version 2022-06-28).
 *
 * Expected database schema (names overridable via `properties`):
 * "Name" (title), "Severity" (select), "Agent" (rich text), "Score" (number),
 * "Message" (rich text).
 */
export function notionChannel(options: NotionChannelOptions): AlertChannel {
  const name = options.name ?? 'notion';
  const props = options.properties ?? {};
  return {
    name,
    async send(alert: Alert): Promise<ChannelResult> {
      try {
        const token = await resolveToken(options.token);
        return await postJson({
          name,
          url: 'https://api.notion.com/v1/pages',
          headers: {
            Authorization: `Bearer ${token}`,
            'Notion-Version': '2022-06-28',
          },
          body: {
            parent: { database_id: options.databaseId },
            properties: {
              [props.title ?? 'Name']: {
                title: [{ text: { content: truncate(alert.title, 200) } }],
              },
              [props.severity ?? 'Severity']: { select: { name: alert.severity } },
              [props.agent ?? 'Agent']: {
                rich_text: [{ text: { content: alert.agentId } }],
              },
              [props.score ?? 'Score']: { number: alert.behaviorScore },
              [props.message ?? 'Message']: {
                rich_text: [{ text: { content: truncate(alert.message, 1900) } }],
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
