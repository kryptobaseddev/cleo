/**
 * `cleo docs modernize <path> --dry-run` — propose, per file, a kind, a
 * stable slug and a disposition (T14113).
 *
 * Steps:
 *
 * 1. Scan `.md` / `.txt` files under the root (the `docs import` scanner),
 *    skipping build, generated and image folders.
 * 2. Classify each file by rules (front matter, folder, filename, headings);
 *    a rule below {@link MODERNIZE_CLASSIFY_FLOOR} is judged by System One
 *    (`docs.modernize.classify`).
 * 3. Derive the stable slug: no task, session or date tokens.
 * 4. Group files by slug. Byte-identical members are deleted in favour of the
 *    survivor; other members merge when their line similarity is high, stay
 *    apart (with a numbered slug) when it is low, and are judged by System
 *    One (`docs.modernize.merge`) in between.
 * 5. Survivors keep or move to `<kind folder>/<slug><ext>`.
 *
 * Read-only: nothing is written except the decision-audit line each System
 * One question gets. The plan is the input to `applyDocsModernize`.
 *
 * @task T14113
 * @epic T14106
 */

import { execFileSync } from 'node:child_process';
import { extname, relative, sep } from 'node:path';
import type {
  DocKindMetadata,
  DocsModernizeDisposition,
  DocsModernizeJudgment,
  DocsModernizeOverride,
  DocsModernizeOverrides,
  DocsModernizePlan,
  DocsModernizePlanRow,
} from '@cleocode/contracts';
import { DocKindRegistry } from '@cleocode/contracts/docs-taxonomy.js';
import type { DecideOptions } from '../../decide/client.js';
import type { DecisionSiteMode } from '../../decide/site.js';
import { createAttachmentStore } from '../../store/attachment-store.js';
import { DEFAULT_EXCLUDE_DIRS, type ScannedFile, scanDirectory } from '../import/scanner.js';
import { normalizeSlug } from '../slug-normalize.js';
import { judgeDocKind, judgeDocMerge, resolveModernizeJudgeSettings } from './judge.js';
import {
  classifyDocByRules,
  docSimilarity,
  folderKind,
  MODERNIZE_CLASSIFY_FLOOR,
  MODERNIZE_MERGE_APART,
  MODERNIZE_MERGE_SURE,
  readTitle,
  stableSlugFor,
  stripVolatileTokens,
  versionOf,
} from './rules.js';

/** Folders modernize never descends into, beyond the scanner's defaults. */
export const MODERNIZE_EXCLUDE_DIRS: ReadonlySet<string> = new Set([
  ...DEFAULT_EXCLUDE_DIRS,
  'generated',
  'images',
  'assets',
]);

/** File extensions modernize reads. */
export const MODERNIZE_EXTENSIONS: readonly string[] = ['.md', '.txt'];

/** Options for {@link planDocsModernize}. */
export interface PlanDocsModernizeOptions {
  /** Absolute directory to modernize. */
  readonly root: string;
  /** Project root (kind registry, config, decision audit). */
  readonly projectRoot: string;
  /** Extra folder names to skip. */
  readonly exclude?: readonly string[];
  /** Explicit System One mode for both sites (tests; default from config). */
  readonly mode?: DecisionSiteMode;
  /** Provider wiring forwarded to `decide()` (tests). */
  readonly decide?: DecideOptions;
  /** Clock override (tests). */
  readonly now?: () => Date;
  /** Reviewer decisions keyed by path; they win over rules and System One. */
  readonly overrides?: DocsModernizeOverrides;
  /** Use this kind for every file instead of classifying (bulk ingest). */
  readonly kind?: string;
  /** Ingest every file into the store and leave the folder untouched. */
  readonly storeOnly?: boolean;
  /** Repository root for the `refs` scan (default: the project root). */
  readonly repoRoot?: string;
}

/** A plan row before the link, category, refs and override fields are added. */
type CoreRow = Omit<
  DocsModernizePlanRow,
  'ownerTasks' | 'category' | 'refs' | 'overridden' | 'covers' | 'baselineRemove'
>;

/**
 * Task and decision ids an old path names (`T1234`, `D11180`), upper-cased,
 * in order of appearance.
 *
 * @param relPath - Path relative to the root.
 * @returns Unique ids.
 */
export function ownerIdsFromPath(relPath: string): string[] {
  const ids = new Set<string>();
  for (const m of relPath.matchAll(/(?:^|[^a-z0-9])([td]\d{3,})(?=[^0-9]|$)/gi)) {
    if (m[1]) ids.add(m[1].toUpperCase());
  }
  return [...ids];
}

