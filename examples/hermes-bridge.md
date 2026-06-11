# Hermes Agent bridge

Hermes Agent (Nous Research) is Python-first; Behavioral AI
(`@takk/behavioralai`) bridges it over HTTP or OpenTelemetry. Both paths
need no change to the Hermes core.

## Path 1: HTTP ingestion via `behavioralai serve`

Start the collector next to your Hermes instance:

```bash
npx @takk/behavioralai serve --port 8787 --state .behavioralai/state.json \
  --slack "$SLACK_WEBHOOK_URL"
```

Then POST one JSON observation per turn from a small Hermes plugin hook:

```python
import requests

def on_turn_complete(turn):
    requests.post("http://127.0.0.1:8787/observe", json={
        "agentId": turn.agent_name,            # or "skill:<name>", "mcp:<server>"
        "latencyMs": turn.latency_ms,
        "inputTokens": turn.usage.input_tokens,
        "outputTokens": turn.usage.output_tokens,
        "costUsd": turn.usage.cost,
        "toolCalls": [
            {"name": call.tool, "ok": call.ok, "latencyMs": call.latency_ms}
            for call in turn.tool_calls
        ],
        "finishReason": turn.finish_reason,
    }, timeout=2)
```

Inspect learned fingerprints anytime:

```bash
curl http://127.0.0.1:8787/inspect
npx @takk/behavioralai inspect --state .behavioralai/state.json
```

## Path 2: OpenTelemetry via hermes-otel

If you already export spans with the community `hermes-otel` plugin, feed
the serialized spans to the mapper in your OTLP pipeline worker:

```ts
import { createBehavioralAI } from '@takk/behavioralai';
import { observeSpan } from '@takk/behavioralai/otel';

const radar = createBehavioralAI();
for (const span of batch.spans) observeSpan(radar, span);
```

Skills, gateways, and MCP servers become first-class behavioral profiles by
naming convention: `skill:summarize`, `gateway:openrouter`,
`mcp:filesystem`, `tool:web_search`. Each gets its own fingerprint, drift
detection, and alerts, which is exactly the coverage Hermes zombie
detection and heartbeat monitoring do not provide on their own.
