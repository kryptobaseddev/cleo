/**
 * ADR Show Operation (ADR-017)
 *
 * Retrieves a single ADR record by ID.
 *
 * @task T4792
 * @task T14108 — reads the canon ADR home instead of `.cleo/adrs/`
 */

import type { AdminAdrShowParams } from '@cleocode/contracts';
import { listAdrFiles } from './home.js';
import { parseAdrFile } from './parse.js';
import type { AdrRecord } from './types.js';

/** Retrieve a single ADR by ID or file-name prefix (e.g. 'ADR-007'), case-insensitively */
export async function showAdr(
  projectRoot: string,
  params: AdminAdrShowParams,
): Promise<AdrRecord | null> {
  const prefix = params.adrId.toLowerCase();
  const file = listAdrFiles(projectRoot).find((f) => f.name.toLowerCase().startsWith(prefix));
  return file ? parseAdrFile(file.absPath, projectRoot) : null;
}
