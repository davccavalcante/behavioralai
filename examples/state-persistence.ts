/**
 * Baseline persistence: fingerprints survive restarts via the file backend.
 * The snapshot contains learned statistics only, never credentials and
 * never prompt or completion content.
 *
 * Run: pnpm tsx examples/state-persistence.ts
 */
import { createBehavioralAI, fileState } from '@takk/behavioralai';

const radar = createBehavioralAI({
  state: fileState({ path: '.behavioralai/state.json' }),
});

// Guarantee hydration completed before serving traffic (optional;
// observations made earlier are kept, hydration only adds missing agents).
await radar.ready();

radar.observe({ agentId: 'support-agent', latencyMs: 815, costUsd: 0.002 });

// Persist explicitly at checkpoints, or rely on close() at shutdown.
await radar.flush();
await radar.close();

// Inspect the persisted baselines anytime from the CLI:
//   npx @takk/behavioralai inspect --state .behavioralai/state.json
