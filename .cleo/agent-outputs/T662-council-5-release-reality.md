# Council Lead 5 — Release & npm Reality Check

**Date**: 2026-04-15
**Auditor**: Independent Lead 5 (Release & npm Reality)
**Parent Epic**: T662

---

## v2026.4.58 Tag State

| Location | State | Detail |
|----------|-------|--------|
| Local git tag | YES | `v2026.4.58` present on commit `384443b0` |
| GitHub tag | YES | `5129af81` on `refs/tags/v2026.4.58` |
| GitHub Release page | YES | Published 2026-04-15T16:53:17Z, assets: `cleocode-2026.4.58.tar.gz`, `cleoos-2026.4.58.tar.gz`, `SHA256SUMS` |
| npm `@cleocode/cleo@2026.4.58` | YES | `npm view @cleocode/cleo version` returns `2026.4.58` |
| npm `@cleocode/cleo-os@2026.4.58` | YES | Published successfully |
| Tag on HEAD | YES | `git rev-parse HEAD` == `git rev-parse v2026.4.58^{}` == `384443b0` |

---

## CI/Release Workflow

- **Run ID**: 24467041649
- **Status**: `completed / success` (overall job "Build & Publish" succeeded in 2m9s)
- **Triggered**: 2026-04-15T16:52:24Z via tag push

### Steps that WARN (non-blocking)

The cleo-os build step contains:
```
tsc && tsc -p tsconfig.extensions.json || true
```
The `|| true` makes TS errors in `extensions/cleo-cant-bridge.ts` non-fatal. Five TS2339 errors were emitted during the cleo-os tarball build:

```
extensions/cleo-cant-bridge.ts(915,25): error TS2339: Property 'currentTask' does not exist
extensions/cleo-cant-bridge.ts(918,...): error TS2339: Property 'currentTask' does not exist (x3)
extensions/cleo-cant-bridge.ts(920,25): error TS2339: Property 'handoff' does not exist
```

These errors appear in the GitHub Actions annotation panel as `X` markers, making the run look broken at a glance. The job itself completed green. **This is a known, pre-existing type drift in the cleo-cant-bridge.ts template.** It is shipped into the npm tarball in an error state and suppressed with `|| true`. No separate ticket was filed.

### Packages Successfully Published

All 13 published packages confirmed `OK: @cleocode/<pkg>@2026.4.58 published`:
- `@cleocode/contracts`, `@cleocode/lafs`, `@cleocode/core`, `@cleocode/caamp`, `@cleocode/cant`, `@cleocode/nexus`, `@cleocode/runtime`, `@cleocode/adapters`, `@cleocode/agents`, `@cleocode/skills`, `@cleocode/cleo`, `@cleocode/cleo-os`

---

## Diff vs v2026.4.57

`git diff v2026.4.57..v2026.4.58 --stat` shows **17 files changed, 213 insertions(+), 28 deletions(-)**.

| File | Change |
|------|--------|
| `CHANGELOG.md` | +151 lines (the entire v2026.4.58 entry) |
| `packages/*/package.json` (14 packages) | 1 line each (version bump only) |
| `packages/studio/src/lib/components/LivingBrainGraph.svelte` | +40/-6 (edge color map fix) |
| `packages/studio/src/routes/brain/+page.server.ts` | +10/-1 (full-graph default) |
| `packages/studio/src/routes/brain/+page.svelte` | +14/-21 (remove "Full graph" button) |

**That is the entire real delta in this release: 3 studio files and version bumps.**

---

## CHANGELOG Accuracy — MAJOR DISCREPANCY

The v2026.4.58 CHANGELOG entry is **151 lines** and claims delivery of:

> T651 follow-up, T657, T655+T656, T646, T650, T649, T647, T644, T643, T651, T635, T645, T634

However, `git diff v2026.4.57..v2026.4.58 --stat` shows only 3 substantive files changed.

**Cross-checking with v2026.4.57:**

The v2026.4.57 CHANGELOG entry (lines 158-237) already claims delivery of:
- T645, T643, T646, T647/T648, T649, T634

**v2026.4.58 re-claims all of these same tasks** — T643, T645, T646, T647, T649, T634 — with expanded descriptions, as though they are new in this release.

**What actually shipped in v2026.4.58 (from the diff):**
1. `LivingBrainGraph.svelte` — edge EDGE_COLOR map expanded to cover all 25 API edge types (the T651 follow-up)
2. `/brain` page now loads full graph (5000-node cap) on first paint without a button click

**Everything else in the v2026.4.58 CHANGELOG was first claimed in v2026.4.57** or earlier. The pattern is consistent with a release commit that copies prior session work into the CHANGELOG rather than accurately scoping to the incremental delta.

---

## User's Installed cleo vs npm

The user's `cleo` resolves to:
```
/home/keatonhoskins/.npm-global/lib/node_modules/@cleocode/cleo-os/node_modules/@cleocode/cleo/
```

