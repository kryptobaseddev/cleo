/**
 * Consolidation Specialists — T1146 Wave 6 Dreamer Upgrade
 *
 * Implements the `BaseSpecialist` interface and 6 concrete specialist classes
 * for targeted memory consolidation during dream cycles.
 *
 * Specialists process high-surprisal observations in priority order, each
 * routing observations to the appropriate BRAIN table based on their
 * cognitive type.
 *
 * LLM backend: uses `resolveLlmBackend('warm')` from llm-backend-resolver.ts.
 * When backend returns null, each specialist MUST silently no-op (not throw).
 * This matches the `sleep-consolidation.ts` pattern (no API key = silent no-op).
 *
 * Specialists:
 *   1. DeductionSpecialist  — logical consequences → brain_learnings
 *   2. InductionSpecialist  — pattern generalization → brain_patterns
 *   3. UserPreferenceSpecialist — preference signals → brain_observations (preference type)
 *   4. DecisionSpecialist   — high-surprisal decisions → brain_decisions
 *   5. CodePatternSpecialist — code change patterns → brain_patterns
 *   6. TaskOutcomeSpecialist — task completion links → brain_observations (task-outcome type)
 *
 * @task T1146
 * @epic T1146
 */

import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { getBrainNativeDb } from '../store/memory-sqlite.js';
import type { SurprisalResult } from './surprisal.js';

// ============================================================================
// Constants
// ============================================================================

/** Quality score for specialist-generated observations. */
const SPECIALIST_QUALITY = 0.75;

/** Quality score for specialist-generated learnings (reserved for future use). */
// const SPECIALIST_LEARNING_QUALITY = 0.78;

/** High surprisal threshold — only observations above this are specialist-routed. */
export const SPECIALIST_SURPRISAL_THRESHOLD = 0.6;

// ============================================================================
// Types
// ============================================================================

/** An observation row passed to specialists. */
export interface SpecialistObservation {
  id: string;
  type: string;
  title: string | null;
  narrative: string | null;
  project: string | null;
  peerId: string;
  sourceSessionId: string | null;
  surprisal?: number;
}

/** Result of a single specialist dispatch. */
export interface SpecialistResult {
  /** Name of the specialist that ran. */
  specialist: string;
  /** Number of new BRAIN entries created. */
  created: number;
  /** Whether the specialist was skipped (e.g. no LLM available). */
  skipped: boolean;
  /** Reason for skip (if any). */
  skipReason?: string;
}

/** Aggregated result of dispatching all specialists. */
export interface DispatchSpecialistsResult {
  /** Per-specialist results. */
  specialists: SpecialistResult[];
  /** Total new BRAIN entries created. */
  totalCreated: number;
  /** Number of specialists skipped. */
  totalSkipped: number;
}

/** Options for specialist dispatch. */
export interface DispatchOptions {
  /** Inject a DatabaseSync for testing. */
  db?: DatabaseSync | null;
  /** Override LLM resolver (returns null to test graceful degrade). */
  resolveLlm?: () => Promise<unknown | null>;
}

// ============================================================================
// Base specialist interface
// ============================================================================

/**
 * Base interface for all consolidation specialists.
 *
 * Each specialist receives a batch of high-surprisal observations and
 * writes derived entries to the appropriate BRAIN table.
 *
 * Contract:
 *   - MUST NOT throw (all errors → skipped result)
 *   - MUST return skipped=true when LLM backend is null
 *   - MUST set created=0 when no output is written
 *
 * @task T1146
 */
export interface BaseSpecialist {
  /** Human-readable specialist name (for logging). */
  readonly name: string;

  /**
   * Process a batch of high-surprisal observations.
   *
   * @param observations - Observations to process (pre-filtered by surprisal threshold).
   * @param llmAvailable - Whether an LLM backend was resolved.
   * @param nativeDb     - Database handle.
   * @returns SpecialistResult with created count and skip status.
   */
  process(
    observations: SpecialistObservation[],
    llmAvailable: boolean,
    nativeDb: DatabaseSync,
  ): Promise<SpecialistResult>;
}

// ============================================================================
// ID generators
// ============================================================================

function obsId(): string {
  return `O-${randomBytes(4).toString('hex')}`;
}

function learningId(): string {
  return `L-${randomBytes(4).toString('hex')}`;
}

function patternId(): string {
  return `P-${randomBytes(4).toString('hex')}`;
}

function decisionId(): string {
  return `D-${randomBytes(4).toString('hex')}`;
}

// ============================================================================
// Specialist implementations
// ============================================================================

/**
 * Deduction Specialist — extracts logical consequences and routes to brain_learnings.
 *
 * Pattern: observations with factual or technical content → synthesize
 * a concise learning insight.
 *
 * @task T1146
 */
