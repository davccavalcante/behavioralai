/**
 * Telegram alert delivery via the Bot API sendMessage method.
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
  truncate,
} from './shared.js';

/** Options for {@link telegramChannel}. */
export interface TelegramChannelOptions extends BaseChannelOptions {
  /** Telegram bot token issued by BotFather. */
  botToken: TokenSource;
  /** Target chat id (user, group, or channel). */
  chatId: string;
}

/**
 * Creates an alert channel that sends the plain-text alert rendering to a
 * Telegram chat through the Bot API.
 */
export function telegramChannel(options: TelegramChannelOptions): AlertChannel {
  const name = options.name ?? 'telegram';
  return {
    name,
    async send(alert: Alert): Promise<ChannelResult> {
      try {
        const token = await resolveToken(options.botToken);
        return await postJson({
          name,
          url: `https://api.telegram.org/bot${token}/sendMessage`,
          body: {
            chat_id: options.chatId,
            text: truncate(alertText(alert), 4000),
            disable_web_page_preview: true,
          },
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        });
      } catch (error) {
        return channelFailure(name, error);
      }
    },
  };
}