**Installed versions:**
- `@cleocode/cleo` inside `@cleocode/cleo-os`: **v2026.4.56** (two versions behind)
- `@cleocode/cleo-os` global: **v2026.4.56**
- npm latest for both: **v2026.4.58**

**To get the new commands, the user must run:**
```bash
npm update -g @cleocode/cleo-os
```

Until that is done, `cleo nexus projects clean` and `cleo nexus projects scan` are NOT available in the user's live CLI.

---

## New Commands Verification (T655/T656)

`cleo nexus projects clean` and `cleo nexus projects scan` exist in:
- Source: `packages/cleo/src/cli/commands/nexus.ts` — confirmed with operation strings `nexus.projects.clean` and `nexus.projects.scan`
- Published npm tarball `@cleocode/cleo@2026.4.58`: **CONFIRMED** — 11 occurrences of `projects.scan` / `projects.clean` operation strings in `dist/cli/index.js`

The commands shipped correctly in `@cleocode/cleo@2026.4.58`. The user's installed CLI simply has not been updated.

---

## Studio Package Distribution

- `packages/studio/package.json` has `"private": true`
- `npm view @cleocode/studio version` returns **404 Not Found**
- Studio is **never published to npm** — dev-only, not distributed
- Studio is not bundled inside `@cleocode/cleo` (21 files in cleo tarball, no studio content)
- Studio is deployed as a standalone SvelteKit server the user runs locally (`pnpm dev` or built node server)

---

## Build Artifacts Tracked in Git

**382 files under `packages/studio/.svelte-kit/` are tracked in git.** These are SvelteKit build output files (compiled JS, CSS, manifest). Examples:

```
packages/studio/.svelte-kit/adapter-node/.vite/manifest.json
packages/studio/.svelte-kit/adapter-node/_app/immutable/assets/NexusGraph.eS4eJg0E.css
packages/studio/.svelte-kit/adapter-node/chunks/NexusGraph.js
... (382 total)
```

**Root cause**: `packages/studio/` has NO `.gitignore` file. The SvelteKit `.svelte-kit/` directory is being tracked because nothing blocks it.

**Impact**:
- Every studio build commits 382+ generated files
- Git history is polluted with compiled output
- Cross-machine builds may create conflicts on hash-named assets
- The tarball for `cleocode-2026.4.58.tar.gz` (GitHub Release asset) may include build output

**This is a hygiene defect. `packages/studio/.gitignore` needs to be created immediately.**

---

## Node.js 20 Actions Deprecation Warning

The release workflow uses `actions/checkout@v4`, `actions/setup-node@v4`, `pnpm/action-setup@v4` — all running on Node.js 20, which is deprecated for GitHub Actions. These will break when Node.js 24 becomes the default on **June 2, 2026**. Not blocking today, but a 7-week countdown.

---

## Release Hygiene Findings

1. **npm publish: SUCCEEDED** — all 12 packages at v2026.4.58 are live on npm. No publish failures.

2. **User's CLI is 2 versions stale** — installed v2026.4.56, npm has v2026.4.58. New commands `nexus projects clean/scan` are NOT in the user's live `cleo` binary until `npm update -g @cleocode/cleo-os` is run.

3. **CHANGELOG inflation** — v2026.4.58 CHANGELOG entry claims ~15 distinct features/fixes covering T634, T635, T643, T644, T645, T646, T647, T649, T650, T651, T655, T656, T657. The actual git delta between v2026.4.57 and v2026.4.58 is 3 studio files. Most of these tasks were already claimed in v2026.4.57. The CHANGELOG cannot be trusted as a reliable record of what shipped in which specific release.

4. **382 SvelteKit build artifacts tracked in git** — `packages/studio/` is missing a `.gitignore`. Every build commit inflates git history with hash-named compiled assets. This is a concrete defect, not cosmetic.

5. **cleo-cant-bridge.ts TypeScript errors suppressed in CI** — 5 TS2339 errors in `extensions/cleo-cant-bridge.ts` are silenced with `|| true` in the cleo-os build step. The errors appear in the GitHub Actions annotation panel as X markers, making the run look partially broken. The template file ships broken TypeScript. No ticket tracks this.

6. **Tag freshness: CLEAN** — v2026.4.58 tag and HEAD both point to `384443b0`. No drift.

7. **Node.js 20 action deprecation** — 3 GitHub Actions runners will break when Node.js 24 becomes default on 2026-06-02 (~7 weeks). Requires action version updates.

---

## Summary Verdict

| Claim | Reality |
|-------|---------|
| v2026.4.58 tagged and pushed | TRUE |
| CI passed | TRUE (with suppressed TS warnings) |
| npm publish succeeded | TRUE — all 12 packages live |
| New hygiene CLI commands in npm | TRUE — in `@cleocode/cleo@2026.4.58` |
| New commands in user's live CLI | FALSE — installed v2026.4.56, needs `npm update -g` |
| Studio published to npm | FALSE — `private: true`, dev-only |
| CHANGELOG accurately scopes v2026.4.58 | FALSE — claims ~15 features; only 3 files changed |
| Build artifacts out of git | FALSE — 382 .svelte-kit files tracked |
