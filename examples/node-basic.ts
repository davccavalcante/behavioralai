/**
 * Basic Node usage: create the engine, observe turns, read the report.
 *
 * Run: pnpm tsx examples/node-basic.ts
 */
import { createBehavioralAI } from '@takk/behavioralai';

const radar = createBehavioralAI({
  sensitivity: 'balanced',
  warmup: { minObservations: 50 },
});

// Wire this call into your agent loop, one call per completed turn.
const report = radar.observe({
  agentId: 'support-agent',
  latencyMs: 842,
  costUsd: 0.0021,
  inputTokens: 1200,
  outputTokens: 310,
  contextTokens: 6100,
  toolCalls: [{ name: 'web_search', ok: true, latencyMs: 130 }],
  finishReason: 'stop',
});

console.log(report.status); // 'learning' until warmup completes
console.log(report.behaviorScore); // 100 at baseline, drops under drift
console.log(radar.fingerprintOf('support-agent')?.observations);

radar.on((event) => {
  if (event.kind === 'drift.detected') {
    console.log(`drift on ${event.feature}: severity ${event.severity}`);
  }
});

await radar.close();
