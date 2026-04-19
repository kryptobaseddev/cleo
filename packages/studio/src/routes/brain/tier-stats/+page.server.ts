/**
 * /brain/tier-stats page server load (T990 Wave 1D).
 *
 * Fetches `/api/memory/tier-stats` at load time so the first paint has
 * server-rendered distributions and the hydrated client can re-fetch
 * on refresh without a perceived flash.
 *
 * @task T990
 * @wave 1D
 */

import type { TierStatsResponse } from '$lib/../routes/api/memory/tier-stats/+server.js';
import type { PageServerLoad } from './$types';

export interface TierStatsPageData {
  stats: TierStatsResponse | null;
  loadedAt: string;
}

export const load: PageServerLoad = async ({ fetch }): Promise<TierStatsPageData> => {
  try {
    const res = await fetch('/api/memory/tier-stats');
    if (!res.ok) {
      return { stats: null, loadedAt: new Date().toISOString() };
    }
    const stats = (await res.json()) as TierStatsResponse;
    return { stats, loadedAt: new Date().toISOString() };
  } catch {
    return { stats: null, loadedAt: new Date().toISOString() };
  }
};
