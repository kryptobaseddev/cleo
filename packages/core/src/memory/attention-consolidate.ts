/**
 * Tier-2 attention consolidation — the dream-cycle's review of the working-memory
 * buffer (E3 · Epic T11289 · Saga T11283).
 *
 * The biological loop closed by this module:
 *
 *   `jot` → Tier-2 `brain_attention` (scope-keyed, decays)
 *        → **dream-cycle consolidates** (this module)
 *        → promote salient → Tier-3 / BRAIN (durable observation)
 *        | discard noise / expired
 *        | keep mid-salience open for the next cycle.
 *
 * ## One scorer, one verdict (reconciles the split AC)
 *
 * Every reviewed attention entry receives EXACTLY ONE verdict per dream cycle —
 * `promote` | `keep` | `discard` — from the SAME composite 6-signal scorer used
 * for observation promotion ({@link computePromotionScore} in
 * `promotion-score.ts`). There is NO parallel attention scorer: the epic's
 * AC2/AC3/AC4 were a single criterion mis-split into three fragments, and
 * {@link decideAttentionVerdict} reconciles them into one coherent decision
 * (child T11385).
 *
 * ## Promotion is via the conduit, never a parallel path
 *
 * A `promote` verdict routes through the sticky-convert conduit shape
 * ({@link promoteAttentionToMemory} in `sticky/convert.ts` → `observeBrain`),
 * carrying the entry's `scope_kind`/`scope_id`/`agent_id` as provenance so a
 * promoted entry from agent A can never surface under agent B's scope. The
 * source row is then marked `status='consolidated'` (idempotent — re-running the
 * dream cycle never double-promotes).
 *
 * ## Decay is via the homeostatic sweep, never reinvented
 *
 * `discard`/expiry reuses the accessor's in-SQL TTL + decay-floor sweep
 * ({@link BrainDataAccessor.expireAttention}, the same `expireAttention` policy
 * the CLI + focus path share) so Tier-2 never grows unbounded. Thresholds are
 * honoured in SQL — never load-all-then-JS-filter.
 *
 * @task T11382 — ingest brain_attention into the dream cycle
 * @task T11383 — promote salient entries via the conduit
 * @task T11384 — decay/discard low-salience entries via the homeostatic sweep
 * @task T11385 — single per-entry promote|keep|discard verdict from the scorer
 * @epic T11289 EP-DREAM-CONSOLIDATE-TIER2
 * @saga T11283 SG-COGNITIVE-SUBSTRATE
 */

import { getLogger } from '../logger.js';
import { promoteAttentionToMemory } from '../sticky/convert.js';
import { getBrainAccessor } from '../store/memory-accessor.js';
import type { BrainAttentionRow } from '../store/memory-schema.js';
import {
  computePromotionRationale,
  computePromotionScore,
  type PromotionSignals,
} from './promotion-score.js';

/** Logger for the Tier-2 consolidation pass — routed through pino (never raw console.*). */
const log = getLogger('attention-consolidate');

/**
 * Score at or above which an attention entry is PROMOTED to durable memory.
 *
 * The promotion SCORER is shared verbatim with observation promotion
 * ({@link computePromotionScore} — one scorer, no parallel implementation). The
 * promotion BAR, however, is calibrated to the attention signal space rather
 * than reusing the observation bar ({@link PROMOTION_THRESHOLD} = 0.6).
 *
 * Three of the six signals are structurally unavailable to a raw working-memory
 * jot: `citation_count` (a jot is not retrieved through the citation log),
 * `user_verified` (jots are not owner-verified), and `outcome_correlated` (no
 * task-outcome link). Those carry combined weight 0.5, so the maximum attainable
 * composite for ANY jot is the remaining `quality + stability + recency` ≈ 0.5 —
 * a jot can never reach the 0.6 observation bar. Calibrating to 0.35 cleanly
 * separates a salient, detailed/tagged jot (~0.40) from a mid-salience note
 * (~0.29) and noise (~0.23) within that 0..0.5 attention band. (See the verdict
 * distribution test for the empirical separation.)
 */
export const ATTENTION_PROMOTE_THRESHOLD = 0.35;

