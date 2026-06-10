/**
 * Catalog seeder — populates `models_catalog` from the shipped offline seed (T11734).
 *
 * ## What it does
 *
 * {@link seedModelsCatalog} reads the bundled `curated-catalog.json`, validates it
 * against the contract zod schema ({@link curatedCatalogSchema}), flattens every
 * provider→model entry into a `models_catalog` row, and UPSERTS each via
 * {@link openDualScopeDb}`('global')`. Seeding is the offline bootstrap of the
 * catalog SSoT — NO network is touched (the network refresh op is a separate leaf).
 *
 * ## Idempotent (AC2) + version-skip (AC4)
 *
 * The seed carries a semver `version`. The seeder records the seeded version in the
 * global key-value `__catalog_meta` row and SKIPS a re-seed when the persisted
 * version equals the shipped version (logged, not re-written). On a NEWER shipped
 * version it re-seeds (upsert on the `(provider_id, models_dev_id)` natural key, so
 * a re-seed never duplicates rows — running twice yields the same row count).
 *
 * @module llm/catalog-seeder
 * @task T11734
 * @epic T11694 (E8-CATALOG-CURATION)
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type CuratedCatalog, curatedCatalogSchema } from '@cleocode/contracts';
import { sql } from 'drizzle-orm';
import { getLogger } from '../logger.js';
import {
  type CleoGlobalDb,
  openDualScopeDb,
  openDualScopeDbAtPath,
} from '../store/dual-scope-db.js';
import {
  modelsCatalog,
  type NewModelsCatalogRow,
} from '../store/schema/cleo-global/models-catalog.js';

const logger = getLogger('llm-catalog-seeder');

/** Result of a {@link seedModelsCatalog} run. */
export interface SeedCatalogResult {
  /** Whether rows were written this run (`false` on a version-skip). */
  readonly seeded: boolean;
  /** The seed version applied (or already persisted on a skip). */
  readonly version: string;
  /** Number of rows upserted (0 on a skip). */
  readonly rowCount: number;
  /** Why the run behaved as it did. */
  readonly reason: 'seeded' | 'version-skip' | 'reseeded-newer';
}

/** Injectable seam for {@link seedModelsCatalog} (tests pass a temp-DB handle + fixture). */
export interface SeedCatalogDeps {
  /**
   * An already-open global Drizzle handle. When omitted the seeder opens via
   * {@link openDualScopeDb}`('global')`. Tests pass a temp-DB handle (opened via
   * {@link openSeederAtPath}) to stay off `.cleo/*.db`.
   */
  readonly db?: CleoGlobalDb;
  /**
   * A catalog object to seed from, bypassing the bundled `curated-catalog.json`
   * (tests pass a fixture). When omitted the shipped seed is read + validated.
   */
  readonly catalog?: CuratedCatalog;
}

/**
 * Open the global seeder handle at an EXPLICIT path (test seam).
 *
 * @param dbPath - Absolute path to the temp `cleo.db`.
 * @task T11734
 */
export async function openSeederAtPath(dbPath: string): Promise<CleoGlobalDb> {
  const handle = await openDualScopeDbAtPath('global', dbPath);
  return handle.db;
}

/**
 * Read + validate the shipped seed (`curated-catalog.json`) — no network.
 *
 * Throws a descriptive error when the bundled file is missing or fails schema
 * validation, so a malformed seed fails the build/seed loudly rather than silently
 * persisting garbage.
 *
 * @task T11734
 */
export function loadAndValidateSeed(): CuratedCatalog {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const jsonPath = join(thisDir, 'curated-catalog.json');
  const raw = JSON.parse(readFileSync(jsonPath, 'utf-8')) as unknown;
  return curatedCatalogSchema.parse(raw);
}

/**
 * Flatten a {@link CuratedCatalog} into `models_catalog` INSERT rows.
 *
 * Each provider→model entry becomes one row; nested `modalities` / `cost` are
 * JSON-serialized into their TEXT columns. `id` and `models_dev_id` both take the
 * entry id (the latter anchors the `(provider_id, models_dev_id)` upsert key).
 *
 * @task T11734
 */
