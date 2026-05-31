/**
 * Sentient Loop Propose Tick — Single-pass Tier-2 proposal generator.
 *
 * Runs inside the daemon cron (every 2 hours) or standalone via
 * `cleo sentient propose run`. Orchestrates the three ingesters,
 * deduplicates candidates by fingerprint, applies the DB-enforced
 * rate limit, and writes accepted candidates as tasks with
 * `status='proposed'` and labels including `'sentient-tier2'`.
 *
 * Scoped IN:
 *   - Ingest from brain.db, nexus.db, and .cleo/audit/gates.jsonl
 *   - Transactional rate-limit check (BEGIN IMMEDIATE + COUNT + INSERT)
 *   - Kill-switch re-check at each checkpoint (Round 2 audit §9)
 *   - tier2Enabled guard (default false — owner opt-in)
 *   - Auto-promotion scan: proposals exceeding weight threshold that pass
 *     the classifyReadiness grill gate transition proposed→pending automatically
 *     (E7-CLOSE-LOOPS T11499 AC1)
 *
 * Scoped OUT:
 *   - LLM calls (NONE — all proposal titles are structured templates)
 *   - Tier-3 sandbox/merge (blocked on T992+T993+T995)
 *
 * Title format enforcement:
 *   All proposal titles MUST match `/^\[T2-(BRAIN|NEXUS|TEST)\]/`.
 *   This is the prompt-injection defence from T1008 §3.6 — no freeform
 *   LLM text can enter the task title column from the Tier-2 proposer.
 *
 * @task T1008
 * @task T11499 E7-CLOSE-LOOPS — Tier-2 auto-promotion + cleo classify
 * @see ADR-054 — Sentient Loop Tier-2
 */

import type { ProposalCandidate, Task } from '@cleocode/contracts';
import { pushWarning } from '@cleocode/lafs';
import { classifyReadiness } from '../orchestration/classify-readiness.js';
import { runBrainIngester } from './ingesters/brain-ingester.js';
import { runNexusIngester } from './ingesters/nexus-ingester.js';
import { runTestIngester } from './ingesters/test-ingester.js';
import { checkDedupCollision, recordDedupRejection } from './proposal-dedup.js';
import {
  countTodayProposals,
  DEFAULT_DAILY_PROPOSAL_LIMIT,
  transactionalInsertProposal,
} from './proposal-rate-limiter.js';
import { patchSentientState, readSentientState } from './state.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Regex that ALL proposal titles MUST match.
 * Enforces structured-template-only output (no freeform LLM text).
 */
export const PROPOSAL_TITLE_PATTERN = /^\[T2-(BRAIN|NEXUS|TEST)\]/;

/**
 * Label applied to every Tier-2 proposal task.
 * Used by the rate limiter to identify proposals.
 */
export const TIER2_LABEL = 'sentient-tier2';

/**
 * Minimum proposal weight required for auto-promotion consideration.
 *
 * Proposals below this threshold remain in `proposed` status and require
 * manual `cleo sentient propose accept` to enter the Tier-1 run queue.
 *
 * The value 0.7 corresponds to the 70th-percentile weight signal (combined
 * brain citation density + nexus coupling score) surfaced by the ingesters.
 *
 * @task T11499 E7-CLOSE-LOOPS
 */
export const TIER2_AUTO_PROMOTE_WEIGHT_THRESHOLD = 0.7 as const;

/**
 * Maximum number of proposals auto-promoted in a single scan pass.
 *
 * Guards against bulk promotions flooding the Tier-1 run queue when a
 * BRAIN reconciler sweep suddenly raises many candidates above the threshold.
 *
 * @task T11499 E7-CLOSE-LOOPS
 */
export const TIER2_AUTO_PROMOTE_MAX_PER_PASS = 5 as const;

// ---------------------------------------------------------------------------
// Outcome types
// ---------------------------------------------------------------------------

