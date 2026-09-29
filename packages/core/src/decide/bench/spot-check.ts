/**
 * Owner spot-check for the System One benchmark dataset (T12495).
 *
 * Before any spend, a small random sample stratified by site and label is
 * written to a file. The orchestrator shows each item to the owner through
 * the ask tool (the item carries the proposed label and the allowed labels
 * as ready-made options) and writes the answers to a corrections file.
 * {@link applyBenchCorrections} then relabels (or drops) those rows and marks
 * them owner-verified. Both steps are offline: no provider is contacted.
 *
 * @task T12495
 * @epic T12486
 */

import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { createSeededRandom, DEFAULT_BENCH_SEED, shuffled } from './stats.js';
import { type BenchRow, labelsForSite } from './types.js';

/** Default spot-check sample size. */
export const DEFAULT_SPOT_CHECK_SIZE = 30;

/** Characters of each text shown in a spot-check item. */
const SPOT_CHECK_TEXT_CHARS = 280;

/** One item the owner reviews. */
export interface BenchSpotCheckItem {
  /** Dataset row id (the key a correction names). */
  readonly id: string;
  /** Site. */
  readonly site: BenchRow['site'];
  /** The label the builder proposed. */
  readonly proposedLabel: string;
  /** Labels the owner may choose from (the proposed one first). */
  readonly options: readonly string[];
  /** Short, redacted summary of what is being labelled. */
  readonly summary: string;
  /** Why the builder proposed the label. */
  readonly provenance: BenchRow['provenance'];
  /** Already verified by the owner in an earlier round. */
  readonly ownerVerified: boolean;
}

/** The spot-check file. */
export interface BenchSpotCheckFile {
  /** Format version. */
  readonly schemaVersion: 1;
  /** ISO time the sample was drawn. */
  readonly generatedAt: string;
  /** Seed the sample was drawn with. */
  readonly seed: number;
  /** How to answer. */
  readonly instructions: string;
  /** Sampled items. */
  readonly items: readonly BenchSpotCheckItem[];
}

/** Clip a text for display. */
function brief(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= SPOT_CHECK_TEXT_CHARS
    ? flat
    : `${flat.slice(0, SPOT_CHECK_TEXT_CHARS - 1)}…`;
}

/** One-paragraph summary of a row. */
function summarize(row: BenchRow): string {
  if (row.site === 'duplicateDetection') {
    const { a, b } = row.input;
    return `Are these the same work? [${a.id}] ${brief(a.title)} — ${brief(a.description)} || [${b.id}] ${brief(b.title)} — ${brief(b.description)}`;
  }
  if (row.site === 'observationType') {
    return `Which type is this observation? [${row.input.id}] ${brief(row.input.title)} — ${brief(row.input.text)}`;
  }
  const { newer, older } = row.input;
  return `Does the newer decision conflict with or replace the older one? NEWER [${newer.id}] ${brief(newer.decision)} (${brief(newer.rationale)}) || OLDER [${older.id}] ${brief(older.decision)} (${brief(older.rationale)})`;
}

/**
 * Largest-remainder allocation of `size` slots over strata, at least one
 * slot per stratum while slots last.
 */