/**
 * Tracked files outside `root` that cite any of `paths` (one `git grep`).
 *
 * @param repoRoot - Repository root.
 * @param root - Absolute modernize root.
 * @param paths - Root-relative paths to look for.
 * @returns Root-relative path → citing repo-relative files.
 */
function findRefs(repoRoot: string, root: string, paths: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (paths.length === 0) return out;
  const prefix = relative(repoRoot, root).split(sep).join('/');
  if (prefix.startsWith('..')) return out;
  const needles = paths.map((p) => (prefix ? `${prefix}/${p}` : p));
  const byNeedle = new Map(needles.map((n, i) => [n, paths[i] ?? n]));
  let stdout = '';
  try {
    stdout = execFileSync(
      'git',
      [
        'grep',
        '-o',
        '-F',
        '-I',
        ...needles.flatMap((n) => ['-e', n]),
        '--',
        '.',
        ...(prefix ? [`:!${prefix}/**`] : []),
      ],
      {
        cwd: repoRoot,
        encoding: 'utf-8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
  } catch {
    return out; // exit 1 = no match; not a repo = nothing to report
  }
  for (const line of stdout.split('\n')) {
    const at = line.indexOf(':');
    if (at <= 0) continue;
    const file = line.slice(0, at);
    const path = byNeedle.get(line.slice(at + 1));
    if (!path) continue;
    const list = out.get(path) ?? [];
    if (!list.includes(file)) list.push(file);
    out.set(path, list);
  }
  return out;
}

/** One scanned file with its classification, before grouping. */
interface Candidate {
  readonly file: ScannedFile;
  readonly kind: string;
  readonly slug: string;
  readonly title: string;
  readonly reasons: string[];
  readonly judgments: DocsModernizeJudgment[];
}

/** The folder, relative to the root, that a kind's docs live in. */
export function kindFolder(kind: string, kinds: readonly DocKindMetadata[]): string {
  const publishDir = kinds.find((k) => k.kind === kind)?.publishDir ?? kind;
  if (publishDir === '.' || publishDir === '') return '';
  return publishDir.split('/').filter(Boolean).pop() ?? kind;
}

/** The canonical path of a survivor, relative to the root. */
function canonicalPath(
  relPath: string,
  kind: string,
  slug: string,
  kinds: readonly DocKindMetadata[],
): string {
  const folder = kindFolder(kind, kinds);
  const ext = extname(relPath).toLowerCase() === '.txt' ? '.txt' : '.md';
  return folder ? `${folder}/${slug}${ext}` : `${slug}${ext}`;
}

/**
 * Order survivors first: highest claimed version, then a file already at its
 * canonical path, then the most content, then path order.
 */
function survivorOrder(kinds: readonly DocKindMetadata[]): (a: Candidate, b: Candidate) => number {
  const settled = (c: Candidate): number =>
    canonicalPath(c.file.relPath, c.kind, c.slug, kinds) === c.file.relPath ? 1 : 0;
  return (a, b) =>
    versionOf(b.file.relPath) - versionOf(a.file.relPath) ||
    settled(b) - settled(a) ||
    b.file.content.length - a.file.content.length ||
    a.file.relPath.localeCompare(b.file.relPath);
}

/** Classify one file, asking System One when the rule is unsure. */
async function classify(
  file: ScannedFile,
  kinds: readonly DocKindMetadata[],
  settings: Awaited<ReturnType<typeof resolveModernizeJudgeSettings>>,
  forced: { readonly kind?: string; readonly overridden: boolean },
): Promise<Candidate> {
  const rule = forced.kind
    ? { kind: forced.kind, confidence: 1, reason: 'kind given by the caller' }
    : classifyDocByRules(file.relPath, file.content, kinds);
  const reasons = [`kind ${rule.kind}: ${rule.reason}`];
  const judgments: DocsModernizeJudgment[] = [];
  let kind = rule.kind;
  const title = readTitle(file.content) ?? '';
  if (rule.confidence < MODERNIZE_CLASSIFY_FLOOR && !forced.overridden) {
    const judgment = await judgeDocKind(
      {
        path: file.relPath,
        title,
        content: file.content,
        ruleKind: rule.kind,
        ruleConfidence: rule.confidence,
        kinds,
      },
      settings,
    );
    judgments.push(judgment);
    kind = judgment.acted;
    if (kind !== rule.kind) reasons.push(`kind ${kind}: System One overrode the rule`);
  }
  const slug = stableSlugFor(file.relPath, file.content, kind);
  if (
    slug !==
    file.relPath
      .split('/')
      .pop()
      ?.replace(/\.[^.]+$/, '')
  ) {
    reasons.push(`slug ${slug}: task, session and date tokens dropped from the name`);
  }
  return { file, kind, slug, title: title || slug, reasons, judgments };
}

/**
 * Whether two files live in the same home: the same folder, or folders that
 * name the same kind under one parent (`docs/specs` and `docs/spec`).
 */
function sameHome(a: string, b: string, kinds: readonly DocKindMetadata[]): boolean {
  const dirA = a.split('/').slice(0, -1);
  const dirB = b.split('/').slice(0, -1);
  if (dirA.join('/') === dirB.join('/')) return true;
  if (dirA.slice(0, -1).join('/') !== dirB.slice(0, -1).join('/')) return false;
  const kindA = folderKind(dirA.at(-1) ?? '', kinds);
  return kindA !== null && kindA === folderKind(dirB.at(-1) ?? '', kinds);
}

/** Next free numbered slug (`<slug>-2`, `-3` …). */
function numberedSlug(slug: string, taken: Set<string>): string {
  let n = 2;
  while (taken.has(`${slug}-${n}`)) n += 1;
  return `${slug}-${n}`;
}

/**
 * Plan a modernize run over `options.root`.
 *
 * @param options - Root, project root and System One overrides.
 * @returns The plan: one row per scanned file, sorted by path.
 */
export async function planDocsModernize(
  options: PlanDocsModernizeOptions,
): Promise<DocsModernizePlan> {
  const kinds = DocKindRegistry.load(options.projectRoot).list();
  const settings = await resolveModernizeJudgeSettings(
    options.projectRoot,
    options.decide,
    options.mode,
  );
  const files = await scanDirectory({
    root: options.root,
    extensions: MODERNIZE_EXTENSIONS,
    excludeDirs: new Set([...MODERNIZE_EXCLUDE_DIRS, ...(options.exclude ?? [])]),
  });

  const candidates: Candidate[] = [];
  const overrides = options.overrides ?? {};
  for (const file of files) {
    const override = overrides[file.relPath];
    candidates.push(
      await classify(file, kinds, settings, {
        kind: override?.kind ?? options.kind,
        overridden: override !== undefined,
      }),
    );
  }
  if (options.storeOnly) return finishPlan(options, kinds, candidates.map(storeOnlyRow), files);

  const groups = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const group = groups.get(c.slug) ?? [];
    group.push(c);
    groups.set(c.slug, group);
  }

  const taken = new Set(groups.keys());
  const rows: CoreRow[] = [];
  const survivorRow = (c: Candidate, slug: string): CoreRow => {
    const target = canonicalPath(c.file.relPath, c.kind, slug, kinds);
    const disposition: DocsModernizeDisposition = target === c.file.relPath ? 'keep' : 'rename';
    return {
      path: c.file.relPath,
      sha256: c.file.contentSha,
      kind: c.kind,
      slug,
      title: c.title,
      disposition,
      target,
      reasons: disposition === 'rename' ? [...c.reasons, `moves to ${target}`] : c.reasons,
      judgments: c.judgments,
    };
  };

  for (const [slug, group] of groups) {
    const [survivor, ...rest] = [...group].sort(survivorOrder(kinds));
    if (!survivor) continue;
    rows.push(survivorRow(survivor, slug));
    for (const other of rest) {
      const reasons = [...other.reasons];
      const judgments = [...other.judgments];
      const reviewed = overrides[other.file.relPath] ?? overrides[survivor.file.relPath];
      const home = sameHome(survivor.file.relPath, other.file.relPath, kinds);
      if (other.file.contentSha === survivor.file.contentSha && home) {
        rows.push({
          path: other.file.relPath,
          sha256: other.file.contentSha,
          kind: survivor.kind,
          slug,
          title: other.title,
          disposition: 'delete',
          target: slug,
          reasons: [...reasons, `byte-identical to ${survivor.file.relPath}`],
          judgments,
        });
        continue;
      }
      const similarity = docSimilarity(survivor.file.content, other.file.content);
      const pct = Math.round(similarity * 100);
      let verdict: 'merge' | 'separate' =
        home && similarity >= MODERNIZE_MERGE_SURE ? 'merge' : 'separate';
      // Different homes (two packages' api-design.md) never merge by rule:
      // System One or an override decides, and the rule says keep apart.
      const ambiguous = home
        ? similarity >= MODERNIZE_MERGE_APART && similarity < MODERNIZE_MERGE_SURE
        : similarity >= MODERNIZE_MERGE_APART;
      if (ambiguous && !reviewed) {
        const rule =
          home && similarity >= (MODERNIZE_MERGE_APART + MODERNIZE_MERGE_SURE) / 2
            ? 'merge'
            : 'separate';
        const judgment = await judgeDocMerge(
          {
            left: { path: survivor.file.relPath, content: survivor.file.content },
            right: { path: other.file.relPath, content: other.file.content },
            similarity,
            rule,
          },
          settings,
        );
        judgments.push(judgment);
        verdict = judgment.acted === 'merge' ? 'merge' : 'separate';
      }
      if (verdict === 'merge') {
        rows.push({
          path: other.file.relPath,
          sha256: other.file.contentSha,
          kind: survivor.kind,
          slug,
          title: other.title,
          disposition: 'merge-into',
          target: slug,
          reasons: [
            ...reasons,
            `${pct}% of lines shared with ${survivor.file.relPath}; folds into it`,
          ],
          judgments,
        });
      } else {
        const own = numberedSlug(slug, taken);
        taken.add(own);
        const row = survivorRow({ ...other, judgments }, own);
        rows.push({
          ...row,
          reasons: [
            ...row.reasons,
            `shares the name ${slug} with ${survivor.file.relPath} but only ${pct}% of lines; kept apart as ${own}`,
          ],
        });
      }
    }
  }

  // Update before create: a survivor whose slug the store already holds
  // updates that doc when they are alike, and takes a numbered slug when not.
  const store = createAttachmentStore();
  const texts = new Map(files.map((f) => [f.relPath, f.content]));
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || (row.disposition !== 'keep' && row.disposition !== 'rename')) continue;
    const existing = await store.findBySlug(row.slug, options.projectRoot);
    if (existing?.metadata.sha256 === row.sha256) continue;
    const sameBytes = await store.getMetadata(row.sha256, options.projectRoot);
    if (sameBytes) {
      const extras = await store.getExtras(sameBytes.id, options.projectRoot);
      rows[i] = {
        ...row,
        reasons: [
          ...row.reasons,
          `already stored in CleoDocs${extras?.slug ? ` as ${extras.slug}` : ''}; the file moves, the stored doc is left as is`,
        ],
      };
      continue;
    }
    if (!existing) continue;
    const stored = await store.get(existing.metadata.sha256, options.projectRoot);
    const similarity = stored
      ? docSimilarity(stored.bytes.toString('utf-8'), texts.get(row.path) ?? '')
      : 0;
    const pct = Math.round(similarity * 100);
    if (similarity >= MODERNIZE_MERGE_APART) {
      rows[i] = {
        ...row,
        reasons: [
          ...row.reasons,
          `merges into the existing CleoDocs doc ${row.slug} (${pct}% of lines shared; nothing of either is dropped)`,
        ],
      };
      continue;
    }
    let own = numberedSlug(row.slug, taken);
    while ((await store.findBySlug(own, options.projectRoot)) !== null) {
      taken.add(own);
      own = numberedSlug(row.slug, taken);
    }
    taken.add(own);
    const moved = canonicalPath(row.path, row.kind, own, kinds);
    for (let j = 0; j < rows.length; j += 1) {
      const dup = rows[j];
      if (
        dup &&
        dup.target === row.slug &&
        (dup.disposition === 'merge-into' || dup.disposition === 'delete')
      ) {
        rows[j] = { ...dup, slug: own, target: own };
      }
    }
    rows[i] = {
      ...row,
      slug: own,
      target: moved,
      disposition: moved === row.path ? 'keep' : 'rename',
      reasons: [
        ...row.reasons,
        `the store's ${row.slug} is a different doc (${pct}% of lines shared); stored as ${own}`,
      ],
    };
  }

  return finishPlan(options, kinds, rows, files);
}

