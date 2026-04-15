# CLI Audit: Task CRUD Domain

**Date**: 2026-04-11
**Auditor**: claude-sonnet-4-6 (CLI Full Audit subagent)
**Session**: ses_20260411021235_a9f15b (CLI-Full-Audit)
**Test task created**: T501 (T502, T503, T504 for batch/lifecycle tests)

---

## Summary Table

| Command | Status | Help Quality | Error Handling | Notes |
|---------|--------|-------------|----------------|-------|
| `cleo add` | PASS | GOOD | GOOD | Strict mode gates undocumented in help |
| `cleo show` | PASS | GOOD | GOOD | Archives still visible — correct |
| `cleo find` | PARTIAL | FAIR | FAIR | Filter-only mode undocumented; query required |
| `cleo list` / `cleo ls` | PASS | GOOD | N/A | ls alias works |
| `cleo update` | PASS | POOR | GOOD | Help description is a single terse line |
| `cleo complete` / `cleo done` | PASS | GOOD | GOOD | Verification gate not bypassed by --force |
| `cleo delete` / `cleo rm` | PASS | FAIR | GOOD | Soft-delete; archives still readable via show |
| `cleo start` | PARTIAL | POOR | GOOD | Does not transition task status to active |
| `cleo stop` | PASS | FAIR | N/A | Idempotent when no current task |
| `cleo current` | PASS | GOOD | N/A | Clean output |
| `cleo next` | PASS | GOOD | N/A | --explain and --count work correctly |
| `cleo exists` | PASS | GOOD | GOOD | Exit 4 on not-found as documented |
| `cleo bug` | FAIL | FAIR | PARTIAL | Creates type:"task" not type:"bug"; AC required |
| `cleo cancel` | PASS | GOOD | GOOD | Reversible; reason captured |
| `cleo add-batch` | PARTIAL | FAIR | GOOD | parentId in JSON ignored; --parent flag required |
| `cleo claim` | PARTIAL | FAIR | BAD | Not-found returns E_INTERNAL (code 1) not E_NOT_FOUND (code 4) |
| `cleo unclaim` | PARTIAL | FAIR | BAD | Not-found returns E_INTERNAL (code 1) not E_NOT_FOUND (code 4) |

**Totals**: 10 PASS | 4 PARTIAL | 1 FAIL | 0 UNWIRED

---

## Detailed Findings

### 1. `cleo add`

**Status**: PASS

**Help quality**: GOOD. Has full description, all options documented with types, enums listed. Preconditions section (with gate names) is unique and useful for agents. Examples provided.

**Actual behavior**: Creates tasks correctly. Returns full task object including verification scaffold.

**Issues found**:
- Strict mode validation fires without any guidance in the base help text. First run against a bare call returned E_VALIDATION for two gates simultaneously: missing parent (strict mode) and missing acceptance criteria. The error output contains the fix, but nothing in `--help` warns that strict mode is active or that acceptance criteria are required for non-trivial priorities.
- The `--parentSearch` option appears in the citty tier of the help but not the rich-help tier — minor inconsistency (`--parent-search` in rich vs `--parentSearch` in citty).
- `--addPhase` and `--desc` alias appear only in citty tier help, not in rich-help tier.

**Agent usability**: Adequate once the agent reads the preconditions section. A zero-context agent will fail on first run and need to retry.

---

### 2. `cleo show`

**Status**: PASS

**Help quality**: GOOD. Single-line description is informative ("returns complete task record with metadata, verification, lifecycle"). Precondition documented.

**Actual behavior**: Returns full task record including verification object. Works on archived tasks (returns status:"archived") — this is correct since delete is a soft-delete.

**Issues found**: None.

**Edge cases tested**: Nonexistent ID returns E_NOT_FOUND (exit 4) with `alternatives` array including search command.

---

### 3. `cleo find`

**Status**: PARTIAL

**Help quality**: FAIR. Arguments section says query is "optional" (correct, since `--id` can replace it), but the help omits the key constraint: **filters alone (e.g. `--status`) cannot substitute for a query or `--id`**. An agent reading the help would reasonably expect `cleo find --status active` to work but it returns E_INVALID_INPUT.

**Actual behavior**:
- Text query alone: works
- `--id` prefix alone: works
- `--status` alone (no query): FAILS with E_INVALID_INPUT (exit 2)
- Query + `--status` combined: works (filter applied on top of search)
- `--in` field filter: works
- `--fields` extra fields: works
- `--exact` title match: works
- `--include-archive`: works, returns archived tasks
- `--verbose`: flag present in help but not tested (implied equivalent to list output)

