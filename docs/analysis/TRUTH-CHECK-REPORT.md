# Truth Check Report: Core Hardening Spot-Check

**Date**: 2026-03-19
**Reviewer**: Independent skeptical audit
**Scope**: 8 critical areas across Waves 1-3, spot-checked for substance vs. shortcuts

---

## Check 1: Agent Registry (Wave 2)

**File**: `packages/core/src/agents/registry.ts`

### Findings

- **registerAgent()**: REAL. Calls `db.insert(agentInstances).values(row)` at line 83. Constructs a full row with generated ID, timestamps, metadata JSON, parent agent ID, capacity. Uses `getDb(cwd)` to get a Drizzle SQLite instance. Not in-memory.
- **heartbeat()**: REAL. Calls `db.update(agentInstances).set({ lastHeartbeat: now })` at line 131. Correctly guards against updating terminal states (stopped/crashed) at line 126.
- **checkAgentHealth()**: REAL. Computes an ISO cutoff timestamp from `Date.now() - thresholdMs`, then queries with `lt(agentInstances.lastHeartbeat, cutoff)` filtered to non-terminal statuses (active, idle, starting). Lines 368-379.
- **deregisterAgent()**: REAL. Queries existing row, checks for idempotency (already stopped), then calls `db.update` to set status='stopped' and stoppedAt. Lines 91-107.
- **Error classification**: Non-trivial. Two regex arrays (RETRIABLE_PATTERNS with 15 entries, PERMANENT_PATTERNS with 14 entries) classifying error types. Error logging goes to a separate `agent_error_log` table via `db.insert(agentErrorLog)` at line 183.
- **Pattern**: Full DataAccessor/Drizzle pattern. No in-memory-only state. Every operation hits SQLite.

### Concerns

- `updateAgentStatus` does a SELECT then UPDATE (not atomic), which could have a race condition under concurrent access. Minor for SQLite single-writer model.

### VERDICT: **SOLID**

This is real, production-quality code with proper DB operations, error handling, and edge case management.

---

## Check 2: Intelligence Prediction (Wave 3)

**File**: `packages/core/src/intelligence/prediction.ts`

### Findings

- **calculateTaskRisk()**: REAL multi-factor scoring. Four distinct factors computed:
  1. `computeComplexityFactor` -- queries DataAccessor for child count via `accessor.countChildren()`, combines task size (0.2/0.5/0.8), dependency count normalized to 0-1, child count normalized to 0-1. Weighted 40/30/30.
  2. `computeHistoricalFailureFactor` -- queries `brainAccessor.findPatterns({ type: 'failure' })` and `{ type: 'blocker' }`, then does textual matching (labels, title substring, description overlap) against each pattern. Not a stub.
  3. `computeBlockingFactor` -- queries `accessor.queryTasks({ status: ['pending', 'active', 'blocked'] })` and counts how many tasks depend on the target. Normalized to 0-1 (5+ blocked = 1.0).
  4. `computeDependencyDepthFactor` -- walks the dependency chain via repeated `accessor.loadSingleTask()` with cycle guard. Also walks parent hierarchy. Combined depth normalized to 0-1.
- **Risk weights**: `{ complexity: 0.25, historicalFailure: 0.25, blockingRisk: 0.30, dependencyDepth: 0.20 }` -- not equal weights, blocking risk is intentionally highest.
- **Confidence scaling**: Starts at 0.25 base, scales up with available data points. Not hardcoded.
- **predictValidationOutcome()**: REAL. Four signals:
  1. Task status assessment (blocked/cancelled/done/active with stage-aware logic)
  2. Acceptance criteria presence check
  3. Historical patterns from `brainAccessor.findPatterns({ type: 'success' })` and `{ type: 'failure' }` with stage-context matching
  4. Learning context from `brainAccessor.findLearnings()` with multi-strategy matching (task ID, labels, applicable types, title keyword overlap)
- **NOT just `return 0.5`**: The risk scoring algorithm is genuinely multi-factor with weighted aggregation.

### Concerns

