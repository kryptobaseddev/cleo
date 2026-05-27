/**
 * One-shot migration: import the legacy `${CLEO_HOME}/anthropic-key` flat file
 * into the unified credential pool as a `legacy-flat-key` entry.
 *
 * Part of `E-CONFIG-AUTH-UNIFY` Epic E1 (T9406 / T-E1-4). The legacy flat key
 * file is the "tier 4b" entry in the current 6-tier resolver in
 * `credentials.ts`. Once imported into the pool, the resolver's tier-3
 * (`cred-file`) lookup will pick it up — so post-E2 we can collapse the
 * tier-4b branch entirely without losing any operator's previously-stored
 * key.
 *
 * ## Behavior
 *
 * On `importLegacyFlatAnthropicKey()` (idempotent):
 *
 * 1. If the migration marker `${CLEO_HOME}/.imported-legacy-flat-key` exists,
 *    return immediately (`status: 'marker-present'`).
 * 2. If the pool already contains an `anthropic` entry with
 *    `label === 'legacy-flat-key'`, write the marker and return
 *    (`status: 'already-imported'`).
 * 3. If `${CLEO_HOME}/anthropic-key` does not exist, write the marker and
 *    return (`status: 'no-flat-file'`). Avoids re-stating the file on
 *    every CLI invocation.
 * 4. If the flat file exists but its trimmed content is empty, write the
 *    marker and return (`status: 'empty-flat-file'`). We do NOT rename an
 *    empty file — leave it for the operator to inspect / delete.
 * 5. Otherwise: call `addCredential()` with the trimmed key, then rename
 *    the flat file to `anthropic-key.pre-e1-bak`, then write the marker.
 *    Returns `status: 'imported'`.
 *
 * ## Atomicity contract
 *
 * The two side-effects we care about — (a) the pool entry insert and
 * (b) the flat-file rename — are sequenced so a failure at (b) leaves the
 * pool entry in place AND no marker is written. The next run will then
 * skip the insert (via the `getCredentialByLabel` check in step 2 above)
 * but still attempt the rename. This avoids a half-done state where the
 * marker exists but the original flat file is still discoverable by the
 * tier-4b resolver branch (which would re-import it on the next pool
 * rebuild).
 *
 * If `addCredential()` itself throws, nothing is renamed and no marker
 * is written — the next invocation retries cleanly.
 *
 * @module llm/legacy-flat-key-import
 * @task T9406
 * @epic E-CONFIG-AUTH-UNIFY
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCleoHome } from '@cleocode/paths';
import { getLogger } from '../logger.js';
import { addCredential, getCredentialByLabel } from './credentials-store.js';

const logger = getLogger('llm-legacy-flat-key-import');

/**
 * Canonical label assigned to the imported entry.
 *
 * Constant rather than parameterized — the resolver collapse in E2 keys
 * its behavior off this exact label, so it MUST remain stable.
 */
export const LEGACY_FLAT_KEY_LABEL = 'legacy-flat-key';

/**
 * Filename suffix used when renaming the original flat file post-import.
 *
 * Kept identical to the convention used by the T310 conduit migration
 * (`.pre-t310.bak`) for cross-codebase greppability.
 */
export const LEGACY_FLAT_KEY_BAK_SUFFIX = '.pre-e1-bak';

/**
 * Filename of the migration marker inside `getCleoHome()`. Existence of
 * this file (any content) is sufficient to short-circuit the migration.
 */
export const LEGACY_FLAT_KEY_MARKER = '.imported-legacy-flat-key';

/**
 * Outcome of a single migration attempt.
 *
 * - `imported`          — flat file read, pool entry added, file renamed,
 *                         marker written
 * - `already-imported`  — pool already had a `legacy-flat-key` entry;
 *                         marker written so we never reach this branch
 *                         again
 * - `no-flat-file`      — `${CLEO_HOME}/anthropic-key` does not exist;
 *                         marker written
 * - `empty-flat-file`   — flat file existed but trimmed content was empty;
 *                         marker written; file is NOT renamed
 * - `marker-present`    — short-circuit from the first idempotency check
 *
 * @task T9406
 */
export type LegacyFlatKeyImportStatus =
  | 'imported'
  | 'already-imported'
  | 'no-flat-file'
  | 'empty-flat-file'
  | 'marker-present';

