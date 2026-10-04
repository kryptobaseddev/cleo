/**
 * Result cache for typed acceptance gates (T12621 · ADR-061).
 *
 * `tool:` evidence atoms have been cached since T1534; typed gates were not, so
 * `cleo verify <id> --run` followed by the attesting `cleo verify <id> --gate …`
 * executed a slow suite twice, and a retry after any unrelated failure executed
 * it a third time. This module gives typed gates the same content-addressed
 * cache, in the same directory (`.cleo/cache/evidence/`, `gate-` prefix).
 *
 * The key is `(gate definition hash, git HEAD, dirty-tree fingerprint, cwd,
 * inputs digest)`. HEAD and the fingerprint come from the exact helpers the tool
 * cache uses, so every tracked byte is unchanged on a hit. The inputs digest
 * covers what the fingerprint cannot: the captured invocation (including its
 * environment hash) and the bytes of every input the verifier binds — untracked
 * harness scripts and task files included. Like the tool cache, a directory that
 * is not a git checkout gets no caching at all rather than one answer forever
 * (gh#1419).
 *
 * NOT in the key (the gh#1221 trade-off, stated rather than hidden): modules an
 * untracked harness imports, `node_modules`, and an in-place toolchain upgrade.
 * A reused pass is therefore always marked `source: 'cache'` on the result and
 * on the receipt, and `evidence.allowCachedGates: false` in
 * `.cleo/project-context.json` turns reuse off and makes completion refuse it.
 *
 * ## Authentication
 *
 * Entries are plain JSON in the project, and every key input is public, so an
 * unauthenticated entry is a forgeable pass. Each entry therefore carries an
 * HMAC-SHA256 under a per-machine key at `<cleoHome>/keys/evidence-cache.key`
 * (created `0600` on first use, outside every project and worktree). An entry
 * whose MAC does not verify is never served. This module can VERIFY an entry
 * given the key; only the gate runner can create one, from a result it executed
 * itself, and nothing exported from core loads the key. The key defends against
 * hand-written, tampered and copied entries; it cannot defend against a process
 * that reads the key file directly with the user's own privileges.
 *
 * Only a `pass` is ever written. A failure, an error or a timeout is not a
 * reusable fact about the tree — it is the thing the next run exists to change.
 * Only process-executing kinds (`test`, `command`, `lint`) are cacheable.
 *
 * @task T12621
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AcceptanceGate, AcceptanceGateResult } from '@cleocode/contracts';
import { acceptanceGateResultSchema } from '@cleocode/contracts/acceptance-gate-schema.js';
import { getCleoHome } from '../paths.js';
import { acItemToText } from './ac-table.js';
import { captureDirtyFingerprint, captureHead } from './tool-cache.js';

/** Schema version of an on-disk gate cache entry; bump to invalidate every entry. */
export const GATE_CACHE_SCHEMA_VERSION = 2;

/** Gate kinds whose pass can be reused for an unchanged tree. */
const CACHEABLE_GATE_KINDS: ReadonlySet<AcceptanceGate['kind']> = new Set([
  'test',
  'command',
  'lint',
]);

/** The observed runner result as stored, without batch position, binding or provenance. */
export type CachedGateObservation = Omit<
  AcceptanceGateResult,
  'index' | 'binding' | 'source' | 'cachedAt'
>;

/** On-disk shape of one cached typed-gate pass, before its MAC. */
export interface GateCacheEntryBody {
  schemaVersion: typeof GATE_CACHE_SCHEMA_VERSION;
  key: string;
  gateHash: string;
  head: string;
  dirtyFingerprint: string;
  cwd: string;
  inputsHash: string;
  /** When the gate actually executed and the entry was sealed. */
  createdAt: string;
  result: CachedGateObservation;
}

/** On-disk shape of one sealed entry. */
export interface GateCacheEntry extends GateCacheEntryBody {
  /** HMAC-SHA256 (hex) of {@link gateCacheEntryMacPayload} under the machine key. */
  mac: string;
}

/**
 * Repo state a batch of gates is keyed against.
 *
 * `null` when the directory is not a git checkout: such a tree has no content
 * fingerprint, so nothing is read from or written to the cache.
 */
export interface GateCacheState {
  /** Git HEAD sha of the execution root. */
  head: string;
  /** sha256 of the tracked uncommitted changes (see `captureDirtyFingerprint`). */
  dirtyFingerprint: string;
  /** Symlink-resolved execution root. */
  cwd: string;
}

/** Outcome of looking a gate up in the cache. */
export type GateCacheLookup =
  | { status: 'hit'; observation: CachedGateObservation; createdAt: string }
  | { status: 'miss' }
  | { status: 'invalid'; reason: string };