- `computeBlockingFactor` loads ALL non-done tasks to count dependents. Could be expensive at scale. Not a correctness issue.
- `computeHistoricalFailureFactor` uses naive substring matching for pattern relevance. Functional but not sophisticated.

### VERDICT: **SOLID**

Genuinely implemented multi-factor analysis with real database queries and non-trivial scoring logic.

---

## Check 3: Pattern Extraction (Wave 3)

**File**: `packages/core/src/intelligence/patterns.ts`

### Findings

- **extractPatternsFromHistory()**: REAL. Four extraction strategies:
  1. `extractBlockerPatterns` -- queries `accessor.queryTasks({ status: 'blocked' })`, groups by `blockedBy` reason, creates patterns with frequency/impact/confidence scoring.
  2. `extractSuccessPatterns` -- queries `accessor.queryTasks({ status: 'done' })`, analyzes label distribution and size distribution, produces frequency-based patterns.
  3. `extractWorkflowPatterns` -- queries ALL tasks, builds dependency target frequency map to find hub tasks, analyzes parent completion rates, detects high-blocked-child-ratio patterns.
  4. `extractObservationPatterns` -- queries `brainAccessor.findObservations({ limit: 200 })`, groups by type and project, maps observation types to pattern types.
- Does NOT return empty arrays by default. Returns patterns when data exists above `minFrequency` threshold.
- **matchPatterns()**: REAL. Queries `brainAccessor.findPatterns({ limit: 200 })`, then scores each pattern against task attributes using `computePatternRelevance()` which considers label match (+0.3), title keyword overlap (+0.15/word), description keyword overlap (+0.1/word), type match (+0.2), with boosts for high-impact (1.2x) and high-frequency (1.1x) patterns.
- **storeDetectedPattern()**: REAL. Calls `brainAccessor.addPattern()` with generated ID, timestamp, and all pattern fields. Lines 158-171.
- **updatePatternStats()**: REAL. Implements running average formula: `newRate = (oldRate * oldFreq + (success ? 1 : 0)) / newFreq`. Calls `brainAccessor.updatePattern()`.

### Concerns

- `extractWorkflowPatterns` loads all tasks into memory. Same scalability note as prediction.
- The observation-to-pattern type mapping is somewhat arbitrary (bugfix -> failure, feature -> success).

### VERDICT: **SOLID**

Comprehensive pattern extraction with four distinct strategies, real DB queries, and proper storage/update operations.

---

## Check 4: Impact Analysis (Wave 3)

**File**: `packages/core/src/intelligence/impact.ts`

### Findings

- **analyzeTaskImpact()**: REAL. Full pipeline:
  1. Loads all tasks from DataAccessor
  2. Builds reverse adjacency map via `buildDependentsMap()` (iterates all tasks, inverts dependency edges)
  3. Runs BFS via `collectTransitiveDependents()` (lines 67-88, proper queue-based traversal with visited set)
  4. Finds affected pipelines by walking parent chains to find epics via `getParentChain()`
  5. Counts blocked work (non-done/non-cancelled tasks in transitive set)
  6. Checks critical path membership via imported `getCriticalPath()`
  7. Computes blast radius with severity classification
- **calculateBlastRadius()**: REAL. Returns `{ directCount, transitiveCount, epicCount, projectPercentage, severity }`. Severity classification: <=1% isolated, <=10% moderate, <=30% widespread, >30% critical.
- **analyzeChangeImpact()**: REAL. Four change type scenarios:
  1. `predictCancelEffects` -- finds direct dependents that lose their only blocking dep, marks them as unblocked/orphaned. Transitive dependents get cascade warnings.
  2. `predictBlockEffects` -- cascading block through all transitive dependents
  3. `predictCompleteEffects` -- identifies dependents whose last unmet dep is now satisfied (they become unblocked)
  4. `predictReprioritizeEffects` -- flags all transitive dependents for potential reordering
- **computeCascadeDepth()**: Uses DFS (lines 171-194) with visited set to find maximum cascade depth. Proper recursive implementation.

