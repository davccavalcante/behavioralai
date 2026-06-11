# Releasing @takk/behavioralai

This document is the runbook for publishing `@takk/behavioralai` to npm and GitHub. The release flow is intentionally **two-step**: a GitHub Release is created and reviewed FIRST, and only then promoted to NPMJS.

The first published cut is `1.0.0`. From there, [SemVer 2.0.0](https://semver.org/spec/v2.0.0.html) applies per the policy in [SPEC.md §5](../SPEC.md#5-stability-promise).

---

## 1. One-time prerequisites (Creator's actions)

These require credentials and cannot be performed from inside this repository.

### 1.1 Provision the npm scope

The npm organization `takk` owns the `@takk/*` scope. Verify locally:

```bash
npm whoami
npm org ls takk
```

### 1.2 Add the `NPM_TOKEN` secret to GitHub

A granular automation token is provisioned on npm:

- Name: `takk-ci` (year-less so the convention survives rotation; track the active issuance date in the npm UI)
- Scope: `@takk`
- Permissions: read and write
- Bypass two-factor authentication: enabled
- Expiration: 90 days from issuance; rotate before expiry

In the GitHub repo settings:

- Settings -> Secrets and variables -> Actions -> New repository secret
- Name: `NPM_TOKEN`
- Value: the token issued at <https://www.npmjs.com/settings/takk/tokens>

Rotation flow when the token expires (or is suspected leaked):

1. Issue a new token on npm with the same name, scope, and permissions.
2. Update the `NPM_TOKEN` GitHub secret with the new value.
3. Re-run any failed publish workflow.
4. Revoke the old token.

### 1.3 Enable branch protection

Settings -> Branches -> Add branch protection rule for `main`:

- Require linear history.
- Require conversation resolution.
- Do not allow force pushes; do not allow deletions.
- (Optional, after first CI run) Require status checks to pass: select `test (Node 20)`, `test (Node 22)`, `test (Node 24)`, `biome`.

### 1.4 Configure topics and metadata

Repo settings -> About -> set topics for organic discoverability:

```
behavioral-observability agent-observability anomaly-detection drift-detection ai-observability llm-observability ai-agents opentelemetry otel monitoring alerting sre hermes-agent mcp multi-agent slack pagerduty typescript edge nodejs
```

And set Website: `https://behavioralai.takk.ag/` (or your preferred canonical URL).

---

## 2. The two-step release flow

The release pipeline is **intentionally non-atomic**, split across two GitHub Actions workflows that the Creator triggers manually:

| Step | Workflow | What it does | Touches NPMJS? |
|---|---|---|---|
| 1 | `release.yml` | Validates package + version + tag absence + CHANGELOG entry. Builds + lints + typechecks + tests + packs (dry-run). Creates git tag `v<version>` and GitHub Release with title `[REVIEW REQUIRED: NOT YET ON NPMJS]`. | **No** |
| 2 | `npm-publish.yml` | Verifies the tag + GitHub Release from Step 1 exist. Verifies monotonic version vs the npm registry. Builds + lints + typechecks + tests + packs (dry-run). Publishes to npm with `--provenance`. Updates the GitHub Release title to `[PUBLISHED ON NPMJS]`. | **Yes** |

The Creator runs Step 1 immediately after a release-worthy change is merged to main; reviews the resulting GitHub Release page (which carries the changelog, the tag, the commit, the pack-smoke result in the workflow logs); and only then runs Step 2 to push the artefact to NPMJS.

**Why the split?** Once a version is on the npm registry, it cannot be unpublished after 72 hours. The two-step flow gives the Creator a reviewable artefact on GitHub before the release becomes permanent on npm.

---

## 3. Routine release flow

### 3.1 Bump and document

```bash
# Example: releasing 1.0.1

# 1. Bump the version
npm version 1.0.1 --no-git-tag-version

# 2. Prepend a new section to CHANGELOG.md with a UTC timestamp
$EDITOR CHANGELOG.md
# Add: ## [1.0.1] - 2026-MM-DDTHH:MM:SSZ
# Use: date -u +%Y-%m-%dT%H:%M:%SZ

# 3. Commit on a branch + open PR (branch protection blocks direct push to main)
git checkout -b chore/release-1.0.1
git add package.json CHANGELOG.md
git commit -s -m "chore: release 1.0.1"
git push -u origin chore/release-1.0.1
gh pr create --fill

# 4. After PR merges to main, fetch main locally (no need to tag manually)
git checkout main && git pull
```

### 3.2 Step 1: create the GitHub Release (no NPMJS yet)

```bash
gh workflow run release.yml \
  -f version=1.0.1 \
  -f confirm=YES-CREATE-GITHUB-RELEASE
```

The workflow validates, builds, tests, packs, then creates the tag `v1.0.1` and a GitHub Release titled `[REVIEW REQUIRED: NOT YET ON NPMJS] @takk/behavioralai@1.0.1`.

Visit <https://github.com/davccavalcante/behavioralai/releases/tag/v1.0.1> and review:

- The changelog body extracted from `CHANGELOG.md`.
- The commit SHA the tag points to.
- The pack-smoke result in the workflow logs.

### 3.3 Step 2: promote to NPMJS

When the GitHub Release looks good:

```bash
gh workflow run npm-publish.yml \
  -f version=1.0.1 \
  -f confirm=I-AM-THE-CREATOR-AND-I-PUBLISH-TO-NPMJS
```

The workflow verifies the Step 1 artefacts exist, validates monotonic version vs the npm registry, builds, tests, packs, then `npm publish --access public --tag <auto-resolved> --provenance`. After publish, the GitHub Release title flips to `[PUBLISHED ON NPMJS] @takk/behavioralai@1.0.1`.

### 3.4 Verify the release

```bash
# Cache may take ~1 min to update; the workflow itself verifies the registry.
npm view @takk/behavioralai versions
npm view @takk/behavioralai dist-tags

# Try installing into a temporary directory
mkdir /tmp/verify && cd /tmp/verify
npm init -y
npm install @takk/behavioralai

# Verify provenance
npm view @takk/behavioralai@1.0.1 --json | jq .dist.attestations
```

### 3.5 Version progression discipline

The Creator's binding rule: no version skipping, no backwards versions, no deprecations without a cycle.

- Initial cut: `1.0.0`.
- Patches: `1.0.1`, `1.0.2`, ...
- Minors: `1.1.0`, `1.2.0`, ...
- Majors: `2.0.0`, only after a full deprecation cycle per [SPEC.md §5.3](../SPEC.md#53-deprecation-policy).

Prereleases use the standard semver qualifiers (`1.0.0-alpha.1`, `1.0.0-beta.1`, `1.0.0-rc.1`) and route to matching dist-tags (`alpha`, `beta`, `rc`) instead of `latest`. The `npm-publish.yml` workflow auto-resolves the dist-tag from the version qualifier when the `dist_tag` input is left blank.

---

## 4. Promoting a prerelease to `latest`

If a release is published under a non-`latest` dist-tag and you later want it to be the default `npm install` target, run:

```bash
npm dist-tag add @takk/behavioralai@1.1.0-rc.1 latest
```

(Requires the same `NPM_TOKEN` and 2FA bypass.)

---

## 5. Emergency: unpublish or deprecate

npm allows `npm unpublish` only within 72 hours of publish AND when no other public package depends on it. Within the window:

```bash
npm unpublish @takk/behavioralai@1.0.1
```

After 72 hours, unpublishing is not permitted. Use `npm deprecate`:

```bash
npm deprecate @takk/behavioralai@1.0.1 "Replaced by 1.0.2 - fixes drift recovery hysteresis."
```

The Creator's discipline is to AVOID this stage: the strict CI + provenance + small surface + the two-step review flow aim to make every published version stable enough to never deprecate. When a deprecation is unavoidable, document it in the next CHANGELOG with a `### Deprecated` section AND ship a non-deprecated alternative in the same release.

---

## 6. Quick reference

| Action | Command |
|---|---|
| Run all tests locally | `pnpm test` |
| Run full verify pipeline | `pnpm verify` |
| Build only | `pnpm build` |
| Pack smoke (no publish) | `pnpm pack --pack-destination /tmp` |
| Manual publish (DO NOT use; let CI do it) | `npm publish --access public --provenance` |
| Step 1, create GitHub Release | `gh workflow run release.yml -f version=<semver> -f confirm=YES-CREATE-GITHUB-RELEASE` |
| Step 2, publish to NPMJS | `gh workflow run npm-publish.yml -f version=<semver> -f confirm=I-AM-THE-CREATOR-AND-I-PUBLISH-TO-NPMJS` |
| Promote a prerelease to latest | `npm dist-tag add @takk/behavioralai@<semver> latest` |
| List versions | `npm view @takk/behavioralai versions` |
| Verify provenance | `npm view @takk/behavioralai@<semver> --json \| jq .dist.attestations` |
| Rotate NPM_TOKEN | Issue new token at <https://www.npmjs.com/settings/takk/tokens>, update GitHub secret, revoke old |

---

## 7. Stability policy

See [SPEC.md §5](../SPEC.md#5-stability-promise) for the binding stability contract: public surface definition, SemVer rules, deprecation cycle, security exception path, prerelease channels, and license/provenance invariants.
