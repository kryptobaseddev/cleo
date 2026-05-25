/**
 * CLEO-native changesets aggregator — rolls `.changeset/*.md` entries into a
 * CHANGELOG markdown section embedded into the release plan envelope.
 *
 * Pure module: no filesystem, no database, no network. Callers are expected to
 * read changeset files via {@link parseChangesetDir} (lives in
 * `@cleocode/core/changesets`) and persist the entries via the data-accessor
 * chokepoint.
 *
 * Output shape: one markdown section per release. Entries are grouped by
 * {@link ChangesetKind} in a stable canonical order; breaking changes float to
 * the top of the section with their `breaking` migration note rendered inline.
 *
 * @epic T9752
 * @task T9753
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ChangesetEntry,
  ChangesetKind,
  ChangesetReleaseNoteSection,
} from '@cleocode/contracts';
import { ChangesetEntrySchema } from '@cleocode/contracts';
import { parse as parseYaml } from 'yaml';
import { parseChangesetDir } from '../changesets/index.js';
import { createAttachmentStore } from '../store/attachment-store.js';

// ─── Public types ────────────────────────────────────────────────────────────

/**
 * Provenance label for an aggregated entry — distinguishes whether the bytes
 * came from the canonical docs SSoT blob store or from a `.changeset/*.md`
 * file that has not yet been mirrored to SSoT.
 *
 * Surfaces under `meta.source` on every {@link AggregatedChangesetEntry}.
 *
 * @task T9793
 */
export type ChangesetSource = 'ssot' | 'file';

/**
 * One aggregated changeset entry paired with its provenance.
 *
 * Returned by {@link readChangesetsSsotFirst} — wraps the parsed
 * {@link ChangesetEntry} with the source label so downstream consumers
 * (release-notes composer, debugging surfaces) can tell at a glance whether
 * a given entry was sourced from SSoT or a legacy `.changeset/*.md` file.
 *
 * @task T9793
 */
export interface AggregatedChangesetEntry {
  /** The parsed changeset entry. */
  readonly entry: ChangesetEntry;
  /** Provenance label — `'ssot'` when read from blob store, `'file'` otherwise. */
  readonly meta: { readonly source: ChangesetSource };
}

/**
 * Result of aggregating a slice of changeset entries into a release CHANGELOG
 * section. The `markdown` field is empty string when `entries.length === 0` so
 * callers can compose conditionally without branching on the contents.
 */
export interface AggregatedChangesetSection {
  /** Rendered CHANGELOG markdown section. Empty string when no entries. */
  readonly markdown: string;
  /** Number of entries rolled into the section. */
  readonly entryCount: number;
  /** Distinct kinds represented in the rendered section. */
  readonly kinds: ReadonlySet<ChangesetKind>;
}

/**
 * Options accepted by {@link aggregateChangesetsForRelease}.
 */