### Concerns

- `findAffectedPipelines` uses `tasks.find()` inside a loop over all affected IDs. O(n*m) but not a correctness issue.

### VERDICT: **SOLID**

Genuine graph traversal with BFS/DFS, four distinct change scenario predictors, and proper blast radius quantification.

---

## Check 5: Underscore Stub Wiring (Wave 1)

### 5a: state-machine.ts skipStage() -- `_reason`

**File**: `packages/core/src/lifecycle/state-machine.ts` lines 716-737

**Finding**: The parameter `reason` (not `_reason` -- it was properly renamed) IS used:
- Line 735: `updatedState.notes = reason` -- stored in in-memory state
- Line 734 comment explains: "the DB-level skip_reason column is set by recordStageProgress in lifecycle/index.ts"
- Verified in `lifecycle/index.ts` line 868: `skipReason: status === 'skipped' ? (notes ?? null) : null` -- the skip reason flows through the `notes` parameter to the DB column.

**VERDICT: SOLID** -- The parameter is used and the reason propagates to the database through the lifecycle layer.

### 5b: signaldock-transport.ts poll() -- `_since`

**File**: `packages/core/src/signaldock/signaldock-transport.ts` line 107

**Finding**: The parameter `since` (not `_since` -- it was properly renamed) IS used:
- Line 108-109: `const path = since ? \`/messages/poll/new?since=${encodeURIComponent(since)}\` : '/messages/poll/new';`
- The parameter is conditionally appended as a query string parameter in the API request URL.

**VERDICT: SOLID** -- The parameter is actually used in the HTTP request construction.

### 5c: skill-ops.ts listSkills() -- `_projectRoot`

**File**: `packages/core/src/orchestration/skill-ops.ts` lines 29, 70

**Finding**: The parameter `projectRoot` (not `_projectRoot` -- it was properly renamed) IS used:
- Line 70: `scanSkillsDir(join(projectRoot, '.cleo', 'skills'))` -- scans project-local skills directory first
- Line 73: `scanSkillsDir(getCanonicalSkillsDir())` -- then scans global skills
- Also used in `getSkillContent()` at line 85: `const projectSkillDir = join(projectRoot, '.cleo', 'skills', skillName)`
- The function actually reads directories from disk via `readdirSync`.

**VERDICT: SOLID** -- The parameter is actively used to construct and scan project-local skill directories.

---

## Check 6: Zod Enum Schemas (Wave 1)

**File**: `packages/core/src/store/validation-schemas.ts`

### Findings

- **Enum sourcing**: The Zod enum schemas import the ACTUAL constants from the source of truth:
  - `TASK_PRIORITIES`, `TASK_TYPES`, `TASK_SIZES` from `./tasks-schema.ts` (lines 49-51)
  - `TASK_STATUSES`, `SESSION_STATUSES`, `LIFECYCLE_PIPELINE_STATUSES`, etc. from `./status-registry.ts` (lines 63-71), which re-exports from `@cleocode/contracts`
  - Brain enums (`BRAIN_PATTERN_TYPES`, `BRAIN_OBSERVATION_TYPES`, etc.) from `./brain-schema.ts` (lines 74-89)
  - Agent enums (`AGENT_INSTANCE_STATUSES`, `AGENT_TYPES`) from `./tasks-schema.ts` (lines 56-58)
- **NOT hardcoded duplicates**: Every enum schema wraps the actual constant array. Example: `z.enum(TASK_STATUSES)` not `z.enum(['pending', 'active', ...])`.
- **One exception**: `taskRelationTypeSchema` at line 143 uses a hardcoded inline array `['related', 'blocks', 'duplicates', 'absorbs', 'fixes', 'extends', 'supersedes']`. This could drift from the actual DB constraint.
- **Drizzle-derived schemas**: Uses `createInsertSchema` and `createSelectSchema` from `drizzle-orm/zod` to auto-derive insert/select schemas from Drizzle table definitions.
- **Business rule refinements**: Non-trivial:
  - Task ID: `s.regex(/^T\d{3,}$/)` -- enforces T + 3+ digit format
  - Task title: `s.min(1).max(120)` -- length bounds
  - Audit log: UUID validation, datetime validation, field length constraints
  - Release manifest: Semver regex `s.regex(/^\d{4}\.\d+\.\d+$|^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/)`
  - External task links: `s.url()` for external URLs
  - Agent instance ID: `s.regex(/^agt_\d{14}_[0-9a-f]{6}$/)` -- enforces ID format
  - Lifecycle stage: block/skip reason max length 1000
  - Gate results: gateName and checkedBy length constraints

