# T523-CA1: BRAIN Integrity Specification

**Author**: CA1 — Brain Integrity Architect
**Date**: 2026-04-11
**Status**: COMPLETE
**Epic**: T523 — BRAIN Integrity Crisis
**Task**: CA1

---

## Preamble

This specification covers the complete remediation of brain.db, which as of the R1 audit
contains 2,955 entries with a 0.95% signal-to-noise ratio (28 real entries, 2,927 noise).
The root causes are: (1) broken deduplication blocks that fell through to unconditional
INSERT, (2) O(N) pattern generation on every task completion, and (3) session lifecycle
hooks that write redundant observations to two separate code paths.

This document is the single source of truth for worker agents implementing T523. It is
structured as eight sections covering purge, dedup engine, quality scoring, hook fixes,
auto-pattern redesign, embedding activation, FTS5 integration, and a wave execution plan.

All file paths are absolute. All code paths reference the actual source files confirmed
by reading the live codebase. Workers MUST NOT deviate from the specified approach
without approval.

---

## Section 1: Purge Execution Plan

### 1.1 Pre-Purge Backup (MANDATORY — runs first)

Before any DELETE statement is executed, create a timestamped snapshot of brain.db using
the existing backup infrastructure. This protects against accidental data loss.

```bash
# Step 1: Backup using CLEO CLI (preferred — uses VACUUM INTO)
cleo backup add

# Step 2: Verify backup exists
cleo backup list

# Step 3: Confirm brain.db path (used for all raw SQL below)
# Default: /path/to/project/.cleo/brain.db
```

If `cleo backup add` is unavailable, perform a manual copy:

```bash
# Manual fallback
cp /path/to/project/.cleo/brain.db \
   /path/to/project/.cleo/backups/brain-pre-purge-$(date +%Y%m%d-%H%M%S).db
```

The backup MUST be verified to exist before proceeding to purge steps.

---

### 1.2 Safety Check Queries (runs after backup, before any DELETE)

Run these queries and record counts. They establish the expected before-state.
If counts deviate significantly from the research findings, STOP and flag for review.

```sql
-- Total entry counts
SELECT 'patterns' AS tbl, COUNT(*) AS cnt FROM brain_patterns
UNION ALL SELECT 'learnings', COUNT(*) FROM brain_learnings
UNION ALL SELECT 'decisions', COUNT(*) FROM brain_decisions
UNION ALL SELECT 'observations', COUNT(*) FROM brain_observations;

-- Pattern dedup preview: how many duplicates exist per label text
SELECT pattern, COUNT(*) AS copies
FROM brain_patterns
GROUP BY lower(trim(pattern))
HAVING COUNT(*) > 1
ORDER BY copies DESC
LIMIT 20;

-- Learning noise preview: count of "Completed:" learnings
SELECT COUNT(*) FROM brain_learnings
WHERE insight LIKE 'Completed: %';

-- Decision noise preview
SELECT COUNT(*) FROM brain_decisions
WHERE decision LIKE '%test%' OR rationale LIKE '%test%';
```

Expected baseline (from R1 audit):
- Patterns: ~2,470
- Learnings: ~329
- Decisions: ~5
- Observations: ~151

---

### 1.3 Purge Order and SQL

Execute each category in the listed order. Order matters: pattern dedup (rule 1) must run
before general pattern deletes (rule 2) to avoid accidentally deleting the wrong survivor.

**Rule 1: Pattern deduplication — keep MAX(extracted_at) per normalized pattern text**

This preserves the most recent instance of each pattern and deletes all older duplicates.

```sql
-- Delete all pattern rows that are NOT the latest instance of their text
DELETE FROM brain_patterns
WHERE id NOT IN (
  SELECT id
  FROM brain_patterns p1
  WHERE extracted_at = (
    SELECT MAX(extracted_at)
    FROM brain_patterns p2
    WHERE lower(trim(p2.pattern)) = lower(trim(p1.pattern))
  )
);
```

Expected deletions: ~2,437 rows.

If two entries share both the same normalized text AND the same `extracted_at` timestamp,
the tie-break is by primary key (lexicographic ID order — keep MIN(id)):

```sql
-- Tie-break: when timestamps match, keep the lexicographically smallest id
DELETE FROM brain_patterns
WHERE id NOT IN (
  SELECT MIN(id)
  FROM brain_patterns
  GROUP BY lower(trim(pattern))
);
```

Run the simpler second query if the first leaves any duplicates.

**Rule 2: Delete test/junk patterns**

```sql
-- Delete patterns with explicitly test-sentinel content
DELETE FROM brain_patterns
WHERE lower(pattern) LIKE '%test pattern%'
   OR lower(pattern) LIKE '%audit test%'
   OR lower(context) LIKE '%audit probe%';
```

Expected deletions: ~4 rows.

**Rule 3: Delete "Completed:" learnings**

These are auto-generated echo entries from `extractTaskCompletionMemory()` and
`extractSessionEndMemory()` that provide no actionable insight.

```sql
DELETE FROM brain_learnings
WHERE insight LIKE 'Completed: %';
```

Expected deletions: ~281 rows.

**Rule 4: Delete dependency chain learnings**

```sql
DELETE FROM brain_learnings
WHERE insight LIKE 'Task % depended on %dependency chain completed successfully';
```

Expected deletions: ~46 rows.

**Rule 5: Delete test learnings**

```sql
DELETE FROM brain_learnings
WHERE source LIKE 'audit-test%'
   OR lower(insight) LIKE '%cli audit test%'
   OR lower(insight) LIKE '%audit probe%';
```

Expected deletions: ~3 rows.

**Rule 6: Delete test decisions**

```sql
DELETE FROM brain_decisions
WHERE lower(decision) LIKE '%test decision%'
   OR lower(decision) LIKE '%audit test%'
   OR lower(rationale) LIKE '%test%' AND type = 'process';
```

Expected deletions: ~4 rows.

Verify that at least 1 real decision remains after this step:

