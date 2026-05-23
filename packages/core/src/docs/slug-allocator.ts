/**
 * Central slug allocator chokepoint for the docs SSoT.
 *
 * ## Why this module exists
 *
 * Before this module, slug uniqueness was enforced LATE — inside the BEGIN
 * IMMEDIATE transaction at {@link
 * https://github.com/kryptobaseddev/cleocode/blob/main/packages/core/src/store/attachment-store.ts
 * | `attachmentStore.put`} via a `SELECT ... WHERE slug = ?` probe and the
 * `uniq_attachments_slug` partial UNIQUE INDEX. Both writers
 * (`cleo docs add`, `cleo changeset add`) reached the constraint through
 * different code paths and surfaced the same conflict through DIFFERENT
 * envelopes. T10294 (PR #576) RCA classified this as the slug-collision class
 * — see Decision option (c): collapse writers AND introduce a chokepoint
 * allocator. This module is the allocator half. The writer-collapse half is
 * delivered by T10386 / T10388 / T10393.
 *
 * ## Contract
 *
 * Every writer that intends to assign a slug to an attachment row MUST
 * call {@link reserveSlug} BEFORE invoking `attachmentStore.put({ slug })`.
 * The allocator:
 *
 *   1. Normalises the slug to canonical kebab-case (lowercase, single
 *      hyphens, trimmed).
 *   2. Acquires an in-process per-slug Mutex so concurrent reservations
 *      for the same slug serialise.
 *   3. Probes the DB for an existing row with the normalised slug.
 *   4. If free, records the slug in an in-process "reserved" set and
 *      returns `{ ok: true, normalizedSlug }`.
 *   5. If taken, derives 3 suggestions via the shared {@link
 *      ../store/attachment-store.deriveSlugSuggestions} helper (so the
 *      suggestion shape matches `SlugCollisionError.suggestions`) and
 *      returns `{ ok: false, code: 'E_SLUG_RESERVED', suggestions }`.
 *
 * `attachmentStore.put` enforces a RUNTIME ASSERT that the slug it is
 * about to write has been reserved by this allocator. A writer that
 * bypasses the chokepoint trips `SlugNotReservedByAllocatorError` —
 * a programmer error that surfaces during dev/CI rather than silent
 * envelope drift in production.
 *
 * The assert is **opt-in via `CLEO_STRICT_SLUG_ALLOCATOR=1`** in this
 * T10392 PR — strict default is flipped on in T10386 / T10388 once
 * both writers (`cleo docs add`, `cleo changeset add`) are wired.
 * Tests in this PR set the env var explicitly to exercise the assert.
 *
 * ## Why in-process Mutex (NOT SQLite advisory locks)
 *
 * `node:sqlite` does not expose `sqlite_set_authorizer` or any equivalent
 * advisory-lock primitive. The two options the council weighed:
 *
 *   (a) SQLite advisory lock via sentinel-row INSERT/DELETE — adds 2
 *       extra round-trips per allocation, leaks rows on crash, and
 *       still needs the in-process Mutex as the same-process backstop.
 *
 *   (b) **In-process `Map<slug, Mutex>` with the SQLite partial UNIQUE
 *       INDEX as the cross-process backstop**.
 *
 * We chose (b) because:
 *   - Within a single CLEO process the Mutex map is sufficient — concurrent
 *     `reserveSlug` calls on the same slug serialise correctly.
 *   - Across processes the `uniq_attachments_slug` partial UNIQUE INDEX
 *     is the hard backstop. A losing process gets a DB-level constraint
 *     violation at `put`-time, which the writer surfaces as the same
 *     `SlugCollisionError` envelope the allocator emits — uniform shape
 *     regardless of which layer caught it.
 *   - CLEO writers are dominated by a SINGLE process at a time (CLI verb
 *     dispatch, sentient daemon, IVTR worker). Cross-process write
 *     contention is rare and the UNIQUE INDEX backstop handles it.
 *
 * ## Lock ordering (deadlock prevention)
 *
 * Per T10392 implementation contract:
 *
 *   1. `reserveSlug` MUST be called BEFORE `withWriteLock` in
 *      `attachmentStore.put`. The allocator holds the per-slug Mutex
 *      only for the duration of its DB probe; it releases BEFORE the
 *      caller acquires the global write lock.
 *
 *   2. The allocator NEVER acquires the global write lock. There is
 *      therefore no chance of deadlock between the per-slug Mutex and
 *      the global write lock.
 *
 *   3. The reserved set is consulted INSIDE `attachmentStore.put` after
 *      the global write lock is acquired — a cheap set lookup, no lock
 *      escalation.
 *
 * ## Global namespace (per E1.5 decision T10390)
 *
 * Slugs are allocated in a GLOBAL namespace across all DocKinds. The
 * `uniq_attachments_slug` partial UNIQUE INDEX (migration
 * `20260519000001`) keys on `slug` alone — NOT `(kind, slug)`. The
 * allocator matches that: `reserveSlug('changeset', 'foo')` followed by
 * `reserveSlug('research', 'foo')` returns `E_SLUG_RESERVED` for the
 * second call. The `kind` argument is retained for future per-kind
 * extensions (and for richer suggestion derivation) but does NOT
 * partition the namespace.
 *
 * @task T10392
 * @epic T10289
 * @saga T10288
 * @adr ADR-076 (canon routing), ADR-083 (Cleo persona)
 */