### Concerns

- The `taskRelationTypeSchema` hardcoded array is the only enum not sourced from a constant. Minor drift risk.
- The `externalLinkTypeSchema` and `syncDirectionSchema` are also hardcoded inline, though these are small and stable.

### VERDICT: **SOLID**

The overwhelming majority of enum schemas properly reference canonical constants. The Drizzle-derived schemas with refinements add genuine validation. Three small inline enums are the only blemish.

---

## Check 7: Hook Payload Schemas (Wave 1)

**File**: `packages/core/src/hooks/payload-schemas.ts`

### Findings

- **NOT `z.object({}).passthrough()`**: Every schema has specific required and optional fields:
  - `OnSessionStartPayloadSchema`: requires `sessionId`, `name`, `scope` (all `z.string()`), optional `agent`
  - `OnSessionEndPayloadSchema`: requires `sessionId`, `duration` (`z.number()`), `tasksCompleted` (`z.array(z.string())`)
  - `OnToolCompletePayloadSchema`: requires `taskId`, `taskTitle`, `status` with enum validation `z.enum(['done', 'archived', 'cancelled'])`
  - `OnFileChangePayloadSchema`: requires `filePath`, `changeType` with `z.enum(['write', 'create', 'delete'])`
  - `OnErrorPayloadSchema`: requires `errorCode` (`z.union([z.number(), z.string()])`), `message`
  - `OnAgentCompletePayloadSchema`: requires `agentId`, `role`, `status` with `z.enum(['complete', 'partial', 'blocked', 'failed'])`
  - `OnPatrolPayloadSchema`: requires `watcherId`, `patrolType` with `z.enum(['health', 'sweep', 'refinery', 'watcher', 'custom'])`
- **Base schema**: `HookPayloadSchema` with `timestamp: z.iso.datetime()`, optional `sessionId`, `taskId`, `providerId`, `metadata: z.record(z.string(), z.unknown())`. All event schemas extend this base.
- **validatePayload()**: REAL dispatcher at line 190. Uses `EVENT_SCHEMA_MAP` (13 entries, lines 151-165) to look up the correct schema by event name, falls back to base schema for unknown events. Uses `safeParse` and returns structured error messages with paths.
- **13 event schemas mapped**: onSessionStart, onSessionEnd, onToolStart, onToolComplete, onFileChange, onError, onPromptSubmit, onResponseComplete, onWorkAvailable, onAgentSpawn, onAgentComplete, onCascadeStart, onPatrol.

### Concerns

- The fallback to `HookPayloadSchema` for unmapped events means new events without schemas would only validate the base fields. This is acceptable defensive design.

### VERDICT: **SOLID**

Strict, typed schemas with enum constraints, required field enforcement, and proper event-to-schema dispatch. No passthrough shortcuts.

---

## Check 8: Nexus E2E Tests (Wave 1)

**File**: `packages/core/src/nexus/__tests__/nexus-e2e.test.ts`

### Findings

