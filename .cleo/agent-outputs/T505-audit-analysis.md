# CLI Audit: Analysis, Stats & Validation Domain

**Date**: 2026-04-11
**Auditor**: Claude Sonnet 4.6 (CLI audit subagent)
**Scope**: 26 commands across analysis/stats and validation/compliance groups

---

## Summary Table

| # | Command | Exit | Output Shape | Notes |
|---|---------|------|--------------|-------|
| 1 | `cleo analyze` | 0 | `tasks.analyze` — tiers + recommended + metrics | Works. `--autoStart` flag exists but not tested (triggers task work) |
| 2 | `cleo stats` | 0 | `admin.stats` — pending/done counts, completion rate, cycle times | Identical backend to `cleo admin stats` |
| 3 | `cleo history log` | 0 | `admin.log` — paginated operation audit log (3740 entries) | Returns mutable events, not completions only |
| 4 | `cleo history work` | 0 | `tasks.history` — timestamp list of work sessions per task | 223 entries; no duration data, only timestamps |
| 5 | `cleo archive-stats` | 0 | `check.archive.stats` — archived task counts by reason/phase/label | byReason always "unknown" (tasks not being reason-tagged on archive) |
| 6 | `cleo complexity estimate <id>` | 0 | `tasks.complexity.estimate` — score + factors | Requires task ID; no bulk mode |
| 7 | `cleo check schema <type>` | 0 | `check.schema` — valid bool + errors | Found real violation: T298 description >2000 chars |
| 8 | `cleo check coherence` | 0 | `check.coherence` — coherent bool + issues list | Clean on current DB |
| 9 | `cleo check task <id>` | 0 | `check.task` — violations array per rule | Incorrectly flags existing tasks as "duplicate ID" — see bugs |
| 10 | `cleo check output <file>` | — | `check.output` — manifest schema validation | Not live-tested (no output file to hand); help verified |
| 11 | `cleo check chain-validate <file>` | — | `check.chain-validate` — WarpChain JSON validation | Not live-tested (no chain file to hand); help verified |
| 12 | `cleo check protocol <type>` | 6 (no manifest) | `check.protocol` — violations + score | Returns E_VALIDATION_ERROR when no manifest entry; 12 protocol types |
| 13 | `cleo verify <id>` | 0 | `check.gate.status` — gates + passed bool | Different purpose to `check task`; shows gate pass/fail state |
| 14 | `cleo testing validate <id>` | 6 (no manifest) | `check.protocol` (protocolType=testing) | Exact alias of `cleo check protocol testing --taskId <id>` |
| 15 | `cleo testing check <file>` | — | `check.manifest` (type=testing) | Manifest-mode variant of testing validate; help verified |
| 16 | `cleo testing status` | 0 | `check.test` (format=status) — bats/dispatch test availability | Reports bats and dispatch test dirs as unavailable |
| 17 | `cleo testing coverage` | 0 | `check.test` (format=coverage) — coverage data | Reports no coverage data; needs tests run first |
| 18 | `cleo testing run` | 0 (exit), 143 (vitest) | `check.test.run` — actual vitest run via `npx vitest run --reporter=json` | DOES invoke real vitest; vitest timed out with exit 143 (SIGTERM); warnings about vi.hoisted in caamp tests |
| 19 | `cleo compliance summary` | 0 | `check.compliance.summary` (view=summary) | 1 entry total; thin dataset |
| 20 | `cleo compliance violations` | 0 | `check.compliance.summary` (detail=true) | Returns violations array; 0 violations in current data |
| 21 | `cleo compliance trend [days]` | 0 | `check.compliance.summary` (type=trend) | Same backend as summary — view param only |
| 22 | `cleo compliance audit <id>` | 0 | `check.compliance.summary` (type=audit) | Same backend as summary — view param only |
| 23 | `cleo compliance sync` | 0 | `check.compliance.sync` | Writes `.cleo/metrics/GRADES.jsonl`; synced 1 entry |
| 24 | `cleo compliance skills` | 0 | `check.compliance.summary` (type=skills) | Same backend as summary — view param only |
| 25 | `cleo compliance value [days]` | 0 | `check.compliance.summary` (type=value) | Same backend as summary — view param only |
| 26 | `cleo compliance record <id> <result>` | 0 | `check.compliance.record` — recorded bool | Writes to compliance metrics; protocol field accepts free text |
| 27 | `cleo backfill --dryRun` | 0 | `admin.backfill` — tasks scanned + changes | 81 tasks scanned, 0 changes needed; `--tasks` flag allows restriction |

---

## Duplicate / Overlap Analysis

### 1. `cleo stats` vs `cleo admin stats` — EXACT DUPLICATE

Both commands dispatch to the same backend operation (`admin.stats`) and return
identical JSON shapes. The only difference is that `cleo stats` accepts `-p
--period` and `-v --verbose` flags while `cleo admin stats` accepts `--period`.
The `-v --verbose` flag on `cleo stats` is declared in the help output but has
no visible effect in the response payload. **Verdict: `cleo admin stats` is the
canonical form; `cleo stats` is a convenience alias that adds undocumented
flags.**

