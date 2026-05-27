# T1008 Worker Specification — Tier 2 cleo propose CLI + Ingesters + DB Rate Limiter

**Lead**: Lead C (sentient-autonomy)
**Epic**: T1007 — Sentient Loop Completion
**Session**: ses_20260419003330_22e46b
**Date**: 2026-04-19

---

## 1. Scope Summary

T1008 ships the Tier 2 proposal surface: the `cleo propose` CLI verbs, three ingester
functions that feed proposal candidates from BRAIN / nexus / test data, and a
DB-enforced rate limiter (UNIQUE INDEX, not in-memory). It does NOT touch any
auto-merge, sandbox, or signing logic — those are Tier 3 and are HARD BLOCKED on
Epic A (T991: T992+T993+T995).

T1008 has NO dependency on T1009-T1012 or on the Epic A write-path guardrails.
The proposer is a read-only consumer of brain.db and nexus.db; it writes only
`tasks.db` (new rows with `status='proposed'`). This is safe before T992/T993/T995
land because T1008 reads existing data — it does not contribute noise back into
the write path.

---

## 2. Concrete File Scope

### New files (must create)

| File | Purpose |
|---|---|
| `packages/cleo/src/sentient/propose-tick.ts` | Single-pass proposer that runs inside the daemon cron (or standalone via `cleo propose run`); calls all three ingesters, deduplicates candidates, applies rate limit, writes tasks |
| `packages/cleo/src/sentient/ingesters/brain-ingester.ts` | Queries brain.db for recurring-pain observations (citation_count >= 3, last 7 days, quality_score >= 0.5); returns ranked `ProposalCandidate[]` |
| `packages/cleo/src/sentient/ingesters/nexus-ingester.ts` | Queries nexus.db for flow anomalies: zero-import symbols with `relations.kind='calls'` but no reverse caller, over-coupled clusters (degree > 2x cluster mean); returns ranked `ProposalCandidate[]` |
| `packages/cleo/src/sentient/ingesters/test-ingester.ts` | Reads `.cleo/audit/gates.jsonl` for `failCount>0` entries and the vitest coverage JSON (if present at `.cleo/coverage-summary.json`) for files with `<80%` line coverage; returns ranked `ProposalCandidate[]` |
| `packages/cleo/src/sentient/proposal-rate-limiter.ts` | Encapsulates the UNIQUE INDEX guard: `INSERT OR IGNORE` into a helper view; exports `countTodayProposals(db)` and `isRateLimitExceeded(db, limit=3)` |
| `packages/cleo/src/dispatch/domains/sentient.ts` | New dispatch domain handler: operations `propose.list`, `propose.accept`, `propose.reject`, `propose.diff` |
| `packages/cleo/src/sentient/__tests__/propose-tick.test.ts` | Propose tick unit tests |
| `packages/cleo/src/sentient/__tests__/brain-ingester.test.ts` | BRAIN ingester unit tests |
| `packages/cleo/src/sentient/__tests__/nexus-ingester.test.ts` | Nexus ingester unit tests |
| `packages/cleo/src/sentient/__tests__/test-ingester.test.ts` | Test ingester unit tests |
| `packages/cleo/src/sentient/__tests__/proposal-rate-limiter.test.ts` | Rate limiter unit tests |

### Modified files

| File | Change |
|---|---|
| `packages/cleo/src/cli/commands/sentient.ts` | Add `propose list/accept/reject/diff` subcommands to the `cleo sentient propose` sub-group (parallels existing `start/stop/status/tick`) |
| `packages/cleo/src/dispatch/domains/index.ts` | Register `new SentientHandler()` at key `'sentient'` |
| `packages/cleo/src/sentient/daemon.ts` | Wire `safeRunProposeTick()` into the existing cron handler as a second pass after `safeRunTick()`; gated by `state.tier2Enabled === true` (new boolean field on `SentientState`) |
| `packages/cleo/src/sentient/state.ts` | Add `tier2Enabled: boolean` (default `false`) and `tier2Stats: { proposalsGenerated, proposalsAccepted, proposalsRejected }` to `SentientState` |
| `packages/contracts/src/index.ts` | Export `ProposalCandidate` and `ProposedTaskMeta` interfaces |

---

## 3. Approach

### 3.1 cleo propose integration with the daemon tick loop

The Tier 1 tick (`runTick`) runs on the `*/5 * * * *` cron. Tier 2 propose runs
on a SEPARATE cron expression `0 */2 * * *` (every 2 hours) to avoid proposal
flooding. Both are registered in `daemon.ts` as independent `node-cron` tasks.

The propose pass is:

