/**
 * Per-checkout nonce — the only evidence that proves a project MOVED
 * (T12470 · ADR-094).
 *
 * `.cleo/project-id` is committed, so a clone, a fork or a hostile copy of the
 * file declares a registered project's id. Git state is no better: a clone has
 * the same root commit and remote, a bare `git init` can add any remote, and a
 * root commit can be faked with `refs/replace`. What a clone can NOT have is
 * local, untracked state. This module keeps a random nonce in the checkout's
 * `.cleo/project-info.json` — never tracked (ADR-013 §9) — and the registry
 * records it on each confirmed location. A real `mv`, or a restore of `.cleo/`
 * from a backup, carries the nonce with it; a clone has none, or its own.
 *
 * @task T12470
 * @module nexus/checkout-nonce
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** `project-info.json` field that carries the nonce. */
export const CHECKOUT_NONCE_FIELD = 'checkoutNonce';

/** Accepted nonce shape: 32 lowercase hex characters (128 random bits). */
const NONCE_PATTERN = /^[0-9a-f]{32}$/;

/** Parse `<root>/.cleo/project-info.json`; `null` when absent or unparseable. */
function readInfo(projectRoot: string): Record<string, unknown> | null {
  const path = join(projectRoot, '.cleo', 'project-info.json');
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Read the checkout's nonce.
 *
 * @param projectRoot - Checkout root (the directory containing `.cleo/`).
 * @returns The nonce, or `null` when the checkout has none.
 *
 * @example
 * ```ts
 * const nonce = readCheckoutNonce(root);
 * ```
 */
export function readCheckoutNonce(projectRoot: string): string | null {
  const value = readInfo(projectRoot)?.[CHECKOUT_NONCE_FIELD];
  return typeof value === 'string' && NONCE_PATTERN.test(value) ? value : null;
}

/**
 * Mint a fresh nonce without writing it anywhere.
 *
 * A checkout CLEO copies (`cleo project move`, T12556) must not carry its
 * source's nonce, or the copy is indistinguishable from the original after
 * either one is later moved by hand. The copy's writer stamps this instead.
 *
 * @returns 32 lowercase hex characters (128 random bits).
 *
 * @example
 * ```ts
 * const info = { ...sourceInfo, [CHECKOUT_NONCE_FIELD]: mintCheckoutNonce() };
 * ```
 */
export function mintCheckoutNonce(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Return the checkout's nonce, minting one into `project-info.json` when the
 * file exists and has none. Called only when a location is CONFIRMED, so a
 * candidate never gains a nonce the registry would accept.
 *
 * Never creates `project-info.json`: a checkout without one (a fresh clone
 * before `cleo init`) has no nonce, and its moves are confirmed explicitly.
 *
 * @param projectRoot - Checkout root.
 * @returns The nonce, or `null` when there is no `project-info.json` to hold it.
 *
 * @example
 * ```ts
 * const nonce = ensureCheckoutNonce(root);
 * ```
 */
export function ensureCheckoutNonce(projectRoot: string): string | null {
  const existing = readCheckoutNonce(projectRoot);
  if (existing) return existing;
  const info = readInfo(projectRoot);
  if (!info) return null;
  const nonce = mintCheckoutNonce();
  const path = join(projectRoot, '.cleo', 'project-info.json');
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ ...info, [CHECKOUT_NONCE_FIELD]: nonce }, null, 2)}\n`);
  renameSync(temp, path);
  return nonce;
}
