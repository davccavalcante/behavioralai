/**
 * Multi-channel alerting: Slack, PagerDuty, Microsoft Teams, Telegram,
 * Notion, Google Sheets, and a custom webhook, all zero-dependency.
 *
 * Run: pnpm tsx examples/channels-multi.ts
 */
import { createBehavioralAI } from '@takk/behavioralai';
import {
  googleSheetsChannel,
  notionChannel,
  pagerdutyChannel,
  slackChannel,
  teamsChannel,
  telegramChannel,
  webhookChannel,
} from '@takk/behavioralai/channels';

const radar = createBehavioralAI({
  channels: [
    slackChannel({ webhookUrl: process.env.SLACK_WEBHOOK_URL ?? '' }),
    pagerdutyChannel({ routingKey: process.env.PAGERDUTY_ROUTING_KEY ?? '' }),
    teamsChannel({ webhookUrl: process.env.TEAMS_WEBHOOK_URL ?? '' }),
    telegramChannel({
      botToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
      chatId: process.env.TELEGRAM_CHAT_ID ?? '',
    }),
    notionChannel({
      token: process.env.NOTION_TOKEN ?? '',
      databaseId: process.env.NOTION_DATABASE_ID ?? '',
    }),
    googleSheetsChannel({
      spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID ?? '',
      auth: {
        serviceAccount: {
          clientEmail: process.env.GOOGLE_CLIENT_EMAIL ?? '',
          privateKey: process.env.GOOGLE_PRIVATE_KEY ?? '',
        },
      },
    }),
    webhookChannel({ url: process.env.ALERT_WEBHOOK_URL ?? '' }),
  ],
  alerts: {
    // Start in canary mode in production: evaluate everything, deliver
    // nothing, and watch the alert.suppressed telemetry while tuning.
    canary: process.env.BEHAVIORALAI_CANARY === '1',
    cooldownMs: 300_000,
    minSeverity: 'warning',
  },
});

radar.on((event) => {
  if (event.kind === 'alert.dispatched' || event.kind === 'alert.failed') {
    console.log(event.kind, event.channel, event.alert?.title);
  }
});

export { radar };