export interface AggregateChangesetsOptions {
  /** Parsed changeset entries to aggregate. */
  readonly entries: readonly ChangesetEntry[];
  /** Release version string (e.g. `v2026.6.0`). Used in the section header. */
  readonly version: string;
  /** ISO-8601 calendar date (YYYY-MM-DD). Used in the section header. */
  readonly date: string;
  /** Optional human-readable release title appended after the version header. */
  readonly title?: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const RELEASE_NOTE_SECTION_ORDER: readonly ChangesetReleaseNoteSection[] = [
  'added',
  'changed',
  'fixed',
  'deprecated',
  'removed',
  'security',
  'breaking',
] as const;

const RELEASE_NOTE_SECTION_HEADERS: Readonly<Record<ChangesetReleaseNoteSection, string>> = {
  added: 'Added',
  changed: 'Changed',
  fixed: 'Fixed',
  deprecated: 'Deprecated',
  removed: 'Removed',
  security: 'Security',
  breaking: 'BREAKING CHANGES',
};

const DEFAULT_TASK_PROVENANCE_BASE_URL = 'https://github.com/kryptobaseddev/cleo/search';
const DEFAULT_PR_PROVENANCE_BASE_URL = 'https://github.com/kryptobaseddev/cleo/pull';

const KIND_TO_RELEASE_NOTE_SECTION: Readonly<Record<ChangesetKind, ChangesetReleaseNoteSection>> = {
  feat: 'added',
  fix: 'fixed',
  perf: 'changed',
  refactor: 'changed',
  docs: 'changed',
  test: 'changed',
  chore: 'changed',
  breaking: 'breaking',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Group entries by {@link ChangesetKind}, preserving the input order WITHIN
 * each bucket so deterministic on-disk ordering (alphabetical filenames per
 * `parseChangesetDir`) translates to stable bullet order in the section.
 *
 * @internal
 */
function groupByReleaseNoteSection(
  entries: readonly ChangesetEntry[],
): Map<ChangesetReleaseNoteSection, ChangesetEntry[]> {
  const groups = new Map<ChangesetReleaseNoteSection, ChangesetEntry[]>();
  for (const entry of entries) {
    if (entry.releaseNotes?.includeInChangelog === false) continue;
    const section = entry.releaseNotes?.section ?? KIND_TO_RELEASE_NOTE_SECTION[entry.kind];
    const bucket = groups.get(section);
    if (bucket) {
      bucket.push(entry);
    } else {
      groups.set(section, [entry]);
    }
  }
  return groups;
}

function markdownLink(label: string, href: string): string {
  return `[${label}](${href})`;
}

function renderTaskProvenanceLink(taskId: string): string {
  return markdownLink(
    taskId,
    `${DEFAULT_TASK_PROVENANCE_BASE_URL}?q=${encodeURIComponent(taskId)}&type=commits`,
  );
}

function renderPrProvenanceLink(pr: number): string {
  return markdownLink(`#${pr}`, `${DEFAULT_PR_PROVENANCE_BASE_URL}/${pr}`);
}

/**
 * Render a single non-breaking entry as a bullet line.
 *
 * Format: `- summary (T1234, T5678) (#42, #43)` — task IDs and PR numbers are
 * appended in parens only when present. Task IDs precede PRs because tasks are
 * the canonical CLEO identifier; PRs are secondary metadata.
 *
 * @internal
 */
function renderEntryBullet(entry: ChangesetEntry): string {
  const note = entry.releaseNotes?.impact ?? entry.summary;
  const taskAnchors = entry.tasks.map(renderTaskProvenanceLink).join(', ');
  const prAnchors =
    entry.prs && entry.prs.length > 0
      ? '; ' + entry.prs.map(renderPrProvenanceLink).join(', ')
      : '';
  const provenance = ` _(provenance: ${taskAnchors}${prAnchors})_`;
  const target = entry.releaseNotes?.targets?.length
    ? `**${entry.releaseNotes.targets.join(', ')}:** `
    : '';
  return `- ${target}${note}${provenance}`.trimEnd();
}

/**
 * Render a breaking entry as a bullet plus an indented migration block.
 *
 * The `breaking` field is required for `kind: 'breaking'` (enforced by the
 * Zod schema) — we still defensively coalesce to an empty migration note so a
 * mis-tagged future entry does not crash the renderer.
 *
 * @internal
 */
function renderBreakingEntry(entry: ChangesetEntry): string {
  const bullet = renderEntryBullet(entry);
  const migration = (entry.releaseNotes?.migration ?? entry.breaking ?? '').trim();
  if (migration.length === 0) return bullet;
  // Indent each line of the migration note by two spaces so it renders as a
  // nested block under the bullet in standard markdown renderers.
  const indented = migration
    .split('\n')
    .map((line) => (line.length > 0 ? `  ${line}` : ''))
    .join('\n');
  return `${bullet}\n\n  Migration:\n\n${indented}`;
}

/**
 * Render a kind group as a `### Header` block followed by bullet lines.
 *
 * @internal
 */
function renderGroup(
  section: ChangesetReleaseNoteSection,
  entries: readonly ChangesetEntry[],
): string {
  const header = `### ${RELEASE_NOTE_SECTION_HEADERS[section]}`;
  const body = entries
    .map((e) => (section === 'breaking' ? renderBreakingEntry(e) : renderEntryBullet(e)))
    .join('\n');
  return `${header}\n\n${body}`;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Aggregate a parsed set of {@link ChangesetEntry} records into a single
 * CHANGELOG section.
 *
 * Section layout:
 *
 * ```md
 * ## <version> — <date> [— <title>]
 *
 * ### BREAKING CHANGES   ← only when at least one breaking entry exists
 *
 * - <summary> (T####) (#PR)
 *
 *   Migration:
 *
 *   <breaking note indented>
 *
 * ### Features
 *
 * - <summary> (T####) (#PR)
 * ```
 *
 * Empty input → returns `{ markdown: '', entryCount: 0, kinds: new Set() }` so
 * the caller can skip emission without branching on string length.
 *
 * @example
 * ```ts
 * import { parseChangesetDir } from '@cleocode/core/changesets';
 * import { aggregateChangesetsForRelease } from '@cleocode/core/release/changesets-aggregator';
 *
 * const entries = parseChangesetDir('.changeset');
 * const section = aggregateChangesetsForRelease({
 *   entries,
 *   version: 'v2026.6.0',
 *   date: '2026-05-20',
 * });
 * console.log(section.markdown);
 * ```
 */
export function aggregateChangesetsForRelease(
  opts: AggregateChangesetsOptions,
): AggregatedChangesetSection {
  const { entries, version, date, title } = opts;
  if (entries.length === 0) {
    return { markdown: '', entryCount: 0, kinds: new Set<ChangesetKind>() };
  }

  const includedEntries = entries.filter(
    (entry) => entry.releaseNotes?.includeInChangelog !== false,
  );
  const groups = groupByReleaseNoteSection(includedEntries);
  const presentKinds = new Set<ChangesetKind>(includedEntries.map((entry) => entry.kind));

  const header = title ? `## ${version} — ${date} — ${title}` : `## ${version} — ${date}`;

  const body = RELEASE_NOTE_SECTION_ORDER.map((section) =>
    renderGroup(section, groups.get(section) ?? []),
  ).join('\n\n');

  const markdown = `${header}\n\n${body}\n`;

  return {
    markdown,
    entryCount: includedEntries.length,
    kinds: presentKinds,
  };
}

// ─── SSoT-first reader (T9793) ───────────────────────────────────────────────

/**
 * Parse the bytes of a changeset markdown blob (read from SSoT) into a
 * validated {@link ChangesetEntry}.
 *
 * Mirrors {@link parseChangesetFile} but operates on in-memory bytes rather
 * than reading the filesystem, so the SSoT-first path never re-touches disk
 * when the canonical content is already addressed by the attachment store.
 *
 * Returns `null` on any parse failure — callers fall back to the file
 * surface for that slug rather than throwing, because aggregation is
 * advisory metadata and one malformed entry must not block the release plan.
 *
 * @internal
 */
function parseChangesetMarkdownBytes(bytes: Buffer, expectedSlug: string): ChangesetEntry | null {
  const raw = bytes.toString('utf-8');
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  let closingIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      closingIdx = i;
      break;
    }
  }
  if (closingIdx === -1) return null;

  const frontmatter = lines.slice(1, closingIdx).join('\n');
  const body = lines
    .slice(closingIdx + 1)
    .join('\n')
    .replace(/^\s+/, '')
    .replace(/\s+$/, '');

  let frontmatterData: unknown;
  try {
    frontmatterData = parseYaml(frontmatter);
  } catch {
    return null;
  }
  if (frontmatterData === null || typeof frontmatterData !== 'object') return null;

  const candidate: Record<string, unknown> = { ...(frontmatterData as Record<string, unknown>) };
  if (!('notes' in candidate) && body.length > 0) {
    candidate.notes = body;
  }
  const parsed = ChangesetEntrySchema.safeParse(candidate);
  if (!parsed.success) return null;
  // Slug cross-check: the SSoT slug column is the canonical address, so its
  // value must match the entry id embedded in the markdown.
  if (parsed.data.id !== expectedSlug) return null;
  return parsed.data;
}

/**
 * Read every changeset entry available in the project, preferring SSoT bytes
 * when present and falling back to `.changeset/*.md` for slugs that have not
 * yet been mirrored to SSoT.
 *
 * Algorithm:
 *   1. Query the attachment store for every row where `type='changeset'`.
 *      Each row carries the slug + content sha256 — the canonical address.
 *   2. Read `.changeset/*.md` from disk for the same project.
 *   3. Build a slug→source map: SSoT wins on slug-match (sha-dedup happens
 *      automatically because both surfaces hash the same canonical bytes).
 *   4. For each unique slug, parse the bytes (from SSoT) or the file (from
 *      disk), attach a `meta.source` label, and return them.
 *
 * Entries that fail validation in EITHER surface are silently skipped —
 * callers receive only the validated subset. The aggregator is advisory
 * metadata and one malformed row must not block release planning.
 *
 * @param projectRoot - Absolute path to the project root.
 * @returns Aggregated entries sorted by id (deterministic for downstream
 *   diff-friendliness). SSoT-first; file-fallback for unmirrored slugs.
 *
 * @example
 * ```ts
 * const entries = await readChangesetsSsotFirst('/path/to/repo');
 * for (const { entry, meta } of entries) {
 *   console.log(`${entry.id} ← ${meta.source}`);
 * }
 * ```
 *
 * @task T9793
 */
export async function readChangesetsSsotFirst(
  projectRoot: string,
): Promise<AggregatedChangesetEntry[]> {
  // Track which slugs we've resolved so file-fallback never double-counts a
  // slug that SSoT has already supplied.
  const bySlug = new Map<string, AggregatedChangesetEntry>();

  // ── 1. SSoT pass — query attachment store for type='changeset' rows. ───
  // Failures here (DB not yet initialised, schema migrations pending, etc.)
  // degrade silently to the file path so a fresh checkout still works.
  try {
    const store = createAttachmentStore();
    const rows = await store.listAllInProject(projectRoot, { type: 'changeset' });
    for (const row of rows) {
      const slug = row.slug;
      if (!slug) continue;
      // We need the raw bytes — fetch by SHA-256.
      const fetched = await store.get(row.metadata.sha256, projectRoot);
      if (!fetched) continue;
      const entry = parseChangesetMarkdownBytes(fetched.bytes, slug);
      if (!entry) continue;
      bySlug.set(slug, { entry, meta: { source: 'ssot' } });
    }
  } catch {
    /* SSoT unavailable — fall through to file-only mode. */
  }

  // ── 2. File pass — fill in slugs SSoT did not cover. ───────────────────
  // T10105: parse failures (YAML or schema) propagate to the caller. The
  // pre-T10105 silent-skip caused the v2026.5.100 ship to drop CHANGELOG
  // entries for v5.100/v5.101/v5.103. Operators (or CI) get a
  // ChangesetYamlInvalidError naming the offending file:line.
  const changesetDir = join(projectRoot, '.changeset');
  if (existsSync(changesetDir)) {
    const fileEntries = parseChangesetDir(changesetDir);
    for (const entry of fileEntries) {
      if (bySlug.has(entry.id)) continue;
      bySlug.set(entry.id, { entry, meta: { source: 'file' } });
    }
  }

  // ── 3. Sort by id for deterministic output. ────────────────────────────
  return Array.from(bySlug.values()).sort((a, b) =>
    a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0,
  );
}

/**
 * Convenience wrapper — strip provenance and return just the entries, for
 * callers (like `cleo release plan`) that feed the result straight into
 * {@link aggregateChangesetsForRelease}.
 *
 * Reads the entries via {@link readChangesetsSsotFirst} then maps to the
 * underlying `ChangesetEntry[]`. Loses the `meta.source` label — use the
 * full reader when provenance is needed.
 *
 * @param projectRoot - Absolute path to the project root.
 * @returns Validated entries, SSoT-first.
 *
 * @task T9793
 */
export async function readChangesetEntriesSsotFirst(
  projectRoot: string,
): Promise<ChangesetEntry[]> {
  const aggregated = await readChangesetsSsotFirst(projectRoot);
  return aggregated.map((a) => a.entry);
}

/**
 * Synchronous helper for {@link readChangesetEntries} in `plan.ts` —
 * the file-only fallback used when `readChangesetEntriesSsotFirst` is not
 * yet wired into a code path that can `await`.
 *
 * Mirrors the legacy behaviour of `parseChangesetDir(.changeset)` — kept
 * because the release plan pipeline (T9753) calls it synchronously from
 * `releasePlan()` and the broader async refactor is out of scope here.
 *
 * The async {@link readChangesetEntriesSsotFirst} is the preferred surface
 * for new code.
 *
 * @internal
 * @task T9793
 */
export function readChangesetEntriesFileOnly(projectRoot: string): ChangesetEntry[] {
  const dir = join(projectRoot, '.changeset');
  if (!existsSync(dir)) return [];
  // T10105: NO try/catch — ChangesetYamlInvalidError propagates so the
  // calling release verb aborts with a deterministic error envelope rather
  // than silently dropping every entry on one malformed file.
  return parseChangesetDir(dir);
}

/**
 * Probe the existence of a `.changeset/<slug>.md` file. Test-helper safety
 * net used by the unit tests — exposed because the writer's file-write step
 * uses `tmp-then-rename` which can race in tight test loops.
 *
 * @internal
 */
export function changesetFileExists(projectRoot: string, slug: string): boolean {
  return existsSync(join(projectRoot, '.changeset', `${slug}.md`));
}

/**
 * Read a `.changeset/<slug>.md` file's raw bytes. Test-helper used by the
 * aggregator-ssot-first test to verify provenance labels match expectations.
 *
 * @internal
 */
export function readChangesetFileBytes(projectRoot: string, slug: string): Buffer | null {
  const path = join(projectRoot, '.changeset', `${slug}.md`);
  if (!existsSync(path)) return null;
  return readFileSync(path);
}
