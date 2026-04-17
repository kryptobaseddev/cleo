# T862 — Deprecated CLI Command Cleanup

## Files Deleted (8)

- `packages/cleo/src/cli/commands/env.ts`
- `packages/cleo/src/cli/commands/phases.ts`
- `packages/cleo/src/cli/commands/observe.ts`
- `packages/cleo/src/cli/commands/validate.ts`
- `packages/cleo/src/cli/commands/agents.ts`
- `packages/cleo/src/cli/commands/implementation.ts`
- `packages/cleo/src/cli/commands/commands.ts`
- `packages/cleo/src/cli/commands/specification.ts`

## References Removed

### `packages/cleo/src/cli/__tests__/startup-migration.test.ts` (6 vi.mock lines removed)
- `../commands/commands.js`
- `../commands/env.js`
- `../commands/implementation.js`
- `../commands/observe.js`
- `../commands/phases.js`
- `../commands/specification.js`
- `../commands/validate.js` (already removed in prior edit — confirmed absent)

### `packages/cleo/src/cli/__tests__/commands.test.ts` (deleted entirely)
- Test file that directly imported the deleted `commands.ts`; removed rather than orphaned.

### `packages/cleo/src/cli/help-renderer.ts` (5 command entries removed from COMMAND_GROUPS)
- `phases` removed from Phases & Lifecycle group
- `validate` removed from Validation & Compliance group
- `implementation` removed from Validation & Compliance group
- `specification` removed from Validation & Compliance group
- `env` and `commands` removed from System & Admin group

### `packages/cleo/src/cli/commands/reason.ts`
- Removed 3-line `DEPRECATED (removed)` comment block from TSDoc header.

### `packages/cleo/src/cli/index.ts`
- Confirmed: zero imports of any of the 8 deleted files were present. No changes needed.

## Gate Results

| Gate | Result |
|------|--------|
| All 8 files absent | PASS — `ALL_DELETED` |
| `grep DEPRECATED\|@deprecated packages/cleo/src/cli` | PASS — empty |
| `pnpm biome check --write packages/cleo/src/cli/` | PASS — 149 files, no fixes |
| `pnpm --filter @cleocode/cleo run build` | PRE-EXISTING FAIL — `ivtr.ts(357,48)` and `tools-engine.ts(681)` type errors unrelated to T862; confirmed broken on clean HEAD before changes |
| `pnpm --filter @cleocode/cleo run test` | PASS — 84 files, 1460 passed, 2 skipped, 0 failures |
| Root help renders | N/A — dist stale due to pre-existing build failure |
| `cleo env` unknown command | N/A — dist stale due to pre-existing build failure |
