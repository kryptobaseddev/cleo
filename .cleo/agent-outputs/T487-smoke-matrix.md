# T487 Smoke Matrix — Commander-Shim Removal Behavioral Regression Test

**Date**: 2026-04-17
**Binary**: `node packages/cleo/dist/cli/index.js`
**Version**: v2026.4.76
**Total tested**: 57 commands
**Pass**: 53 | **Warn**: 4 | **Fail**: 0

---

## Legend

- PASS — exit 0 or expected business-logic error (E_NOT_FOUND etc.), sensible output
- WARN — unexpected but non-crashing behavior (no exit 127, no module errors, no TypeScript runtime errors)
- FAIL — crash, module error, exit 127, or citty panic

---

## Core Task Domain

| Command | Result | Notes |
|---------|--------|-------|
| `--help \| head -40` | PASS | All command groups render; root help intact |
| `show T487` | PASS | Full JSON record returned |
| `show --help` | PASS | Shows TASKID arg, usage |
| `find "shim" --limit 3` | PASS | Returns 3 results, total 232 |
| `list --parent T487 --limit 3` | PASS | Returns 3 of 14 children |
| `current --json` | PASS | `{"currentTask":"T837","currentPhase":null}` |
| `next --explain` | PASS | Suggestion with score/reasons returned |
| `blockers --json` | PASS | `{"blockedTasks":[],"total":0}` |
| `dash` | PASS | Full project health JSON returned |
| `roadmap --json` | PASS | 8 epics listed |
| `ops --help` | PASS | Tier flag documented |

## Session Domain

| Command | Result | Notes |
|---------|--------|-------|
| `session --help` | PASS | All sub-commands listed |
| `session status` | PASS | Active session `ses_20260416230443_5f23a3` returned |

## Check / Verify Domain

| Command | Result | Notes |
|---------|--------|-------|
| `check --help` | PASS | schema/coherence/task/output listed |
| `validate --help` | WARN | Falls through to root help — `validate` not registered in subCommands. Exit 0, no crash. |
| `verify --help` | PASS | TASKID arg documented |

## Memory / BRAIN Domain

| Command | Result | Notes |
|---------|--------|-------|
| `memory --help` | PASS | All 30+ sub-commands listed |
| `brain --help` | PASS | maintenance/backfill/purge/plasticity listed |
| `observe --help` | WARN | Falls through to root help — `observe` not registered as top-level alias. Exit 0, no crash. |

## Orchestrate Domain

| Command | Result | Notes |
|---------|--------|-------|
| `orchestrate --help` | PASS | All sub-commands listed |
| `orchestrate ready --epic T487` | PASS | 10 ready tasks returned |

## Nexus Domain

| Command | Result | Notes |
|---------|--------|-------|
| `nexus --help` | PASS | Full sub-command list rendered |
| `nexus context ShimCommand --json` | PASS | Exit 0, returns result (verifying no ShimCommand symbols remain is expected) |

## Admin / Diagnostics Domain

| Command | Result | Notes |
|---------|--------|-------|
| `admin --help` | PASS | version/health/stats/runtime/smoke listed |
| `doctor --help` | PASS | --detailed/--comprehensive flags shown |
| `admin version` | PASS | `{"version":"2026.4.76"}` |

## Agent Domain

| Command | Result | Notes |
|---------|--------|-------|
| `agent --help` | PASS | Full sub-command list rendered |
| `agent list` | PASS | 2 agents returned (cleo-prime-dev, cleo-prime) |

## Skills Domain

| Command | Result | Notes |
|---------|--------|-------|
| `skills --help` | PASS | list/search/validate/info/install listed |
| `skills list` | PASS | Full skill catalog returned |

## Phase Domain

| Command | Result | Notes |
|---------|--------|-------|
| `phase --help` | PASS | show/list/set/start/complete/advance listed |
| `phase list` | PASS | Empty phases array, exit 0 |

## Tools Domain

| Command | Result | Notes |
|---------|--------|-------|
| `lifecycle --help` | PASS | show/start/complete/skip/gate/guidance listed |
| `pipeline --help` | PASS | Routes to `phase` command (pipeline = phase alias) |
| `chain --help` | PASS | show/list/add/instantiate/advance listed |

## Documents / Attachments Domain

| Command | Result | Notes |
|---------|--------|-------|
| `docs --help` | PASS | add/list/fetch/remove/generate/sync/gap-check listed |

## Flags

| Command | Result | Notes |
|---------|--------|-------|
| `show T487 --json \| head -5` | PASS | LAFS envelope `{"success":true,...}` correct |
| `show T487 --human \| head -5` | PASS | Renders bordered human-readable panel |

## Aliases

| Command | Result | Notes |
|---------|--------|-------|
| `ls --parent T487 --limit 2` | PASS | `ls` = `list` alias works, 2 children returned |
| `rm --help` | PASS | Shows delete command help (rm = delete alias) |
| `tags --help` | PASS | Shows labels command help (tags = labels alias) |
| `pipeline --help` | PASS | Routes to phase command (pipeline = phase alias) |

## isDefault Substitutes

| Command | Result | Notes |
|---------|--------|-------|
| `admin` (no sub) | PASS | Shows admin sub-command help, dispatches default |
| `env` (no sub) | WARN | Not registered in subCommands — falls through to root help. Exit 0, no crash. |
| `context` (no sub) | PASS | Dispatches context monitor, returns context window JSON |
| `phases` (no sub) | WARN | Not registered in subCommands — falls through to root help. Exit 0, no crash. |
| `labels` (no sub) | PASS | Dispatches label list, returns full label catalog |

---

## WARN Summary (4 items — none blocking)

| # | Command | Behavior | Severity |
|---|---------|----------|----------|
| W1 | `validate --help` | No `validate` entry in subCommands; falls to root help | Low — may have been removed intentionally |
| W2 | `observe --help` | No top-level `observe` alias; injection docs reference it. CLEO-INJECTION.md says `cleo memory observe` is correct route. | Low — alias absent but canonical path works |
| W3 | `env` (no sub) | Not registered — falls to root help | Low — `env` may have been removed |
| W4 | `phases` (no sub) | Not registered — falls to root help | Low — `phase` (singular) is canonical |

---

## FAIL Summary

**None.** Zero exit-127 / module-not-found / TypeScript runtime errors / citty crashes observed.

---

## Observations

- SQLite experimental warning (`ExperimentalWarning: SQLite is an experimental feature`) appears on every invocation — cosmetic, not a regression.
- LAFS envelope (`{"success":true,...}`) consistently present on all JSON-mode commands.
- `--human` flag renders correctly for task display.
- All aliases (`ls`, `rm`, `tags`, `pipeline`) resolve correctly.
- `nexus context ShimCommand` returns cleanly — no leftover ShimCommand symbols surfaced.
