/**
 * The main brain: observations and decisions in the GLOBAL `cleo.db`, which
 * the account's `home:<user>` stream syncs across devices (T13370).
 *
 * Writes go through the global accessors in `store/memory-accessor.ts`, each
 * in one capture frame, so capture records them and the sealer seals them
 * onto the home stream. Reads tag every entry `scope: 'global'` so project
 * memory commands can list them alongside project entries.
 *
 * The project-scope pipeline (writer thread, extraction gate, graph nodes,
 * embeddings) stays project-only: it is bound to a project store.
 *
 * @task T13720
 * @module memory/global-brain
 */

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { BrainCompactHit, FetchedBrainEntry } from '@cleocode/contracts';
import { addGlobalDecision, addGlobalObservation } from '../store/memory-accessor.js';
import type { BrainSourceConfidence } from '../store/schema/memory-schema.js';
import { classifyObservationTypeByKeywords } from './observation-type-decision.js';
import { computeObservationQuality } from './quality-scoring.js';

/** Monotonic counter: two observations in one millisecond get distinct ids. */
let observeSeq = 0;

/** SQLite `datetime('now')` shape, the format the project brain writers use. */
const nowSql = (): string => new Date().toISOString().replace('T', ' ').slice(0, 19);

async function globalNativeDb(): Promise<DatabaseSync> {
  const { getDualScopeNativeDb, openDualScopeDb } = await import('../store/dual-scope-db.js');
  return getDualScopeNativeDb(await openDualScopeDb('global'));
}

/**
 * Save an observation to the main brain (global store).
 *
 * @param params - Observation text plus optional title, type, agent and source type.
 * @returns The new observation's id, type and creation time, tagged `scope: 'global'`.
 * @example
 * ```ts
 * const { id } = await observeGlobalBrain({ text: 'pnpm 11 reads only pnpm_config_*' });
 * ```
 */
export async function observeGlobalBrain(params: {
  text: string;
  title?: string;
  type?: string;
  agent?: string;
  sourceType?: string;
}): Promise<{ id: string; type: string; createdAt: string; scope: 'global' }> {
  const text = params.text.trim();
  // @sync-invariant none:input-shape empty observation text is rejected before any write
  if (!text) throw new Error('Observation text is required');
  const type = params.type ?? classifyObservationTypeByKeywords(text);
  const title = params.title ?? text.slice(0, 120);
  const sourceType = params.sourceType ?? 'manual';
  const sourceConfidence: BrainSourceConfidence = sourceType === 'manual' ? 'owner' : 'agent';
  const createdAt = nowSql();
  const id = `O-${Date.now().toString(36)}-${(observeSeq++ % 1000).toString(36)}`;
  await addGlobalObservation({
    id,
    type,
    title,
    narrative: text,
    contentHash: createHash('sha256').update(text.toLowerCase()).digest('hex').slice(0, 16),
    sourceType,
    agent: params.agent ?? null,
    sourceConfidence,
    verified: sourceConfidence === 'owner',
    qualityScore: computeObservationQuality({
      text,
      title,
      sourceConfidence,
      memoryTier: 'short',
    }),
    createdAt,
  });
  return { id, type, createdAt, scope: 'global' };
}

/**
 * Store a decision in the main brain (global store) with the next `Dnnn` id.
 * A colliding id from another device is re-minted by sync's collision settle.
 *
 * @param params - Decision, rationale and optional lifecycle fields.
 * @returns The new decision's id and creation time, tagged `scope: 'global'`.
 * @example
 * ```ts
 * const { id } = await storeGlobalDecision({ decision: 'Use pnpm', rationale: 'workspaces' });
 * ```
 */
export async function storeGlobalDecision(params: {
  decision: string;
  rationale: string;
  alternatives?: string[];
  adrPath?: string | null;
  confirmationState?: 'proposed' | 'accepted' | 'superseded';
  decidedBy?: 'owner' | 'council' | 'agent';
}): Promise<{ id: string; type: string; decision: string; createdAt: string; scope: 'global' }> {
  const createdAt = nowSql();
  const id = await addGlobalDecision({
    type: 'technical',
    decision: params.decision.trim(),
    rationale: params.rationale.trim(),
    confidence: 'medium',
    outcome: 'pending',
    alternativesJson: params.alternatives?.length ? JSON.stringify(params.alternatives) : null,
    adrPath: params.adrPath ?? null,
    confirmationState: params.confirmationState ?? 'proposed',
    decidedBy: params.decidedBy ?? 'agent',
    createdAt,
  });
  return { id, type: 'technical', decision: params.decision.trim(), createdAt, scope: 'global' };
}