- **REAL integration tests**: Every test creates actual temp directories (`mkdtemp`), SQLite databases (`createTestProjectDb` which calls `createSqliteDataAccessor` and `seedTasks`), and runs real operations. Lines 77-86 show the helper creating `.cleo` dirs and seeding tasks into SQLite.
- **No mocking**: Zero mock imports. Tests use real `getNexusDb()`, real `nexusRegister()`, real filesystem operations.
- **Proper setup/teardown**: `beforeEach` creates temp dirs, sets env vars, resets DB state. `afterEach` cleans up env vars, resets state, and `rm(testDir, { recursive: true, force: true })`. Lines 108-134.
- **16 test categories** covering:
  1. Audit log verification (8 tests) -- verifies actual DB rows after operations
  2. Health status (4 tests) -- tests status storage, updates, retrieval, and all valid values
  3. Permission updates (6 tests) -- tests upgrades, downgrades, error cases
  4. Schema integrity (5 tests) -- verifies schema version, table existence, indexes, file creation
  5. Multi-project operations (4 tests) -- registers 5 projects, sync-all, structure verification
  6. Cross-project task resolution (5 tests) -- named project resolution, wildcard, error cases
  7. Dependency graph (4 tests) -- multi-project graphs, forward/reverse deps
  8. Orphan detection (2 tests) -- local deps, no-deps case
  9. Blocking analysis (1 test) -- diamond dependency pattern
  10. Critical path (2 tests) -- structure validation, blocker detection
  11. Discovery module (12 tests) -- keyword extraction, cross-project search, related task discovery
  12. Reconciliation (2 tests) -- hash-based lookup, auto-registration
  13. Edge cases (9 tests) -- long paths, empty inputs, idempotency, hash determinism
  14. Query module (4 tests) -- syntax validation, parsing, project extraction
  15. Permission module (5 tests) -- hierarchy, bypass, detail, error messages
  16. Graph caching (1 test) -- cache invalidation
- **Error/edge case coverage**: Tests for empty strings, non-existent projects, permission downgrades, long paths, idempotent init, empty task lists, invalid query syntax, wildcard queries, unique UUIDs.
- **Assertion quality**: Tests make specific assertions against DB state (e.g., checking `entry.action === 'register'`, `entry.success === 1`, parsing `detailsJson`). Not just `toBeTruthy()` everywhere.

### Concerns

- Some tests verify structure more than behavior (e.g., critical path test at line 863 checks `result.length === result.criticalPath.length` which is trivially true). Minor.
- No explicit concurrency tests. Acceptable for SQLite.

### VERDICT: **SOLID**

These are genuine integration tests with real database operations, filesystem setup, comprehensive coverage across 16 categories, and meaningful assertions including error cases.

---

## Summary Scorecard

| Check | Area | Wave | Verdict |
|-------|------|------|---------|
| 1 | Agent Registry | 2 | **SOLID** |
| 2 | Intelligence Prediction | 3 | **SOLID** |
| 3 | Pattern Extraction | 3 | **SOLID** |
| 4 | Impact Analysis | 3 | **SOLID** |
| 5a | State Machine skipReason | 1 | **SOLID** |
| 5b | SignalDock poll since | 1 | **SOLID** |
| 5c | Skill-ops projectRoot | 1 | **SOLID** |
| 6 | Zod Enum Schemas | 1 | **SOLID** |
| 7 | Hook Payload Schemas | 1 | **SOLID** |
| 8 | Nexus E2E Tests | 1 | **SOLID** |

## Honest Overall Assessment

**The agents did real work.** None of the 8 checks revealed stubs, hardcoded returns, in-memory-only shortcuts, or passthrough schemas. Every module examined:

1. Uses actual SQLite operations through Drizzle ORM or BrainDataAccessor
2. Implements non-trivial algorithms (BFS graph traversal, weighted multi-factor scoring, running-average stats)
3. Handles error cases and edge conditions
4. References canonical constants rather than duplicating them

**The only shortcut patterns found were:**
- Scalability -- several modules load all tasks into memory for analysis. Acceptable for the current scale but worth noting.
- Three inline Zod enum arrays instead of referencing constants. Drift risk but not fake work.
- `updateAgentStatus` SELECT-then-UPDATE is not atomic. Minor under SQLite's single-writer model.

**Bottom line**: This is one of the cleaner multi-agent outputs I have examined. The code is structurally sound, properly wired to the database layer, and the test suite is genuinely comprehensive with real I/O. No evidence of lying or taking shortcuts.
