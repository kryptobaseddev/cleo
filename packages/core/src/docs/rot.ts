/**
 * Docs rot — stale, duplicate and orphaned docs, from git alone (T14111).
 *
 * A doc declares the code it documents in its frontmatter, with the same
 * glob grammar as a skill's `metadata.covers` (gate 32):
 *
 * ```yaml
 * ---
 * covers:
 *   - packages/core/src/release/**
 * ---
 * ```
 *
 * The report reads tracked markdown and main's first-parent history, never
 * the docs store, so CI and a local run see the same thing:
 *
 *   - **stale** — a covered file changed in a later first-parent commit than
 *     the doc's own last change. First-parent with `-m` makes a merged PR one
 *     unit: a PR that changes code and its doc together is not stale.
 *   - **duplicates** — `docs/` files with identical bodies, or H1 titles at
 *     least {@link DOCS_ROT_TITLE_SIMILARITY} alike.
 *   - **orphans** — a covers glob that matches no tracked file, or a `docs/`
 *     file no other tracked file names.
 *   - **flagged** — with a `<base>..<head>` range, the docs whose covers match
 *     a file the range changed and that the range did not update. The
 *     post-merge sweep (T14101) passes a merged PR's range and
 *     {@link flagDocsRotOnTasks} marks that PR's tasks.
 *
 * Skills are out of scope: gate 32 already blocks a PR that changes a
 * skill's covered code without the skill.
 *
 * Cost: one `git ls-files`, one `git log`, one `git grep` and one read per
 * tracked doc: about half a second on this repo.
 *
 * @task T14111
 * @epic T14106
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, join, matchesGlob } from 'node:path';
import type {
  DocsRotCoverageHit,
  DocsRotDuplicate,
  DocsRotOrphan,
  DocsRotResult,
} from '@cleocode/contracts/operations/docs.js';
import { parse as parseYaml } from 'yaml';
import { updateTask } from '../tasks/update.js';
import { similarityScore } from './similarity-check.js';

/** Titles at least this alike (normalised Levenshtein) are reported as duplicates. */
export const DOCS_ROT_TITLE_SIMILARITY = 0.95;

/** Label {@link flagDocsRotOnTasks} adds to a task whose merge left a doc stale. */
export const DOCS_ROT_LABEL = 'docs-update';

/** Tracked markdown that is never a doc for this report (gate 32 owns skills). */
const NOT_DOCS = [/^packages\/skills\//, /(^|\/)CHANGELOG\.md$/, /^\.changeset\//, /^\.cleo\//];

/** Basenames too generic to prove a reference (many files share them). */
const GENERIC_NAMES = new Set(['README.md', 'index.md']);

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** One tracked markdown doc as the report sees it. */
interface ScannedDoc {
  path: string;
  covers: string[];
  title: string | null;
  bodyHash: string;
}

function git(root: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) {
    throw new Error(`git ${args[0]} failed in ${root}: ${r.stderr.trim()}`);
  }
  return r.stdout;
}

function lines(out: string): string[] {
  return out.split('\n').filter((l) => l.length > 0);
}

/**
 * Read a doc's `covers:` globs from its frontmatter. Invalid YAML or a
 * non-list value reads as no covers: the report never fails on one bad doc.
 *
 * @param content - Full markdown text.
 * @returns The declared globs (strings only).
 */
export function readDocCovers(content: string): string[] {
  const m = FRONTMATTER_RE.exec(content);
  if (!m) return [];
  try {
    const fm: unknown = parseYaml(m[1] ?? '');
    if (fm === null || typeof fm !== 'object' || !('covers' in fm)) return [];
    const covers = fm.covers;
    return Array.isArray(covers) ? covers.filter((g): g is string => typeof g === 'string') : [];
  } catch {
    return [];
  }
}

