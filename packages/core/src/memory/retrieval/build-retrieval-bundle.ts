/**
 * BRAIN Multi-Pass Retrieval Bundle (PSYCHE Wave 4 · T1090).
 *
 * Executes up to three passes in parallel:
 * - Cold (20 % of budget): user-profile traits + peer instructions
 * - Warm (50 % of budget): peer-scoped learnings, patterns, decisions
 * - Hot  (30 % of budget): session narrative + recent observations + active tasks
 *
 * @task T1090
 * @epic T1083
 */

import type { TaskStatus } from '@cleocode/contracts';

/** Default token budget for `buildRetrievalBundle` (characters / 4 ≈ tokens). */
const DEFAULT_TOKEN_BUDGET = 4000;

/** Default pass-mask: all three passes active. */
const DEFAULT_PASS_MASK = { cold: true, warm: true, hot: true };

/** Cold pass budget share (20 %). */
const COLD_BUDGET_FRACTION = 0.2;
/** Hot pass budget share (30 %). */
const HOT_BUDGET_FRACTION = 0.3;

/**
 * Estimate tokens consumed by an arbitrary string.
 * Uses the approximate 4-chars-per-token heuristic.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ============================================================================
// Cold pass — fetchIdentity
// ============================================================================

/**
 * Cold pass — fetch user-profile traits and peer instructions from NEXUS.
 *
 * Calls `listUserProfile({ minConfidence: 0.5 })` from Wave 1 (T1078).
 * `peerInstructions` is populated from the sigil's `systemPromptFragment`
 * when a sigil exists for `peerId` (Wave 8 — T1148). Falls back to an empty
 * string when no sigil is found or when the sigil has no fragment set.
 *
 * @param peerId   - CANT peer identifier (used to look up the sigil).
 * @param nexusDb  - Drizzle nexus database handle.
 * @returns Cold-pass bundle slice: userProfile traits + peerInstructions + sigilCard.
 *
 * @task T1090
 * @task T1148
 */
export async function fetchIdentity(
  peerId: string,
  nexusDb: import('drizzle-orm/node-sqlite').NodeSQLiteDatabase<
    typeof import('../../store/schema/nexus-schema.js')
  >,
): Promise<{
  userProfile: import('@cleocode/contracts').UserProfileTrait[];
  peerInstructions: string;
  sigilCard: import('../../nexus/sigil.js').SigilCard | null;
}> {
  const { listUserProfile } = await import('../../nexus/user-profile.js');
  const { getSigil } = await import('../../nexus/sigil.js');

  const [userProfile, sigilCard] = await Promise.all([
    listUserProfile(nexusDb, { minConfidence: 0.5 }),
    // Graceful fallback: if sigil lookup fails for any reason, continue without it.
    getSigil(nexusDb, peerId).catch(() => null),
  ]);

  // Prefer sigil's system-prompt fragment; fall back to empty string.
  const peerInstructions = sigilCard?.systemPromptFragment ?? '';

  return { userProfile, peerInstructions, sigilCard };
}

// ============================================================================
// Warm pass — fetchPeerMemory
// ============================================================================

/**
 * Warm pass — fetch peer-scoped learnings, patterns, and decisions from BRAIN.
 *
 * Uses the Wave 2 peer_id filter: each query returns rows where
 * `peer_id = peerId OR peer_id = 'global'`. When `query` is supplied the
 * learnings search is narrowed to relevant entries via FTS; decisions and
 * patterns are returned by recency (most recent first, capped at 10 each).
 *
 * @param peerId   - CANT peer identifier.
 * @param brainDb  - Drizzle brain database handle.
 * @param query    - Optional search term to scope learnings retrieval.
 * @returns Warm-pass bundle slice: peerLearnings, peerPatterns, decisions.
 *
 * @task T1090
 */