**Issues found**:
- `--status` (and presumably other filters) cannot be used as a standalone filter without a query. The help says query is optional, implying filters alone should work, but they do not. This is a documentation gap that will confuse agents.
- When used as a filter alongside a query, `--status` works correctly.
- Fix suggestion in error ("cleo find \"<query>\"") is correct.

---

### 4. `cleo list` / `cleo ls`

**Status**: PASS

**Help quality**: GOOD. Filters documented. Examples present.

**Actual behavior**: Both `cleo list` and `cleo ls` resolve to the same command. No-args call returns all tasks (80 total in test environment) with a default limit of 10. `--parent` filter works. `--status`, `--priority`, `--type`, `--phase`, `--label` filters all documented.

**Issues found**:
- Calling `cleo list` with no arguments returns a large result set. The CLEO protocol documentation warns against this ("avoid `cleo list` without `--parent`") for token budget reasons but the CLI itself does not warn.
- No `--sort` option exposed.

**Cross-domain**: `cleo list` is the verbose browsing counterpart to `cleo find` for search. Distinction is clear.

---

### 5. `cleo update`

**Status**: PASS

**Help quality**: POOR. The description is a single terse line: "Update a task". No description of what can be updated, no precondition documentation, no examples. Compare to `cleo add` (with full description, gates, examples) — the gap is significant for zero-context agent use.

**Actual behavior**: Correctly updates title, notes, priority, size. Returns `changes` array listing what changed. Calling with no update fields returns E_NO_CHANGE (code 102, exit 102) with a clear fix message. Nonexistent ID returns E_NOT_FOUND (exit 4).

**Issues found**:
- Missing help description is the primary issue. An agent cannot know from `--help` alone what validation rules apply (anti-hallucination for title/description, strict mode, etc.).
- `--pipelineStage` option is exposed in the update help but only in the citty tier. The forward-only constraint is mentioned in the option description ("forward-only:") which is useful.
- `--noAutoComplete` option is listed without explanation of what "auto-complete for epic" means.

---

### 6. `cleo complete` / `cleo done`

**Status**: PASS

**Help quality**: GOOD. Full description, preconditions with gate names, examples. The `done` alias renders the same help as `complete`.

**Actual behavior**: Requires verification gates to be set (via `cleo verify --all`) before completion. `--force` does NOT bypass verification gates — it only bypasses incomplete-children and unresolved-dependency checks. This is intentional per the lifecycle model but the help text for `--force` says "even when children are not done or dependencies unresolved" — it does not mention that verification gates still fire. An agent could expect `--force` to override everything.

**Issues found**:
- `--force` description is incomplete: it does not tell the agent that verification gates are still enforced. An agent expecting `cleo complete T123 --force` to always work will be surprised by E_LIFECYCLE_GATE_FAILED (exit 80).
- The `--verify` flag mentioned in the rich-help preconditions ("no --verification-note or --verify flag was supplied") does not appear as an option in either help tier. `--verificationNote` (citty) / `--verification-note` (rich) is the actual flag. The mention of `--verify` in the precondition text is either stale or refers to an unlisted alias.

---

### 7. `cleo delete` / `cleo rm`

**Status**: PASS

**Help quality**: FAIR. Terse but accurate. "Soft delete to archive" is in the description, which correctly sets expectations. `--force` and `--cascade` options documented.

**Actual behavior**: Soft-deletes (sets status to "archived"). The deleted task remains visible via `cleo show` with status:"archived". `cleo list` excludes archived tasks by default; `cleo find --include-archive` includes them. Both `delete` and `rm` aliases work.

**Issues found**:
- The `--force` option has no description text in the help output (blank). Agents won't know when to use it.
- The `--cascade` option has no description text in the help output (blank).
- Distinction from `cleo archive` (which archives completed tasks in bulk) is not surfaced in either command's help. `cleo delete` is per-task soft-delete; `cleo archive` is bulk archival of completed tasks. These serve different purposes.

---

### 8. `cleo start`

**Status**: PARTIAL

**Help quality**: POOR. Description says "sets it as the current task in the active session" but does NOT mention that it does NOT change the task's status field. An agent may call `cleo start T123` expecting the task status to transition to "active".

**Actual behavior**: Sets the session's `currentTask` pointer only. The task's `.status` field remains "pending". Verified: after `cleo start T504`, `cleo show T504` returned `status:"pending"`.

**Issues found**:
- **Design gap (not a bug)**: `cleo start` tracks focus, not status. To transition status, the agent must separately call `cleo update T### --status active`. This dual-step is not explained in the help and is a common point of confusion.
- No options exposed (no `--status-transition` or similar).
- Nonexistent ID returns E_NOT_FOUND (exit 4) — correct.

