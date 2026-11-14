/**
 * ADR List Operation (ADR-017)
 *
 * Lists ADR records from the ADR home (`docs/adr/`, see `home.ts`) with
 * optional filtering.
 *
 * @task T4792
 * @task T14108 — reads the canon ADR home instead of `.cleo/adrs/`
 */

import type { AdminAdrFindParams } from '@cleocode/contracts';
import { paginate } from '../pagination.js';
import { listAdrFiles } from './home.js';
import { parseAdrFile } from './parse.js';
import type { AdrListResult } from './types.js';

/** List ADRs from the ADR home with optional status filter */
export async function listAdrs(
  projectRoot: string,
  params: AdminAdrFindParams = {},
): Promise<AdrListResult> {
  const records = listAdrFiles(projectRoot).map((f) => parseAdrFile(f.absPath, projectRoot));

  const total = records.length;
  const filtered = records.filter((r) => {
    if (params.status && r.frontmatter.Status !== params.status) return false;
    if (params.since && r.frontmatter.Date < params.since) return false;
    return true;
  });
  const page = paginate(filtered, params.limit, params.offset);

  return {
    adrs: page.items.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.frontmatter.Status,
      date: r.frontmatter.Date,
      filePath: r.file,
    })),
    total,
    filtered: filtered.length,
  };
}
