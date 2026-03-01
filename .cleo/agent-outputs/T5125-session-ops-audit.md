# T5125: Session Operations Audit

## Overview

The session domain exposes **11 query operations** and **7 mutate operations** (18 total) through the dispatch layer in `src/dispatch/domains/session.ts`. All delegate to engine functions in `src/dispatch/engines/session-engine.ts`, which in turn call core functions in `src/core/sessions/`.

---

## Query Operations (11)

### 1. `status` (Tier 0 in spec, listed as Tier 1 in ops-ref)
- **Purpose**: Check if a session is currently active, its scope, and basic state.
- **When agents use it**: First thing at session start to detect resume scenarios.
- **Params**: None
- **Overlap**: None. This is the cheapest session check.
- **Recommendation**: Should be Tier 0 (essential for session-start efficiency sequence). The ops-ref lists it as Tier 1 but CLEO-INJECTION.md uses it in step 1 of the mandatory efficiency sequence, implying Tier 0. Align to Tier 0.

### 2. `list` (Tier 2)
- **Purpose**: List all sessions with basic metadata. Supports `active` and `limit` filters.
- **When agents use it**: Rarely. Only to browse past sessions or find a specific one.
- **Params**: `active?` (boolean), `limit?` (number, defaults to 10)
- **Overlap**: Overlaps with `find` for discovery. `list` returns full session objects; `find` returns minimal records.
- **Recommendation**: Keep at Tier 2. Agents should prefer `find` for discovery.

### 3. `show` (Tier 2)
- **Purpose**: Get full details for a specific session by ID.
- **When agents use it**: When they have a session ID and need complete data.
- **Params**: `sessionId` (required)
- **Overlap**: None. This is the canonical detail view.
- **Recommendation**: Keep at Tier 2.

### 4. `find` (Tier not yet in ops-ref)
- **Purpose**: Lightweight session discovery with filters. Returns minimal session records.
- **When agents use it**: When searching for sessions by status, scope, or text query.
- **Params**: `status?`, `scope?`, `query?`, `limit?`
- **Overlap**: Partial overlap with `list`. `find` is the lightweight alternative.
- **Recommendation**: Add to ops-ref at Tier 1. Preferred over `list` for discovery (same pattern as `tasks.find` vs `tasks.list`).

### 5. `history` (Tier 2)
- **Purpose**: Get session event history (start/end/suspend/resume timeline).
- **When agents use it**: Debugging session lifecycle issues or reviewing what happened.
- **Params**: `sessionId?`, `limit?`
- **Overlap**: None.
- **Recommendation**: Keep at Tier 2.

### 6. `decision.log` (Tier 2)
- **Purpose**: View decisions recorded during a session or for a task.
- **When agents use it**: Reviewing rationale for past decisions, audit trails.
- **Params**: `sessionId?`, `taskId?`
- **Overlap**: None. Complements `record.decision`.
- **Recommendation**: Keep at Tier 2.

### 7. `context.drift` (Tier 3)
- **Purpose**: Analyze how far the current context has drifted from session start.
- **When agents use it**: Advanced introspection for long-running sessions.
- **Params**: `sessionId?`
- **Overlap**: None.
- **Recommendation**: Keep at Tier 3. Specialized use case.

### 8. `handoff.show` (Tier 0)
- **Purpose**: Get structured handoff data from the most recent ended session. Contains last task, completed/created tasks, next suggestions, blockers, bugs.
- **When agents use it**: At session start to understand context from the previous session.
- **Params**: `scope?` (string: "global" or "epic:T1234")
- **Overlap**: Partial overlap with `briefing.show` (which also includes next-task suggestions). Handoff is session-exit data; briefing is session-start data.
- **Recommendation**: Keep at Tier 0. Critical for session continuity.
- **Bug fixed (T5123)**: Error handling now preserves CleoError exit codes instead of doing message-string matching.

### 9. `briefing.show` (Tier 0)
- **Purpose**: Generate a session-start briefing with next tasks, open bugs, blockers, and epic summaries.
- **When agents use it**: At session start for a comprehensive view of what to work on.
- **Params**: `scope?`, `maxNextTasks?`, `maxBugs?`, `maxBlocked?`, `maxEpics?`
- **Overlap**: Partial overlap with `handoff.show` (both suggest next tasks). Briefing is more comprehensive and forward-looking; handoff is backward-looking.
- **Recommendation**: Keep at Tier 0. They serve different purposes and complement each other.

### 10. `debrief.show` (Tier 2)
- **Purpose**: Get rich debrief data for a specific session (superset of handoff with git state, metrics, etc.).
- **When agents use it**: Post-session analysis, reviewing what was accomplished.
- **Params**: `sessionId` (required)
- **Overlap**: Superset of `handoff.show`. Handoff is "quick resume context"; debrief is "full session report."
- **Recommendation**: Keep at Tier 2. Most agents only need handoff.