import type { BuiltinDocKind } from '@cleocode/contracts';
import { deriveSlugSuggestionsForAllocator } from '../store/attachment-store.js';
import { getDb } from '../store/sqlite.js';

// ─── Public surface ───────────────────────────────────────────────────────────

/**
 * Successful reservation outcome — the slug is now reserved in the
 * current process and a subsequent `attachmentStore.put({ slug })` is
 * permitted to write it.
 */
export interface SlugReserveOk {
  readonly ok: true;
  /** The normalised kebab-case form of the input slug. */
  readonly normalizedSlug: string;
}

/**
 * Failed reservation outcome — the slug is already taken in this project.
 *
 * Suggestions are derived via the shared `deriveSlugSuggestions` helper so
 * the shape matches `SlugCollisionError.suggestions`. Always exactly 3.
 */
export interface SlugReserveErr {
  readonly ok: false;
  readonly code: 'E_SLUG_RESERVED';
  /** Exactly 3 free alternative slugs. */
  readonly suggestions: readonly string[];
}

/** Discriminated union returned by {@link reserveSlug}. */
export type SlugReserveResult = SlugReserveOk | SlugReserveErr;

/**
 * Options accepted by {@link reserveSlug}.
 *
 * `cwd` is forwarded to `getDb(cwd)` — same convention used elsewhere in
 * `@cleocode/core` for path resolution.
 */
export interface ReserveSlugOptions {
  /** Optional working directory for `.cleo/` resolution. */
  readonly cwd?: string;
}

// ─── Per-slug Mutex map (in-process serialisation) ────────────────────────────

/**
 * Per-slug Mutex implementation. We model each Mutex as a Promise chain
 * keyed by the normalised slug. Acquiring the lock pushes a new tail
 * onto the chain; releasing resolves the tail so the next waiter runs.
 *
 * The map is keyed by the NORMALISED slug — `Foo-Bar` and `foo-bar`
 * share the same lock. The chain is pruned lazily when the trailing
 * waiter finishes (so the map stays bounded by concurrent contention,
 * not historical usage).
 */
const slugLockChain = new Map<string, Promise<void>>();

/**
 * Acquire the per-slug Mutex. Returns the release callback which the
 * caller MUST invoke (always — try/finally) to let the next waiter
 * proceed.
 *
 * @param normalizedSlug - The kebab-cased slug.
 * @returns Release callback. Idempotent — calling it twice is a no-op.
 */
async function acquireSlugLock(normalizedSlug: string): Promise<() => void> {
  const prev = slugLockChain.get(normalizedSlug) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  slugLockChain.set(normalizedSlug, next);
  await prev;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
    // Prune the map entry if no further waiters chained on after us.
    if (slugLockChain.get(normalizedSlug) === next) {
      slugLockChain.delete(normalizedSlug);
    }
  };
}

// ─── Reserved-slug set (allocator → put handshake) ────────────────────────────

/**
 * Slugs that have been reserved by {@link reserveSlug} in this process and
 * are awaiting a follow-up `attachmentStore.put` call. The set keys on the
 * NORMALISED slug; writers MUST pass the normalised form to `put`.
 *
 * The set is process-local: it does NOT persist across CLI invocations
 * and is NOT visible to other processes. It exists purely so
 * `attachmentStore.put` can detect a writer that bypassed the allocator
 * chokepoint (programmer error → throws `E_SLUG_NOT_RESERVED_BY_ALLOCATOR`).
 *
 * @internal
 */
const reservedSlugs = new Set<string>();

/**
 * Check whether the allocator has reserved `slug` in this process.
 *
 * Exported for use by `attachmentStore.put` (runtime assert).
 *
 * @internal
 */
export function isSlugReserved(slug: string): boolean {
  return reservedSlugs.has(normalizeSlug(slug));
}

/**
 * Mark a slug as consumed — typically called by `attachmentStore.put` after
 * a successful write so the reserved set does not grow unbounded.
 *
 * @internal
 */
export function consumeReservedSlug(slug: string): void {
  reservedSlugs.delete(normalizeSlug(slug));
}

/**
 * Test-only escape hatch — clears the in-process reserved set + lock map.
 *
 * Vitest beforeEach hooks call this to ensure cross-test isolation when
 * the same vitest worker reuses the module instance across files.
 *
 * @internal
 */
export function _resetSlugAllocatorState_TESTING_ONLY(): void {
  reservedSlugs.clear();
  slugLockChain.clear();
}

// ─── Slug normalisation ───────────────────────────────────────────────────────

