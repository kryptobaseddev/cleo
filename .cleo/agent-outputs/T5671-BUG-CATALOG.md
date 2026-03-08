# T5671 Complete Bug Catalog

**Date**: 2026-03-08
**Task**: T5671 Phase 2 - Gauntlet Bug Research
**Total Bugs Found**: 17 (4 P1, 7 P2, 6 P3/LOW)

---

## P1 (Broken Functionality) - 4 Bugs

### TASKS-1: `relates discover/suggest` routes to removed operation

| Field | Value |
|-------|-------|
| **Domain** | Tasks |
| **Severity** | P1 |
| **File** | `src/cli/commands/relates.ts` |
| **Issue** | CLI subcommands `relates discover` and `relates suggest` dispatch to `tasks.relates.find` which was merged/removed. Operation no longer exists in registry. |
| **Reproduction** | `cleo relates discover T001` → `{"success":false,"error":{"code":2,"message":"Unknown operation: query:tasks.relates.find"}}` |
| **Root Cause** | Operation merge during Constitution consolidation; CLI not updated |
| **Fix** | Update CLI to call `tasks.relates` with `mode: "discover"` or `mode: "suggest"` parameter instead of `tasks.relates.find` |
| **Complexity** | Small |

### TASKS-2: `restore task` routes to removed operation

| Field | Value |
|-------|-------|
| **Domain** | Tasks |
| **Severity** | P1 |
| **File** | `src/cli/commands/restore.ts` |
| **Issue** | CLI command `restore task` dispatches to `tasks.reopen` which was merged into `tasks.restore`. Operation no longer exists. |
| **Reproduction** | `cleo complete T002 && cleo restore task T002` → `{"success":false,"error":{"code":"E_INTERNAL_GENERAL_ERROR","message":"Unknown operation: mutate:tasks.reopen"}}` |
| **Root Cause** | Operation merge during Constitution consolidation; CLI not updated |
| **Fix** | Update CLI to call `tasks.restore` with `from: "done"` parameter instead of `tasks.reopen` |
| **Complexity** | Small |

### SESSION-B2: `session list --status` validates against wrong enum

| Field | Value |
|-------|-------|
| **Domain** | Session |
| **Severity** | P1 |
| **File** | `src/dispatch/domains/session.ts` or `src/validation/` layer |
| **Issue** | `session list --status ended` rejects with "Invalid status: ended. Allowed values: pending, active, blocked, done...". Validation uses task status enum instead of session status enum (active/ended/orphaned). |
| **Reproduction** | `cleo session list --status ended` → validation error with task statuses |
| **Root Cause** | Wrong enum in validation layer; mixing task and session status types |
| **Fix** | Session list handler should validate against session status enum (`active \| ended \| orphaned`) not task status enum |
| **Complexity** | Small |

### PIPELINE-1: `research` CLI routes manifest ops to wrong domain

| Field | Value |
|-------|-------|
| **Domain** | Pipeline |
| **Severity** | P1 |
| **File** | `src/cli/commands/research.ts` |
| **Issue** | 5 research subcommands dispatch to memory domain instead of pipeline domain after T5241 cutover: |
| | - `research show <id>` → routes to `query memory show` (should be `query pipeline manifest.show`) |
| | - `research stats` → routes to `query memory stats` (should be `query pipeline manifest.stats`) |
| | - `research add` → routes to `mutate session context.inject` (should be `mutate pipeline manifest.append`) |
| | - `research links <taskId>` → routes to `query memory find` (should be `query pipeline manifest.find`) |
| | - `research link <id> <taskId>` → routes to `mutate memory link` (should be `mutate pipeline manifest.link`) |
| **Root Cause** | Stale routing from pre-T5241 when manifest was in memory domain; not updated during cutover |
| **Fix** | Remap all 5 research subcommands to pipeline domain with correct operation names |
| **Complexity** | Small |

---

## P2 (Significant Behavioral) - 7 Bugs

### SESSION-B1: `session.stop` vs `session.end` naming mismatch

