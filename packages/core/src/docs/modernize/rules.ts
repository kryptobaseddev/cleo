/**
 * Pure rules for `cleo docs modernize` (T14113): classify a file into a
 * taxonomy kind, derive its stable slug, measure how alike two docs are, and
 * rewrite links to wikilinks.
 *
 * No I/O here. The planner (`plan.ts`) feeds these rules the scanned files and
 * asks System One (`judge.ts`) only where a rule is unsure.
 *
 * @task T14113
 * @epic T14106
 */

import type { DocKindMetadata, DocsModernizePlanRow } from '@cleocode/contracts';
import { WIKILINK_PATTERN } from '../derive-links.js';
import { DOC_NAME_MAX_LENGTH, docNameViolation, subjectSlug } from '../doc-name-rule.js';

/** Confidence at or above which a classify rule acts without asking System One. */
export const MODERNIZE_CLASSIFY_FLOOR = 0.75;

/** Similarity at or above which two docs merge without asking System One. */
export const MODERNIZE_MERGE_SURE = 0.8;

/** Similarity below which two docs are kept apart without asking System One. */
export const MODERNIZE_MERGE_APART = 0.4;

/** Longest slug modernize proposes, in characters. */
export const MODERNIZE_SLUG_MAX = DOC_NAME_MAX_LENGTH;

/** A rule's classification of one file. */
export interface ModernizeClassification {
  /** Proposed kind. */
  readonly kind: string;
  /** 0..1; below {@link MODERNIZE_CLASSIFY_FLOOR} the call is ambiguous. */
  readonly confidence: number;
  /** One line explaining the rule that fired. */
  readonly reason: string;
}

/**
 * Folder-name aliases that name a kind under another spelling (the T14107
 * taxonomy's "absorbs" column). An alias only fires when its kind is
 * registered, so kinds a project has not adopted fall through to the rules.
 */
const FOLDER_ALIASES: Readonly<Record<string, string>> = {
  adrs: 'adr',
  decisions: 'adr',
  specs: 'spec',
  specifications: 'spec',
  handoffs: 'handoff',
  plans: 'plan',
  notes: 'note',
  releases: 'release-note',
  analysis: 'research',
  audits: 'research',
  audit: 'research',
  reports: 'research',
  guides: 'guide',
  examples: 'guide',
  'owner-ci': 'guide',
  concepts: 'concept',
  architecture: 'concept',
  design: 'concept',
  api: 'reference',
  'cli-reference': 'reference',
  registry: 'reference',
  skills: 'reference',
  migrations: 'migration',
};

/** Filename words that name a kind. */
const NAME_HINTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^adr-\d+/, 'adr'],
  [/(^|-)handoff(-|$)/, 'handoff'],
  [/(^|-)spec(ification)?(-|$)/, 'spec'],
  [/(^|-)plan(-|$)/, 'plan'],
  [/(^|-)(research|report|audit|analysis)(-|$)/, 'research'],
  [/(^|-)release-notes?(-|$)/, 'release-note'],
];

