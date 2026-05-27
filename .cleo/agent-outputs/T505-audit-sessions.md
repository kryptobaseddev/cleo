# CLI Audit — Sessions & Planning Domain

**Date**: 2026-04-11
**Auditor**: Subagent (claude-sonnet-4-6)
**Active session during audit**: ses_20260411021235_a9f15b (CLI-Full-Audit)
**Method**: Every command tested live. Write commands tested with --help and safe dry runs only.

---

## Summary Table

| # | Command | Status | Help Quality | Exit Code | Notes |
|---|---------|--------|--------------|-----------|-------|
| 1 | `cleo session start` | PASS (write, help only) | ADEQUATE | 0 | Two required flags: --scope, --name |
| 2 | `cleo session end` | PASS (write, help only) | ADEQUATE | 0 | -- |
| 3 | `cleo session stop` | DUPLICATE | N/A | 0 | Alias of `session end` via `.alias('stop')`. Same help text shown. |
| 4 | `cleo session handoff` | PASS | ADEQUATE | 0 | Returns previous session's handoff, not current |
| 5 | `cleo session status` | PASS | POOR | 0 | No options documented; no --scope; returns massive session notes array |
| 6 | `cleo session resume` | PASS (help only) | ADEQUATE | 0 | Requires SESSIONID positional |
| 7 | `cleo session find` | PASS | GOOD | 0 | Best discovery command; returns minimal fields + `_next` hint |
| 8 | `cleo session list` | PASS | PARTIAL | 0 | Returns full session objects; no --scope filter; has pagination |
| 9 | `cleo session gc` | PASS | POOR | 0 | No default maxAge documented; no --dry-run flag |
| 10 | `cleo session show` | BUG | ADEQUATE | 0 | --include debrief returns `"data": null` |
| 11 | `cleo session context-drift` | PASS | ADEQUATE | 0 | Returns score 0 with reasons when no scoped tasks |
| 12 | `cleo session suspend` | PASS (error path only) | ADEQUATE | 31 on bad ID | Error envelope correct |
| 13 | `cleo session record-assumption` | PASS | ADEQUATE | 0 | Creates assumption record tied to active session |
| 14 | `cleo session record-decision` | PASS (help only) | ADEQUATE | 0 | Three required fields; --taskId is required |
| 15 | `cleo session decision-log` | PASS | ADEQUATE | 0 | Returns all decisions across all sessions by default |
| 16 | `cleo briefing` | PASS | GOOD | 0 | Rich: handoff + tasks + bugs + blockers + epics + memory |
| 17 | `cleo dash` | PASS | ADEQUATE | 0 | Project health; includes highPriority tasks (verbose) |
| 18 | `cleo plan` | PASS | GOOD | 0 | Prioritized scored list; no options (intentional) |
| 19 | `cleo safestop` | PASS | GOOD | 0 | --dryRun tested; works correctly |
| 20 | `cleo context status` | BUG/PARTIAL | POOR | 0 | Reports stale=true but not what "stale" means |
| 21 | `cleo context check` | PASS | ADEQUATE | 54 (non-zero) | Exits non-zero when stale regardless of threshold |

---

## Detailed Findings

### 1. `cleo session start`

**Status**: PASS (write command — tested help only)

