# Docs Command Surface Inventory — T11041

**Saga:** T10516 (SG-DOCS-CLI-SIMPLIFICATION)
**Epic:** T10517 (T10516-A: Docs simple command surface and migration aliases)
**Date:** 2026-05-27

## Summary

The `cleo docs` command surface consists of **26 subcommands** across 8 functional groups, spanning ~3,100 lines of TypeScript across 3 files. Strict flag validation covers only 4 of 26 subcommands (15%). Two legacy verbs (`gap-check`, `sync` drift mode) from T4551/T4545 coexist with modern replacements.

---

## Complete Command Surface

### Core Attachment Management (T797)

| Verb | Description | Args | Strict Flags | File:Line |
|------|-------------|------|:---:|-----------|
| `add` | Attach file or URL to a CLEO entity | `<owner-id> [file] --url --desc --labels --slug --type --title --allow-similar --strict --attached-by` | ✓ | docs.ts:217-524 |
| `list` | List attachments with scope/type/limit/order filters | `--task --session --observation --project --type --limit --orderBy --verbose` | ✗ | docs.ts:537-657 |
| `fetch` | Retrieve attachment metadata + bytes by ID or SHA-256 | `<attachment-ref> --verbose` | ✗ | docs.ts:662-697 |
| `remove` | Remove attachment ref from owner entity | `<attachment-ref> --from <ownerId>` | ✗ | docs.ts:702-737 |

### Document Lifecycle

| Verb | Description | Strict Flags | File:Line |
|------|-------------|:---:|-----------|
| `update` | Update-in-place via slug with versioning audit trail (T10161) | ✓ | docs.ts:1340-1408 |
| `supersede` | Atomically supersede old doc with new via FK pointers (T10162) | ✓ | docs.ts:775-812 |
| `graph` | Traverse provenance graph as DocProvenanceResponse (T10164) | ✗ | docs/graph.ts |

### llmtxt Primitives

| Verb | Description | Strict Flags | File:Line |
|------|-------------|:---:|-----------|
| `search` | Semantic search via rankBySimilarity (T9647) | ✗ | docs.ts:954-1006 |
| `find` | Find docs similar to seed slug via llmtxt/similarity (T10163) | ✓ | docs.ts:1024-1138 |
| `merge` | Merge two attachments via llmtxt/sdk diff (T9648) | ✗ | docs.ts:1145-1211 |
| `rank` | Rank attachments by relevance (T9649) | ✗ | docs.ts:1226-1265 |
| `versions` | List SHA-256 versions per entity (T9650) | ✗ | docs.ts:1415-1454 |
| `generate` | Generate llms.txt-format summary (T947) | ✗ | docs.ts:817-849 |
| `export` | Rich Markdown export of task (T947) | ✗ | docs.ts:864-947 |

### Publishing (git⇄llmtxt, Saga T9625)

| Verb | Description | Strict Flags | File:Line |
|------|-------------|:---:|-----------|
| `publish` | Atomic publish from SSoT to git path (T9633) | ✗ | docs.ts:1461-1510 |
| `publish-pr` | Publish to GitHub PR with frontmatter (T9716-19) | ✗ | docs.ts:1529-1612 |
| `sync` | Bidirectional: reverse-ingest OR legacy drift check (T9702/T4551) | ✗ | docs.ts:1632-1734 |
| `status` | Compare disk files vs SSoT (git⇄llmtxt drift) (T9703) | ✗ | docs.ts:1748-1776 |

### Discovery / Registry (T9788)

| Verb | Description | Strict Flags | File:Line |
|------|-------------|:---:|-----------|
| `schema` | Emit doc-kind taxonomy registry as JSON | ✗ | docs.ts:2007-2057 |
| `list-types` | Human-readable table of doc kinds | ✗ | docs.ts:2069-2128 |

### Legacy (T4551, Epic T4545)

| Verb | Description | Status | File:Line |
|------|-------------|--------|-----------|
| `gap-check` | Validate review-doc knowledge transfer | ⚠ LEGACY — no migration path | docs.ts:1781-1822 |
| `sync` (drift mode) | Compare scripts/ vs COMMANDS-INDEX.json | ⚠ LEGACY — dual-mode: `--from` path is modern (T9702) | docs.ts:1699-1733 |

### Migration

| Verb | Description | File:Line |
|------|-------------|-----------|
| `import` | Recursive .md migration into SSoT (T9639) | docs.ts:1842-1930 |

### Viewer Subcommands (from docs-viewer.ts)

| Verb | Description | Strict Flags | File:Line |
|------|-------------|:---:|-----------|
| `serve` | Run local web viewer (T9646) | ✗ | docs-viewer.ts:131-320 |
| `open` | Open viewer in browser, auto-start server (T9721) | ✗ | docs-viewer.ts:326-427 |
| `stop` | SIGTERM viewer + pidfile cleanup (T9721) | ✗ | docs-viewer.ts:430-508 |
| `viewer-status` | Report viewer pid/port/url/uptime (T9721) | ✗ | docs-viewer.ts:514-569 |

