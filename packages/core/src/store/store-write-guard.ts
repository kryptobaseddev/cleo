/**
 * Write guard for a project store whose twin collapse failed (T12535).
 *
 * When the collapse cannot run inside a domain bind, the bind still succeeds.
 * Reads are served from TEMP shadows holding the merged, bare-authoritative
 * view (see `twin-collapse.ts`), so nobody is locked out, but a write would
 * land in a shadow or in a twin that is not in step. This module is the
 * single question the write path asks: may this project's store be written?
 * The CLI dispatch pipeline asks it for every mutating operation.
 *
 * @module
 * @task T12535
 */

import { existsSync } from 'node:fs';
import type { CleoError } from '../errors.js';
import { resolveDualScopeDbPath } from './dual-scope-db.js';
import { getDb, getNativeDb } from './sqlite.js';
import { twinCollapseError, twinCollapseFailureOf } from './twin-collapse.js';

/**
 * Which dispatch domains write each collapsed pair (`'*'`: every mutation).
 * A failed pair blocks only its writers: a docs merge failure never stops
 * `cleo add` or `cleo complete`. Writers outside these domains (a memory
 * observation with attachment refs, a changeset) are still refused at the
 * accessor entry (`assertTwinCollapseWritable`).
 */
const WRITE_SCOPE: Readonly<Record<string, '*' | readonly string[]>> = {
  schema_meta: '*',
  sticky_tags: ['sticky'],
  attachments: ['docs'],
  // Token writes are refused at the accessor only (`token-service.ts`): a failed
  // token drain must not block any command (T13115).
  token_usage: [],
};

/** The operation asking to write, as the dispatch pipeline names it. */
export interface StoreWriteRequest {
  readonly domain: string;
  readonly operation: string;
}

/**
 * The `E_TWIN_COLLAPSE_FAILED` error that blocks this write to the project's
 * store, or `null` when it may proceed.
 *
 * Binds the tasks domain first (which runs the collapse), so the answer is
 * current. A project without a store, or one whose bind fails for another
 * reason, is not blocked here: the operation then fails, or not, on its own.
 *
 * @param projectRoot - Project directory.
 * @param request - The operation; omitted, any failed pair blocks.
 * @returns The blocking error, or `null`.
 * @task T12535
 */
export async function storeWriteBlock(
  projectRoot: string,
  request?: StoreWriteRequest,
): Promise<CleoError | null> {
  let dbPath: string;
  try {
    dbPath = resolveDualScopeDbPath('project', projectRoot);
  } catch {
    return null;
  }
  if (!existsSync(dbPath)) return null;
  try {
    await getDb(projectRoot);
  } catch {
    return null;
  }
  const native = getNativeDb(projectRoot);
  const failure = native ? twinCollapseFailureOf(native) : undefined;
  if (!failure) return null;
  if (request === undefined) return twinCollapseError(failure);
  const blocks = failure.tables.some((table) => {
    const scope = WRITE_SCOPE[table] ?? '*';
    return scope === '*' || scope.includes(request.domain);
  });
  return blocks ? twinCollapseError(failure) : null;
}
