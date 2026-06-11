/**
 * Sibling-package integrations (optional peers, install only what you use):
 *
 *   pnpm add @takk/keymesh @takk/modelchain
 *
 * - keymeshBridge fingerprints your credential-pool behavior.
 * - modelchainBridge fingerprints every model the router serves.
 * - modelchainAlertSummarizer appends a model-written incident summary to
 *   every alert before delivery.
 *
 * Run: pnpm tsx examples/integrations-takk.ts
 */
import { createKeymesh } from '@takk/keymesh';
import { openaiAdapter } from '@takk/keymesh/openai';
import { createModelchain } from '@takk/modelchain';
import { anthropicModel, geminiModel } from '@takk/modelchain/providers';
import { createBehavioralAI } from '@takk/behavioralai';
import { slackChannel } from '@takk/behavioralai/channels';
import {
  keymeshBridge,
  modelchainAlertSummarizer,
  modelchainBridge,
} from '@takk/behavioralai/integrations';

const router = createModelchain({
  models: [
    anthropicModel('claude-haiku-4-5', {
      cost: { costPer1kInput: 0.001, costPer1kOutput: 0.005 },
      keys: process.env.ANTHROPIC_API_KEY ?? '',
    }),
    geminiModel('gemini-2.5-flash', {
      cost: { costPer1kInput: 0.0003, costPer1kOutput: 0.0025 },
      keys: process.env.GEMINI_API_KEY ?? '',
    }),
  ],
  strategy: 'cost-then-quality',
});

const radar = createBehavioralAI({
  channels: [slackChannel({ webhookUrl: process.env.SLACK_WEBHOOK_URL ?? '' })],
  // Every alert gains a two-sentence incident summary written by the router.
  enrich: modelchainAlertSummarizer({ router }),
});

// Fingerprint each routed model as its own profile: modelchain:<modelId>.
const stopRouterBridge = modelchainBridge(router, radar, { perModel: true });

// Fingerprint the key pool too: keymesh:<keyId> profiles.
const pool = createKeymesh({
  provider: openaiAdapter,
  keys: (process.env.OPENAI_API_KEYS ?? '').split(',').filter(Boolean),
});
const stopPoolBridge = keymeshBridge(pool, radar, { perKey: true });

// ... run your traffic through `router` and `pool` as usual ...

stopRouterBridge();
stopPoolBridge();
await radar.close();