```sql
SELECT COUNT(*) FROM brain_decisions;
-- Expected: >= 1
```

**Rule 7: Delete task start observations**

```sql
DELETE FROM brain_observations
WHERE title LIKE 'Task start: T%'
   OR title LIKE 'Session start: %';
```

Expected deletions: ~64 rows (task starts) + session start observations.

Note: `session-hooks.ts:handleSessionStart()` writes observations with title
`'Session start: <payload.name>'`. These duplicate the session table and MUST be purged.

**Rule 8: Delete session note observations from auto-extract**

```sql
DELETE FROM brain_observations
WHERE title LIKE 'Session summary: %'
   OR title LIKE 'Session end: %'
   OR (title LIKE 'Session note: %' AND source_type = 'agent');
```

Expected deletions: ~29 rows.

**Rule 9: Delete task complete observations**

```sql
DELETE FROM brain_observations
WHERE title LIKE 'Task complete: %'
   OR narrative LIKE 'Completed task T%';
```

Expected deletions: ~6 rows.

**Rule 10: Delete identified test/junk observations**

```sql
DELETE FROM brain_observations
WHERE lower(title) LIKE '%audit test%'
   OR lower(title) LIKE '%audit probe%'
   OR lower(title) LIKE '%test title%'
   OR lower(narrative) LIKE '%testing learning store%'
   OR lower(narrative) LIKE '%test observation%';
```

Expected deletions: ~25 rows.

---

### 1.4 Post-Purge Verification Queries

Run these immediately after purge to confirm expected state.

```sql
-- Final counts — target: ~57 entries total
SELECT 'patterns' AS tbl, COUNT(*) AS cnt FROM brain_patterns
UNION ALL SELECT 'learnings', COUNT(*) FROM brain_learnings
UNION ALL SELECT 'decisions', COUNT(*) FROM brain_decisions
UNION ALL SELECT 'observations', COUNT(*) FROM brain_observations;

-- Verify no remaining "Completed:" learnings
SELECT COUNT(*) AS should_be_zero FROM brain_learnings
WHERE insight LIKE 'Completed: %';

-- Verify no pattern duplicates remain
SELECT pattern, COUNT(*) AS copies
FROM brain_patterns
GROUP BY lower(trim(pattern))
HAVING COUNT(*) > 1;
-- Expected: 0 rows

-- Verify at least 1 real decision
SELECT id, type, decision FROM brain_decisions;
-- Expected: 1 row with the real CLI-only dispatch decision

-- Verify real observations remain
SELECT COUNT(*) FROM brain_observations
WHERE title NOT LIKE 'Task start: T%'
  AND title NOT LIKE 'Session start: %'
  AND title NOT LIKE 'Session summary: %'
  AND title NOT LIKE 'Session end: %';
-- Expected: >= 20 (the 27 real observations from R1 audit minus test deletions)
```

Expected post-purge totals:
- Patterns: 29 (one per distinct label)
- Learnings: ~0-5 (only genuine insights, if any survive filters above)
- Decisions: 1 (the CLI-only dispatch decision)
- Observations: 27 (the real ones identified in R1 audit)
- Total: ~57 entries

---

### 1.5 Memory Link Cleanup

After purging patterns/learnings/decisions/observations, orphaned links in
`brain_memory_links` must also be removed. These are soft cross-references to
deleted entries.

```sql
-- Remove links where the referenced memory entry no longer exists
DELETE FROM brain_memory_links
WHERE (memory_type = 'pattern' AND memory_id NOT IN (SELECT id FROM brain_patterns))
   OR (memory_type = 'learning' AND memory_id NOT IN (SELECT id FROM brain_learnings))
   OR (memory_type = 'decision' AND memory_id NOT IN (SELECT id FROM brain_decisions))
   OR (memory_type = 'observation' AND memory_id NOT IN (SELECT id FROM brain_observations));
```

---

## Section 2: Deduplication Engine Specification

### 2.1 Context

The current dedup in `patterns.ts:storePattern()` (lines 65-82) and
`learnings.ts:storeLearning()` (lines 60-68) both contain an empty `if (duplicate) { }`
block — the comment says "We would ideally increment frequency here" but the code falls
through to unconditional INSERT. This is the primary root cause of the noise.

The `BrainDataAccessor` already exposes `updatePattern()` and `updateLearning()` methods
at lines 164-169 and 220-225 of `brain-accessor.ts`. They are not currently used by the
store functions.

### 2.2 Content Normalization

Before any dedup check, text MUST be normalized consistently. The normalization function
is used identically at write time and at lookup time.

```typescript
// Normalization rules (apply in order):
// 1. Trim leading/trailing whitespace
// 2. Collapse internal whitespace runs to single space
// 3. Lowercase for comparison only (store original case)
function normalizeForDedup(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}
```

Normalization applies to:
- `brain_patterns.pattern` column
- `brain_learnings.insight` column

Context, source, rationale, and other fields are NOT used for dedup matching.

### 2.3 `storePattern()` — Upsert Specification

**File**: `packages/core/src/memory/patterns.ts`

The function MUST:
1. Normalize `params.pattern` using `normalizeForDedup()`.
2. Query `brain_patterns` for an existing row where `lower(trim(pattern))` matches.
3. If found: call `accessor.updatePattern(existingId, { frequency: existing.frequency + 1, updatedAt: now })`. Do NOT merge examples — append new examples to existing `examplesJson`.
4. If not found: insert a new row with `frequency: 1`.
5. Return the updated or newly inserted row in both cases.

The application-level dedup check replaces the current empty `if (duplicate)` block.
The existing `accessor.findPatterns({ type })` call loads ALL patterns of a given type,
then filters in-memory — this is acceptable for current data volumes but MUST use
normalized comparison.

Normalized comparison:
```typescript
const normalizedInput = normalizeForDedup(params.pattern);
const duplicate = existingPatterns.find(
  (e) => normalizeForDedup(e.pattern) === normalizedInput,
);
```