export function flattenCatalogToRows(catalog: CuratedCatalog): NewModelsCatalogRow[] {
  const rows: NewModelsCatalogRow[] = [];
  for (const [providerId, models] of Object.entries(catalog.models)) {
    for (const [modelId, entry] of Object.entries(models)) {
      rows.push({
        id: modelId,
        providerId,
        name: entry.name,
        family: entry.family,
        attachment: entry.attachment,
        reasoning: entry.reasoning,
        temperature: entry.temperature,
        interleaved: entry.interleaved,
        toolCall: entry.tool_call,
        modalities: JSON.stringify(entry.modalities),
        cost: JSON.stringify(entry.cost),
        contextLimit: entry.limit.context,
        outputLimit: entry.limit.output,
        status: entry.status,
        releaseDate: entry.release_date,
        modelsDevId: entry.id,
        source: 'seed',
      });
    }
  }
  return rows;
}

/** Resolve the global Drizzle handle — injected, else canonical open. */
async function resolveDb(deps?: SeedCatalogDeps): Promise<CleoGlobalDb> {
  if (deps?.db !== undefined) return deps.db;
  const handle = await openDualScopeDb('global');
  return handle.db;
}

/** The KV key under which the seeded catalog version is persisted. */
const CATALOG_VERSION_KEY = 'catalog.seed.version';

/**
 * Read the persisted seeded-catalog version from the lightweight `__catalog_meta`
 * KV table (created on demand), or `null` when never seeded.
 *
 * @internal
 */
async function readPersistedVersion(db: CleoGlobalDb): Promise<string | null> {
  db.run(
    sql`CREATE TABLE IF NOT EXISTS __catalog_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  );
  const rows = (await db.all(
    sql`SELECT value FROM __catalog_meta WHERE key = ${CATALOG_VERSION_KEY} LIMIT 1`,
  )) as Array<{ value: string }>;
  return rows[0]?.value ?? null;
}

/** Persist the seeded-catalog version into `__catalog_meta`. @internal */
async function writePersistedVersion(db: CleoGlobalDb, version: string): Promise<void> {
  db.run(
    sql`INSERT INTO __catalog_meta (key, value) VALUES (${CATALOG_VERSION_KEY}, ${version})
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
}

/** Compare two semver strings — `a > b`? Padded numeric per-segment compare. @internal */
function semverGreater(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10));
  const pb = b.split('.').map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da > db) return true;
    if (da < db) return false;
  }
  return false;
}

/**
 * Seed `models_catalog` from the shipped offline seed — idempotent, offline-first.
 *
 * Behaviour:
 *   - First run (no persisted version): upsert every row, persist the version. (AC1)
 *   - Re-run with the SAME version: SKIP (logged, not re-written). (AC4)
 *   - Re-run with a NEWER shipped version: re-seed (upsert, no duplicates). (AC3)
 *
 * The upsert is on the `(provider_id, models_dev_id)` natural key, so running twice
 * yields the same row count and never duplicates (AC2). NO network is touched.
 *
 * @param deps - Optional injected DB handle / fixture catalog (tests).
 * @returns A {@link SeedCatalogResult} describing what happened.
 *
 * @task T11734
 */
export async function seedModelsCatalog(deps?: SeedCatalogDeps): Promise<SeedCatalogResult> {
  const catalog = deps?.catalog ?? loadAndValidateSeed();
  const db = await resolveDb(deps);

  const persisted = await readPersistedVersion(db);
  if (persisted !== null && !semverGreater(catalog.version, persisted)) {
    logger.debug(
      { persisted, shipped: catalog.version },
      'catalog-seeder: persisted version >= shipped; skipping re-seed',
    );
    return { seeded: false, version: persisted, rowCount: 0, reason: 'version-skip' };
  }

  const rows = flattenCatalogToRows(catalog);
  for (const row of rows) {
    await db
      .insert(modelsCatalog)
      .values(row)
      .onConflictDoUpdate({
        target: [modelsCatalog.providerId, modelsCatalog.modelsDevId],
        set: {
          id: row.id,
          name: row.name,
          family: row.family,
          attachment: row.attachment,
          reasoning: row.reasoning,
          temperature: row.temperature,
          interleaved: row.interleaved,
          toolCall: row.toolCall,
          modalities: row.modalities,
          cost: row.cost,
          contextLimit: row.contextLimit,
          outputLimit: row.outputLimit,
          status: row.status,
          releaseDate: row.releaseDate,
          source: row.source,
          seededAt: sql`(datetime('now'))`,
        },
      });
  }
  await writePersistedVersion(db, catalog.version);

  const reason: SeedCatalogResult['reason'] = persisted === null ? 'seeded' : 'reseeded-newer';
  logger.debug(
    { version: catalog.version, rowCount: rows.length, reason },
    'catalog-seeder: models_catalog seeded',
  );
  return { seeded: true, version: catalog.version, rowCount: rows.length, reason };
}