/** A store-only row: ingest the file as is, owned by its task, without a slug. */
function storeOnlyRow(c: Candidate): CoreRow {
  const owner = ownerIdsFromPath(c.file.relPath).find((id) => id.startsWith('T'));
  return {
    path: c.file.relPath,
    sha256: c.file.contentSha,
    kind: c.kind,
    slug: c.slug,
    title: c.title,
    disposition: 'keep',
    target: null,
    reasons: [
      ...c.reasons,
      `stored without a slug, owned by ${owner ?? 'the project'}; the file stays where it is`,
    ],
    judgments: c.judgments,
  };
}

/** Apply overrides, add links, category and refs, sort and count. */
function finishPlan(
  options: PlanDocsModernizeOptions,
  kinds: readonly DocKindMetadata[],
  coreRows: readonly CoreRow[],
  files: readonly ScannedFile[],
): DocsModernizePlan {
  const overrides = options.overrides ?? {};
  const moved = options.storeOnly
    ? []
    : coreRows.filter((r) => r.disposition !== 'keep' || overrides[r.path]).map((r) => r.path);
  const refs = findRefs(options.repoRoot ?? options.projectRoot, options.root, moved);
  const scanned = new Set(files.map((f) => f.relPath));
  const rows: DocsModernizePlanRow[] = coreRows.map((row) => {
    const override = overrides[row.path];
    const kind = override?.kind ?? row.kind;
    const base = {
      ...row,
      kind,
      ownerTasks: ownerIdsFromPath(row.path),
      category: kindFolder(kind, kinds),
      refs: refs.get(row.path) ?? [],
      overridden: override !== undefined,
      covers: override?.covers ?? [],
      baselineRemove: false,
    };
    const settled = override ? applyOverride(base, override, kinds) : base;
    return { ...settled, baselineRemove: !options.storeOnly && clearsSlugRule(settled) };
  });
  const survivors = new Set(
    rows.filter((r) => r.disposition === 'keep' || r.disposition === 'rename').map((r) => r.slug),
  );
  for (const row of rows) {
    if (!row.overridden) continue;
    if (
      (row.disposition === 'merge-into' || row.disposition === 'delete') &&
      !survivors.has(row.target ?? '')
    ) {
      // @sync-invariant none:input-shape an override that folds a file into no survivor is refused before any write
      throw new DocsModernizeOverrideError(
        `override for ${row.path}: ${row.disposition} must name a survivor's slug (got ${row.target ?? 'none'})`,
      );
    }
  }
  for (const path of Object.keys(overrides)) {
    if (!scanned.has(path)) {
      // @sync-invariant none:input-shape an override for a file the scan did not find is refused before any write
      throw new DocsModernizeOverrideError(
        `override names ${path}, which is not a scanned file under the root`,
      );
    }
  }
  rows.sort((a, b) => a.path.localeCompare(b.path));
  const counts: Record<DocsModernizeDisposition, number> = {
    keep: 0,
    rename: 0,
    'merge-into': 0,
    delete: 0,
  };
  for (const row of rows) counts[row.disposition] += 1;
  return {
    root: options.root,
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
    rows,
    counts,
    mode: options.storeOnly ? 'store-only' : 'tree',
  };
}

