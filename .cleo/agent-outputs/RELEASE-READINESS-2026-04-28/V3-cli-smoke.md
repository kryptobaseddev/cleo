# V3 Validation Report — CLI Smoke Matrix (18 Dispatch Domains)

**Validator**: T1559
**Date**: 2026-04-28
**HEAD commit at validation start**: e4f9b4d3cc0e234dd5f1d0d8af6c7e05de725025
**Baseline reference**: v2026.4.153 (commit fd0b20b76)

## Verdict

**SHIP**

All 18 dispatch domains respond cleanly. The built-in `cleo admin smoke` confirms 14/14 probes pass (11 domain probes + 3 DB checks). Every domain tested returns a valid ADR-039 JSON envelope `{success, data?, error?, meta, page?}`. No crashes, no E_INVALID_OPERATION errors.

---

## Evidence

| Domain | Commands Tested | Exit | Envelope Valid | Notes |
|--------|----------------|------|----------------|-------|
| admin | `health`, `stats`, `smoke` | 0 | PASS | `status` subcommand does not exist (use `health`); `smoke` passes 14/14 |
| check | `--help`, `canon`, `coherence` | 0 | PASS | Canon: 330 ops, 0 violations; coherence reports 19 data-integrity issues (pre-existing) |
| conduit | `status` | 0 | PASS | `{connected:true, transport:"local"}` |
| diagnostics | `status` | 0 | PASS | Telemetry disabled (expected) |
| docs | `list --task T1559`, `--help` | 0 | PASS | Empty list returns correctly; missing required flag returns exit 6 E_VALIDATION |
| intelligence | `predict --task T1559` | 0 | PASS | riskScore:0.075, confidence:0.813 |
| ivtr | `orchestrate ivtr T1559 --status` | 0 | PASS | `meta.operation: orchestrate.ivtr.status` — ivtr is NOT a top-level CLI command; lives under `orchestrate ivtr` |
| memory | `find "test"`, `llm-status` | 0 | PASS | Find returns 10 results; llm-status shows `resolvedSource:"oauth"` |
| nexus | `status` | 0 | PASS | 13217 nodes, 27091 relations; 303 stale files (index stale — expected, non-blocking) |
| orchestrate | `status`, `pending` | 0 | PASS | 75 epics, 460 tasks, 0 pending HITL approvals |
| pipeline | `--help` (alias: `cleo pipeline` → `phase`) | 0 | PASS | `pipeline` alias resolves to `phase` domain correctly |
| playbook | `list`, `validate ivtr.cantbook` | 0 | PASS | 0 active runs; cantbook validates cleanly |
| release | `list` | 0 | PASS | 8 releases returned; `meta.operation: pipeline.release.list` |
| sentient | `status` | 0 | PASS | Daemon stopped, kill-switch ACTIVE (expected state) |
| session | `status`, `--help` | 0 | PASS | Active session `ses_20260428151143_9bb03f` returned |
| sticky | `list` | 100 | PASS | Exit 100 = `ExitCode.NO_DATA` (≥100 is non-error per `isSuccess()`); 0 stickies in DB |
| tasks | `find "test"`, `show T1559` | 0 | PASS | `find` returns 297 matches; `show` returns full task record |
| tools | `skills list`, `provider detect`, `provider list` | 0 | PASS | 21 skills; `meta.operation: tools.skill.list` / `tools.provider.detect` |

### Alias Resolution

| Alias | Resolves To | Status |
|-------|-------------|--------|
| `cleo pipeline` | `cleo phase` | PASS |
| `cleo done` | `cleo complete` | PASS |
| `cleo ls` | `cleo list` | PASS |
| `cleo tags` | `cleo labels` | PASS |

### ADR-039 Envelope Conformance

Spot-checked 8 representative commands:

| Command | Envelope Keys | meta.operation | PASS |
|---------|--------------|----------------|------|
| `admin health` | `{success,data,meta}` | `admin.health` | PASS |
| `conduit status` | `{success,data,meta}` | `conduit.status` | PASS |
| `memory find` | `{success,data,meta}` | `memory.find` | PASS |
| `release list` | `{success,data,meta,page}` | `pipeline.release.list` | PASS |
| `orchestrate status` | `{success,data,meta}` | `orchestrate.status` | PASS |
| `tasks show` | `{success,data,meta}` | `tasks.show` | PASS |
| `intelligence predict` | `{success,data,meta}` | `intelligence.predict` | PASS |
| `orchestrate ivtr --status` | `{success,data,meta}` | `orchestrate.ivtr.status` | PASS |

All envelopes are well-formed; no unknown top-level keys outside `{success, data, error, meta, page}`.

---

## Findings

### P0 (blocker)
_None._

### P1 (concerning)

- **`cleo ivtr` is not a top-level CLI command** — The scope doc lists `ivtr` as one of 18 dispatch domains, but `cleo ivtr` returns `Unknown command ivtr` (exit 127). The IVTR capability is accessible only via `cleo orchestrate ivtr <taskId>`. The dispatch domain (`packages/cleo/src/dispatch/domains/ivtr.ts`) exists and functions correctly. This is a CLI registration gap, not a functional failure.

- **`cleo tools` and `cleo tasks` are not top-level CLI commands** — Both return `Unknown command`. The `tools` dispatch domain is exposed via `cleo cant`, `cleo provider`, `cleo skills`, and `cleo adapter`. The `tasks` domain is exposed via `cleo find`, `cleo show`, `cleo add`, etc. Functional coverage is complete; top-level namespace is absent.

- **`admin status` does not exist** — `cleo admin status` fails with `Unknown command status` (exit 1). The intended command is `cleo admin health`. The CLEO protocol documentation and CLEO-INJECTION.md do not document `admin status`, so this is a documentation confusion only.

### P2 (note)

- **Nexus index is 303 files stale** — `cleo nexus status` reports `303 stale` files since last index on 2026-04-24. This is expected in a release-readiness window; `npx gitnexus analyze` should be run post-ship.

- **coherence check reports 19 data-integrity warnings** — Pre-existing: done parent tasks with pending children (T948, T1187, T1467, T1505). Not a release blocker; known backlog state.

- **DEP0040 punycode deprecation warning** — All commands emit `[DEP0040] DeprecationWarning: The punycode module is deprecated` to stderr. This is a Node.js platform warning, not a CLEO issue. Non-blocking.

- **signaldock.db not found** — `admin health` reports `warn: signaldock.db not found. Run: cleo init`. Pre-existing; non-blocking for this environment.

---

## Built-In Smoke Result

`cleo admin smoke` — **14/14 PASS** (0 failed, 0 skipped):

- Domain probes (11): admin, tasks, session, memory, pipeline, check, tools, sticky, nexus, orchestrate, adapter — all pass
- DB checks (3): tasks.db, brain.db, migrations — all pass
- Total time: 1,560ms

---

## Recommendations

- **Ship as v2026.4.154**: All 18 dispatch domains are functionally operational. JSON envelope conformance is clean. No crashes, no E_INVALID_OPERATION errors across the matrix.
- **Post-release follow-up**: File a task to add `cleo ivtr` as a top-level CLI alias for `cleo orchestrate ivtr` (P1 gap — dispatch domain exists, CLI registration absent).
- **Post-release follow-up**: File a task to add `cleo tasks` and `cleo tools` as top-level namespace commands (cosmetic; all operations accessible via current aliases).
- **Post-release**: Run `npx gitnexus analyze` to clear 303 stale index entries.
