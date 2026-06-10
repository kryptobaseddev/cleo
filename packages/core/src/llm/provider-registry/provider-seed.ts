/**
 * Provider seeder — populates the `providers` table from the builtin ProviderDef set.
 *
 * M3 Provider SSoT (epic T11667 · task T11703). {@link seedProviders} takes the builtin
 * {@link ProviderDef} set (derived from the runtime {@link ProviderProfile} builtins by
 * {@link builtinProviderDefs}), serializes each declarative field to its TEXT column,
 * and UPSERTS each row via {@link openDualScopeDb}`('global')`. Seeding is the offline
 * bootstrap of the provider SSoT — NO network is touched.
 *
 * ## Idempotent (AC5) + does NOT clobber user plugin providers
 *
 * The upsert targets the `id` primary key, so re-running yields the same row count and
 * never duplicates (running twice = same rows). Only BUILTIN ids are touched — a user
 * plugin provider row (a different id) is never read or written, so a re-seed cannot
 * clobber it. `source` is stamped `seed` for these rows; plugin rows carry their own
 * `source`.
 *
 * @module llm/provider-registry/provider-seed
 * @task T11703
 * @epic T11667
 * @see ./provider-defs.ts — the builtin ProviderDef set (seed source)
 * @see ../../store/schema/cleo-global/providers.ts — the persisted table
 * @see ../catalog-seeder.ts — the sibling seeder this mirrors
 */

import type { ProviderDef } from '@cleocode/contracts';
import { sql } from 'drizzle-orm';
import { getLogger } from '../../logger.js';
import {
  type CleoGlobalDb,
  openDualScopeDb,
  openDualScopeDbAtPath,
} from '../../store/dual-scope-db.js';
import { type NewProviderRow, providers } from '../../store/schema/cleo-global/providers.js';
import { builtinProviderDefs } from './provider-defs.js';

const logger = getLogger('llm-provider-seeder');

/** Result of a {@link seedProviders} run. */
export interface SeedProvidersResult {
  /** Whether rows were written this run. */
  readonly seeded: boolean;
  /** Number of builtin provider rows upserted. */
  readonly rowCount: number;
}

/** Injectable seam for {@link seedProviders} (tests pass a temp-DB handle + defs). */
export interface SeedProvidersDeps {
  /**
   * An already-open global Drizzle handle. When omitted the seeder opens via
   * {@link openDualScopeDb}`('global')`. Tests pass a temp-DB handle (opened via
   * {@link openProviderSeederAtPath}) to stay off `.cleo/*.db`.
   */
  readonly db?: CleoGlobalDb;
  /**
   * The provider definitions to seed, bypassing {@link builtinProviderDefs} (tests
   * pass a fixture). When omitted the builtin set is used.
   */
  readonly defs?: ReadonlyArray<ProviderDef>;
}

/**
 * Open the global seeder handle at an EXPLICIT path (test seam).
 *
 * @param dbPath - Absolute path to the temp `cleo.db`.
 * @task T11703
 */
export async function openProviderSeederAtPath(dbPath: string): Promise<CleoGlobalDb> {
  const handle = await openDualScopeDbAtPath('global', dbPath);
  return handle.db;
}

/**
 * Serialize one {@link ProviderDef} into a `providers` INSERT row. JSON columns are
 * `JSON.stringify`-serialized; `oauth` is NULL when the provider has no OAuth flow.
 *
 * @param def - The declarative provider definition.
 * @returns The flattened `providers` row.
 * @task T11703
 */
export function providerDefToRow(def: ProviderDef): NewProviderRow {
  return {
    id: def.id,
    displayName: def.displayName,
    aliases: JSON.stringify(def.aliases),
    authMethods: JSON.stringify(def.authMethods),
    endpoint: JSON.stringify(def.endpoint),
    altEndpoints: JSON.stringify(def.altEndpoints ?? []),
    modelsDevId: def.modelsDevId,
    defaultHeaders: JSON.stringify(def.defaultHeaders ?? {}),
    envVars: JSON.stringify(def.envVars ?? []),
    oauth: def.oauth !== undefined ? JSON.stringify(def.oauth) : null,
    requestQuirks: JSON.stringify(def.requestQuirks ?? []),
    source: 'seed',
  };
}

/** Resolve the global Drizzle handle — injected, else canonical open. @internal */
async function resolveDb(deps?: SeedProvidersDeps): Promise<CleoGlobalDb> {
  if (deps?.db !== undefined) return deps.db;
  const handle = await openDualScopeDb('global');
  return handle.db;
}

/**
 * Seed the `providers` table from the builtin {@link ProviderDef} set — idempotent,
 * offline-first, plugin-safe.
 *
 * Upserts on the `id` primary key, so running twice yields the same row count and
 * never duplicates (AC5). Only builtin ids are written; user plugin provider rows
 * (other ids) are never touched. NO network is touched.
 *
 * @param deps - Optional injected DB handle / fixture defs (tests).
 * @returns A {@link SeedProvidersResult} describing what happened.
 * @task T11703
 */
export async function seedProviders(deps?: SeedProvidersDeps): Promise<SeedProvidersResult> {
  const defs = deps?.defs ?? builtinProviderDefs();
  const db = await resolveDb(deps);

  for (const def of defs) {
    const row = providerDefToRow(def);
    await db
      .insert(providers)
      .values(row)
      .onConflictDoUpdate({
        target: providers.id,
        set: {
          displayName: row.displayName,
          aliases: row.aliases,
          authMethods: row.authMethods,
          endpoint: row.endpoint,
          altEndpoints: row.altEndpoints,
          modelsDevId: row.modelsDevId,
          defaultHeaders: row.defaultHeaders,
          envVars: row.envVars,
          oauth: row.oauth,
          requestQuirks: row.requestQuirks,
          source: row.source,
          seededAt: sql`(datetime('now'))`,
        },
      });
  }

  logger.debug({ rowCount: defs.length }, 'provider-seeder: providers seeded');
  return { seeded: defs.length > 0, rowCount: defs.length };
}
