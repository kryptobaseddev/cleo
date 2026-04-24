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
 * @see ADR-054 — Sentient Loop Tier-2
 */

import type { ProposalCandidate } from '@cleocode/contracts';
import { runBrainIngester } from './ingesters/brain-ingester.js';
import { runNexusIngester } from './ingesters/nexus-ingester.js';
import { runTestIngester } from './ingesters/test-ingester.js';
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
 * @param projectRoot - Absolute project root for DB resolution.
 * @param statePath   - Path to sentient-state.json for kill-switch check.
 */
async function checkBrainHealthReflex(projectRoot: string, statePath: string): Promise<void> {
  try {
    // Respect kill-switch — do not trigger reconciler if killed.
    const killed = await killSwitchActive(statePath);
    if (killed) return;

    const { scanBrainNoise } = await import('../memory/brain-doctor.js');
    const result = await scanBrainNoise(projectRoot);

    if (!result.isClean) {
      // Async fire-and-forget — do NOT await; never throw into the propose tick.
      void import('../memory/brain-reconciler.js')
        .then(({ triggerReconcilerSweep }) =>
          triggerReconcilerSweep(projectRoot).catch(() => {
            /* non-fatal */
          }),
        )
        .catch(() => {
          /* non-fatal */
        });
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
      process.stderr.write(
        `[sentient/propose-tick] Rejected candidate with invalid title format: "${candidate.title}"\n`,
      );
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

  for (const candidate of toWrite) {
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

    if (!tasksNativeDb) {
      process.stderr.write('[sentient/propose-tick] tasks DB not available; skipping write\n');
      break;
    }

    // Use the SQL INSERT path (with metadata_json-equivalent stored in notes_json
    // as a structured first element) and labels to mark the proposal.
    // The rate limiter identifies proposals by: labels_json LIKE '%sentient-tier2%'
    // This avoids needing a new column on the tasks table.
    const notesJson = JSON.stringify([
      JSON.stringify({
        kind: 'proposal-meta',
        proposedBy: 'sentient-tier2',
        source: candidate.source,
        sourceId: candidate.sourceId,
        weight: candidate.weight,
        proposedAt: now,
      }),
    ]);

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
        :role, :scope
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
      role: 'work',
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
      } else if (result.reason === 'rate-limit') {
        // Rate limit hit mid-loop — stop writing.
        break;
      }
      // If 'busy', skip this one and continue.
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[sentient/propose-tick] INSERT failed for ${taskId}: ${message}\n`);
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
      detail: 'candidates available but none written (rate limit or DB unavailable)',
    };
  }

  return {
    kind: 'wrote',
    written,
    count: finalCount,
    detail: `wrote ${written} proposal(s) (${finalCount}/${DEFAULT_DAILY_PROPOSAL_LIMIT} today)`,
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
