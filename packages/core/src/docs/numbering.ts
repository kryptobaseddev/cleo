/**
 * Atomic ID-numbering utility for docs slugs that carry a numeric portion.
 *
 * ## Why this module exists
 *
 * Before this module the `cleo docs add` path for kinds like ADR (slug
 * pattern `adr-<NNN>-<rest>`) had no canonical way to pick the next number.
 * Authoring agents resorted to filesystem `readdir(docs/adr/)` + parse
 * `adr-<NNN>-...` → max → +1 — race-prone (two concurrent adds pick the
 * same N) and inconsistent with the SSoT canon (the `attachments` table is
 * the authority, not the publish-mirror directory).
 *
 * T10153 (the original sub-task that asked for `cleo docs add --type adr
 * --next` semantics) is ABSORBED here per T10159 — the new entry point
 * accepts an `AUTO` token in the caller-supplied slug, resolves it via
 * a SQLite `BEGIN IMMEDIATE` transaction over the `attachments` table,
 * and returns a fully-formed slug ready for {@link reserveSlug}.
 *
 * ## Contract
 *
 *   1. {@link resolveNextDocNumber}(kind, opts) — inspects every existing
 *      `attachments` row whose `slug` matches the kind's pattern, parses
 *      the numeric portion (per the regex captured at the `AUTO` position
 *      derived from the kind's `entityIdPattern`), and returns
 *      `max(seen) + 1` (or `1` when the table is empty).
 *
 *   2. {@link applyAutoSlug}(rawSlug, resolvedNumber) — replaces the
 *      literal `AUTO` token in the caller-supplied slug with the resolved
 *      number, zero-padding to the kind's expected width when the pattern
 *      requires it (e.g. `adr-\d{3,4}` → pad to 3 digits).
 *
 *   3. {@link allocateAutoSlug}(kind, rawSlug, opts) — the high-level
 *      convenience that combines both: detect `AUTO`, resolve, apply,
 *      return the final slug. The DB probe + slug assembly happen inside
 *      a single `BEGIN IMMEDIATE` transaction so two concurrent
 *      `cleo docs add --slug adr-AUTO-foo` invocations in the same
 *      process never pick the same N.
 *
 * ## Why BEGIN IMMEDIATE
 *
 * `node:sqlite` does not expose advisory-lock primitives. The `attachments`
 * partial UNIQUE INDEX on `slug` is the cross-process backstop, but it
 * fires LATE — after the writer has already chosen a number. By taking
 * a `BEGIN IMMEDIATE` lock on the database BEFORE the MAX query we ensure
 * that no other write transaction can sneak in between our read and the
 * imminent INSERT performed by `attachmentStore.put`. Same-process callers
 * additionally serialise via {@link reserveSlug} (per-slug Mutex) once the
 * slug is fully formed.
 *
 * ## Pad-width policy
 *
 * Each DocKind's `entityIdPattern` (declared in `@cleocode/contracts`)
 * encodes the expected numeric-portion width — e.g. `adr-\d{3,4}` means
 * "3 or 4 digits". We pad to the LOWER bound (3) so newly-allocated
 * numbers stay sortable lexicographically with the legacy corpus, and
 * naturally widen to 4 once a project crosses N=1000 without any
 * migration.
 *
 * Unknown / non-numeric DocKinds (e.g. `note`, `handoff`) — return
 * `{ kind, sequence: 0 }` from {@link resolveNextDocNumber} and pass
 * through the slug unchanged from {@link applyAutoSlug}.
 *
 * @task T10159 (absorbs T10153)
 * @epic T10157
 * @saga T9855
 * @adr ADR-076 (canon routing)
 */

import { type AnyColumn, like, sql } from 'drizzle-orm';
import { attachments } from '../store/schema/attachments.js';
import { getDb, getNativeTasksDb } from '../store/sqlite.js';

// ─── Public surface ───────────────────────────────────────────────────────────

/**
 * Options accepted by every public entry point.
 *
 * `cwd` is forwarded to `getDb(cwd)` — same convention used by
 * {@link reserveSlug}.
 */
export interface DocNumberingOptions {
  /** Optional working directory for `.cleo/` resolution. */
  readonly cwd?: string;
}

/**
 * Result of {@link resolveNextDocNumber}.
 *
 * `sequence === 0` signals that the kind does NOT have a numeric portion
 * (the caller should leave the slug unchanged).
 */
export interface ResolveNextDocNumberResult {
  /** The DocKind that was queried (echoed back for caller convenience). */
  readonly kind: string;
  /** Next available sequence number, or `0` for non-numeric kinds. */
  readonly sequence: number;
}