| Field | Value |
|-------|-------|
| **Domain** | Session |
| **Severity** | P2 |
| **File** | `src/cli/commands/session.ts:61` |
| **Issue** | CLI emits `operation: "session.stop"` in `_meta` but Constitution and registry define canonical verb as `session.end`. CLI command name is `stop` (with `end` as alias), but metadata should report the canonical operation name. |
| **Fix** | Change line 61 from `operation: 'session.stop'` to `operation: 'session.end'` |
| **Complexity** | Trivial |

### SESSION-B3: `session end` succeeds with no active session

| Field | Value |
|-------|-------|
| **Domain** | Session |
| **Severity** | P2 |
| **File** | `src/dispatch/domains/session.ts` or `src/core/sessions/` |
| **Issue** | Calling `session end` when no active session exists returns `{success: true, sessionId: "default"}` instead of failing. Silently "ending" a non-existent session is misleading. |
| **Reproduction** | Fresh project, no session started: `cleo session end` → `{success: true}` instead of error |
| **Fix** | Add guard check: return error if no active session (similar to how other operations validate state) |
| **Complexity** | Small |

### SESSION-B4: Double `session start` silently orphans previous session

| Field | Value |
|-------|-------|
| **Domain** | Session |
| **Severity** | P2 |
| **File** | `src/core/sessions/` or `src/dispatch/domains/session.ts` |
| **Issue** | Starting a new session while one is already active does not warn, error, or end the previous session. The previous session becomes orphaned. |
| **Reproduction** | `cleo session start --scope epic:T001 --name first && cleo session start --scope epic:T002 --name second` → both complete without conflict detection |
| **Fix** | Either: (1) auto-end previous session before starting new one, OR (2) return error requiring explicit end first |
| **Complexity** | Small |

### SESSION-B6: `--max-age` parameter unit mismatch

| Field | Value |
|-------|-------|
| **Domain** | Session |
| **Severity** | P2 |
| **File** | `src/cli/commands/session.ts:182` |
| **Issue** | CLI option is `--max-age <hours>` but dispatch parameter is `maxAgeDays`. Either the CLI description is wrong (should say days) or the parameter name is wrong. |
| **Reproduction** | `cleo session gc --max-age 24` → unclear if this means 24 hours or 24 days |
| **Fix** | Align CLI description and engine param name. If engine expects days, rename CLI to `--max-age-days`. If engine expects hours, rename param to `maxAgeHours`. |
| **Complexity** | Small |

### CHECK-1: `compliance sync` sends wrong params to domain handler

| Field | Value |
|-------|-------|
| **Domain** | Check |
| **Severity** | P2 |
| **File** | `src/cli/commands/compliance.ts:88-103` |
| **Issue** | CLI command `compliance sync` dispatches to `check.compliance.record` with `{action: 'sync', force: opts.force}`, but domain handler requires `taskId` and `result` params. Always returns error: "taskId and result are required" |
| **Reproduction** | `cleo compliance sync` → `{"success":false,"error":{"code":2,"message":"taskId and result are required"}}` |
| **Fix** | Either (1) add a `sync` action path to compliance.record handler, OR (2) route `compliance sync` to a different operation |
| **Complexity** | Small |

### CHECK-2: `verify` CLI always routes to query gateway

| Field | Value |
|-------|-------|
| **Domain** | Check |
| **Severity** | P2 |
| **File** | `src/cli/commands/verify.ts:19-34` |
| **Issue** | The verify CLI command always dispatches to `query` + `gate.status`, even when write flags (`--gate`, `--all`, `--reset`) are provided. Constitution split `check.gate.verify` into `gate.status` (query) + `gate.set` (mutate), but CLI never calls mutate path. |
| **Fix** | Add conditional routing: if `--gate`, `--all`, or `--reset` is provided, dispatch to `mutate` + `gate.set` instead of `query` + `gate.status` |
| **Complexity** | Small |

### ADMIN-1: `adr validate` routes to unregistered operation