**Frequency increment via updatePattern:**
```typescript
if (duplicate) {
  const mergedExamples = [
    ...JSON.parse(duplicate.examplesJson || '[]'),
    ...(params.examples ?? []),
  ].slice(-20); // cap at 20 examples to prevent unbounded growth

  await accessor.updatePattern(duplicate.id, {
    frequency: duplicate.frequency + 1,
    examplesJson: JSON.stringify(mergedExamples),
    // Do NOT update impact or successRate unless explicitly provided
  });
  return {
    ...duplicate,
    frequency: duplicate.frequency + 1,
    examples: mergedExamples,
  };
}
```

### 2.4 `storeLearning()` — Upsert Specification

**File**: `packages/core/src/memory/learnings.ts`

The function MUST:
1. Normalize `params.insight` using `normalizeForDedup()`.
2. Load all learnings via `accessor.findLearnings()`.
3. Find a duplicate by normalized insight match.
4. If found: call `accessor.updateLearning(existingId, { confidence: Math.max(existing.confidence, params.confidence), updatedAt: now })`. Confidence keeps the maximum of old and new (new info should not reduce existing confidence).
5. If not found: insert a new row with the provided confidence.

**Confidence merge rule:**
```typescript
if (duplicate) {
  const mergedConfidence = Math.max(duplicate.confidence, params.confidence);
  await accessor.updateLearning(duplicate.id, {
    confidence: mergedConfidence,
    // Only update actionable if the new entry is more specific
    actionable: duplicate.actionable || (params.actionable ?? false),
  });
  return {
    ...duplicate,
    confidence: mergedConfidence,
    applicableTypes: JSON.parse(duplicate.applicableTypesJson || '[]'),
  };
}
```

### 2.5 Database-Level UNIQUE Constraints

The schema in `brain-schema.ts` currently has no UNIQUE constraint on the pattern or
insight text columns. Application-level dedup is required because:
- Normalized dedup (lowercase + trim) cannot be expressed as a simple SQLite UNIQUE.
- A computed index or expression index would require a SQLite-generated column.

The preferred approach is application-level dedup as specified above. A follow-up task
MAY add a SQLite generated column for the normalized text and a UNIQUE index on it, but
that is out of scope for T523.

For the dedup engine in Wave 2, do NOT add schema migrations for UNIQUE constraints
in this wave. Application-level guards are sufficient and less risky.

### 2.6 Decision Deduplication

`brain_decisions` does NOT have a dedup problem currently (only 5 total, 1 real).
The `storeDecision()` function in `decisions.ts` SHOULD be reviewed to add source-based
dedup: if a decision with the same `source:${sessionId}` combination already exists,
skip the insert. This prevents session-end from creating duplicate session decisions.

Exact spec for decisions:
```typescript
// In storeDecision(), before INSERT:
if (params.contextTaskId || params.contextEpicId) {
  const existing = await accessor.findDecisions({ type: params.type });
  const normalizedDecision = normalizeForDedup(params.decision);
  const duplicate = existing.find(
    (e) => normalizeForDedup(e.decision) === normalizedDecision,
  );
  if (duplicate) return { ...duplicate }; // return existing, no update needed
}
```

---

## Section 3: Quality Scoring Model

### 3.1 Purpose

Quality scores (0.0–1.0) enable search ranking and bridge generation to surface the
highest-value entries first. The current system has no quality scores — all entries
receive equal weight. After purge, the 57 surviving entries are all real, but as new
entries accumulate, quality scoring prevents signal degradation.

### 3.2 Score Formula by Memory Type

**Patterns** (`brain_patterns.quality_score` — new column):

```
quality = source_weight(type)
        * frequency_factor(frequency)
        * recency_factor(days_since_extracted)
        * impact_factor(impact)
        * success_rate_boost(successRate)

Where:
  source_weight('success' | 'workflow') = 0.8
  source_weight('optimization')         = 0.7
  source_weight('blocker' | 'failure')  = 0.6  // Documented problems are valuable

  frequency_factor(f) = min(1.0, 0.5 + (f / 20.0))
  // 1 occurrence = 0.55, 5 = 0.75, 10 = 1.0 (capped)

  recency_factor(days) = max(0.1, 1.0 - (days / 365.0))
  // 0 days = 1.0, 180 days = 0.51, 365 days = 0.1 (floor)

  impact_factor('high') = 1.0
  impact_factor('medium') = 0.8
  impact_factor('low') = 0.6
  impact_factor(null) = 0.7  // unknown impact treated as medium-low

  success_rate_boost(r) = 0.9 + (r ?? 0.5) * 0.1
  // successRate=1.0 → boost 1.0; successRate=null → boost 0.95
```

**Learnings** (`brain_learnings.quality_score` — new column):

```
quality = confidence
        * actionable_boost(actionable)
        * recency_factor(days_since_created_or_updated)
        * source_trust(source)

Where:
  actionable_boost(true)  = 1.0
  actionable_boost(false) = 0.7

  recency_factor(days) = max(0.1, 1.0 - (days / 365.0))

  source_trust('task-completion:*')  = 0.5  // low — these are echoes
  source_trust('session-end:*')      = 0.5  // low — these are echoes
  source_trust('transcript:*')       = 0.7  // medium — from actual work
  source_trust('manual')             = 1.0  // high — explicit human input
  source_trust('*')                  = 0.8  // default for unknown sources
```

**Decisions** (`brain_decisions.quality_score` — new column):

```
quality = confidence_numeric(confidence)
        * outcome_factor(outcome)
        * age_penalty(days_since_created)

Where:
  confidence_numeric('high')   = 1.0
  confidence_numeric('medium') = 0.7
  confidence_numeric('low')    = 0.4

  outcome_factor('success') = 1.0
  outcome_factor('pending')  = 0.9
  outcome_factor('mixed')    = 0.7
  outcome_factor('failure')  = 0.5
  outcome_factor(null)       = 0.85  // unknown — assume pending

  age_penalty(days) = max(0.3, 1.0 - (days / 730.0))
  // Decisions older than 2 years still retain 30% score floor
```