function allocate(counts: readonly number[], size: number): number[] {
  const total = counts.reduce((s, c) => s + c, 0);
  if (total === 0) return counts.map(() => 0);
  const target = Math.min(size, total);
  const alloc: number[] = counts.map((c) => (c > 0 && target >= counts.length ? 1 : 0));
  let left = target - alloc.reduce((s, a) => s + a, 0);
  const exact = counts.map((c) => (c / total) * left);
  for (const [i, e] of exact.entries()) {
    const add = Math.min(Math.floor(e), (counts[i] ?? 0) - (alloc[i] ?? 0));
    alloc[i] = (alloc[i] ?? 0) + add;
    left -= add;
  }
  const order = exact
    .map((e, i) => ({ i, r: e - Math.floor(e) }))
    .sort((x, y) => y.r - x.r || x.i - y.i);
  while (left > 0) {
    let moved = false;
    for (const { i } of order) {
      if (left === 0) break;
      if ((alloc[i] ?? 0) < (counts[i] ?? 0)) {
        alloc[i] = (alloc[i] ?? 0) + 1;
        left -= 1;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return alloc;
}

/**
 * Draw a random sample stratified by site and label.
 *
 * @param rows - Dataset rows.
 * @param opts - Sample size (default {@link DEFAULT_SPOT_CHECK_SIZE}) and seed.
 * @returns The spot-check file contents.
 */
export function sampleBenchSpotCheck(
  rows: readonly BenchRow[],
  opts: { readonly size?: number; readonly seed?: number; readonly now?: Date } = {},
): BenchSpotCheckFile {
  const seed = opts.seed ?? DEFAULT_BENCH_SEED;
  const random = createSeededRandom(seed ^ 0x5eed);
  const strata = new Map<string, BenchRow[]>();
  for (const r of rows) {
    const key = `${r.site}\u0000${r.label}`;
    strata.set(key, [...(strata.get(key) ?? []), r]);
  }
  const keys = [...strata.keys()].sort();
  const alloc = allocate(
    keys.map((k) => strata.get(k)?.length ?? 0),
    opts.size ?? DEFAULT_SPOT_CHECK_SIZE,
  );
  const items: BenchSpotCheckItem[] = [];
  for (const [i, key] of keys.entries()) {
    for (const row of shuffled(strata.get(key) ?? [], random).slice(0, alloc[i] ?? 0)) {
      const allowed = labelsForSite(row.site);
      items.push({
        id: row.id,
        site: row.site,
        proposedLabel: row.label,
        options: [row.label, ...allowed.filter((l) => l !== row.label)],
        summary: summarize(row),
        provenance: row.provenance,
        ownerVerified: row.ownerVerified === true,
      });
    }
  }
  return {
    schemaVersion: 1,
    generatedAt: (opts.now ?? new Date()).toISOString(),
    seed,
    instructions:
      'For each item, ask the owner (ask tool) to pick one of `options` (the proposed label is first) or "drop" when the pair is not a fair test. Write the answers as {"corrections":[{"id","label"} | {"id","drop":true}]} and pass the file to `cleo decide bench --corrections <file>`. Confirming the proposed label also marks the row owner-verified.',
    items: shuffled(items, random),
  };
}

/** Zod schema of one correction. */
const correctionSchema = z.union([
  z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    note: z.string().optional(),
  }),
  z.object({ id: z.string().min(1), drop: z.literal(true), note: z.string().optional() }),
]);

/** Zod schema of a corrections file: `{ corrections: [...] }` or a bare array. */
const correctionsFileSchema = z.union([
  z.object({ corrections: z.array(correctionSchema) }),
  z.array(correctionSchema),
]);

/** One owner answer: a label for a row, or a drop. */
export type BenchCorrection = z.infer<typeof correctionSchema>;

/** Outcome of {@link applyBenchCorrections}. */
export interface BenchCorrectionsReceipt {
  /** Rows confirmed with the proposed label. */
  readonly confirmed: number;
  /** Rows relabelled. */
  readonly relabelled: number;
  /** Rows removed. */
  readonly dropped: number;
  /** Correction ids that matched no row. */
  readonly unmatched: readonly string[];
  /** Corrections whose label is not allowed for the row's site (not applied). */
  readonly rejected: readonly { readonly id: string; readonly label: string }[];
}

/**
 * Parse a corrections file.
 *
 * @param text - File contents (JSON).
 * @returns The corrections.
 * @throws Error when the JSON or its shape is invalid.
 */
export function parseBenchCorrections(text: string): BenchCorrection[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('corrections file is not JSON');
  }
  const parsed = correctionsFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error('corrections file must be {"corrections":[{"id","label"}|{"id","drop":true}]}');
  }
  return Array.isArray(parsed.data) ? parsed.data : parsed.data.corrections;
}

/**
 * Read and parse a corrections file.
 *
 * @param path - Corrections file.
 * @returns The corrections.
 */
export async function readBenchCorrections(path: string): Promise<BenchCorrection[]> {
  return parseBenchCorrections(await readFile(path, 'utf-8'));
}

/**
 * Apply owner corrections: relabel or drop the named rows and mark every
 * corrected (or confirmed) row owner-verified. A relabelled row keeps its
 * original label in `correctedFrom`.
 *
 * @param rows - Dataset rows.
 * @param corrections - Owner answers.
 * @returns The new rows and a receipt.
 */
export function applyBenchCorrections(
  rows: readonly BenchRow[],
  corrections: readonly BenchCorrection[],
): { rows: BenchRow[]; receipt: BenchCorrectionsReceipt } {
  const byId = new Map(corrections.map((c) => [c.id, c]));
  const seen = new Set<string>();
  const rejected: { id: string; label: string }[] = [];
  let confirmed = 0;
  let relabelled = 0;
  let dropped = 0;
  const out: BenchRow[] = [];
  for (const row of rows) {
    const c = byId.get(row.id);
    if (!c) {
      out.push(row);
      continue;
    }
    seen.add(row.id);
    const note = c.note ? { ownerNote: c.note } : {};
    if ('drop' in c) {
      dropped++;
      continue;
    }
    if (!labelsForSite(row.site).includes(c.label)) {
      rejected.push({ id: row.id, label: c.label });
      out.push(row);
      continue;
    }
    if (c.label === row.label) {
      confirmed++;
      out.push({ ...row, ...note, ownerVerified: true });
    } else {
      relabelled++;
      out.push({
        ...row,
        ...note,
        label: c.label,
        correctedFrom: row.correctedFrom ?? row.label,
        ownerVerified: true,
      });
    }
  }
  return {
    rows: out,
    receipt: {
      confirmed,
      relabelled,
      dropped,
      unmatched: corrections.filter((c) => !seen.has(c.id)).map((c) => c.id),
      rejected,
    },
  };
}
