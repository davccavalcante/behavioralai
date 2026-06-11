# Contributing to @takk/behavioralai

Thanks for considering a contribution. This document is the canonical guide for proposing changes to Behavioral AI (`@takk/behavioralai`), the behavioral observability layer that learns a per-agent fingerprint for Massive Intelligence (IM) agents and non-human entities (NHE), detects drift before visible failure, and forecasts the trend.

The project is open source under [Apache License 2.0](../LICENSE). The package surface and stability promise are documented in [SPEC.md](../SPEC.md); the live roadmap and deferred work are in [TASK.md](../TASK.md).

---

## 1. Code of conduct

Be respectful, be precise, and assume good faith. The full text lives in [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md). The maintainer reads every issue and PR personally; disrespectful, harmful, or manipulative behavior is grounds for removal from the project.

---

## 2. Contributor license

Every contribution is governed by the Apache License 2.0 (the same license the project is published under) and the contributor agreement in [CLA.md](../CLA.md). Sign off every commit with `git commit -s` (Developer Certificate of Origin):

```bash
git commit -s -m "fix(drift): cap forecast horizon at 24 h"
```

The `-s` flag appends a `Signed-off-by:` trailer that attests you have the right to submit the change under Apache 2.0. PRs without DCO sign-off are not merged.

---

## 3. Local setup

### 3.1 Prerequisites

- **Node 20, 22, or 24.** CI runs the full matrix; pick one for local dev. `.nvmrc` pins 22.
- **pnpm 10.** The repo pins `pnpm@10.34.1` via `packageManager`. `npm` and `yarn` also work but `pnpm-lock.yaml` is the source of truth.
- **git** with `git commit -s` configured (DCO).

### 3.2 Clone and install

```bash
git clone https://github.com/davccavalcante/behavioralai.git
cd behavioralai
pnpm install
```

### 3.3 Verify locally

```bash
pnpm verify          # lint + typecheck + test + build + publint
pnpm attw            # type-correctness of every entry condition
pnpm size            # brotli budget per entry point
# or run individually:
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
pnpm publint
```

Current baseline (verify before opening a PR): **201 tests passing across 14 suites**. Coverage `lines 94.4% / statements 92.88% / functions 95.51% / branches 85.08%` (enforced thresholds 80/80/80/60 in `vitest.config.ts`).

---

## 4. Branch and commit conventions

### 4.1 Branch names

- `fix/<short-slug>` - bug fixes
- `feat/<short-slug>` - new optional surface (minor bump)
- `docs/<short-slug>` - README/SPEC/CHANGELOG-only changes
- `chore/<short-slug>` - tooling, deps, CI
- `refactor/<short-slug>` - internal restructuring with no API change

Avoid PRs larger than ~500 LOC; split into smaller logically-coherent PRs.

### 4.2 Commit style

[Conventional Commits](https://www.conventionalcommits.org/) are encouraged but not enforced. What IS enforced:

- **One commit per logical change.** No `WIP` or `fixup` commits in the merged history.
- **Imperative subject up to 70 chars.** Body wrap at 72 cols.
- **DCO sign-off (`git commit -s`).**
- **No commit credits to Massive Intelligence (IM) assistants.** This is the Creator's discipline.

### 4.3 What requires a discussion before coding

Open a GitHub Issue first if your change touches:

- New public export (SemVer minor/major impact - see [SPEC.md §5](../SPEC.md#5-stability-promise)).
- New telemetry event kind.
- The persisted `StateSnapshot` schema.
- The CLI flags or subcommands (`inspect`, `simulate`, `serve`).
- The `AlertChannel`, `AlertEnricher`, or `StateBackend` interface, or the sensitivity presets (`strict` / `balanced` / `relaxed`).
- The drift state machine semantics (two-evaluation confirmation, recovery after 5 in-range evaluations, baseline freeze during critical drift, `absorb`).

For docs-only fixes, typos, or contained internal refactors, skip the issue and open a PR directly.

---

## 5. Pull request workflow

### 5.1 Before opening

- All checks green: `pnpm verify`, plus `pnpm attw` and `pnpm size`.
- Coverage thresholds preserved or improved (see `vitest.config.ts`).
- For any change that touches the public API: `SPEC.md` and `README.md` updated.
- For any deprecated surface: `@deprecated` JSDoc + runtime `console.warn` (debounced) + a `### Deprecated` section in the next `CHANGELOG.md` entry.

### 5.2 PR description

Fill the [PULL_REQUEST_TEMPLATE.md](./PULL_REQUEST_TEMPLATE.md) honestly. Empty sections are not acceptable; write "N/A" with a one-line reason if a section truly does not apply.

### 5.3 Review

The maintainer reviews every PR personally. Expect:

- Surgical line-by-line read.
- Question on intent before merge (Creator's discipline: "if you notice any problem, error, or inconsistency, ask before acting").
- Required for governance-touching changes: explicit Creator approval before merge.

### 5.4 After merge

CI publishes nothing on merge to `main`. Publishing is a Creator-triggered two-step flow: a reviewable GitHub Release is created first, and only then promoted to NPMJS (see [RELEASING.md](./RELEASING.md)).

---

## 6. Tests

Add tests for any non-trivial change. Patterns:

- **Vitest** in `tests/unit/` (one file per surface area: core, stats, fingerprint, feature extraction, channels, channel auth, SMTP, OTel, state, CLI args) and `tests/integration/` (engine lifecycle, CLI, integrations).
- **Deterministic seeds** for anything random; the drift and forecasting paths must produce identical results on every run.
- **`fetch` is stubbed** for every channel HTTP path. No network calls in tests.
- **SMTP tests** run against a scripted local SMTP server on a loopback socket (see `tests/unit/smtp.test.ts` for the canonical pattern).
- **CLI tests** spawn the CLI as a subprocess via `tsx` (see `tests/integration/cli.test.ts`).
- **No live credentials in CI.** Tests run fully offline.

Every fix-able bug ships with a regression test that fails pre-fix and passes post-fix.

---

## 7. Security disclosure

Do NOT open a public GitHub Issue for security vulnerabilities. Follow [SECURITY.md](../SECURITY.md): email `davcavalcante@proton.me` with the prefix `[SECURITY]` and we will coordinate fix + disclosure timeline privately.

---

## 8. Releasing

Releases are maintainer-only. The full runbook lives in [RELEASING.md](./RELEASING.md); the flow is deliberately two-step (GitHub Release reviewed first, NPMJS publication second). Contributors do not tag, do not publish, do not edit historical CHANGELOG entries (those are immutable per Keep a Changelog).

When proposing a change that warrants a release, indicate in your PR description which SemVer bump you believe it triggers (patch / minor / major per [SPEC.md §5.2](../SPEC.md#52-semver-policy)). The maintainer makes the final call.

---

## 9. Communication

- **GitHub Issues** for bug reports + feature requests (see [ISSUE_TEMPLATE/](./ISSUE_TEMPLATE)).
- **GitHub Discussions** (if enabled) for design conversations.
- **Email** `davcavalcante@proton.me` for anything private, sensitive, or trademark/licence-related.

The project's primary language for code, docs, CI, issues, and PRs is **English**. Use English in PR descriptions and code comments.

---

## Contact

**David C Cavalcante**
- Email: [davcavalcante@proton.me](mailto:davcavalcante@proton.me)
- LinkedIn: [linkedin.com/in/hellodav](https://linkedin.com/in/hellodav)
- GitHub: [github.com/davccavalcante](https://github.com/davccavalcante)
- X: [x.com/davccavalcante](https://x.com/davccavalcante)
- Project site: [takk.ag](https://takk.ag)
