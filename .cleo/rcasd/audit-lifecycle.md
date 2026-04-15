# CLI Audit: Phase, Lifecycle, Release, Roadmap Domains

**Date**: 2026-04-11
**Auditor**: CLI Full Audit subagent
**Scope**: 24 commands across phase, lifecycle, release, and roadmap domains
**Method**: Every command executed with `--help`, read-only commands executed for real, write commands exercised with safe test data or edge-case inputs

---

## Summary Table

| # | Command | Help OK | Exec OK | Exit Code | Notes |
|---|---------|---------|---------|-----------|-------|
| 1 | `cleo phase show` | PASS | PARTIAL | EXIT 0 on failure | **BUG**: returns exit 0 even when no phase set or slug not found; inner `data.success: false` but outer `success: true` |
| 2 | `cleo phase list` | PASS | PASS | 0 | Returns empty list correctly when no phases defined |
| 3 | `cleo phase set` | PASS | N/A | 4 (E_NOT_FOUND) | Missing arg shows help; `--dryRun` hits E_NOT_FOUND before dry-run logic executes |
| 4 | `cleo phase start` | PASS | N/A | 4 (E_NOT_FOUND) | Operation name is `pipeline.phase.set` (same as phase set — shared handler) |
| 5 | `cleo phase complete` | PASS | N/A | 4 (E_NOT_FOUND) | Operation name is `pipeline.phase.set` (same as phase set — shared handler) |
| 6 | `cleo phase advance` | PASS | FAIL | 1 (E_PHASE_ADVANCE) | Correctly rejects when no current phase set |
| 7 | `cleo phase rename` | PASS | N/A | 1 | Missing args shows help + error |
| 8 | `cleo phase delete` | PASS | N/A | 4 (E_NOT_FOUND) | `--force` flag documented but does not gate lookup failure |
| 9 | `cleo pipeline` (alias) | PASS | — | — | **CONFIRMED**: exact alias for `cleo phase`; help text is byte-for-byte identical |
| 10 | `cleo lifecycle show` | PASS | PASS | 0 | Returns full stage list; `initialized: false` when untouched, `initialized: true` after first write |
| 11 | `cleo lifecycle start` | PASS | PASS | 0 | Transitions to `in_progress`; operation is `pipeline.stage.record` |
| 12 | `cleo lifecycle complete` | PASS | PASS | 0 | Accepts `--artifacts` and `--notes`; records `completed` status |
| 13 | `cleo lifecycle skip` | PASS | PASS | 0 | Requires `--reason`; exits 1 with help if missing |
| 14 | `cleo lifecycle gate` | PASS | PASS | 0 | Returns `canProgress`, `missingPrerequisites`, `issues` |
| 15 | `cleo lifecycle guidance` | PASS | PARTIAL | 0 / 2 | `--epicId` with uninitialized epic returns `E_INVALID_INPUT` (exit 2); `--epicId` with active stage works; no-args returns exit 2 |
| 16 | `cleo lifecycle history` | PASS | PASS | 0 | Returns array; empty when no writes made; only logs completed/skipped (not reset) |
| 17 | `cleo lifecycle reset` | PASS | PASS | 0 | Requires `--reason`; reverts stage to `not_started`; exits 1 with help if `--reason` missing |
| 18 | `cleo lifecycle gate-record pass` | PASS | PASS | 0 | Takes `<epicId> <gateName>`; optional `--agent`, `--notes` |
| 19 | `cleo lifecycle gate-record fail` | PASS | PASS | 0 | Takes `<epicId> <gateName>`; optional `--reason` |
| 20 | `cleo release ship` | PASS | FAIL (dry) | 1 | Dry-run auto-prepares a release record, then fails validation (E_GENERAL: release not found); `--epic` is required; missing flag shows help |
| 21 | `cleo release list` | PASS | PASS | 0 | Lists all releases with version, status, createdAt, taskCount |
| 22 | `cleo release show` | PASS | PASS | 0 | Returns full release with task list and changelog; E_NOT_FOUND (exit 4) for missing version |
| 23 | `cleo release cancel` | PASS | PASS | 0 | Accepts `prepared`/`draft` state only; rejects `rolled_back` with `E_INVALID_STATE` (exit 1) |
| 24 | `cleo release rollback` | PASS | PASS | 0 | Works on `prepared` releases; `--reason` is optional (defaults to "No reason provided") |
| 25 | `cleo release channel` | PASS | PASS | 0 | Returns `branch`, `channel`, `distTag`, `description` |
| 26 | `cleo roadmap` | PASS | PASS | 0 | Returns upcoming epics + summary; `--includeHistory` adds CHANGELOG entries; `--upcomingOnly` filters as expected |