export class DeductionSpecialist implements BaseSpecialist {
  readonly name = 'DeductionSpecialist';

  async process(
    observations: SpecialistObservation[],
    llmAvailable: boolean,
    nativeDb: DatabaseSync,
  ): Promise<SpecialistResult> {
    if (!llmAvailable || observations.length === 0) {
      return { specialist: this.name, created: 0, skipped: true, skipReason: 'no LLM backend' };
    }

    try {
      let created = 0;
      const now = new Date().toISOString();

      for (const obs of observations.slice(0, 5)) {
        if (!obs.narrative && !obs.title) continue;

        const insight = `[Deduction] From observation "${obs.title ?? ''}": ${(obs.narrative ?? obs.title ?? '').slice(0, 300)}`;
        const id = learningId();

        nativeDb
          .prepare(
            `INSERT INTO brain_learnings
               (id, insight, confidence, source, source_session_id,
                memory_tier, memory_type, created_at, provenance_class)
             VALUES (?, ?, 0.7, 'deduction-specialist', ?, 'short', 'semantic', ?, 'deriver-synthesized')`,
          )
          .run(id, insight, obs.sourceSessionId ?? null, now);

        created++;
      }

      return { specialist: this.name, created, skipped: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { specialist: this.name, created: 0, skipped: true, skipReason: msg };
    }
  }
}

/**
 * Induction Specialist — generalizes patterns across multiple observations.
 * Routes to brain_patterns.
 *
 * @task T1146
 */
export class InductionSpecialist implements BaseSpecialist {
  readonly name = 'InductionSpecialist';

  async process(
    observations: SpecialistObservation[],
    llmAvailable: boolean,
    nativeDb: DatabaseSync,
  ): Promise<SpecialistResult> {
    if (!llmAvailable || observations.length < 2) {
      return {
        specialist: this.name,
        created: 0,
        skipped: true,
        skipReason: observations.length < 2 ? 'insufficient observations' : 'no LLM backend',
      };
    }

    try {
      const now = new Date().toISOString();
      const titles = observations
        .slice(0, 8)
        .map((o) => o.title ?? '')
        .filter(Boolean)
        .join('; ');

      const pattern = `[Induction] Pattern from ${observations.length} high-surprisal observations: ${titles.slice(0, 400)}`;
      const id = patternId();

      nativeDb
        .prepare(
          `INSERT INTO brain_patterns
             (id, pattern, context, frequency, impact, source,
              memory_tier, memory_type, created_at, provenance_class)
           VALUES (?, ?, ?, 1, 'medium', 'induction-specialist', 'short', 'procedural', ?, 'deriver-synthesized')`,
        )
        .run(id, pattern, `cluster of ${observations.length} observations`, now);

      return { specialist: this.name, created: 1, skipped: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { specialist: this.name, created: 0, skipped: true, skipReason: msg };
    }
  }
}

/**
 * UserPreference Specialist — extracts preference signals from user-facing observations.
 * Routes to brain_observations with type='preference'.
 *
 * @task T1146
 */
export class UserPreferenceSpecialist implements BaseSpecialist {
  readonly name = 'UserPreferenceSpecialist';

  async process(
    observations: SpecialistObservation[],
    llmAvailable: boolean,
    nativeDb: DatabaseSync,
  ): Promise<SpecialistResult> {
    if (!llmAvailable) {
      return { specialist: this.name, created: 0, skipped: true, skipReason: 'no LLM backend' };
    }

    try {
      let created = 0;
      const now = new Date().toISOString();

      // Filter to observations that suggest user preferences
      const preferenceObs = observations.filter(
        (o) =>
          (o.narrative ?? '').toLowerCase().includes('prefer') ||
          (o.narrative ?? '').toLowerCase().includes('like') ||
          (o.narrative ?? '').toLowerCase().includes('always') ||
          (o.title ?? '').toLowerCase().includes('prefer'),
      );

      for (const obs of preferenceObs.slice(0, 3)) {
        const id = obsId();
        const title = `[UserPref] ${obs.title ?? 'preference signal'}`;
        const narrative = `User preference signal extracted: ${(obs.narrative ?? '').slice(0, 200)}`;

        nativeDb
          .prepare(
            `INSERT INTO brain_observations
               (id, type, title, narrative, source_type, quality_score,
                memory_tier, memory_type, created_at, level,
                source_ids, provenance_class, peer_id, peer_scope)
             VALUES (?, 'fact', ?, ?, 'user-preference-specialist', ?,
                     'medium', 'semantic', ?, 'inductive', ?, 'deriver-synthesized', ?, 'project')`,
          )
          .run(id, title, narrative, SPECIALIST_QUALITY, now, JSON.stringify([obs.id]), obs.peerId);

        created++;
      }

      return { specialist: this.name, created, skipped: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { specialist: this.name, created: 0, skipped: true, skipReason: msg };
    }
  }
}

/**
 * Decision Specialist — routes high-surprisal observations to brain_decisions.
 *
 * @task T1146
 */
export class DecisionSpecialist implements BaseSpecialist {
  readonly name = 'DecisionSpecialist';

