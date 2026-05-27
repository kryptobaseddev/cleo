# T1699: W1-A6 — Reconcile NexusWikiResult Duplicate in Contracts

**Task**: T1699  
**Date**: 2026-05-02  
**Branch**: task/T1699  
**Commit**: 54af198655a430934573843de15d86590b60e3f3  

## Summary

Removed duplicate `NexusWikiResult` type definition within `@cleocode/contracts`.

## Root Cause

Two definitions existed:
1. **`packages/contracts/src/nexus-wiki-ops.ts`** (canonical): Rich interface with `success`, `outputDir`, `communityCount`, `fileCount`, `communities`, `error?`, `skippedCommunities?`, `loomEnabled?` — used by `packages/core/src/nexus/wiki-index.ts` and exported from the barrel.
2. **`packages/contracts/src/operations/nexus.ts`** (duplicate stub): `export type NexusWikiResult = unknown` — a placeholder with no structural information.

## Decision

`nexus-wiki-ops.ts` is canonical per domain-specific module ownership (same pattern as T1424 NexusProfileResult dedup). `operations/nexus.ts` is the dispatch surface layer — it should reference types from domain-specific modules, not define its own.

## Changes

**`packages/contracts/src/operations/nexus.ts`** (single file changed, 4 insertions, 2 deletions):
- Added `import type { NexusWikiResult } from '../nexus-wiki-ops.js';` at top (sorted per biome import rules)
- Replaced `export type NexusWikiResult = unknown;` stub with `export type { NexusWikiResult };` re-export
- `NexusOps` union at line 1236 continues to reference `NexusWikiResult` — now resolves to the rich canonical type

**`packages/contracts/src/index.ts`** — no changes needed:
- Already exports `NexusWikiResult` only from `nexus-wiki-ops.ts` (line 445)
- Does not export `NexusWikiResult` from `operations/nexus.ts` (that section only exports `NexusWikiParams`)

**`packages/contracts/src/nexus-wiki-ops.ts`** — no changes needed:
- Already the canonical definition, no modifications required

## Callers Verified

- `packages/core/src/nexus/wiki-index.ts`: imports from `@cleocode/contracts` barrel — unaffected
- `packages/cleo/src/dispatch/domains/__tests__/nexus-code-intel-dispatch.test.ts`: uses string mention only, no type import — unaffected

## Quality Gates

- biome CI: clean (90 files in contracts/src checked, no errors)
- tsc: clean (--noEmit, no new errors)
- 148/148 tests passed (T1699-test.json)
- build: `pnpm --filter @cleocode/contracts run build` succeeds

## Evidence

- Commit: `54af198655a430934573843de15d86590b60e3f3` on `task/T1699`
- Test run: `/tmp/T1699-test.json` (148 pass, 0 fail)
- QA: biome exit 0, tsc exit 0