/**
 * Decay floor below which an OPEN, unpromoted attention entry is DISCARDED.
 *
 * Matches {@link DEFAULT_DECAY_THRESHOLD} (0.1) used by the live-items query and
 * the CLI sweep, so an item hidden from reads is also the item swept here.
 */
export const ATTENTION_DISCARD_THRESHOLD = 0.1;

/** The single per-entry verdict produced by one dream cycle (reconciled AC). */
export type AttentionVerdict = 'promote' | 'keep' | 'discard';

/**
 * The audited outcome of reviewing one attention entry in a dream cycle.
 *
 * @task T11385
 */
export interface AttentionReview {
  /** The attention item id (`att_<ts>_<hex>`). */
  id: string;
  /** The single verdict this entry received this cycle. */
  verdict: AttentionVerdict;
  /** Composite 6-signal score that drove the verdict, in `[0, 1]`. */
  score: number;
  /** Scope the entry is keyed to — carried into promotion provenance. */
  scopeKind: BrainAttentionRow['scopeKind'];
  /** Scope id the entry is keyed to. */
  scopeId: string;
  /**
   * For a `promote` verdict, the id of the durable `brain_observations` row the
   * entry was promoted into via the conduit. `null` for `keep`/`discard`.
   */
  promotedToId: string | null;
}

/**
 * Aggregated result of one Tier-2 consolidation pass over the attention buffer.
 *
 * Surfaced inside {@link RunConsolidationResult.attentionConsolidation} so the
 * `brain_consolidation_events` row records the Tier-2 outcome alongside every
 * other consolidation step.
 *
 * @task T11382
 */
export interface AttentionConsolidationResult {
  /** Total live attention entries reviewed this cycle. */
  reviewed: number;
  /** Entries promoted to durable memory via the conduit (verdict `promote`). */
  promoted: number;
  /** Entries left `open` for the next cycle (verdict `keep`). */
  kept: number;
  /** Entries swept to `discarded` (verdict `discard` + the TTL/decay sweep). */
  discarded: number;
  /** Per-entry audited verdicts (for the test assertion + observability). */
  reviews: AttentionReview[];
}

/**
 * Derive the composite-scorer {@link PromotionSignals} for an attention entry.
 *
 * Attention rows are lightweight working-memory jots — they do not carry the
 * citation/quality/stability columns a `brain_observations` row accrues. We map
 * the available signal onto the EXISTING 6-signal vector rather than inventing a
 * parallel scorer:
 *
 * - `citationCount`   — always 0 (a jot is not retrieved through the citation log).
 * - `qualityScore`    — a content-richness proxy: longer + tagged jots read as
 *   higher quality, normalised to `[0, 1]` (null would default to 0.5, which is
 *   too generous for a one-word jot, so we compute an explicit proxy).
 * - `stabilityScore`  — the entry's own `decay_score` when present (an entry that
 *   has survived decay is more stable); null → scorer default (0.5).
 * - `createdAt`       — drives the recency factor (fresh jots score higher).
 * - `userVerified`    — 0 (jots are not owner-verified).
 * - `outcomeCorrelated` — 0 (no task-outcome correlation for raw jots).
 *
 * @param row - The attention row to score.
 * @returns The 6-signal vector consumed by {@link computePromotionScore}.
 * @task T11382
 * @task T11385
 */
export function attentionToPromotionSignals(row: BrainAttentionRow): PromotionSignals {
  const tagCount = Array.isArray(row.tags) ? row.tags.length : 0;
  // Content-richness proxy: scale length toward 1.0 over ~120 chars, add a
  // modest boost per tag (capped). A terse, untagged jot lands well below the
  // promote bar; a detailed, tagged note can cross it on recency alone.
  const lengthFactor = Math.min(1, row.content.trim().length / 120);
  const tagFactor = Math.min(0.3, tagCount * 0.1);
  const qualityScore = Math.min(1, lengthFactor * 0.7 + tagFactor);

  // `createdAt` is stored as unix-ms; the scorer's recencyFactor expects an
  // ISO/SQLite datetime string, so normalise to ISO.
  const createdAtIso = new Date(row.createdAt).toISOString();

  return {
    citationCount: 0,
    qualityScore,
    // An entry that already carries a decay_score has demonstrated persistence;
    // feed it as the stability signal. Null → scorer's 0.5 default.
    stabilityScore: row.decayScore,
    createdAt: createdAtIso,
    userVerified: 0,
    outcomeCorrelated: 0,
  };
}