**Cross-domain**: `cleo start <id>` (task focus) vs `cleo session start` (session lifecycle) — the help descriptions are distinct enough that a careful reader will understand them separately, but the shared `start` verb is ambiguous out of context.

---

### 9. `cleo stop`

**Status**: PASS

**Help quality**: FAIR. Description is informative but the return schema is embedded in the description ("returns {cleared: boolean, previousTask: string|null}") which is helpful for agents. No options or examples shown because there are none.

**Actual behavior**: Clears the session's currentTask. Idempotent when no task is active (returns `{cleared: true, previousTask: null}` — note: exit 0, not an error). Returns the previous task ID in `previousTask`.

**Issues found**: None functional. The idempotent behavior (no error when already stopped) is correct.

---

### 10. `cleo current`

**Status**: PASS

**Help quality**: FAIR. Return shape documented in description. No options.

**Actual behavior**: Returns `{currentTask: string|null, currentPhase: string|null}`. Correctly reflects session state.

**Issues found**: None.

---

### 11. `cleo next`

**Status**: PASS

**Help quality**: GOOD. Short but complete. `--explain` and `--count` documented.

**Actual behavior**: Returns top N task suggestions scored by priority, dependency readiness, and age. `--explain` adds `reasons` array per suggestion. `--count 3` returns up to 3 results. Score algorithm is transparent.

**Issues found**:
- A stale migration journal WARN message fires ("Detected stale migration journal entries from a previous CLEO version. Reconciling.") on every invocation of `cleo next`. This is noise in agent pipelines that parse JSON output.

---

### 12. `cleo exists`

**Status**: PASS

**Help quality**: GOOD. Documents exit code contract (0=exists, 4=not found) in the description itself — excellent for script/agent use.

**Actual behavior**: Returns `{exists: true/false, taskId}`. With `--verbose` also returns `title` and `status`. Exit 0 when found, exit 4 when not found (matches documentation).

**Issues found**: None.

---

### 13. `cleo bug`

**Status**: FAIL

**Help quality**: FAIR. Severity levels documented (P0-P3), default noted. `--dryRun` available.

**Actual behavior**:
- Creates a task with `type: "task"` not `type: "bug"`. Confirmed via dry-run output: `"type": "task"`. This appears to be a regression or design omission — the command is named `bug` but the resulting task type field does not reflect this.
- Does NOT auto-inject acceptance criteria. Callers must supply `--acceptance` or the command fails with E_VALIDATION in strict mode (high/critical priority tasks require 3+ ACs).
- Does NOT auto-inject a standard description template. Without `--description`, the anti-hallucination gate fires because description defaults to the title string.
- `--epic` accepts an epic ID for parent linkage — useful, but the error when strict mode requires a parent is the same E_VALIDATION as `cleo add`.

**Issues found**:
- **BUG**: `type` field is `"task"` not `"bug"`. The entire purpose of `cleo bug` is to create bug-type tasks; this core invariant is broken.
- The command is intended as a shortcut (severity maps to priority, labels are injected) but is not actually shorter than `cleo add` because the caller must still supply description, parent, and 3+ acceptance criteria in strict mode.
- The `--dryRun` passes when strict-mode constraints would fail on real execution (because dry-run uses a lighter validation path). This dry-run / live inconsistency is misleading.

---

### 14. `cleo cancel`

**Status**: PASS

**Help quality**: GOOD. "Soft terminal state; reversible via restore" in the description is exactly what agents need to know. `--reason` documented.

**Actual behavior**: Sets status to "cancelled". The reason is stored in `cancellationReason`. Nonexistent ID returns E_NOT_FOUND (exit 4). Correctly reversible (cancel does not delete).

**Issues found**: None.

---

### 15. `cleo add-batch`

**Status**: PARTIAL

**Help quality**: FAIR. `--file` and stdin (`-`) documented. `--dryRun` and `--parent` mentioned.

**Actual behavior**:
- `--file <path>` and `--file -` (stdin) both work.
- `--dryRun` works.
- The `parentId` field in per-task JSON objects is IGNORED. The strict mode parent requirement must be satisfied via the `--parent` CLI flag. The dry-run validated a payload with `"parentId": "T091"` in JSON and returned success, but the live run returned E_VALIDATION for missing parent. **The dry-run was inconsistent with live behavior.**
- When `--parent` CLI flag is provided, it correctly applies to all tasks that do not specify their own parent.
- Per-task `acceptance` in JSON must be an array of strings (not a single pipe-delimited string as in `cleo add`). The format diverges from `--acceptance` on `cleo add`.
- Partial failure: if some tasks fail, the command exits 1 but the successful tasks are still created. The results array reports per-task success/failure.