```
proposeTick
  1. Check killSwitch → abort if true
  2. isRateLimitExceeded(db, 3) → abort if true (DB enforced)
  3. Run all three ingesters in parallel (Promise.all)
  4. Merge + deduplicate candidates by fingerprint (title hash)
  5. Score candidates with weighted formula (see §3.2)
  6. Take top-N candidates (N = 3 - countTodayProposals())
  7. For each candidate: INSERT task with status='proposed', meta->'proposedBy'='sentient-tier2'
  8. Check killSwitch again before writing
  9. Update tier2Stats
```

This is deliberately NOT integrated into the Tier 1 `runTick` function to keep
the tick loop simple and testable in isolation. `safeRunProposeTick` is a sibling
export from `propose-tick.ts`.

### 3.2 DB rate limit design

Per the T1008 acceptance criterion, the rate limit is a UNIQUE INDEX constraint,
NOT an in-process counter. This closes Round 2 contrarian attack #7 ("rate-limit
enforcement locus — in-process counter survives daemon restart but two daemon
instances would both allow 3/day").

Schema addition in tasks.db (applied via a new migration):

```sql
-- Partial index: only rows where meta JSON contains proposedBy = sentient-tier2
CREATE UNIQUE INDEX IF NOT EXISTS sentient_proposal_day
  ON tasks(date(created_at))
  WHERE json_extract(meta, '$.proposedBy') = 'sentient-tier2'
    AND status = 'proposed';
```

Wait — SQLite partial unique indexes enforce one row per key value across the
partial set. Because we want up to 3 per day (not 1), the index alone cannot
enforce a count-based limit. The correct approach is:

1. Before each INSERT, run:
   ```sql
   SELECT COUNT(*) FROM tasks
   WHERE json_extract(meta, '$.proposedBy') = 'sentient-tier2'
     AND status IN ('proposed', 'pending', 'active', 'done')
     AND date(created_at) = date('now')
   ```
2. If count >= 3, abort with `E_RATE_LIMIT_EXCEEDED`.
3. The COUNT query runs INSIDE a BEGIN IMMEDIATE transaction with the INSERT,
   preventing TOCTOU race between two parallel daemon instances (advisory lock
   via `sentient.lock` from daemon.ts also prevents this in practice, but the
   transaction is the belt-and-suspenders guard).

The `sentient.lock` advisory lock (already implemented in `daemon.ts`) is the
primary parallel-daemon collision guard per the T1008 acceptance criterion. The
transactional count check is the secondary guard. Both are required.

The acceptance criterion text `UNIQUE INDEX sentient_proposal_day ON tasks((date(created_at))) WHERE meta->>'proposedBy'='sentient-tier2' LIMIT 3/day` is aspirational SQL — SQLite does not support `LIMIT` in CREATE INDEX. The transactional count approach is the correct implementation.

### 3.3 BRAIN ingester

Input: `brain.db` via `getBrainNativeDb(projectRoot)` (already used in memory domain).

Query:

```sql
SELECT id, title, text, citation_count, quality_score
FROM brain_observations
WHERE type IN ('bugfix', 'decision')
  AND citation_count >= 3
  AND created_at >= datetime('now', '-7 days')
  AND quality_score >= 0.5
ORDER BY citation_count DESC, quality_score DESC
LIMIT 10
```

This surfaces recurring pains (high citation = multiple agents cited the same
issue) and high-quality decisions that may need a follow-on task.

Output: `ProposalCandidate[]` with fields `{ source: 'brain', sourceId, title, rationale, weight }`.

Weight formula: `(citation_count / 10) * quality_score` capped at 1.0.

### 3.4 Nexus ingester

Input: `nexus.db` via `getNexusDb()` (global DB, already used in nexus domain).

Two queries:

**Query A — orphaned callee (zero-import but has callers):**
```sql
SELECT n.id, n.name, n.file_path, COUNT(r.id) as caller_count
FROM nexus_nodes n
JOIN nexus_relations r ON r.target_id = n.id AND r.kind = 'calls'
WHERE NOT EXISTS (
  SELECT 1 FROM nexus_relations r2
  WHERE r2.source_id = n.id AND r2.kind = 'calls'
)
AND n.kind = 'function'
GROUP BY n.id
HAVING caller_count > 5
ORDER BY caller_count DESC
LIMIT 5
```

**Query B — high-degree nodes (potential over-coupling):**
```sql
SELECT n.id, n.name, n.file_path, COUNT(r.id) as degree
FROM nexus_nodes n
JOIN nexus_relations r ON r.source_id = n.id OR r.target_id = n.id
GROUP BY n.id
HAVING degree > 20
ORDER BY degree DESC
LIMIT 5
```