/**
 * Decide the SINGLE verdict for one attention entry from its composite score and
 * liveness — the reconciliation of the parent epic's split AC2/AC3/AC4.
 *
 * Exactly one of `promote` | `keep` | `discard` is returned:
 *
 * 1. `discard` — the entry is already past its TTL (`expires_at <= now`) OR its
 *    `decay_score` is below {@link ATTENTION_DISCARD_THRESHOLD}. (The accessor
 *    sweep flips these to `discarded`; deciding `discard` here keeps the verdict
 *    audit consistent with what the sweep will do.)
 * 2. `promote` — a live entry whose composite score ≥
 *    {@link ATTENTION_PROMOTE_THRESHOLD}.
 * 3. `keep` — everything else: a live, mid-salience entry that stays `open` for
 *    the next cycle.
 *
 * @param row - The attention entry under review.
 * @param score - Its composite 6-signal score (from {@link computePromotionScore}).
 * @param now - Reference time (unix ms) for the TTL check; defaults to `Date.now()`.
 * @param promoteThreshold - Promote bar (defaults to {@link ATTENTION_PROMOTE_THRESHOLD}).
 * @param discardThreshold - Discard decay floor (defaults to {@link ATTENTION_DISCARD_THRESHOLD}).
 * @returns The single verdict for this entry.
 * @task T11385
 */
export function decideAttentionVerdict(
  row: BrainAttentionRow,
  score: number,
  now: number = Date.now(),
  promoteThreshold: number = ATTENTION_PROMOTE_THRESHOLD,
  discardThreshold: number = ATTENTION_DISCARD_THRESHOLD,
): AttentionVerdict {
  const expired = typeof row.expiresAt === 'number' && row.expiresAt <= now;
  const decayedOut = typeof row.decayScore === 'number' && row.decayScore < discardThreshold;
  if (expired || decayedOut) return 'discard';
  if (score >= promoteThreshold) return 'promote';
  return 'keep';
}

/**
 * Options for {@link consolidateAttention}.
 *
 * @task T11382
 */
export interface ConsolidateAttentionOptions {
  /** Reference time (unix ms) for recency + TTL. Defaults to `Date.now()`. */
  now?: number;
  /** Max entries reviewed per cycle (bounds the pass). Defaults to 200. */
  limit?: number;
  /** Promote threshold override (defaults to {@link ATTENTION_PROMOTE_THRESHOLD}). */
  promoteThreshold?: number;
  /** Discard decay floor override (defaults to {@link ATTENTION_DISCARD_THRESHOLD}). */
  discardThreshold?: number;
}

/**
 * Review the live Tier-2 attention buffer and apply one promote|keep|discard
 * verdict per entry — the dream-cycle's consolidation pass over working memory.
 *
 * Steps:
 *
 * 1. Read every LIVE (`open`, non-expired, above-decay-floor) attention entry
 *    across ALL scopes via the accessor's leakage-safe `findAttention` (no scope
 *    restriction → the whole buffer; JSONB `tags` read via `json(col)`). This is
 *    the dream-cycle reviewing the buffer, NOT a per-agent read.
 * 2. Score each entry with the EXISTING composite 6-signal scorer and decide one
 *    verdict ({@link decideAttentionVerdict}).
 * 3. `promote` → route through the conduit ({@link promoteAttentionToMemory}),
 *    carrying scope provenance, then mark the source `consolidated` (idempotent).
 * 4. `discard`/expiry → the homeostatic sweep
 *    ({@link BrainDataAccessor.expireAttention}) flips TTL/decay-floor entries to
 *    `discarded` in SQL.
 * 5. `keep` → left `open` for the next cycle.
 *
 * Every verdict is audited via pino ({@link getLogger}) so a teardown-race never
 * routes a deferred log through the vitest console interceptor.
 *
 * Leakage preservation: scope provenance is attached at promotion time, so agent
 * A's promoted entry never surfaces under agent B's scope — the structural
 * guarantee the buffer's scope-key already provides for reads is carried forward
 * into durable memory.
 *
 * @param projectRoot - Absolute project root (brain.db resolution).
 * @param options - Reference time, per-cycle limit, threshold overrides.
 * @returns The aggregated consolidation result + per-entry audit.
 * @task T11382
 * @task T11383
 * @task T11384
 * @task T11385
 */
