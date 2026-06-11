# @takk/behavioralai - Technical Specification

**Version:** 1.0.0
**Status:** Stable
**License:** Apache-2.0

This document is the binding technical contract for the public surface of
`@takk/behavioralai`. Statements here use RFC-2119 keywords (MUST, MUST
NOT, SHOULD). Anything not documented here or in the generated type
declarations is internal and may change without notice.

---

## 1. Purpose

Behavioral AI (`@takk/behavioralai`) is a behavioral observability engine for Massive Intelligence
(IM) agents and non-human entities (NHE) in production. It learns a
statistical fingerprint of each observed unit (agent, skill, gateway, MCP
server, tool, model, credential pool) from per-turn measurements, detects
deviations from that learned normal in real time, attributes which features
caused the deviation, projects trends toward critical thresholds, and
delivers alerts to operational channels. Where tracers record what
happened, Behavioral AI states what is abnormal now and what will cross the
line next, before a visible failure.

The engine is a passive observer by contract:

- `observe()` MUST be synchronous and MUST NOT perform I/O.
- Alert delivery and state persistence MUST run asynchronously and report
  outcomes only through telemetry.
- No failure of a channel, enricher, or state backend may ever propagate an
  exception into the observed agent's call path.
- The engine MUST NOT receive, retain, or transmit prompt or completion
  content; the ingestion contract is numbers, category labels, and
  caller-chosen identifiers.

## 2. Public surface

### 2.1 Entry points

| Entry | Runtime | Contents |
|---|---|---|
| `@takk/behavioralai` | universal | engine, errors, state backends, sensitivity presets, all public types |
| `@takk/behavioralai/otel` | universal | `turnFromSpan`, `observeSpan`, span data types |
| `@takk/behavioralai/channels` | universal | 12 fetch-based channel factories, `TokenSource`, `GoogleAuth`, formatting helpers |
| `@takk/behavioralai/smtp` | Node >= 20 | `emailChannel` (built-in SMTP client) |
| `@takk/behavioralai/integrations` | universal | `keymeshBridge`, `modelchainBridge`, `modelchainAlertSummarizer`, structural types |
| `@takk/behavioralai/web` | browsers | core surface minus the file state backend |
| `@takk/behavioralai/edge` | edge runtimes | core surface minus the file state backend |
| `behavioralai` (bin) | Node >= 20 | CLI: `help`, `inspect`, `simulate`, `serve` |

All library entries ship dual ESM + CJS with `.d.ts`/`.d.cts`. The package
has zero runtime dependencies; `@takk/keymesh` and `@takk/modelchain` are
optional peers used only by import-free structural adapters.

### 2.2 Core API

`createBehavioralAI(options?: BehavioralAIOptions): BehavioralAI`

| Option | Default | Contract |
|---|---|---|
| `sensitivity` | `'balanced'` | preset name or partial `SensitivityConfig` merged over balanced |
| `warmup.minObservations` | `50` | observations per agent before findings are emitted; MUST be >= 1 |
| `windowSize` | `50` | recent-window length per feature; integer >= 5 |
| `maxAgents` | `1000` | cardinality guard; observations for new agents beyond the cap are ignored with an `error` telemetry event |
| `alerts.cooldownMs` | `300000` | per agent/kind/top-feature delivery cooldown; escalations bypass |
| `alerts.minSeverity` | `'warning'` | severity floor for drift alerts |
| `alerts.canary` | `false` | evaluate and emit telemetry, never deliver to channels |
| `alerts.notifyRecovery` | `true` | deliver `recovery` alerts (severity `info`) |
| `alerts.notifyForecast` | `true` | deliver `forecast` alerts (severity `warning`) |
| `channels` | `[]` | `AlertChannel[]`; failures surface as `alert.failed` telemetry |
| `enrich` | none | `AlertEnricher` applied before dispatch; failure falls back to the original alert |
| `state` | none | `StateBackend`; hydration is async and additive (`ready()`) |
| `now` | system clock | clock override; with it the engine is fully deterministic |

`BehavioralAI` methods and their guarantees:

- `observe(turn)` validates `agentId` (non-empty string, else
  `ConfigurationError`), evaluates synchronously, returns the
  `DriftReport` for that turn, and never blocks on I/O.
