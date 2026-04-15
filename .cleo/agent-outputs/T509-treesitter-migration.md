# T509 — tree-sitter Migration: CLI Subprocess to Native Node Bindings

**Date**: 2026-04-11
**Status**: complete
**Author**: Team Lead (claude-sonnet-4-6)

---

## Summary

Replaced the tree-sitter CLI subprocess approach in `packages/core` with the
native tree-sitter Node.js module. Users no longer need to install
`tree-sitter-cli` separately after `npm install -g @cleocode/cleo` — the
native module and all language grammars ship as bundled regular dependencies.

---

## Root Cause

`cleo code outline/search/unfold` was failing with exit code 7 because the
implementation in `packages/core/src/code/parser.ts` spawned the `tree-sitter`
CLI binary, resolved its path from `node_modules/.bin`, and parsed JSON output
from that subprocess. After a global `npm install -g @cleocode/cleo`, the binary
was not on PATH. The grammars were `optionalDependencies` so npm could skip
them silently.

---

## Changes Made

### 1. `packages/core/package.json`

- Removed `optionalDependencies` block entirely (removed `tree-sitter-cli` and all language grammars)
- Added to regular `dependencies`:
  - `tree-sitter@^0.22.1` — the native Node binding (uses prebuilds, no compilation required)
  - `tree-sitter-c@^0.23.2`
  - `tree-sitter-cpp@^0.23.4`
  - `tree-sitter-go@^0.23.0`
  - `tree-sitter-java@^0.23.5`
  - `tree-sitter-javascript@^0.23.0`
  - `tree-sitter-python@^0.23.4`
  - `tree-sitter-ruby@^0.23.1`
  - `tree-sitter-rust@^0.23.1`
  - `tree-sitter-typescript@^0.23.2`

### 2. `package.json` (monorepo root)

- Added all tree-sitter packages to `pnpm.onlyBuiltDependencies` so pnpm
  runs their install scripts (needed to select the correct prebuild binary
  via `node-gyp-build` at runtime)

### 3. `packages/core/src/code/parser.ts` — complete rewrite

Old approach:
- `resolveTreeSitterBin()` searched `node_modules/.bin` for the CLI binary
- `mkdtempSync` + `writeFileSync` wrote S-expression patterns to temp files
- `execFileSync` spawned `tree-sitter query <queryFile> <sourceFile>`
- Regex-parsed text output to extract symbol positions

New approach (native bindings):
- `isTreeSitterAvailable()` — probes the `tree-sitter` native module via
  `createRequire`, caches result. No subprocess or filesystem I/O.
- `getParser()` — lazy singleton `Parser` instance, reused across all parses
- `loadGrammar(langKey)` — loads grammar packages via `createRequire` with
  a `GRAMMAR_SPECS` map; handles `tree-sitter-typescript`'s `{ typescript, tsx }`
  export shape. Cached in `_grammarCache`.
- `getQuery(grammar, langKey, pattern)` — compiles `Parser.Query` from the
  S-expression pattern string (the exact same patterns as before). Cached in
  `_queryCache` to avoid recompilation.
- `captureToSymbols(captures, ...)` — converts `QueryCapture[]` from
  `query.captures(rootNode)` into `CodeSymbol[]`. Capture ordering:
  `definition.*` (enclosing node) precedes `name` (identifier node).
- `parseFile` and `batchParse` public API signatures unchanged.

### 4. `packages/core/src/lib/tree-sitter-languages.ts`

- Updated module-level TSDoc to reflect native bindings (removed CLI references)
- Updated `grammarPackage()` TSDoc to note it returns the npm package name
  that `parser.ts` loads via `createRequire`
- No functional changes — `detectLanguage()` and extension mapping unchanged

### 5. `packages/core/src/system/dependencies.ts`

- Updated `tree-sitter` `DependencySpec`: description and `installCommand`
  changed from `npm install -g tree-sitter-cli` to `pnpm install`
- Rewrote `checkTreeSitter()`: no longer calls `which('tree-sitter')` or
  `tryExec('tree-sitter', ['--version'])`; instead delegates to
  `isTreeSitterAvailable()` from parser.ts and reads the installed package
  version from `tree-sitter/package.json`

---

## Verification

### Quality gates all passed

```
pnpm biome check --write .     # Fixed 1 file (import ordering in parser.ts)
pnpm run build                  # Build complete — no errors
pnpm run test                   # 390 passed | 1 skipped (7018 tests), 0 failures
```

### End-to-end smoke test

```
isTreeSitterAvailable() → true
parseFile('./src/code/parser.ts') → 64 symbols, 0 errors
batchParse(5 files) → 142 total symbols, 0 skipped, 0 errors
smartOutline(parser.ts) → 64 symbols, ~1447 tokens, 0 errors
smartUnfold(parser.ts, 'parseFile') → found, lines 413-502, 0 errors
smartSearch('parseFile', ...) → exact match, score 10
```

---

## Architecture Notes

- The `tree-sitter` native module ships with prebuilds for
  `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `win32-x64`,
  `win32-arm64`. No compilation from source is required on any supported
  platform — `node-gyp-build` selects the right prebuild at runtime.
- All language grammar packages also ship with platform-specific prebuilds.
- The singleton `Parser` instance is reused across all calls; `setLanguage()`
  is called before each parse. This matches the GitNexus reference pattern.
- Query objects are compiled once per language key and cached — repeated
  parses of the same language incur no recompilation cost.
- The public API (`parseFile`, `batchParse`, `smartOutline`, `smartSearch`,
  `smartUnfold`) is unchanged. Only internals changed.

---

## Files Modified

| File | Change |
|------|--------|
| `packages/core/package.json` | Moved tree-sitter pkgs from optionalDeps to deps; removed cli; updated version to ^0.22.1 |
| `package.json` (root) | Added tree-sitter packages to `onlyBuiltDependencies` |
| `packages/core/src/code/parser.ts` | Complete rewrite — native bindings replace CLI subprocess |
| `packages/core/src/lib/tree-sitter-languages.ts` | TSDoc updates only |
| `packages/core/src/system/dependencies.ts` | Updated tree-sitter check to probe native module |
