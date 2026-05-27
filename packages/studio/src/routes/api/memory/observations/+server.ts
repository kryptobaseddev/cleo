/**
 * Memory observations API endpoint.
 * GET /api/memory/observations?tier=short&type=episodic&min_quality=0.5
 *
 * Delegates to `@cleocode/core` public memory API (T9615/T9616).
 * Zero raw SQL in this handler.
 *
 * @remarks
 * The CORE `getObservations` result fields use camelCase; this route
 * maps them back to snake_case for backward compatibility with Studio UI.
 */

import { getObservations } from '@cleocode/core';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** A single observation record (snake_case for back-compat with Studio UI). */
export interface BrainObservation {
  id: string;
  type: string;
  title: string;
  subtitle: string | null;
  narrative: string | null;
  project: string | null;
  quality_score: number | null;
  memory_tier: string | null;
  memory_type: string | null;
  verified: number;
  valid_at: string | null;
  invalid_at: string | null;
  source_confidence: string | null;
  citation_count: number;
  prune_candidate: number;
  created_at: string;
}

/** Response envelope for GET /api/memory/observations. */
export interface BrainObservationsResponse {
  observations: BrainObservation[];
  total: number;
  filtered: number;
}

export const GET: RequestHandler = async ({ locals, url }) => {
  const tier = url.searchParams.get('tier') ?? undefined;
  const type = url.searchParams.get('type') ?? undefined;
  const minQualityRaw = url.searchParams.get('min_quality');
  const minQuality =
    minQualityRaw !== null
      ? (() => {
          const q = parseFloat(minQualityRaw);
          return Number.isNaN(q) ? undefined : q;
        })()
      : undefined;

  try {
    const result = await getObservations({
      tier,
      type,
      minQuality,
      limit: 200,
      projectPath: locals.projectCtx.projectPath,
    });

    // Map camelCase CORE result to snake_case for UI back-compat.
    const observations: BrainObservation[] = result.observations.map((o) => ({
      id: o.id,
      type: o.type,
      title: o.title,
      subtitle: o.subtitle,
      narrative: o.narrative,
      project: o.project,
      quality_score: o.qualityScore,
      memory_tier: o.memoryTier,
      memory_type: o.memoryType,
      verified: o.verified,
      valid_at: o.validAt,
      invalid_at: o.invalidAt,
      source_confidence: o.sourceConfidence,
      citation_count: o.citationCount,
      prune_candidate: o.pruneCandidate,
      created_at: o.createdAt,
    }));

    return json({
      observations,
      total: result.total,
      filtered: result.filtered,
    } satisfies BrainObservationsResponse);
  } catch {
    return json({ observations: [], total: 0, filtered: 0 } satisfies BrainObservationsResponse);
  }
};