**Issues found**:
- Dry-run does not apply strict-mode validation. A dry-run that passes is not a reliable preview of whether the live run will succeed.
- `parentId` in task JSON is silently ignored. If per-task parents are intended to work, this is a bug; if not, the field should be rejected with a clear error rather than silently dropping it.
- Acceptance format in JSON differs from `--acceptance` flag format. JSON uses `["AC1", "AC2", "AC3"]` array; flag uses `"AC1|AC2|AC3"` pipe-separated string. This inconsistency is not documented.

---

### 16. `cleo claim`

**Status**: PARTIAL

**Help quality**: FAIR. `--agent` required flag documented. No examples.

**Actual behavior**: Assigns agent ID to task. Returns `{taskId, agentId}`.

**Issues found**:
- **Wrong error code**: When task does not exist, returns `E_INTERNAL` (code 1, exit 1) instead of `E_NOT_FOUND` (code 4, exit 4). All other task commands return code 4 for not-found. This breaks exit-code-based error handling in agent pipelines.
- No idempotency documented: what happens if you claim an already-claimed task? (Not tested, but edge case worth noting.)

---

### 17. `cleo unclaim`

**Status**: PARTIAL

**Help quality**: FAIR. Very terse — no description of what "removing current assignee" means in terms of output or side effects.

**Actual behavior**: Removes assignee. Returns `{taskId}` only (no `agentId` to confirm what was removed). Idempotent when task has no assignee (succeeds silently).

**Issues found**:
- **Wrong error code**: Same as `claim` — nonexistent task returns `E_INTERNAL` (code 1, exit 1) instead of `E_NOT_FOUND` (code 4, exit 4).
- Return value does not include the previous assignee. An agent cannot confirm which agent was unclaimed.

---

## Cross-Domain Overlap Analysis

| Pair | Distinction | Verdict |
|------|-------------|---------|
| `cleo start <id>` vs `cleo session start` | `start <id>` sets focus; `session start` creates session | Clear enough if reading help; verb collision is a minor risk |
| `cleo complete <id>` vs `cleo lifecycle complete` | `complete` marks task done; `lifecycle complete` advances RCASD pipeline stage | Different concepts; help descriptions distinguish them |
| `cleo delete` vs `cleo archive` | `delete` is per-task soft-delete; `archive` is bulk archival of completed tasks | Poorly distinguished — `delete` help says "soft delete to archive" but `archive` also exists as a separate concept |

---

## Issues Summary (Prioritized)

### P0 — Functional Bugs
1. **`cleo bug` creates `type:"task"` instead of `type:"bug"`** — Core invariant broken. Every task created with `cleo bug` has the wrong type field.
2. **`cleo claim` / `cleo unclaim` return `E_INTERNAL` (exit 1) for not-found** — Should be `E_NOT_FOUND` (exit 4). Breaks exit-code-driven error handling.

### P1 — Behavioral Inconsistencies
3. **`cleo add-batch` dry-run bypasses strict-mode validation** — Dry-run reports success for payloads that will fail on real execution.
4. **`cleo add-batch` silently ignores `parentId` in task JSON** — The field appears valid but is dropped.
5. **`cleo complete --force` does not bypass verification gates** — `--force` description implies it overrides all guards; verification gates still fire.

### P2 — Documentation/Help Gaps
6. **`cleo find` help says query is optional but `--status`-only calls fail** — The constraint "query or --id required" is not surfaced; filters alone do not work.
7. **`cleo start` does not change task status** — Help does not mention this; agents will expect a status transition.
8. **`cleo update` has a one-word description** — Missing examples, preconditions, and validation rules.
9. **`cleo delete` `--force` and `--cascade` options have no description text**.
10. **`cleo bug` does not auto-populate acceptance criteria** — Defeats the purpose of a shortcut command.

### P3 — Minor / Cosmetic
11. Stale migration journal WARN fires on every `cleo next` invocation — noise in JSON output.
12. `cleo add-batch` acceptance format (JSON array) vs `cleo add` acceptance format (pipe string) is undocumented.
13. `cleo unclaim` return value does not include the previous assignee.
14. `--verify` mentioned in `cleo complete` preconditions text but the actual flag is `--verification-note`.
15. `cleo delete` vs `cleo archive` distinction is not surfaced in either command's help.