export async function fetchPeerMemory(
  peerId: string,
  query?: string,
): Promise<{
  peerLearnings: import('@cleocode/contracts').RetrievalLearning[];
  peerPatterns: import('@cleocode/contracts').RetrievalPattern[];
  decisions: import('@cleocode/contracts').RetrievalDecision[];
}> {
  // Warm pass reads from the project-scoped brain.db via the native handle.
  const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
  const nativeDb = getBrainNativeDb();

  // If the native DB isn't initialised yet, return empty warm pass gracefully.
  if (!nativeDb) {
    return { peerLearnings: [], peerPatterns: [], decisions: [] };
  }

  // Peer clause: include peer-specific + global pool entries.
  // When peerId is 'global' we return all global entries (no extra peer filter).
  const peerFilter = peerId !== 'global';

  // -- Learnings (FTS-scoped when query supplied, otherwise recent-10) --
  interface RawLearning extends Record<string, unknown> {
    id: string;
    insight: string;
    created_at: string;
    provenance_class: string | null;
  }

  // Both query-on and query-off currently use the same recent-10 fallback.
  // The `query` branch is kept for future FTS-scoped narrowing (T1090 followup).
  // T1260 PSYCHE E3: SELECT provenance_class AS provenance_class for M6 refusal gate.
  const learningSqlWithPeer = `SELECT id, insight, created_at, provenance_class FROM brain_learnings
             WHERE (peer_id = ? OR peer_id = 'global')
             ORDER BY created_at DESC LIMIT 10`;
  const learningSqlGlobal = `SELECT id, insight, created_at, provenance_class FROM brain_learnings
             WHERE peer_id = 'global'
             ORDER BY created_at DESC LIMIT 10`;
  const learningSqlLegacy =
    'SELECT id, insight, created_at FROM brain_learnings ORDER BY created_at DESC LIMIT 10';

  let learningRows: RawLearning[] = [];
  // `query` intentionally unused until FTS narrowing lands (T1090 followup).
  void query;
  try {
    learningRows = peerFilter
      ? (nativeDb.prepare(learningSqlWithPeer).all(peerId) as RawLearning[])
      : (nativeDb.prepare(learningSqlGlobal).all() as RawLearning[]);
  } catch {
    // peer_id column may not exist in older schemas — graceful degradation
    try {
      learningRows = nativeDb.prepare(learningSqlLegacy).all() as RawLearning[];
    } catch {
      learningRows = [];
    }
  }

  // -- Patterns (recent-10, peer-scoped) --
  interface RawPattern extends Record<string, unknown> {
    id: string;
    pattern: string;
    extracted_at: string;
    provenance_class: string | null;
  }

  // T1260 PSYCHE E3: SELECT provenance_class for M6 refusal gate.
  const patternSqlWithPeer = `SELECT id, pattern, extracted_at, provenance_class FROM brain_patterns
           WHERE (peer_id = ? OR peer_id = 'global')
           ORDER BY extracted_at DESC LIMIT 10`;
  const patternSqlGlobal = `SELECT id, pattern, extracted_at, provenance_class FROM brain_patterns
           WHERE peer_id = 'global'
           ORDER BY extracted_at DESC LIMIT 10`;
  const patternSqlLegacy =
    'SELECT id, pattern, extracted_at FROM brain_patterns ORDER BY extracted_at DESC LIMIT 10';

  let patternRows: RawPattern[] = [];
  try {
    patternRows = peerFilter
      ? (nativeDb.prepare(patternSqlWithPeer).all(peerId) as RawPattern[])
      : (nativeDb.prepare(patternSqlGlobal).all() as RawPattern[]);
  } catch {
    try {
      patternRows = nativeDb.prepare(patternSqlLegacy).all() as RawPattern[];
    } catch {
      patternRows = [];
    }
  }

  // -- Decisions (recent-10, peer-scoped) --
  interface RawDecision extends Record<string, unknown> {
    id: string;
    decision: string;
    created_at: string;
    provenance_class: string | null;
  }

  // T1260 PSYCHE E3: SELECT provenance_class for M6 refusal gate.
  const decisionSqlWithPeer = `SELECT id, decision, created_at, provenance_class FROM brain_decisions
           WHERE (peer_id = ? OR peer_id = 'global')
           ORDER BY created_at DESC LIMIT 10`;
  const decisionSqlGlobal = `SELECT id, decision, created_at, provenance_class FROM brain_decisions
           WHERE peer_id = 'global'
           ORDER BY created_at DESC LIMIT 10`;
  const decisionSqlLegacy =
    'SELECT id, decision, created_at FROM brain_decisions ORDER BY created_at DESC LIMIT 10';

  let decisionRows: RawDecision[] = [];
  try {
    decisionRows = peerFilter
      ? (nativeDb.prepare(decisionSqlWithPeer).all(peerId) as RawDecision[])
      : (nativeDb.prepare(decisionSqlGlobal).all() as RawDecision[]);
  } catch {
    try {
      decisionRows = nativeDb.prepare(decisionSqlLegacy).all() as RawDecision[];
    } catch {
      decisionRows = [];
    }
  }

  return {
    peerLearnings: learningRows.map((r) => ({
      id: r.id,
      insight: r.insight,
      createdAt: r.created_at,
      provenanceClass: r.provenance_class ?? 'unswept-pre-T1151',
    })),
    peerPatterns: patternRows.map((r) => ({
      id: r.id,
      pattern: r.pattern,
      extractedAt: r.extracted_at,
      provenanceClass: r.provenance_class ?? 'unswept-pre-T1151',
    })),
    decisions: decisionRows.map((r) => ({
      id: r.id,
      decision: r.decision,
      createdAt: r.created_at,
      provenanceClass: r.provenance_class ?? 'unswept-pre-T1151',
    })),
  };
}

