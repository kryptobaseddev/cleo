/**
 * Federation index storage — per-user list of trusted federation peers.
 *
 * Persists to `~/.cleo/federation.json` (operator-managed, plain JSON, no
 * SQLite). The format is intentionally simple so the operator can hand-edit
 * the file when needed without booting CLEO.
 *
 * ## Wire shape
 *
 * ```json
 * {
 *   "version": 1,
 *   "entries": [
 *     { "url": "https://peer.example/", "trust": "verified", "addedAt": "2026-05-18T..." }
 *   ]
 * }
 * ```
 *
 * Validation invariants enforced by {@link addFederationPeer}:
 *
 *   1. `url` MUST parse as `http://` or `https://` — other schemes rejected.
 *   2. `trust` MUST be one of `'verified' | 'unverified' | 'blocked'`.
 *   3. URLs are normalised (lowercase scheme + host, trailing slash) so
 *      `add` is idempotent regardless of casing / trailing-slash variance.
 *
 * @task T9729
 * @epic T9571
 * @saga T9560
 * @architecture docs/architecture/SG-CLEO-SKILLS-architecture-v3.md §9 (federation)
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Trust level associated with a federation peer.
 *
 * - `'verified'`   — peer has passed handshake / signature validation.
 * - `'unverified'` — peer added without verification (default for `add`).
 * - `'blocked'`    — peer explicitly denied; never resolved by lookups.
 */
export type FederationTrustLevel = 'verified' | 'unverified' | 'blocked';

/**
 * One entry in the federation index.
 *
 * `url` is the canonical (normalised) form — see {@link normaliseFederationUrl}.
 */
export interface FederationEntry {
  /** Normalised peer URL (always trailing-slashed, lowercase scheme/host). */
  readonly url: string;
  /** Operator-assigned trust level — see {@link FederationTrustLevel}. */
  readonly trust: FederationTrustLevel;
  /** ISO-8601 timestamp when the entry was added. */
  readonly addedAt: string;
}

/**
 * On-disk shape of `~/.cleo/federation.json`.
 *
 * `version` is bumped on incompatible schema changes; readers MUST refuse
 * to parse a higher version than they understand.
 */
export interface FederationIndex {
  /** Schema version — currently `1`. */
  readonly version: 1;
  /** All known peers, ordered by `url` ascending. */
  readonly entries: readonly FederationEntry[];
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Return the canonical filesystem path for the federation index.
 *
 * Always `~/.cleo/federation.json` — NOT the XDG `getCleoHome()` path,
 * because federation peers are explicitly operator-managed and the simple
 * `~/.cleo` location lets the user hand-edit without spelunking through
 * `~/.local/share`.
 *
 * @task T9729
 */
export function getFederationIndexPath(): string {
  return join(homedir(), '.cleo', 'federation.json'); // path-drift-allowed: operator-managed file deliberately at ~/.cleo, NOT XDG getCleoHome() (T9729)
}

// ---------------------------------------------------------------------------
// URL normalisation + validation
// ---------------------------------------------------------------------------

/**
 * Normalise a peer URL into the canonical on-disk form.
 *
 * Rules:
 *   - Scheme + host lowercased.
 *   - Default port stripped when it matches the scheme default.
 *   - Path canonicalised; trailing `/` always present.
 *   - Query string + fragment dropped (federation URLs don't carry them).
 *
 * @param raw - Caller-supplied URL string.
 * @returns The canonical form.
 * @throws {Error} If `raw` does not parse as a valid `http(s)://` URL.
 *
 * @task T9729
 */
export function normaliseFederationUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid federation URL: ${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Federation URL must use http:// or https:// — got "${parsed.protocol}" in "${raw}"`,
    );
  }
  parsed.hash = '';
  parsed.search = '';
  // Force trailing slash on the path so "https://peer" and "https://peer/"
  // resolve to the same entry.
  if (!parsed.pathname.endsWith('/')) parsed.pathname += '/';
  return parsed.toString();
}

const VALID_TRUST_LEVELS: readonly FederationTrustLevel[] = ['verified', 'unverified', 'blocked'];

/**
 * Validate that `value` is one of the {@link FederationTrustLevel} literals.
 *
 * @param value - Anything (typically user input from the CLI).
 * @throws {Error} If `value` is not a recognised trust level.
 */