/**
 * Normalise a free-form slug to canonical kebab-case.
 *
 * Steps:
 *   1. Unicode NFKD normalise + strip combining diacritics.
 *   2. Lowercase.
 *   3. Replace any non-`[a-z0-9]` run with a single hyphen.
 *   4. Trim leading/trailing hyphens.
 *
 * Note: This is intentionally the SAME algorithm as
 * `packages/core/src/docs/import/slug.ts:slugify`. Inlined here to
 * avoid a circular import (the import module already depends on
 * attachment-store via the accessor).
 *
 * @param input - Raw slug from the caller.
 * @returns Canonical kebab-case form. May be empty if input had no alphanumerics.
 */
export function normalizeSlug(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ─── Main allocator entry point ───────────────────────────────────────────────

/**
 * Reserve a slug for an upcoming `attachmentStore.put` call.
 *
 * The reservation lives only in-process and is released either when
 * `put` consumes it (success path) or when {@link releaseReservedSlug}
 * is called explicitly (caller abort path). The DB-level UNIQUE INDEX
 * remains the cross-process backstop.
 *
 * @param kind - The DocKind requesting the slug. Retained for future
 *               per-kind extensions; does NOT partition the namespace
 *               (see module-level docs §"Global namespace").
 * @param slug - Raw slug from the caller — will be normalised.
 * @param opts - Optional cwd for path resolution.
 * @returns Discriminated union: `{ ok: true }` or `{ ok: false, code, suggestions }`.
 * @task T10392
 */
export async function reserveSlug(
  kind: BuiltinDocKind | string,
  slug: string,
  opts?: ReserveSlugOptions,
): Promise<SlugReserveResult> {
  void kind; // Reserved for future per-kind suggestion derivation (T10390).
  const normalizedSlug = normalizeSlug(slug);

  // Acquire the per-slug Mutex. Released inside the try/finally below.
  const releaseLock = await acquireSlugLock(normalizedSlug);

  try {
    // Same-process check first — another in-flight reservation already
    // claimed this slug.
    if (reservedSlugs.has(normalizedSlug)) {
      const db = await getDb(opts?.cwd);
      const suggestions = await deriveSlugSuggestionsForAllocator(db, normalizedSlug);
      return { ok: false, code: 'E_SLUG_RESERVED', suggestions };
    }

    // Probe the DB for an existing row holding this slug.
    const db = await getDb(opts?.cwd);
    const { attachments } = await import('../store/tasks-schema.js');
    const { eq } = await import('drizzle-orm');
    const conflict = await db
      .select()
      .from(attachments)
      .where(eq(attachments.slug, normalizedSlug))
      .get();

    if (conflict) {
      const suggestions = await deriveSlugSuggestionsForAllocator(db, normalizedSlug);
      return { ok: false, code: 'E_SLUG_RESERVED', suggestions };
    }

    // Free — reserve it for the imminent `put`.
    reservedSlugs.add(normalizedSlug);
    return { ok: true, normalizedSlug };
  } finally {
    releaseLock();
  }
}

/**
 * Release a reserved slug without consuming it (abort path).
 *
 * Use when the caller decided NOT to proceed with `put` after a
 * successful `reserveSlug`. Calling on an unreserved slug is a no-op.
 *
 * @param slug - The slug as passed to `reserveSlug` (will be re-normalised).
 */
export function releaseReservedSlug(slug: string): void {
  reservedSlugs.delete(normalizeSlug(slug));
}

// ─── ADR-057-compliant dispatch entry-point wrapper ───────────────────────────

/**
 * Params for {@link reserveSlugForDispatch} — ADR-057 uniform signature.
 *
 * @task T10386
 */
export interface ReserveSlugForDispatchParams {
  /** DocKind requesting the slug (or empty string when --type is omitted). */
  readonly kind: BuiltinDocKind | string;
  /** Raw slug — normalised inside the allocator. */
  readonly slug: string;
}

/**
 * Result of {@link reserveSlugForDispatch} — opaque pass-through of
 * {@link SlugReserveResult} so the dispatch caller can pattern-match on
 * `ok` without importing the underlying discriminated-union shape twice.
 *
 * @task T10386
 */
export type ReserveSlugForDispatchResult = SlugReserveResult;

/**
 * Dispatch entry-point wrapper around {@link reserveSlug} conforming to the
 * ADR-057 uniform `(projectRoot, params)` signature.
 *
 * The wrapper exists so the `cleo docs add` dispatch handler can `await
 * reserveSlugForDispatch(projectRoot, params)` without tripping the
 * `lint-contracts-core-ssot` L1 rule. `projectRoot` is forwarded to
 * `reserveSlug` as the `cwd` option for path resolution; the rest of the
 * params object is the kind + slug pair.
 *
 * T10396 will collapse this wrapper back into a single signature once
 * `reserveSlug` itself is refactored to the canonical ADR-057 shape.
 *
 * @param projectRoot - Working directory for `.cleo/` resolution.
 * @param params - The DocKind + raw slug pair.
 * @returns Same discriminated union as {@link reserveSlug}.
 * @task T10386
 */
export async function reserveSlugForDispatch(
  projectRoot: string,
  params: ReserveSlugForDispatchParams,
): Promise<ReserveSlugForDispatchResult> {
  return reserveSlug(params.kind, params.slug, { cwd: projectRoot });
}