// ============================================================================
// Hot pass — fetchSessionState
// ============================================================================

/**
 * Hot pass — fetch live session state: narrative + recent observations + active tasks.
 *
 * Calls `getSessionNarrative(sessionId)` from Wave 3 (T1089).
 * Active tasks are queried from tasks.db via the DataAccessor.
 *
 * @param sessionId  - Active session identifier.
 * @param projectRoot - Project root for DB resolution (tasks.db + brain.db).
 * @returns Hot-pass bundle slice: sessionNarrative, recentObservations, activeTasks.
 *
 * @task T1090
 */
export async function fetchSessionState(
  sessionId: string,
  projectRoot: string,
): Promise<{
  sessionNarrative: string;
  recentObservations: import('@cleocode/contracts').RetrievalObservation[];
  activeTasks: import('@cleocode/contracts').RetrievalActiveTask[];
}> {
  // -- Session narrative (Wave 3) --
  const { getSessionNarrative } = await import('../session-narrative.js');
  let sessionNarrative = '';
  try {
    const { getBrainDb } = await import('../../store/memory-sqlite.js');
    await getBrainDb(projectRoot);
    const record = await getSessionNarrative(sessionId);
    sessionNarrative = record?.narrative ?? '';
  } catch {
    // brain.db not initialised or session_narrative table absent — graceful
  }

  // -- Recent observations (last 10 from this session) --
  const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
  const nativeDb = getBrainNativeDb();

  interface RawObs extends Record<string, unknown> {
    id: string;
    title: string;
    narrative: string | null;
    created_at: string;
    provenance_class: string | null;
  }

  let recentObservations: import('@cleocode/contracts').RetrievalObservation[] = [];
  if (nativeDb) {
    try {
      const obsRows = nativeDb
        .prepare(
          `SELECT id, title, narrative, created_at, provenance_class
           FROM brain_observations
           WHERE source_session_id = ?
           ORDER BY created_at DESC, id DESC LIMIT 10`,
        )
        .all(sessionId) as RawObs[];
      recentObservations = obsRows.map((r) => ({
        id: r.id,
        title: r.title,
        narrative: r.narrative ?? '',
        createdAt: r.created_at,
        provenanceClass: r.provenance_class ?? 'unswept-pre-T1151',
      }));
    } catch {
      recentObservations = [];
    }
  }

  // -- Active tasks (from tasks.db) --
  let activeTasks: import('@cleocode/contracts').RetrievalActiveTask[] = [];
  try {
    const { getTaskAccessor } = await import('../../store/data-accessor.js');
    const accessor = await getTaskAccessor(projectRoot);
    const { tasks } = await accessor.queryTasks({
      status: ['active', 'in_progress'] as TaskStatus[],
      limit: 10,
    });
    activeTasks = tasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
    }));
  } catch {
    activeTasks = [];
  }

  return { sessionNarrative, recentObservations, activeTasks };
}

// ============================================================================
// buildRetrievalBundle — main entry point
// ============================================================================

/**
 * Build a structured multi-pass retrieval bundle for agent briefing.
 *
 * Executes up to three passes in parallel (controlled by `passMask`):
 *
 * - **Cold** (20 % of budget): user-profile traits + peer instructions
 * - **Warm** (50 % of budget): peer-scoped learnings, patterns, decisions
 * - **Hot**  (30 % of budget): session narrative + recent observations + active tasks
 *
 * When the total token estimate exceeds `tokenBudget`, the hot pass is trimmed
 * first (observations then tasks) to preserve the more stable cold/warm context.
 *
 * This function is the primary entry point consumed by `computeBriefing` in
 * `packages/core/src/sessions/briefing.ts` (T1091).
 *
 * @param req         - Retrieval request with peerId, sessionId, optional query and passMask.
 * @param projectRoot - Project root directory for DB resolution.
 * @returns Fully-structured `RetrievalBundle` with token accounting.
 *
 * @example
 * ```ts
 * const bundle = await buildRetrievalBundle(
 *   { peerId: 'cleo-prime', sessionId: 'ses_abc', passMask: { cold: true, warm: true, hot: true } },
 *   '/mnt/projects/cleocode',
 * );
 * console.log(bundle.cold.userProfile.length, 'profile traits');
 * ```
 *
 * @task T1090
 * @epic T1083
 */
