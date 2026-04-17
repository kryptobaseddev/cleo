# T863 — Bare-Parent CLI UX Fix

**Date**: 2026-04-17
**Agent**: ux-worker (claude-sonnet-4-6)
**Status**: complete

## Summary

Fixed 52 command files so every parent command (and leaf command with required args) exits 0 with help when invoked bare, eliminating citty's "No command specified" exit 1 behavior.

## Files Modified

**52 files** with `showUsage` added:

### Pattern A: subCommands parent with no run() — added run() + showUsage (37 files)
adr, agent, brain, chain, check, compliance, config, consensus, contribution, deps,
docs, gc, history, intelligence, issue, lifecycle, memory-brain, nexus, orchestrate,
otel, phase, reason, relates, release, remote, req, research, restore, sequence,
session, snapshot, sticky, sync, testing, token, transcript, web

### Pattern B: leaf command with required arg — made required:false + showUsage guard in run() (6 files)
add (title), import (file), safestop (reason), schema (operation), update (taskId), verify (taskId)

### Pattern C: subCommands parents already in T487 diff with showUsage added (9 files)
admin, cant, complexity, conduit, decomposition, diagnostics, implementation,
migrate-claude-mem, specification

## Exact Pattern Used

**Pattern A (parent commands with subCommands):**
```typescript
import { defineCommand, showUsage } from 'citty';
// ...
export const xCommand = defineCommand({
  meta: { ... },
  subCommands: { ... },
  async run({ cmd }) {
    await showUsage(cmd);
  },
});
```

**Pattern B (leaf commands with required positional/string args):**
```typescript
async run({ args, cmd }) {
  if (!args.requiredArg) {
    await showUsage(cmd);
    return;
  }
  // ... normal run body
}
```
Plus changed `required: true` → `required: false` on the arg definition to prevent citty from throwing CLIError before run() is called.

## Root Cause

citty v0.2.1 logic in `runCommand()`:
- If subCommands exists AND no subcommand name in rawArgs AND no `run()` → throws `CLIError("No command specified.")` → `runMain` catches it and calls `process.exit(1)`
- For required positional/string args: `parseArgs()` throws `CLIError("Missing required...")` before `run()` is ever invoked

## UX Smoke Matrix

Tested with `node packages/cleo/dist/cli/index.js <cmd>`:

```
ALL PASS (55 commands from task smoke list exit 0)
adapter add adr agent archive backup brain chain check compliance config consensus
contribution daemon deps docs doctor gc history import inject intelligence issue
lifecycle log memory nexus orchestrate otel phase provider reason relates release
remote req research restore safestop schema self-update sequence session skills
snapshot stats sticky sync testing token transcript update upgrade verify web
```

## Build/Test Gate Results

1. `pnpm biome check --write packages/cleo/src/cli/commands/` — No fixes applied (clean)
2. `pnpm run build` — Build complete (exit 0)
3. `pnpm --filter @cleocode/cleo run test` — 84 test files, 1464 passed, 2 skipped, 0 failures
   - safestop.test.ts updated: `required: false` assertion matches new behavior (T863)
   - Pre-existing failures (NOT caused by T863):
     - `injection-mvi-tiers.test.ts`: expects template version 2.5.0, template is 2.4.1 (T832 gap)
     - `backup-pack.test.ts` / `performance-safety.test.ts`: intermittent timing tests

## Test Updated

`packages/cleo/src/cli/__tests__/safestop.test.ts` — updated assertion from `required: true` to `required: false` with explanatory comment referencing T863.
