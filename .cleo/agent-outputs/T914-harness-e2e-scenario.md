# T914 — harness-e2e scenario

**Task**: E2b: scenario — harness-e2e (per-harness CLEO workflow)
**Date**: 2026-04-18
**Status**: complete

## Deliverables

All three files written to `/mnt/projects/cleo-sandbox/scenarios/harness-e2e/`:

### README.md
Documents purpose, pre-conditions, what is tested, pass criteria, harness
mapping table, and artifact file reference.

### run.sh (chmod +x)
- Accepts `--harness <name>` flag (default: `vanilla-node`)
- 7-step workflow: `cleo init` → `cleo add` → `cleo start` → `cleo verify`
  → `cleo complete` → `cleo memory observe` → `cleo self-update --check`
- Each step's exit code recorded to `exit-codes.txt`
- `cleo verify` failure is noted but non-fatal (gate enforcement varies by build)
- `cleo memory observe` gracefully falls back to `MANIFEST.jsonl` if brain.db unavailable
- Exits 0 only when all 5 critical commands succeed

### assertions.sh (chmod +x)
Verifies:
1. All 9 artifact output files present
2. All 7 commands exited 0 (verify noted, not fatal)
3. `.cleo/tasks.db` in db-snapshot.txt
4. Memory persisted (observe output OR MANIFEST.jsonl fallback)
5. `self-update.txt` non-empty (check ran)

## Log
`/mnt/projects/cleo-sandbox/artifacts/T914-harness-e2e-scenario.log`
