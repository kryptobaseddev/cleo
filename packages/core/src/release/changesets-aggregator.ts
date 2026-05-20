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
import type { ChangesetEntry, ChangesetKind } from '@cleocode/contracts';

// ─── Public types ────────────────────────────────────────────────────────────

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

/**
 * Canonical render order for kind groups. Breaking floats to the TOP of the
 * section so migration-critical context lands first; everything else follows a
 * stable engineering taxonomy aligned with conventional-commit semantics.
 *
 * NOTE: `breaking` is rendered FIRST in the markdown body but iterated last
 * here — rendering wraps the order so breaking sits at the head. See
 * {@link aggregateChangesetsForRelease} for the wrap logic.
 *
 * @internal
 */
const KIND_RENDER_ORDER: readonly ChangesetKind[] = [
  'feat',
  'fix',
  'perf',
  'refactor',
  'docs',
  'test',
  'chore',
  'breaking',
] as const;

/**
 * Human-readable section headers per kind. Lower-case keys are intentional;
 * we Title-Case at render time for consistency with conventional-commit
 * vocabulary used elsewhere in CLEO's release tooling.
 *
 * @internal
 */
const KIND_HEADERS: Readonly<Record<ChangesetKind, string>> = {
  feat: 'Features',
  fix: 'Fixes',
  perf: 'Performance',
  refactor: 'Refactors',
  docs: 'Documentation',
  test: 'Tests',
  chore: 'Chores',
  breaking: 'BREAKING CHANGES',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Group entries by {@link ChangesetKind}, preserving the input order WITHIN
 * each bucket so deterministic on-disk ordering (alphabetical filenames per
 * `parseChangesetDir`) translates to stable bullet order in the section.
 *
 * @internal
 */
function groupByKind(entries: readonly ChangesetEntry[]): Map<ChangesetKind, ChangesetEntry[]> {
  const groups = new Map<ChangesetKind, ChangesetEntry[]>();
  for (const entry of entries) {
    const bucket = groups.get(entry.kind);
    if (bucket) {
      bucket.push(entry);
    } else {
      groups.set(entry.kind, [entry]);
    }
  }
  return groups;
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
  const taskAnchors = entry.tasks.map((id) => `(${id})`).join(' ');
  const prAnchors =
    entry.prs && entry.prs.length > 0 ? ' ' + entry.prs.map((n) => `(#${n})`).join(' ') : '';
  return `- ${entry.summary} ${taskAnchors}${prAnchors}`.trimEnd();
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
  const migration = (entry.breaking ?? '').trim();
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
function renderGroup(kind: ChangesetKind, entries: readonly ChangesetEntry[]): string {
  const header = `### ${KIND_HEADERS[kind]}`;
  const body = entries
    .map((e) => (kind === 'breaking' ? renderBreakingEntry(e) : renderEntryBullet(e)))
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

  const groups = groupByKind(entries);
  const presentKinds = new Set<ChangesetKind>(groups.keys());

  // Compose a render order that floats `breaking` to the head if present and
  // preserves the canonical engineering order for the rest.
  const orderedKinds: ChangesetKind[] = [];
  if (groups.has('breaking')) orderedKinds.push('breaking');
  for (const kind of KIND_RENDER_ORDER) {
    if (kind === 'breaking') continue;
    if (groups.has(kind)) orderedKinds.push(kind);
  }

  const header = title ? `## ${version} — ${date} — ${title}` : `## ${version} — ${date}`;

  const body = orderedKinds.map((kind) => renderGroup(kind, groups.get(kind) ?? [])).join('\n\n');

  const markdown = `${header}\n\n${body}\n`;

  return {
    markdown,
    entryCount: entries.length,
    kinds: presentKinds,
  };
}
