/**
 * Alert delivery channels for @takk/behavioralai.
 *
 * Every channel here is fetch-based and universal: it runs on Node 20+, in
 * browsers, and on edge runtimes with zero runtime dependencies. The email
 * (SMTP) channel is intentionally absent; it lives under
 * `@takk/behavioralai/smtp` because it needs `node:tls`.
 *
 * @module
 */

export { type DiscordChannelOptions, discordChannel } from './discord.js';
export { type GoogleAuth, googleAccessToken } from './google-auth.js';
export { type GoogleChatChannelOptions, googleChatChannel } from './googlechat.js';
export { type GoogleDocsChannelOptions, googleDocsChannel } from './googledocs.js';
export { type GoogleSheetsChannelOptions, googleSheetsChannel } from './googlesheets.js';
export { type NotionChannelOptions, notionChannel } from './notion.js';
export { type PagerdutyChannelOptions, pagerdutyChannel } from './pagerduty.js';
export { type RedditChannelOptions, redditChannel } from './reddit.js';
export {
  alertCompact,
  alertText,
  type BaseChannelOptions,
  resolveToken,
  severityColorHex,
  type TokenSource,
  truncate,
} from './shared.js';
export { type SlackChannelOptions, slackChannel } from './slack.js';
export { type TeamsChannelOptions, teamsChannel } from './teams.js';
export { type TelegramChannelOptions, telegramChannel } from './telegram.js';
export { type WebhookChannelOptions, webhookChannel } from './webhook.js';
export { type XChannelOptions, xChannel } from './x.js';
