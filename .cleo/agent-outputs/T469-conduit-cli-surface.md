# T469 — Conduit CLI Surface (Worker D)

**Status**: PARTIAL — implementation complete, deliverable markdown aborted due to prompt-size limit
**Session**: ses_20260416230443_5f23a3

## What Shipped

- `packages/cleo/src/cli/commands/conduit.ts` (4,779 bytes) — native citty subcommand group
- `packages/cleo/src/cli/commands/__tests__/conduit.test.ts` (9,768 bytes) — test coverage
- `packages/cleo/src/cli/index.ts` — import + subCommands registration at lines 356/359
- `packages/cleo/src/cli/help-renderer.ts` — NATIVE_COMMAND_DESCS + COMMAND_GROUPS at lines 59/146

## Registry Alignment

All 5 operations dispatch to `orchestrate.conduit.*` (per ADR-042), NOT `conduit.*`. This correctly matches the registry surface.

| CLI | Dispatch |
|---|---|
| `cleo conduit status` | `query orchestrate.conduit.status` |
| `cleo conduit peek` | `query orchestrate.conduit.peek` |
| `cleo conduit start` | `mutate orchestrate.conduit.start` |
| `cleo conduit stop` | `mutate orchestrate.conduit.stop` |
| `cleo conduit send` | `mutate orchestrate.conduit.send` |

## Verification Needed

Orchestrator to run:
```bash
pnpm biome ci .
pnpm --filter @cleocode/cleo run build
pnpm --filter @cleocode/cleo run test -- conduit
./packages/cleo/bin/cleo.js conduit --help
```

## T469 closure criteria

- [x] Command file exported
- [x] 5 subcommands present
- [x] Registry dispatch paths correct
- [x] index.ts wired
- [x] help-renderer.ts wired (description + group)
- [x] Test file created
- [ ] Build + test verification (pending orchestrator gate run — deferred until Workers A/B/C index.ts changes settle)