**Observations** (`brain_observations.quality_score` — new column):

```
quality = source_type_weight(source_type)
        * type_weight(type)
        * recency_factor(days_since_created)
        * content_richness(narrative, factsJson, conceptsJson)

Where:
  source_type_weight('manual')          = 1.0
  source_type_weight('session-debrief') = 0.9
  source_type_weight('claude-mem')      = 0.8
  source_type_weight('agent')           = 0.6

  type_weight('decision')  = 1.0
  type_weight('feature')   = 0.9
  type_weight('bugfix')    = 0.9
  type_weight('refactor')  = 0.8
  type_weight('change')    = 0.7
  type_weight('discovery') = 0.7

  recency_factor(days) = max(0.1, 1.0 - (days / 180.0))
  // Observations decay faster (6 months to floor vs 1 year for learnings)

  content_richness = min(1.0, 0.5
    + (narrative != null ? 0.2 : 0.0)
    + (factsJson has >= 2 items ? 0.2 : 0.0)
    + (conceptsJson has >= 1 item ? 0.1 : 0.0))
```

### 3.3 Score Storage

Add `quality_score REAL` column to each of the four tables in a new migration.
The column is nullable (null = score not yet computed). Workers MUST add a new
Drizzle migration file rather than modifying existing migrations.

Migration location: `packages/core/src/store/migrations/drizzle-brain/`

Migration must add:
```sql
ALTER TABLE brain_patterns ADD COLUMN quality_score REAL;
ALTER TABLE brain_learnings ADD COLUMN quality_score REAL;
ALTER TABLE brain_decisions ADD COLUMN quality_score REAL;
ALTER TABLE brain_observations ADD COLUMN quality_score REAL;
```

And indexes:
```sql
CREATE INDEX IF NOT EXISTS idx_brain_patterns_quality ON brain_patterns(quality_score);
CREATE INDEX IF NOT EXISTS idx_brain_learnings_quality ON brain_learnings(quality_score);
CREATE INDEX IF NOT EXISTS idx_brain_decisions_quality ON brain_decisions(quality_score);
CREATE INDEX IF NOT EXISTS idx_brain_observations_quality ON brain_observations(quality_score);
```

### 3.4 Score Computation Timing

Scores are NOT computed on every read (too expensive). The timing rules are:

| Event | Action |
|-------|--------|
| INSERT of any memory entry | Compute and store quality_score immediately |
| UPDATE of frequency, confidence, outcome | Recompute quality_score inline |
| Daily maintenance run (`cleo brain maintenance`) | Recompute ALL scores (recency decay changes) |
| Manual `cleo brain score --rebuild` | Full rebuild on demand |

The initial backfill after Wave 2 deploys: `cleo brain score --rebuild` is run once
to populate scores for all existing entries.

### 3.5 Score Impact on Search and Bridge

**Search ranking**: `searchBrain()` in `brain-search.ts` MUST add a `quality_score`
factor to FTS5 BM25 rank when available. The combined score is:

```
combined_rank = bm25_rank * (0.7 + quality_score * 0.3)
```

Where `quality_score` defaults to 0.5 for null entries (not yet scored).

**Bridge generation**: `memory-bridge.ts` currently shows the most recent entries.
After quality scoring is available, it MUST filter entries to `quality_score >= 0.5`
and sort by quality_score DESC before selecting which entries to surface.

**Bridge exclusion**: Entries with `quality_score < 0.3` are treated as noise and
excluded from bridge generation and search ranking entirely.

---

## Section 4: Hook Fix Specification

### 4.1 Current Hook Map (Source of Duplicate Writes)

Two separate code paths both write observations for session lifecycle events:

**Path A**: `session-hooks.ts:handleSessionStart()` (lines 31-40)
- Writes observation: title = `"Session start: <payload.name>"`
- Type: 'discovery', sourceType: 'agent'

**Path B**: `session-hooks.ts:handleSessionEnd()` (lines 60-68)
- Writes observation: title = `"Session end: <sessionId>"`
- Type: 'change', sourceType: 'agent'

**Path C**: `session-memory-bridge.ts:bridgeSessionToMemory()` (lines 48-55)
- Writes SECOND observation: title = `"Session summary: <sessionId>"`
- Type: 'change', sourceType: 'agent'
- Also calls `extractSessionEndMemory()` which writes MORE learnings + patterns

This means a single session produces at minimum 3 brain.db writes for lifecycle
metadata that is already stored in the sessions table.

### 4.2 What Session Hooks MUST Do After Fix

**`handleSessionStart()` — DISABLE the observation write**

The session-start observation is pure noise: it duplicates the sessions table entry
and adds no information not already in `source_session_id` references.

Fix: Remove the `observeBrain()` call at lines 31-39. Keep the `maybeRefreshMemoryBridge()`
call — that is still needed.

```typescript
// BEFORE (lines 30-46):
export async function handleSessionStart(
  projectRoot: string,
  payload: SessionStartPayload,
): Promise<void> {
  const { observeBrain } = await import('../../memory/brain-retrieval.js');
  try {
    await observeBrain(projectRoot, { /* session start obs */ });
  } catch (err) { ... }
  await maybeRefreshMemoryBridge(projectRoot);
}

// AFTER:
export async function handleSessionStart(
  projectRoot: string,
  _payload: SessionStartPayload,
): Promise<void> {
  // Session start is already recorded in the sessions table.
  // We do NOT duplicate it in brain_observations.
  await maybeRefreshMemoryBridge(projectRoot);
}
```

**`handleSessionEnd()` — DISABLE the duplicate observation write, KEEP transcript extraction**

The session-end observation duplicates `bridgeSessionToMemory()`. Remove the
`observeBrain()` call at lines 60-68. Keep the grading call and the transcript
extraction call — both are signal.

