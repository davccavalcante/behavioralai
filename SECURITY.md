# Security Policy

Behavioral AI (`@takk/behavioralai`) is a stable (1.0.0) library for behavioral observability
of production agents: per-agent fingerprinting, drift detection, attribution,
and alerting. We take security reports seriously and aim to acknowledge each
one within two business days.

## Supported versions

Each published version follows strict SemVer (see [`SPEC.md`](./SPEC.md) §5 and
[`.github/RELEASING.md`](./.github/RELEASING.md)). Only the latest minor of the
current major receives security patches; an older major receives critical-CVE
fixes for 6 months after the next major lands.

| Package | Supported |
|---|---|
| `@takk/behavioralai` | current `latest` dist-tag |

## Reporting a vulnerability

**Please do not file public GitHub issues for security problems.** Send reports
privately to:

- Email: `davcavalcante@proton.me` with subject prefix `[SECURITY]`
- Alternative: `say@takk.ag`

Include: affected version, a minimal reproduction, the impact you believe it
has, and any suggested fix. Reports in English are processed fastest.

## Response process

1. Acknowledgement within two business days.
2. Triage and severity assessment (CVSS) within five business days.
3. Fix developed privately; coordinated disclosure date agreed with the
   reporter.
4. Patched release published to NPMJS with SLSA provenance, followed by a
   GitHub Security Advisory crediting the reporter (unless anonymity is
   requested).

## Threat model in scope

- Alert-channel credential handling: webhook URLs, bot tokens, routing keys,
  OAuth secrets, and SMTP passwords pass through channel factories. They are
  held in closure scope only, are never logged, never serialized into state
  snapshots, and never appear in telemetry events or error messages.
- Persisted baseline integrity: `fileState` snapshots are plain JSON on local
  disk; writes are atomic (temp file plus rename) so a crash cannot corrupt a
  previous baseline. Snapshots contain learned statistics only, never
  credentials and never raw prompt or completion content.
- Injection through observations: `TurnObservation` fields are treated as
  opaque data, never evaluated, never interpolated into shell commands or
  HTML. Channel payloads JSON-encode all user-influenced strings.
- Outbound alert traffic: every channel request has an enforced timeout and
  reports failure through `ChannelResult`; a malicious or broken endpoint
  cannot crash, hang, or block the observed agent.
- The `serve` CLI bridge binds to 127.0.0.1 by default, caps request bodies
  at 1 MB, and exposes no mutating endpoint other than `/observe`.
- Baseline poisoning resistance: features under active critical drift are
  frozen and excluded from baseline absorption, so an attacker who degrades
  an agent cannot quietly retrain the fingerprint to accept the degraded
  behavior; accepting a new normal requires an explicit `absorb()` call.

## Out of scope

- Vulnerabilities in the agents, frameworks, or providers being observed.
- Compromise of the machine or process that hosts the engine (anyone with
  process memory access already owns the observations).
- Alert delivery guarantees during third-party outages (Slack, PagerDuty,
  X, Reddit, Google, Microsoft, Notion, Telegram, Discord, or SMTP relays).
- Statistical evasion through changes slower than the configured
  sensitivity; tune `sensitivity` and review `absorb()` usage for your risk
  profile.
- The optional peer packages `@takk/keymesh` and `@takk/modelchain` have
  their own security policies in their own repositories.

## Supply-chain assurances

- Zero required runtime dependencies; nothing to audit transitively.
- Optional peer dependencies are limited to `@takk/keymesh` and
  `@takk/modelchain`, both published by the same author with provenance.
- Every release is built and published exclusively by GitHub Actions with
  npm provenance attestation (SLSA); no human-run `npm publish`.
- The published tarball ships `dist/`, `README.md`, `LICENSE`, `NOTICE`,
  `CHANGELOG.md`, and `SECURITY.md` only; no tests, no fixtures, no secrets.
- `pnpm-lock.yaml` is committed; CI installs with `--frozen-lockfile`.