/** Discriminant for the propose-tick outcome. */
export type ProposalTickOutcomeKind =
  | 'killed' // killSwitch active
  | 'disabled' // tier2Enabled = false
  | 'rate-limited' // daily cap already reached
  | 'no-candidates' // all ingesters returned empty
  | 'wrote' // at least one proposal was written
  | 'error'; // unexpected error

/** Structured outcome of a single propose-tick pass. */
export interface ProposeTickOutcome {
  /** Discriminant describing how the tick ended. */
  kind: ProposalTickOutcomeKind;
  /** Number of proposals written in this pass. */
  written: number;
  /** Current daily proposal count at the end of the pass. */
  count: number;
  /** Human-readable detail (one line). */
  detail: string;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options for {@link runProposeTick}. */
export interface ProposeTickOptions {
  /** Absolute path to the project root (contains `.cleo/`). */
  projectRoot: string;
  /** Absolute path to sentient-state.json. */
  statePath: string;
  /**
   * Override for the brain DB handle. Injected by tests to avoid
   * opening a real brain.db. When omitted the real getBrainNativeDb() is used.
   */
  brainDb?: import('node:sqlite').DatabaseSync | null;
  /**
   * Override for the nexus DB handle. Injected by tests.
   * When omitted the real getNexusNativeDb() is used.
   */
  nexusDb?: import('node:sqlite').DatabaseSync | null;
  /**
   * Override for the tasks DB handle (used by rate limiter + INSERT).
   * Injected by tests. When omitted the real getNativeTasksDb() is used.
   */
  tasksDb?: import('node:sqlite').DatabaseSync | null;
  /**
   * Override the task ID allocator. Injected by tests.
   * When omitted the real allocateNextTaskId() is used.
   */
  allocateTaskId?: () => Promise<string>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute a deduplication fingerprint for a candidate.
 * Two candidates with the same source + sourceId are considered identical.
 */
function fingerprint(candidate: ProposalCandidate): string {
  return `${candidate.source}:${candidate.sourceId}`;
}

/**
 * Check whether the kill switch is currently active.
 */
async function killSwitchActive(statePath: string): Promise<boolean> {
  const state = await readSentientState(statePath);
  return state.killSwitch === true;
}

/**
 * T1148 W8-8 — Dispatch-time brain health reflex (T1151 Sentient Self-Healing).
 *
 * Checks the brain corpus for noise markers before the Tier-2 proposer reads
 * from BRAIN to generate proposals.  If unhealthy, triggers the reconciler
 * sweep asynchronously (fire-and-forget) so future propose ticks run against
 * a progressively cleaner corpus.
 *
 * This is intentionally NON-BLOCKING — the propose tick continues regardless.
 * The M7 hard gate (assertMemoryClean in setTier2Enabled) remains the entry
 * condition; this reflex is ongoing health maintenance post-activation.
 *
 * Kill-switch is respected: no reconciler trigger if killSwitch is active.
 *
 * ### T10351 — concurrent-sweep guard
 *
 * The original implementation fire-and-forget'd a parallel reconciler sweep
 * which could overlap with the dialectic-hook + STDP plasticity writers —
 * the exact concurrent-write storm identified in the T10301 RCA. The reflex
 * now serializes via `_reconcilerInFlight` and AWAITS the sweep so writes
 * don't race with anything else this propose tick will do next.
 *
 * @param projectRoot - Absolute project root for DB resolution.
 * @param statePath   - Path to sentient-state.json for kill-switch check.
 */
let _reconcilerInFlight = false;

async function checkBrainHealthReflex(projectRoot: string, statePath: string): Promise<void> {
  try {
    // Respect kill-switch — do not trigger reconciler if killed.
    const killed = await killSwitchActive(statePath);
    if (killed) return;

    const { scanBrainNoise } = await import('../memory/brain-doctor.js');
    const result = await scanBrainNoise(projectRoot);

    if (!result.isClean) {
      // T10351: serialize the reconciler trigger. The original implementation
      // fire-and-forget'd a parallel reconciler sweep that could overlap with
      // the dialectic-hook setImmediate writer + ongoing STDP writes — the
      // exact concurrent-write storm identified in the T10301 RCA. We now
      // skip silently if another sweep is already in flight, and otherwise
      // await the sweep so its writes don't race with anything else this
      // propose tick will do next.
      if (_reconcilerInFlight) return;
      _reconcilerInFlight = true;
      try {
        const { triggerReconcilerSweep } = await import('../memory/brain-reconciler.js');
        await triggerReconcilerSweep(projectRoot);
      } catch {
        // non-fatal — reconciler errors must never break the propose tick
      } finally {
        _reconcilerInFlight = false;
      }
    }
  } catch {
    // Health-reflex errors are non-fatal; the propose tick must continue.
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run a single Tier-2 propose pass.
 *
 * Steps:
 *   1. Check killSwitch → abort if true
 *   2. Check tier2Enabled → abort if false
 *   3. Run all three ingesters in parallel
 *   4. Check killSwitch again (post-ingest checkpoint)
 *   5. Merge + deduplicate candidates by fingerprint
 *   6. Validate title format (must match PROPOSAL_TITLE_PATTERN)
 *   7. Score + take top-N candidates (N = limit - countTodayProposals)
 *   8. Check killSwitch again (pre-write checkpoint)
 *   9. For each candidate: transactional INSERT into tasks.db
 *  10. Update tier2Stats in state
 *
 * @param options - Propose tick options (see {@link ProposeTickOptions})
 * @returns Structured outcome describing how the pass ended.
 */
export async function runProposeTick(options: ProposeTickOptions): Promise<ProposeTickOutcome> {
  const { projectRoot, statePath } = options;

  // Checkpoint 1: killSwitch before any work
  if (await killSwitchActive(statePath)) {
    return { kind: 'killed', written: 0, count: 0, detail: 'killSwitch active before ingest' };
  }

  // Check tier2Enabled guard
  const state = await readSentientState(statePath);
  if (!state.tier2Enabled) {
    return {
      kind: 'disabled',
      written: 0,
      count: 0,
      detail: 'tier2Enabled=false; enable via cleo sentient propose enable',
    };
  }

  // T1148 W8-8 (T1151 dispatch-time reflex): before reading BRAIN for proposals,
  // check corpus health and asynchronously trigger reconciler if dirty.
  // This is a NON-BLOCKING health maintenance pass — the propose tick continues
  // regardless; the M7 gate (setTier2Enabled) is the hard entry gate.
  await checkBrainHealthReflex(projectRoot, statePath);

  // Resolve DB handles
  let brainDb: import('node:sqlite').DatabaseSync | null;
  let nexusDb: import('node:sqlite').DatabaseSync | null;
  let tasksNativeDb: import('node:sqlite').DatabaseSync | null;

  if (options.brainDb !== undefined) {
    brainDb = options.brainDb;
  } else {
    // Ensure brain.db is initialized before calling getBrainNativeDb
    try {
      const { getBrainDb, getBrainNativeDb } = await import('@cleocode/core/internal');
      await getBrainDb(projectRoot);
      brainDb = getBrainNativeDb();
    } catch {
      brainDb = null;
    }
  }

  if (options.nexusDb !== undefined) {
    nexusDb = options.nexusDb;
  } else {
    try {
      const { getNexusDb, getNexusNativeDb } = await import('@cleocode/core/internal');
      await getNexusDb();
      nexusDb = getNexusNativeDb();
    } catch {
      nexusDb = null;
    }
  }

  if (options.tasksDb !== undefined) {
    tasksNativeDb = options.tasksDb;
  } else {
    const { getNativeDb, getDb } = await import('@cleocode/core/internal');
    // Ensure tasks.db is initialized
    await getDb(projectRoot);
    tasksNativeDb = getNativeDb();
  }

  // Run all three ingesters in parallel
  const [brainCandidates, nexusCandidates, testCandidates] = await Promise.all([
    Promise.resolve(runBrainIngester(brainDb)),
    Promise.resolve(runNexusIngester(nexusDb)),
    Promise.resolve(runTestIngester(projectRoot)),
  ]);

  // Checkpoint 2: killSwitch after ingest
  if (await killSwitchActive(statePath)) {
    return {
      kind: 'killed',
      written: 0,
      count: 0,
      detail: 'killSwitch active after ingest phase',
    };
  }

  // Merge + deduplicate by fingerprint
  const seenFingerprints = new Set<string>();
  const merged: ProposalCandidate[] = [];

  for (const candidate of [...brainCandidates, ...nexusCandidates, ...testCandidates]) {
    // Validate title format — reject candidates with non-template titles
    if (!PROPOSAL_TITLE_PATTERN.test(candidate.title)) {
      // Surface via envelope warnings instead of stderr (T9773).
      pushWarning({
        code: 'W_PROPOSE_AUDIT_FAILED',
        severity: 'warn',
        message: `[sentient/propose-tick] Rejected candidate with invalid title format: "${candidate.title}"`,
        context: {
          phase: 'title-validation',
          source: candidate.source,
          sourceId: candidate.sourceId,
          title: candidate.title,
        },
      });
      continue;
    }

    const fp = fingerprint(candidate);
    if (seenFingerprints.has(fp)) continue;
    seenFingerprints.add(fp);
    merged.push(candidate);
  }

  if (merged.length === 0) {
    return { kind: 'no-candidates', written: 0, count: 0, detail: 'no candidates from ingesters' };
  }

  // Sort by weight descending
  merged.sort((a, b) => b.weight - a.weight);

  // Determine how many slots remain today
  const currentCount = tasksNativeDb ? countTodayProposals(tasksNativeDb) : 0;
  const slotsRemaining = Math.max(0, DEFAULT_DAILY_PROPOSAL_LIMIT - currentCount);

  if (slotsRemaining === 0) {
    return {
      kind: 'rate-limited',
      written: 0,
      count: currentCount,
      detail: `daily limit reached (${currentCount}/${DEFAULT_DAILY_PROPOSAL_LIMIT})`,
    };
  }

  // Take top-N candidates
  const toWrite = merged.slice(0, slotsRemaining);

  // Checkpoint 3: killSwitch before DB writes
  if (await killSwitchActive(statePath)) {
    return {
      kind: 'killed',
      written: 0,
      count: currentCount,
      detail: 'killSwitch active before write phase',
    };
  }

  // Write proposals
  let written = 0;
  let dedupRejected = 0;

  for (const candidate of toWrite) {
    if (!tasksNativeDb) {
      // Surface via envelope warnings instead of stderr (T9773).
      pushWarning({
        code: 'W_PROPOSE_AUDIT_FAILED',
        severity: 'warn',
        message: '[sentient/propose-tick] tasks DB not available; skipping write',
        context: { phase: 'pre-write', reason: 'tasks-db-unavailable' },
      });
      break;
    }

    // T1592 — per-parent dedup gate.  Sentient proposals are root tasks
    // (parent_id IS NULL), so collisions detect cross-tick duplicates of the
    // T1555 burst pattern.  Hash is computed before rate-limit insert so that
    // a skipped dup does not consume a daily slot.
    const dedupCheck = checkDedupCollision({
      tasksDb: tasksNativeDb,
      candidate: {
        parentId: null,
        title: candidate.title,
        acceptance: candidate.rationale,
      },
    });

    if (dedupCheck.isDuplicate && dedupCheck.existingTaskId) {
      dedupRejected++;
      try {
        await recordDedupRejection({
          projectRoot,
          parentId: null,
          title: candidate.title,
          source: candidate.source,
          sourceId: candidate.sourceId,
          dedupHash: dedupCheck.dedupHash,
          existingTaskId: dedupCheck.existingTaskId,
        });
      } catch (auditErr) {
        // Surface via envelope warnings instead of stderr (T9773).
        const message = auditErr instanceof Error ? auditErr.message : String(auditErr);
        pushWarning({
          code: 'W_PROPOSE_AUDIT_FAILED',
          severity: 'warn',
          message: `[sentient/propose-tick] audit append failed: ${message}`,
          context: {
            phase: 'dedup-audit-append',
            source: candidate.source,
            sourceId: candidate.sourceId,
            error: message,
          },
        });
      }
      continue;
    }

    // Allocate task ID
    let taskId: string;
    if (options.allocateTaskId) {
      taskId = await options.allocateTaskId();
    } else {
      const { allocateNextTaskId } = await import('@cleocode/core/internal');
      taskId = await allocateNextTaskId(projectRoot);
    }

    const now = new Date().toISOString();
    const labels = JSON.stringify([TIER2_LABEL, `source:${candidate.source}`]);

    // Use the SQL INSERT path (with metadata_json-equivalent stored in notes_json
    // as a structured first element) and labels to mark the proposal.
    // The rate limiter identifies proposals by: labels_json LIKE '%sentient-tier2%'
    // This avoids needing a new column on the tasks table.
    // T1592: dedupHash is embedded inside the proposal-meta envelope so future
    // ticks can detect cross-tick duplicates via a substring LIKE query.
    const notesJson = JSON.stringify([
      JSON.stringify({
        kind: 'proposal-meta',
        proposedBy: 'sentient-tier2',
        source: candidate.source,
        sourceId: candidate.sourceId,
        weight: candidate.weight,
        proposedAt: now,
        dedupHash: dedupCheck.dedupHash,
      }),
    ]);

    // DB column is named 'role' (T9067 deferral — CHECK constraint defers rename)
    const insertSql = `
      INSERT INTO tasks (
        id, title, description, status, priority,
        labels_json, notes_json,
        created_at, updated_at,
        role, scope
      ) VALUES (
        :id, :title, :description, :status, :priority,
        :labelsJson, :notesJson,
        :createdAt, :updatedAt,
        :kind, :scope
      )
    `;

    const insertParams = {
      id: taskId,
      title: candidate.title,
      description: candidate.rationale,
      status: 'proposed',
      priority: 'medium',
      labelsJson: labels,
      notesJson,
      createdAt: now,
      updatedAt: now,
      kind: 'work',
      scope: 'feature',
    };

    try {
      const result = transactionalInsertProposal(
        tasksNativeDb,
        insertSql,
        insertParams,
        DEFAULT_DAILY_PROPOSAL_LIMIT,
      );

      if (result.inserted) {
        written++;
        // T11356: keep the task_labels junction in sync so Tier-2 membership
        // filters (sentientProposeList/Accept/Reject) — now junction joins, not
        // labels_json LIKE — see this proposal. INSERT OR IGNORE is idempotent.
        if (tasksNativeDb) {
          const labelStmt = tasksNativeDb.prepare(
            'INSERT OR IGNORE INTO task_labels (task_id, label) VALUES (?, ?)',
          );
          labelStmt.run(taskId, TIER2_LABEL);
          labelStmt.run(taskId, `source:${candidate.source}`);
        }
      } else if (result.reason === 'rate-limit') {
        // Rate limit hit mid-loop — stop writing.
        break;
      }
      // If 'busy', skip this one and continue.
    } catch (err) {
      // Surface via envelope warnings instead of stderr (T9773).
      const message = err instanceof Error ? err.message : String(err);
      pushWarning({
        code: 'W_PROPOSE_AUDIT_FAILED',
        severity: 'warn',
        message: `[sentient/propose-tick] INSERT failed for ${taskId}: ${message}`,
        context: { phase: 'transactional-insert', taskId, error: message },
      });
    }
  }

  // Update tier2Stats
  if (written > 0) {
    const latestState = await readSentientState(statePath);
    await patchSentientState(statePath, {
      tier2Stats: {
        ...latestState.tier2Stats,
        proposalsGenerated: latestState.tier2Stats.proposalsGenerated + written,
      },
    });
  }

  const finalCount = tasksNativeDb ? countTodayProposals(tasksNativeDb) : currentCount + written;

  if (written === 0) {
    return {
      kind: 'no-candidates',
      written: 0,
      count: finalCount,
      detail:
        dedupRejected > 0
          ? `candidates available but all ${dedupRejected} rejected by per-parent dedup gate (T1592)`
          : 'candidates available but none written (rate limit or DB unavailable)',
    };
  }

  const dedupSuffix = dedupRejected > 0 ? `; ${dedupRejected} dup(s) rejected (T1592)` : '';
  return {
    kind: 'wrote',
    written,
    count: finalCount,
    detail: `wrote ${written} proposal(s) (${finalCount}/${DEFAULT_DAILY_PROPOSAL_LIMIT} today)${dedupSuffix}`,
  };
}

/**
 * Safe wrapper for {@link runProposeTick} — swallows unexpected exceptions.
 * Used by the daemon cron handler.
 *
 * @param options - Propose tick options
 * @returns The propose tick outcome, or an error outcome if the tick threw.
 */
export async function safeRunProposeTick(options: ProposeTickOptions): Promise<ProposeTickOutcome> {
  try {
    return await runProposeTick(options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      kind: 'error',
      written: 0,
      count: 0,
      detail: `propose tick threw: ${message}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Tier-2 Auto-Promotion Scan (E7-CLOSE-LOOPS · T11499 AC1)
// ---------------------------------------------------------------------------

/**
 * Outcome of a single auto-promotion scan pass.
 *
 * @task T11499 E7-CLOSE-LOOPS
 */
export interface AutoPromoteOutcome {
  /** Number of proposals promoted to `pending` in this pass. */
  promoted: number;
  /** Number of proposals inspected (above weight threshold). */
  scanned: number;
  /** Number of proposals grilled (blocked by classifyReadiness). */
  grilled: number;
  /** Human-readable summary. */
  detail: string;
}

/**
 * Options for {@link runProposalAutoPromoteScan}.
 *
 * @task T11499 E7-CLOSE-LOOPS
 */
export interface AutoPromoteScanOptions {
  /** Absolute path to the project root (contains `.cleo/`). */
  projectRoot: string;
  /** Absolute path to sentient-state.json. */
  statePath: string;
  /**
   * Override for the tasks DB handle (used by SELECT + UPDATE).
   * When omitted, the real `getNativeTasksDb()` is used.
   */
  tasksDb?: import('node:sqlite').DatabaseSync | null;
  /**
   * Weight threshold for auto-promotion candidacy.
   * Proposals whose stored `weight` is below this value are skipped.
   * Defaults to {@link TIER2_AUTO_PROMOTE_WEIGHT_THRESHOLD} (0.7).
   */
  weightThreshold?: number;
  /**
   * Maximum proposals to promote per pass.
   * Defaults to {@link TIER2_AUTO_PROMOTE_MAX_PER_PASS} (5).
   */
  maxPerPass?: number;
}

/**
 * Scan all `proposed` Tier-2 tasks and auto-promote those that:
 *  1. Have a proposal weight ≥ `weightThreshold` (default 0.7), AND
 *  2. Pass the {@link classifyReadiness} grill gate — i.e. verdict `'proceed'`.
 *
 * Promotes eligible tasks from `proposed` → `pending` so they enter the
 * Tier-1 run queue without requiring manual `cleo sentient propose accept`.
 * This closes the BRAIN learning loop (E7-CLOSE-LOOPS T11499 AC1).
 *
 * **Grill gate semantics**: `classifyReadiness` checks five triggers
 * (MISSING_AC, OWNER_DECISION_REQUIRED, IVTR_MAX_RETRIES, RELEASE_GATE,
 * AMBIGUOUS_SCOPE). A proposal that fires any trigger is left in `proposed`
 * status and counted in the `grilled` field so callers can surface it.
 *
 * **Kill-switch respected**: if the sentient kill-switch is active no
 * promotions are attempted and the function returns immediately.
 *
 * **Pure DB path**: no ingesters are invoked. The scan reads existing
 * `proposed` tasks directly from `tasks.db` via the junction query.
 *
 * @param options - Scan options (see {@link AutoPromoteScanOptions}).
 * @returns Structured outcome describing how many proposals were promoted.
 *
 * @task T11499 E7-CLOSE-LOOPS AC1
 */
export async function runProposalAutoPromoteScan(
  options: AutoPromoteScanOptions,
): Promise<AutoPromoteOutcome> {
  const {
    projectRoot,
    statePath,
    weightThreshold = TIER2_AUTO_PROMOTE_WEIGHT_THRESHOLD,
    maxPerPass = TIER2_AUTO_PROMOTE_MAX_PER_PASS,
  } = options;

  // Kill-switch guard — do nothing if the daemon is halted.
  const state = await readSentientState(statePath);
  if (state.killSwitch) {
    return {
      promoted: 0,
      scanned: 0,
      grilled: 0,
      detail: 'auto-promote scan skipped: killSwitch active',
    };
  }

  // Resolve tasks DB.
  let tasksNativeDb: import('node:sqlite').DatabaseSync | null;
  if (options.tasksDb !== undefined) {
    tasksNativeDb = options.tasksDb;
  } else {
    const { getNativeDb, getDb } = await import('@cleocode/core/internal');
    await getDb(projectRoot);
    tasksNativeDb = getNativeDb();
  }

  if (!tasksNativeDb) {
    return {
      promoted: 0,
      scanned: 0,
      grilled: 0,
      detail: 'auto-promote scan skipped: tasks DB not available',
    };
  }

  // Query all `proposed` Tier-2 tasks via junction (index-backed).
  // We fetch the full row so we can build a Task object for classifyReadiness.
  const proposedRows = tasksNativeDb
    .prepare(
      `SELECT t.id, t.title, t.description, t.status, t.priority,
              t.labels_json, t.notes_json, t.created_at, t.updated_at,
              t.acceptance_json, t.type, t.kind, t.scope, t.phase,
              t.pipeline_stage, t.blocked_by
       FROM tasks t
       INNER JOIN task_labels tl ON tl.task_id = t.id AND tl.label = ?
       WHERE t.status = 'proposed'
       ORDER BY t.created_at ASC`,
    )
    .all(TIER2_LABEL) as Array<Record<string, unknown>>;

  if (proposedRows.length === 0) {
    return {
      promoted: 0,
      scanned: 0,
      grilled: 0,
      detail: 'no proposed Tier-2 tasks found',
    };
  }

  // Filter to candidates above the weight threshold.
  const candidates: Array<{ row: Record<string, unknown>; weight: number }> = [];
  for (const row of proposedRows) {
    const weight = extractProposalWeight(row.notes_json as string | null);
    if (weight >= weightThreshold) {
      candidates.push({ row, weight });
    }
  }

  if (candidates.length === 0) {
    return {
      promoted: 0,
      scanned: 0,
      grilled: 0,
      detail: `no proposed tasks exceed weight threshold ${weightThreshold}`,
    };
  }

  // Sort by weight descending — promote highest-signal proposals first.
  candidates.sort((a, b) => b.weight - a.weight);

  let promoted = 0;
  let grilled = 0;
  const scanned = candidates.length;
  const toConsider = candidates.slice(0, maxPerPass);

  const now = new Date().toISOString();
  const updateStmt = tasksNativeDb.prepare(
    `UPDATE tasks SET status = 'pending', updated_at = ? WHERE id = ? AND status = 'proposed'`,
  );

  for (const { row } of toConsider) {
    const taskId = row.id as string;

    // Build a minimal Task object for classifyReadiness.
    const task: Task = buildTaskFromRow(row);

    // Grill gate: classifyReadiness determines if the task can proceed autonomously.
    const readiness = classifyReadiness(task);
    if (readiness.verdict === 'grill') {
      grilled++;
      continue;
    }

    // Promote: proposed → pending.
    try {
      const result = updateStmt.run(now, taskId);
      if ((result as { changes: number }).changes > 0) {
        promoted++;
      }
    } catch {
      // Non-fatal — log via warning and continue to next candidate.
      pushWarning({
        code: 'W_PROPOSE_AUDIT_FAILED',
        severity: 'warn',
        message: `[sentient/propose-tick] auto-promote UPDATE failed for ${taskId}`,
        context: { phase: 'auto-promote', taskId },
      });
    }
  }

  // Persist stat increment.
  if (promoted > 0) {
    const latestState = await readSentientState(statePath);
    await patchSentientState(statePath, {
      tier2Stats: {
        ...latestState.tier2Stats,
        proposalsAccepted: latestState.tier2Stats.proposalsAccepted + promoted,
      },
    });
  }

  return {
    promoted,
    scanned,
    grilled,
    detail:
      `auto-promote scan: scanned ${scanned} candidate(s) above weight ${weightThreshold}, ` +
      `promoted ${promoted}, grilled ${grilled}`,
  };
}

/**
 * Safe wrapper for {@link runProposalAutoPromoteScan} — swallows unexpected exceptions.
 *
 * @param options - Scan options
 * @returns Structured outcome, or an error-annotated outcome if the scan threw.
 * @task T11499 E7-CLOSE-LOOPS AC1
 */
export async function safeRunProposalAutoPromoteScan(
  options: AutoPromoteScanOptions,
): Promise<AutoPromoteOutcome> {
  try {
    return await runProposalAutoPromoteScan(options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      promoted: 0,
      scanned: 0,
      grilled: 0,
      detail: `auto-promote scan threw: ${message}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers for auto-promotion scan
// ---------------------------------------------------------------------------

/**
 * Extract the `weight` field from a proposal's `notes_json` column.
 *
 * The proposal-meta envelope is stored as `JSON.stringify([JSON.stringify({kind:'proposal-meta',...})])`.
 * Returns 0 when absent or unparseable so callers can use simple comparison.
 */
function extractProposalWeight(notesJson: string | null | undefined): number {
  if (!notesJson) return 0;
  try {
    const outer = JSON.parse(notesJson);
    if (!Array.isArray(outer) || outer.length === 0) return 0;
    const first = outer[0];
    if (typeof first !== 'string') return 0;
    const meta = JSON.parse(first);
    if (meta.kind === 'proposal-meta' && typeof meta.weight === 'number') {
      return meta.weight;
    }
    return 0;
  } catch {
    return 0;
  }
}

/**
 * Build a minimal {@link Task} object from a raw SQLite row so that
 * {@link classifyReadiness} can evaluate it without opening any extra DB.
 *
 * Only the fields inspected by `classifyReadiness` are populated; others
 * remain at their zero values. The `id` and `title` are always present (NOT
 * NULL columns in the schema).
 */
function buildTaskFromRow(row: Record<string, unknown>): Task {
  // Parse acceptance criteria from acceptance_json (array of strings).
  let acceptance: string[] = [];
  try {
    const raw = row.acceptance_json as string | null;
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        acceptance = parsed.filter((x): x is string => typeof x === 'string');
      }
    }
  } catch {
    // leave empty
  }

  // Parse labels from labels_json.
  let labels: string[] = [];
  try {
    const raw = row.labels_json as string | null;
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        labels = parsed.filter((x): x is string => typeof x === 'string');
      }
    }
  } catch {
    // leave empty
  }

  const task: Task = {
    id: (row.id as string) ?? '',
    title: (row.title as string) ?? '',
    description: (row.description as string) ?? '',
    status: 'proposed',
    priority: ((row.priority as string) ?? 'medium') as Task['priority'],
    type: ((row.type as string) ?? 'task') as Task['type'],
    kind: ((row.kind as string) ?? 'work') as Task['kind'],
    labels,
    acceptance,
    createdAt: (row.created_at as string) ?? new Date().toISOString(),
  };

  // Conditionally assign optional fields only when present.
  const pipelineStage = row.pipeline_stage as string | undefined | null;
  if (pipelineStage) task.pipelineStage = pipelineStage;

  const blockedBy = row.blocked_by as string | undefined | null;
  if (blockedBy) task.blockedBy = blockedBy;

  const phase = row.phase as string | undefined | null;
  if (phase) task.phase = phase;

  const scope = row.scope as string | undefined | null;
  if (scope) task.scope = scope as Task['scope'];

  return task;
}
