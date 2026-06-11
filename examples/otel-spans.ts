/**
 * OpenTelemetry ingestion: feed GenAI semantic-convention spans (for
 * example exported by the hermes-otel plugin for Hermes Agent, or by any
 * OTLP pipeline) straight into the engine. Tool spans become their own
 * "tool:<name>" behavioral profiles.
 *
 * Run: pnpm tsx examples/otel-spans.ts
 */
import { createBehavioralAI } from '@takk/behavioralai';
import { observeSpan, turnFromSpan } from '@takk/behavioralai/otel';

const radar = createBehavioralAI({ warmup: { minObservations: 30 } });

// A chat span as your OTLP exporter would serialize it.
const chatSpan = {
  name: 'chat claude-haiku-4-5',
  attributes: {
    'gen_ai.operation.name': 'chat',
    'gen_ai.agent.id': 'research-agent',
    'gen_ai.usage.input_tokens': 1850,
    'gen_ai.usage.output_tokens': 420,
    'gen_ai.response.finish_reasons': ['stop'],
  },
  startTimeUnixNano: '1750000000000000000',
  endTimeUnixNano: '1750000001230000000',
  status: { code: 1 },
};

// A tool-execution span: profiled separately as "tool:web_search".
const toolSpan = {
  name: 'execute_tool web_search',
  attributes: {
    'gen_ai.operation.name': 'execute_tool',
    'gen_ai.tool.name': 'web_search',
  },
  durationMs: 140,
  status: { code: 1 },
};

observeSpan(radar, chatSpan);
observeSpan(radar, toolSpan);

// Or map manually when you want to inspect or amend the turn first.
const turn = turnFromSpan(chatSpan);
console.log(turn?.agentId, turn?.latencyMs, turn?.inputTokens);

await radar.close();