| Field | Value |
|-------|-------|
| **Domain** | Admin |
| **Severity** | P2 |
| **File** | `src/cli/commands/adr.ts` (or similar) |
| **Issue** | CLI command `adr validate` routes to `mutate:admin.adr.validate` which is NOT registered in the dispatch registry. Operation never defined. |
| **Reproduction** | `cleo adr validate` → `{"success":false,"error":{"code":2,"message":"Unknown operation: mutate:admin.adr.validate"}}` |
| **Fix** | Either (1) register `admin.adr.validate` operation in domain handler, OR (2) remove CLI command and document limitation |
| **Complexity** | Small |

---

## P3 (Low / Cosmetic) - 6 Bugs

### SESSION-B5: Resume error JSON goes to stderr

| Field | Value |
|-------|-------|
| **Domain** | Session |
| **Severity** | P3 |
| **File** | `src/cli/commands/session.ts` (resume handler) |
| **Issue** | `session resume <bad-id>` outputs error JSON to stderr instead of stdout, breaking JSON parsing in pipelines. All other JSON responses go to stdout. |
| **Fix** | Ensure all JSON envelope output goes to stdout; only non-JSON diagnostics go to stderr |
| **Complexity** | Trivial |

### SESSION-B7: `context.inject` still in session domain

| Field | Value |
|-------|-------|
| **Domain** | Session |
| **Severity** | P3 |
| **File** | `src/dispatch/domains/session.ts:366-388` |
| **Issue** | `session.context.inject` is listed in Constitution as moved to `admin.context.inject`. Backward-compat alias remains in session handler, which is fine for compatibility, but the operation should eventually be removed. |
| **Fix** | Add deprecation logging when alias is used. Plan removal in future version. |
| **Complexity** | Trivial |

### CHECK-3: Protocol validation error envelope inconsistency

| Field | Value |
|-------|-------|
| **Domain** | Check |
| **Severity** | P3 |
| **File** | `src/dispatch/domains/check.ts` (protocol validation handlers) |
| **Issue** | Protocol operations (`consensus validate`, `contribution validate`, etc.) return bare error envelope without full `_meta` envelope. Other check operations return complete envelope with `$schema`, `specVersion`, etc. |
| **Fix** | Wrap protocol validation errors in full `_meta` envelope for consistency |
| **Complexity** | Trivial |

### PIPELINE-2: `research archive` missing `--before-date` param

| Field | Value |
|-------|-------|
| **Domain** | Pipeline |
| **Severity** | P3 |
| **File** | `src/cli/commands/research.ts` |
| **Issue** | CLI command `research archive` dispatches to `pipeline.manifest.archive` but passes no `beforeDate` parameter, which is required. |
| **Fix** | Add `--before-date` option to CLI command; pass to domain handler |
| **Complexity** | Small |

### PIPELINE-3: `release changelog` dispatches to nonexistent operation

| Field | Value |
|-------|-------|
| **Domain** | Pipeline |
| **Severity** | P3 |
| **File** | `src/cli/commands/release.ts` |
| **Issue** | CLI command `release changelog <version>` dispatches to `mutate:pipeline.release.changelog` which doesn't exist. Likely absorbed into `release.ship` with a `step` parameter. |
| **Fix** | Remove CLI command OR redirect to `release.ship {step:"changelog"}` |
| **Complexity** | Small |

### PIPELINE-4: Constitution operation count drift

| Field | Value |
|-------|-------|
| **Domain** | Pipeline |
| **Severity** | P3 |
| **File** | `docs/specs/CLEO-OPERATION-CONSTITUTION.md` (Pipeline section) |
| **Issue** | Constitution claims "pipeline (27 operations)" but registry has 31. Phase operations (phase.set, phase.advance, phase.rename, phase.delete) are listed as "removed from registry" but are actually present. |
| **Fix** | Update Constitution to reflect current 31 operations; remove incorrect "removed from registry" entries for phase ops; update phase subsection |
| **Complexity** | Trivial |

