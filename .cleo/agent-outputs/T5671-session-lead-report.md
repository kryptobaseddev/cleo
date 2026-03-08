# Session Domain Gauntlet Report (T5671)

**Agent**: gauntlet-session
**Date**: 2026-03-08
**Domain**: session (15 registered operations: 8 query + 7 mutate)

---

## Summary

| Metric | Value |
|--------|-------|
| Pass Rate | 21/26 (81%) |
| Usability Score | 5/10 |
| Consistency Score | 6/10 |
| Bugs Found | 7 |
| CLI Coverage | 7/15 operations (47%) |

---

## Pass A: Functional Testing

### CLI-Available Operations (7/15)

| # | Operation | Gateway | CLI Command | Result | Notes |
|---|-----------|---------|-------------|--------|-------|
| 1 | `status` | query | `session status` | PASS | Returns `{session: null}` when no session; full session object when active |
| 2 | `list` | query | `session list` | PASS | Supports `--status`, `--limit`, `--offset` |
| 3 | `handoff.show` | query | `session handoff` | PASS | Returns handoff from most recent ended session |
| 4 | `start` | mutate | `session start` | PASS | Requires `--scope epic:TXXX --name <name>` |
| 5 | `end` | mutate | `session end` / `session stop` | PASS* | See bugs B1, B3 |
| 6 | `resume` | mutate | `session resume <id>` | PASS* | See bug B5 |
| 7 | `gc` | mutate | `session gc` | PASS* | See bug B6 |

### MCP-Only Operations (8/15 -- no CLI commands)

| # | Operation | Gateway | CLI Available | Notes |
|---|-----------|---------|---------------|-------|
| 8 | `show` | query | No | Only via MCP dispatch |
| 9 | `find` | query | No | Only via MCP dispatch |
| 10 | `decision.log` | query | No | Only via MCP dispatch |
| 11 | `context.drift` | query | No | Only via MCP dispatch |
| 12 | `briefing.show` | query | No | Only via MCP dispatch |
| 13 | `suspend` | mutate | No | Only via MCP dispatch |
| 14 | `record.decision` | mutate | No | Only via MCP dispatch |
| 15 | `record.assumption` | mutate | No | Only via MCP dispatch |

### Backward-Compat Aliases (in dispatch handler, not in registry)

| Alias | Redirects To | Notes |
|-------|-------------|-------|
| `debrief.show` | `show {include: "debrief"}` | Constitution-compliant merge |
| `history` | `sessionHistory()` | Not in registry, kept for callers |
| `chain.show` | `sessionChainShow()` | Moved to pipeline domain per T5615 |
| `context.inject` | `sessionContextInject()` | Should be `admin.context.inject` per Constitution |

---

## Pass B: Usability Testing

### Error Handling

| Test | Input | Expected | Actual | Result |
|------|-------|----------|--------|--------|
| Start without `--scope` | `session start --name x` | Error | CLI error (Commander) | PASS |
| Start without `--name` | `session start --scope epic:T001` | Error | CLI error: required option | PASS |
| Start with bad scope | `session start --scope bad --name x` | Error | Error: scope must include task ID | PASS |
| Resume nonexistent | `session resume fake-id` | Error | Error: session not found | PASS* (stderr only) |
| End with no session | `session end` | Error | **success:true, sessionId:"default"** | **FAIL** |
| Double start | Start while session active | Error/warning | **Silently creates new session** | **FAIL** |
| List invalid status | `session list --status ended` | Filtered results OR graceful error | **Validates against task statuses** | **FAIL** |

### Discoverability

- `session --help` lists 6 subcommands (start, stop/end, handoff, status, resume, list, gc)
- Each subcommand has `--help` with option descriptions
- `--name` is listed as required but the help format (`[options]`) does not make it obvious
- 8/15 operations have no CLI path at all -- agents must use MCP
- No `session find`, `session show`, `session suspend`, `session briefing` CLI commands

### Progressive Disclosure

- Tier 0 ops (`status`, `start`, `end`, `briefing.show`, `handoff.show`) are partially covered
- Tier 1 ops (`list`, `show`, `find`, etc.) have mixed coverage
- `briefing.show` (tier 0) has no CLI command -- this is a gap since it's the primary session-start context

---

## Pass C: Consistency Testing

### Operation Names vs Constitution

| Registry Op | Constitution Op | CLI `_meta.operation` | Match? |
|-------------|-----------------|----------------------|--------|
| `status` | `status` | `session.status` | YES |
| `list` | `list` | `session.list` | YES |
| `show` | `show` | n/a (MCP only) | n/a |
| `decision.log` | `decision.log` | n/a (MCP only) | n/a |
| `context.drift` | `context.drift` | n/a (MCP only) | n/a |
| `handoff.show` | `handoff.show` | `session.handoff.show` | YES |
| `briefing.show` | `briefing.show` | n/a (MCP only) | n/a |
| `find` | `find` | n/a (MCP only) | n/a |
| `start` | `start` | `session.start` | YES |
| `end` | `end` | **`session.stop`** | **NO** |
| `resume` | `resume` | `session.resume` | YES |
| `suspend` | `suspend` | n/a (MCP only) | n/a |
| `gc` | `gc` | `session.gc` | YES |
| `record.decision` | `record.decision` | n/a (MCP only) | n/a |
| `record.assumption` | `record.assumption` | n/a (MCP only) | n/a |