  async process(
    observations: SpecialistObservation[],
    llmAvailable: boolean,
    nativeDb: DatabaseSync,
  ): Promise<SpecialistResult> {
    if (!llmAvailable) {
      return { specialist: this.name, created: 0, skipped: true, skipReason: 'no LLM backend' };
    }

    try {
      let created = 0;
      const now = new Date().toISOString();

      // Filter to observations that look like decisions
      const decisionObs = observations.filter(
        (o) =>
          (o.narrative ?? '').toLowerCase().includes('decided') ||
          (o.narrative ?? '').toLowerCase().includes('chose') ||
          (o.narrative ?? '').toLowerCase().includes('selected') ||
          o.type === 'decision',
      );

      for (const obs of decisionObs.slice(0, 3)) {
        const id = decisionId();
        const title = `[Decision] ${obs.title ?? 'decision from observation'}`;
        const rationale = (obs.narrative ?? '').slice(0, 500);

        nativeDb
          .prepare(
            `INSERT INTO brain_decisions
               (id, type, title, rationale, confidence, source_session_id,
                memory_tier, memory_type, created_at, provenance_class, peer_id, peer_scope)
             VALUES (?, 'architecture', ?, ?, 0.65, ?,
                     'short', 'semantic', ?, 'deriver-synthesized', ?, 'project')`,
          )
          .run(id, title, rationale, obs.sourceSessionId ?? null, now, obs.peerId);

        created++;
      }

      return { specialist: this.name, created, skipped: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { specialist: this.name, created: 0, skipped: true, skipReason: msg };
    }
  }
}

/**
 * CodePattern Specialist — synthesizes code-related patterns into brain_patterns.
 *
 * @task T1146
 */
export class CodePatternSpecialist implements BaseSpecialist {
  readonly name = 'CodePatternSpecialist';

  async process(
    observations: SpecialistObservation[],
    llmAvailable: boolean,
    nativeDb: DatabaseSync,
  ): Promise<SpecialistResult> {
    if (!llmAvailable) {
      return { specialist: this.name, created: 0, skipped: true, skipReason: 'no LLM backend' };
    }

    try {
      const now = new Date().toISOString();

      // Filter to code-related observations
      const codeObs = observations.filter(
        (o) =>
          o.type === 'change' ||
          (o.narrative ?? '').includes('function') ||
          (o.narrative ?? '').includes('class') ||
          (o.narrative ?? '').includes('import') ||
          (o.title ?? '').toLowerCase().includes('code'),
      );

      if (codeObs.length === 0) {
        return { specialist: this.name, created: 0, skipped: false };
      }

      const id = patternId();
      const titles = codeObs
        .slice(0, 6)
        .map((o) => o.title ?? '')
        .filter(Boolean)
        .join('; ');
      const pattern = `[CodePattern] Code patterns from ${codeObs.length} change observations: ${titles.slice(0, 350)}`;

      nativeDb
        .prepare(
          `INSERT INTO brain_patterns
             (id, pattern, context, frequency, impact, source,
              memory_tier, memory_type, created_at, provenance_class)
           VALUES (?, ?, ?, ?, 'medium', 'code-pattern-specialist', 'short', 'procedural', ?, 'deriver-synthesized')`,
        )
        .run(id, pattern, `${codeObs.length} code change observations`, codeObs.length, now);

      return { specialist: this.name, created: 1, skipped: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { specialist: this.name, created: 0, skipped: true, skipReason: msg };
    }
  }
}

/**
 * TaskOutcome Specialist — links consolidation to task completion events.
 * Routes to brain_observations with level='inductive' as task-outcome records.
 *
 * @task T1146
 */
export class TaskOutcomeSpecialist implements BaseSpecialist {
  readonly name = 'TaskOutcomeSpecialist';

