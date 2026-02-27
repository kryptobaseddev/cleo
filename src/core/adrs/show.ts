/**
 * ADR Show Operation (ADR-017)
 *
 * Retrieves a single ADR record by ID.
 *
 * @task T4792
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseAdrFile } from './parse.js';
import type { AdrRecord } from './types.js';

/** Retrieve a single ADR by ID (e.g., 'ADR-007') */
export async function showAdr(
  projectRoot: string,
  adrId: string,
): Promise<AdrRecord | null> {
  const adrsDir = join(projectRoot, '.cleo', 'adrs');

  if (!existsSync(adrsDir)) return null;

  const files = readdirSync(adrsDir).filter(f => f.startsWith(adrId) && f.endsWith('.md'));
  if (files.length === 0) return null;

  const filePath = join(adrsDir, files[0]!);
  return parseAdrFile(filePath, projectRoot);
}