function scanDoc(root: string, path: string): ScannedDoc {
  const content = readFileSync(join(root, path), 'utf8');
  const body = content.replace(FRONTMATTER_RE, '');
  const title = /^#\s+(.+)$/m.exec(body)?.[1]?.trim().toLowerCase() ?? null;
  const normalised = body.replace(/\s+/g, ' ').trim();
  return {
    path,
    covers: readDocCovers(content),
    title,
    bodyHash: createHash('sha256').update(normalised).digest('hex'),
  };
}

function matchesAny(file: string, globs: readonly string[]): boolean {
  return globs.some((g) => g === file || matchesGlob(file, g));
}

/**
 * Docs whose covers match a changed file, for every doc the change did not
 * itself update.
 *
 * @param docs - Docs that declare covers.
 * @param changed - Files the change touched.
 * @returns One hit per affected doc, files sorted.
 */
function coverageHits(
  docs: readonly ScannedDoc[],
  changed: ReadonlySet<string>,
): DocsRotCoverageHit[] {
  const hits: DocsRotCoverageHit[] = [];
  for (const doc of docs) {
    if (changed.has(doc.path)) continue;
    const files = [...changed].filter((f) => matchesAny(f, doc.covers)).sort();
    if (files.length > 0) hits.push({ doc: doc.path, files });
  }
  return hits;
}

/**
 * Walk main's first-parent history newest-first: a covered file seen before
 * (newer than) its doc's own last change is stale.
 */
function findStale(root: string, docs: readonly ScannedDoc[]): DocsRotCoverageHit[] {
  if (docs.length === 0) return [];
  const pending = new Map(docs.map((d) => [d.path, d]));
  const newer = new Set<string>();
  const stale: DocsRotCoverageHit[] = [];
  const log = git(root, ['log', '--first-parent', '-m', '--format=%x01', '--name-only', 'HEAD']);
  for (const commit of log.split('\x01')) {
    if (pending.size === 0) break;
    const files = lines(commit);
    for (const path of files) {
      const doc = pending.get(path);
      if (doc === undefined) continue;
      pending.delete(path);
      const changed = [...newer].filter((f) => matchesAny(f, doc.covers)).sort();
      if (changed.length > 0) stale.push({ doc: path, files: changed });
    }
    for (const f of files) newer.add(f);
  }
  return stale.sort((a, b) => a.doc.localeCompare(b.doc));
}

function findDuplicates(docs: readonly ScannedDoc[]): DocsRotDuplicate[] {
  const out: DocsRotDuplicate[] = [];
  const byHash = new Map<string, string[]>();
  for (const d of docs) byHash.set(d.bodyHash, [...(byHash.get(d.bodyHash) ?? []), d.path]);
  const sameContent = new Set<string>();
  for (const group of byHash.values()) {
    if (group.length < 2) continue;
    out.push({ reason: 'content', docs: [...group].sort() });
    for (const p of group) sameContent.add(p);
  }
  const titled = docs.filter((d) => d.title !== null && !sameContent.has(d.path));
  for (let i = 0; i < titled.length; i++) {
    for (let j = i + 1; j < titled.length; j++) {
      const a = titled[i]!.title!;
      const b = titled[j]!.title!;
      // Cheap length bound first: two titles this far apart in length cannot reach the threshold.
      if (Math.min(a.length, b.length) / Math.max(a.length, b.length) < DOCS_ROT_TITLE_SIMILARITY) {
        continue;
      }
      if (similarityScore(a, b) >= DOCS_ROT_TITLE_SIMILARITY) {
        out.push({ reason: 'title', docs: [titled[i]!.path, titled[j]!.path].sort() });
      }
    }
  }
  return out;
}