- `fingerprintOf(agentId)`, `reportOf(agentId)`, `agents()`, `inspect()`
  are pure reads of current state.
- `on(listener)` subscribes to telemetry; listener exceptions are
  swallowed; returns an unsubscribe function.
- `ready()` resolves when state hydration finished (no-op without a
  backend). Hydration only restores agents not yet observed locally.
- `absorb(agentId, feature?)` accepts the recent window as the new normal
  for one or all features: baselines are rebuilt from the window, drift
  states reset, frozen features unfrozen. Unknown agent throws
  `ConfigurationError`.
- `flush()` awaits hydration, drains in-flight alert deliveries, and
  persists a snapshot when a backend is configured.
- `close()` flushes, closes the backend, and invalidates the engine;
  `observe()`/`absorb()` after close throw `ClosedError`.

Behavior score: an EWMA-smoothed `round(100 * exp(-index))` where the
index is the rms of per-feature deviations that count ONLY at warning level
or above (sub-warning statistical noise reads as zero, capped at 3x
critical per feature). Healthy agents read a steady 100 (the detection
benchmark bounds the healthy 5th percentile at >= 99); genuine drift pulls
the score down within 1-2 evaluations.

### 2.3 Error hierarchy

`BehavioralaiError` (base) with `ConfigurationError`, `StateError`,
`ClosedError`. Channels MUST NOT throw from `send()`; they resolve
`ChannelResult { channel, ok, status?, error? }`.

### 2.4 Telemetry events

`TelemetryEvent { kind, timestamp, agentId?, feature?, severity?,
channel?, message?, report?, alert? }` with 15 kinds:
`observation.recorded`, `agent.registered`, `baseline.learning`,
`baseline.ready`, `baseline.frozen`, `baseline.absorbed`,
`drift.detected`, `drift.recovered`, `forecast.detected`,
`alert.dispatched`, `alert.suppressed`, `alert.failed`, `state.loaded`,
`state.persisted`, `error`. New kinds are a minor change; removing or
renaming one is major.

## 3. Architecture

### 3.1 Feature extraction

Each `TurnObservation` is reduced to the numeric features `latencyMs`,
`costUsd`, `inputTokens`, `outputTokens`, `totalTokens`, `contextTokens`,
`contextSnr` (= outputTokens / contextTokens), `retrievalChunks`,
`toolCallCount`, `toolFailureRate`, `turnIndex`, `errorRate`, and the
categorical features `toolSelection` (one sample per tool call) and
`finishReason`. Only provided dimensions are fingerprinted; `errorRate` is
always extracted (absent error means 0) so silent failure onset is always
observable.

### 3.2 Fingerprinting statistics

Per numeric feature and agent: Welford running mean/variance/min/max
(long-run baseline), EWMA mean/variance (recency-weighted baseline, alpha
from sensitivity), three P-square quantile estimators (p50, p95, p99), a
recent window of (timestamp, value) points, and a Page-Hinkley detector.
Per categorical feature: cumulative baseline frequencies plus a recent
window. Memory per agent is O(features x windowSize); raw history is never
kept beyond the window.

### 3.3 Drift detection

Numeric point features: robust z = (x - ewmaMean) / max(ewmaStd,
0.25 x welfordStd, 1e-9), capped at +-50. Bounded-rate features
(`errorRate`, `toolFailureRate`) use an EXACT one-sided binomial tail test
(the p-chart normal approximation is invalid at np < 5, where healthy
agents live): the window failure count is tested against the
Laplace-smoothed baseline rate and expressed as an equivalent z via the
inverse normal CDF, alerting on the harmful direction only. Sustained
shifts are confirmed by a two-sided Page-Hinkley test over
baseline-standardized samples with exponential forgetting (0.999); a
firing opens a finding IMMEDIATELY (the detector is itself a
multi-observation confirmation), does not touch the per-feature state
machine, and re-arms, producing a bounded reminder cadence for persistent
regime changes. Categorical features: bias-corrected Jensen-Shannon
divergence (base 2, bounded [0,1]) between the recent window and the
learned baseline, subtracting the finite-sample bias (k - 1) / (4 n ln 2).

