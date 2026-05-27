# T1263 Explorer Map — Session-Journal Substrate (E6 · v2026.4.130)

**Generated**: 2026-04-24 (read-only deep-mapping)
**Context**: T-COUNCIL-RECONCILIATION-2026-04-24 — T1262 CLI + session-end hook absorbed into T1263 (detector itself shipped read-only in .126)

---

## TL;DR (5 bullets)

- `.cleo/session-journals/` does NOT exist. No session-journal JSONL writer exists. Feature is entirely greenfield.
- `cleo session end` already has a rich 7-stage hook pipeline (backup → consolidation → observer → reflector → transcript-schedule). T1263 adds an 8th hook at priority 2 (runs after transcript-schedule at priority 3).
- `cleo memory doctor` is FULLY SHIPPED: `packages/core/src/memory/brain-doctor.ts`, dispatch case at `packages/cleo/src/dispatch/domains/memory.ts:404`, CLI at `packages/cleo/src/cli/commands/memory.ts:1690`. `--assert-clean` flag wired. T1263 absorbs only the session-end hook that calls `scanBrainNoise` and appends a journal entry.
- Existing JSONL append pattern: `packages/core/src/tasks/gate-audit.ts` (`appendFile` + `mkdir recursive` + single JSON line + `\n`). Journal writer copies pattern verbatim.
- Hook insertion point: `packages/core/src/hooks/handlers/session-hooks.ts` — add `handleSessionEndJournal` and register `{ id: 'journal-session-end', event: 'SessionEnd', priority: 2 }`.

---

## 1. Current Session Lifecycle Surface

### 1.1 CLI Entry Points

| Command | File | Handler |
|---------|------|---------|
| `cleo session start` | `packages/cleo/src/cli/commands/session.ts:31` | `dispatchFromCli('mutate','session','start',...)` |
| `cleo session end` | `packages/cleo/src/cli/commands/session.ts:181` | `dispatchFromCli('mutate','session','end',...)` |
| `cleo session status` | `packages/cleo/src/cli/commands/session.ts` | `dispatchFromCli('query','session','status',...)` |
| `cleo memory doctor` | `packages/cleo/src/cli/commands/memory.ts:1690` | `dispatchFromCli('query','memory','doctor',{assert-clean})` |

### 1.2 Domain Handler

`packages/cleo/src/dispatch/domains/session.ts` — `end` op at line 303 calls `sessionEnd → sessionComputeDebrief → persistSessionMemory → refreshMemoryBridge`. Thin typed dispatcher; business logic in engine layer.

### 1.3 Engine Layer

- Dispatch-side: `packages/cleo/src/dispatch/engines/session-engine.ts` — `sessionEnd()` at line 534
- Core-side: `packages/core/src/sessions/index.ts` — `endSession()` at line 238 (canonical impl); fires `SessionEnd` hook awaited at line 280

### 1.4 Where Debrief/Handoff Captured Today

- `debriefJson` and `handoffJson` stored as JSON strings on `Session` row in `tasks.db` via `accessor.upsertSingleSession()`
- `computeDebrief()` / `computeHandoff()` called in `session-engine.ts` after `sessionEnd()`, persisted via `persistSessionMemory()` → brain.db observations (type: `session_summary`)
- No JSONL file exists; debrief lives only in SQLite

### 1.5 Existing JSONL Patterns

| File | Path | Pattern |
|------|------|---------|
| `packages/core/src/tasks/gate-audit.ts:130` | `.cleo/audit/gates.jsonl` | `appendFile` + `mkdir recursive` + JSON line + `\n` |
| `packages/core/src/sessions/agent-session-adapter.ts:349` | `.cleo/audit/receipts.jsonl` | Same pattern |
| `packages/core/src/sessions/session-grade.ts` | `.cleo/audit/grades.jsonl` (inferred) | Same via `appendGradeResult` |

T1263 journal writer = new module `packages/core/src/sessions/session-journal.ts` copying this pattern.

---

## 2. Session-End Hook Plumbing

### 2.1 Hook Registry

`packages/core/src/hooks/registry.ts`. Hooks auto-register at module load via `hooks.register({ id, event, handler, priority })`.

### 2.2 SessionEnd Hook Pipeline (Current Priority Order)

