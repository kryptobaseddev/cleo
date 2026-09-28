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
 * Only a `pass` is ever written. A failure, an error or a timeout is not a
 * reusable fact about the tree — it is the thing the next run exists to change —
 * so it is never cached, and in particular never read back as a pass.
 *
 * Only process-executing kinds (`test`, `command`, `lint`) are cacheable. `file`
 * gates are cheap reads, `http` gates observe a service rather than the tree,
 * and `manual` gates never execute.
 *
 * @task T12621
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { AcceptanceGate, AcceptanceGateResult } from '@cleocode/contracts';
import { acceptanceGateResultSchema } from '@cleocode/contracts';
import { acItemToText } from './ac-table.js';
import { captureDirtyFingerprint, captureHead } from './tool-cache.js';

/** Schema version of an on-disk gate cache entry; bump to invalidate every entry. */
const GATE_CACHE_SCHEMA_VERSION = 1;

/** Gate kinds whose pass can be reused for an unchanged tree. */
const CACHEABLE_GATE_KINDS: ReadonlySet<AcceptanceGate['kind']> = new Set([
  'test',
  'command',
  'lint',
]);

/** On-disk shape of one cached typed-gate pass. */
interface GateCacheEntry {
  schemaVersion: typeof GATE_CACHE_SCHEMA_VERSION;
  key: string;
  gateHash: string;
  head: string;
  dirtyFingerprint: string;
  cwd: string;
  inputsHash: string;
  recordedAt: string;
  /** The observed runner result, without its batch position or binding. */
  result: Omit<AcceptanceGateResult, 'index' | 'binding'>;
}

/**
 * Repo state a batch of gates is keyed against. Captured once per batch.
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

function gateCachePath(projectRoot: string, key: string): string {
  return join(projectRoot, '.cleo', 'cache', 'evidence', `gate-${key}.json`);
}

/**
 * Read a cached pass for a gate against the captured repo state.
 * @param projectRoot - Project whose `.cleo/cache/evidence/` holds the entry.
 * @param gate - Gate definition; any change to it changes the key.
 * @param state - Repo state from {@link captureGateCacheState}.
 * @param inputsHash - Digest of the captured invocation and input artifacts.
 * @returns The cached passing result, or `null` on a miss or an unusable entry.
 * @remarks A hit is re-dated to now (`checkedAt`) and its evidence names the
 * original run: the key proves the definition, tree and inputs are identical,
 * so the reuse is itself the check, and a result bound by the caller can never
 * appear to precede its own input capture.
 * @example
 * ```typescript
 * const hit = state ? readCachedGatePass(root, gate, state, inputsHash) : null;
 * ```
 * @task T12621
 */
export function readCachedGatePass(
  projectRoot: string,
  gate: AcceptanceGate,
  state: GateCacheState,
  inputsHash: string,
): Omit<AcceptanceGateResult, 'index' | 'binding'> | null {
  if (!isCacheableGate(gate)) return null;
  const key = gateCacheKey(gate, state, inputsHash);
  const path = gateCachePath(projectRoot, key);
  if (!existsSync(path)) return null;
  try {
    const entry = JSON.parse(readFileSync(path, 'utf-8')) as Partial<GateCacheEntry>;
    if (
      entry.schemaVersion !== GATE_CACHE_SCHEMA_VERSION ||
      entry.key !== key ||
      entry.gateHash !== gateHash(gate) ||
      entry.head !== state.head ||
      entry.dirtyFingerprint !== state.dirtyFingerprint ||
      entry.cwd !== state.cwd ||
      entry.inputsHash !== inputsHash ||
      !entry.result
    )
      return null;
    // Re-parse through the canonical schema: a hand-edited or truncated entry
    // is a miss, and nothing other than a pass is ever served.
    const result = acceptanceGateResultSchema.parse({ ...entry.result, index: 0 });
    if (result.result !== 'pass' || result.kind !== gate.kind || result.req !== gate.req)
      return null;
    const { index: _index, binding: _binding, ...observed } = result;
    const note = `cached pass from ${observed.checkedAt}, not re-executed (T12621)`;
    return {
      ...observed,
      evidence: observed.evidence ? `${note}\n${observed.evidence}` : note,
      checkedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * Record a gate's observed result. Anything but a `pass` is ignored.
 * @param projectRoot - Project whose `.cleo/cache/evidence/` receives the entry.
 * @param gate - Gate definition the result was observed for.
 * @param state - Repo state captured BEFORE the gate executed.
 * @param inputsHash - Digest of the invocation and inputs captured BEFORE the gate executed.
 * @param result - The runner's observed result.
 * @example
 * ```typescript
 * if (state) writeCachedGateResult(root, gate, state, inputsHash, observed);
 * ```
 * @task T12621
 */
export function writeCachedGateResult(
  projectRoot: string,
  gate: AcceptanceGate,
  state: GateCacheState,
  inputsHash: string,
  result: AcceptanceGateResult,
): void {
  if (!isCacheableGate(gate) || result.result !== 'pass') return;
  const key = gateCacheKey(gate, state, inputsHash);
  const { index: _index, binding: _binding, ...observed } = result;
  const entry: GateCacheEntry = {
    schemaVersion: GATE_CACHE_SCHEMA_VERSION,
    key,
    gateHash: gateHash(gate),
    head: state.head,
    dirtyFingerprint: state.dirtyFingerprint,
    cwd: state.cwd,
    inputsHash,
    recordedAt: new Date().toISOString(),
    result: observed,
  };
  const finalPath = gateCachePath(projectRoot, key);
  try {
    mkdirSync(dirname(finalPath), { recursive: true });
    const tmpPath = `${finalPath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(entry, null, 2), 'utf-8');
    renameSync(tmpPath, finalPath);
  } catch {
    // A cache is an optimisation: failing to persist one never fails the gate.
  }
}