Candidates from nexus have lower weight (0.3 base) since they're structural signals
rather than observed runtime pain.

### 3.5 Test ingester

Two data sources:

**Source A — gates.jsonl failCount:**
Read `.cleo/audit/gates.jsonl` (JSONL). Each line is a gate record. Parse and
group by `taskId`. For tasks with `failCount > 0` in any gate, emit a candidate
suggesting "add flaky-test guard for T###".

**Source B — vitest coverage:**
Check for `.cleo/coverage-summary.json` (written by `vitest --coverage` when
`coverageReporter: json-summary` is set). If present, find files where
`lines.pct < 80`. Emit candidates suggesting coverage improvement.

If coverage file is absent, emit zero candidates from Source B (do NOT fail).

### 3.6 Prompt hygiene (injection defense)

Per the T1008 acceptance criterion: "Prompt-hygiene pass at proposal ingest:
structured-field extraction only (no tools/memory read from proposer agent)."

This means the proposer does NOT call an LLM. All candidates come from structured
DB/file queries. The `title` field of each proposal is constructed programmatically
from templates:

- BRAIN: `"[T2-BRAIN] Recurring issue: {brain_entry_title}"`
- Nexus: `"[T2-NEXUS] Over-coupled symbol: {symbol_name} ({caller_count} callers)"`
- Test: `"[T2-TEST] Increase coverage: {file_path} ({pct}% lines)"`

No freeform LLM-generated text enters the `tasks.title` column from the Tier 2
proposer. This defeats the prompt-injection P0 escalation attack described in
the ROUND2-SYNTHESIS: an agent that can write arbitrary titles could smuggle
instructions into the next agent's spawn prompt via task title.

### 3.7 cleo propose CLI verbs

The `cleo sentient propose` subcommand group (added to `sentient.ts`):

| Verb | Operation | Description |
|---|---|---|
| `cleo sentient propose list` | `sentient.propose.list` | Show all tasks with status='proposed', sorted by weight desc |
| `cleo sentient propose accept <id>` | `sentient.propose.accept` | Transition task from proposed → pending (owner action) |
| `cleo sentient propose reject <id>` | `sentient.propose.reject` | Transition task from proposed → cancelled |
| `cleo sentient propose diff <id>` | `sentient.propose.diff` | Show what would change if the proposal were accepted (for content-diff proposals, which are out of Tier 2 scope but the verb is registered now for Tier 3 extension) |
| `cleo sentient propose run` | `sentient.propose.run` | Manually trigger a single propose tick in-process (no daemon required; for owner testing) |

All verbs emit LAFS envelopes. `--json` flag available on all.

The new `SentientHandler` in `packages/cleo/src/dispatch/domains/sentient.ts`
handles these operations. It is registered in `index.ts` as domain `'sentient'`.

---

## 4. Tests (≥5 per area)

### 4.1 propose CLI tests (`propose-tick.test.ts`)

1. `runProposeTick` returns `{ kind: 'killed' }` when killSwitch is active before any ingester call
2. `runProposeTick` returns `{ kind: 'rate-limited', count: 3 }` when `countTodayProposals(db) >= 3`
3. `runProposeTick` with mocked ingesters returning 5 candidates inserts exactly `(3 - existingCount)` tasks
4. `runProposeTick` sets `status='proposed'` and `meta.proposedBy='sentient-tier2'` on inserted tasks
5. `runProposeTick` deduplicates candidates with identical fingerprints (same source + sourceId) — writes only one
6. `runProposeTick` returns `{ kind: 'killed' }` on killSwitch flip between ingester phase and write phase
7. Proposal title format is validated: no freeform text, must match template pattern `/^\[T2-(BRAIN|NEXUS|TEST)\]/`

### 4.2 BRAIN ingester tests (`brain-ingester.test.ts`)

1. Returns empty array when no brain_observations match criteria (citation_count < 3)
2. Returns entries where citation_count >= 3 AND created_at within 7 days AND quality_score >= 0.5
3. Excludes entries older than 7 days even if citation_count >= 3
4. Computes weight correctly: `(citation_count / 10) * quality_score` capped at 1.0
5. Returns at most 10 candidates sorted by weight descending
6. Handles getBrainNativeDb failure gracefully (returns empty array + logs warning)

### 4.3 Nexus ingester tests (`nexus-ingester.test.ts`)

1. Returns empty array when nexus.db has no nodes matching Query A (no high-caller orphans)
2. Query A returns orphaned callees with caller_count > 5
3. Query B returns over-coupled nodes with degree > 20
4. Merges Query A + B results into single candidate list without duplication
5. Assigns base weight 0.3 to all nexus candidates regardless of degree
6. Handles nexus.db absence gracefully (returns empty array)