/**
 * Per-kind numbering descriptor — the surface area the resolver needs.
 *
 * Kept inline (rather than re-exported from `@cleocode/contracts`) because
 * the contracts module declares only `entityIdPattern` and the LIKE prefix
 * derivation logic is a numbering concern, not a taxonomy concern. The
 * map below is intentionally narrow: only kinds that have an `AUTO` slot
 * appear here.
 */
interface NumberingDescriptor {
  /** SQL LIKE prefix used to narrow the `attachments` scan. */
  readonly likePrefix: string;
  /** Regex applied to each candidate slug — group 1 MUST be the digits. */
  readonly extractRegex: RegExp;
  /** Minimum digit width — controls zero-padding by {@link applyAutoSlug}. */
  readonly padWidth: number;
}

/**
 * Canonical numbering map.
 *
 * Each entry mirrors the kind's `entityIdPattern` in `BUILTIN_DOC_KINDS`:
 *
 *   - `adr`        → `adr-\d{3,4}-...`   (pad to 3, accept 4)
 *   - `changeset`  → `t<id>-\d+-...`     (kind-only entry would over-match;
 *                                          the AUTO position depends on the
 *                                          caller-supplied prefix, so the
 *                                          changeset row is consulted at
 *                                          `allocateAutoSlug`-time rather
 *                                          than from this map)
 *
 * Only kinds with a fixed prefix-then-digits shape sit here. Variable-prefix
 * kinds (changeset, where the prefix carries the task ID) are resolved by
 * deriving the descriptor from the raw input slug at call-time.
 */
const NUMBERING_BY_KIND: ReadonlyMap<string, NumberingDescriptor> = new Map<
  string,
  NumberingDescriptor
>([
  [
    'adr',
    {
      likePrefix: 'adr-',
      extractRegex: /^adr-(\d{3,4})-/,
      padWidth: 3,
    },
  ],
]);

/**
 * Literal token a caller embeds in a slug to ask the allocator to fill in
 * the next sequence number. The literal is intentionally short, ALL-CAPS
 * (to never collide with a valid kebab-case identifier), and unique enough
 * that an accidental match is implausible.
 */
export const AUTO_TOKEN = 'AUTO';

// ─── Slug-shape helpers ───────────────────────────────────────────────────────

/**
 * Pad `n` to at least `width` digits (left-pad with `'0'`). When `n` already
 * exceeds the width the value is returned unchanged so historical 4-digit
 * ADRs continue to widen naturally without a migration.
 *
 * @param n - Numeric value to render.
 * @param width - Minimum digit count.
 * @returns Zero-padded string representation.
 */
function padNumber(n: number, width: number): string {
  const str = String(n);
  if (str.length >= width) return str;
  return str.padStart(width, '0');
}

/**
 * Derive an inline {@link NumberingDescriptor} from a raw slug that uses
 * the `AUTO` token.
 *
 * Algorithm:
 *
 *   1. Split the slug on the literal `AUTO` token. The portion BEFORE
 *      `AUTO` is the prefix used both for the SQL LIKE probe and for
 *      regex anchoring.
 *   2. The portion AFTER `AUTO` is informational only — different rows
 *      may have different suffixes, so the regex captures `(\d+)` then
 *      requires a hyphen.
 *   3. `padWidth` falls back to `1` (no padding) for inline descriptors —
 *      explicit kind-level descriptors carry the canonical width.
 *
 * Returns `null` when the slug does not contain `AUTO`.
 *
 * @param rawSlug - Slug supplied by the caller (e.g. `adr-AUTO-foo`).
 * @returns Numbering descriptor or `null`.
 */
function deriveDescriptorFromSlug(rawSlug: string): NumberingDescriptor | null {
  const idx = rawSlug.indexOf(AUTO_TOKEN);
  if (idx === -1) return null;
  const prefix = rawSlug.slice(0, idx);
  if (prefix.length === 0) return null;
  // Anchor the regex with the literal prefix; escape regex metachars.
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    likePrefix: prefix,
    extractRegex: new RegExp(`^${escaped}(\\d+)`),
    padWidth: 1,
  };
}

// ─── Slug parser (T10159 acceptance) ──────────────────────────────────────────

/**
 * Parse a numbered slug into its `(kind, sequence, remainder)` parts.
 *
 * Recognises the canonical `adr-<NNN>-<rest>` shape today. Returns `null`
 * for unprefixed slugs or slugs whose leading token does not match any
 * known numbering pattern.
 *
 * @param slug - Slug to inspect.
 * @returns Triple or `null`.
 */
