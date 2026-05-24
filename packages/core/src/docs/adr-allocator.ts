/**
 * ADR slug auto-allocation chokepoint.
 *
 * ## Why this module exists
 *
 * Before T10360, `cleo docs add --type adr` required the caller to
 * hand-craft an `adr-NNNN-<topic>` slug. Agents and humans both
 * (a) had to discover the next available ADR number by grepping disk
 * or `.cleo/adrs/` and (b) frequently picked colliding numbers when
 * multiple agents drafted ADRs concurrently. That was the user-facing
 * symptom T10153 originally tracked.
 *
 * This module centralises the allocation: callers provide `--type adr`
 * + `--title "<human readable title>"` and the allocator:
 *
 *   1. Queries the docs SSoT for the highest existing ADR number.
 *   2. Increments by 1 and assembles the candidate slug
 *      `adr-<NNN>-<kebab-title>` (`NNN` zero-padded to width 3 — the
 *      ADR numbering convention used across `.cleo/adrs/` and the
 *      `docs/adr/` publish dir).
 *   3. Calls {@link reserveSlug} (the T10392 central allocator
 *      chokepoint) so the slug is reserved in the in-process Mutex
 *      map AND probed against the `uniq_attachments_slug` partial
 *      UNIQUE INDEX in a single chokepoint.
 *   4. On `E_SLUG_RESERVED` (rare — two agents racing for the same
 *      number despite the per-slug Mutex), retries with `N+1`,
 *      `N+2`, ... up to {@link MAX_ADR_ALLOCATION_ATTEMPTS} before
 *      surfacing `E_ADR_NUMBER_EXHAUSTED`.
 *
 * The allocator is project-scoped: it asks `.cleo/tasks.db` for the
 * highest existing ADR number, NOT a global registry. Different
 * projects keep independent ADR sequences.
 *
 * ## Why width 3 (`adr-001-...`)
 *
 * The historical `.cleo/adrs/` directory uses `ADR-NNN-<topic>.md`
 * filenames with `NNN` zero-padded to 3 digits (e.g.
 * `ADR-083-cleo-persona.md`). Auto-allocated slugs preserve that
 * width so the slug ↔ filename mapping stays mechanically obvious
 * for humans and orchestrators alike. The cap at 999 is a soft
 * ceiling — ADRs that overflow it bump to 4 digits naturally
 * (`adr-1000-...`) because the regex tolerates any digit length.
 *
 * ## Bypass
 *
 * Callers passing an explicit `--slug` skip the allocator entirely
 * and are routed straight to {@link reserveSlug} on the provided
 * value. This preserves backward compatibility with
 * `ct-adr-recorder`'s historical recipe and lets HITL operators
 * pick a specific number when superseding a deleted/withdrawn ADR.
 *
 * @task T10360
 * @epic T10291 (E3-DOCS-CLI-HARDENING)
 * @saga T10288 (SG-DOCS-INTEGRITY)
 * @closes T10153
 */

import { sql } from 'drizzle-orm';
import { getDb } from '../store/sqlite.js';
import { slugify } from './import/slug.js';
import { type ReserveSlugOptions, reserveSlug, type SlugReserveResult } from './slug-allocator.js';

// ─── Public surface ───────────────────────────────────────────────────────────

/**
 * Maximum number of consecutive allocation attempts before giving up.
 *
 * In practice the per-slug Mutex + DB UNIQUE INDEX serialises
 * reservations so a single increment is almost always enough. The
 * cap defends against pathological concurrency races (e.g. 5+ agents
 * racing on the same epoch) by surfacing `E_ADR_NUMBER_EXHAUSTED`
 * rather than retrying forever.
 */
export const MAX_ADR_ALLOCATION_ATTEMPTS = 5;

/**
 * Successful ADR allocation outcome.
 *
 * `number` is the integer ADR id that was allocated. `slug` is the
 * canonical form written to `attachments.slug`. `slug` matches
 * `adr-<NNN>-<kebab-title>` for `number <= 999` and
 * `adr-<NNNN>-<kebab-title>` for `number >= 1000`.
 */
export interface AdrAllocateOk {
  readonly ok: true;
  readonly number: number;
  readonly slug: string;
}

/**
 * Failed ADR allocation outcome.
 *
 * `code` discriminates between exhaustion (5+ reservation collisions
 * in a row — `E_ADR_NUMBER_EXHAUSTED`) and validation failures
 * (`E_VALIDATION` for an empty title that slugifies to nothing). The
 * dispatch layer maps `code` straight into the LAFS error envelope.
 */
export interface AdrAllocateErr {
  readonly ok: false;
  readonly code: 'E_ADR_NUMBER_EXHAUSTED' | 'E_VALIDATION';
  readonly message: string;
}

/** Discriminated union returned by {@link allocateAdrSlug}. */
export type AdrAllocateResult = AdrAllocateOk | AdrAllocateErr;

/** Options accepted by {@link allocateAdrSlug}. */
export interface AllocateAdrOptions extends ReserveSlugOptions {
  /**
   * Override the starting ADR number. Used by unit tests to force the
   * allocator down the retry path without populating the DB first.
   *
   * @internal
   */
  readonly startNumberOverride?: number;

  /**
   * Override the reserveSlug implementation. Used by unit tests to
   * simulate persistent contention without hitting the real DB.
   *
   * @internal
   */
  readonly reserveSlugImpl?: typeof reserveSlug;
}

// ─── ADR number discovery ─────────────────────────────────────────────────────