### 4.4 Test ingester tests (`test-ingester.test.ts`)

1. Returns empty array when gates.jsonl is absent
2. Parses gates.jsonl and emits one candidate per task with failCount > 0
3. Returns empty array for Source B when coverage-summary.json is absent (no error thrown)
4. Coverage source: emits candidate for file with lines.pct < 80
5. Coverage source: does NOT emit candidate for file with lines.pct >= 80
6. Title format for gate-fail candidate: `[T2-TEST] Fix flaky gate: {taskId}.{gateName}`

### 4.5 Rate limiter tests (`proposal-rate-limiter.test.ts`)

1. `countTodayProposals(db)` returns 0 on fresh DB
2. `countTodayProposals(db)` returns correct count after inserting 2 proposed tasks with today's timestamp
3. `countTodayProposals(db)` excludes proposed tasks from prior days
4. `isRateLimitExceeded(db, 3)` returns false when count is 2
5. `isRateLimitExceeded(db, 3)` returns true when count is 3
6. Transactional INSERT + COUNT prevents TOCTOU: two concurrent inserts where count=2 result in exactly one insert (simulated via sequential BEGIN IMMEDIATE transactions in test)
7. `countTodayProposals` counts tasks in terminal states (pending/active/done) that were proposed today — accepted proposals still count toward the daily cap

---

## 5. Evidence Atoms (ADR-051)

Before `cleo complete T1008`, the implementing worker MUST provide:

```bash
cleo verify T1008 --gate implemented \
  --evidence "commit:<sha>;files:packages/cleo/src/sentient/propose-tick.ts,packages/cleo/src/sentient/ingesters/brain-ingester.ts,packages/cleo/src/sentient/ingesters/nexus-ingester.ts,packages/cleo/src/sentient/ingesters/test-ingester.ts,packages/cleo/src/sentient/proposal-rate-limiter.ts,packages/cleo/src/dispatch/domains/sentient.ts,packages/cleo/src/cli/commands/sentient.ts,packages/cleo/src/sentient/state.ts,packages/cleo/src/sentient/daemon.ts,packages/contracts/src/index.ts"

cleo verify T1008 --gate testsPassed --evidence "tool:pnpm-test"

cleo verify T1008 --gate qaPassed --evidence "tool:biome;tool:tsc"

cleo verify T1008 --gate documented \
  --evidence "files:packages/cleo/src/sentient/propose-tick.ts"

cleo verify T1008 --gate securityPassed \
  --evidence "note:proposer is read-only (no tools/memory/LLM), structured-field output only, rate limit is transactional DB check, advisory lock prevents parallel daemon collision"

cleo verify T1008 --gate cleanupDone \
  --evidence "note:no experimental branches; Tier 3 scope explicitly excluded"
```

---

## 6. Round 2 Contrarian Attack Analysis — Tier 2 Applicability

The 11 Round 2 contrarian attacks were identified against T946 (Tier 1+2+3 bundle).
Below is each attack with a disposition for T1008 (Tier 2 only).

| # | Attack | T1008 Disposition |
|---|---|---|
| 1 | Sandbox RO mount theatrical — agent runs on host RW | NOT APPLICABLE. T1008 has no sandbox. There is no mount. |
| 2 | Receipts.jsonl hash chain locally-rewriteable | NOT APPLICABLE. T1008 proposal receipts are `tasks` DB rows, not a JSONL file. DB rows are harder to tamper (WAL + process lock). No hash chain needed for Tier 2. |
| 3 | Ed25519 mode-0600 insufficient — prompt-injected agent reads as same user | PARTIALLY APPLICABLE. T1008 does NOT sign proposals (no keys involved). However, the attack vector is generalized as "proposer could be prompt-injected to escalate." MITIGATED: proposal titles are programmatic templates only. No LLM, no freeform text, no tool calls from proposer. |
| 4 | Baseline gameable — written by the experiment agent itself | NOT APPLICABLE. T1008 does not create baselines. Tier 3 only. |
| 5 | Status='proposed' picker race — picker at dependency-check.ts:103-113 only excludes done/cancelled | DIRECTLY APPLICABLE. MITIGATED per T946 Wave B: `dependency-check.ts` lines 101 and 122 already exclude `status='proposed'` from `getUnblockedTasks` and `getReadyTasks`. T1008 MUST verify this exclusion is still present before shipping. |
| 6 | In-process rate limit survives restart but two daemon instances both allow 3/day | DIRECTLY APPLICABLE. MITIGATED: T1008 uses transactional DB count check (not in-process counter). Advisory lock (`sentient.lock`) prevents two daemon instances. See §3.2. |
| 7 | Rate-limit enforcement locus — enforcement in wrong layer | DIRECTLY APPLICABLE. MITIGATED: enforcement is in tasks.db via a BEGIN IMMEDIATE transaction wrapping COUNT + INSERT. This is the "enforcement locus" fix. |
| 8 | FF-only merge with abort-on-fail — no auto-rebase | NOT APPLICABLE. T1008 does not merge. Tier 3 only. |
| 9 | Kill-switch re-check at every tick step | PARTIALLY APPLICABLE. T1008 propose tick must re-check killSwitch at the same checkpoints as `runTick`: before ingesters, after ingesters, before DB write. This is already specified in §3.1. |
| 10 | Severity-write gated — severity is OWNER-WRITE-ONLY via cleo bug severity gated by credential | NOT APPLICABLE TO PROPOSE WRITE PATH. T1008 proposals set `priority='medium'` unconditionally. They do NOT write severity (severity is bug-specific per T944). |
| 11 | llmtxt/identity not wired — Ed25519 from-scratch | NOT APPLICABLE. T1008 does not sign anything. Signing is Tier 3 (T1010). |