Severity: `warning` and `critical` thresholds per sensitivity. A finding
opens only after 2 consecutive out-of-range evaluations; there is NO
single-observation bypass (heavy-tailed features cannot page on one
sample). Baseline absorption takes only in-band values (a value already at
warning level never feeds the baseline). A drifted feature recovers after
5 consecutive evaluations comfortably back in range (below 0.7x warning,
Schmitt-trigger hysteresis). While a feature has ANY open finding its
baseline is frozen: anomalous turns are excluded from absorption so the
fingerprint cannot be poisoned by the incident it is reporting; release
requires recovery or explicit `absorb()`.

Sensitivity presets:

| Preset | warningZ | criticalZ | warnJSD | critJSD | ewmaAlpha | PH delta | PH lambda |
|---|---|---|---|---|---|---|---|
| strict | 2.5 | 3.5 | 0.07 | 0.18 | 0.08 | 0.01 | 50 |
| balanced | 3 | 4.5 | 0.10 | 0.25 | 0.05 | 0.02 | 75 |
| relaxed | 4 | 6 | 0.16 | 0.38 | 0.03 | 0.04 | 110 |

JSD thresholds apply to the bias-corrected divergence.

### 3.4 Attribution and forecasting

Attribution ranks features by squared normalized deviation (top 5,
contributions sum to 1) with direction, observed/expected values, and a
one-line summary each. Forecasting fits a least-squares trend over the
recent window (>= 8 points) of non-drifted features, REQUIRES slope
significance (|slope| >= 4 standard errors, so stationary noise produces
near-zero forecasts), clamps projections to the feature domain (no
negative thresholds; rates within [0, 1]), and reports time-to-critical in
observations and hours when the projection lands within 24 hours.

### 3.5 Alert governance

Alerts carry kind `drift` (severity = max finding severity), `recovery`
(severity `info`), or `forecast` (severity `warning`). The governor
applies, in order: canary mode, the drift severity floor, and a cooldown
keyed by (agent, kind, top attributed feature) that a strictly higher
severity bypasses. Suppressed alerts emit `alert.suppressed` telemetry
with the reason. Dispatch fans out to all channels concurrently; `flush()`
drains in-flight deliveries.

### 3.6 State persistence

`StateSnapshot` v1: `{ version: 1, savedAt, agents: Record<agentId,
serialized fingerprint> }` containing aggregate statistics, drift states,
and window values only; never credentials, never content. `fileState`
writes atomically (temp file + rename). Loading an unsupported version
throws `StateError`; engine hydration converts backend failures into
`error` telemetry instead of crashing.

## 4. Operational SLOs

On the reference laptop (Apple Silicon, Node 22):

- `observe()` p99 < 1 ms per turn at 12 numeric + 2 categorical features
  (pure in-memory statistics; the test suite of 201 cases including
  thousands of observations completes in well under one second).
- Memory: O(agents x features x windowSize); the default window of 50
  keeps a single agent profile around 100 kB.
- Detection quality is enforced by a labeled benchmark suite in CI
  (tests/integration/detection-benchmark.test.ts, 7 deterministic
  scenarios), with these bounds at the balanced preset: an abrupt 6-sigma
  regression turns critical in exactly 2 evaluations; a sustained
  3.2-sigma shift opens within 15 evaluations, freezes the baseline, and
  produces no false recovery while it persists; a sustained 2.5-sigma
  shift (below the point threshold) is confirmed by Page-Hinkley within 80
  observations; an error-rate jump from 2 to 15 percent is detected within
  30 turns with the learned baseline held at or below 4 percent
  (anti-poisoning); a finish-reason mix shift from 5 to 40 percent is
  detected within 80 turns; a clean latency ramp produces a significant
  forecast before the critical threshold is crossed; the deterministic CLI
  simulation (seed 7) forecasts the injected latency ramp at turn 113,
  26 turns before the first hard detection.
- False-positive hygiene (balanced preset, benchmark-enforced): the
  stationary control scenario (2000 healthy turns) yields ZERO drift
  findings, at most 2 forecast events, and a healthy behavior-score 5th
  percentile of >= 99; single blips never open findings (2-evaluation
  confirmation, no extreme bypass).
- Alert delivery: every channel request enforces a timeout (default 10 s,
  SMTP 15 s total); one slow channel never delays another (concurrent
  fan-out).

## 5. Stability promise

### 5.1 What counts as the public API

Every name exported from the seven library entries, the CLI command and
flag surface, the persisted `StateSnapshot` v1 schema, the telemetry event
kinds and their documented fields, the channel wire formats documented in
the factory JSDoc, and the OTel attribute mappings in `/otel`.