export async function consolidateAttention(
  projectRoot: string,
  options: ConsolidateAttentionOptions = {},
): Promise<AttentionConsolidationResult> {
  const now = options.now ?? Date.now();
  const limit = options.limit ?? 200;
  const promoteThreshold = options.promoteThreshold ?? ATTENTION_PROMOTE_THRESHOLD;
  const discardThreshold = options.discardThreshold ?? ATTENTION_DISCARD_THRESHOLD;

  const result: AttentionConsolidationResult = {
    reviewed: 0,
    promoted: 0,
    kept: 0,
    discarded: 0,
    reviews: [],
  };

  const accessor = await getBrainAccessor(projectRoot);

  // 1. Read the LIVE buffer across all scopes (no scope restriction → whole
  //    buffer). `openOnly` (default) + decay floor filter to reviewable entries
  //    entirely in SQL; tags are projected via json(col) (JSONB read rule).
  const live = await accessor.findAttention({
    openOnly: true,
    decayThreshold: discardThreshold,
    now,
    limit,
  });
  result.reviewed = live.length;

  // 2–3. Score + decide + promote-via-conduit, per entry.
  for (const row of live) {
    const signals = attentionToPromotionSignals(row);
    const score = computePromotionScore(signals);
    const verdict = decideAttentionVerdict(row, score, now, promoteThreshold, discardThreshold);

    let promotedToId: string | null = null;

    if (verdict === 'promote') {
      const promotion = await promoteAttentionToMemory(row, projectRoot);
      if (promotion.success && promotion.memoryId) {
        promotedToId = promotion.memoryId;
        // Idempotent: a re-run reads only `open` entries, so a `consolidated`
        // row is never re-promoted.
        await accessor.setAttentionStatus(row.id, 'consolidated');
        result.promoted += 1;
      } else {
        // Conduit failure — leave the entry open so the next cycle retries.
        log.warn(
          { attentionId: row.id, err: promotion.error },
          'Tier-2 promotion via conduit failed; leaving entry open',
        );
        result.kept += 1;
      }
    } else if (verdict === 'discard') {
      // The accessor sweep (step 4) performs the actual status flip in SQL; the
      // verdict here records the intent for the audit + the test assertion.
      result.discarded += 1;
    } else {
      result.kept += 1;
    }

    const rationale = computePromotionRationale(signals, promoteThreshold);
    // Audit row via pino — deciding signal scores recorded (T11385 AC2).
    log.debug(
      {
        attentionId: row.id,
        verdict,
        score,
        scopeKind: row.scopeKind,
        scopeId: row.scopeId,
        rationale: rationale.signals,
      },
      'Tier-2 attention verdict',
    );

    result.reviews.push({
      id: row.id,
      verdict,
      score,
      scopeKind: row.scopeKind,
      scopeId: row.scopeId,
      promotedToId,
    });
  }

  // 4. Homeostatic decay sweep — flip TTL-expired / decay-floor entries to
  //    `discarded` in SQL (reused, not reinvented). Idempotent; runs after
  //    promotion so a just-promoted entry is never swept.
  const swept = await accessor.expireAttention({ now, decayThreshold: discardThreshold });
  // The per-entry `discard` verdicts and the sweep both target the same
  // TTL/decay-floor entries; the sweep is the authoritative status-flip and may
  // also catch entries beyond the read limit. Report the larger so the buffer is
  // provably bounded.
  result.discarded = Math.max(result.discarded, swept);

  log.info(
    {
      reviewed: result.reviewed,
      promoted: result.promoted,
      kept: result.kept,
      discarded: result.discarded,
    },
    'Tier-2 attention consolidation complete',
  );

  return result;
}
