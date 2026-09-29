/**
 * Build the System One benchmark dataset from CLEO's own history (T12495).
 *
 * The control group is CLEO dogfooded: every row is a question a decision
 * site really asks, labelled from what the project's records already say.
 *
 * - `duplicateDetection` — task pairs. Positives: a `duplicates` relation, a
 *   task cancelled with a reason that calls it a duplicate of a named task,
 *   or a note that records a duplicate of a named task. Negatives: pairs of
 *   tasks under the same parent with no relation between them.
 * - `observationType` — observations whose stored type can only have come
 *   from a caller: it is one of the offered options and differs from BOTH
 *   the keyword default the writer applies today and the substring default
 *   it applied before T12494. A type that agrees with a keyword default may
 *   have been defaulted, so it is not used as a label.
 * - `decisionContradiction` — decision pairs. Positives: a supersedes edge
 *   (newer → older). Negatives: random pairs with no supersedes edge between
 *   them. The newer decision's declared `supersedes` is never sent.
 *
 * Pair rows whose text gives the label away (one side names the other's id,
 * or says "duplicate of T123" / "supersedes D12") are dropped
 * ({@link leaksBenchLabel}).
 *
 * Every text field is redacted with the memory redaction patterns System One
 * uses (`redactContent`) and clipped before it is stored, so the dataset file
 * never holds a secret the provider would not have been sent anyway.
 *
 * Pure: the store is read through a {@link BenchSource}; randomness is seeded.
 *
 * @task T12495
 * @epic T12486
 */

import { readFile, writeFile } from 'node:fs/promises';
import {
  classifyObservationTypeByKeywords,
  OBSERVATION_TYPE_OPTIONS,
} from '../../memory/observation-type-decision.js';
import { redactContent } from '../../memory/redaction.js';
import { redactThenClip } from '../site.js';
import { type BenchRandom, createSeededRandom, DEFAULT_BENCH_SEED, shuffled } from './stats.js';
import {
  BENCH_SITES,
  type BenchDecisionRecord,
  type BenchObservationRecord,
  type BenchRow,
  type BenchSite,
  type BenchSource,
  type BenchTaskRecord,
  benchRowSchema,
} from './types.js';

/** Characters kept per text field in the dataset (the site builders clip further). */
export const BENCH_TEXT_MAX_CHARS = 1_000;

/** Default cap on rows per site. */
export const DEFAULT_BENCH_MAX_ROWS_PER_SITE = 400;

/** Default negatives sampled per positive. */
export const DEFAULT_BENCH_NEGATIVES_PER_POSITIVE = 1;

/** Negatives sampled even when a site has few or no positives. */
export const MIN_BENCH_NEGATIVES = 10;

/** Options for {@link buildBenchDataset}. */
export interface BuildBenchDatasetOptions {
  /** Sites to build. Default: all of {@link BENCH_SITES}. */
  readonly sites?: readonly BenchSite[];
  /** PRNG seed. Default {@link DEFAULT_BENCH_SEED}. */
  readonly seed?: number;
  /** Row cap per site. Default {@link DEFAULT_BENCH_MAX_ROWS_PER_SITE}. */
  readonly maxRowsPerSite?: number;
  /** Negatives per positive. Default {@link DEFAULT_BENCH_NEGATIVES_PER_POSITIVE}. */
  readonly negativesPerPositive?: number;
  /** Redaction. Default: the memory redaction patterns (`redactContent`). */
  readonly redact?: (text: string) => string;
}

