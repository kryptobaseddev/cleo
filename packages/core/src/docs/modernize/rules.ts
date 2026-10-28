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

import type { DocKindMetadata } from '@cleocode/contracts';
import { WIKILINK_PATTERN } from '../derive-links.js';
import { DOC_NAME_MAX_LENGTH, suggestDocName } from '../doc-name-rule.js';
import { normalizeSlug } from '../slug-normalize.js';

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

/** Version and draft markers: not a naming violation, but versions of one doc share a slug. */
const VERSION_TOKEN = /^(v\d+|final|draft|copy|wip|tmp)$/;

/**
 * Strip task ids, session ids and dates (the T14107 rule, via
 * {@link suggestDocName}) and version/draft markers from a name.
 *
 * @param name - A filename (no extension) or title.
 * @returns The remaining kebab words, or `''` when none are left.
 */
export function stripVolatileTokens(name: string): string {
  const suggested = suggestDocName(name);
  if (suggested === 'doc' && !normalizeSlug(name).split('-').includes('doc')) return '';
  return suggested
    .split('-')
    .filter((w) => w.length > 0 && !VERSION_TOKEN.test(w))
    .join('-');
}

/**
 * The stable slug for a file: the filename without volatile tokens, or the
 * title's when the filename has fewer than two words left. ADRs keep their
 * `adr-NNN-` prefix.
 *
 * @param relPath - Path relative to the modernize root.
 * @param content - File text.
 * @param kind - The file's kind.
 * @returns A kebab slug of at most {@link MODERNIZE_SLUG_MAX} characters.
 */
export function stableSlugFor(relPath: string, content: string, kind: string): string {
  const base = (relPath.split('/').pop() ?? '').replace(/\.[^.]+$/, '');
  const adr = /^adr-?(\d+)/i.exec(base);
  let words = stripVolatileTokens(adr ? base.slice(adr[0].length) : base);
  // An ADR's number already identifies it; one word after it is enough.
  if (words.split('-').filter(Boolean).length < (adr ? 1 : 2)) {
    const title = readTitle(content);
    const fromTitle = title ? stripVolatileTokens(title.replace(/^adr[\s-]?\d+[:\s.-]*/i, '')) : '';
    if (fromTitle.split('-').filter(Boolean).length >= 2) words = fromTitle;
  }
  if (!words) words = kind;
  const prefix = adr && kind === 'adr' ? `adr-${adr[1]?.padStart(3, '0')}-` : '';
  const slug = `${prefix}${words}`.slice(0, MODERNIZE_SLUG_MAX).replace(/-+$/, '');
  return slug || kind;
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
 * @param duplicateSlug - The merged doc's slug, cited on what was appended.
 * @returns The merged text (the survivor unchanged when nothing is new).
 */
export function mergeDocBodies(survivor: string, duplicate: string, duplicateSlug: string): string {
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
    appended.push(`## From [[${duplicateSlug}]]\n\n${preamble}\n`);
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
      section.replace(/^##\s+.+$/m, `## ${headingLine} (from [[${duplicateSlug}]])`).trimEnd(),
    );
  }
  if (appended.length === 0) return survivor;
  return `${survivor.trimEnd()}\n\n<!-- merged from [[${duplicateSlug}]] by cleo docs modernize -->\n\n${appended.join('\n\n')}\n`;
}

/**
 * Rewrite relative markdown links to files in the tree, and wikilinks to
 * renamed slugs, into `[[new-slug]]` / `[[new-slug|label]]`.
 *
 * @param content - Doc text.
 * @param fromPath - The doc's own path relative to the root (resolves `../x.md`).
 * @param slugByPath - Every scanned file's path → its final slug.
 * @param slugRename - Old slug → final slug, for existing wikilinks.
 * @returns The rewritten text.
 */
export function rewriteDocLinks(
  content: string,
  fromPath: string,
  slugByPath: ReadonlyMap<string, string>,
  slugRename: ReadonlyMap<string, string>,
): string {
  const dir = fromPath.split('/').slice(0, -1);
  const resolvePath = (href: string): string | null => {
    if (/^[a-z]+:/i.test(href) || href.startsWith('/') || href.startsWith('#')) return null;
    const parts = [...dir];
    for (const part of href.split('#')[0]?.split('/') ?? []) {
      if (part === '' || part === '.') continue;
      if (part === '..') parts.pop();
      else parts.push(decodeURIComponent(part));
    }
    return parts.join('/');
  };
  const linked = content.replace(
    /\[([^\]\n]*)\]\(([^)\s]+\.(?:md|txt))(#[^)\s]*)?\)/gi,
    (whole, label: string, href: string) => {
      const target = resolvePath(href);
      const slug = target ? slugByPath.get(target) : undefined;
      if (!slug) return whole;
      return label && label !== slug ? `[[${slug}|${label}]]` : `[[${slug}]]`;
    },
  );
  return linked.replace(WIKILINK_PATTERN, (whole, target: string) => {
    const renamed = slugRename.get(target.trim());
    return renamed ? whole.replace(target, renamed) : whole;
  });
}