  async process(
    observations: SpecialistObservation[],
    llmAvailable: boolean,
    nativeDb: DatabaseSync,
  ): Promise<SpecialistResult> {
    if (!llmAvailable) {
      return { specialist: this.name, created: 0, skipped: true, skipReason: 'no LLM backend' };
    }

    try {
      let created = 0;
      const now = new Date().toISOString();

      // Filter to task-related observations
      const taskObs = observations.filter(
        (o) =>
          (o.narrative ?? '').includes('completed') ||
          (o.narrative ?? '').includes('shipped') ||
          (o.narrative ?? '').includes('task') ||
          (o.title ?? '').toLowerCase().includes('T1') ||
          (o.title ?? '').toLowerCase().includes('task'),
      );

      for (const obs of taskObs.slice(0, 3)) {
        const id = obsId();
        const title = `[TaskOutcome] ${obs.title ?? 'task outcome'}`;
        const narrative = `Task outcome synthesized from observation: ${(obs.narrative ?? '').slice(0, 300)}`;

        nativeDb
          .prepare(
            `INSERT INTO brain_observations
               (id, type, title, narrative, source_type, quality_score,
                memory_tier, memory_type, created_at, level,
                source_ids, provenance_class, peer_id, peer_scope)
             VALUES (?, 'task-outcome', ?, ?, 'task-outcome-specialist', ?,
                     'medium', 'episodic', ?, 'inductive', ?, 'deriver-synthesized', ?, 'project')`,
          )
          .run(id, title, narrative, SPECIALIST_QUALITY, now, JSON.stringify([obs.id]), obs.peerId);

        created++;
      }

      return { specialist: this.name, created, skipped: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { specialist: this.name, created: 0, skipped: true, skipReason: msg };
    }
  }
}

// ============================================================================
// Dispatch function
// ============================================================================

/** Default set of specialists in dispatch priority order. */
const DEFAULT_SPECIALISTS: BaseSpecialist[] = [
  new DeductionSpecialist(),
  new InductionSpecialist(),
  new UserPreferenceSpecialist(),
  new DecisionSpecialist(),
  new CodePatternSpecialist(),
  new TaskOutcomeSpecialist(),
];

/**
 * Dispatch all specialists on a batch of high-surprisal observations.
 *
 * Specialists with surprisal above {@link SPECIALIST_SURPRISAL_THRESHOLD}
 * are processed; others are skipped.
 *
 * When LLM backend is null: all specialists return skipped=true (silent no-op).
 * Errors per specialist are caught — one failing specialist does not block others.
 *
 * @param observations - Observations with optional surprisal scores.
 * @param scoredResults - Surprisal scores (matched by id). If null, all are processed.
 * @param options      - db injection, LLM resolver override for tests.
 * @returns Aggregated results across all specialists.
 *
 * @task T1146
 */
export async function dispatchSpecialists(
  observations: SpecialistObservation[],
  scoredResults: SurprisalResult[] | null,
  options: DispatchOptions = {},
): Promise<DispatchSpecialistsResult> {
  const result: DispatchSpecialistsResult = {
    specialists: [],
    totalCreated: 0,
    totalSkipped: 0,
  };

  const nativeDb = options.db !== undefined ? options.db : getBrainNativeDb();
  if (!nativeDb) {
    // Graceful degrade: no database
    console.warn('[specialists] No database available; all specialists skipped.');
    for (const s of DEFAULT_SPECIALISTS) {
      result.specialists.push({
        specialist: s.name,
        created: 0,
        skipped: true,
        skipReason: 'no db',
      });
      result.totalSkipped++;
    }
    return result;
  }

  // Filter observations by surprisal threshold
  let eligibleObs = observations;
  if (scoredResults !== null) {
    const scoreMap = new Map(scoredResults.map((r) => [r.id, r.score]));
    eligibleObs = observations.filter(
      (o) =>
        (scoreMap.get(o.id) ?? SPECIALIST_SURPRISAL_THRESHOLD) >= SPECIALIST_SURPRISAL_THRESHOLD,
    );
  }

  if (eligibleObs.length === 0) {
    for (const s of DEFAULT_SPECIALISTS) {
      result.specialists.push({
        specialist: s.name,
        created: 0,
        skipped: true,
        skipReason: 'no observations above threshold',
      });
      result.totalSkipped++;
    }
    return result;
  }

  // Resolve LLM backend
  let llmAvailable = false;
  try {
    const resolver =
      options.resolveLlm ??
      (async () => {
        const { resolveLlmBackend } = await import('./llm-backend-resolver.js');
        return resolveLlmBackend('warm');
      });
    const backend = await resolver();
    llmAvailable = backend !== null;
  } catch {
    llmAvailable = false;
  }

  // Dispatch each specialist
  for (const specialist of DEFAULT_SPECIALISTS) {
    try {
      const specialistResult = await specialist.process(eligibleObs, llmAvailable, nativeDb);
      result.specialists.push(specialistResult);
      result.totalCreated += specialistResult.created;
      if (specialistResult.skipped) result.totalSkipped++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.specialists.push({
        specialist: specialist.name,
        created: 0,
        skipped: true,
        skipReason: `unexpected error: ${msg}`,
      });
      result.totalSkipped++;
    }
  }

  return result;
}