function findOrphans(
  root: string,
  docs: readonly ScannedDoc[],
  tracked: readonly string[],
): DocsRotOrphan[] {
  const orphans: DocsRotOrphan[] = [];
  for (const d of docs) {
    const dead = d.covers.filter((g) => !tracked.some((f) => f === g || matchesGlob(f, g)));
    if (dead.length > 0) orphans.push({ doc: d.path, reason: 'dead-covers', globs: dead });
  }
  const named = docs.filter(
    (d) => d.path.startsWith('docs/') && !GENERIC_NAMES.has(basename(d.path)),
  );
  if (named.length === 0) return orphans;
  // One `git grep` for every `*.md` name in the repo; a doc naming only itself
  // is no reference. PCRE is ~7x faster here; git built without it gets -E.
  const grep = (mode: string, re: string) =>
    spawnSync('git', ['grep', '-I', '-o', mode, re], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
  let r = grep('-P', String.raw`[\w.-]+\.md`);
  if (r.status !== 0 && r.status !== 1) r = grep('-E', '[A-Za-z0-9._-]+[.]md');
  const referenced = new Set<string>();
  for (const line of lines(r.stdout)) {
    const sep = line.lastIndexOf(':');
    const name = line.slice(sep + 1);
    if (basename(line.slice(0, sep)) !== name) referenced.add(name);
  }
  for (const d of named) {
    if (!referenced.has(basename(d.path))) orphans.push({ doc: d.path, reason: 'unreferenced' });
  }
  return orphans.sort((a, b) => a.doc.localeCompare(b.doc));
}

/**
 * Build the docs-rot report for a git work tree.
 *
 * @param opts.projectRoot - Absolute root of the git work tree.
 * @param opts.changed - Optional `<base>..<head>` range of a merged change.
 * @returns The report; read-only (nothing is written).
 * @task T14111
 */
export function scanDocsRot(opts: { projectRoot: string; changed?: string }): DocsRotResult {
  const started = Date.now();
  const root = opts.projectRoot;
  const tracked = lines(git(root, ['ls-files']));
  const docs = tracked
    .filter((p) => p.endsWith('.md') && !NOT_DOCS.some((re) => re.test(p)))
    .map((p) => scanDoc(root, p));
  const covering = docs.filter((d) => d.covers.length > 0);
  const flagged = opts.changed
    ? coverageHits(covering, new Set(lines(git(root, ['diff', '--name-only', opts.changed]))))
    : [];
  const stale = findStale(root, covering);
  const duplicates = findDuplicates(docs.filter((d) => d.path.startsWith('docs/')));
  const orphans = findOrphans(root, docs, tracked);
  const summary =
    `${docs.length} docs (${covering.length} declare covers): ${stale.length} stale, ` +
    `${duplicates.length} duplicate groups, ${orphans.length} orphaned` +
    (opts.changed ? `, ${flagged.length} flagged by ${opts.changed}` : '');
  return {
    scanned: docs.length,
    covering: covering.length,
    stale,
    duplicates,
    orphans,
    flagged,
    durationMs: Date.now() - started,
    summary,
  };
}

/**
 * Mark each task of a merged change for the docs it left stale: the
 * {@link DOCS_ROT_LABEL} label plus one note per doc naming the covered
 * files. The post-merge sweep (T14101) calls this with the PR's tasks and
 * `scanDocsRot({changed}).flagged`. No hits, no writes.
 *
 * @param projectRoot - Absolute project root.
 * @param taskIds - The merged change's task ids.
 * @param flagged - Hits from {@link scanDocsRot} for that change.
 * @param ref - What changed the code, quoted in the note (e.g. `PR #2550`).
 * @returns The task ids that were updated.
 * @task T14111
 */
export async function flagDocsRotOnTasks(
  projectRoot: string,
  taskIds: readonly string[],
  flagged: readonly DocsRotCoverageHit[],
  ref: string,
): Promise<string[]> {
  if (flagged.length === 0) return [];
  const notes = flagged
    .map(
      (h) => `docs-rot: ${h.doc} covers ${h.files.join(', ')}, changed in ${ref}; update the doc`,
    )
    .join('\n');
  const updated: string[] = [];
  for (const taskId of taskIds) {
    await updateTask({ taskId, addLabels: [DOCS_ROT_LABEL], notes }, projectRoot);
    updated.push(taskId);
  }
  return updated;
}
