/**
 * Detected provider capabilities and the last usage read, cached per base URL
 * in `<cleoHome>/decide/provider-state.json` (T12664).
 *
 * Detection (`detectJevCapabilities`) calls `GET /v1/usage` and
 * `GET /v1/templates`, both of which count toward the provider's rate limit,
 * so `cleo decide status` refreshes this file at most once every
 * {@link USAGE_REFRESH_MS}. The client reads it (memoised per process) to
 * know which extensions the configured provider supports; with no file, or a
 * file for another base URL, the provider is treated as the Jev minimum.
 *
 * @task T12664
 * @epic T12486
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DecisionProviderCapabilities, DecisionProviderUsage } from '@cleocode/contracts';
import { getCleoHome } from '@cleocode/paths';

/** Minimum interval between usage/capability refreshes: 10 minutes. */
export const USAGE_REFRESH_MS = 10 * 60 * 1000;

/** How long the client trusts its in-process copy of the file. */
const MEMO_MS = 60_000;

/** One cached provider state. */
export interface ProviderState {
  /** Base URL the state was detected for. */
  readonly baseUrl: string;
  /** Epoch ms of the detection. */
  readonly detectedAt: number;
  /** Detected capabilities. */
  readonly capabilities: DecisionProviderCapabilities;
  /** Usage read at detection time, when the provider has a usage endpoint. */
  readonly usage?: DecisionProviderUsage;
}

/**
 * Default location: `<cleoHome>/decide/provider-state.json`.
 *
 * @returns Absolute path.
 */
export function defaultProviderStatePath(): string {
  return join(getCleoHome(), 'decide', 'provider-state.json');
}

/** Structural check of a parsed state; anything else is ignored. */
function isProviderState(value: unknown): value is ProviderState {
  if (value === null || typeof value !== 'object') return false;
  const baseUrl: unknown = Reflect.get(value, 'baseUrl');
  const detectedAt: unknown = Reflect.get(value, 'detectedAt');
  const capabilities: unknown = Reflect.get(value, 'capabilities');
  return (
    typeof baseUrl === 'string' &&
    typeof detectedAt === 'number' &&
    capabilities !== null &&
    typeof capabilities === 'object' &&
    typeof Reflect.get(capabilities, 'wire') === 'string' &&
    typeof Reflect.get(capabilities, 'maxQuestionsPerRequest') === 'number' &&
    typeof Reflect.get(capabilities, 'maxStateChars') === 'number'
  );
}

/**
 * Read the cached state for `baseUrl`.
 *
 * @param baseUrl - The configured provider base URL.
 * @param path - State file. Default {@link defaultProviderStatePath}.
 * @returns The state, or `null` when absent, unreadable or for another URL.
 */
export function readProviderState(
  baseUrl: string,
  path = defaultProviderStatePath(),
): ProviderState | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    return isProviderState(parsed) && parsed.baseUrl === baseUrl ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Write the cached state (atomic rename). Never throws.
 *
 * @param state - State to store.
 * @param path - State file. Default {@link defaultProviderStatePath}.
 */
export function writeProviderState(state: ProviderState, path = defaultProviderStatePath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), 'utf-8');
    renameSync(tmp, path);
    memo = null;
  } catch {
    /* best effort: the next status run detects again */
  }
}

let memo: {
  readonly baseUrl: string;
  readonly at: number;
  readonly caps: DecisionProviderCapabilities | null;
} | null = null;

/**
 * Capabilities the client may use for `baseUrl`, memoised per process for a
 * minute so the hot path does not read the file on every decision.
 *
 * @param baseUrl - The configured provider base URL.
 * @param now - Clock, epoch ms.
 * @returns Detected capabilities, or `null` (→ the Jev minimum).
 */
export function cachedCapabilities(
  baseUrl: string,
  now: number = Date.now(),
): DecisionProviderCapabilities | null {
  if (memo && memo.baseUrl === baseUrl && now - memo.at < MEMO_MS) return memo.caps;
  const caps = readProviderState(baseUrl)?.capabilities ?? null;
  memo = { baseUrl, at: now, caps };
  return caps;
}

/**
 * Clear the in-process memo. Tests only.
 *
 * @internal
 */
export function _resetProviderStateMemoForTest(): void {
  memo = null;
}