### 5.2 SemVer policy

- Patch: bug fixes, doc fixes, internal refactors, dependency-free
  performance work; no observable contract change.
- Minor: new exports, new optional options or fields, new telemetry event
  kinds, new channels, new CLI flags or subcommands, new sensitivity
  presets, and new members in the `FeatureName` unions (consumers MUST NOT
  exhaustively switch over feature names); defaults may be tightened only
  if no documented contract breaks.
- Major: removing or renaming any export, changing a signature or default
  in a way that changes documented behavior, changing `StateSnapshot` in a
  non-additive way, removing a CLI flag, or changing the meaning of
  severities, scores, or thresholds.

Detection thresholds inside presets MAY be recalibrated in a minor version
only when the documented qualitative contract (section 4 hygiene
guarantees) is preserved or improved; any recalibration is CHANGELOG-noted.

### 5.3 Deprecation policy

A deprecated surface keeps working for at least one full minor cycle,
carries `@deprecated` JSDoc plus a CHANGELOG entry, and is removed only in
the next major. Security fixes are exempt from the waiting period but not
from documentation.

### 5.4 License and provenance invariants

Apache-2.0 forever for this package. Every published version is built and
published exclusively by the two-step GitHub Actions flow with npm
provenance (SLSA) attestation. No human-run `npm publish`. The published
tarball contains `dist/`, `README.md`, `LICENSE`, `NOTICE`,
`CHANGELOG.md`, `SECURITY.md` and nothing else.

## 6. Runtime expectations

- Node >= 20 for the core, CLI, and SMTP channel (uses global fetch,
  WebCrypto, `node:net`/`node:tls` via lazy dynamic import).
- Browsers and edge runtimes (Cloudflare Workers, Vercel Edge, Deno, Bun)
  are first-class for `.`, `/web`, `/edge`, `/channels`, `/otel`,
  `/integrations`: only web-standard APIs are referenced statically; the
  Node-only file backend and SMTP load their builtins lazily inside
  function bodies.
- No global state besides a token cache in the Google auth helper; two
  engines in one process never interact.
- The engine never installs signal handlers, timers, or sockets; the CLI
  `serve` command does (documented there).

## 7. Test surface

201 tests across 14 Vitest suites: statistics primitives (Welford, EWMA,
P-square, Page-Hinkley including stationarity and shift detection,
Jensen-Shannon, trend fitting), feature extraction, fingerprint lifecycle
(warmup, quiet stationarity, abrupt-shift freeze and recovery, categorical
shift, absorb-as-new-normal, forecast emission, JSON round-trip), engine
end-to-end (telemetry sequences, alert cooldown and escalation, canary,
enricher, channel failure isolation, persistence and hydration, close
semantics), all 12 fetch channels plus OAuth and service-account signing
(RS256 verified against a real key pair), SMTP against a scripted local
server (STARTTLS negotiation skip, AUTH LOGIN, dot-stuffing, failure
stages, timeout), OTel span mapping, sibling integrations (compile-time
assignability against the real published @takk/keymesh and
@takk/modelchain declarations, plus runtime bridge mapping), CLI argument
parsing and subprocess end-to-end (help, unknown command, deterministic
simulate, inspect, serve HTTP surface), plus the labeled
detection-quality benchmark described in section 4. Coverage: 94.4 percent
lines, 92.88 percent statements, 95.51 percent functions, 85.08 percent
branches, enforced thresholds 80/80/80/60.

## 8. Non-goals (in 1.0)

- Not a tracer and not a trace store: Behavioral AI consumes measurements,
  it does not record conversations or spans (pair it with your tracer via
  `/otel`).
- No multivariate covariance modeling (deviations combine per-feature;
  full covariance and Bayesian online changepoint detection are planned
  evolutions, see TASK.md).
- No hosted aggregation, dashboards, RBAC, or multi-tenant storage (the
  open core is local-first; managed baselines are a future cloud concern).
- No automatic remediation: Behavioral AI reports and alerts, it never
  mutates the observed system.
- No content evaluation (hallucination scoring, toxicity, faithfulness);
  the engine is content-free by design.
- No Windows-specific CLI service tooling; the CLI is a plain Node
  process.