/** Body shapes that name a kind. */
const BODY_HINTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^#{1,3}\s+(context|status)\b[\s\S]*^#{1,3}\s+decision\b/im, 'adr'],
  [/^#{1,3}\s+(handoff|next steps for the next agent)\b/im, 'handoff'],
  [/^#{1,3}\s+(requirements|acceptance criteria)\b/im, 'spec'],
  [/^#{1,3}\s+(findings|methodology|summary of findings)\b/im, 'research'],
];

/**
 * Read a front-matter scalar (`key: value`) from a markdown file.
 *
 * @param content - File text.
 * @param key - Front-matter key.
 * @returns The trimmed, unquoted value, or null.
 */
export function readFrontMatterValue(content: string, key: string): string | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match?.[1]) return null;
  const line = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(match[1]);
  if (!line?.[1]) return null;
  return line[1].trim().replace(/^['"]|['"]$/g, '') || null;
}

/**
 * The first H1 of a markdown file, or null.
 *
 * @param content - File text.
 * @returns The heading text without the `#`.
 */
export function readTitle(content: string): string | null {
  const fm = readFrontMatterValue(content, 'title');
  if (fm) return fm;
  const match = /^#\s+(.+?)\s*#*\s*$/m.exec(content);
  return match?.[1]?.trim() || null;
}

/**
 * Resolve a folder or word to a registered kind.
 *
 * @param word - A folder name or filename word.
 * @param kinds - Registered kind ids.
 * @returns The kind, or null when none matches.
 */
function kindForWord(word: string, kinds: ReadonlySet<string>): string | null {
  const lower = word.toLowerCase();
  if (kinds.has(lower)) return lower;
  const alias = FOLDER_ALIASES[lower];
  if (alias && kinds.has(alias)) return alias;
  if (lower.endsWith('s') && kinds.has(lower.slice(0, -1))) return lower.slice(0, -1);
  return null;
}

/**
 * The kind a folder name stands for (its own name or a T14107 alias).
 *
 * @param folder - One folder name.
 * @param kinds - The registry's kinds.
 * @returns The kind, or null.
 */
export function folderKind(folder: string, kinds: readonly DocKindMetadata[]): string | null {
  return kindForWord(folder, new Set(kinds.map((k) => k.kind)));
}

/**
 * Classify one file by rules: front matter, folder, filename, then body shape.
 *
 * @param relPath - Path relative to the modernize root.
 * @param content - File text.
 * @param kinds - The registry's kinds.
 * @returns The classification; `note` at low confidence when nothing fires.
 */
export function classifyDocByRules(
  relPath: string,
  content: string,
  kinds: readonly DocKindMetadata[],
): ModernizeClassification {
  const ids = new Set(kinds.map((k) => k.kind));
  for (const key of ['kind', 'type']) {
    const declared = readFrontMatterValue(content, key);
    const kind = declared ? kindForWord(declared, ids) : null;
    if (kind) return { kind, confidence: 1, reason: `front matter declares ${key}: ${declared}` };
  }

  const segments = relPath.split('/');
  const base = (segments.pop() ?? '').replace(/\.[^.]+$/, '').toLowerCase();
  if (ids.has('adr') && /^adr-\d+/.test(base)) {
    return { kind: 'adr', confidence: 0.95, reason: 'filename carries an ADR number' };
  }
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const segment = segments[i] ?? '';
    const kind = kindForWord(segment, ids);
    if (kind) return { kind, confidence: 0.9, reason: `sits in the ${segment}/ folder` };
  }
  for (const [pattern, kind] of NAME_HINTS) {
    if (ids.has(kind) && pattern.test(base)) {
      return { kind, confidence: 0.7, reason: `filename names a ${kind}` };
    }
  }
  for (const [pattern, kind] of BODY_HINTS) {
    if (ids.has(kind) && pattern.test(content)) {
      return { kind, confidence: 0.6, reason: `headings read like a ${kind}` };
    }
  }
  const fallback = ids.has('note') ? 'note' : (kinds[0]?.kind ?? 'note');
  return { kind: fallback, confidence: 0.3, reason: 'no folder, name or heading rule fired' };
}

/** Words a slug derived from a name or title has. */
function wordCount(slug: string): number {
  return slug === 'doc' ? 0 : slug.split('-').filter(Boolean).length;
}

/**
 * The stable slug for a file, under the T14107 naming rule:
 *
 * - a file name that already passes {@link docNameViolation} for its kind is
 *   kept unchanged (a release note's `v2026.10.28`, a clean `adr-001-store`);
 * - otherwise the slug is {@link subjectSlug} of the name, or of the title
 *   when the name has too few words left (two; one after an ADR number);
 * - an ADR keeps its number as an `adr-NNN-` prefix.
 *
 * @param relPath - Path relative to the modernize root.
 * @param content - File text.
 * @param kind - The file's kind.
 * @returns A slug that passes the naming rule.
 */
export function stableSlugFor(relPath: string, content: string, kind: string): string {
  const base = (relPath.split('/').pop() ?? '').replace(/\.[^.]+$/, '');
  if (base && docNameViolation(base, kind) === null) return base;
  const adr = kind === 'adr' ? /^adr-?(\d+)/i.exec(base) : null;
  const prefix = adr ? `adr-${adr[1]?.padStart(3, '0')}-` : '';
  const room = MODERNIZE_SLUG_MAX - prefix.length;
  let words = subjectSlug(adr ? base.slice(adr[0].length) : base, room);
  if (wordCount(words) < (adr ? 1 : 2)) {
    const title = readTitle(content)?.replace(/^adr[\s-]?\d+[:\s.-]*/i, '');
    const fromTitle = title ? subjectSlug(title, room) : 'doc';
    if (wordCount(fromTitle) >= Math.max(2, wordCount(words) + 1)) words = fromTitle;
  }
  if (wordCount(words) === 0) words = subjectSlug(kind, room);
  return `${prefix}${words}`;
}

/**
 * The version a filename claims (`-v2` → 2), or 0.
 *
 * @param relPath - Path relative to the root.
 * @returns The version number.
 */
export function versionOf(relPath: string): number {
  const match = /(?:^|[-_])v(\d+)(?=[-_.]|$)/i.exec(relPath.split('/').pop() ?? '');
  return match?.[1] ? Number(match[1]) : 0;
}

/** Normalised non-empty lines of a doc, for similarity. */
function lineSet(content: string): Set<string> {
  const out = new Set<string>();
  for (const raw of content.split('\n')) {
    const line = raw.trim().toLowerCase().replace(/\s+/g, ' ');
    if (line.length > 2 && !/^[-=*_`#>|]+$/.test(line)) out.add(line);
  }
  return out;
}

/**
 * Jaccard similarity of two docs' normalised lines (0..1).
 *
 * @param a - First doc text.
 * @param b - Second doc text.
 * @returns 1 for the same lines, 0 for none shared.
 */
export function docSimilarity(a: string, b: string): number {
  const left = lineSet(a);
  const right = lineSet(b);
  if (left.size === 0 && right.size === 0) return 1;
  let shared = 0;
  for (const line of left) if (right.has(line)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** Collapse whitespace so formatting-only differences do not count as content. */
function normalizeBlock(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Split a doc into its preamble (before the first `##`) and its `##` sections. */
function splitSections(text: string): { preamble: string; sections: string[] } {
  const parts = text.split(/^(?=##\s)/m);
  const first = parts[0] ?? '';
  return first.startsWith('## ')
    ? { preamble: '', sections: parts }
    : { preamble: first, sections: parts.slice(1) };
}

/**
 * Fold a duplicate into its survivor without losing any of its content.
 *
 * - A `##` section whose heading the survivor lacks is appended as is.
 * - A section whose heading the survivor has, but whose body differs, is
 *   appended under `<heading> (from [[slug]])`.
 * - The preamble (everything before the first `##`, which is the whole doc
 *   when it has no `##` headings) is appended under `## From [[slug]]` unless
 *   the survivor already contains it; a lone `# Title` line equal to the
 *   survivor's title is dropped as the same title.
 *
 * Every non-blank line of the duplicate is therefore in the result, either
 * because the survivor already had the block or because it was appended.
 *
 * @param survivor - The kept doc's text.
 * @param duplicate - The merged doc's text.
 * @param duplicateRef - How the merged doc is cited on what was appended: a
 *   resolvable slug, already formatted (`` `slug` `` or `[[slug]]`).
 * @returns The merged text (the survivor unchanged when nothing is new).
 */
export function mergeDocBodies(survivor: string, duplicate: string, duplicateRef: string): string {
  const own = splitSections(survivor);
  const ownBlocks = new Set(own.sections.map(normalizeBlock));
  const ownByHeading = new Map<string, string>();
  for (const section of own.sections) {
    const heading = /^##\s+(.+)$/m.exec(section)?.[1]?.trim().toLowerCase() ?? '';
    ownByHeading.set(heading, normalizeBlock(section));
  }
  const whole = normalizeBlock(survivor);
  const appended: string[] = [];

  const dup = splitSections(duplicate);
  const ownTitle = /^#\s+(.+)$/m.exec(survivor)?.[1]?.trim().toLowerCase();
  const preamble = dup.preamble
    .split('\n')
    .filter((line) => !(ownTitle && line.trim().toLowerCase() === `# ${ownTitle}`))
    .join('\n')
    .trim();
  if (preamble && !whole.includes(normalizeBlock(preamble))) {
    appended.push(`## From ${duplicateRef}\n\n${preamble}\n`);
  }
  for (const section of dup.sections) {
    const headingLine = /^##\s+(.+)$/m.exec(section)?.[1]?.trim() ?? '';
    const key = headingLine.toLowerCase();
    if (ownBlocks.has(normalizeBlock(section))) continue;
    if (!ownByHeading.has(key)) {
      appended.push(section.trimEnd());
      continue;
    }
    appended.push(
      section.replace(/^##\s+.+$/m, `## ${headingLine} (from ${duplicateRef})`).trimEnd(),
    );
  }
  if (appended.length === 0) return survivor;
  return `${survivor.trimEnd()}\n\n<!-- merged from ${duplicateRef} by cleo docs modernize -->\n\n${appended.join('\n\n')}\n`;
}

/** Inline markdown links and images: `[label](href)` / `![alt](href)`; group 2 is the href. */
const MARKDOWN_LINK = /(!?\[[^\]\n]*\])\(([^)\s]+)\)/g;

/** Whether an href is a relative path (not a URL, an absolute path or a bare anchor). */
function isRelativeHref(href: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('/') && !href.startsWith('#');
}

/**
 * Resolve a relative href against a root-relative file path.
 *
 * @param fromPath - The linking file's path relative to the root.
 * @param href - The relative href (fragment allowed).
 * @returns The target's root-relative path, or null when it leaves the root.
 */
function resolveRelative(fromPath: string, href: string): string | null {
  const parts = fromPath.split('/').slice(0, -1);
  for (const part of href.split('#')[0]?.split('/') ?? []) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(decodeURIComponent(part));
  }
  return parts.join('/');
}

/** A root-relative path expressed relative to a directory (POSIX). */
function relativeHref(fromDir: string[], to: string): string {
  const target = to.split('/');
  let common = 0;
  while (common < fromDir.length && fromDir[common] === target[common]) common += 1;
  const up = fromDir.slice(common).map(() => '..');
  return [...up, ...target.slice(common)].join('/') || '.';
}

/**
 * Where one relative href points after a move, or null when it stays as is
 * (a URL, an anchor, a link leaving the root, or nothing moved).
 */
function repointHref(
  href: string,
  fromOld: string,
  newDir: string[],
  moved: boolean,
  finalPathOf: ReadonlyMap<string, string>,
): string | null {
  if (!isRelativeHref(href)) return null;
  const target = resolveRelative(fromOld, href);
  if (target === null) return null;
  const final = finalPathOf.get(target) ?? target;
  if (!moved && final === target) return null;
  const fragment = href.includes('#') ? href.slice(href.indexOf('#')) : '';
  let next = relativeHref(newDir, final);
  if (href.startsWith('./') && !next.startsWith('.')) next = `./${next}`;
  next = `${next.split('/').map(encodeURIComponent).join('/')}${fragment}`;
  return next === href ? null : next;
}

/**
 * Re-point relative markdown links (and images) after a move, keeping them
 * plain markdown so they still render on GitHub (T14185).
 *
 * A link's target is resolved from the file's OLD path. A target in the plan
 * maps to its final path (a merged or deleted file maps to its survivor's),
 * and any other target keeps its location; the href is then rewritten
 * relative to the file's NEW path. Links that leave the root, URLs and
 * anchors are left alone, and so is a link whose href would not change.
 *
 * @param content - Doc text.
 * @param fromOld - The file's path before the move, relative to the root.
 * @param toNew - The file's path after the move.
 * @param finalPathOf - Root-relative old path → final path, for every planned file.
 * @returns The text with every relative link pointing at the right place.
 */
export function repointMarkdownLinks(
  content: string,
  fromOld: string,
  toNew: string,
  finalPathOf: ReadonlyMap<string, string>,
): string {
  const newDir = toNew.split('/').slice(0, -1);
  return content.replace(MARKDOWN_LINK, (whole, label: string, href: string) => {
    const next = repointHref(href, fromOld, newDir, fromOld !== toNew, finalPathOf);
    return next === null ? whole : `${label}(${next})`;
  });
}

/**
 * The href edits a file that stays where it is needs because link targets
 * move: the `link-fix` rows of a plan's kept files (T14185). Each distinct
 * href is listed once.
 *
 * @param content - Doc text.
 * @param path - The file's path, relative to the root (it does not move).
 * @param finalPathOf - Root-relative old path → final path, for every planned file.
 * @returns `{ href, newHref }` pairs, in order of first appearance.
 */
export function markdownLinkFixes(
  content: string,
  path: string,
  finalPathOf: ReadonlyMap<string, string>,
): { href: string; newHref: string }[] {
  const newDir = path.split('/').slice(0, -1);
  const fixes = new Map<string, string>();
  for (const match of content.matchAll(MARKDOWN_LINK)) {
    const href = match[2] ?? '';
    if (fixes.has(href)) continue;
    const next = repointHref(href, path, newDir, false, finalPathOf);
    if (next !== null) fixes.set(href, next);
  }
  return [...fixes].map(([href, newHref]) => ({ href, newHref }));
}

/**
 * Apply `link-fix` rows to a kept file: only the listed hrefs of markdown
 * links change, every other byte stays as it was (T14185).
 *
 * @param content - Doc text.
 * @param fixes - The plan's fixes for this file.
 * @returns The text with exactly those hrefs replaced.
 */
export function applyLinkFixes(
  content: string,
  fixes: readonly { readonly href: string; readonly newHref: string }[],
): string {
  if (fixes.length === 0) return content;
  const byHref = new Map(fixes.map((f) => [f.href, f.newHref]));
  return content.replace(MARKDOWN_LINK, (whole, label: string, href: string) => {
    const next = byHref.get(href);
    return next === undefined ? whole : `${label}(${next})`;
  });
}

/** Folders a repo-wide link fix never edits: history, CLEO state, vendored and built output. */
const NEVER_REWRITTEN_DIRS: ReadonlySet<string> = new Set([
  '.changeset',
  '.cleo',
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'generated',
  'vendor',
  '_archived',
]);

/**
 * Whether a markdown file outside the modernize root may get `link-fix` edits
 * (T14196). Changelogs and changesets are history, so they are never
 * rewritten (they stay listed in a row's `refs`); nor is anything under CLEO
 * state, vendored or built folders.
 *
 * @param repoPath - The file's path relative to the repository root, POSIX.
 * @returns True when the file may be edited.
 */
export function repoLinkFixAllowed(repoPath: string): boolean {
  const parts = repoPath.split('/');
  const name = parts.at(-1) ?? '';
  if (!/\.md$/i.test(name) || /^changelog(\.|$)/i.test(name)) return false;
  return !parts.slice(0, -1).some((part) => NEVER_REWRITTEN_DIRS.has(part));
}

/**
 * Where every planned file ends up: a survivor at its target, a merged or
 * deleted file at its survivor's target (T14185).
 *
 * @param rows - The plan rows.
 * @returns Root-relative old path → final path.
 */
export function finalPaths(rows: readonly DocsModernizePlanRow[]): Map<string, string> {
  const survivorBySlug = new Map(
    rows
      .filter((r) => r.disposition === 'keep' || r.disposition === 'rename')
      .map((r) => [r.slug, r]),
  );
  const finalPathOf = new Map<string, string>();
  for (const row of rows) {
    if (row.disposition === 'keep' || row.disposition === 'rename') {
      finalPathOf.set(row.path, row.target ?? row.path);
    } else {
      const survivor = row.target ? survivorBySlug.get(row.target) : undefined;
      if (survivor) finalPathOf.set(row.path, survivor.target ?? survivor.path);
    }
  }
  return finalPathOf;
}

/**
 * Turn relative markdown links to planned files into `[[slug]]` /
 * `[[slug|label]]` wikilinks: the opt-in `--wikilinks` mode (T14185). Only a
 * planned file's final slug is ever written, so every wikilink resolves.
 *
 * @param content - Doc text.
 * @param fromPath - The doc's own path relative to the root (resolves `../x.md`).
 * @param slugByPath - Every scanned file's path → its final slug.
 * @returns The rewritten text; links to files outside the plan are left as they are.
 */
export function rewriteDocLinks(
  content: string,
  fromPath: string,
  slugByPath: ReadonlyMap<string, string>,
): string {
  return content.replace(
    /\[([^\]\n]*)\]\(([^)\s]+\.(?:md|txt))(#[^)\s]*)?\)/gi,
    (whole, label: string, href: string) => {
      if (!isRelativeHref(href)) return whole;
      const target = resolveRelative(fromPath, href);
      const slug = target ? slugByPath.get(target) : undefined;
      if (!slug) return whole;
      return label && label !== slug ? `[[${slug}|${label}]]` : `[[${slug}]]`;
    },
  );
}

/**
 * Re-point existing `[[old-name]]` wikilinks to the final slug of the file
 * they named. Only names in `slugRename` change, and its values are planned
 * slugs, so a rewritten wikilink always resolves (T14185).
 *
 * @param content - Doc text.
 * @param slugRename - Old name → final slug.
 * @returns The text with renamed wikilinks.
 */
export function renameWikilinks(content: string, slugRename: ReadonlyMap<string, string>): string {
  return content.replace(WIKILINK_PATTERN, (whole, target: string) => {
    const renamed = slugRename.get(target.trim());
    return renamed ? whole.replace(target, renamed) : whole;
  });
}

/**
 * The planned slugs a body links to: its `[[wikilinks]]` plus the final slug
 * of every planned file its relative markdown links point at (resolved from
 * the file's final path). Feeds the `links-to` graph edges in both link modes.
 *
 * @param content - The body as written.
 * @param atPath - The file's final path, relative to the root.
 * @param slugByFinalPath - Final path → slug, for every planned survivor.
 * @param wikilinkTargets - The body's `[[wikilink]]` targets.
 * @returns Linked slugs, unique, sorted.
 */
export function linkedSlugs(
  content: string,
  atPath: string,
  slugByFinalPath: ReadonlyMap<string, string>,
  wikilinkTargets: readonly string[],
): string[] {
  const out = new Set(wikilinkTargets);
  for (const m of content.matchAll(MARKDOWN_LINK)) {
    const href = m[2] ?? '';
    if (!isRelativeHref(href)) continue;
    const target = resolveRelative(atPath, href);
    const slug = target ? slugByFinalPath.get(target) : undefined;
    if (slug) out.add(slug);
  }
  return [...out].sort();
}
