/**
 * /brain/learnings page server load (T990 Wave 1D).
 *
 * @task T990
 * @wave 1D
 */

import type { BrainLearningsResponse } from '$lib/../routes/api/memory/learnings/+server.js';
import type { PageServerLoad } from './$types';

export interface LearningsPageData {
  initial: BrainLearningsResponse | null;
}

export const load: PageServerLoad = async ({ fetch }): Promise<LearningsPageData> => {
  try {
    const res = await fetch('/api/memory/learnings?limit=50&offset=0&sort=created_desc');
    if (!res.ok) return { initial: null };
    const initial = (await res.json()) as BrainLearningsResponse;
    return { initial };
  } catch {
    return { initial: null };
  }
};