export function parseSlugSequence(
  slug: string,
): { kind: string; sequence: number; remainder: string } | null {
  for (const [kind, desc] of NUMBERING_BY_KIND.entries()) {
    const match = desc.extractRegex.exec(slug);
    if (!match) continue;
    const digits = match[1];
    if (digits === undefined) continue;
    const sequence = Number.parseInt(digits, 10);
    if (!Number.isFinite(sequence)) continue;
    const remainder = slug.slice(match[0].length);
    return { kind, sequence, remainder };
  }
  return null;
}

// ─── Display-number resolution (T11875) ───────────────────────────────────────

/**
 * Resolve the DISPLAY number to render for a doc, preferring the explicitly
 * stored {@link import('../store/schema/attachments.js').attachments.displayAlias}
 * over the number derived from the slug string.
 *
 * ## Why this exists (T11875 · ADR reconcile T11676)
 *
 * Under the slug-primary model the kebab slug is the canonical handle and the
 * rendered number (e.g. ADR "051") is a DISPLAY ALIAS only. Historically that
 * number was DERIVED from the slug via {@link parseSlugSequence} — so three
 * DISTINCT ADRs slugged `adr-051-*` all rendered "051" with no way to
 * disambiguate. T11875 added a real `display_alias` column; this resolver makes
 * the stored alias authoritative while preserving byte-for-byte legacy
 * behaviour for docs that never had one assigned.
 *
 * Precedence:
 *   1. `storedAlias` — when a non-null positive integer is supplied, it wins
 *      unconditionally (the alias is the decoupled SSoT).
 *   2. Slug-derived — otherwise parse the numeric portion out of `slug` via the
 *      canonical numbering patterns ({@link parseSlugSequence}).
 *   3. `null` — when neither yields a number (non-numbered kind / no alias).
 *
 * @param slug - The doc's canonical slug (e.g. `adr-051-override-patterns`), or
 *   `null` for slug-less docs.
 * @param storedAlias - The value of `attachments.display_alias` for this doc, or
 *   `null` when unset.
 * @returns The display number to render, or `null` when none can be resolved.
 */
export function resolveDisplayNumber(
  slug: string | null | undefined,
  storedAlias: number | null | undefined,
): number | null {
  // (1) Stored alias is the decoupled SSoT — it wins over the slug-derived
  // number whenever it is a usable positive integer.
  if (typeof storedAlias === 'number' && Number.isInteger(storedAlias) && storedAlias >= 1) {
    return storedAlias;
  }
  // (2) Fall back to the slug-derived number — unchanged legacy behaviour.
  if (typeof slug !== 'string' || slug.length === 0) return null;
  const parsed = parseSlugSequence(slug);
  return parsed ? parsed.sequence : null;
}

// ─── DB inspection (atomic) ───────────────────────────────────────────────────

/**
 * Module-level promise chain used as an in-process async Mutex around
 * the BEGIN IMMEDIATE / MAX / COMMIT triple.
 *
 * `node:sqlite` uses ONE connection per process (the singleton returned
 * by `getNativeTasksDb()`), so two concurrent `BEGIN IMMEDIATE` calls on
 * the same connection raise `cannot start a transaction within a
 * transaction`. The Mutex serialises same-process callers so each
 * resolver sees a consistent MAX snapshot. Cross-process safety is
 * provided by the SQLite engine's own write-locking + the partial
 * UNIQUE INDEX on `attachments.slug` as the late-bound backstop.
 */
let scanLock: Promise<void> = Promise.resolve();

/**
 * Acquire {@link scanLock}, run `fn`, then release.
 *
 * @param fn - Async function to execute under the lock.
 * @returns Whatever `fn` returns.
 */
async function withScanLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = scanLock;
  let release!: () => void;
  scanLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * In-process "highest sequence handed out" cache, keyed by
 * `<cwd>::<likePrefix>`. The DB MAX is the floor; the cache prevents
 * two concurrent same-process callers from picking the same N when
 * neither has reached `attachmentStore.put` yet.
 *
 * The cache is bounded by the count of distinct (cwd, kind) pairs used
 * in a single process — practically tiny. It is cleared in tests via
 * {@link _resetNumberingCache_TESTING_ONLY}.
 */
const inFlightMax = new Map<string, number>();

/** Reset in-process state — test-only escape hatch. */
export function _resetNumberingCache_TESTING_ONLY(): void {
  inFlightMax.clear();
}

/** Build the cache key for a given descriptor + cwd. */
function cacheKey(descriptor: NumberingDescriptor, cwd: string | undefined): string {
  return `${cwd ?? ''}::${descriptor.likePrefix}`;
}