export function assertTrustLevel(value: unknown): asserts value is FederationTrustLevel {
  if (typeof value !== 'string' || !(VALID_TRUST_LEVELS as readonly string[]).includes(value)) {
    throw new Error(
      `Trust level must be one of: ${VALID_TRUST_LEVELS.join(', ')} — got ${JSON.stringify(value)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------

/**
 * Read the federation index from disk.
 *
 * Returns a fresh empty index when the file does not exist (first-run case).
 * Throws on JSON parse errors or schema-version mismatches — the operator
 * SHOULD see those loudly so corrupted state is not silently overwritten.
 *
 * @param path - Optional override (defaults to {@link getFederationIndexPath}).
 * @returns The validated index.
 *
 * @task T9729
 */
export function readFederationIndex(path?: string): FederationIndex {
  const resolved = path ?? getFederationIndexPath();
  if (!existsSync(resolved)) {
    return { version: 1, entries: [] };
  }
  const raw = readFileSync(resolved, 'utf8');
  const parsed = JSON.parse(raw) as { version?: unknown; entries?: unknown };
  if (parsed.version !== 1) {
    throw new Error(
      `Federation index at ${resolved} has unsupported version ${String(parsed.version)} (expected 1)`,
    );
  }
  if (!Array.isArray(parsed.entries)) {
    throw new Error(`Federation index at ${resolved} is missing the "entries" array`);
  }
  // Trust the array shape — invariants are enforced on write, not read,
  // so we don't double-validate hot-path reads. If the operator hand-edits
  // garbage in, the next write will overwrite it.
  return { version: 1, entries: parsed.entries as FederationEntry[] };
}

/**
 * Atomically write the federation index to disk.
 *
 * Uses the tmp-then-rename pattern so a crash mid-write never leaves a
 * partial file. The parent directory (`~/.cleo`) is created on demand.
 *
 * @param index - The index to persist.
 * @param path - Optional override (defaults to {@link getFederationIndexPath}).
 *
 * @task T9729
 */
export function writeFederationIndex(index: FederationIndex, path?: string): void {
  const resolved = path ?? getFederationIndexPath();
  const dir = dirname(resolved);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${resolved}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(index, null, 2)}\n`, { encoding: 'utf8' });
  // Synchronous rename is atomic on POSIX + recent Node Windows.
  renameSync(tmp, resolved);
}

// ---------------------------------------------------------------------------
// High-level operations (used by the CLI command)
// ---------------------------------------------------------------------------

/**
 * Result of {@link addFederationPeer}.
 */
export interface AddFederationResult {
  /** The entry as persisted (post-normalisation). */
  readonly entry: FederationEntry;
  /** `true` when the URL was already present and only the trust level changed. */
  readonly updated: boolean;
}

/**
 * Add (or update) a federation peer.
 *
 * Idempotent on `url` — calling twice with the same normalised URL updates
 * the existing entry's `trust` and leaves `addedAt` unchanged. Returns
 * `updated: true` in that case.
 *
 * @param url   - Caller-supplied URL (will be normalised).
 * @param trust - Trust level — defaults to `'unverified'`.
 * @param path  - Optional override of the index file location (test hook).
 * @returns The persisted entry and a flag indicating insert-vs-update.
 *
 * @task T9729
 */
export function addFederationPeer(
  url: string,
  trust: FederationTrustLevel = 'unverified',
  path?: string,
): AddFederationResult {
  assertTrustLevel(trust);
  const normalised = normaliseFederationUrl(url);
  const index = readFederationIndex(path);

  const existing = index.entries.find((e) => e.url === normalised);
  const now = new Date().toISOString();

  const nextEntries: FederationEntry[] = existing
    ? index.entries.map((e) =>
        e.url === normalised ? { url: e.url, trust, addedAt: e.addedAt } : e,
      )
    : [...index.entries, { url: normalised, trust, addedAt: now }];

  // Stable sort by URL ascending for deterministic on-disk diffs.
  nextEntries.sort((a, b) => a.url.localeCompare(b.url));

  writeFederationIndex({ version: 1, entries: nextEntries }, path);
  const persisted = nextEntries.find((e) => e.url === normalised);
  if (!persisted) {
    /* c8 ignore next */
    throw new Error(`addFederationPeer: entry for ${normalised} vanished after write`);
  }
  return { entry: persisted, updated: !!existing };
}

/**
 * Remove a federation peer by URL.
 *
 * @param url  - Caller-supplied URL (will be normalised before lookup).
 * @param path - Optional override of the index file location (test hook).
 * @returns `true` when a row was removed; `false` when the URL was unknown.
 *
 * @task T9729
 */
export function removeFederationPeer(url: string, path?: string): boolean {
  const normalised = normaliseFederationUrl(url);
  const index = readFederationIndex(path);
  const next = index.entries.filter((e) => e.url !== normalised);
  if (next.length === index.entries.length) return false;
  writeFederationIndex({ version: 1, entries: next }, path);
  return true;
}

/**
 * List all federation peers.
 *
 * @param path - Optional override of the index file location (test hook).
 * @returns Entries in canonical sort order (by URL ascending).
 *
 * @task T9729
 */
export function listFederationPeers(path?: string): readonly FederationEntry[] {
  return readFederationIndex(path).entries;
}
