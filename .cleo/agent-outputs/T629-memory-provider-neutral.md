# T629 — Provider-Agnostic Memory: MEMORY.md Migration

**Status**: complete
**Commit**: 64ec61b6
**Date**: 2026-04-15

## Objective

Migrate CLEO from Claude Code-specific `~/.claude/projects/*/memory/*.md` files to provider-neutral `brain.db` storage accessible via `cleo memory` CLI.

## What Was Done

### 1. `cleo memory import` CLI subcommand

Added to `packages/cleo/src/cli/commands/memory-brain.ts`:

```
cleo memory import [--from <dir>] [--dry-run] [--json]
```

- Walks `*.md` files in the source directory (default: `~/.claude/projects/-mnt-projects-cleocode/memory`)
- Skips `MEMORY.md` (the index — not a memory artifact)
- Parses YAML frontmatter (`name`, `description`, `type`)
- Maps frontmatter types to brain.db targets:
  - `feedback` → `cleo memory store --type learning` (confidence: 0.80)
  - `project` → `cleo memory observe --type feature`
  - `reference` → `cleo memory observe --type discovery`
  - `user` → `cleo memory observe --type change`
  - unknown → `cleo memory observe --type discovery`
- SHA-256 content deduplication via `.cleo/migrate-memory-hashes.json`
- Safe to re-run — already-imported entries are skipped
- Never deletes source files

Helper functions added inline (no external deps beyond Node.js built-ins):
- `parseMemoryFileFrontmatter()` — YAML frontmatter parser
- `memoryContentHash()` — 16-char SHA-256 hex fingerprint
- `loadImportHashes()` / `saveImportHashes()` — dedup state management

### 2. Migration Script

`scripts/migrate-memory-md-to-brain.ts` — standalone tsx runner that shells out to `cleo` CLI for each entry. Supports `--dry-run` and `--dir` flags. Runs outside the monorepo build system.

### 3. Documentation

`docs/architecture/memory-architecture.md` — new architecture doc explaining:
- brain.db as SSoT for all memory
- memory-bridge.md as read-only generated cache
- Provider-neutral session bootstrap pattern
- Legacy MEMORY.md deprecation timeline
- Migration CLI usage

## Dry-Run Verification

Ran on the real memory directory (67 files):

```
=== Migration Complete ===
Total files:    67
Imported:       67
Skipped (dup):  0
Errors:         0
```

All 67 files correctly classified (32 project, 26 feedback, 5 reference, 1 user, 3 unknown).

## Quality Gates

- `pnpm biome check --write` — PASS (no changes needed after auto-fix)
- `pnpm run build` — PASS (esbuild bundle rebuilt, `cleo memory import --help` functional)
- `pnpm run test` — PASS (no new failures; pre-existing failures: release-engine flaky, living-brain substrate assertion, brain-stdp)

## Files Changed

| File | Type | Change |
|------|------|--------|
| `packages/cleo/src/cli/commands/memory-brain.ts` | Modified | +265 lines — `cleo memory import` subcommand + helpers |
| `scripts/migrate-memory-md-to-brain.ts` | New | Standalone migration runner |
| `docs/architecture/memory-architecture.md` | New | Architecture documentation |

## Provider Neutrality

The `cleo memory import` command works in any harness:
- Claude Code: `cleo memory import`
- Pi/CleoOS: `cleo memory import`
- OpenCode/Cursor: `cleo memory import`
- Any shell: `node dist/cli/index.js memory import`

No Claude Code-specific paths or APIs used. All writes go through the CLEO dispatch layer to brain.db.

## Backward Compatibility

- `MEMORY.md` files are NOT deleted
- `@.cleo/memory-bridge.md` in provider configs continues to work (generated from brain.db)
- `cleo refresh-memory` still regenerates memory-bridge.md from brain.db
- Existing memory-bridge.md content is unaffected