/**
 * Whether a gate kind's pass may be served from the cache.
 * @param gate - Gate to classify.
 * @returns `true` for `test`, `command` and `lint` gates.
 * @example
 * ```typescript
 * isCacheableGate({ kind: 'manual', description: 'look', prompt: 'ok?' }); // false
 * ```
 * @task T12621
 */
export function isCacheableGate(gate: AcceptanceGate): boolean {
  return CACHEABLE_GATE_KINDS.has(gate.kind);
}

/**
 * Capture the repo state gate cache keys are computed against.
 * @param projectRoot - Directory the gates execute in.
 * @returns The state, or `null` when the directory is not a git checkout.
 * @example
 * ```typescript
 * const state = await captureGateCacheState('/project');
 * ```
 * @task T12621
 */
export async function captureGateCacheState(projectRoot: string): Promise<GateCacheState | null> {
  const head = await captureHead(projectRoot);
  if (!head) return null;
  const dirtyFingerprint = await captureDirtyFingerprint(projectRoot);
  if (!dirtyFingerprint) return null;
  let cwd: string;
  try {
    cwd = realpathSync(projectRoot);
  } catch {
    cwd = resolve(projectRoot);
  }
  return { head, dirtyFingerprint, cwd };
}

function gateHash(gate: AcceptanceGate): string {
  return createHash('sha256').update(acItemToText(gate)).digest('hex');
}

function gateCacheKey(gate: AcceptanceGate, state: GateCacheState, inputsHash: string): string {
  return createHash('sha256')
    .update(
      JSON.stringify([gateHash(gate), state.head, state.dirtyFingerprint, state.cwd, inputsHash]),
    )
    .digest('hex')
    .slice(0, 32);
}

/**
 * Absolute path of the cache entry for a gate against a repo state.
 * @param projectRoot - Project whose `.cleo/cache/evidence/` holds the entry.
 * @param gate - Gate definition.
 * @param state - Repo state from {@link captureGateCacheState}.
 * @param inputsHash - Digest of the captured invocation and input artifacts.
 * @returns The entry path (which may not exist).
 * @example
 * ```typescript
 * const path = gateCacheEntryPath(root, gate, state, inputsHash);
 * ```
 * @task T12621
 */
export function gateCacheEntryPath(
  projectRoot: string,
  gate: AcceptanceGate,
  state: GateCacheState,
  inputsHash: string,
): string {
  return join(
    projectRoot,
    '.cleo',
    'cache',
    'evidence',
    `gate-${gateCacheKey(gate, state, inputsHash)}.json`,
  );
}

/**
 * Path of the per-machine key that authenticates evidence cache entries.
 * @returns `<cleoHome>/keys/evidence-cache.key`.
 * @example
 * ```typescript
 * evidenceCacheKeyPath(); // ~/.local/share/cleo/keys/evidence-cache.key
 * ```
 * @task T12621
 */
export function evidenceCacheKeyPath(): string {
  return join(getCleoHome(), 'keys', 'evidence-cache.key');
}

/**
 * Build the unsealed entry body for an observed pass.
 * @param gate - Gate the result was observed for.
 * @param state - Repo state captured BEFORE the gate executed.
 * @param inputsHash - Inputs digest captured BEFORE the gate executed.
 * @param result - The runner's observed result.
 * @returns The body to seal, or `null` for anything but a cacheable pass.
 * @example
 * ```typescript
 * const body = buildGateCacheEntryBody(gate, state, inputsHash, observed);
 * ```
 * @task T12621
 */
export function buildGateCacheEntryBody(
  gate: AcceptanceGate,
  state: GateCacheState,
  inputsHash: string,
  result: AcceptanceGateResult,
): GateCacheEntryBody | null {
  if (!isCacheableGate(gate) || result.result !== 'pass') return null;
  const {
    index: _index,
    binding: _binding,
    source: _source,
    cachedAt: _cachedAt,
    ...observed
  } = result;
  return {
    schemaVersion: GATE_CACHE_SCHEMA_VERSION,
    key: gateCacheKey(gate, state, inputsHash),
    gateHash: gateHash(gate),
    head: state.head,
    dirtyFingerprint: state.dirtyFingerprint,
    cwd: state.cwd,
    inputsHash,
    createdAt: new Date().toISOString(),
    result: observed,
  };
}

/**
 * Canonical bytes an entry's MAC covers: every body field, in a fixed order.
 * @param body - Entry body (a `mac` field, if present, is ignored).
 * @returns The string to MAC.
 * @example
 * ```typescript
 * const payload = gateCacheEntryMacPayload(body);
 * ```
 * @task T12621
 */
