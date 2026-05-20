---
title: Saga T9625 — llmtxt Upstream Issue Tracker
saga: T9625
epic: T9632
task: T9648
filed_against: kryptobaseddev/llmtxt
filed_at: 2026-05-19
---

# Saga T9625 — llmtxt Upstream Issue Tracker

Cross-link tracker for the 9 upstream issues filed against
`kryptobaseddev/llmtxt` capturing gaps discovered during Saga T9625
(W0–W3) while building `cleo docs` on top of the llmtxt SDK.

T9648 ships these issues so they get fixed at the source rather than
re-papered with cleocode-local workarounds. T9649 is the downstream
task that awaits the llmtxt fixes and bumps the `llmtxt` dep version.

## Filed issues (9 total)

| Sev | Title | Issue URL | Status | Cleocode tasks blocked |
| --- | ----- | --------- | ------ | ---------------------- |
| P0  | CLI commands should always emit LAFS envelopes on error, even from argument parsing | https://github.com/kryptobaseddev/llmtxt/issues/6 | open | T9633 (workaround landed via PR #318); T9649 (await SDK guarantee) |
| P1  | Add stable kebab-case `slug` as primary lookup key for stored documents | https://github.com/kryptobaseddev/llmtxt/issues/7 | open | T9712, T9716 (cleo-side slug generator); T9649 |
| P1  | Bake document type taxonomy (spec/adr/research/handoff/note/llm-readme) into the SDK | https://github.com/kryptobaseddev/llmtxt/issues/8 | open | T9710 (cleo classifier); T9649 |
| P1  | Scope `listDocs` by project (not only by owner) | https://github.com/kryptobaseddev/llmtxt/issues/9 | open | T9703 (cleo docs status); T9649 |
| P1  | Add `fetchBySlug(projectId, slug)` to the SDK as ergonomic alternative to opaque attachment ID lookup | https://github.com/kryptobaseddev/llmtxt/issues/10 | open | T9701 (cleo docs publish); T9649 |
| P2  | Ship prebuilt viewer SPA bundle inside the llmtxt npm package | https://github.com/kryptobaseddev/llmtxt/issues/11 | open | T9723 (cleo embedded viewer fallback); T9649 |
| P2  | Extend `rankBySimilarity` with type/project filters for cross-doc search | https://github.com/kryptobaseddev/llmtxt/issues/12 | open | future cleo `docs search`; T9649 |
| P2  | Add SDK-side markdown render pipeline with frontmatter + ToC | https://github.com/kryptobaseddev/llmtxt/issues/13 | open | T9720, T9723 (cleo inline renderer); T9649 |
| P2  | Add opt-in file watcher / auto-sync daemon to the SDK | https://github.com/kryptobaseddev/llmtxt/issues/14 | open | T9702 (cleo docs sync --from); T9649 |

All 9 issues filed under the `from-cleocode` label on 2026-05-19.
Status is refreshed when T9649 polls upstream.

## Cleocode workarounds — file refs

For each gap, the cleocode side currently carries a workaround. Once
the upstream issue lands, the workaround is removed under T9649.

### P0 — Silent failure on `cleo docs publish` (PR #318, commit `3a4f1276d`)

- `packages/cleo/src/cli/index.ts:230` (pre-fix) handed dispatch to
  citty's `runMain`, which catches `CLIError` and prints to stderr —
  never emitting a LAFS envelope on stdout.
- `packages/cleo/src/cli/commands/docs.ts:822` (pre-fix) double-wrapped
  errors by piping `formatError(...)` through `cliOutput`.
- Fix in cleocode: `runMainWithLafsEnvelope` at
  `packages/cleo/src/cli/index.ts:284` maps `CLIError` → LAFS envelope.
- Upstream ask: llmtxt's own CLI surface should not have the same
  citty-swallowed-error vector. If llmtxt ships a CLI (`packages/llmtxt/src/cli/`),
  it MUST emit `{success:false, error, meta}` on every failure path
  including argument-parsing errors.

### P1 — Slug primary key (PRs #336 + commits `ef49e91c1`, `453186f77`)

- `packages/core/src/docs/import/slug.ts:64` — `slugify()` is owned by
  cleocode because llmtxt doesn't expose slug generation or
  fetch-by-slug.
- `packages/core/src/docs/publish-pr.ts:482` — `resolveSlugOrId()`
  worked around the missing API by trying slug → attachment id →
  sha256 in sequence.

### P1 — Type taxonomy (commit `eaabb491d`)

- `packages/core/src/docs/import/scanner.ts` classifies files into
  6 types (spec/adr/research/handoff/note/llm-readme) entirely
  cleocode-side. The taxonomy is generic enough that other llmtxt
  consumers would benefit from a shared enum.

### P1 — List per-project (commit `82a023a34`)

- `packages/core/src/docs/docs-ops.ts` filters by ownerId then
  manually scopes by projectId in-memory. A native `listDocsByProject`
  call would remove an O(n) post-filter.

### P1 — Fetch by slug (commit `141fd1d64`)

- `packages/core/src/docs/publish-pr.ts:500` imports the attachment
  store directly because the llmtxt SDK only exposes `fetch(id)`.

### P2 — Embedded viewer SPA (commit `bb5e799e9`)

- `packages/cleo/assets/viewer/` (index.html + viewer.js + styles.css)
  is owned by cleocode because llmtxt v2026.4.13 does not ship a
  pre-built SPA in `node_modules/llmtxt/dist/viewer/`.

### P2 — Cross-doc search

- `packages/core/src/docs/docs-ops.ts:210` calls
  `rankBySimilarity(query, candidates)` but candidates are
  pre-fetched + pre-filtered by cleocode. A native filter parameter
  would let the SDK push the filter down.

### P2 — Markdown render pipeline (commit `bb5e799e9`)

- `packages/cleo/assets/viewer/viewer.js` ships an inline markdown
  renderer (~150 LoC) because no SDK-side renderer exists.

### P2 — File watcher (commit `d6d9aea1e`)

- `cleo docs sync --from <path>` is cleocode's reverse-ingest
  command. A daemonized opt-in watcher in the SDK would let other
  consumers get the same UX without re-implementing inotify/fsevents
  plumbing.

## Sources

- Saga T9625, Epic T9632 (W4 closeout).
- PR #318 — citty silent-failure root cause.
- PR #336 — slug primary key.
- Commits `141fd1d64`, `82a023a34`, `eaabb491d`, `bb5e799e9`,
  `d6d9aea1e`, `3a4f1276d` (cleocode `task/T9648` branch HEAD baseline).
