/**
 * Update before create (T14109, owner decision D11210 "docs never rot"):
 * `cleo docs add` refuses a doc that likely duplicates an existing one and
 * routes the writer to `cleo docs update <slug>`. A writer who really means a
 * new doc says why with `--new-because <reason>`, and the reason is recorded.
 *
 * A proposed doc is a likely duplicate of an existing doc when any rule hits:
 *  1. exact: its content hash equals the existing doc's (any kind);
 * Only canonical docs (typed with a DocKind) are compared; changesets and
 * per-task rcasd state never are.
 *
 *  2. slug: same kind and normalised Levenshtein score
 *     >= 0.85 (the T10361 scorer), after dropping task-id and numeric tokens
 *     from both slugs;
 *  3. title: same kind and token Jaccard >= 0.8 between normalised titles;
 *  4. content: >= 60 % of the new doc's word 5-grams already appear in an
 *     existing doc of the same kind (both at least 50 words).
 *
 * @task T14109
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { similarityScore } from './slug-similarity.js';

/** Default thresholds; a project may only tighten them (lower values catch more). */
export const DUPLICATE_THRESHOLDS = Object.freeze({ slug: 0.85, title: 0.8, content: 0.6 });

/** Shortest `--new-because` reason accepted. */
export const NEW_BECAUSE_MIN_LENGTH = 15;

/** Kinds that are release plumbing or task working state, never compared. */
const UNCOMPARED_KINDS: ReadonlySet<string> = new Set(['changeset', 'rcasd']);

/** Words a doc needs before its content is compared. */
const MIN_CONTENT_WORDS = 50;

/** Bytes of an existing doc read for the content comparison. */
const MAX_CONTENT_BYTES = 1_048_576;

/** Words that carry no subject in a title. */
const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'for',
  'in',
  'of',
  'on',
  'the',
  'to',
  'with',
  'doc',
  'docs',
  'v2',
  'new',
  'draft',
  'final',
]);

/** A doc a proposed doc is compared with. */
export interface DuplicateCandidate {
  /** The doc's slug. */
  slug: string;
  /** Its kind, when typed. */
  kind: string | null;
  /** Its title: the first `# ` heading, else its description, else its slug. */
  title: string;
  /** SHA-256 of its stored bytes. */
  sha256: string;
  /** Its text, when it is a readable text blob. */
  content: string | null;
}

/** The doc being added. */
export interface ProposedDoc {
  slug?: string;
  kind?: string;
  title?: string;
  /** Its text, when known (file or inline content). */
  content?: string;
  /** SHA-256 of its bytes, when known. */
  sha256?: string;
}

/** Which rule judged two docs the same. */
export type DuplicateRule = 'exact' | 'slug' | 'title' | 'content';

/** An existing doc the proposed doc likely duplicates. */
export interface DuplicateMatch {
  slug: string;
  kind: string | null;
  title: string;
  rule: DuplicateRule;
  /** The rule's score in `[0, 1]` (`1` for an exact match). */
  score: number;
}

/** Thresholds for one check; each defaults to {@link DUPLICATE_THRESHOLDS}. */
export type DuplicateThresholds = Partial<Record<'slug' | 'title' | 'content', number>>;

/** Lowercase alphanumeric tokens without task ids, dates or bare numbers. */
function subjectTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !/^t\d{3,}$/.test(t) && !/^\d+$/.test(t));
}

/** Token Jaccard of two titles, stopwords removed; 0 when either is empty. */
function titleScore(a: string, b: string): number {
  const left = new Set(subjectTokens(a).filter((t) => !STOPWORDS.has(t)));
  const right = new Set(subjectTokens(b).filter((t) => !STOPWORDS.has(t)));
  if (left.size === 0 || right.size === 0) return 0;
  const shared = [...left].filter((t) => right.has(t)).length;
  return shared / (left.size + right.size - shared);
}

/** Word 5-gram shingles of a text. */
function shingles(text: string): Set<string> | null {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.length < MIN_CONTENT_WORDS) return null;
  const out = new Set<string>();
  for (let i = 0; i + 5 <= words.length; i++) out.add(words.slice(i, i + 5).join(' '));
  return out;
}

/** Share of the new text's shingles already in the existing text; 0 when either is short. */
function containment(proposed: Set<string> | null, existing: string | null): number {
  if (proposed === null || existing === null || proposed.size === 0) return 0;
  const theirs = shingles(existing);
  if (theirs === null) return 0;
  let shared = 0;
  for (const s of proposed) if (theirs.has(s)) shared++;
  return shared / proposed.size;
}

/** The slug with task-id and date tokens dropped, for comparison. */
function slugSubject(slug: string): string {
  return subjectTokens(slug).join('-');
}

/**
 * The title of a markdown text: its first `# ` heading, else null.
 *
 * @param content - Markdown text.
 * @returns The heading text, or null.
 */
export function markdownTitle(content: string): string | null {
  const match = /^#\s+(.+?)\s*#*\s*$/m.exec(content);
  return match?.[1] ?? null;
}

/**
 * The existing doc the proposed doc most likely duplicates, judged by the
 * rules in this module's header, strongest rule first; null when none hits.
 *
 * @param proposed - The doc being added.
 * @param existing - The docs already in the store.
 * @param thresholds - Overrides; a value looser than the default is ignored.
 * @returns The best match, or null.
 * @task T14109
 */