---

## Strict Flag Validation Coverage

Only **4 of 26** subcommands (15%) have strict flag validation via `assertKnownFlags`. The remaining 22 silently absorb unknown flags due to citty 0.2.1's `parseArgs({ strict: false })`.

**With strict validation:** `add`, `update`, `find`, `supersede`

**Without:** `list`, `fetch`, `remove`, `generate`, `export`, `search`, `merge`, `graph`, `rank`, `versions`, `publish`, `publish-pr`, `sync`, `status`, `gap-check`, `import`, `schema`, `list-types`, `serve`, `open`, `stop`, `viewer-status`

**Implementation:** `packages/cleo/src/cli/lib/strict-args.ts` (333 lines)
**Test:** `packages/cleo/src/cli/commands/__tests__/docs-add-strict-args.test.ts`

---

## Legacy Verbs

1. **`gap-check`** — T4551 (Epic T4545). Validates agent-outputs/*.md for missing `## Summary` and `**Task**:` headers. No migration alias. Should be deprecated; functionality folded into a `check` verb.

2. **`sync` (drift mode)** — T4551. When called without `--from`, compares `scripts/*.sh` against `docs/commands/COMMANDS-INDEX.json`. Same verb serves modern reverse-ingest (T9702) with `--from`. Two unrelated features sharing one name.

---

## Proposed Simplifications (8 reductions)

| # | Simplification | Old → New | Savings |
|---|---------------|-----------|---------|
| 1 | Collapse `generate` + `export` | `generate → export --format llms-txt` | -1 verb |
| 2 | Collapse `schema` + `list-types` | `schema → list-types --json` | -1 verb |
| 3 | Collapse `find` + `search` | `find --similar X → search --similar X` | -1 verb |
| 4 | Collapse `publish` + `publish-pr` | `publish-pr X → publish X --pr` | -1 verb |
| 5 | Collapse `rank` into `search` | `rank --for T123 → search --owner T123` | -1 verb |
| 6 | Collapse `versions` into `list` | `versions --for T123 → list --task T123 --versions` | -1 verb |
| 7 | Deprecate `gap-check` | `gap-check → check --gaps` (or remove) | -1 verb |
| 8 | Split `sync` drift to `check --drift` | legacy sync → `check --drift` | -0 verbs, +clarity |

**After simplification:** ~16-18 verbs (down from 26), all with strict flag validation, 8 migration aliases for backward compatibility.

**Post-simplification target surface** (~15-18 commands):

- **Core:** add, list, fetch, remove, update, supersede
- **Discovery:** search (absorbs find, rank), list-types (absorbs schema)
- **Export:** export (absorbs generate), import
- **Publish:** publish (absorbs publish-pr), sync (reverse-ingest only)
- **Check:** check (absorbs gap-check, legacy sync drift), status
- **Graph:** graph (provenance)
- **Versions:** versions (or `list --versions`)
- **Viewer:** serve, open, stop, viewer-status

---

## Test Files

1. `packages/cleo/src/cli/commands/__tests__/docs-add-strict-args.test.ts` (T10359)
2. `packages/cleo/src/cli/commands/__tests__/docs-add-strict-body.test.ts` (T10160)
3. `packages/cleo/src/cli/commands/__tests__/docs-add-similarity.test.ts` (T10361)
4. `packages/cleo/src/cli/commands/__tests__/docs-find-similar.test.ts` (T10163)
5. `packages/cleo/src/cli/commands/__tests__/docs-supersede.test.ts` (T10162)
6. `packages/cleo/src/cli/commands/__tests__/docs-update.test.ts` (T10161)
7. `packages/cleo/src/cli/commands/__tests__/worktree-docs-add.test.ts` (T10389)

---

## Skill References

- **ct-cleo** (`packages/skills/skills/ct-cleo/SKILL.md` line 43): References `cleo docs list-types` for runtime kind discovery and DocKindRegistry usage.
- **AGENTS.md**: References `cleo docs add`, `cleo docs fetch`, `cleo docs list-types`, `cleo docs generate` in the documents section.

---

## Code Structure

| File | Lines | Purpose |
|------|-------|---------|
| `packages/cleo/src/cli/commands/docs.ts` | 2,180 | Main command surface — 22 subcommands |
| `packages/cleo/src/cli/commands/docs-viewer.ts` | 576 | Viewer subcommands (serve/open/stop/viewer-status) |
| `packages/cleo/src/cli/commands/docs/graph.ts` | 129 | Provenance graph traversal |
| `packages/cleo/src/cli/lib/strict-args.ts` | 333 | Strict flag validation utility |