export async function buildRetrievalBundle(
  req: import('@cleocode/contracts').RetrievalRequest,
  projectRoot: string,
): Promise<import('@cleocode/contracts').RetrievalBundle> {
  const {
    peerId,
    sessionId,
    query,
    passMask = DEFAULT_PASS_MASK,
    tokenBudget = DEFAULT_TOKEN_BUDGET,
  } = req;
  const mask = { ...DEFAULT_PASS_MASK, ...passMask };

  const coldBudget = Math.floor(tokenBudget * COLD_BUDGET_FRACTION);
  const hotBudget = Math.floor(tokenBudget * HOT_BUDGET_FRACTION);

  // Run all enabled passes in parallel for minimum latency.
  const [coldResult, warmResult, hotResult] = await Promise.all([
    mask.cold
      ? (async () => {
          try {
            const { getNexusDb } = await import('../../store/nexus-sqlite.js');
            const nexusDb = await getNexusDb();
            return await fetchIdentity(peerId, nexusDb);
          } catch {
            return { userProfile: [], peerInstructions: '', sigilCard: null };
          }
        })()
      : Promise.resolve({ userProfile: [], peerInstructions: '', sigilCard: null }),

    mask.warm
      ? (async () => {
          try {
            // Ensure brain.db is initialised for the project; the warm pass
            // reads via getBrainNativeDb() inside fetchPeerMemory.
            const { getBrainDb } = await import('../../store/memory-sqlite.js');
            await getBrainDb(projectRoot);
            return await fetchPeerMemory(peerId, query);
          } catch {
            return { peerLearnings: [], peerPatterns: [], decisions: [] };
          }
        })()
      : Promise.resolve({ peerLearnings: [], peerPatterns: [], decisions: [] }),

    mask.hot
      ? fetchSessionState(sessionId, projectRoot)
      : Promise.resolve({ sessionNarrative: '', recentObservations: [], activeTasks: [] }),
  ]);

  // -- M6 refusal gate (T1260 PSYCHE E3) --
  //
  // Entries with provenanceClass='unswept-pre-T1151' are refused to prevent
  // Sentient v1 reading unswept legacy memory. This gate is active until the
  // T1147 W7 sweep (.132) stamps entries as 'swept-clean'.
  //
  // NOTE (Risk 5): With the default 'unswept-pre-T1151' on all legacy rows,
  // this gate will refuse ALL warm entries and hot observations for existing
  // BRAIN data until .132 ships. This is correct per Council. Callers MUST NOT
  // crash on an empty bundle — they should degrade gracefully.
  const REFUSED_CLASS = 'unswept-pre-T1151';

  const refusedWarmLearnings = warmResult.peerLearnings.filter(
    (e) => e.provenanceClass === REFUSED_CLASS,
  );
  const acceptedWarmLearnings = warmResult.peerLearnings.filter(
    (e) => e.provenanceClass !== REFUSED_CLASS,
  );
  const refusedWarmPatterns = warmResult.peerPatterns.filter(
    (e) => e.provenanceClass === REFUSED_CLASS,
  );
  const acceptedWarmPatterns = warmResult.peerPatterns.filter(
    (e) => e.provenanceClass !== REFUSED_CLASS,
  );
  const refusedWarmDecisions = warmResult.decisions.filter(
    (e) => e.provenanceClass === REFUSED_CLASS,
  );
  const acceptedWarmDecisions = warmResult.decisions.filter(
    (e) => e.provenanceClass !== REFUSED_CLASS,
  );
  const refusedHotObservations = hotResult.recentObservations.filter(
    (e) => e.provenanceClass === REFUSED_CLASS,
  );
  const acceptedHotObservations = hotResult.recentObservations.filter(
    (e) => e.provenanceClass !== REFUSED_CLASS,
  );

  const refusedCount =
    refusedWarmLearnings.length +
    refusedWarmPatterns.length +
    refusedWarmDecisions.length +
    refusedHotObservations.length;

  if (refusedCount > 0) {
    // Emit a warning so callers can detect the empty-bundle-until-sweep state.
    // Do NOT crash — callers must degrade gracefully on empty bundle.
    console.warn(
      `[buildRetrievalBundle] M6 refusal gate: refused ${refusedCount} entries ` +
        `with provenanceClass='unswept-pre-T1151'. ` +
        `Run T1147 W7 sweep (.132) to promote entries to 'swept-clean'. ` +
        `Bundle may be empty until sweep completes.`,
    );
  }

  // Replace warm+hot results with filtered (accepted-only) versions.
  const filteredWarmResult = {
    peerLearnings: acceptedWarmLearnings,
    peerPatterns: acceptedWarmPatterns,
    decisions: acceptedWarmDecisions,
  };
  const filteredHotObservations = acceptedHotObservations;

  // -- Token accounting --
  let coldTokens = 0;
  for (const trait of coldResult.userProfile) {
    coldTokens += estimateTokens(`${trait.traitKey}:${trait.traitValue}`);
  }
  coldTokens += estimateTokens(coldResult.peerInstructions);

  let warmTokens = 0;
  for (const l of filteredWarmResult.peerLearnings) warmTokens += estimateTokens(l.insight);
  for (const p of filteredWarmResult.peerPatterns) warmTokens += estimateTokens(p.pattern);
  for (const d of filteredWarmResult.decisions) warmTokens += estimateTokens(d.decision);

  let hotTokens = estimateTokens(hotResult.sessionNarrative);
  for (const o of filteredHotObservations) hotTokens += estimateTokens(o.narrative || o.title);
  for (const t of hotResult.activeTasks) hotTokens += estimateTokens(`${t.id} ${t.title}`);

  // -- Budget enforcement: trim hot first when over-budget --
  let trimmedObservations = filteredHotObservations;
  let trimmedTasks = hotResult.activeTasks;

  const totalRaw = coldTokens + warmTokens + hotTokens;
  if (totalRaw > tokenBudget) {
    const hotAllowed = tokenBudget - coldTokens - warmTokens;
    // Ensure we don't go negative
    const effectiveHotBudget = Math.max(0, Math.min(hotBudget, hotAllowed));

    // Trim observations first (most volatile content)
    let usedHot = estimateTokens(hotResult.sessionNarrative);
    trimmedObservations = [];
    for (const obs of filteredHotObservations) {
      const cost = estimateTokens(obs.narrative || obs.title);
      if (usedHot + cost <= effectiveHotBudget) {
        trimmedObservations.push(obs);
        usedHot += cost;
      }
    }

    // Then trim tasks
    trimmedTasks = [];
    for (const task of hotResult.activeTasks) {
      const cost = estimateTokens(`${task.id} ${task.title}`);
      if (usedHot + cost <= effectiveHotBudget) {
        trimmedTasks.push(task);
        usedHot += cost;
      }
    }

    hotTokens = usedHot;
  }

  // -- Trim cold/warm if still over budget (best-effort, cold is capped first) --
  let trimmedProfile = coldResult.userProfile;
  if (coldTokens > coldBudget) {
    let usedCold = estimateTokens(coldResult.peerInstructions);
    trimmedProfile = [];
    for (const trait of coldResult.userProfile) {
      const cost = estimateTokens(`${trait.traitKey}:${trait.traitValue}`);
      if (usedCold + cost <= coldBudget) {
        trimmedProfile.push(trait);
        usedCold += cost;
      }
    }
    coldTokens = usedCold;
  }

  const total = coldTokens + warmTokens + hotTokens;

  return {
    cold: {
      userProfile: trimmedProfile,
      peerInstructions: coldResult.peerInstructions,
      sigilCard: coldResult.sigilCard ?? null,
    },
    warm: {
      peerLearnings: filteredWarmResult.peerLearnings,
      peerPatterns: filteredWarmResult.peerPatterns,
      decisions: filteredWarmResult.decisions,
    },
    hot: {
      sessionNarrative: hotResult.sessionNarrative,
      recentObservations: trimmedObservations,
      activeTasks: trimmedTasks,
    },
    tokenCounts: {
      cold: coldTokens,
      warm: warmTokens,
      hot: hotTokens,
      total,
    },
  };
}
