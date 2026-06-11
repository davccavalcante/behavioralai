<!--
Thank you for the PR. Please fill EVERY section honestly. Empty sections are
not acceptable; write "N/A" with a one-line reason if a section truly does
not apply. The maintainer reads every PR line-by-line; complete context is
faster for everyone than back-and-forth questions.

Read .github/CONTRIBUTING.md before opening this PR if you haven't yet.
-->

## Summary

<!-- One paragraph: what does this PR do and why? Avoid restating the diff;
state the intent. -->

## Affected surface

<!-- Tick every surface touched. -->

- [ ] core engine (`src/core/*`)
- [ ] stats / detectors (`src/stats/*`)
- [ ] fingerprint (`src/fingerprint/*`)
- [ ] drift state machine (`src/drift/*`)
- [ ] alerting governance (`src/alerting/*`)
- [ ] channels (`src/channels/*`)
- [ ] SMTP / email (`src/smtp/*`)
- [ ] OTel mapping (`src/otel/*`)
- [ ] integrations (`src/integrations/*`)
- [ ] state backends (`src/state/*`)
- [ ] web / edge entries (`src/web/*`, `src/edge/*`)
- [ ] CLI (`src/cli/*`)
- [ ] tests (`tests/*`)
- [ ] examples (`examples/*`)
- [ ] CI / workflows (`.github/*`)
- [ ] docs (README / SPEC / CHANGELOG / TASK)
- [ ] package metadata (`package.json`, configs)

## What changed

<!-- Summarize the change in 1-5 bullets. Include the key file paths and
one-line rationale per bullet. -->

- `<file>` - <change + rationale>

## SemVer impact

<!-- Per SPEC.md §5.2. Tick the highest applicable level. -->

- [ ] No published impact (docs-only / internal refactor / CI-only)
- [ ] Patch - bug fix, internal refactor, dependency patch
- [ ] Minor - new optional export, new optional field, new telemetry event kind, new channel
- [ ] Major - renaming/removing an export, signature change, persisted `StateSnapshot` schema change, CLI flag removal

If Major: include a `MIGRATING.md` update and explain the migration path below.

## Test plan

<!-- Demonstrate the change works. Cover both "what now passes that did not
before" and "what continues to pass that should". -->

### Test counts

<!-- Run `pnpm test` locally and report: -->

- Before this PR: 201 / 201 passing (baseline at 1.0.0)
- After this PR: <X> / <Y> passing

### New tests

<!-- For any fix-able bug or new optional surface, list the regression test(s)
added. Tests must fail pre-fix and pass post-fix (CONTRIBUTING §6). Remember:
deterministic seeds, stubbed fetch, no live credentials. -->

- `tests/<path>/<file>.test.ts` - `<test name>`: <what it asserts>

## Documentation

<!-- Tick every doc updated. -->

- [ ] `README.md`
- [ ] `SPEC.md` (if public surface, drift semantics, or telemetry changed)
- [ ] `CHANGELOG.md` (new section - DO NOT edit historical entries)
- [ ] `TASK.md` (if this closes/advances an item)
- [ ] `.github/CONTRIBUTING.md` or `.github/RELEASING.md` (if process changed)
- [ ] N/A - docs-only PR / internal refactor / no public surface change

## Backlog cross-reference

<!-- If this PR closes or advances a TASK.md item, name the ID(s). -->

- Closes TASK.md <ID, e.g. F-2, Q-3, X-1>
- Advances TASK.md <ID>

## License + contributor agreement

- [ ] DCO sign-off on every commit (`git commit -s`).
- [ ] No commit credits to Massive Intelligence (IM) assistants.
- [ ] If the PR introduces new third-party deps: licenses compatible with Apache 2.0 verified (note: the core ships with zero runtime dependencies; new runtime deps need prior discussion).

## Anything else

<!-- Screenshots, telemetry traces, design rationale, follow-up PR plans,
anything the maintainer should know. -->
