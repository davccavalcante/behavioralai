# Changelog

All notable changes to `@takk/behavioralai` are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-06-11T11:48:27Z

Initial stable release of Behavioral AI. Universal, zero-runtime-dependency NPM library and
CLI for behavioral observability of Massive Intelligence (IM) agents and
non-human entities (NHE): per-agent behavioral fingerprinting learned in
production, real-time statistical drift detection, cause attribution, trend
forecasting, and multi-channel alerting. OpenTelemetry GenAI spans as input.

### Added

#### Core engine

- `createBehavioralAI(options)` factory returning a `BehavioralAI` engine
  (`observe`, `fingerprintOf`, `reportOf`, `agents`, `inspect`, `on`,
  `ready`, `absorb`, `flush`, `close`). `observe()` is synchronous and
  performs no I/O; alert delivery and persistence run in the background and
  surface as telemetry, so the engine can never block or crash the observed
  agent.
- Multi-dimensional feature extraction per turn: `latencyMs`, `costUsd`,
  `inputTokens`, `outputTokens`, `totalTokens`, `contextTokens`,
  `contextSnr` (completion per context token), `retrievalChunks`,
  `toolCallCount`, `toolFailureRate`, `turnIndex`, `errorRate`, plus the
  categorical distributions `toolSelection` and `finishReason`.
- Behavioral fingerprint per agent built from streaming statistics only:
  Welford mean/variance, EWMA mean/variance, P-square quantile estimators
  (p50/p95/p99), per-feature recent windows, and categorical frequency
  baselines. No raw observation retention beyond the configured window.
- Drift detection with four complementary detectors: robust z-score
  against the recency-weighted baseline, an exact one-sided binomial tail
  test for bounded-rate features, a two-sided Page-Hinkley sequential
  mean-shift test with exponential forgetting (a firing opens a finding
  immediately and re-arms), and bias-corrected Jensen-Shannon divergence
  for categorical mixes. Two-evaluation confirmation suppresses
  single-turn blips with no single-observation bypass.
- Anomaly hygiene by design: per-feature drift state machines with
  Schmitt-trigger recovery hysteresis (5 evaluations below 0.7x warning),
  baseline freezing while any finding is open so incidents never poison
  the learned normal, in-band-only baseline absorption, and explicit
  `absorb()` to accept a new normal (rebuilds the baseline from the recent
  window). A labeled detection-quality benchmark (7 deterministic
  scenarios with hard acceptance bounds) runs in CI alongside the
  mechanism tests.
- Attribution layer: ranked per-feature contributions (normalized, summing
  to 1) with direction, observed vs expected values, and human-readable
  summaries on every drift report.
- Predictive alerts: least-squares trend projection per feature with a
  slope-significance gate (4 standard errors) and physical-domain clamps,
  time-to-critical estimates (observations and hours, 24 h horizon)
  surfaced as forecasts and optional forecast alerts; the stationary
  benchmark bounds false forecasts at 2 per 2000 healthy turns.
- Composite behavior score (0..100), EWMA-smoothed and counting only
  warning-level deviations: healthy agents read a steady 100.
- Sensitivity presets `strict`, `balanced` (default), `relaxed`, plus fully
  custom thresholds (`warningZ`, `criticalZ`, divergence thresholds, EWMA
  alpha, Page-Hinkley delta/lambda).
- Alert governor: per agent/kind/feature cooldown with escalation bypass,
  severity floor, canary mode (evaluate everything, deliver nothing), and
  recovery/forecast notification toggles.
- Telemetry bus with 15 event kinds (`observation.recorded`,
  `agent.registered`, `baseline.learning`, `baseline.ready`,
  `baseline.frozen`, `baseline.absorbed`, `drift.detected`,
  `drift.recovered`, `forecast.detected`, `alert.dispatched`,
  `alert.suppressed`, `alert.failed`, `state.loaded`, `state.persisted`,
  `error`).