```typescript
// AFTER (handleSessionEnd):
export async function handleSessionEnd(
  projectRoot: string,
  payload: SessionEndPayload,
): Promise<void> {
  // Session grading — keep
  try {
    const { gradeSession } = await import('../../sessions/session-grade.js');
    await gradeSession(payload.sessionId, projectRoot);
  } catch { }

  // Transcript extraction — keep, but ONLY when autoCapture is true
  try {
    const { loadConfig } = await import('../../config.js');
    const config = await loadConfig(projectRoot);
    if (config.brain?.autoCapture) {
      const { AdapterManager } = await import('../../adapters/index.js');
      const manager = AdapterManager.getInstance(projectRoot);
      const activeAdapter = manager.getActive();
      const hookProvider = activeAdapter?.hooks;
      if (hookProvider && typeof hookProvider.getTranscript === 'function') {
        const transcript = await hookProvider.getTranscript(payload.sessionId, projectRoot);
        if (transcript) {
          const { extractFromTranscript } = await import('../../memory/auto-extract.js');
          await extractFromTranscript(projectRoot, payload.sessionId, transcript);
        }
      }
    }
  } catch { }

  await maybeRefreshMemoryBridge(projectRoot);
}
```

**`bridgeSessionToMemory()` — REMOVE call to `extractSessionEndMemory()`**

The `extractSessionEndMemory()` call at lines 57-64 of `session-memory-bridge.ts`
is the second source of session-end pattern/learning noise. Remove it entirely.
The summary observation write (lines 48-55) is acceptable to keep AS-IS, as it
provides a human-readable log entry — but it SHOULD be gated by a config flag.

```typescript
// AFTER (bridgeSessionToMemory):
export async function bridgeSessionToMemory(
  projectRoot: string,
  sessionData: SessionBridgeData,
): Promise<void> {
  try {
    // Gate on config: only write if brain.autoCapture is enabled
    const { loadConfig } = await import('../config.js');
    const config = await loadConfig(projectRoot).catch(() => null);
    if (!config?.brain?.autoCapture) return;

    const taskList = sessionData.tasksCompleted.length > 0
      ? sessionData.tasksCompleted.join(', ')
      : 'none';
    const durationMinutes = Math.round(sessionData.duration / 60);
    const summary = [
      `Session ${sessionData.sessionId} ended.`,
      `Scope: ${sessionData.scope}.`,
      `Duration: ${durationMinutes} min.`,
      `Tasks completed: ${taskList}.`,
    ].join(' ');

    await observeBrain(projectRoot, {
      text: summary,
      title: `Session summary: ${sessionData.sessionId}`,
      type: 'change',
      sourceSessionId: sessionData.sessionId,
      sourceType: 'session-debrief',  // Changed from 'agent' to reflect real source
    });
    // DO NOT call extractSessionEndMemory — removed
  } catch { }
}
```

### 4.3 autoCapture Config Gate

The `BrainConfig.autoCapture` flag (referenced in `config.ts`) MUST be checked before
any hook writes a brain.db entry, with the following policy:

| Hook | autoCapture=true | autoCapture=false |
|------|-----------------|------------------|
| Session start observation | DISABLED (always) | DISABLED (always) |
| Session end observation (handleSessionEnd) | DISABLED (always) | DISABLED (always) |
| bridgeSessionToMemory summary | Writes observation | Skips entirely |
| Transcript extraction | Runs | Skips |
| `extractTaskCompletionMemory` | Runs (but with new behavior — see Section 5) | Skips entirely |

---

## Section 5: Auto-Pattern Redesign

### 5.1 Should "Recurring label" Patterns Exist?

**No, not in their current form.** The current pattern text `"Recurring label 'X' seen in N completed tasks"` is:
- Purely mechanical information derivable from task counts at query time
- Re-created on every task completion (O(N) growth — 2,470 noise patterns from 29 distinct labels)
- Not actionable — it tells an agent nothing about HOW to work with that label

The pattern type should be reserved for genuine workflow insights written by agents who
have made an observation about how work actually proceeds.

### 5.2 What Replaces Auto-Pattern Detection

Auto-pattern detection from task labels MUST be **disabled by default** and replaced with
a **threshold-gated, dedup-enforced, less-frequent mechanism**.

**New behavior for `extractTaskCompletionMemory()`**:

1. The "Completed: X" learning write MUST be removed entirely.
2. The dependency chain learning MUST be removed entirely.
3. Label pattern detection MUST be replaced by a no-op OR moved to a dedicated
   scheduled maintenance task (`cleo brain maintenance`), NOT triggered on every task completion.

The complete updated function:

```typescript
/**
 * Extract and store memory entries when a task is completed.
 *
 * REDESIGNED (T523): No longer writes noise learnings for every completion.
 * Only writes signal: patterns that meet a quality threshold and pass dedup.
 * Called from task completion hooks.
 */
export async function extractTaskCompletionMemory(
  projectRoot: string,
  task: Task,
  _parentTask?: Task,
): Promise<void> {
  // Intentionally empty. Task completion no longer auto-writes learnings.
  // Rationale: "Completed: X" echoes are noise; true learnings come from
  // session debriefs and manual `cleo memory observe` calls.
  // Label pattern detection moved to: cleo brain maintenance (on schedule).
}
```

**New behavior for `extractSessionEndMemory()`**:

This function is called only from `bridgeSessionToMemory()` which we are removing the
call from. The function itself should be kept but made a no-op (or properly gated):

```typescript
export async function extractSessionEndMemory(
  projectRoot: string,
  sessionData: SessionBridgeData,
  taskDetails: Task[],
): Promise<void> {
  // No-op. Session-end memory extraction is now done exclusively by:
  // 1. bridgeSessionToMemory() — one summary observation (if autoCapture enabled)
  // 2. cleo brain maintenance — scheduled pattern detection (not per-session)
  // This function is retained for API compatibility but performs no work.
}
```

### 5.3 Label Pattern Detection in Maintenance (Optional, Future)