export function findDuplicateDoc(
  proposed: ProposedDoc,
  existing: readonly DuplicateCandidate[],
  thresholds: DuplicateThresholds = {},
): DuplicateMatch | null {
  const limit = (rule: 'slug' | 'title' | 'content'): number =>
    Math.min(thresholds[rule] ?? DUPLICATE_THRESHOLDS[rule], DUPLICATE_THRESHOLDS[rule]);
  const proposedShingles = proposed.content === undefined ? null : shingles(proposed.content);
  const proposedSlug = proposed.slug === undefined ? null : slugSubject(proposed.slug);
  const rank: Record<DuplicateRule, number> = { exact: 4, slug: 3, title: 2, content: 1 };
  let best: DuplicateMatch | null = null;
  const consider = (candidate: DuplicateCandidate, rule: DuplicateRule, score: number): void => {
    if (
      best === null ||
      rank[rule] > rank[best.rule] ||
      (rank[rule] === rank[best.rule] && score > best.score)
    )
      best = { slug: candidate.slug, kind: candidate.kind, title: candidate.title, rule, score };
  };
  // Only canonical docs (typed with a DocKind) are compared: an untyped task
  // attachment may share a blob with another owner by design.
  if (proposed.kind === undefined || UNCOMPARED_KINDS.has(proposed.kind)) return null;
  for (const candidate of existing) {
    if (candidate.kind === null || UNCOMPARED_KINDS.has(candidate.kind)) continue;
    if (proposed.slug !== undefined && candidate.slug === proposed.slug) continue;
    if (proposed.sha256 !== undefined && proposed.sha256 === candidate.sha256) {
      consider(candidate, 'exact', 1);
      continue;
    }
    if (proposedSlug !== null && proposedSlug.length > 0 && candidate.kind === proposed.kind) {
      const score = similarityScore(proposedSlug, slugSubject(candidate.slug));
      if (score >= limit('slug')) consider(candidate, 'slug', score);
    }
    if (proposed.title !== undefined && candidate.kind === proposed.kind) {
      const score = titleScore(proposed.title, candidate.title);
      if (score >= limit('title')) consider(candidate, 'title', score);
    }
    const shared =
      candidate.kind === proposed.kind ? containment(proposedShingles, candidate.content) : 0;
    if (shared >= limit('content')) consider(candidate, 'content', shared);
  }
  return best;
}

/**
 * Every doc in the project's store as a {@link DuplicateCandidate}, read
 * through the docs read model over the WHOLE store (T14115: never a page).
 * Exact-content matches need no body. Bodies (up to 1 MB each) are read for
 * the docs of the proposed kind only, which the title and content rules
 * compare; other docs carry their slug as title and no body.
 *
 * @param projectRoot - Project root.
 * @param proposed - The doc being added: its kind bounds the reads.
 * @returns The candidates.
 * @task T14109
 * @task T14115
 */
export async function loadDuplicateCandidates(
  projectRoot: string,
  proposed: { kind?: string } = {},
): Promise<DuplicateCandidate[]> {
  const { createDocsReadModel } = await import('./docs-read-model.js');
  const model = createDocsReadModel(projectRoot);
  const docs = await model.listProjectDocs({ sluggedOnly: true });
  const readable = docs.filter(
    (doc) =>
      proposed.kind !== undefined &&
      doc.kind === proposed.kind &&
      doc.sizeBytes <= MAX_CONTENT_BYTES,
  );
  const bodies =
    readable.length > 0 ? await model.fetchContentBatch(readable) : new Map<string, string>();
  return docs.flatMap((doc) => {
    if (doc.slug === null) return [];
    const text = bodies.get(doc.id) ?? null;
    const content = text !== null && !text.includes('\u0000') ? text : null;
    return [
      {
        slug: doc.slug,
        kind: doc.kind,
        title: (content ? markdownTitle(content) : null) ?? doc.summary ?? doc.slug,
        sha256: doc.sha256,
        content,
      },
    ];
  });
}

/**
 * The refusal text for a likely duplicate: the matching doc's slug, title,
 * kind and rule, and the commands to read it, update it, or add anyway.
 *
 * @param match - The match.
 * @returns The message and the one fix to show first.
 * @task T14109
 */
export function describeDuplicate(match: DuplicateMatch): { message: string; fix: string } {
  const why: Record<DuplicateRule, string> = {
    exact: 'has the same content as',
    slug: `has a slug ${Math.round(match.score * 100)}% similar to`,
    title: `has a title ${Math.round(match.score * 100)}% similar to`,
    content: `repeats ${Math.round(match.score * 100)}% of the text of`,
  };
  return {
    message:
      `This doc ${why[match.rule]} the existing ${match.kind ?? 'doc'} "${match.slug}" ` +
      `(title: "${match.title}"). Update the existing doc instead of adding another: ` +
      `read it with cleo docs fetch ${match.slug}, then cleo docs update ${match.slug}. ` +
      `If it really is a different doc, add it with --new-because "<why it is not ${match.slug}>".`,
    fix: `cleo docs fetch ${match.slug} && cleo docs update ${match.slug}`,
  };
}

/**
 * Record a `--new-because` override: the doc added, the doc it resembled,
 * and the writer's reason (`.cleo/audit/docs-new-because.jsonl`).
 *
 * @param projectRoot - Project root.
 * @param entry - What was added, what it resembled and why it is new.
 * @task T14109
 */
export async function recordNewBecause(
  projectRoot: string,
  entry: { slug: string | null; kind: string | null; resembles: DuplicateMatch; reason: string },
): Promise<void> {
  const dir = join(projectRoot, '.cleo', 'audit');
  await mkdir(dir, { recursive: true });
  await appendFile(
    join(dir, 'docs-new-because.jsonl'),
    `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`,
    'utf-8',
  );
}