/**
 * Scan `attachments.slug` for rows matching `descriptor.likePrefix` and
 * extract the maximum numeric portion captured by `descriptor.extractRegex`.
 *
 * Wrapped in BOTH a per-process Mutex AND a `BEGIN IMMEDIATE` transaction:
 *
 *   1. The Mutex serialises same-process callers so the single
 *      `node:sqlite` connection never sees nested `BEGIN IMMEDIATE` calls
 *      (which would raise `cannot start a transaction within a transaction`).
 *   2. `BEGIN IMMEDIATE` upgrades to a RESERVED lock at the SQLite level,
 *      so cross-process writers either wait or fail-fast with SQLITE_BUSY.
 *
 * Cross-process safety beyond the IMMEDIATE window is provided by the
 * partial UNIQUE INDEX on `attachments.slug` — a losing process gets a
 * constraint violation at INSERT time which the writer surfaces as the
 * same `SlugCollisionError` envelope as any other late-bound conflict.
 *
 * @param descriptor - Numbering descriptor (kind-canonical or slug-derived).
 * @param cwd - Optional working directory for `.cleo/` resolution.
 * @returns Next available sequence (max + 1, or `1` when no rows match).
 */
async function scanMaxSequenceAtomically(
  descriptor: NumberingDescriptor,
  cwd: string | undefined,
): Promise<number> {
  return withScanLock(async () => {
    const db = await getDb(cwd);
    const nativeDb = getNativeTasksDb();
    if (!nativeDb) throw new Error('Database not initialized');

    let max = 0;
    nativeDb.prepare('BEGIN IMMEDIATE').run();
    try {
      const rows = await db
        .select({ slug: attachments.slug as AnyColumn })
        .from(attachments)
        .where(like(attachments.slug, `${descriptor.likePrefix}%`))
        .all();
      for (const row of rows) {
        const slug = row.slug;
        if (typeof slug !== 'string') continue;
        const match = descriptor.extractRegex.exec(slug);
        if (!match) continue;
        const digits = match[1];
        if (digits === undefined) continue;
        const value = Number.parseInt(digits, 10);
        if (Number.isFinite(value) && value > max) {
          max = value;
        }
      }
    } finally {
      // Always release the lock — the writer takes its own fresh
      // `BEGIN IMMEDIATE` when it actually performs the INSERT.
      nativeDb.prepare('COMMIT').run();
    }
    // Touch `sql` so future inline-SQL extensions stay tree-shake-safe.
    void sql;

    // Combine the DB MAX with the in-process "highest handed out" cache
    // so concurrent same-process callers get DISTINCT sequence numbers
    // even when the imminent INSERTs haven't landed yet.
    const key = cacheKey(descriptor, cwd);
    const prevHandedOut = inFlightMax.get(key) ?? 0;
    const next = Math.max(max, prevHandedOut) + 1;
    inFlightMax.set(key, next);
    return next;
  });
}

// ─── Public entry points ──────────────────────────────────────────────────────

/**
 * Resolve the next sequence number for `kind`.
 *
 * Returns `{ kind, sequence: 0 }` for kinds that do not carry a numeric
 * portion (e.g. `note`, `handoff`). Caller should leave the slug unchanged
 * in that case.
 *
 * @param kind - DocKind to query (e.g. `'adr'`).
 * @param opts - Optional cwd.
 * @returns The next sequence number for this kind.
 */
export async function resolveNextDocNumber(
  kind: string,
  opts?: DocNumberingOptions,
): Promise<ResolveNextDocNumberResult> {
  const descriptor = NUMBERING_BY_KIND.get(kind);
  if (!descriptor) {
    return { kind, sequence: 0 };
  }
  const sequence = await scanMaxSequenceAtomically(descriptor, opts?.cwd);
  return { kind, sequence };
}

/**
 * Replace the `AUTO` token in `rawSlug` with `resolvedNumber`.
 *
 * Pad width is selected from the kind-canonical descriptor when one
 * exists (so `adr` always pads to 3+ digits); slug-derived descriptors
 * pad to 1 (no padding) since the AUTO position there is arbitrary.
 *
 * When `rawSlug` does not contain `AUTO` the input is returned unchanged.
 *
 * @param rawSlug - Slug supplied by the caller.
 * @param resolvedNumber - Sequence number to substitute.
 * @param kind - Optional DocKind — selects the canonical pad width.
 * @returns Slug with `AUTO` replaced by the (padded) number.
 */
