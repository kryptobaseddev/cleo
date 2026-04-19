/**
 * /brain/search server load (T990 Wave 1D).
 *
 * No initial query — the search page is driven entirely by client-side
 * input. Load is a no-op; the page takes a `q` URL param to support
 * deep-linking from memory-bridge / external tools.
 *
 * @task T990
 * @wave 1D
 */

import type { PageServerLoad } from './$types';

export interface SearchPageData {
  initialQuery: string;
}

export const load: PageServerLoad = ({ url }): SearchPageData => {
  return {
    initialQuery: (url.searchParams.get('q') ?? '').trim(),
  };
};