/**
 * Apply one reviewer override to a row. `keep` stays at the file's own path;
 * `rename` uses the override's target or the canonical path; `merge-into` and
 * `delete` use the override's target or the row's own survivor slug.
 */
function applyOverride(
  row: DocsModernizePlanRow,
  override: DocsModernizeOverride,
  kinds: readonly DocKindMetadata[],
): DocsModernizePlanRow {
  const slug = override.slug ?? row.slug;
  const wasSurvivor = row.disposition === 'keep' || row.disposition === 'rename';
  let target: string | null;
  if (override.disposition === 'keep') target = row.path;
  else if (override.disposition === 'rename') {
    target =
      override.target ??
      (wasSurvivor && !override.slug && !override.kind
        ? row.target
        : canonicalPath(row.path, row.kind, slug, kinds));
  } else target = override.target ?? (wasSurvivor ? null : row.target);
  return {
    ...row,
    slug,
    disposition: override.disposition,
    target,
    reasons: [...row.reasons, `override: ${override.reason}`],
  };
}

/** Whether the old name broke the slug rule and the row's outcome no longer does. */
function clearsSlugRule(row: CoreRow): boolean {
  const base = normalizeSlug((row.path.split('/').pop() ?? '').replace(/\.[^.]+$/, ''));
  const brokeRule = stripVolatileTokens(base) !== base;
  if (!brokeRule || row.disposition === 'keep') return false;
  return stripVolatileTokens(row.slug) === row.slug;
}

/** Raised when an override names a path the scan did not find. */
export class DocsModernizeOverrideError extends Error {
  /** Stable code for the envelope. */
  readonly code = 'E_MODERNIZE_OVERRIDE';
}