---

## Bugs and Issues

### BUG-1: `cleo phase show` — Double Envelope Wrapping Masks Failures (severity: medium)

**Symptom**: `cleo phase show` exits with code `0` even when the operation fails. The outer envelope reports `success: true` while the inner `data` object contains `success: false` and an error payload.

**Reproduction**:
```
cleo phase show          # no current phase set
cleo phase show bogus    # nonexistent slug
```

**Output (truncated)**:
```json
{"success":true,"data":{"success":false,"error":{"code":"E_PHASE_SHOW_FAILED","message":"No current phase set"}},"meta":{...}}
```

**Expected**: Exit code non-zero; outer envelope `success: false`; proper `error.codeName` in top-level error field.

**Impact**: Any agent or script that checks `success` at the outer envelope level will silently miss phase-not-found errors.

---

### BUG-2: `cleo phase start` and `cleo phase complete` share `pipeline.phase.set` operation name (severity: low)

**Symptom**: Both `cleo phase start <slug>` and `cleo phase complete <slug>` report `"operation":"pipeline.phase.set"` in the meta field, identical to `cleo phase set`. This makes audit logs and provenance chains ambiguous.

**Reproduction**:
```
cleo phase start nonexistent 2>&1
cleo phase complete nonexistent 2>&1
```

**Expected**: Operation names `pipeline.phase.start` and `pipeline.phase.complete` respectively.

---

### BUG-3: `cleo lifecycle guidance --epicId <id>` fails for uninitialized epic (severity: medium)

**Symptom**: Passing `--epicId` when the epic has no active pipeline stage returns `E_INVALID_INPUT` (exit 2) with the message "Either stage or epicId (with an active pipeline stage) is required". The help text implies `--epicId` should resolve the stage automatically, but it requires an _active_ stage.

**Reproduction**:
```
cleo lifecycle guidance --epicId T114   # T114 has no stages initialized
```

**Error**:
```json
{"success":false,"error":{"code":2,"message":"Either stage or epicId (with an active pipeline stage) is required","codeName":"E_INVALID_INPUT"}}
```

**Expected options**:
- Either: Document that `--epicId` only works when the epic has an active stage (help text is currently silent on this).
- Or: Fall back to the epic's `nextStage` when no stage is active, rather than erroring.

---

### BUG-4: `contribution` stage listed in help but not recognized by engine (severity: high)

**Symptom**: Every `cleo lifecycle` subcommand's help text lists `contribution` as a valid stage. However, the engine rejects it at runtime.

**Reproduction**:
```
cleo lifecycle start T091 contribution
cleo lifecycle gate T091 contribution
```

**Error from gate**:
```
Invalid stage: contribution. Valid stages: research, consensus, architecture_decision, specification, decomposition, implementation, validation, testing, release
```

**Error from start**:
```
Unknown stage: contribution
```

**Impact**: Agents following the help text will attempt to start/gate/skip `contribution` and receive confusing runtime failures. This is a documentation-to-implementation mismatch in the help strings for `start`, `complete`, `skip`, `reset`.

**Fix**: Either register `contribution` as a valid stage in the engine, or remove it from all help text.

---

### BUG-5: `cleo release rollback` accepts `prepared` status without guard (severity: medium)

**Symptom**: `cleo release rollback v2026.4.25` succeeded on a release with status `prepared` — a release that was never shipped. Rollback semantics imply a shipped release; rolling back a `prepared` release is a data correctness issue.