If label pattern detection is desired in a future task (T523 follow-up), it MUST:
1. Run only in `cleo brain maintenance` (scheduled), never on task completion.
2. Use a higher threshold: label must appear in >= 10 completed tasks (not 3).
3. Apply full dedup via `storePattern()` before writing.
4. Include the pattern text in a non-ephemeral, human-readable format that provides
   actionable guidance (not just "recurring label X").
5. Be disabled unless `brain.autoCapture = true` in config.

The pattern text format SHOULD be:
```
"Label '<X>' appears in <N> completed tasks — review for extractable workflow documentation"
```
This is actionable (it prompts a human action) rather than merely statistical.

---

## Section 6: Embedding Activation Plan

### 6.1 Current State

From reading `brain-sqlite.ts:loadBrainVecExtension()` (lines 110-119):
- `require('sqlite-vec')` is attempted at DB init time
- If it fails (not installed), `_vecLoaded = false` and no vec0 table is created
- `isBrainVecLoaded()` returns false
- `searchSimilar()` in `brain-similarity.ts` checks `isBrainVecLoaded()` and returns
  `[]` immediately — graceful no-op
- `isEmbeddingAvailable()` in `brain-embedding.ts` checks `currentProvider` which is null
  because `initDefaultProvider()` is never called at startup

From reading `embedding-local.ts`: the `LocalEmbeddingProvider` uses
`@huggingface/transformers` (transformers.js v4) with model `Xenova/all-MiniLM-L6-v2`
(384 dimensions). The package is listed as a regular (not optional) dependency.

### 6.2 Installation Steps for sqlite-vec

```bash
# Step 1: Install sqlite-vec in the core package
cd /path/to/project/packages/core
pnpm add sqlite-vec

# Step 2: Verify it loads
node -e "const sv = require('sqlite-vec'); console.log('sqlite-vec ok:', typeof sv.load);"

# Step 3: Verify brain.db picks it up
cleo memory find "test query"
# Should no longer show "embedding unavailable" warning (if any)
```

If `sqlite-vec` requires native compilation, verify Node.js ABI compatibility:
```bash
node -e "console.log(process.versions)"
# Ensure node_modules/sqlite-vec/prebuilds/ has a matching binary
```

### 6.3 Startup Wiring for initDefaultProvider()

The function `initDefaultProvider()` in `brain-embedding.ts` (line 80) is never called
in the startup path. It MUST be wired into `getBrainDb()` in `brain-sqlite.ts`.

Add the following after line 192 (`if (_vecLoaded) { initializeBrainVec(nativeDb); }`):

```typescript
// Initialize local embedding provider when vec is available
if (_vecLoaded) {
  initializeBrainVec(nativeDb);
  // Async: load embedding model in background, do not block DB init
  void (async () => {
    try {
      const config = await import('../config.js').then(m =>
        m.loadConfig(cwd ?? process.cwd()).catch(() => null)
      );
      if (config?.brain?.embedding?.enabled !== false) {
        const { initDefaultProvider } = await import('../memory/brain-embedding.js');
        await initDefaultProvider();
      }
    } catch {
      // Embedding init failure is non-fatal
    }
  })();
}
```

The `void` wrapper ensures this runs asynchronously without blocking DB initialization.
The first embedding call will wait for the model to load via the lazy pipeline in
`embedding-local.ts:loadPipeline()`.

### 6.4 Embedding Generation Trigger Points

| Event | Embedding Action |
|-------|-----------------|
| `observeBrain()` — new observation with narrative | Embed `title + ' ' + narrative` asynchronously |
| `storePattern()` — new pattern inserted | Embed `pattern + ' ' + context` asynchronously |
| `storeLearning()` — new learning inserted | Embed `insight` asynchronously |
| `storeDecision()` — new decision inserted | Embed `decision + ' ' + rationale` asynchronously |
| `cleo brain maintenance` | Backfill missing embeddings via `populateEmbeddings()` |
| Post-purge initial run | `cleo brain maintenance --skip-decay --skip-consolidation` |

The async embedding generation uses the existing `populateEmbeddings()` pattern in
`brain-retrieval.ts`. Worker implementing embedding activation SHOULD extract a reusable
`embedAndStore(id, text, projectRoot)` helper rather than duplicating embed logic per
table.

### 6.5 Embedding Backfill After Purge and Activation

Once sqlite-vec is installed and `initDefaultProvider()` is wired:

```bash
# Step 1: Purge noise (Wave 1 must be complete)
# Step 2: Install sqlite-vec
pnpm add sqlite-vec

# Step 3: Run maintenance to backfill embeddings for the ~57 surviving entries
cleo brain maintenance --skip-decay --skip-consolidation --skip-reconciliation

# Step 4: Verify embedding coverage
# (expected: 57/57 processed, 0 skipped)
```

### 6.6 Expected Coverage After Activation

With 57 entries post-purge and all four tables covered, expected results:
- Embeddings: 57 vectors in `brain_embeddings` vec0 table
- Vector search: `searchSimilar()` returns results instead of `[]`
- Hybrid search: `hybridSearch()` uses vec weight of 0.4 as intended

---

## Section 7: FTS5 Integration

### 7.1 Current State

FTS5 is already implemented in `brain-search.ts:ensureFts5Tables()` (line 78).
The four virtual tables are:
- `brain_decisions_fts` — columns: id, decision, rationale
- `brain_patterns_fts` — columns: id, pattern, context
- `brain_learnings_fts` — columns: id, insight, source
- `brain_observations_fts` — columns: id, title, narrative

Content-sync triggers exist for all four tables. The `rebuildFts5Index()` function
(line 252) handles full rebuilds.

The only problem is that FTS5 is currently searching 2,955 noise entries, so every
query returns noise as top results.

### 7.2 Post-Purge FTS5 Rebuild

After the Section 1 purge SQL runs, the FTS5 tables are out of sync with the main
tables (the DELETE operations do not automatically remove entries from content= FTS
tables unless the ad triggers fire correctly).

The content-sync `brain_patterns_ad` trigger IS in place, so DELETEs SHOULD propagate.
However, to guarantee consistency, run a forced rebuild immediately after purge:

```typescript
// Via existing API:
import { rebuildFts5Index } from '../memory/brain-search.js';
import { getBrainNativeDb } from '../store/brain-sqlite.js';

const nativeDb = getBrainNativeDb();
if (nativeDb) {
  rebuildFts5Index(nativeDb);
}
```

Or via a new CLI command: `cleo brain rebuild-fts` (see Wave 1 acceptance criteria).

### 7.3 Schema Changes Required

None. The FTS5 schema is complete and correct for the current four tables.

Future table additions (if any) MUST add corresponding FTS5 virtual tables and triggers.

### 7.4 Quality Score Integration with FTS5 Rankings

FTS5 BM25 scores are negative numbers (more negative = better match). The current code
uses `ORDER BY bm25(brain_patterns_fts)` which correctly ranks by relevance.

After quality scores are added (Wave 2), the query SHOULD combine BM25 with quality:

```sql
-- Enhanced pattern search with quality boost
SELECT p.*, bm25(brain_patterns_fts) AS bm25_score
FROM brain_patterns_fts fts
JOIN brain_patterns p ON p.rowid = fts.rowid
WHERE brain_patterns_fts MATCH ?
  AND (p.quality_score IS NULL OR p.quality_score >= 0.3)
ORDER BY bm25(brain_patterns_fts) * (0.7 + COALESCE(p.quality_score, 0.5) * 0.3)
LIMIT ?
```

The same pattern applies for learnings, decisions, and observations.

### 7.5 Observations FTS Verification

The `brain_observations_fts` table was added later and has a try/catch around its rebuild
in `rebuildFts5Index()` (lines 262-268). Verify it was created in the live database:

```sql
SELECT name FROM sqlite_master WHERE type='table' AND name='brain_observations_fts';
-- Expected: 1 row
```

If the table is missing (older brain.db), it will be created on the next `searchBrain()`
call via `ensureFts5Tables()`, which uses `CREATE VIRTUAL TABLE IF NOT EXISTS`.

---

## Section 8: Implementation Wave Plan

### Wave 1: Purge + Hook Fixes (Stop the Bleeding)

**Goal**: Eliminate existing noise, prevent new noise from accumulating.

**Tasks**:
1. Execute Section 1 purge SQL in order (Rules 1-10 + memory link cleanup)
2. Rebuild FTS5 indexes post-purge
3. Fix `handleSessionStart()` — remove observeBrain call
4. Fix `handleSessionEnd()` — remove observeBrain call
5. Fix `bridgeSessionToMemory()` — remove extractSessionEndMemory call, add autoCapture gate
6. Replace `extractTaskCompletionMemory()` with no-op
7. Replace `extractSessionEndMemory()` with no-op

**Acceptance Criteria**:
- [ ] `SELECT COUNT(*) FROM brain_patterns` returns <= 35 (29 deduped + any real ones)
- [ ] `SELECT COUNT(*) FROM brain_learnings WHERE insight LIKE 'Completed: %'` returns 0
- [ ] `SELECT COUNT(*) FROM brain_decisions` returns >= 1 (real decision intact)
- [ ] `SELECT COUNT(*) FROM brain_observations WHERE title LIKE 'Session start: %'` returns 0
- [ ] Running `cleo session start` + `cleo session end` does NOT create new noise observations
- [ ] Running `cleo complete <any-task-id>` does NOT create new "Completed:" learnings
- [ ] Total brain.db entries: 40-70 (purge within range of expected 57)
- [ ] `pnpm run test` passes with zero new failures

---

### Wave 2: Dedup Engine + Quality Scoring

**Goal**: Prevent future noise via proper upsert behavior and score-gate low-quality entries.

**Tasks**:
1. Implement `normalizeForDedup()` helper in a shared utility module
2. Fix `storePattern()` — implement upsert with frequency increment (Section 2.3)
3. Fix `storeLearning()` — implement upsert with confidence merge (Section 2.4)
4. Fix `storeDecision()` — add source-based dedup guard (Section 2.6)
5. Add migration: `quality_score REAL` column + indexes to all four tables (Section 3.3)
6. Implement `computeQualityScore(entry, type)` function in new file:
   `packages/core/src/memory/brain-quality.ts`
7. Wire quality score computation into `storePattern()`, `storeLearning()`, etc.
8. Wire quality score into `searchBrain()` FTS5 queries (Section 7.4 SQL)
9. Wire quality score into bridge generation (Section 3.5)
10. Run `cleo brain score --rebuild` to backfill existing entries

**Acceptance Criteria**:
- [ ] Calling `storePattern()` twice with the same pattern text: second call increments
  `frequency` to 2 instead of creating a new row
- [ ] Calling `storeLearning()` twice with the same insight: second call updates
  `confidence` to max(old, new) instead of creating a new row
- [ ] All existing entries have `quality_score IS NOT NULL` after rebuild
- [ ] `searchBrain('auth')` returns only entries with `quality_score >= 0.3`
- [ ] Memory bridge shows only entries with `quality_score >= 0.5`
- [ ] `pnpm run build` succeeds
- [ ] `pnpm run test` passes with zero new failures
- [ ] `pnpm biome check --write .` produces zero violations

---

### Wave 3: Embedding Activation + FTS5 Rebuild

**Goal**: Enable vector search pipeline end-to-end.

**Tasks**:
1. `pnpm add sqlite-vec` in `packages/core`
2. Wire `initDefaultProvider()` into `getBrainDb()` (Section 6.3)
3. Implement async embed-on-insert in `storePattern()`, `storeLearning()`,
   `storeDecision()`, `observeBrain()` using a shared helper
4. Run post-purge embedding backfill: `cleo brain maintenance --skip-decay --skip-consolidation`
5. Verify `searchSimilar('auth')` returns results (non-empty array)
6. Verify `hybridSearch('auth', projectRoot)` returns results from vec source
7. Verify `rebuildFts5Index()` runs cleanly post-activation