**Summary**: Attacks 5, 6, 7, 9 apply to Tier 2. All are mitigated in the design above.
Attacks 1, 2, 4, 8, 10, 11 are Tier 3 concerns. Attack 3 is mitigated by structured-field-only output.

---

## 7. Tier 3 Blocker Declaration

**T1009, T1010, T1011, T1012 are HARD BLOCKED.**

These four tasks MUST NOT be decomposed or started until ALL of the following land:

| Blocker | Task | Why |
|---|---|---|
| `verifyAndStore` route for observeBrain | T992 | Tier 3 baseline signing needs trustworthy brain entries. If the write path is noisy, the signed baseline captures garbage. |
| Title-prefix blocklist in verifyCandidate | T993 | Tier 3 agent reads proposed task titles to understand experiment scope. Without blocklist, injected titles propagate into the sandbox agent's context. |
| Step 9f hard-sweeper | T995 | Tier 3 auto-merge must read from a clean proposal queue. Noise entries surviving the sweeper would trigger spurious experiments. |

Until T992+T993+T995 are `status=done`, the correct labels for T1009-T1012 are:

```
blocked-on-T992,blocked-on-T993,blocked-on-T995
```

These labels should be applied via `cleo update T1009 --labels "blocked-on-T992,blocked-on-T993,blocked-on-T995"` (and equivalent for T1010-T1012) by the orchestrator after this decomposition is accepted.

---

## 8. Quality Gates Summary

| Gate | Requirement | Notes |
|---|---|---|
| implemented | All 10 new/modified files committed | See evidence atoms §5 |
| testsPassed | 35+ tests green (≥5 per area × 5 areas, plus existing sentient tests) | `pnpm run test` from repo root |
| qaPassed | biome clean + tsc 0 errors | `pnpm biome check --write .` then `pnpm run build` |
| documented | TSDoc on all exports in propose-tick.ts and sentient.ts additions | Required per CLAUDE.md |
| securityPassed | No LLM calls from proposer; all structured fields; see note in §5 | |
| cleanupDone | No dead code; Tier 3 scope explicitly excluded from all files | |

---

## 9. Key Implementation Warnings

1. **Do NOT implement domain routing for `sentient` as a sub-key of `tasks`.** The `propose.list/accept/reject` operations act on tasks but logically belong to the sentient domain. Register as a first-class domain `sentient` in `createDomainHandlers()`.

2. **Do NOT call any LLM from the proposer.** The entire pipeline is structured-field SQL queries → template-formatted titles → DB INSERT. Any LLM call would reopen the prompt-injection attack vector.

3. **`status='proposed'` enum value was confirmed added in Wave B** (T946). Before writing to it, verify it exists in `TASK_STATUSES` in `packages/core/src/store/tasks-schema.ts`. Do not add it again.

4. **Advisory lock (`sentient.lock`) is ALREADY implemented in `daemon.ts`**. The propose tick runs under the same lock — do not create a second lock. Just add `safeRunProposeTick()` inside the existing lock scope.

5. **`tier2Enabled` defaults to `false`**. The daemon MUST NOT auto-enable Tier 2 on upgrade. Owner enables via `cleo sentient propose enable` (can be a simple `cleo update` to state file or a dedicated subcommand). Tier 2 is off-by-default to avoid surprising proposal floods on first daemon start.