/**
 * Result returned by `importLegacyFlatAnthropicKey()`.
 *
 * `bakPath` is populated only when the rename actually occurred (i.e.
 * `status === 'imported'`).
 *
 * @task T9406
 */
export interface LegacyFlatKeyImportResult {
  /** Outcome category — see `LegacyFlatKeyImportStatus`. */
  status: LegacyFlatKeyImportStatus;
  /** Absolute path of the original flat key file (whether or not it existed). */
  flatPath: string;
  /** Absolute path of the renamed backup, or null if no rename happened. */
  bakPath: string | null;
  /** Absolute path of the marker file (always populated post-call). */
  markerPath: string;
}

/**
 * Compute all paths used by the migration. Pure — no filesystem touch.
 */
function migrationPaths(): { flatPath: string; bakPath: string; markerPath: string } {
  const home = getCleoHome();
  return {
    flatPath: join(home, 'anthropic-key'),
    bakPath: join(home, `anthropic-key${LEGACY_FLAT_KEY_BAK_SUFFIX}`),
    markerPath: join(home, LEGACY_FLAT_KEY_MARKER),
  };
}

/**
 * Write the migration marker. Uses `flag: 'wx'` so concurrent first-run
 * callers race-tolerantly — exactly one writes, the rest get `EEXIST`
 * which we treat as success.
 *
 * Best-effort 0o600 (matches the surrounding cred-store hardening).
 */
function writeMarker(markerPath: string): void {
  try {
    writeFileSync(markerPath, `${new Date().toISOString()}\n`, {
      encoding: 'utf-8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return;
    // Marker write is best-effort. Re-runs are cheap (one stat + one read);
    // surfacing this would just spam the log. Drop to debug.
    logger.debug(
      { markerPath, err: err instanceof Error ? err.message : String(err) },
      'legacy-flat-key migration: marker write failed',
    );
  }
}

/**
 * Read and trim the flat file. Returns null on any I/O error or when the
 * trimmed content is empty. Never throws.
 */
function readFlatKey(flatPath: string): string | null {
  try {
    if (!existsSync(flatPath)) return null;
    const raw = readFileSync(flatPath, 'utf-8').trim();
    return raw || null;
  } catch (err) {
    logger.warn(
      { flatPath, err: err instanceof Error ? err.message : String(err) },
      'legacy-flat-key migration: read failed — skipping',
    );
    return null;
  }
}

/**
 * Import the legacy `${CLEO_HOME}/anthropic-key` flat file into the
 * credential pool, exactly once per CLEO home directory.
 *
 * Idempotent — safe to call from any bootstrap path on every CLI
 * invocation. The marker file guarantees O(1) cost on warm runs.
 *
 * Never throws. All errors are caught and surfaced through the structured
 * logger; the resolver fallback chain still works.
 *
 * @returns A `LegacyFlatKeyImportResult` describing the outcome.
 *
 * @task T9406
 */
export async function importLegacyFlatAnthropicKey(): Promise<LegacyFlatKeyImportResult> {
  const { flatPath, bakPath, markerPath } = migrationPaths();

  // Step 1 — Cheap idempotency check: marker file.
  if (existsSync(markerPath)) {
    return { status: 'marker-present', flatPath, bakPath: null, markerPath };
  }

  // Step 2 — Pool already has a legacy-flat-key entry? Treat as done.
  // This handles the case where a prior CLEO version imported the key but
  // never wrote a marker (or the marker was deleted), AND the case where
  // an operator manually ran `cleo llm add --label legacy-flat-key ...`.
  let existing: Awaited<ReturnType<typeof getCredentialByLabel>> = null;
  try {
    existing = await getCredentialByLabel('anthropic', LEGACY_FLAT_KEY_LABEL);
  } catch (err) {
    // `getCredentialByLabel` is sync-read internally and shouldn't throw,
    // but defensively log + bail so we never wedge bootstrap.
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'legacy-flat-key migration: pool lookup failed — skipping this run',
    );
    return { status: 'no-flat-file', flatPath, bakPath: null, markerPath };
  }
  if (existing) {
    writeMarker(markerPath);
    return { status: 'already-imported', flatPath, bakPath: null, markerPath };
  }

  // Step 3 — Flat file missing? Write marker so we never recheck.
  if (!existsSync(flatPath)) {
    writeMarker(markerPath);
    return { status: 'no-flat-file', flatPath, bakPath: null, markerPath };
  }

  // Step 4 — Flat file empty? Skip without renaming so the operator can
  // inspect it. Write the marker — an empty file will stay empty across
  // runs, so re-checking is pointless.
  const token = readFlatKey(flatPath);
  if (!token) {
    writeMarker(markerPath);
    return { status: 'empty-flat-file', flatPath, bakPath: null, markerPath };
  }

  // Step 5 — Import + rename + marker, in that strict order. If either
  // (5a) or (5b) throws, NO marker is written so the next run retries.
  try {
    // (5a) Pool insert.
    await addCredential({
      provider: 'anthropic',
      label: LEGACY_FLAT_KEY_LABEL,
      authType: 'api_key',
      accessToken: token,
      source: 'manual',
      priority: 100,
    });
  } catch (err) {
    // The pool insert failed — do NOT rename, do NOT mark migrated. Next
    // run will retry the whole operation cleanly.
    logger.error(
      { err: err instanceof Error ? err.message : String(err), flatPath },
      'legacy-flat-key migration: addCredential failed — leaving flat file in place for retry',
    );
    return { status: 'no-flat-file', flatPath, bakPath: null, markerPath };
  }

  // (5b) Rename the flat file. If the rename fails, the pool entry is
  // already in place — the next run will skip the insert (via the
  // `getCredentialByLabel` check) and re-attempt the rename + marker.
  try {
    renameSync(flatPath, bakPath);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), flatPath, bakPath },
      'legacy-flat-key migration: rename to .pre-e1-bak failed — entry imported, will retry rename',
    );
    // Do not write marker — we still want to retry the rename next run.
    // The duplicate-import guard in step 2 prevents a second pool insert.
    return { status: 'imported', flatPath, bakPath: null, markerPath };
  }

  // (5c) Marker. Best-effort; even if this fails the next run is cheap
  // because the duplicate-import guard catches us in step 2 (which then
  // writes the marker itself).
  writeMarker(markerPath);

  logger.info(
    { flatPath, bakPath, markerPath, label: LEGACY_FLAT_KEY_LABEL },
    'legacy-flat-key migration: imported anthropic flat key into pool',
  );

  return { status: 'imported', flatPath, bakPath, markerPath };
}

