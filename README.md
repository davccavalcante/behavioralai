# Behavioral AI NPM

[![status: stable](https://img.shields.io/badge/status-stable-brightgreen)](./CHANGELOG.md)
[![license](https://img.shields.io/badge/license-Apache_2.0-blue.svg)](./LICENSE)
[![version](https://img.shields.io/badge/version-1.0.0-blue)](./CHANGELOG.md)
[![node](https://img.shields.io/badge/node-%E2%89%A520-success)]()
[![tests](https://img.shields.io/badge/tests-201%20passing-brightgreen)]()
[![coverage](https://img.shields.io/badge/coverage-94%25-brightgreen)]()
[![runtime deps](https://img.shields.io/badge/runtime%20deps-0-success)]()

<p align="center">
  <img src="https://raw.githubusercontent.com/davccavalcante/behavioralai/main/assets/behavioralai.png" alt="Behavioral AI" width="500">
</p>

[![Star History Chart](https://api.star-history.com/svg?repos=davccavalcante/behavioralai&type=timeline&legend=top-left)](https://www.star-history.com/#davccavalcante/behavioralai&type=timeline&legend=top-left)

> Behavioral AI: universal, zero-runtime-dependency behavioral observability for production agents. It learns each agent's normal in production, tells you what is abnormal now, and forecasts what crosses the line next, before any visible failure. Built for Massive Intelligence (IM) agents and non-human entities (NHE).

Behavioral AI (`@takk/behavioralai`) sits beside your agent loop. You call `observe()` once per completed turn with numbers you already have (latency, cost, tokens, tool calls, finish reason); the engine builds a statistical fingerprint of each observed unit, detects deviations from that learned normal in real time, attributes which features caused the deviation, projects trends toward critical thresholds, and delivers alerts to Slack, PagerDuty, Microsoft Teams, Telegram, Notion, Google Sheets, email, and seven more destinations. It runs in Node, edge runtimes (Cloudflare Workers, Vercel Edge, Deno, Bun), and the browser, and ships a CLI with an HTTP ingestion server for Python-first stacks.

You do not configure metrics or thresholds: you switch it on, it learns each agent's baseline during a warmup window, then evaluates every turn synchronously against that baseline. `observe()` never performs I/O; alert delivery runs asynchronously and surfaces only as telemetry; a failing channel can never crash the observed agent. Where tracers record what happened, Behavioral AI states what is abnormal now and what will cross critical next.

**Core promise:** zero required runtime dependencies, one-call ingestion (`observe()` is synchronous and I/O-free), ergonomic TypeScript types, ESM + CJS dual distribution, SLSA provenance on every release.

---

## Install

```bash
pnpm add @takk/behavioralai
# or: npm install @takk/behavioralai
# or: yarn add @takk/behavioralai
# or: bun add @takk/behavioralai
```

The package has zero runtime dependencies. Seven library entries ship dual ESM + CJS with `.d.ts`/`.d.cts`, plus the `behavioralai` CLI bin:

| Entry | Runtime | Contents |
|---|---|---|
| `@takk/behavioralai` | universal | engine, errors, state backends, sensitivity presets, all public types |
| `@takk/behavioralai/otel` | universal | `turnFromSpan`, `observeSpan` (OpenTelemetry GenAI spans as input) |
| `@takk/behavioralai/channels` | universal | 12 fetch-based alert channel factories |
| `@takk/behavioralai/smtp` | Node >= 20 | `emailChannel` (built-in SMTP client) |
| `@takk/behavioralai/integrations` | universal | `keymeshBridge`, `modelchainBridge`, `modelchainAlertSummarizer` |
| `@takk/behavioralai/web` | browsers | core surface minus the file state backend |
| `@takk/behavioralai/edge` | edge runtimes | core surface minus the file state backend |

Only `/integrations` involves optional peers, and even there the adapters are structural (they import nothing from the peers). Install the siblings only if you use them:

```bash
pnpm add @takk/keymesh @takk/modelchain   # optional, for /integrations
```

---

## Quickstart

```ts
// src/example.ts
import { createBehavioralAI } from '@takk/behavioralai';

const radar = createBehavioralAI(); // balanced sensitivity, 50-observation warmup

// Wire this call into your agent loop, one call per completed turn.
// Synchronous, no I/O, returns the drift report for that turn.
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

console.log(report.status);        // 'learning' until warmup completes, then 'ready'
console.log(report.behaviorScore); // 100 at baseline, drops under drift
console.log(report.findings);      // drifted features: severity, direction, summary
console.log(report.attributions);  // which features caused the deviation, ranked
console.log(report.forecasts);     // trends projected to cross critical thresholds

await radar.close();
```

Every field except `agentId` is optional: the engine fingerprints whatever dimensions you provide and ignores the rest. The full option surface of `createBehavioralAI` (sensitivity, warmup, window size, alert governance, channels, enrichment, state, clock override) is documented in [SPEC.md](./SPEC.md).

---

## Quickstart - OpenTelemetry input

If you already export OpenTelemetry GenAI semantic-convention spans (`gen_ai.*` attributes), you do not need to touch your agent code at all. Feed serialized spans straight from your OTLP pipeline:

```ts
import { createBehavioralAI } from '@takk/behavioralai';
import { observeSpan, turnFromSpan } from '@takk/behavioralai/otel';

const radar = createBehavioralAI();

// For example: spans exported by the community hermes-otel plugin
// for Hermes Agent, or by any OTLP pipeline worker.
for (const span of batch.spans) observeSpan(radar, span);

// Or map manually when you want to inspect or amend the turn first.
const turn = turnFromSpan(chatSpan);
```

Chat spans become turn observations for the agent named in the span attributes; tool-execution spans become their own `tool:<name>` behavioral profiles. This makes Behavioral AI a complement to your tracer, not a replacement: the tracer keeps the record, Behavioral AI learns the normal. See [examples/otel-spans.ts](./examples/otel-spans.ts).

---

## Channels

All channels are zero-dependency. The 12 in `/channels` are pure `fetch` and run on any modern runtime; `emailChannel` in `/smtp` is Node-only and speaks SMTP directly (STARTTLS, implicit TLS, AUTH LOGIN, dot-stuffing), no mail library required.

| Destination | Factory | Entry | Notes |
|---|---|---|---|
| Slack | `slackChannel` | `/channels` | incoming webhook |
| Discord | `discordChannel` | `/channels` | webhook |
| Microsoft Teams | `teamsChannel` | `/channels` | Adaptive Card payload |
| Google Chat | `googleChatChannel` | `/channels` | space webhook |
| Telegram | `telegramChannel` | `/channels` | bot API |
| PagerDuty | `pagerdutyChannel` | `/channels` | Events API v2 |
| Generic webhook | `webhookChannel` | `/channels` | any JSON endpoint |
| Notion | `notionChannel` | `/channels` | one database page per alert |
| Reddit | `redditChannel` | `/channels` | script-app OAuth2 |
| X | `xChannel` | `/channels` | OAuth2 bearer or full OAuth 1.0a HMAC-SHA1 via WebCrypto |
| Google Sheets | `googleSheetsChannel` | `/channels` | row append per alert |
| Google Docs | `googleDocsChannel` | `/channels` | document append |
| Email | `emailChannel` | `/smtp` | built-in minimal SMTP client, Node only |

Google channels authenticate with a service account out of the box: `googleAccessToken` signs the RS256 JWT with WebCrypto and caches the token, no Google SDK involved. Every credential field accepts a `TokenSource` (`string | () => string | Promise<string>`), so secrets can come from a vault at send time.

```ts
import { createBehavioralAI } from '@takk/behavioralai';
import { pagerdutyChannel, slackChannel, telegramChannel } from '@takk/behavioralai/channels';
import { emailChannel } from '@takk/behavioralai/smtp';

const radar = createBehavioralAI({
  channels: [
    slackChannel({ webhookUrl: process.env.SLACK_WEBHOOK_URL ?? '' }),
    pagerdutyChannel({ routingKey: process.env.PAGERDUTY_ROUTING_KEY ?? '' }),
    telegramChannel({
      botToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
      chatId: process.env.TELEGRAM_CHAT_ID ?? '',
    }),
    emailChannel({
      host: process.env.SMTP_HOST ?? '',
      port: 587,
      username: process.env.SMTP_USERNAME ?? '',
      password: process.env.SMTP_PASSWORD ?? '',
      from: 'alerts@example.com',
      to: ['oncall@example.com'],
    }),
  ],
  alerts: { cooldownMs: 300_000, minSeverity: 'warning' },
});
```

Channel failures can never reach the agent: every `send()` resolves a `ChannelResult` and failures surface as `alert.failed` telemetry. Deliveries fan out concurrently with per-request timeouts, so one slow destination never delays another.

**Tip: start in canary mode.** Set `alerts: { canary: true }` for the first days in production. The engine evaluates everything and emits full telemetry (including `alert.suppressed` with the reason) but delivers nothing externally. Tune sensitivity against real traffic, then flip the flag. See [examples/channels-multi.ts](./examples/channels-multi.ts).

---

## Drift detection

The fingerprint, in plain words: for every agent and every dimension you provide, the engine keeps a long-run baseline, a recency-weighted baseline (EWMA), streaming quantiles, and a recent window. Each new turn is compared against the learned normal; nothing is ever compared against a hand-set threshold you had to invent.

Up to 12 numeric and 2 categorical features are extracted per turn:

| Feature | Kind | What it captures |
|---|---|---|
| `latencyMs` | numeric | end-to-end turn latency |
| `costUsd` | numeric | cost attributed to the turn |
| `inputTokens` | numeric | prompt-side token count |
| `outputTokens` | numeric | completion-side token count |
| `totalTokens` | numeric | input plus output tokens |
| `contextTokens` | numeric | context-window occupancy at request time |
| `contextSnr` | numeric | output tokens per context token (context signal-to-noise) |
| `retrievalChunks` | numeric | retrieval chunks injected into the context |
| `toolCallCount` | numeric | tool invocations per turn |
| `toolFailureRate` | rate | share of failed tool calls (exact binomial) |
| `turnIndex` | numeric | turn position inside its task or session |
| `errorRate` | rate | share of failed turns (exact binomial, always extracted) |
| `toolSelection` | categorical | which tools the agent reaches for |
| `finishReason` | categorical | mix of provider finish reasons |

Four detectors run together:

- **Robust z-score** against the EWMA baseline for numeric point features, with a variance floor from the long-run statistics so a quiet stretch cannot make the detector hypersensitive.
- **Exact binomial tail test** for the bounded-rate features (`errorRate`, `toolFailureRate`): the recent window count against the baseline rate, one-sided on the harmful direction. The classic p-chart normal approximation is invalid where healthy agents live (a couple of failures per window) and fires on pure chance; the exact tail does not.
- **Two-sided Page-Hinkley** with exponential forgetting for sustained shifts that never trip a single-turn threshold: when it confirms a shift it opens a finding immediately (the detector already integrated evidence across dozens of turns) and re-arms, so a persistent regime change produces a bounded reminder cadence instead of silence.
- **Jensen-Shannon divergence** for the categorical mixes: an agent that suddenly prefers different tools or finishes for different reasons drifts even when every numeric stays flat.

Sensitivity is one option with three presets (or pass a partial config to override individual thresholds). JSD thresholds apply to bias-corrected divergence: the engine subtracts the finite-sample bias (k - 1) / (4 n ln 2) before comparing, so the values are meaningful at any category count:

| Preset | warning z | critical z | warning JSD | critical JSD | EWMA alpha | PH delta | PH lambda |
|---|---|---|---|---|---|---|---|
| `strict` | 2.5 | 3.5 | 0.07 | 0.18 | 0.08 | 0.01 | 50 |
| `balanced` (default) | 3 | 4.5 | 0.10 | 0.25 | 0.05 | 0.02 | 75 |
| `relaxed` | 4 | 6 | 0.16 | 0.38 | 0.03 | 0.04 | 110 |

Semantics that keep alerts trustworthy:

- **Confirmation.** A finding opens only after 2 consecutive out-of-range evaluations, with no single-observation bypass: one-sample outliers never page anyone, however extreme (real latency is heavy-tailed). The only thing that opens immediately is a Page-Hinkley confirmed sustained shift, because that detector is itself a multi-observation confirmation.
- **Recovery.** A drifted feature recovers after 5 consecutive evaluations comfortably back in range (below 0.7x the warning threshold, a Schmitt-trigger hysteresis so a shift hovering at the threshold cannot flip-flop); recovery emits an `info` alert when `notifyRecovery` is on (default).
- **Freezing.** While a feature has ANY open finding (warning included), its baseline is frozen: anomalous turns are excluded from baseline absorption, so the incident cannot poison the learned normal it is being measured against, and the printed expected values stay honest throughout an incident.
- **`absorb()`.** When the new behavior is intentional (a model upgrade, a prompt change), call `radar.absorb(agentId)` (or `absorb(agentId, feature)`) to accept the recent window as the new normal: baselines rebuild from the window, drift states reset, frozen features unfreeze.
- **Behavior score.** Every report carries a composite 0..100 health score, smoothed over evaluations and counting only warning-level deviations: healthy agents read a steady 100 (the benchmark bounds the healthy 5th percentile at 99 or above), and genuine drift pulls it down within 1 or 2 evaluations. Ideal for dashboards and SLOs.

---

## Predictive alerts

Detection tells you what is wrong now; forecasting tells you what will be wrong soon. For every numeric feature that is not already drifted, the engine fits a least-squares trend over the recent window (at least 8 points), requires the slope to be statistically significant (at least 4 standard errors from zero, so stationary noise produces near-zero forecasts: the benchmark bounds them at 2 events per 2000 healthy turns), clamps projections to the feature's physical domain (no negative thresholds, rates within [0, 1]), and reports time-to-critical in both observations and hours when the crossing lands within a 24 hour horizon:

```text
turn 113 forecast.detected feature=latencyMs latencyMs is trending up and is
projected to cross its critical threshold (1438.64) in about 0.78 h
(94 observations) if the trend continues
```

Forecasts appear in every `DriftReport` (`report.forecasts`, with `slopePerObservation`, `slopePerHour`, `observationsToCritical`, `hoursToCritical`), as `forecast.detected` telemetry, and as `forecast` alerts (severity `warning`) on your channels when `notifyForecast` is on (default). A slow latency ramp or a creeping context window pages you while there is still time to act, not after the SLO is gone.

---

## CLI

The package ships a `behavioralai` bin with four commands:

```bash
npx @takk/behavioralai help
npx @takk/behavioralai inspect --state .behavioralai/state.json
npx @takk/behavioralai simulate --turns 160 --warmup 30 --drift-at 96 --seed 7
npx @takk/behavioralai serve --port 8787 --host 127.0.0.1 \
  --state .behavioralai/state.json \
  --slack "$SLACK_WEBHOOK_URL" --webhook "$ALERT_WEBHOOK_URL"
```

`simulate` is fully deterministic: a seeded generator and a simulated clock produce byte-identical output on every run, so you can watch the whole lifecycle (learning, baseline ready, injection, confirmation, detection, attribution) before wiring a single real agent:

```text
$ npx @takk/behavioralai simulate --turns 160 --warmup 30 --seed 7
simulation: turns=160 warmup=30 drift-at=96 seed=7
turn 31 baseline.ready agent=sim-agent
turn 113 forecast.detected feature=latencyMs latencyMs is trending up and is projected to cross its critical threshold (1438.64) in about 0.78 h (94 observations) if the trend continues
turn 139 drift.detected feature=latencyMs severity=warning score=1.01 behavior=94
turn 140 drift.detected feature=toolFailureRate severity=warning score=3.10 behavior=90
turn 140 drift.detected feature=errorRate severity=warning score=3.10 behavior=90
...
--- summary ---
turns: 160
drift injected at turn: 96
first detection: turn 139 (delay 43 turns)
final behavior score: 74
top attributions:
  toolFailureRate contribution=0.50 toolFailureRate is above baseline: observed 0.26 vs expected 0.09 (z=3.47)
  errorRate contribution=0.50 errorRate is above baseline: observed 0.26 vs expected 0.09 (z=3.47)
```

The forecast at turn 113 is the thesis in one line: it fired 17 turns after the injection and 26 turns before the first hard detection, while everything still looked fine. The printed expected rate (0.09) reflects this demo's deliberately small warmup of 30 turns: with the production default (50 or more) the frozen baseline holds near the true rate throughout an incident, a bound the detection benchmark enforces in CI.

`serve` starts an HTTP ingestion server: `POST /observe` (a single observation or an array), `GET /inspect`, `GET /healthz`. It binds `127.0.0.1` by default, caps request bodies at 1 MB, optionally persists state to a file, dispatches alerts to Slack or a generic webhook, and accepts `--token <secret>` to require `Authorization: Bearer` on every endpoint except `/healthz` (set it whenever binding beyond localhost). It is the bridge for stacks that are not TypeScript, including Python-first agent frameworks.

---

## Hermes Agent bridge

Hermes Agent (Nous Research) is Python-first; Behavioral AI bridges it without touching the Hermes core, over either path:

- **HTTP:** run `npx @takk/behavioralai serve` next to your Hermes instance and `POST /observe` one JSON observation per turn from a small plugin hook.
- **OpenTelemetry:** if you already export spans with the community `hermes-otel` plugin, feed them to `observeSpan` from `@takk/behavioralai/otel` in your OTLP pipeline.

Skills, gateways, MCP servers, and tools become first-class behavioral profiles by naming convention: `skill:summarize`, `gateway:openrouter`, `mcp:filesystem`, `tool:web_search`. Each gets its own fingerprint, drift detection, and alerts. Hermes v0.13 Tenacity (2026-05-07) added zombie detection and heartbeat monitoring in Kanban; Behavioral AI extends that instinct to the whole stack: skill behavior fingerprinting, gateway pattern analysis, MCP server health profiling. Full walkthrough with the Python hook: [examples/hermes-bridge.md](./examples/hermes-bridge.md).

---

## Integrations

`@takk/behavioralai/integrations` connects the sibling packages of the Takk portfolio. The adapters are structurally typed and import nothing from the peers; type compatibility is proven in CI against the real published 1.0.0 declarations of both siblings.

- **`keymeshBridge(client, radar, { perKey? })`** subscribes to `@takk/keymesh` telemetry and fingerprints the behavior of your credential pool (one `keymesh:<keyId>` profile per key with `perKey: true`).
- **`modelchainBridge(router, radar, { perModel? })`** subscribes to `@takk/modelchain` telemetry and fingerprints every routed model (one `modelchain:<modelId>` profile per model with `perModel: true`).
- **`modelchainAlertSummarizer({ router })`** is an `AlertEnricher`: every alert gains a two-sentence incident summary written by a model behind your router, before delivery.

```ts
import { createBehavioralAI } from '@takk/behavioralai';
import { slackChannel } from '@takk/behavioralai/channels';
import {
  keymeshBridge,
  modelchainAlertSummarizer,
  modelchainBridge,
} from '@takk/behavioralai/integrations';

const radar = createBehavioralAI({
  channels: [slackChannel({ webhookUrl: process.env.SLACK_WEBHOOK_URL ?? '' })],
  enrich: modelchainAlertSummarizer({ router }),
});

const stopRouter = modelchainBridge(router, radar, { perModel: true });
const stopPool = keymeshBridge(pool, radar, { perKey: true });
```

The stack reads as one sentence: route with `@takk/modelchain`, rotate credentials with `@takk/keymesh`, observe everything with `@takk/behavioralai`. Runnable version: [examples/integrations-takk.ts](./examples/integrations-takk.ts).

---

## Telemetry

Everything the engine does is observable through one subscription. There are 15 event kinds:

- **Ingestion:** `observation.recorded`, `agent.registered`
- **Baseline lifecycle:** `baseline.learning`, `baseline.ready`, `baseline.frozen`, `baseline.absorbed`
- **Detection:** `drift.detected`, `drift.recovered`, `forecast.detected`
- **Alert governance:** `alert.dispatched`, `alert.suppressed`, `alert.failed`
- **Persistence:** `state.loaded`, `state.persisted`
- **Failures:** `error`

```ts
const off = radar.on((event) => {
  if (event.kind === 'drift.detected') {
    log.warn({ agent: event.agentId, feature: event.feature, severity: event.severity });
  }
  if (event.kind === 'alert.failed') {
    log.error({ channel: event.channel, message: event.message });
  }
  if (event.kind === 'alert.suppressed') {
    log.debug({ reason: event.message }); // cooldown, canary, or severity floor
  }
});
```

Listener exceptions are swallowed; `on()` returns an unsubscribe function. Events carry the full `DriftReport` or `Alert` where relevant, so you can forward them to your own logging or metrics pipeline without re-deriving anything.

---

## Inspection and state

Read the learned normal at any time, in process or from the CLI:

```ts
const fp = radar.fingerprintOf('support-agent');
// { agentId, status, observations, firstSeen, lastSeen,
//   numeric:     [{ feature, count, mean, stdDev, ewmaMean, p50, p95, p99, min, max }, ...],
//   categorical: [{ feature, baseline, recent, divergence }, ...],
//   frozen:      [] }

const snapshot = radar.inspect();
// { createdAt, observations, agents, lastReports }
```

Baselines survive restarts with a state backend. `memoryState()` is the implicit default; `fileState` persists to disk with atomic writes (temp file + rename):

```ts
import { createBehavioralAI, fileState } from '@takk/behavioralai';

const radar = createBehavioralAI({ state: fileState({ path: '.behavioralai/state.json' }) });
await radar.ready(); // hydration finished; earlier observations are preserved

await radar.flush(); // persist at checkpoints, or rely on close() at shutdown
```

The persisted `StateSnapshot` (v1) holds aggregate statistics, drift states, and window values only: never credentials, never prompt or completion content. In fact the engine never sees prompt or completion text at all; the ingestion contract is numbers, category labels, and caller-chosen identifiers. `npx @takk/behavioralai inspect --state <path>` reads the same file. See [examples/state-persistence.ts](./examples/state-persistence.ts).

---

## Quality

- 201 tests across 14 suites, all passing under Vitest, including a labeled detection-quality benchmark: 7 deterministic scenarios (stationary control, sustained 2.5 and 3.2 sigma shifts, abrupt 6 sigma regression, error-rate spike with an anti-poisoning bound, finish-reason mix shift, forecast-before-critical ramp) with hard acceptance bounds, so any regression in detection quality fails CI, not just regressions in mechanism correctness.
- Coverage: 94.4% lines, 92.88% statements, 95.51% functions, 85.08% branches; thresholds enforced in CI at 80/80/80/60.
- Typecheck clean under TypeScript in maximum strict mode (`exactOptionalPropertyTypes`, `useUnknownInCatchVariables`, `noUncheckedIndexedAccess`); lint clean under Biome.
- `publint` clean; `attw` green for all 8 entry conditions (dual ESM + CJS with `.d.ts`/`.d.cts`).
- Bundle sizes (brotli): core 8.88 kB ESM / 9.04 kB CJS, `/otel` 805 B, `/channels` 3.26 kB, `/smtp` 2.05 kB, `/integrations` 744 B, `/web` 8.26 kB, `/edge` 8.26 kB.
- Channel signing tested for real: service-account RS256 verified against a real key pair, SMTP exercised against a scripted local server, CLI exercised end-to-end as a subprocess including the deterministic simulation.
- Integration types proven against the real published `@takk/keymesh` and `@takk/modelchain` 1.0.0 declarations at compile time.
- CI matrix: Node 20, 22, and 24, with `pnpm@10.34.1`.
- Published exclusively by the two-step GitHub Actions flow with npm provenance (SLSA attestation); no human-run `npm publish`. See [.github/RELEASING.md](./.github/RELEASING.md).

See [SPEC.md](./SPEC.md) for the formal specification, including the [stability promise](./SPEC.md#5-stability-promise) and the [SemVer policy](./SPEC.md#52-semver-policy).

---

## FAQ

**I already trace my agents. Why this?**
Tracers (Braintrust, Langfuse, LangSmith, LangWatch, Helicone, Datadog LLM Observability) record what happened and are excellent at it. None of them learns what is normal for each of your agents. Behavioral AI fingerprints every observed unit and tells you what is abnormal now and what crosses the line next. It takes OpenTelemetry as input precisely so it can sit downstream of your tracer rather than replace it.

**How does it avoid false positives?**
By construction, and by benchmark: findings need 2 consecutive out-of-range evaluations with no single-observation bypass, rate features use an exact binomial tail instead of a normal approximation, forecasts require a statistically significant slope, Page-Hinkley firing on stationary streams is bounded by its forgetting factor, alerts respect a per-agent cooldown that only a strictly higher severity bypasses, and canary mode lets you watch what would have fired before anything reaches a human. The stationary-control scenario in the CI benchmark holds the line: zero drift findings and at most 2 forecast events across 2000 healthy turns. If a change is intentional, `absorb()` accepts it as the new normal in one call.

**Does it see my prompts or completions?**
No. The engine cannot receive content by contract: `TurnObservation` carries numbers, category labels, and identifiers you choose. State snapshots hold aggregate statistics only. There is nothing to redact because nothing sensitive ever enters.

**Does it run on the edge or in the browser?**
Yes. `@takk/behavioralai/edge` and `/web` expose the core surface without the Node file backend, and the 12 `/channels` factories are pure `fetch`. Cloudflare Workers, Vercel Edge, Deno, Bun, and browsers are first-class; only `fileState`, the CLI, and `emailChannel` require Node >= 20.

**What about low-traffic agents?**
Warmup is counted in observations, not time: at the default of 50, an agent observed once per hour is blind for roughly two days, and a restart without a state backend starts the count over. For low-traffic agents, lower `warmup.minObservations` and persist baselines with `fileState` (or your own `StateBackend`) so learned normals survive restarts. High-cardinality profile spaces (for example auto-created `tool:` profiles from spans) are capped by the `maxAgents` option (default 1000); observations for agents beyond the cap are ignored with an `error` telemetry event instead of growing memory forever.

**How does warmup work?**
Each agent starts in `learning` status. After `warmup.minObservations` turns (default 50) the baseline flips to `ready` (a `baseline.ready` telemetry event) and drift evaluation begins. Until then reports carry the learning status and no findings, so a fresh agent can never page anyone.

**I run a fleet of agents. Does this scale?**
Each `agentId` gets its own independent fingerprint, and the naming convention (`skill:summarize`, `gateway:openrouter`, `mcp:filesystem`, `tool:web_search`) turns every layer of the stack into an observed unit. Memory is O(features x windowSize) per profile, around 100 kB at the default window, and `observe()` stays under a millisecond per turn.

**Does this help with EU AI Act, SOC 2, or ISO 42001 work?**
It produces a strong supporting artifact for those programs: continuous behavioral monitoring of non-human entities with a learned reference, severity-classified deviations, a delivery trail (`alert.dispatched` / `alert.suppressed` / `alert.failed`), and persisted, content-free baselines you can show an auditor.

**When should I not use it?**
When you need a trace store, content evaluation (hallucination or toxicity scoring), automatic remediation, or hosted dashboards. Behavioral AI deliberately does none of that: it observes, reports, and alerts, and it never mutates the observed system. Pair it with a tracer and your own runbooks for the rest.

---

## Contributing

See [.github/CONTRIBUTING.md](./.github/CONTRIBUTING.md) for the contributor guide. Substantive proposals open a GitHub Issue first; trivial fixes can go straight to a PR. All commits require DCO sign-off (`git commit -s`). Non-trivial contributions are governed by the [Contributor License Agreement](./CLA.md). Tests, lint, typecheck, build, and publint must be green before review (`pnpm verify`).

## Community & support

- **Site and docs.** [behavioralai.takk.ag](https://behavioralai.takk.ag/)
- **Issues & feature requests.** Open a GitHub issue at [`davccavalcante/behavioralai/issues`](https://github.com/davccavalcante/behavioralai/issues). For each report, include: the package version, a minimal reproduction, expected vs. actual behaviour, and (where relevant) the telemetry events or the `radar.inspect()` snapshot.
- **Discussions.** Questions, ideas, and show-and-tell at [`davccavalcante/behavioralai/discussions`](https://github.com/davccavalcante/behavioralai/discussions).
- **Security disclosures.** Do NOT open public issues for vulnerabilities. Follow the responsible-disclosure flow in [`SECURITY.md`](./SECURITY.md): contact `davcavalcante@proton.me` (or `say@takk.ag`) with the `[SECURITY]` prefix.
- **Code of Conduct.** This project follows the [Contributor Covenant 2.1](./CODE_OF_CONDUCT.md). Participation in any Behavioral AI space (issues, PRs, discussions) implies agreement.
- **Contributions.** All non-trivial contributions go through the [Contributor License Agreement](./CLA.md).

---

## Author

Created by **David C Cavalcante**. [davcavalcante@proton.me](mailto:davcavalcante@proton.me) (preferred) · [say@takk.ag](mailto:say@takk.ag) (Takk relay) · [linkedin.com/in/hellodav](https://linkedin.com/in/hellodav) · [x.com/davccavalcante](https://x.com/davccavalcante) · [takk.ag](https://takk.ag/)

Behavioral AI is the watchdog layer of a broader portfolio of NPM packages targeting infrastructure for Massive Intelligence (IM) for 2026-2030, built at Takk Innovate Studio.

---

## Related research by the author

The architectural philosophy behind Behavioral AI, treating agents as non-human entities with learned behavioral identities that can be observed, supervised, and governed, echoes the author's research frameworks:

- **MAIC (Massive Artificial Intelligence Consciousness)**: a systemic intelligence framework designed to coordinate, supervise, and govern large-scale intelligence ecosystems, providing global context awareness, alignment, and orchestration across multiple models, agents, and decision layers.
- **HIM (Hybrid Intelligence Model)**: a hybrid intelligence layer that integrates machine intelligence systems with human-defined logic, rules, heuristics, and strategic intent, interpreting objectives and structuring decision-making before and after model execution.
- **NHE (Non-Human Entity)**: a non-human cognitive entity with a defined functional identity and operational agency within an intelligence ecosystem, operating through coordinated intelligence layers while maintaining a non-anthropomorphic identity.

These frameworks are published independently of Behavioral AI and are separate works:

- Research papers: [The Soul of the Machine](https://philarchive.org/rec/CRTTSO) · [Beyond Consciousness in LLMs](https://philarchive.org/rec/CRTBCI) · [The Cave of Silence](https://philarchive.org/rec/CRTTCO).
- PhilPapers profile: [David Cortes Cavalcante](https://philpeople.org/profiles/david-cortes-cavalcante).
- Hugging Face: [TeleologyHI](https://huggingface.co/TeleologyHI).
- GitHub: [davccavalcante](https://github.com/davccavalcante) · [Takk8IS](https://github.com/Takk8IS).

---

## Sponsors

Join the journey as the portfolio continues to ship infrastructure for Massive Intelligence (IM). Your support is the cornerstone of this work.

- Sponsor on GitHub: [github.com/sponsors/davccavalcante](https://github.com/sponsors/davccavalcante)
- USDT (TRC-20): `TS1vuhMAhFpbd7y68cu5ZtP9PsXVmZWmeh`

---

## Privacy

Behavioral AI runs entirely inside your own process and infrastructure. It makes no outbound calls to the author, collects no usage data, and ships no analytics. The only network traffic it produces is the alert deliveries you configured, to the destinations you chose. The engine never receives prompt or completion content, and persisted state contains aggregate statistics only: never credentials, never conversation text. See [PRIVACY.md](./PRIVACY.md) for the full data-handling notice, including how the optional file state backend persists baselines on disk.

---

## License

Licensed under the **Apache License 2.0**. See [LICENSE](./LICENSE) for the full text and [NOTICE](./NOTICE) for attribution and third-party component licenses. You may use, modify, and distribute the code under the terms of that license, including its patent grant and attribution requirements.