| Priority | ID | Effect |
|----------|----|---------|
| 100 | `brain-session-end` | Grade session, transcript extraction, memory bridge refresh |
| 10 | `backup-session-end` | `VACUUM INTO` snapshot of tasks.db + brain.db |
| 5 | `consolidation-session-end` | `setImmediate` consolidation pipeline |
| 4.5 | `observer-session-end` | `setImmediate` Observer (threshold=1) |
| 4 | `reflector-session-end` | `setImmediate` Reflector synthesis |
| 3 | `transcript-schedule-session-end` | `setImmediate` writes tombstone to brain_observations |

**T1263 inserts at priority 2** — runs LAST, **synchronous await needed** so CLI doesn't exit before journal write completes:

```typescript
hooks.register({
  id: 'journal-session-end',
  event: 'SessionEnd',
  handler: handleSessionEndJournal,
  priority: 2,
});
```

### 2.3 Handler Design

In `packages/core/src/hooks/handlers/session-hooks.ts`:
- `handleSessionEndJournal(projectRoot, payload: SessionEndPayload)` — has `payload.sessionId`, `payload.duration`, `payload.tasksCompleted`, `payload.providerId`
- MUST `await` (NOT `setImmediate`) — process exits immediately after; setImmediate would drop the write
- Calls `scanBrainNoise(projectRoot)` and embeds doctor summary (T1262 absorption)

### 2.4 HMAC Signing — Not Needed

Recommendation: no signing in initial implementation. Pure JSONL append sufficient for training corpus. `agent-session-adapter.ts` receipts already provide tamper-evident chain at session level. If needed later, import `signAuditLine` from `cleo-identity.ts` (same pattern as `appendSignedGateAuditLine`).

---

## 3. Memory-Doctor CLI Surface (T1262 Absorbed)

### 3.1 What Shipped in .126

All three layers complete:

| Layer | File | Status |
|-------|------|--------|
| Core scanner | `packages/core/src/memory/brain-doctor.ts` | **SHIPPED** — `scanBrainNoise(projectRoot)` returns `BrainDoctorResult` |
| Dispatch op | `packages/cleo/src/dispatch/domains/memory.ts:404` | **SHIPPED** — `case 'doctor':` with `--assert-clean` exit-non-zero |
| CLI command | `packages/cleo/src/cli/commands/memory.ts:1690` | **SHIPPED** — `doctorCommand` with `--assert-clean` + `--json` |

### 3.2 What T1263 Adds for T1262 Absorption

Council verdict: "T1262 CLI surface + session-end hook absorbed into E6." CLI surface already shipped. T1263 adds:
1. **Session-end hook** calling `scanBrainNoise` and writing compact doctor-summary into each session journal entry
2. **Journal entry `doctorSummary` field** (`{ isClean, findingsCount, patterns[] }`)
3. No new CLI commands — `cleo memory doctor` already exists

### 3.3 `--assert-clean` and M7 Gate

M7 mechanism already implemented:
- `memory.doctor` dispatch case (line 408): `if (assertClean && !result.isClean) return errorResult('E_BRAIN_NOISE_DETECTED', ...)`
- CLI `doctorCommand` passes `assert-clean` to dispatch
- M7 wiring into `sentient propose enable` is T1148 W8 work (not T1263)

---

## 4. JSONL Schema Design

### 4.1 Proposed Schema

```typescript
interface SessionJournalEntry {
  // Identity
  schemaVersion: '1.0';
  timestamp: string;            // ISO 8601
  sessionId: string;
  eventType: 'session_start' | 'session_end' | 'observation' | 'decision' | 'error';

  // Session metadata (start/end)
  agentIdentifier?: string;
  providerId?: string;
  scope?: string;               // 'global' or 'epic:T###'

  // Session-end specific
  duration?: number;            // seconds
  tasksCompleted?: string[];    // task IDs only (privacy)

  // Doctor summary (T1262 absorbed)
  doctorSummary?: {
    isClean: boolean;
    findingsCount: number;
    patterns: string[];
    totalScanned: number;
  };

  // Debrief summary
  debriefSummary?: {
    noteExcerpt?: string;       // first 200 chars
    tasksCompletedCount: number;
    tasksFocused?: string[];    // up to 5 task IDs
  };

  // Optional hash chain
  prevEntryHash?: string;       // SHA-256 of previous line's raw JSON
}
```

### 4.2 File Naming

Daily rotation: `.cleo/session-journals/YYYY-MM-DD.jsonl`. Multiple sessions append to same daily file (atomic per Node.js `O_APPEND` for sub-4KB writes).