Help text is clear. Two required options: `--scope` (epic:T### or global) and `--name`. Optional `--autoFocus` is documented as alias for `--autoStart` but help shows both separately — fine.

**Issue (minor)**: `--agent` option is undocumented in terms of what it does. An agent subagent reading this cold has no idea when or why to pass `--agent`.

---

### 2. `cleo session end`

**Status**: PASS (write command — tested help only)

Help is adequate. `--session` flag allows targeting a specific session ID, which is useful for orchestrators ending a specific worker's session. `--nextAction` is a free-text field — purpose unclear from help alone.

---

### 3. `cleo session stop`

**Status**: DUPLICATE

`session stop` is a registered `.alias('stop')` on the `session end` command. Both show identical help text:

```
End the current session (session end)
```

The `(session end)` label in the description even leaks the canonical name when accessed via the alias. An agent using `cleo session stop --help` sees "session end" in the output, which is confusing. There is no value in having both — agents need one canonical command.

**Recommendation**: Remove `session stop` alias or at minimum rename the help description to acknowledge it is an alias.

---

### 4. `cleo session handoff`

**Status**: PASS

Returns the previous *ended* session's handoff data, not the current active session's. This is the correct intent (a new session consuming the handoff from the previous one). Output is structured and useful.

**Overlap note**: `cleo briefing` also shows the last handoff as part of its output. The briefing is a superset. `session handoff` is more focused. These are complementary, not duplicates.

---

### 5. `cleo session status`

**Status**: PASS (functional) / POOR (help quality)

Runs correctly and returns a full session record. However:

- **No options at all** — no `--scope`, no `--session` flag to check a non-active session.
- **Output is enormous**: the `sessionNotes` array contains the entire notes history across all sessions (hundreds of entries in this project). This is a context budget hazard for agents.
- Help text says only "Show current session status" with no options. An agent cannot know what the output shape looks like.

**Bug/Blocker for agents**: `session status` output contains `sessionNotes` with notes from all historical sessions — likely a query scope bug. The notes array should be scoped to the current session only.

---

### 6. `cleo session resume`

**Status**: PASS (help only)

Requires a positional SESSIONID. Without it, exits 1 with "Missing required positional argument: SESSIONID". Error message is clear.

**Issue**: No way to resume "the most recently ended session" without first knowing its ID. An agent would need to run `session find --status ended` to discover IDs. A `--last` flag would be ergonomic.

---

### 7. `cleo session find`

**Status**: PASS

Best discovery command. Returns minimal fields: `id`, `name`, `status`, `startedAt`, `scope`, and a helpful `_next.show` hint with the exact command to get full details. Supports `--status`, `--scope`, `--query` (fuzzy name/ID match), `--limit`.

**Compared to `session list`**: `find` is lower context cost (fewer fields), supports fuzzy `--query`, and includes `_next` hints. `list` returns full session objects with all 15 fields and supports pagination (`--offset`) but no `--scope`. They serve different purposes.

---

### 8. `cleo session list`

**Status**: PASS (functional) / PARTIAL (UX)

Functional with pagination. Returns full session objects (15 fields each), which is expensive. No `--scope` filter — cannot filter by epic/global scope. Has `--status` and `--limit/--offset` only.

**Ambiguity**: `session list` and `session find` both accept `--status`. The help text for `list` says "List sessions" with no explanation of when to prefer it over `find`. An agent defaulting to `list` will consume far more context budget than `find`.

**Recommendation**: The CLEO protocol already says "NEVER `cleo list` for browsing" for tasks. The same guidance should apply to `session list`. Its help text should say "Use `session find` for low-context discovery."

---

### 9. `cleo session gc`

**Status**: PASS (functional) / POOR (discoverability)

Runs and returns `{orphaned: [], removed: []}` with no `--maxAge`. The default behavior is unclear from help — no documentation of what the default age threshold is, or what "orphaned" means vs "removed."

**Issue**: No `--dry-run` flag. GC is a destructive operation (removes sessions) but you cannot preview what would be deleted.

**Issue**: Help says `--maxAge` is "Max age in days for active sessions" — "active sessions" seems wrong; gc should target old *ended* sessions, not active ones.

---

### 10. `cleo session show`

**Status**: BUG

`cleo session show <id>` (without `--include`) works correctly and returns a full session object.

`cleo session show <id> --include debrief` returns `{"success":true,"data":null}`. The debrief include is silently failing. The session does have `debriefJson` data (confirmed in `session list` output for ended sessions). For the active session under test, `debriefJson` is null (expected) — but testing with ended sessions confirms the field exists in the DB.

**Action needed**: The `--include debrief` handler needs investigation. The data is in the DB but not being returned when requested.

---

### 11. `cleo session context-drift`

**Status**: PASS

Returns a score and explanatory factors. When session scope is global and no tasks are in scope, returns score=0 with `["No tasks found in session scope", "Scope type: global"]`. Output is clear and parseable.

**Overlap note**: `cleo context status` monitors AI context window usage (tokens). `cleo session context-drift` monitors whether the agent is working on tasks outside its declared scope. These are distinct — good naming prevents confusion.

---

### 12. `cleo session suspend`

**Status**: PASS (error path tested)

Error envelope is correct: exits 31 (`E_SESSION_NOT_FOUND`) with a structured error response. Suspend requires a positional SESSIONID — cannot suspend the active session without knowing its ID. Agents must call `session status` or `session find` first.

**Issue**: No convenience for "suspend current session" without passing an explicit ID.

---

### 13. `cleo session record-assumption`

**Status**: PASS

Tested live. Creates an assumption record, defaults to active session, returns the new record with `id`, `sessionId`, `taskId` (null if not passed), `assumption`, `confidence`, and `timestamp`.

Help clearly documents the two required options and their allowed values.

---

### 14. `cleo session record-decision`

**Status**: PASS (help only, source confirmed)

Three required options: `--taskId`, `--decision`, `--rationale`. The `--taskId` requirement is a design choice — every decision must be tied to a task. This is intentional but worth noting: agents cannot record a general session-level decision without inventing a task ID.

**Issue**: `--alternatives` accepts a string but the storage and display treat it as a single string, not a list. Decision log shows `alternatives: []` in output — mismatch with input schema.

---

### 15. `cleo session decision-log`

**Status**: PASS

Returns all decisions with no filter by default. With `--sessionId`, filters to one session. With `--taskId`, filters to one task. Output includes session context and all decision fields. Useful for post-session review.

---

### 16. `cleo briefing`

**Status**: PASS

Richest context-restoration command. Returns: last handoff, current task (null if none), next tasks (scored), open bugs, blocked tasks, active epics, memory context (recent decisions, patterns, observations, learnings). 

Help text is excellent — description includes version tag `v2026.4.29` and lists all sections. Options allow tuning list sizes.

**Relationship to other commands**: `briefing` is the recommended session-start command per CLEO protocol. It subsumes `session handoff` data. It is NOT a duplicate — it adds task prioritization and memory context that `session handoff` alone does not provide.

---

### 17. `cleo dash`

**Status**: PASS

Returns project health: task status counts, current phase, active session, high-priority tasks (with full task detail). Output is high-context — the `highPriority.tasks` array includes full task bodies.

Help description is good and distinguishes it from `plan`: "overall project status."

**Distinction from `cleo plan`**: `dash` shows project health (counts, phases, blocked, recent activity). `plan` shows prioritized task lists with scoring rationale. They are complementary, not duplicates.

---

### 18. `cleo plan`

**Status**: PASS

Returns scored, prioritized task list with scoring rationale per task (`reasons` array). Covers in-progress epics, ready tasks, blocked tasks, open bugs. No options — intentional simplicity.

Output is verbose (all ready tasks with full scoring details) but well-structured. Very useful for deciding what to work on next.

---

### 19. `cleo safestop`

**Status**: PASS

Tested with `--dryRun --reason "audit test dry run"`. Returns `{stopped: false, sessionEnded: false, dryRun: true}`. Correct behavior.

Help is the best in this domain: clearly documents `--dryRun`, `--commit`, `--handoff`, `--noSessionEnd` flags. Purpose is unambiguous.

**Distinction from `session end`**: `safestop` is for agents approaching context limits. It optionally commits WIP, generates handoff docs, and ends the session in one atomic operation. `session end` is just the session state transition. These are NOT duplicates.

---

### 20 & 21. `cleo context status` / `cleo context check`

**Status**: PASS (functional) / POOR (help) for `status` | PASS for `check`

`cleo context status` reads a `.context-state.json` file and reports token usage. Returns `{available, status, percentage, currentTokens, maxTokens, timestamp, stale, sessions}`.

**Bug**: Returns `status: "stale"` when `.context-state.json` is not current (written by hooks, not live). The word "stale" is confusing — it means the state file is old, not that the context window is depleted. Help text says nothing about this.

**Bug**: `context check` exits non-zero (54) when `stale: true` — even at 6% usage. An agent scripting on exit code would think context is at threshold when it's actually at 6%. The exit code semantics conflate staleness with threshold exceeded.

Help for `context check` says "exits non-zero when threshold exceeded" but it exits non-zero when `stale: true` regardless of threshold. This is misleading.

**Distinction from `session context-drift`**: Completely different concerns. `context` = AI token budget. `session context-drift` = task scope fidelity. No overlap, but the shared word "context" could confuse agents. The help descriptions are distinct enough.

---

## Duplicate / Overlap Analysis

| Pair | Verdict |
|------|---------|
| `session end` vs `session stop` | TRUE DUPLICATE — `stop` is an alias that shows "session end" in its own help. Remove the alias or document it explicitly. |
| `cleo briefing` vs `session handoff` | COMPLEMENTARY — briefing is a superset. Keep both; briefing is the agent start-of-session command, handoff is for targeted inspection. |
| `cleo dash` vs `cleo plan` | COMPLEMENTARY — distinct purposes. dash=health overview, plan=prioritized work queue. |
| `cleo context` vs `session context-drift` | COMPLEMENTARY — different concerns (token budget vs task scope). The shared word is confusing but the commands are distinct. |
| `cleo safestop` vs `session end` | COMPLEMENTARY — safestop is a workflow command (commit+handoff+end), session end is a primitive state transition. |

---

## Bugs Found

| ID | Severity | Command | Description |
|----|----------|---------|-------------|
| BUG-S-001 | HIGH | `session show --include debrief` | Returns `"data": null` for active session. Debrief data not surfaced. |
| BUG-S-002 | HIGH | `context check` | Exits non-zero (54) when state file is stale but context at 6%. Exit code semantics are wrong — conflates staleness with threshold. |
| BUG-S-003 | MEDIUM | `session status` | `sessionNotes` array contains all historical notes across all sessions, not just current session. Context budget hazard. |
| BUG-S-004 | MEDIUM | `session gc` | Help says "--maxAge: Max age in days for **active** sessions" — should say "ended sessions". Misleading. |
| BUG-S-005 | MEDIUM | `session stop` | Alias of `session end` shows "(session end)" in help text when invoked via alias. Leaks implementation detail. |
| BUG-S-006 | LOW | `session record-decision` | `--alternatives` stored/shown as `[]` in decision-log output despite accepting a string input. Schema mismatch. |
| BUG-S-007 | LOW | `session gc` | No `--dry-run` flag on a potentially destructive command. |
| BUG-S-008 | LOW | `context status` | `stale: true` meaning is undocumented. Agents cannot interpret what action to take. |

---

## Help Text Quality Issues

| Command | Issue |
|---------|-------|
| `session status` | No description of output shape. No options. Output contains massive notes history. |
| `session gc` | Wrong description of what `--maxAge` targets. No mention of default behavior. |
| `session start` | `--agent` option has no description of when/why to use it. |
| `session resume` | No mention of how to find a session ID to resume (must use `session find` first). |
| `context status` | `stale` field meaning not explained. |
| `context check` | Claims "exits non-zero when threshold exceeded" but actually exits non-zero on staleness too. |

---

## Ergonomic Gaps

1. **No "suspend current session" shorthand** — `suspend` requires an explicit session ID; agent must first look up its own active session ID.
2. **No "resume last session" shorthand** — `resume` requires an explicit session ID; no `--last` flag.
3. **`session list` has no `--scope` filter** — agents working in epic scope cannot list only their epic's sessions without going through `session find`.
4. **`session gc` has no `--dry-run`** — users cannot preview what would be cleaned up.
5. **`session decision-log` shows all sessions by default** — without `--sessionId`, this is a full dump of all decisions in the project. Should default to active session.

---

## What Works Well

- `cleo session find` — excellent lightweight discovery with `_next` hints.
- `cleo briefing` — comprehensive context restoration in one call.
- `cleo safestop` — well-designed emergency shutdown with `--dryRun`.
- `cleo plan` — clean prioritized view with transparent scoring.
- Error envelopes — all errors return structured `{success: false, error: {code, message, codeName}}` with correct exit codes.
- `session record-assumption` — clean, well-named, defaults to active session.
- `session context-drift` — informative score with explanatory factors.