export function gateCacheEntryMacPayload(body: GateCacheEntryBody): string {
  return JSON.stringify([
    body.schemaVersion,
    body.key,
    body.gateHash,
    body.head,
    body.dirtyFingerprint,
    body.cwd,
    body.inputsHash,
    body.createdAt,
    body.result,
  ]);
}

function macOf(body: GateCacheEntryBody, key: Buffer): string {
  return createHmac('sha256', key).update(gateCacheEntryMacPayload(body)).digest('hex');
}

/**
 * Seal an entry body with the machine key.
 * @param body - Entry body from {@link buildGateCacheEntryBody}.
 * @param key - Machine key; the caller is the only holder.
 * @returns The sealed entry.
 * @example
 * ```typescript
 * const entry = sealGateCacheEntry(body, key);
 * ```
 * @task T12621
 */
export function sealGateCacheEntry(body: GateCacheEntryBody, key: Buffer): GateCacheEntry {
  return { ...body, mac: macOf(body, key) };
}

/**
 * Look a gate up in the cache and authenticate what is found.
 * @param projectRoot - Project whose `.cleo/cache/evidence/` holds the entry.
 * @param gate - Gate definition; any change to it changes the key.
 * @param state - Repo state from {@link captureGateCacheState}.
 * @param inputsHash - Digest of the captured invocation and input artifacts.
 * @param key - Machine key the entry must be sealed under.
 * @returns `hit` with the observation, `miss` when there is no entry, or
 * `invalid` when an entry exists but is unauthenticated, tampered or not a pass.
 * @example
 * ```typescript
 * const lookup = readGateCacheEntry(root, gate, state, inputsHash, key);
 * ```
 * @task T12621
 */
export function readGateCacheEntry(
  projectRoot: string,
  gate: AcceptanceGate,
  state: GateCacheState,
  inputsHash: string,
  key: Buffer,
): GateCacheLookup {
  if (!isCacheableGate(gate)) return { status: 'miss' };
  const path = gateCacheEntryPath(projectRoot, gate, state, inputsHash);
  if (!existsSync(path)) return { status: 'miss' };
  let entry: Partial<GateCacheEntry>;
  try {
    entry = JSON.parse(readFileSync(path, 'utf-8')) as Partial<GateCacheEntry>;
  } catch {
    return { status: 'invalid', reason: 'entry is not readable JSON' };
  }
  if (
    entry.schemaVersion !== GATE_CACHE_SCHEMA_VERSION ||
    entry.key !== gateCacheKey(gate, state, inputsHash) ||
    entry.gateHash !== gateHash(gate) ||
    entry.head !== state.head ||
    entry.dirtyFingerprint !== state.dirtyFingerprint ||
    entry.cwd !== state.cwd ||
    entry.inputsHash !== inputsHash ||
    typeof entry.createdAt !== 'string' ||
    !entry.result ||
    typeof entry.mac !== 'string'
  )
    return { status: 'invalid', reason: 'entry is unsealed or describes another gate or tree' };
  const expected = Buffer.from(macOf(entry as GateCacheEntryBody, key), 'hex');
  const actual = Buffer.from(entry.mac, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    return { status: 'invalid', reason: 'entry MAC does not verify under this machine key' };
  try {
    const result = acceptanceGateResultSchema.parse({ ...entry.result, index: 0 });
    if (result.result !== 'pass' || result.kind !== gate.kind || result.req !== gate.req)
      return { status: 'invalid', reason: 'entry is not a pass for this gate' };
    const {
      index: _index,
      binding: _binding,
      source: _source,
      cachedAt: _cachedAt,
      ...observation
    } = result;
    return { status: 'hit', observation, createdAt: entry.createdAt };
  } catch {
    return { status: 'invalid', reason: 'entry result is malformed' };
  }
}

/**
 * Project policy: may a typed gate pass be reused from the cache?
 *
 * Reads `evidence.allowCachedGates` from `.cleo/project-context.json` with a
 * bare read, like `evidence.gitRoot`. Only an explicit `false` disables reuse.
 *
 * @param projectRoot - CLEO store root holding `.cleo/`.
 * @returns `false` only when the project declares `evidence.allowCachedGates: false`.
 * @example
 * ```typescript
 * if (!readAllowCachedGates(root)) cache = 'off';
 * ```
 * @task T12621
 */
export function readAllowCachedGates(projectRoot: string): boolean {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(projectRoot, '.cleo', 'project-context.json'), 'utf-8'),
    );
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return true;
    const evidence = (parsed as { evidence?: unknown }).evidence;
    if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)) return true;
    return (evidence as { allowCachedGates?: unknown }).allowCachedGates !== false;
  } catch {
    return true;
  }
}