### 4.3 Path Helper

```typescript
export function getSessionJournalPath(projectRoot: string, date?: Date): string {
  const d = date ?? new Date();
  const dateStr = d.toISOString().slice(0, 10);
  return resolvePath(projectRoot, '.cleo', 'session-journals', `${dateStr}.jsonl`);
}
```

---

## 5. Meta-Agent Integration at `cleo init`

### 5.1 Current Flow

T1259 E2 added meta-agent install in `cleo init`. `installSeedAgents` option at `init.ts:80` invokes agent-architect (or static fallback).

### 5.2 Journal Reading at Init

Pattern:
1. End of `initProject()` in `packages/core/src/init.ts` — best-effort read of N most recent session journal entries (N=5 default, configurable via `config.sessionJournal.recentCount`)
2. Return `recentJournalSummary` in `InitResult.sessionContext`
3. CLI dispatcher surfaces this in LAFS envelope `data` field

**File to modify**: `packages/core/src/init.ts` — add `readRecentJournals(projectRoot, count)` near end.

### 5.3 Read pattern

```
.cleo/session-journals/
  2026-04-24.jsonl       ← today
  2026-04-23.jsonl       ← yesterday
  ...
```

Meta-agent reads 3 most recent dated files, up to 20 lines total.

---

## 6. Retention Policy

ADR-013 §9 spirit. Pattern from `sqlite-backup.ts`: `MAX_SNAPSHOTS = 10` per database, oldest rotated out.

**Proposed JSONL retention**:

| Tier | Age | Disposition |
|------|-----|-------------|
| Hot | 0–7 days | All entries retained verbatim |
| Warm | 8–30 days | Retain `session_end` entries only |
| Archive | 31–90 days | Monthly rollup; individual files deleted |
| Purge | >90 days | Delete monthly rollups |

**Implementation**: `rotateSessionJournals(projectRoot)` called from `SessionEnd` hook at priority 1, or from `sessionGc()` in `session-engine.ts` (already has `maxAgeDays`). No schema migration — files deleted at filesystem level.

---

## 7. Atomic Decomposition Proposal (7 worker tasks)

### T1263-C1 — `session-journal.ts` core module (small)
**Files**: `packages/core/src/sessions/session-journal.ts` (new)
**Scope**: `getSessionJournalPath()`, `appendSessionJournalEntry()`, `SessionJournalEntry` type, `readRecentJournals(projectRoot, count)`
**ACs**: exports compile, append atomic, directory auto-created, type exported from `internal.ts` barrel

### T1263-C2 — Session-end hook + doctor integration (small-medium)
**Files**: `packages/core/src/hooks/handlers/session-hooks.ts` (modify)
**Scope**: `handleSessionEndJournal(projectRoot, payload)` — calls `scanBrainNoise`, builds entry, appends; registers at priority 2
**ACs**: hook fires on `cleo session end`, entry written, doctor summary embedded, synchronous await (no setImmediate)

### T1263-C3 — Session-start journal entry (small)
**Files**: `packages/core/src/sessions/index.ts` (modify `startSession`)
**Scope**: After `hooks.dispatch('SessionStart', ...)`, append `session_start` entry. Best-effort.
**ACs**: `cleo session start` produces journal entry with `eventType:'session_start'`, `agentIdentifier`, `providerId`, `scope`

### T1263-C4 — Schema documentation + Zod/type enforcement (small)
**Files**: `packages/contracts/src/session-journal.ts` (new), exported from `packages/contracts/src/index.ts`
**Scope**: Zod schema + TS type + `SESSION_JOURNAL_SCHEMA_VERSION = '1.0'`
**ACs**: schema imported in C1+C2; biome+tsc green; TSDoc on all exports

### T1263-C5 — `cleo init` recent-journals integration (small)
**Files**: `packages/core/src/init.ts` (modify), `packages/cleo/src/dispatch/engines/init-engine.ts` (widen return type)
**Scope**: `readRecentJournals(projectRoot, 5)` at end of `initProject()`, returned as `InitResult.sessionContext`; CLI renders summary
**ACs**: `cleo init --json` includes `sessionContext.recentJournals`

### T1263-C6 — Retention policy + `rotateSessionJournals` (small-medium)
**Files**: `packages/core/src/sessions/session-journal.ts` (extend), wire into `sessionGc()`
**Scope**: `rotateSessionJournals(projectRoot, options)` — deletes old per retention policy
**ACs**: files >90 days deleted; warm-tier stripping applied; test verifies rotation