---

## Fix Waves - Recommended Grouping

### Wave 1: CLI Routing Sweep (P1 - 6 bugs)
**Scope**: Systematic audit of all `src/cli/commands/*.ts` dispatch calls

| Bug ID | Domain | File | Fix Type |
|--------|--------|------|----------|
| TASKS-1 | Tasks | `relates.ts` | Route to `tasks.relates` with `mode` param |
| TASKS-2 | Tasks | `restore.ts` | Route to `tasks.restore` with `from` param |
| PIPELINE-1 | Pipeline | `research.ts` | Remap all 5 commands to pipeline domain |
| PIPELINE-3 | Pipeline | `release.ts` | Remove or redirect `changelog` command |
| CHECK-2 | Check | `verify.ts` | Add mutate routing for write flags |
| ADMIN-1 | Admin | `adr.ts` | Register missing operation or remove command |

**Estimated Complexity**: Medium
**Impact**: Restores 5 broken CLI features and validates all dispatch routing

---

### Wave 2: Session Domain Hardening (P1-P2 - 6 bugs)
**Scope**: Focused pass on session domain validation, guards, metadata

| Bug ID | Domain | File | Fix Type |
|--------|--------|------|----------|
| SESSION-B1 | Session | `session.ts:61` | Fix metadata operation name |
| SESSION-B2 | Session | Validation layer | Fix status enum validation |
| SESSION-B3 | Session | `session.ts` | Add guard for end without active session |
| SESSION-B4 | Session | `session.ts` | Add conflict detection for double start |
| SESSION-B6 | Session | `session.ts:182` | Fix `--max-age` parameter unit |
| SESSION-B7 | Session | `session.ts:366` | Add deprecation logging for alias |

**Estimated Complexity**: Medium
**Impact**: Fixes all session bugs; prevents silent failures and orphaned sessions

---

### Wave 3: Check Domain Fixes (P2-P3 - 3 bugs)
**Scope**: Check domain consistency and routing

| Bug ID | Domain | File | Fix Type |
|--------|--------|------|----------|
| CHECK-1 | Check | `compliance.ts` | Add sync action to handler or reroute |
| CHECK-3 | Check | Check handlers | Standardize error envelope format |

**Estimated Complexity**: Small
**Impact**: Fixes compliance sync functionality and error consistency

---

### Wave 4: Pipeline Minor Fixes (P3 - 2 bugs)
**Scope**: Pipeline CLI parameter and documentation

| Bug ID | Domain | File | Fix Type |
|--------|--------|------|----------|
| PIPELINE-2 | Pipeline | `research.ts` | Add `--before-date` CLI option |
| PIPELINE-4 | Pipeline | Constitution | Update operation count and phase listings |

**Estimated Complexity**: Small
**Impact**: Completes research archive CLI, syncs documentation

---

### Wave 5: Session Output Consistency (P3 - 1 bug)
**Scope**: Session error output stream fix

| Bug ID | Domain | File | Fix Type |
|--------|--------|------|----------|
| SESSION-B5 | Session | `session.ts` | Route all JSON to stdout |

**Estimated Complexity**: Trivial
**Impact**: Enables JSON parsing in pipelines

---

## Summary by Wave

| Wave | Name | Bugs | Severity | Complexity | Priority |
|------|------|------|----------|-----------|----------|
| 1 | CLI Routing Sweep | 6 | P1 | Medium | CRITICAL |
| 2 | Session Hardening | 6 | P1-P2 | Medium | HIGH |
| 3 | Check Fixes | 2 | P2-P3 | Small | HIGH |
| 4 | Pipeline Minor | 2 | P3 | Small | MEDIUM |
| 5 | Session Output | 1 | P3 | Trivial | LOW |

**Total**: 17 bugs across 5 waves
**Critical Path**: Waves 1 → 2 (Session fixes depend on routing being correct)
**Parallel**: Waves 3-5 can run in parallel after Wave 1 completes