- State persistence: `memoryState()` and atomic-write `fileState({ path })`
  backends with a versioned `StateSnapshot` schema (v1) and non-blocking
  hydration (`ready()`).
- Cardinality guard: `maxAgents` option (default 1000) protects
  long-running processes from unbounded profile creation.

#### Alert channels (`@takk/behavioralai/channels`, fetch-based, universal)

- `slackChannel`, `discordChannel`, `teamsChannel` (Adaptive Card),
  `googleChatChannel`, `telegramChannel`, `pagerdutyChannel` (Events API
  v2), `webhookChannel`, `notionChannel` (database page per alert),
  `redditChannel` (script-app OAuth2), `xChannel` (OAuth2 bearer or full
  OAuth 1.0a HMAC-SHA1 via WebCrypto), `googleSheetsChannel` (row append),
  `googleDocsChannel` (document append), all zero-dependency and safe in
  Node 20+, browsers, and edge runtimes.
- Google service-account authentication built in (`googleAccessToken`):
  RS256 JWT signing via WebCrypto, token caching, no SDK required.
- `TokenSource` (`string | () => string | Promise<string>`) on every
  credential for rotation-friendly setups.
- Channel contract: `send()` never throws; failures resolve as
  `ChannelResult` and surface as `alert.failed` telemetry; every request
  carries an enforced timeout.

#### Email (`@takk/behavioralai/smtp`, Node only)

- `emailChannel`: minimal built-in SMTP client over `node:net`/`node:tls`
  with STARTTLS, implicit TLS, AUTH LOGIN, multi-recipient delivery,
  CRLF normalization, and dot-stuffing. Zero dependencies.

#### OpenTelemetry ingestion (`@takk/behavioralai/otel`)

- `turnFromSpan` and `observeSpan`: map OpenTelemetry GenAI
  semantic-convention spans (including hermes-otel exports for Hermes
  Agent) to turn observations. Tool spans become first-class `tool:<name>`
  behavioral profiles; skills, gateways, and MCP servers are profiled by
  agent-id convention.

#### Sibling integrations (`@takk/behavioralai/integrations`, optional peers)

- `keymeshBridge`: fingerprints `@takk/keymesh` credential-pool behavior
  from its telemetry (per-pool or per-key profiles).
- `modelchainBridge`: fingerprints every model served by a
  `@takk/modelchain` router (per-router or per-model profiles).
- `modelchainAlertSummarizer`: alert enricher that appends a model-written
  two-sentence incident summary via `router.complete()`.
- Implemented with structural typing only; neither package is imported, so
  consumers without them pay nothing. Type compatibility is proven in CI
  against the published 1.0.0 declarations.

#### CLI (`behavioralai`, Node only, zero dependencies)

- `behavioralai help`, `behavioralai inspect --state <path>`,
  `behavioralai simulate` (deterministic seeded demo: learns a baseline,
  injects drift, reports detection delay), and `behavioralai serve`
  (127.0.0.1 HTTP collector: `POST /observe`, `GET /inspect`,
  `GET /healthz`, optional file persistence, Slack/webhook alerting, and
  optional bearer-token auth via `--token`), the bridge for Python-first
  stacks such as Hermes Agent.

#### Quality and packaging

- 201 tests across 14 suites (including the detection-quality benchmark);
  coverage 94.4 percent lines, 92.88 percent statements, 95.51 percent
  functions, 85.08 percent branches.
- TypeScript max-strict; Biome lint clean; publint clean; attw type
  resolution green for all 8 entry conditions; dual ESM+CJS with .d.ts and
  .d.cts for every entry.
- Bundle budgets enforced (brotli): core 8.88 kB ESM / 9.04 kB CJS,
  channels 3.26 kB, otel 0.81 kB, smtp 2.05 kB, integrations 0.74 kB,
  web 8.26 kB, edge 8.26 kB.
- Two-step Creator-gated release flow (`release.yml` then
  `npm-publish.yml`) with SLSA provenance attestation on publish.

[1.0.0]: https://github.com/davccavalcante/behavioralai/releases/tag/v1.0.0
