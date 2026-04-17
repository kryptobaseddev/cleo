# T863 Parent-Run Regression Fix

**Date**: 2026-04-17
**Session**: ses_20260416230443_5f23a3
**Status**: complete

---

## Diagnosis

### Root Cause

Citty's `runCommand` (v0.2.1, `packages/cleo/node_modules/.pnpm/citty@0.2.1/`) unconditionally calls `cmd.run(context)` after routing to a subcommand. Source lines 179-188:

```
if (subCommandName) {
    ...runs subcommand recursively...
}
// THEN ALWAYS falls through:
if (typeof cmd.run === "function") result = await cmd.run(context);
```

T863 introduced `async run({ cmd }) { await showUsage(cmd); }` on all 44 parent commands with `subCommands`. When any subcommand was invoked (e.g., `cleo memory dream --json`), the parent `run` handler fired AFTER the subcommand completed, printing help text to stdout and corrupting the JSON output.

The `rawArgs` in the parent run context contains the FULL arg list passed to the parent — e.g., for `cleo memory dream --json`, `memoryBrainCommand.run()` receives `rawArgs = ['dream', '--json']`. The first non-flag token `dream` is a key in `cmd.subCommands`, proving a subcommand was already routed.

### Why Tests Were Failing

The T682 tests (`packages/core/src/memory/__tests__/brain-stdp-functional.test.ts`) use `execFile('cleo', ...)` to invoke the **installed global binary** (`~/.npm-global/bin/cleo` → `cleo-os/node_modules/@cleocode/cleo/dist/cli/index.js`). Even after fixing the source and rebuilding, the installed binary was stale. Reinstalling `cleo-os` globally was required to propagate the fix.

---

## Fix Pattern

**Old (all 44 files):**
```typescript
async run({ cmd }) {
  await showUsage(cmd);
},
```

**New (all 44 files):**
```typescript
async run({ cmd, rawArgs }) {
  const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
  if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
  await showUsage(cmd);
},
```

Logic: find the first non-flag token in `rawArgs`. If it matches a key in `cmd.subCommands`, a subcommand was already routed — skip help. If no non-flag token exists (bare parent invocation) or the token does not match a subcommand key, show help as intended.

This correctly handles:
- `cleo memory dream --json` → `firstArg='dream'`, `'dream' in subCommands` → return early, no help
- `cleo memory` → `firstArg=undefined` → show help
- `cleo memory --help` → citty intercepts `--help` before `runMain` reaches `run`, never fires

---

## Files Touched

All 44 files under `packages/cleo/src/cli/commands/` that had `subCommands:` + `async run({ cmd }) { await showUsage(cmd); }`:

```
admin.ts, adr.ts, agent.ts, brain.ts, cant.ts, chain.ts, check.ts,
complexity.ts, compliance.ts, conduit.ts, config.ts, consensus.ts,
contribution.ts, decomposition.ts, deps.ts, diagnostics.ts, docs.ts,
gc.ts, history.ts, intelligence.ts, issue.ts, lifecycle.ts,
memory-brain.ts, migrate-claude-mem.ts, nexus.ts, orchestrate.ts,
otel.ts, phase.ts, reason.ts, relates.ts, release.ts, remote.ts,
req.ts, research.ts, restore.ts, sequence.ts, session.ts, snapshot.ts,
sticky.ts, sync.ts, testing.ts, token.ts, transcript.ts, web.ts
```

Change applied with `sed` to ensure consistency across all 44 occurrences.

---

## Build & Reinstall

```bash
pnpm biome ci .             # No errors
pnpm --filter @cleocode/cleo run build    # Clean
pnpm --filter @cleocode/cleo-os run build # Clean
npm install -g /mnt/projects/cleocode/packages/cleo-os  # Propagate to installed binary
```

---

## Test Coverage

### T682 Tests (previously failing, now passing)

- **T682-1**: `cleo memory dream --json` produces valid JSON; `JSON.parse` succeeds
- **T682-2**: `cleo brain plasticity stats --json` produces valid JSON; `JSON.parse` succeeds

### JSON parse validation

```bash
CLEO_DIR=/tmp/test-t863 cleo memory dream --json 2>/dev/null | python3 -c "import json,sys; data=json.load(sys.stdin); print('OK')"
# → OK

CLEO_DIR=/tmp/test-t863 cleo brain plasticity stats --json 2>/dev/null | python3 -c "import json,sys; data=json.load(sys.stdin); print('OK')"
# → OK
```

### Bare-parent help still works

```bash
CLEO_DIR=/tmp/test-t863 cleo memory 2>&1 | grep USAGE
# → USAGE memory store|find|stats|...

CLEO_DIR=/tmp/test-t863 cleo admin 2>&1 | grep USAGE
# → USAGE admin version|health|stats|...

CLEO_DIR=/tmp/test-t863 cleo brain 2>&1 | grep USAGE
# → USAGE brain maintenance|backfill|...
```

### Full test suite

```
Test Files  481 passed (481)
Tests  8601 passed | 10 skipped | 32 todo (8643)
Zero failures. Zero new failures.
```

---

## Evidence Summary

| Check | Result |
|-------|--------|
| biome ci | PASS (0 errors) |
| pnpm build | PASS |
| T682-1 | PASS |
| T682-2 | PASS |
| Full suite (8601 tests) | PASS |
| Bare `cleo memory` shows help | PASS |
| `cleo memory dream --json` clean JSON | PASS |
| `cleo brain plasticity stats --json` clean JSON | PASS |