**Expected**: Rollback should require `shipped` status. `prepared` releases should only be cancellable via `cleo release cancel`.

**Observed output**:
```json
{"version":"v2026.4.25","previousStatus":"prepared","status":"rolled_back","reason":"No reason provided"}
```

---

### BUG-6: `cleo release ship --dryRun` auto-creates a release record before failing (severity: medium)

**Symptom**: Running `cleo release ship v2026.4.99 --epic T091 --dryRun` wrote `[Step 0/8] Auto-prepare release record... ✓` before failing at gate validation. Even in dry-run mode, a record mutation occurred at step 0.

**Expected**: `--dryRun` should perform zero writes.

---

### ISSUE-7: `cleo lifecycle history` does not log `start` or `reset` events (informational)

After performing `lifecycle start` then `lifecycle reset` then `lifecycle complete` and `lifecycle skip`, the history array only contained the `skipped` event. The `start`, `complete`, and `reset` transitions on the `research` stage were absent.

This may be intentional (history = final state transitions only), but it reduces traceability for agents trying to reconstruct what happened.

---

### ISSUE-8: Stale migration journal warning on many commands (informational)

Multiple commands emitted:
```
{"subsystem":"sqlite","orphaned":1,"msg":"Detected stale migration journal entries from a previous CLEO version. Reconciling."}
```

This appears on `release rollback`, `release show` (slow: 4997ms vs <1ms normally), `phase advance`, and others. The reconciliation adds latency (up to 5 seconds in one observed case). Not a blocker but worth tracking.

---

## Duplicate / Overlap Analysis

### `cleo phase` vs `cleo pipeline`

| Attribute | Finding |
|-----------|---------|
| Alias confirmed | YES — help output is byte-for-byte identical |
| Both work | YES |
| Recommendation | Both names are fine to keep; `pipeline` feels more intuitive for agent prompts that think in terms of delivery pipelines. Document the alias in help output so agents know both work. |

---

### `cleo phase start/complete` vs `cleo lifecycle start/complete`

These operate at fundamentally different scopes but have confusing name overlap:

| Attribute | `cleo phase start/complete` | `cleo lifecycle start/complete` |
|-----------|----------------------------|--------------------------------|
| Scope | Project delivery phases (coarse-grained milestones like "Q1", "Alpha") | RCASD-IVTR per-epic stages (fine-grained: research, spec, impl, etc.) |
| Target | `<slug>` — named project phase | `<epicId> <stage>` — stage within an epic |
| State machine | `pending → active → completed` | `not_started → in_progress → completed / skipped` |
| Confusion risk | HIGH for zero-context agents | HIGH for zero-context agents |

**Recommendation**: Add a one-line distinction comment to each help header. Currently both say "start" and "complete" with no hint that one is global/project-level and the other is per-epic/RCASD. Suggested help text:

- `cleo phase start <slug>` — "Mark a project milestone phase as active (project-wide delivery pipeline)"
- `cleo lifecycle start <epicId> <stage>` — "Begin a stage in an epic's RCASD workflow (per-epic research → release pipeline)"

---

### `cleo lifecycle` vs `cleo phase` — Zero-Context Agent Distinction

A zero-context agent sees:
- `cleo phase` — "Project-level phase lifecycle management"
- `cleo lifecycle` — "RCASD-IVTR+C lifecycle pipeline management"

The term "lifecycle" appears in the description of `cleo phase` ("phase lifecycle management") and is also the top-level name of `cleo lifecycle`. This creates genuine confusion.

**Recommendation**: Rename `cleo phase` description to "Project milestone pipeline management" or "Delivery phase tracking" to avoid the word "lifecycle" appearing in both.

---

### `cleo release ship` vs lifecycle gates

`cleo release ship` runs gate validation as step 1. However, it does not check `cleo lifecycle gate` results — it has its own internal gate logic. These two gate systems are independent:

| Gate system | What it checks |
|-------------|---------------|
| `cleo lifecycle gate <epicId> <stage>` | Per-epic RCASD stage prerequisites |
| `cleo release ship` step 1 validation | Internal release readiness (not RCASD-linked) |

