/**
 * ADR List Operation (ADR-017)
 *
 * Lists ADR records from .cleo/adrs/ with optional filtering.
 *
 * @task T4792
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { paginate } from '../pagination.js';
import { parseAdrFile } from './parse.js';
import type { AdrListResult } from './types.js';

/** List ADRs from .cleo/adrs/ directory with optional status filter */
export async function listAdrs(
  projectRoot: string,
  opts?: { status?: string; since?: string; limit?: number; offset?: number },
): Promise<AdrListResult> {
  const adrsDir = join(projectRoot, '.cleo', 'adrs');

  if (!existsSync(adrsDir)) {
    return { adrs: [], total: 0, filtered: 0 };
  }

  const files = readdirSync(adrsDir)
    .filter((f) => f.endsWith('.md') && f.startsWith('ADR-'))
    .sort();

  const records = files.map((f) => parseAdrFile(join(adrsDir, f), projectRoot));

  const total = records.length;
  const filtered = records.filter((r) => {
    if (opts?.status && r.frontmatter.Status !== opts.status) return false;
    if (opts?.since && r.frontmatter.Date < opts.since) return false;
    return true;
  });
  const page = paginate(filtered, opts?.limit, opts?.offset);

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