export function applyAutoSlug(rawSlug: string, resolvedNumber: number, kind?: string): string {
  if (!rawSlug.includes(AUTO_TOKEN)) return rawSlug;
  let padWidth = 1;
  if (kind !== undefined) {
    const desc = NUMBERING_BY_KIND.get(kind);
    if (desc !== undefined) padWidth = desc.padWidth;
  }
  return rawSlug.replace(AUTO_TOKEN, padNumber(resolvedNumber, padWidth));
}

/**
 * One-shot helper: detect `AUTO` in `rawSlug`, resolve the next sequence
 * atomically, and return the fully-formed slug.
 *
 * Resolution path:
 *
 *   1. If the slug does not contain `AUTO`, return it unchanged.
 *   2. If the slug starts with the kind's canonical prefix (e.g.
 *      `adr-AUTO-...` with `kind === 'adr'`), use the kind descriptor for
 *      width-correct padding.
 *   3. Otherwise derive an inline descriptor from the slug itself — used
 *      for variable-prefix kinds like `changeset` where the leading
 *      `t<id>-` portion is part of the slug, not the kind.
 *
 * The DB probe runs inside `BEGIN IMMEDIATE` so two concurrent calls in
 * the same process cannot pick the same N. Cross-process serialisation
 * relies on the `attachments.slug` partial UNIQUE INDEX as the backstop.
 *
 * @param kind - DocKind hint (used for canonical pad width).
 * @param rawSlug - Slug containing the `AUTO` token.
 * @param opts - Optional cwd.
 * @returns Slug with `AUTO` replaced — ready to forward to {@link reserveSlug}.
 */
export async function allocateAutoSlug(
  kind: string,
  rawSlug: string,
  opts?: DocNumberingOptions,
): Promise<string> {
  if (!rawSlug.includes(AUTO_TOKEN)) return rawSlug;

  // Prefer the kind-canonical descriptor when the slug starts with its
  // expected prefix — keeps pad width consistent with legacy corpus.
  const kindDescriptor = NUMBERING_BY_KIND.get(kind);
  let descriptor: NumberingDescriptor | null = null;
  if (kindDescriptor !== undefined && rawSlug.startsWith(kindDescriptor.likePrefix)) {
    descriptor = kindDescriptor;
  } else {
    descriptor = deriveDescriptorFromSlug(rawSlug);
  }
  if (descriptor === null) {
    // No way to resolve — return the slug as-is so the caller surfaces
    // a downstream validation error rather than silently writing AUTO.
    return rawSlug;
  }

  const next = await scanMaxSequenceAtomically(descriptor, opts?.cwd);
  return rawSlug.replace(AUTO_TOKEN, padNumber(next, descriptor.padWidth));
}

// ─── ADR-057-compliant dispatch entry-point wrapper ───────────────────────────

/**
 * Params for {@link allocateAutoSlugForDispatch} — ADR-057 uniform signature.
 *
 * @task T10159
 */
export interface AllocateAutoSlugForDispatchParams {
  /** DocKind hint — selects the canonical pad width when applicable. */
  readonly kind: string;
  /** Raw slug containing the `AUTO` token (or any slug — pass-through if no AUTO). */
  readonly rawSlug: string;
}

/**
 * Result of {@link allocateAutoSlugForDispatch} — the fully-resolved slug.
 *
 * Declared as an interface so the lint script's `<Op>Result` heuristic
 * recognises it as a typed contract surface.
 *
 * @task T10159
 */
export interface AllocateAutoSlugForDispatchResult {
  /** Slug with `AUTO` replaced (or input pass-through). */
  readonly resolvedSlug: string;
}

/**
 * Dispatch entry-point wrapper around {@link allocateAutoSlug} conforming
 * to the ADR-057 uniform `(projectRoot, params)` signature.
 *
 * The wrapper exists so the `cleo docs add` dispatch handler can `await
 * allocateAutoSlugForDispatch(projectRoot, params)` without tripping the
 * `lint-contracts-core-ssot` L1 rule. `projectRoot` is forwarded to
 * {@link allocateAutoSlug} as the `cwd` option for path resolution.
 *
 * @param projectRoot - Working directory for `.cleo/` resolution.
 * @param params - The DocKind hint + raw slug pair.
 * @returns The resolved slug wrapped in an envelope.
 * @task T10159
 */
export async function allocateAutoSlugForDispatch(
  projectRoot: string,
  params: AllocateAutoSlugForDispatchParams,
): Promise<AllocateAutoSlugForDispatchResult> {
  const resolvedSlug = await allocateAutoSlug(params.kind, params.rawSlug, {
    cwd: projectRoot,
  });
  return { resolvedSlug };
}
