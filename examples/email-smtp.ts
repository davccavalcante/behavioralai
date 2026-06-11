/**
 * Email alerts over the built-in zero-dependency SMTP client (Node only).
 * Supports STARTTLS (port 587) and implicit TLS (port 465), AUTH LOGIN.
 *
 * Run: pnpm tsx examples/email-smtp.ts
 */
import { createBehavioralAI } from '@takk/behavioralai';
import { emailChannel } from '@takk/behavioralai/smtp';

const radar = createBehavioralAI({
  channels: [
    emailChannel({
      host: process.env.SMTP_HOST ?? 'smtp.example.com',
      port: 587,
      username: process.env.SMTP_USERNAME ?? '',
      password: process.env.SMTP_PASSWORD ?? '',
      from: 'alerts@example.com',
      to: ['oncall@example.com', 'sre@example.com'],
      subjectPrefix: '[behavioralai]',
    }),
  ],
  alerts: { minSeverity: 'critical' },
});

export { radar };
