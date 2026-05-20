---
title: Saga T9625 — SG-CLEO-DOCS-CANON Hand-off
saga: T9625
epic: T9632
task: T9649
status: complete
closed: 2026-05-19
---

# Saga T9625: SG-CLEO-DOCS-CANON — Hand-off

**Status**: COMPLETE
**Closed**: 2026-05-19
**Epics**: 7 (all merged — viewer search T9647 carried over as deferred follow-up)
**PRs merged in saga window**: 11 (#318, #327, #330, #333, #336, #340, #341, #342, #343, #344, #345)
**Saga window**: 2026-05-19 11:47 PDT → 2026-05-19 23:56 PDT (~12 hours)

This document is the saga-level closeout for `SG-CLEO-DOCS-CANON` (T9625).
It captures the surface that emerged, the per-epic outcome, cross-links to
the in-flight tracker docs, and the deferred follow-ups that pop out of
the saga but do not block the release.

The companion task tracker is
[`docs/saga-t9625-llmtxt-upstream-tracker.md`](./saga-t9625-llmtxt-upstream-tracker.md)
(T9648) — the 9 upstream issues filed against `kryptobaseddev/llmtxt`.

## What shipped — docs SSoT v1

`cleo docs` is now the canonical surface for project documentation,
replacing the ad-hoc "drop a markdown file under `.cleo/research/`"
pattern. Every command emits a LAFS envelope; data is content-addressed
through the `llmtxt` blob store; the human-facing key is a stable
kebab-case slug.

### CLI surface

| Command | Purpose | Shipped in |
| --- | --- | --- |
| `cleo docs add <ownerId> <file> --type X --slug Y` | Write a doc + slug + type | T9627 / T9636 / T9637 |
| `cleo docs fetch <slug \| att_id \| sha-prefix>` | Read a doc by slug, attachment id, or sha prefix | T9627 |
| `cleo docs list --type X --project` | Discover; type + project-scoped listing | T9627 / T9638 |
| `cleo docs publish --for <ownerId> --to <path>` | Atomic write to a git path (tmp-then-rename) | T9634 / T9701 |
| `cleo docs publish-pr <slug>` | Open or update a PR carrying the doc | T9644 / T9716–T9719 |
| `cleo docs sync --from <path>` | Reverse-ingest a git file into the blob store with provenance | T9634 / T9702 |
| `cleo docs status` | Drift detection — exit 2 on mismatch (CI-friendly) | T9634 / T9703 |
| `cleo docs import <dir>` | Bulk migrate a legacy `.md` tree | T9639 / T9710–T9713 |
| `cleo docs serve` / `open` / `stop` / `viewer-status` | Local viewer SPA + port allocator | T9646 / T9720–T9723 |
| `cleo docs search` (extended in T9647) | Ranked similarity search UI | deferred → T9647 |

### Skills SDK migration (T9629 — PR #340)

- `ct-docs-write`, `ct-docs-review`, `ct-spec-writer`, and
  `ct-adr-recorder` now consume the docs SDK directly.
- Direct-filesystem paths in those skills are marked deprecated with
  migration notes; the SDK path is the recommended surface for new work.

### GitHub Actions integration (T9645 — PR #345)

- `.github/workflows/docs-reingest.yml` — on PR merge, blob versions
  are bumped automatically so the git path and the blob SHA stay in sync.
- `.github/workflows/ci.yml` `docs-drift` job — release-verify gate that
  runs `cleo docs status` and fails the release if a watched path drifts.
- Pre-commit hook for docs SSoT drift detection (T9645 — `d0632d6ec`).

### Atomic round-trip semantics

The contract that emerges from T9634 + T9635 + T9645:

1. `cleo docs add` writes the blob and assigns a slug.
2. `cleo docs publish --to <path>` writes the file atomically (tmp + rename)
   and returns a LAFS envelope with the SHA of what was written.
3. `cleo docs sync --from <path>` is the reverse: ingest the file back into
   the blob store with provenance attached so we can prove origin.
4. `cleo docs status` reports any mismatch between the blob SHA and the
   on-disk file SHA — drift always exits 2 so CI can gate on it.
5. Re-running any of (2), (3), (4) on the same input is idempotent. Bytes
   are content-addressed; running publish twice rewrites no blobs.

## Per-epic summary

| Epic  | Status | PR(s) | Key delivery |
| ----- | ------ | ----- | ------------ |
| T9626 | done | #318, #327, #330 | Fix `cleo docs publish` silent failure (citty `runMain` envelope vector) + ship the publish/sync/status round-trip + RT-* integration tests. |
| T9627 | done | #336 | Human kebab-case slugs as primary lookup key + doc-type taxonomy (`spec` / `adr` / `research` / `handoff` / `note` / `llm-readme`) + project-scoped `list`. |
| T9628 | done | #333, #341 | `cleo docs import` — recursive `.md` scanner + classifier + SHA-dedup + dry-run + audit manifest. Validated end-to-end against 1272 files in the cleocode repo (T9640). |
| T9629 | done | #340 | `ct-docs-write` / `ct-docs-review` / `ct-spec-writer` / `ct-adr-recorder` skills consume the SDK (T9641–T9643). |
| T9630 | done | #342, #345 | `cleo docs publish-pr` opens or updates a PR with the doc body in the description (T9644) + GH Actions re-ingest on merge + release-verify drift gate (T9645). |
| T9631 | done (search deferred) | #343 | `cleo docs serve` / `open` / `stop` / `viewer-status` — local viewer SPA + port allocator + embedded fallback SPA bundle. Search/rank UI carried over to T9647. |
| T9632 | done (this PR closes) | #344, this PR | 9 upstream llmtxt issues filed under `from-cleocode` label (T9648) + saga-level hand-off doc (T9649). |

## Cross-links

- [`docs/saga-t9625-llmtxt-upstream-tracker.md`](./saga-t9625-llmtxt-upstream-tracker.md)
  — T9648, the 9 upstream llmtxt issues with workaround → file refs.
- [`docs/migration/legacy-to-docs.md`](./migration/legacy-to-docs.md)
  — T9640, the migration guide for legacy `.md` trees (with the
  cleocode-repo validation report as the worked example).
- `scripts/docs-import-smoke.mjs` — T9640 CI smoke test for the importer.
- `.github/workflows/docs-reingest.yml` — T9645 PR-merge re-ingest workflow.

## Deferred follow-ups

These pop out of the saga as separate tasks; none of them block the
release tag for the saga itself.

- **T9647** — `cleo docs search` ranked-similarity UI in the viewer.
  Moved out of the saga close because the PR (#346) is in flight at the
  moment T9648 + T9649 close Epic T9632. The viewer SPA already wires
  the search endpoint; the rank-UI panel is what carries over.
- **T9735** — 6 sibling commands inside `packages/cleo/src/cli/commands/docs.ts`
  (`export`, `search`, `merge`, `graph`, `rank`, `versions`) carry the
  same `cliOutput(formatError(...))` double-wrap that T9633 fixed for
  `publish`. Identical one-line pattern fix; held out so the saga PRs
  stay scoped.
- **T9736** — `primary-guard.test.ts` (T9686-D) flakes on macOS shard 1.
  This is pre-existing main breakage exposed by every PR's macOS merge
  candidate during the saga window; not introduced by the docs work.
- **Llmtxt P2 — embedded viewer SPA bundle.** The upstream package does
  not ship a pre-built SPA. We embedded a fallback minimal viewer under
  `packages/cleo/assets/viewer/`. Once
  [`kryptobaseddev/llmtxt#11`](https://github.com/kryptobaseddev/llmtxt/issues/11)
  ships, we delete our copy.
- **`DocsAccessor.listDocs` in-memory `blobIndex`.** During T9640 the
  validator (`val1`) flagged that a second import inflates `importCount`
  because the in-memory `Map` is not rehydrated cross-process. Adjacent
  to T9064; not regressed in the saga but called out for the next
  docs-domain sweep.
- **Upstream llmtxt dep version bump.** When the 9 upstream issues
  ship, T9649's deferred half is to bump the `llmtxt` dep in the
  cleocode workspace and delete the cleocode-side workarounds listed in
  the upstream tracker.

## Saga release plan

The saga ships through the standard 4-verb release pipeline (ADR-065 /
SPEC-T9345). The proposed release is `v2026.5.86` — the immediate next
patch after `v2026.5.85` (the SG-CLEO-SKILLS Sphere B close that landed
the same day as this saga). Use whatever the next available CalVer slot
is at release time.

```bash
# 1. Plan — writes the release envelope, persists a row in `releases`.
cleo release plan v2026.5.86 --epic T9625

# 2. Open — dispatches release-prepare GHA; cuts release/v2026.5.86,
#    commits CHANGELOG + version bump, opens the PR.
cleo release open v2026.5.86 --commit-plan

# 3. Poll PR + CI status.
cleo release pr-status v2026.5.86

# 4. After merge, reconcile backfills the 11 provenance tables.
cleo release reconcile v2026.5.86
```

The tag push triggers the Trusted Publisher npm publish through GH
Actions; local `npm publish` is not the canonical path (it returns
E401 by design — see `feedback_trusted_publisher`).

### CHANGELOG anchor

The CHANGELOG entry for the saga release should anchor on this document.
Suggested intro:

> **Saga T9625 — SG-CLEO-DOCS-CANON close.** Ships `cleo docs` as the
> canonical project-documentation surface — 11 commands across 7 epics.
> See `docs/saga-t9625-handoff.md` for the full saga narrative and
> `docs/saga-t9625-llmtxt-upstream-tracker.md` for the 9 upstream
> llmtxt issues that came out of the dogfood loop.

## Validation gate — dogfood the new surface

After the release ships, the validation gate is that this doc plus the
SG-CLEO-SKILLS Sphere B hand-off doc (`att_4b30bae5…`) MUST round-trip
through the new system:

```bash
cleo docs fetch sg-cleo-docs-canon-handoff   # this doc
cleo docs fetch sg-cleo-skills-sphere-b      # the cross-saga handoff
cleo docs publish-pr sg-cleo-docs-canon-handoff
cleo docs status                              # exit 0 — no drift
```

If any of the four exit non-zero, the saga is not truly closed and a
follow-up issue must be filed against the offending command.

---

Refs: T9649, Epic T9632, Saga T9625. Closes SG-CLEO-DOCS-CANON.