The relationship between RCASD lifecycle completion and release ship eligibility is not enforced. An agent could `cleo release ship` without any lifecycle stages completed.

**Recommendation**: Consider requiring or at least warning if the linked epic has incomplete mandatory lifecycle stages before shipping.

---

## `cleo roadmap` Findings

- Works correctly; returns `success: true` with structured data
- `--includeHistory` adds `releaseHistory` array from CHANGELOG
- `--upcomingOnly` filters to pending/upcoming epics (no behavioral change observed vs default since no completed epics in this project)
- `currentVersion` returns `"unknown"` — may indicate the version file is not configured or not found
- Only 1 upcoming epic (T091) despite 80 total tasks — roadmap only surfaces `type: epic` tasks, which is correct behavior

---

## Exit Code Summary

| Scenario | Expected | Actual | Correct? |
|----------|----------|--------|----------|
| `phase show` (no phase) | non-zero | 0 | NO — BUG-1 |
| `phase show` (bad slug) | non-zero | 0 | NO — BUG-1 |
| `phase start` (bad slug) | non-zero | 4 | YES |
| `phase complete` (bad slug) | non-zero | 4 | YES |
| `phase advance` (no phase) | non-zero | 1 | YES |
| `lifecycle show` (bad ID format) | non-zero | 6 | YES |
| `lifecycle gate` (bad stage) | non-zero | 1 | YES |
| `lifecycle guidance` (no args) | non-zero | 2 | YES |
| `lifecycle skip` (no reason) | non-zero | 1 | YES |
| `lifecycle reset` (no reason) | non-zero | 1 | YES |
| `release show` (not found) | non-zero | 4 | YES |
| `release cancel` (rolled_back state) | non-zero | 1 | YES |
| `release ship` (missing --epic) | non-zero | 1 | YES |
| `release rollback` (prepared state) | non-zero | 0 | NO — BUG-5 |

---

## Verified Working (No Issues)

- `cleo phase list` — correct
- `cleo lifecycle show` — correct
- `cleo lifecycle start` — correct
- `cleo lifecycle complete` (with options) — correct
- `cleo lifecycle skip` (with reason) — correct
- `cleo lifecycle gate` (valid stage) — correct
- `cleo lifecycle guidance` (with stage arg) — correct
- `cleo lifecycle history` — correct
- `cleo lifecycle reset` (with reason) — correct
- `cleo lifecycle gate-record pass` — correct
- `cleo lifecycle gate-record fail` — correct
- `cleo release list` — correct
- `cleo release show` — correct
- `cleo release cancel` (valid state) — correct
- `cleo release channel` — correct
- `cleo roadmap` — correct
- `cleo roadmap --includeHistory` — correct
- `cleo roadmap --upcomingOnly` — correct
- `cleo pipeline` (alias) — confirmed identical to `cleo phase`

---

## Bug Priority Matrix

| Bug | Severity | Impact | Suggested Fix |
|-----|----------|--------|---------------|
| BUG-4: `contribution` in help but rejected by engine | HIGH | Agents will attempt and fail | Register or remove |
| BUG-1: `phase show` exits 0 on failure | MEDIUM | Silent failures in automation | Return non-zero exit; fix outer envelope |
| BUG-3: `lifecycle guidance --epicId` fails for uninitialized epic | MEDIUM | Help text misleads agents | Document constraint or auto-resolve to `nextStage` |
| BUG-5: `release rollback` accepts `prepared` state | MEDIUM | Logical state corruption | Guard: require `shipped` status |
| BUG-6: `release ship --dryRun` writes at step 0 | MEDIUM | Dry-run is not truly dry | Move auto-prepare inside dry-run guard |
| BUG-2: `phase start/complete` share `phase.set` operation name | LOW | Audit log ambiguity | Assign distinct operation names |
| ISSUE-7: history misses start/reset events | INFO | Reduced traceability | Log all transitions or document behavior |
| ISSUE-8: Stale migration journal warnings | INFO | Latency (up to 5s) | One-time reconcile on first run |