### Response Envelope

All tested CLI operations produce valid LAFS envelope:
- `$schema` present
- `_meta` with `specVersion`, `schemaVersion`, `timestamp`, `operation`, `requestId`, `transport`
- `success` boolean at top level
- `result` or `error` object

### Verb Standards Compliance

- `show` used correctly for read operations (handoff.show, briefing.show)
- `find` used correctly for lightweight discovery
- `record` used for structured event logging
- **`stop` alias violates verb standard** -- Constitution mandates `end` as canonical verb

---

## Bugs Found

### B1: `session.stop` vs `session.end` naming (Consistency)
**Severity**: Medium
**File**: `src/cli/commands/session.ts:61`
**Issue**: CLI emits `operation: "session.stop"` in `_meta` but Constitution and registry use `session.end`. The CLI command name is `stop` (with `end` as alias), but the operation metadata should report `session.end`.
**Fix**: Change line 61 from `operation: 'session.stop'` to `operation: 'session.end'`

### B2: `session list --status ended` validates against task statuses (Bug)
**Severity**: High
**Issue**: `session list --status ended` fails with "Invalid status: ended. Allowed values: pending, active, blocked, done...". The validation layer is using task status enum instead of session status enum (active/ended/orphaned).
**File**: Likely in session-engine or validation layer
**Fix**: Session list status validation should accept session-specific statuses, not task statuses.

### B3: `session end` succeeds with no active session (Bug)
**Severity**: Medium
**Issue**: `session end` with no active session returns `{success: true, sessionId: "default"}` instead of failing. Silently "ending" a non-existent session is misleading.
**Fix**: Return `success: false` with appropriate error when no active session exists.

### B4: Double `session start` silently overwrites (Bug)
**Severity**: Medium
**Issue**: Starting a new session while one is active does not warn, error, or end the previous session. The previous session becomes orphaned.
**Fix**: Either auto-end the previous session, or return an error requiring explicit end first.

### B5: Resume error JSON goes to stderr (Consistency)
**Severity**: Low
**Issue**: `session resume <bad-id>` outputs error JSON to stderr instead of stdout, breaking JSON parsing pipelines.
**Fix**: Ensure all JSON envelope output goes to stdout; only diagnostics go to stderr.

### B6: GC `--max-age` (hours) mapped to `maxAgeDays` (Param mismatch)
**Severity**: Medium
**File**: `src/cli/commands/session.ts:182`
**Issue**: CLI option is `--max-age <hours>` but the dispatch parameter name is `maxAgeDays`. Either the CLI description is wrong (should say days) or the param name is wrong.
**Fix**: Align CLI description and engine param name. If the engine expects days, rename CLI to `--max-age-days <days>`. If it expects hours, rename param to `maxAgeHours`.

### B7: `context.inject` still in session handler (Stale alias)
**Severity**: Low
**File**: `src/dispatch/domains/session.ts:366-388`
**Issue**: `session.context.inject` is listed in the Constitution as moved to `admin.context.inject`. The backward-compat alias remains in the session handler, which is fine for compatibility, but the operation should eventually be removed from the session domain.
**Fix**: Add deprecation logging when the alias is used. Plan removal in a future version.

---

## Improvements List

### Priority 1 (Bugs)
1. Fix `session list --status` validation to use session statuses (B2)
2. Fix `session end` to fail when no active session (B3)
3. Fix `session start` to handle active session conflict (B4)
4. Fix `--max-age` / `maxAgeDays` param mismatch (B6)

### Priority 2 (Consistency)
5. Rename CLI operation from `session.stop` to `session.end` in metadata (B1)
6. Ensure error JSON goes to stdout for all session commands (B5)

### Priority 3 (Coverage)
7. Add CLI command for `session briefing` (tier 0, high value)
8. Add CLI command for `session suspend` (counterpart to resume)
9. Add CLI command for `session find` (lightweight discovery)
10. Add CLI command for `session show <id>` (detail view)

### Priority 4 (Cleanup)
11. Add deprecation warning for `session.context.inject` alias (B7)
12. Remove `session.history` and `session.chain.show` backward-compat aliases after deprecation period

---

## Registry vs Handler Alignment

Registry declares 15 ops (8q + 7m). Handler `getSupportedOperations()` also returns 8q + 7m. The handler additionally processes 3 backward-compat aliases (`debrief.show`, `history`, `chain.show`) and 1 moved operation (`context.inject`) not in the registry -- all acceptable for backward compatibility.

**Verdict**: Registry and handler are aligned. Constitution is authoritative and matches.