### 11. `chain.show` (Tier 2)
- **Purpose**: View the chain of sessions (previous session linked to current).
- **When agents use it**: Understanding session lineage across multiple work periods.
- **Params**: `sessionId` (required)
- **Overlap**: None.
- **Recommendation**: Keep at Tier 2.

---

## Mutate Operations (7)

### 1. `start` (Tier 1)
- **Purpose**: Start a new work session with a scope.
- **When agents use it**: Beginning of every work period.
- **Params**: `scope` (required), `name?`, `autoStart?`, `startTask?`/`focus?`, `grade?`
- **Overlap**: None.
- **Recommendation**: Keep at Tier 1.
- **Note**: Also binds session to process-scoped context and optionally starts a task.

### 2. `end` (Tier 1)
- **Purpose**: End the current session. Auto-computes debrief/handoff data.
- **When agents use it**: End of every work period.
- **Params**: `note?`, `nextAction?`
- **Overlap**: None.
- **Recommendation**: Keep at Tier 1.
- **Note**: Automatically unbinds session context and computes debrief (falling back to handoff if debrief fails).

### 3. `resume` (Tier 2)
- **Purpose**: Resume a previously suspended session.
- **When agents use it**: Continuing interrupted work.
- **Params**: `sessionId` (required)
- **Overlap**: None. Inverse of `suspend`.
- **Recommendation**: Keep at Tier 2.

### 4. `suspend` (Tier 2)
- **Purpose**: Temporarily suspend an active session without ending it.
- **When agents use it**: Pausing work temporarily (e.g., switching context).
- **Params**: `sessionId` (required), `reason?`
- **Overlap**: None. Inverse of `resume`.
- **Recommendation**: Keep at Tier 2.

### 5. `gc` (Tier 3)
- **Purpose**: Garbage collect old ended sessions.
- **When agents use it**: Maintenance only.
- **Params**: `maxAgeDays?`
- **Overlap**: None.
- **Recommendation**: Keep at Tier 3. Housekeeping operation.

### 6. `record.decision` (Tier 1)
- **Purpose**: Record a decision made during the session with rationale and alternatives.
- **When agents use it**: After making significant architectural or implementation decisions.
- **Params**: `sessionId?`, `taskId?`, `decision` (required), `rationale` (required), `alternatives?`
- **Overlap**: None. Read counterpart is `decision.log`.
- **Recommendation**: Keep at Tier 1.

### 7. `record.assumption` (Tier 2)
- **Purpose**: Record an assumption made during the session.
- **When agents use it**: When making assumptions that should be validated later.
- **Params**: `sessionId?`, `taskId?`, `assumption` (required), `confidence` (required: high/medium/low)
- **Overlap**: Conceptually similar to `record.decision` but for unverified beliefs.
- **Recommendation**: Keep at Tier 2. Less commonly used than decisions.

---

## Overlap Analysis

| Operation Pair | Overlap Type | Resolution |
|---------------|-------------|------------|
| `list` vs `find` | Discovery overlap | `find` is preferred (lightweight). `list` for full data only. |
| `handoff.show` vs `briefing.show` | Both suggest next tasks | Different direction: handoff=backward, briefing=forward. Keep both. |
| `handoff.show` vs `debrief.show` | Debrief is superset | Handoff for quick resume, debrief for full report. Keep both. |
| `record.decision` vs `record.assumption` | Both record session context | Decisions are verified choices; assumptions are unverified. Keep both. |

---

## Recommended Tier Alignment

| Operation | Current Tier (ops-ref) | Recommended Tier |
|-----------|----------------------|-----------------|
| `status` | 1 | **0** (used in mandatory efficiency sequence) |
| `find` | not listed | **1** (lightweight discovery) |
| All others | as listed | No change |

---

## Recommended Deprecations

None. All 18 operations serve distinct purposes with minimal overlap. The `list` vs `find` overlap is intentional (same pattern as tasks domain).

---

## Bug Fix Applied (T5123)

`sessionHandoff` in `src/dispatch/engines/session-engine.ts` had a catch block that:
- Cast all errors to `(err as Error).message` (unsafe for non-Error throws)
- Did string matching (`message.includes('not found')`) instead of checking CleoError type
- Lost original exit codes from CleoError instances

**Fixed to**:
- Check `err instanceof CleoError` first and preserve the original exit code via `getExitCodeName`
- Fall back to `E_GENERAL` for non-CleoError exceptions
- Safely handle non-Error thrown values with `String(err)`

Test: `src/dispatch/engines/__tests__/session-handoff-fix.test.ts` (7 tests)