/**
 * Search the main brain's current observations and decisions by substring.
 *
 * shortcut: LIKE match, no FTS or ranking; add the global store to the hybrid
 * search when the main brain grows past a few thousand rows.
 *
 * @param query - Text to match against titles and bodies.
 * @param opts - Result limit, table filter and whether to include retired entries.
 * @returns Compact hits, newest first, each tagged `scope: 'global'`.
 */
export async function findGlobalBrain(
  query: string,
  opts: { limit?: number; tables?: readonly string[]; includeHistory?: boolean } = {},
): Promise<BrainCompactHit[]> {
  const db = await globalNativeDb();
  const like = `%${query}%`;
  const want = (t: string) => !opts.tables || opts.tables.includes(t);
  const current = (extra: string) => (opts.includeHistory ? '' : ` AND invalid_at IS NULL${extra}`);
  const hits: BrainCompactHit[] = [];
  if (want('observations')) {
    const rows = db
      .prepare(
        `SELECT id, title, created_at FROM main.brain_observations
         WHERE (title LIKE ? OR narrative LIKE ?)${current('')}`,
      )
      .all(like, like) as Array<{ id: string; title: string; created_at: string }>;
    for (const r of rows) hits.push(hit(r.id, 'observation', r.title, r.created_at));
  }
  if (want('decisions')) {
    const rows = db
      .prepare(
        `SELECT id, decision, created_at FROM main.brain_decisions
         WHERE (decision LIKE ? OR rationale LIKE ?)${current(
           " AND superseded_by IS NULL AND confirmation_state != 'superseded'",
         )}`,
      )
      .all(like, like) as Array<{ id: string; decision: string; created_at: string }>;
    for (const r of rows) hits.push(hit(r.id, 'decision', r.decision, r.created_at));
  }
  return hits.sort((a, b) => b.date.localeCompare(a.date)).slice(0, opts.limit ?? 10);
}

/**
 * The main brain's accepted, current decisions, newest first (briefing guidance).
 *
 * @param limit - Maximum decisions returned.
 * @returns Compact hits tagged `scope: 'global'`.
 */
export async function listAcceptedGlobalDecisions(limit: number): Promise<BrainCompactHit[]> {
  const db = await globalNativeDb();
  const rows = db
    .prepare(
      `SELECT id, decision, created_at FROM main.brain_decisions
       WHERE confirmation_state = 'accepted' AND invalid_at IS NULL AND superseded_by IS NULL
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit) as Array<{ id: string; decision: string; created_at: string }>;
  return rows.map((r) => hit(r.id, 'decision', r.decision, r.created_at));
}

/**
 * Fetch full main-brain rows by id (observations and decisions).
 *
 * @param ids - Entry ids; ids that are neither `O-…` nor `D…` are skipped.
 * @returns The rows found, tagged `scope: 'global'`.
 */
export async function fetchGlobalBrain(ids: readonly string[]): Promise<FetchedBrainEntry[]> {
  const db = await globalNativeDb();
  const out: FetchedBrainEntry[] = [];
  for (const id of ids) {
    const [type, table] = id.startsWith('O-')
      ? (['observation', 'brain_observations'] as const)
      : /^D/.test(id)
        ? (['decision', 'brain_decisions'] as const)
        : [null, null];
    if (!table) continue;
    const row = db.prepare(`SELECT * FROM main.${table} WHERE id = ?`).get(id);
    if (row) out.push({ id, type, data: row, scope: 'global' });
  }
  return out;
}

function hit(
  id: string,
  type: BrainCompactHit['type'],
  title: string,
  date: string,
): BrainCompactHit {
  return { id, type, title, date, scope: 'global', _next: { fetch: `cleo memory fetch ${id}` } };
}