// ---------------------------------------------------------------------------
// First-invocation latch (T9407 — E1 close-out)
// ---------------------------------------------------------------------------

let hasRunInProcess = false;

/**
 * Run {@link importLegacyFlatAnthropicKey} at most once per Node process.
 *
 * Fire-and-forget: the credentials resolver is synchronous, but the import
 * is async (the credential-store API is async). Callers MUST NOT await
 * this — the helper is fully idempotent and the marker / pool-entry checks
 * ensure later invocations observe the imported entry without re-running.
 *
 * Errors are caught and dropped on the floor (the underlying helper already
 * logs through the structured logger). Returning a no-op promise keeps the
 * call site uniform with {@link ensureGlobalConfigMigrated} from
 * `global-config-migration.ts`.
 *
 * Wired into `resolveCredentials()` so a stale install gets its legacy flat
 * key promoted into the credential pool on first credentials read.
 *
 * Use {@link _resetLegacyFlatKeyImportLatch} in tests to re-arm the latch.
 *
 * @public
 * @task T9407
 */
export function ensureLegacyFlatAnthropicKeyImported(): void {
  if (hasRunInProcess) return;
  hasRunInProcess = true;
  // Fire-and-forget. The helper never throws, but the await chain could in
  // theory propagate a logger error; swallow defensively so a wedge here can
  // never break credential resolution.
  importLegacyFlatAnthropicKey().catch(() => {
    // Already logged in `importLegacyFlatAnthropicKey()` — drop silently.
  });
}

/**
 * Reset the in-process import latch. Test-only — use in `beforeEach` so each
 * test re-runs the import with its own fresh `CLEO_HOME` / `XDG_DATA_HOME`
 * overrides.
 *
 * @internal
 * @task T9407
 */
export function _resetLegacyFlatKeyImportLatch(): void {
  hasRunInProcess = false;
}
