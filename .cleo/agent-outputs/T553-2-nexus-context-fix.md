# T553-2: nexus context/impact --json Fix

**Date**: 2026-04-13
**Status**: complete
**Task**: T553

## Summary

Fixed `cleo nexus context <symbol>` and `cleo nexus impact <symbol>` silently ignoring `--json` flag, causing them to always output human-readable text even when JSON output was requested.

---

## Root Cause

**File**: `packages/cleo/src/cli/index.ts`, function `shimToCitty`

The CLI uses citty as the argument parser, with a Commander-compatible shim layer that translates shim command definitions into citty command definitions. When a string-type option has `parseFn=parseInt` and a numeric `defaultValue` (e.g. `--limit <n>` with default `20`), the shim stored the number `20` as citty's arg default.

Passing a numeric default for a `type: 'string'` arg causes citty's internal parser to malfunction. Instead of parsing remaining argv tokens as named flags (e.g. `--json`), citty lumped them into the raw `_` array. The result: `args['json']` was `undefined` even when `--json` was present on the command line.

The bug only manifested on commands with **both**:
1. A required positional arg (`<symbol>`) 
2. An option with `parseFn + numeric defaultValue`

Commands with only optional positional args (e.g. `clusters [path]`) were unaffected because citty handles those differently.

### Affected commands

| Command | Broken option |
|---------|--------------|
| `nexus context <symbol>` | `--limit <n>` (default 20) |
| `nexus impact <symbol>` | `--depth <n>` (default 3) |
| `nexus discover <query>` | `--limit <n>` (default 10) |
| `nexus search <pattern>` | `--limit <n>` (default 20) |

---

## Fix

**Commit**: `b9835914 fix(cli): convert numeric shim defaults to strings for citty compatibility`

In `shimToCitty`, convert numeric `defaultValue` to string before assigning as the citty arg default:

```typescript
// Before
if (opt.defaultValue !== undefined) {
  (argDef as Record<string, unknown>).default = opt.defaultValue;
}

// After  
if (opt.defaultValue !== undefined) {
  // Citty requires that string-type arg defaults are actual strings.
  const defaultVal =
    opt.takesValue && typeof opt.defaultValue === 'number'
      ? String(opt.defaultValue)
      : opt.defaultValue;
  (argDef as Record<string, unknown>).default = defaultVal;
}
```

The `parseFn` still runs at invocation time (condition `opt.parseFn && typeof val === 'string'`), so `opts['limit']` correctly receives a number (e.g. `20` from `parseInt('20')`).

---

## Verification

### Before fix
```
$ cleo nexus context "observeBrain" --json
[nexus] Context for symbol 'observeBrain' (3 matches):   # plain text, not JSON
```

### After fix
```
$ cleo nexus context "observeBrain" --json
{
  "success": true,
  "data": {
    "query": "observeBrain",
    "matchCount": 3,
    "results": [...]
  }
}

$ cleo nexus impact "observeBrain" --json
{
  "success": true,
  "data": {
    "riskLevel": "NONE",
    "totalImpactedNodes": 0,
    ...
  }
}
```

### Quality gates
- `pnpm biome check --write`: no fixes needed
- `pnpm run build`: success
- `pnpm run test`: 396 files, 7130 tests pass, 0 new failures

---

## Context: What was NOT broken

The `context` and `impact` commands correctly accepted symbol names (not task IDs) in the installed binary. The error in the T553 fresh-agent-test report (`"Invalid query syntax: observeBrain. Expected: T001..."`) was from an older build that predated the `nexus context` command entirely. The installed binary at time of writing has both commands wired correctly to the code intelligence graph — only the `--json` flag was broken.

---

## Files Changed

- `packages/cleo/src/cli/index.ts` — shimToCitty default value fix