### 2. `cleo analyze` vs `cleo complexity` — COMPLEMENTARY, NOT DUPLICATE

- `cleo analyze`: fleet-level triage. Returns all tasks ranked into
  critical/high/normal tiers with a recommended task. Backend: `tasks.analyze`.
- `cleo complexity estimate <id>`: single-task deep analysis. Returns a numeric
  score with per-factor breakdown (description length, AC count, dependency
  depth, subtask count, file refs). Backend: `tasks.complexity.estimate`.

These are genuinely different. No action needed.

### 3. `cleo check task <id>` vs `cleo verify <id>` — DIFFERENT CONCERNS

- `cleo check task <id>`: schema/rule validation. Checks field lengths, required
  fields, uniqueness rules. Backend: `check.task`. Currently bugs on existing
  tasks (flags them as duplicate IDs — see Bugs section).
- `cleo verify <id>`: verification gate status. Shows whether implemented /
  testsPassed / qaPassed gates are set. Backend: `check.gate.status`.

Different data, different use cases. No action needed.

### 4. `cleo testing validate <id>` vs `cleo check protocol testing --taskId <id>` — EXACT ALIAS

These are identical at the source level. `testing validate` dispatches to
`check` domain, operation `protocol`, with `protocolType: 'testing'` and
`mode: 'task'`. `check protocol testing --taskId` dispatches the same payload.
Output is byte-for-byte equivalent (verified against T488). **Verdict: one of
these should be removed or one documented as the canonical form.**

### 5. `cleo testing check <file>` vs `cleo check protocol testing --manifestFile <file>` — NEAR ALIAS

`testing check` dispatches to `check.manifest` with `type: 'testing'`.
`check protocol testing --manifestFile` dispatches to `check.protocol` with
`mode: 'manifest'`. These are distinct operations (`check.manifest` vs
`check.protocol`) with slightly different validation paths. Not exact duplicates,
but functionally overlapping for the testing protocol. **Verdict: low priority,
keep both, clarify in help text that `check protocol` is the unified surface.**

### 6. `cleo compliance summary/trend/audit/skills/value` — FIVE VIEWS ON ONE BACKEND

All five of these subcommands (plus `violations`) route to the same backend
operation: `check.compliance.summary`. The backend appends a `view` field to
distinguish them. Differentiation is cosmetic (view param only); no separate
logic executes per view type for trend, audit, skills, or value — the underlying
`validateComplianceSummary` function is called once and the result is tagged.
**This means `compliance trend`, `compliance audit`, `compliance skills`, and
`compliance value` all return the same data set with a different label.**
These commands appear to be placeholder stubs awaiting full backend
differentiation.

### 7. `cleo testing run` — Does it call real `pnpm test`?

No. It calls `npx vitest run --reporter=json` directly via `execFileSync`. It
does NOT invoke the project's `pnpm run test` script. Observed: vitest was
launched but received SIGTERM (exit 143) — likely a timeout. The outer CLI
command returned exit 0 despite vitest failing; the `passed: false` and
`exitCode: 143` are buried inside `data`.

### 8. `cleo history log` vs `cleo archive-stats` — NOT OVERLAPPING

- `history log`: operation audit trail (all CLI mutations, paginated, 3740+
  entries). Backend: `admin.log`.
- `archive-stats`: analytics over the archived tasks table (counts by phase,
  label, priority, cycle times). Backend: `check.archive.stats`.

Different data sources. No action needed.

### 9. `cleo stats compliance` vs `cleo compliance summary` — COMPLETELY DIFFERENT

- `cleo stats compliance`: dispatches to `check.workflow.compliance` — WF-001
  through WF-005 workflow rule enforcement (AC count, session binding, gate
  pass-before-complete). Returns grade + per-rule violation counts.
- `cleo compliance summary`: dispatches to `check.compliance.summary` — reads
  the `compliance-summary.json` file tracking RCASD-IVTR+C protocol check
  results recorded via `cleo compliance record`.

These measure different compliance dimensions. No action needed, but the naming
is confusing: both involve "compliance" but one is workflow rules and the other
is protocol audit records.

---

## Bugs Found

### BUG-1: `cleo check task <id>` incorrectly flags existing tasks as duplicate IDs

**Reproduction**: `cleo check task T483` returns a violation:
```
{"rule":"unique-id","field":"id","message":"Task ID 'T483' already exists","severity":"error"}
```
The command is meant to validate whether a _new_ task with that ID would be
valid. When given an existing task ID, the uniqueness check fires because the
ID already exists in the DB. This makes the command useless for validating
existing tasks — it always fails. The correct behavior would be to validate the
task's own fields (description length, AC count, etc.) without checking
uniqueness against itself. Severity: medium.

### BUG-2: `cleo testing run` exits 0 even when vitest exits non-zero

The CLI command exits 0 regardless of the test runner exit code. The actual
vitest exit code (143 = SIGTERM) is captured inside `data.exitCode` and
`data.passed: false`, but the CLI process itself exits cleanly. Agents relying
on exit codes from `cleo testing run` will falsely believe tests passed.
Severity: high (misleads agent workflows).