**Acceptance Criteria**:
- [ ] `isBrainVecLoaded()` returns `true` at runtime
- [ ] `isEmbeddingAvailable()` returns `true` after first call to `getBrainDb()`
- [ ] `SELECT COUNT(*) FROM brain_embeddings` equals post-purge total entry count
- [ ] `searchSimilar('session management')` returns >= 1 result
- [ ] `hybridSearch()` result includes at least one entry with `sources: ['vec']`
- [ ] Embedding a new observation via `cleo memory observe "test" --title "test"` creates
  an entry in `brain_embeddings`
- [ ] `pnpm run test` passes with zero new failures
- [ ] `pnpm biome check --write .` produces zero violations

---

### Wave 4: Ongoing Maintenance Automation

**Goal**: Prevent score drift and embedding gaps from accumulating.

**Tasks**:
1. Add `cleo brain score --rebuild` command that recomputes all quality scores
2. Add `cleo brain score --stats` command showing distribution of quality scores
3. Ensure `cleo brain maintenance` runs `score --rebuild` automatically (add step 5 to
   `runBrainMaintenance()` in `brain-maintenance.ts`)
4. Add a maintenance schedule recommendation to docs (e.g., run weekly via cron)
5. Add `cleo brain purge-noise [--dry-run]` command that applies Rules 3, 7, 8, 9, 10
   automatically for future noise accumulation

**Acceptance Criteria**:
- [ ] `cleo brain maintenance` produces output showing: decay, consolidation, reconciliation,
  embeddings, and quality scores updated
- [ ] `cleo brain score --stats` shows score distribution by table and quality band
  (< 0.3, 0.3–0.5, 0.5–0.7, 0.7–1.0)
- [ ] `cleo brain purge-noise --dry-run` lists candidates without deleting
- [ ] `cleo brain purge-noise` with no flags deletes noise and prints a summary count
- [ ] Running the full maintenance cycle after one week of normal usage does not result
  in entries with `quality_score < 0.3` accumulating to > 10% of total

---

## Appendix A: File Change Map

| File | Wave | Change Type |
|------|------|-------------|
| `packages/core/src/memory/patterns.ts` | 2 | Fix dedup (storePattern upsert) |
| `packages/core/src/memory/learnings.ts` | 2 | Fix dedup (storeLearning upsert) |
| `packages/core/src/memory/decisions.ts` | 2 | Add source-based dedup guard |
| `packages/core/src/memory/auto-extract.ts` | 1 | No-op extractTaskCompletionMemory + extractSessionEndMemory |
| `packages/core/src/hooks/handlers/session-hooks.ts` | 1 | Remove observeBrain from handleSessionStart + handleSessionEnd |
| `packages/core/src/sessions/session-memory-bridge.ts` | 1 | Remove extractSessionEndMemory call, add autoCapture gate |
| `packages/core/src/memory/brain-quality.ts` | 2 | New file — quality score computation |
| `packages/core/src/memory/brain-search.ts` | 2 | Quality score integration in FTS5 queries |
| `packages/core/src/memory/memory-bridge.ts` | 2 | Quality score filter in bridge generation |
| `packages/core/src/store/brain-schema.ts` | 2 | quality_score column added via migration (NOT in schema file directly) |
| `packages/core/src/store/brain-sqlite.ts` | 3 | Wire initDefaultProvider() after vec init |
| `packages/core/src/memory/brain-maintenance.ts` | 4 | Add quality score rebuild step |
| `packages/core/migrations/drizzle-brain/NNNN_quality_scores.sql` | 2 | New migration for quality_score columns |

---

## Appendix B: Anti-Patterns to Avoid

Workers implementing T523 MUST NOT do any of the following:

1. **Do NOT add `brain.autoCapture` checks in places where the gating spec says "always disabled"** — session start and session end observations are removed unconditionally, not gated.

2. **Do NOT use `any` type** in quality score or dedup code — use explicit types from `brain-schema.ts`.

3. **Do NOT run purge SQL on tasks.db** — all purge targets are in brain.db only.

4. **Do NOT modify the sessions table** — session history is NOT cleaned up by this epic.

5. **Do NOT create new duplicate utility functions** — the `normalizeForDedup()` function MUST be defined once in a shared location and imported everywhere needed.

6. **Do NOT skip `pnpm biome check --write .` and `pnpm run test`** before marking any wave complete.

7. **Do NOT run purge without taking a backup first** — the backup step is mandatory.

8. **Do NOT call `initDefaultProvider()` synchronously in the getBrainDb hot path** — it MUST be called async without blocking DB initialization.

---

## Appendix C: Key Source References

| Concept | File | Lines |
|---------|------|-------|
| Pattern dedup bug | `packages/core/src/memory/patterns.ts` | 65-82 |
| Learning dedup bug | `packages/core/src/memory/learnings.ts` | 60-68 |
| Task completion noise | `packages/core/src/memory/auto-extract.ts` | 25-85 |
| Session end noise (auto-extract) | `packages/core/src/memory/auto-extract.ts` | 94-143 |
| Session hook observations | `packages/core/src/hooks/handlers/session-hooks.ts` | 31-40, 60-68 |
| Bridge duplicate observation | `packages/core/src/sessions/session-memory-bridge.ts` | 48-65 |
| BrainDataAccessor.updatePattern | `packages/core/src/store/brain-accessor.ts` | 164-169 |
| BrainDataAccessor.updateLearning | `packages/core/src/store/brain-accessor.ts` | 220-225 |
| sqlite-vec load | `packages/core/src/store/brain-sqlite.ts` | 110-119 |
| initDefaultProvider | `packages/core/src/memory/brain-embedding.ts` | 80-84 |
| FTS5 rebuild | `packages/core/src/memory/brain-search.ts` | 252-269 |
| Brain schema tables | `packages/core/src/store/brain-schema.ts` | all |
| Temporal decay | `packages/core/src/memory/brain-lifecycle.ts` | 38-78 |
| Maintenance runner | `packages/core/src/memory/brain-maintenance.ts` | 141-215 |
