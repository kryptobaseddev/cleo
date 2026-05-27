# T1939: CAAMP Injection-Chain Dedup

**Status**: complete
**Task**: T1939 (parent: T1929)
**Commit**: 3d4c274d6880af1c0cbe422e322b53fb0bc4e695

## Bug Summary

AGENTS.md accumulated duplicate `<!-- CAAMP:START -->` blocks across sessions.
Each CLEO session wrote a new block pointing to a temp path, while
prior sessions' temp-path blocks were left behind. The CAAMP `inject()`
function already consolidates same-content duplicates but did not have
a standalone dedup utility for blocks with distinct content (different temp paths).

## Changes Made

### `packages/caamp/src/core/instructions/injector.ts`

Added three new exported functions:

- `parseCaampBlocks(fileContent)` — position-aware parser returning `CaampBlock[]`
  with `raw`, `content`, `startIndex`, `endIndex` per block
- `dedupeFile(filePath)` — content-keyed dedup with last-occurrence wins;
  returns `DedupeResult` with `removed`, `kept`, `modified` counts
- `dedupeFiles(filePaths)` — batch variant for multi-file processing

Added exported types: `CaampBlock`, `DedupeResult`

### `packages/caamp/src/index.ts`

Re-exported all three new functions and two new types.

### `packages/caamp/tests/unit/injector-dedup.test.ts` (NEW)

24 new tests covering:
- `parseCaampBlocks()`: empty, single, multiple, position accuracy, T1939 5-block scenario
- `dedupeFile()`: non-existent, no blocks, already-clean, 5 identical, distinct preserved,
  surrounding content preserved, last-wins, idempotency, malformed block safety
- `dedupeFiles()`: multi-file batch, missing files silently skipped
- Combined `inject() + dedupeFile()` scenarios

### `packages/cleo/src/cli/commands/caamp.ts` (NEW)

`cleo caamp dedupe` CLI command:
- `--file <path>` — target specific file (default: `~/.agents/AGENTS.md` + cwd `AGENTS.md`)
- `--dry-run` — preview without writing
- `--json` — JSON output

### `packages/cleo/src/cli/index.ts`

Wired `caampCommand` into the CLI command registry.

## Gate Evidence

- implemented: commit:3d4c274d6 + 5 files
- testsPassed: 1334 passed, 0 failed (caamp test suite)
- qaPassed: biome lint + tsc typecheck (caamp package)
- documented: TSDoc on all exported symbols
- securityPassed: filesystem writes to user-controlled paths only
- cleanupDone: live ~/.agents/AGENTS.md has 1 clean block; CLI added

## Live File Status

`/home/keatonhoskins/.agents/AGENTS.md`: 1 block (already clean before this task ran).
`cleo caamp dedupe --file /home/keatonhoskins/.agents/AGENTS.md` reports `removed: 0`.