/**
 * Match an ADR slug and capture its numeric segment.
 *
 * Accepts `adr-1-foo`, `adr-001-foo`, `adr-99-foo`, `adr-1234-foo`.
 * The numeric segment is anchored so `adr-foo-001-bar` does NOT match.
 *
 * @internal
 */
const ADR_SLUG_PATTERN = /^adr-(\d+)-/;

/**
 * Find the highest ADR number currently recorded in the attachments
 * table.
 *
 * Returns `0` when no ADR slugs exist yet (so the first allocation
 * lands on `1` — `adr-001-<topic>`).
 *
 * @param cwd - Optional working directory for `.cleo/` resolution.
 * @returns Highest ADR number, or `0` when none exist.
 * @internal — exported for tests.
 */
export async function findHighestAdrNumber(cwd?: string): Promise<number> {
  const db = await getDb(cwd);
  // Raw SELECT keeps the query independent of the Drizzle schema barrel —
  // we only need the slug strings, not full row objects.
  const rows = await db
    .select({ slug: sql<string>`slug` })
    .from(sql`attachments`)
    .where(sql`slug LIKE 'adr-%-%'`)
    .all();

  let highest = 0;
  for (const row of rows) {
    const slug = row.slug;
    if (typeof slug !== 'string') continue;
    const match = ADR_SLUG_PATTERN.exec(slug);
    if (!match) continue;
    // Use the captured digit run directly — Number.parseInt with base 10.
    const n = Number.parseInt(match[1] ?? '', 10);
    if (Number.isFinite(n) && n > highest) {
      highest = n;
    }
  }
  return highest;
}

// ─── Slug assembly ────────────────────────────────────────────────────────────

/**
 * Assemble the canonical ADR slug from a number and a free-form title.
 *
 * `number` is zero-padded to width 3 (the historical convention) when
 * it fits, otherwise the natural-width string is used so `adr-1000-foo`
 * stays well-formed.
 *
 * `title` is slugified via the shared {@link slugify} helper so the
 * shape matches existing T9636 conventions and the
 * `uniq_attachments_slug` regex constraints.
 *
 * @param number - The ADR number (>= 1).
 * @param title - Raw human-readable title (e.g. "Adopt Drizzle v1 beta").
 * @returns Canonical slug (e.g. `adr-042-adopt-drizzle-v1-beta`).
 * @internal — exported for tests.
 */
export function assembleAdrSlug(number: number, title: string): string {
  const padded = number < 1000 ? String(number).padStart(3, '0') : String(number);
  const kebab = slugify(title);
  return `adr-${padded}-${kebab}`;
}

// ─── Main allocator entry point ───────────────────────────────────────────────

/**
 * Auto-allocate an ADR slug for an upcoming `attachmentStore.put` call.
 *
 * Returns a discriminated union: on success the slug has been reserved
 * via {@link reserveSlug} and the caller MUST proceed with `put` (or
 * release explicitly via `releaseReservedSlug`). On failure the slug
 * has NOT been reserved and the dispatch layer surfaces the error
 * envelope verbatim.
 *
 * The allocator retries on `E_SLUG_RESERVED` up to
 * {@link MAX_ADR_ALLOCATION_ATTEMPTS} times. Each retry increments
 * the candidate number — concurrent allocators converge on distinct
 * slugs without re-querying the DB on every attempt.
 *
 * @param title - Human-readable title — slugified into the slug tail.
 *                Empty / whitespace-only titles return `E_VALIDATION`.
 * @param opts - Optional cwd + test overrides.
 * @returns `{ ok: true, number, slug }` or `{ ok: false, code, message }`.
 *
 * @task T10360
 */
// SSoT-EXEMPT: internal SDK helper — not a dispatched (projectRoot, params) op. Title is the canonical input + opts only injects test seams. (T10360)
export async function allocateAdrSlug(
  title: string,
  opts?: AllocateAdrOptions,
): Promise<AdrAllocateResult> {
  // Reject empty / whitespace-only titles up front so an empty kebab
  // tail (`adr-001-`) never lands in the DB.
  const kebab = slugify(title);
  if (!kebab) {
    return {
      ok: false,
      code: 'E_VALIDATION',
      message: 'title must contain at least one alphanumeric character after slugification',
    };
  }

  const reserve = opts?.reserveSlugImpl ?? reserveSlug;
  const startNumber = opts?.startNumberOverride ?? (await findHighestAdrNumber(opts?.cwd)) + 1;

  // Try `startNumber`, `startNumber+1`, ... up to MAX_ADR_ALLOCATION_ATTEMPTS
  // increments. Each candidate is a fresh reservation attempt against the
  // central allocator chokepoint.
  for (let i = 0; i < MAX_ADR_ALLOCATION_ATTEMPTS; i++) {
    const candidateNumber = startNumber + i;
    const candidateSlug = assembleAdrSlug(candidateNumber, title);
    const reservation: SlugReserveResult = await reserve('adr', candidateSlug, {
      ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
    });
    if (reservation.ok) {
      return { ok: true, number: candidateNumber, slug: reservation.normalizedSlug };
    }
    // Reservation lost — bump and retry.
  }

  return {
    ok: false,
    code: 'E_ADR_NUMBER_EXHAUSTED',
    message:
      `failed to allocate an ADR slug after ${MAX_ADR_ALLOCATION_ATTEMPTS} attempts ` +
      `starting at adr-${startNumber} — check for concurrent allocators or pass --slug explicitly`,
  };
}