### T1263-C7 — E2E session-to-meta-agent test (medium)
**Files**: `packages/core/src/sessions/__tests__/session-journal.test.ts` (new)
**Scope**: Full lifecycle: start → end → verify journal entry → verify doctor summary → simulate `cleo init` and confirm surfacing
**ACs**: passes with `pnpm run test`; covers happy path + doctor-noise scenario (mock `scanBrainNoise`); covers rotation logic

---

## 8. Risk Callouts

### R1 — JSONL Writer Concurrency (HIGH)
Multiple sessions can run simultaneously (worktree-by-default, ADR-055). Each writes to same daily file. Node `appendFile` uses `O_APPEND` — atomic for single-write calls under ~4 KB on ext4/APFS. **Mitigation**: `mkdir({recursive:true})` before every append (idempotent). Do NOT use shared file handle — each process opens/appends/closes independently.

### R2 — Schema Versioning Forward-Compat (MEDIUM)
`schemaVersion: '1.0'` checked on read. Future versions add fields, never remove. **Mitigation**: version check in `readRecentJournals`; `?? undefined` for optional fields.

### R3 — Privacy: Sensitive Content (HIGH)
Journals embed `noteExcerpt`, `tasksCompleted`, `agentIdentifier`, doctor findings. PII surface for projects with sensitive task names. **Mitigation**: (a) cap noteExcerpt at 200 chars; (b) exclude task TITLES (only IDs); (c) `config.sessionJournal.enabled = true` opt-in (default true); (d) add `.cleo/session-journals/` to `.gitignore` via `ensureGitignore()` in `init.ts`.

### R4 — `brain-doctor.ts` opens `brain.db` — fresh-install handling (LOW)
`scanBrainNoise` calls `getBrainDb` which initializes brain.db if absent. On first `cleo session end` after init, brain.db may be empty. `scanBrainNoise` already handles gracefully (returns `{ isClean: true, totalScanned: 0 }`). Document `totalScanned: 0` = "empty/unavailable" not "clean".

### R5 — `setImmediate` vs synchronous await at session-end (MEDIUM)
Existing hooks priorities 3-5 use `setImmediate` to avoid blocking CLI exit. Journal hook MUST use `await` — last operation before `process.exit`; `setImmediate` would drop the write. **Mitigation**: `await appendSessionJournalEntry(...)` directly inside handler.

### R6 — Pure JSONL (no DB) — N/A
Intentional per spec, avoids WAL synchronization issues. Tradeoff: not SQL-queryable; meta-agent reads as raw JSON lines. Acceptable for "training corpus" use case.

---

## 9. Key Files Reference

| Role | Absolute Path |
|------|---------------|
| Session domain handler | `packages/cleo/src/dispatch/domains/session.ts` |
| Session engine (dispatch) | `packages/cleo/src/dispatch/engines/session-engine.ts` |
| Session core (endSession + hook dispatch) | `packages/core/src/sessions/index.ts` |
| Session CLI commands | `packages/cleo/src/cli/commands/session.ts` |
| SessionEnd hook handlers | `packages/core/src/hooks/handlers/session-hooks.ts` |
| Hook registry | `packages/core/src/hooks/registry.ts` |
| Hook handler barrel (auto-registers) | `packages/core/src/hooks/handlers/index.ts` |
| Brain-doctor scanner (T1262 core) | `packages/core/src/memory/brain-doctor.ts` |
| Memory domain handler | `packages/cleo/src/dispatch/domains/memory.ts` |
| Memory doctor CLI command | `packages/cleo/src/cli/commands/memory.ts:1690` |
| Gate audit JSONL pattern | `packages/core/src/tasks/gate-audit.ts` |
| Receipts JSONL pattern | `packages/core/src/sessions/agent-session-adapter.ts` |
| Session memory bridge (no-op) | `packages/core/src/sessions/session-memory-bridge.ts` |
| SQLite backup retention pattern | `packages/core/src/store/sqlite-backup.ts` |
| Init core (for AC5) | `packages/core/src/init.ts` |
| **NEW (C1)** | `packages/core/src/sessions/session-journal.ts` |
| **NEW (C4)** | `packages/contracts/src/session-journal.ts` |
| **NEW test (C7)** | `packages/core/src/sessions/__tests__/session-journal.test.ts` |
