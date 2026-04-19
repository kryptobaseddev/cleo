/**
 * /brain/causal server load (T990 Wave 1D).
 *
 * @task T990
 * @wave 1D
 */

import type { PageServerLoad } from './$types';

export interface CausalPageData {
  initialTaskId: string;
}

export const load: PageServerLoad = ({ url }): CausalPageData => {
  return {
    initialTaskId: (url.searchParams.get('taskId') ?? '').trim(),
  };
};
