/**
 * /brain/patterns page server load (T990 Wave 1D).
 *
 * Initial pass fetches the default patterns list so SSR delivers a
 * populated page. Client-side interactions (filter, sort, paginate)
 * re-issue the same endpoint.
 *
 * @task T990
 * @wave 1D
 */

import type { BrainPatternsResponse } from '$lib/../routes/api/memory/patterns/+server.js';
import type { PageServerLoad } from './$types';

export interface PatternsPageData {
  initial: BrainPatternsResponse | null;
}

export const load: PageServerLoad = async ({ fetch }): Promise<PatternsPageData> => {
  try {
    const res = await fetch('/api/memory/patterns?limit=50&offset=0&sort=created_desc');
    if (!res.ok) return { initial: null };
    const initial = (await res.json()) as BrainPatternsResponse;
    return { initial };
  } catch {
    return { initial: null };
  }
};