### BUG-3: `cleo archive-stats` — `byReason` always shows "unknown"

All 421 archived tasks have `byReason: {unknown: 421}`. Tasks are not being
tagged with an archive reason on completion/archival. The `--byPhase` breakdown
also shows all tasks as "unassigned". The archive-stats feature requires tasks
to carry phase and archive-reason metadata at archival time, which is not
currently happening. Severity: low (feature is non-functional rather than
incorrect).

### BUG-4: `cleo compliance trend/audit/skills/value` return undifferentiated data

As noted above, these four views all call `validateComplianceSummary` and return
the same data payload with only a `view` label appended. For example,
`compliance value` is documented as "Token savings & validation impact" but
returns `{total:1, pass:1, fail:0, passRate:100, byProtocol:{...}, view:'value'}`
— no token savings data at all. These commands are currently stubs. Severity:
medium (misleads agents that expect per-view analytics).

### BUG-5: `cleo check schema todo` reports real violation (T298)

`cleo check schema todo` reports T298 has a description exceeding 2000 chars.
This is a pre-existing data quality issue, not a CLI bug. Surfaced by the audit.
Severity: low (data quality, not CLI defect).

### BUG-6: `cleo history work` returns timestamps only, no durations

`history work` is documented as "time tracked per task" but returns a flat list
of `{taskId, timestamp}` pairs with no duration data. If work is tracked by
start/stop events, the duration computation is not being performed. An agent
reading this command to assess time spent per task would get no useful data.
Severity: medium.

---

## Command Categorization

### Genuinely Distinct Commands (Keep As-Is)

| Command | Purpose |
|---------|---------|
| `cleo analyze` | Fleet triage — which task to work on next |
| `cleo complexity estimate <id>` | Single-task complexity scoring |
| `cleo stats` / `cleo admin stats` | Project counts and completion rate (alias pair) |
| `cleo history log` | Operation audit log (all mutations) |
| `cleo history work` | Work session timestamps per task |
| `cleo archive-stats` | Archived task analytics (currently impaired — BUG-3) |
| `cleo check schema <type>` | Schema field validation across all tasks |
| `cleo check coherence` | Cross-task referential integrity |
| `cleo check task <id>` | Per-task field rule validation (bugged — BUG-1) |
| `cleo check output <file>` | Agent output manifest validation |
| `cleo check chain-validate <file>` | WarpChain JSON validation |
| `cleo check protocol <type>` | 12 RCASD-IVTR+C protocol validators |
| `cleo verify <id>` | Gate pass/fail status (implemented/testsPassed/qaPassed) |
| `cleo compliance sync` | Write metrics to global GRADES.jsonl |
| `cleo compliance record <id> <result>` | Record a protocol check result |
| `cleo backfill` | Retroactively add AC + verification metadata |
| `cleo stats compliance` | WF-001-005 workflow rule violation dashboard |

### Exact / Near Aliases (Redundant)

| Alias | Canonical | Recommendation |
|-------|-----------|----------------|
| `cleo testing validate <id>` | `cleo check protocol testing --taskId <id>` | Remove or redirect; document as alias |
| `cleo stats` | `cleo admin stats` | Add note in help; consider deprecating `cleo stats` as standalone |

### Stub Commands (No Backend Differentiation Yet)

| Command | Status |
|---------|--------|
| `cleo compliance trend` | Returns summary data with `view:'trend'` label only |
| `cleo compliance audit <id>` | Returns summary data with `view:'audit'` label only |
| `cleo compliance skills` | Returns summary data with `view:'skills'` label only |
| `cleo compliance value` | Returns summary data with `view:'value'` label only |
| `cleo compliance violations` | Returns all violations (no severity filtering applied server-side) |

### Impaired Commands (Bugs Prevent Correct Use)

| Command | Bug |
|---------|-----|
| `cleo check task <id>` | BUG-1: always reports "duplicate ID" for existing tasks |
| `cleo testing run` | BUG-2: exits 0 even when vitest fails |
| `cleo archive-stats` | BUG-3: reason/phase metadata never populated |
| `cleo history work` | BUG-6: no duration data, timestamps only |

---

## Recommended Actions

Priority order:

1. **Fix BUG-2** (`cleo testing run` exit code): agents relying on exit codes
   for test gating will silently pass failing test suites. Pass vitest's exit
   code through to the CLI process exit.

2. **Fix BUG-1** (`cleo check task` duplicate-ID false positive): exclude the
   task being validated from the uniqueness check when an existing ID is
   provided.

3. **Remove `cleo testing validate`** or explicitly document it as an alias for
   `cleo check protocol testing --taskId`. The alias creates unnecessary surface
   area without added value.

4. **Implement backend differentiation** for `compliance trend`, `audit`,
   `skills`, `value` subcommands. Currently these are empty promises — they
   return the same aggregate data regardless of which view was requested.

5. **Fix BUG-6** (`cleo history work`): compute and return actual duration per
   task from start/stop event pairs, or rename to `history sessions` to set
   correct expectations.

6. **Populate archive reason on task archival** (BUG-3): `cleo archive-stats`
   is useless until tasks carry a reason code at archival time.