/** Row counts of a dataset, per site and label. */
export interface BenchDatasetSizes {
  /** Total rows. */
  readonly total: number;
  /** Rows marked owner-verified. */
  readonly ownerVerified: number;
  /** Site → label → rows. */
  readonly bySite: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

/** Keyword default of the observation writer BEFORE T12494 (substring match). */
const LEGACY_TYPE_KEYWORDS: readonly {
  readonly keywords: readonly string[];
  readonly type: string;
}[] = [
  { keywords: ['bug', 'fix', 'error', 'crash'], type: 'bugfix' },
  { keywords: ['refactor', 'rename', 'extract', 'move'], type: 'refactor' },
  { keywords: ['add', 'create', 'implement', 'new'], type: 'feature' },
  { keywords: ['decide', 'chose', 'pick', 'instead'], type: 'decision' },
  { keywords: ['update', 'change', 'modify', 'upgrade'], type: 'change' },
];

/**
 * The type the pre-T12494 writer assigned when the caller gave none: the
 * first keyword group with a SUBSTRING match, else `discovery`.
 *
 * @param text - Observation narrative.
 * @returns The legacy default type.
 */
export function legacyKeywordObservationType(text: string): string {
  const lower = text.toLowerCase();
  for (const { keywords, type } of LEGACY_TYPE_KEYWORDS) {
    if (keywords.some((k) => lower.includes(k))) return type;
  }
  return 'discovery';
}

/** Words that mark a cancellation reason or note as a duplicate verdict. */
const DUPLICATE_WORDS = /\b(duplicat\w*|dup(?:e)?s?|dedup\w*|same as)\b/i;

/** Task ids named in `text`. */
function taskIdsIn(text: string): string[] {
  return [...new Set(text.match(/\bT\d{2,}\b/g) ?? [])];
}

/** A verdict word followed closely by a task or decision id: "duplicate of T123". */
const GIVEAWAY =
  /\b(duplicat\w*|dup(?:e)?s?|dedup\w*|same as|supersed\w*|replac\w*|obsolete\w*)\b[^\n]{0,40}?\b[TD]\d{2,}\b/i;

/**
 * Whether a pair row's text gives its label away: either side names the
 * other's id, or says "duplicate of T123" / "supersedes D12". Such rows are
 * dropped, so a provider is never scored on reading the answer off the text.
 *
 * @param row - A dataset row.
 * @returns True when the text leaks the label.
 */
export function leaksBenchLabel(row: BenchRow): boolean {
  if (row.site === 'observationType') return false;
  const [x, y] =
    row.site === 'duplicateDetection'
      ? [row.input.a, row.input.b]
      : [row.input.newer, row.input.older];
  const textOf = (side: typeof x): string =>
    'title' in side ? `${side.title}\n${side.description}` : `${side.decision}\n${side.rationale}`;
  const mentions = (text: string, id: string): boolean =>
    new RegExp(`\\b${id.replace(/[^\w]/g, '')}\\b`).test(text);
  const xt = textOf(x);
  const yt = textOf(y);
  return mentions(xt, y.id) || mentions(yt, x.id) || GIVEAWAY.test(xt) || GIVEAWAY.test(yt);
}

/** Rows kept: those whose text does not leak the label. */
function fair(row: BenchRow): boolean {
  return !leaksBenchLabel(row);
}

/** Unordered pair key. */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}+${b}` : `${b}+${a}`;
}

/** Redact then clip one text field. */
function clean(text: string | null | undefined, redact: (s: string) => string): string {
  return redactThenClip(text ?? '', BENCH_TEXT_MAX_CHARS, redact);
}

type DuplicateRow = Extract<BenchRow, { site: 'duplicateDetection' }>;
type ObservationRow = Extract<BenchRow, { site: 'observationType' }>;
type ContradictionRow = Extract<BenchRow, { site: 'decisionContradiction' }>;

/** Keep at most `max` rows, balancing positives and negatives. */
function capBalanced<T extends BenchRow>(
  positives: readonly T[],
  negatives: readonly T[],
  max: number,
  random: BenchRandom,
): T[] {
  if (positives.length + negatives.length <= max) return [...positives, ...negatives];
  const half = Math.floor(max / 2);
  const keepPos = Math.min(positives.length, Math.max(half, max - negatives.length));
  const keepNeg = Math.min(negatives.length, max - keepPos);
  return [
    ...shuffled(positives, random).slice(0, keepPos),
    ...shuffled(negatives, random).slice(0, keepNeg),
  ];
}

/** Number of negatives to sample for `positives` positives. */
function negativeTarget(positives: number, perPositive: number): number {
  return Math.max(MIN_BENCH_NEGATIVES, Math.ceil(positives * perPositive));
}

/** Duplicate-detection rows. */
function duplicateRows(
  tasks: readonly BenchTaskRecord[],
  opts: Required<Omit<BuildBenchDatasetOptions, 'sites' | 'seed'>>,
  random: BenchRandom,
): DuplicateRow[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const linked = new Set<string>();
  for (const t of tasks) for (const r of t.relates) linked.add(pairKey(t.id, r.taskId));

  const positives = new Map<string, DuplicateRow>();
  const addPositive = (
    aId: string,
    bId: string,
    rule: DuplicateRow['provenance']['rule'],
    reason: string,
  ): void => {
    const a = byId.get(aId);
    const b = byId.get(bId);
    if (!a || !b || a.id === b.id || !a.title.trim() || !b.title.trim()) return;
    const key = pairKey(a.id, b.id);
    if (positives.has(key)) return;
    const [first, second] = a.id < b.id ? [a, b] : [b, a];
    positives.set(key, {
      id: `duplicateDetection:${key}`,
      site: 'duplicateDetection',
      label: 'duplicate',
      input: {
        a: {
          id: first.id,
          title: clean(first.title, opts.redact),
          description: clean(first.description, opts.redact),
        },
        b: {
          id: second.id,
          title: clean(second.title, opts.redact),
          description: clean(second.description, opts.redact),
        },
      },
      provenance: { sourceIds: [first.id, second.id], rule, reason },
    });
  };

  for (const t of tasks) {
    for (const r of t.relates) {
      if (r.type !== 'duplicates') continue;
      addPositive(
        t.id,
        r.taskId,
        'duplicates-relation',
        `${t.id} has a "duplicates" relation to ${r.taskId}${r.reason ? ` (${clean(r.reason, opts.redact)})` : ''}`,
      );
    }
  }
  for (const t of tasks) {
    const reason = t.cancellationReason ?? '';
    if (!reason || !DUPLICATE_WORDS.test(reason)) continue;
    for (const other of taskIdsIn(reason)) {
      addPositive(
        t.id,
        other,
        'cancelled-duplicate-reason',
        `${t.id} was cancelled as a duplicate of ${other}: "${clean(reason, opts.redact)}"`,
      );
    }
  }
  for (const t of tasks) {
    for (const note of t.notes) {
      if (!DUPLICATE_WORDS.test(note)) continue;
      for (const other of taskIdsIn(note)) {
        addPositive(
          t.id,
          other,
          'note-duplicate-reference',
          `a note on ${t.id} records a duplicate of ${other}: "${clean(note, opts.redact)}"`,
        );
      }
    }
  }

  // Negatives: same-parent pairs with no relation of any kind.
  const byParent = new Map<string, BenchTaskRecord[]>();
  for (const t of tasks) {
    if (!t.parentId || !t.title.trim()) continue;
    const siblings = byParent.get(t.parentId) ?? [];
    siblings.push(t);
    byParent.set(t.parentId, siblings);
  }
  const families = [...byParent.entries()]
    .filter(([, kids]) => kids.length >= 2)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const negatives = new Map<string, DuplicateRow>();
  const want = negativeTarget(positives.size, opts.negativesPerPositive);
  for (let attempt = 0; negatives.size < want && attempt < want * 50; attempt++) {
    const family = families[Math.floor(random() * families.length)];
    if (!family) break;
    const [parentId, kids] = family;
    const a = kids[Math.floor(random() * kids.length)];
    const b = kids[Math.floor(random() * kids.length)];
    if (!a || !b || a.id === b.id) continue;
    const key = pairKey(a.id, b.id);
    if (positives.has(key) || negatives.has(key) || linked.has(key)) continue;
    const [first, second] = a.id < b.id ? [a, b] : [b, a];
    negatives.set(key, {
      id: `duplicateDetection:${key}`,
      site: 'duplicateDetection',
      label: 'distinct',
      input: {
        a: {
          id: first.id,
          title: clean(first.title, opts.redact),
          description: clean(first.description, opts.redact),
        },
        b: {
          id: second.id,
          title: clean(second.title, opts.redact),
          description: clean(second.description, opts.redact),
        },
      },
      provenance: {
        sourceIds: [first.id, second.id],
        rule: 'same-parent-unrelated',
        reason: `${first.id} and ${second.id} share parent ${parentId} and have no relation between them`,
      },
    });
  }
  return capBalanced(
    [...positives.values()].filter(fair),
    [...negatives.values()].filter(fair),
    opts.maxRowsPerSite,
    random,
  );
}

/** Whether `value` is one of the offered observation types. */
function isOfferedType(value: string): boolean {
  return OBSERVATION_TYPE_OPTIONS.some((o) => o === value);
}

/** Observation-type rows. */
function observationRows(
  observations: readonly BenchObservationRecord[],
  opts: Required<Omit<BuildBenchDatasetOptions, 'sites' | 'seed'>>,
  random: BenchRandom,
): ObservationRow[] {
  const rows: ObservationRow[] = [];
  for (const o of observations) {
    const text = o.narrative.trim();
    if (!text || !isOfferedType(o.type)) continue;
    const current = classifyObservationTypeByKeywords(text);
    const legacy = legacyKeywordObservationType(text);
    if (o.type === current || o.type === legacy) continue;
    rows.push({
      id: `observationType:${o.id}`,
      site: 'observationType',
      label: o.type,
      input: { id: o.id, title: clean(o.title, opts.redact), text: clean(text, opts.redact) },
      provenance: {
        sourceIds: [o.id],
        rule: 'explicit-type',
        reason: `stored type "${o.type}" differs from both keyword defaults (current: ${current}, pre-T12494: ${legacy}), so a caller set it`,
      },
    });
  }
  if (rows.length <= opts.maxRowsPerSite) return rows;
  // Stratified down-sampling by type keeps rare types represented.
  const byType = new Map<string, ObservationRow[]>();
  for (const r of rows) byType.set(r.label, [...(byType.get(r.label) ?? []), r]);
  const out: ObservationRow[] = [];
  const types = [...byType.keys()].sort();
  const perType = Math.max(1, Math.floor(opts.maxRowsPerSite / types.length));
  for (const t of types) out.push(...shuffled(byType.get(t) ?? [], random).slice(0, perType));
  return out.slice(0, opts.maxRowsPerSite);
}

/** Decision-contradiction rows. */
function contradictionRows(
  decisions: readonly BenchDecisionRecord[],
  opts: Required<Omit<BuildBenchDatasetOptions, 'sites' | 'seed'>>,
  random: BenchRandom,
): ContradictionRow[] {
  const byId = new Map(decisions.map((d) => [d.id, d]));
  const edges = new Map<string, { newer: string; older: string; via: string }>();
  for (const d of decisions) {
    if (d.supersedes && byId.has(d.supersedes) && d.supersedes !== d.id) {
      edges.set(pairKey(d.id, d.supersedes), {
        newer: d.id,
        older: d.supersedes,
        via: `${d.id}.supersedes = ${d.supersedes}`,
      });
    }
  }
  for (const d of decisions) {
    if (d.supersededBy && byId.has(d.supersededBy) && d.supersededBy !== d.id) {
      const key = pairKey(d.id, d.supersededBy);
      if (!edges.has(key)) {
        edges.set(key, {
          newer: d.supersededBy,
          older: d.id,
          via: `${d.id}.supersededBy = ${d.supersededBy}`,
        });
      }
    }
  }
  const text = (d: BenchDecisionRecord, withType: boolean) => ({
    id: d.id,
    ...(withType ? { type: d.type } : {}),
    decision: clean(d.decision, opts.redact),
    rationale: clean(d.rationale, opts.redact),
  });
  const positives: ContradictionRow[] = [];
  for (const [key, e] of edges) {
    const newer = byId.get(e.newer);
    const older = byId.get(e.older);
    if (!newer || !older) continue;
    positives.push({
      id: `decisionContradiction:${e.newer}>${e.older}`,
      site: 'decisionContradiction',
      label: 'conflict',
      input: { newer: text(newer, true), older: text(older, false) },
      provenance: {
        sourceIds: [e.newer, e.older],
        rule: 'supersedes-edge',
        reason: `supersedes edge ${e.via} (pair ${key}): the newer decision replaces the older one`,
      },
    });
  }
  const pool = [...decisions].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const negatives = new Map<string, ContradictionRow>();
  const want = negativeTarget(positives.length, opts.negativesPerPositive);
  for (let attempt = 0; negatives.size < want && attempt < want * 50; attempt++) {
    const a = pool[Math.floor(random() * pool.length)];
    const b = pool[Math.floor(random() * pool.length)];
    if (!a || !b || a.id === b.id) continue;
    const key = pairKey(a.id, b.id);
    if (edges.has(key) || negatives.has(key)) continue;
    negatives.set(key, {
      id: `decisionContradiction:${a.id}>${b.id}`,
      site: 'decisionContradiction',
      label: 'compatible',
      input: { newer: text(a, true), older: text(b, false) },
      provenance: {
        sourceIds: [a.id, b.id],
        rule: 'random-unlinked-pair',
        reason: `random pair with no supersedes edge between ${a.id} and ${b.id}`,
      },
    });
  }
  return capBalanced(
    positives.filter(fair),
    [...negatives.values()].filter(fair),
    opts.maxRowsPerSite,
    random,
  );
}

/**
 * Build the labelled dataset from a store.
 *
 * @param source - Store port (the accessors in production, records in tests).
 * @param opts - Sites, seed, caps and redaction.
 * @returns Rows, grouped by site in {@link BENCH_SITES} order.
 */
export async function buildBenchDataset(
  source: BenchSource,
  opts: BuildBenchDatasetOptions = {},
): Promise<BenchRow[]> {
  const sites = opts.sites ?? BENCH_SITES;
  const resolved = {
    maxRowsPerSite: opts.maxRowsPerSite ?? DEFAULT_BENCH_MAX_ROWS_PER_SITE,
    negativesPerPositive: opts.negativesPerPositive ?? DEFAULT_BENCH_NEGATIVES_PER_POSITIVE,
    redact: opts.redact ?? ((s: string) => redactContent(s).content),
  };
  const seed = opts.seed ?? DEFAULT_BENCH_SEED;
  const rows: BenchRow[] = [];
  // One generator per site, so adding a site never reshuffles another.
  for (const [k, site] of BENCH_SITES.entries()) {
    if (!sites.includes(site)) continue;
    const random = createSeededRandom(seed + k);
    if (site === 'duplicateDetection') {
      rows.push(...duplicateRows(await source.tasks(), resolved, random));
    } else if (site === 'observationType') {
      rows.push(...observationRows(await source.observations(), resolved, random));
    } else {
      rows.push(...contradictionRows(await source.decisions(), resolved, random));
    }
  }
  return rows;
}

/**
 * Count rows per site and label.
 *
 * @param rows - Dataset rows.
 * @returns The sizes.
 */
export function benchDatasetSizes(rows: readonly BenchRow[]): BenchDatasetSizes {
  const bySite: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    const site = bySite[r.site] ?? {};
    site[r.label] = (site[r.label] ?? 0) + 1;
    bySite[r.site] = site;
  }
  return {
    total: rows.length,
    ownerVerified: rows.filter((r) => r.ownerVerified === true).length,
    bySite,
  };
}

/**
 * Serialise rows as JSONL (one row per line, trailing newline).
 *
 * @param rows - Dataset rows.
 * @returns The JSONL text.
 */
export function serializeBenchDataset(rows: readonly BenchRow[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length > 0 ? '\n' : '');
}

/**
 * Parse and validate JSONL rows.
 *
 * @param text - JSONL text.
 * @returns The rows.
 * @throws Error naming the first invalid line.
 */
export function parseBenchDataset(text: string): BenchRow[] {
  const rows: BenchRow[] = [];
  for (const [i, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      throw new Error(`dataset line ${i + 1} is not JSON`);
    }
    const parsed = benchRowSchema.safeParse(json);
    if (!parsed.success) throw new Error(`dataset line ${i + 1} is not a benchmark row`);
    rows.push(parsed.data);
  }
  return rows;
}

/**
 * Write rows to a JSONL file.
 *
 * @param path - Target file.
 * @param rows - Dataset rows.
 */
export async function writeBenchDataset(path: string, rows: readonly BenchRow[]): Promise<void> {
  await writeFile(path, serializeBenchDataset(rows), { encoding: 'utf-8', mode: 0o600 });
}

/**
 * Read rows from a JSONL file.
 *
 * @param path - Source file.
 * @returns The rows.
 */
export async function readBenchDataset(path: string): Promise<BenchRow[]> {
  return parseBenchDataset(await readFile(path, 'utf-8'));
}
