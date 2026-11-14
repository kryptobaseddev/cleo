/**
 * ADR Show Operation (ADR-017)
 *
 * Retrieves a single ADR record by ID.
 *
 * @task T4792
 * @task T14108 — reads the canon ADR home instead of `.cleo/adrs/`
 */

import type { AdminAdrShowParams } from '@cleocode/contracts';
import { loadAdrs } from './home.js';
import type { AdrRecord } from './types.js';

/**
 * Retrieve a single ADR, case-insensitively, by its id (`ADR-007` resolves to
 * the preferred ADR of that number, see `loadAdrs`), by its slug, or by a
 * file-name prefix.
 */
export async function showAdr(
  projectRoot: string,
  params: AdminAdrShowParams,
): Promise<AdrRecord | null> {
  const wanted = params.adrId.toLowerCase();
  const adrs = loadAdrs(projectRoot);
  const match =
    adrs.find((adr) => adr.record.id.toLowerCase() === wanted || adr.slug === wanted) ??
    adrs.find((adr) => adr.file.name.toLowerCase().startsWith(wanted));
  return match?.record ?? null;
}
