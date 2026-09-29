/**
 * Types and row schemas for the System One accuracy benchmark (T12495).
 *
 * A benchmark row is ONE labelled question built from CLEO's own history
 * (duplicate task pairs, explicitly typed observations, superseding decision
 * pairs), already redacted. Rows are stored as JSONL; every row carries its
 * provenance (source record ids and the rule that labelled it) so the owner
 * spot-check and any later audit can trace the label back to the store.
 *
 * @task T12495
 * @epic T12486
 */

import { z } from 'zod';
import { OBSERVATION_TYPE_OPTIONS } from '../../memory/observation-type-decision.js';

/** The benchmarked decision sites, by their `decide.sites.*` key name. */
export const BENCH_SITES = [
  'duplicateDetection',
  'observationType',
  'decisionContradiction',
] as const;

/** One of {@link BENCH_SITES}. */
export type BenchSite = (typeof BENCH_SITES)[number];

/** Labels of the duplicate-detection site. `duplicate` is the positive class. */
export const DUPLICATE_LABELS = ['duplicate', 'distinct'] as const;

/** Labels of the decision-contradiction site. `conflict` is the positive class. */
export const CONTRADICTION_LABELS = ['conflict', 'compatible'] as const;

/**
 * The labels a row of `site` may carry.
 *
 * @param site - Benchmarked site.
 * @returns The allowed labels, positive class first for the two-label sites.
 */
export function labelsForSite(site: BenchSite): readonly string[] {
  if (site === 'duplicateDetection') return DUPLICATE_LABELS;
  if (site === 'decisionContradiction') return CONTRADICTION_LABELS;
  return OBSERVATION_TYPE_OPTIONS;
}

/**
 * The positive class of a two-label site, or `null` for a multi-class site
 * (whose precision, recall, F1 and false-positive rate are macro averages).
 *
 * @param site - Benchmarked site.
 * @returns The positive label, or `null`.
 */
export function positiveLabel(site: BenchSite): string | null {
  if (site === 'duplicateDetection') return 'duplicate';
  if (site === 'decisionContradiction') return 'conflict';
  return null;
}

/** Why a row carries its label. */
export const BENCH_LABEL_RULES = [
  'duplicates-relation',
  'cancelled-duplicate-reason',
  'note-duplicate-reference',
  'same-parent-unrelated',
  'explicit-type',
  'supersedes-edge',
  'random-unlinked-pair',
] as const;

/** One of {@link BENCH_LABEL_RULES}. */
export type BenchLabelRule = (typeof BENCH_LABEL_RULES)[number];

const taskTextSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  description: z.string(),
});

const decisionTextSchema = z.object({
  id: z.string().min(1),
  type: z.string().optional(),
  decision: z.string(),
  rationale: z.string(),
});

const provenanceSchema = z.object({
  sourceIds: z.array(z.string().min(1)).min(1),
  rule: z.enum(BENCH_LABEL_RULES),
  reason: z.string().min(1),
});

const rowBase = {
  id: z.string().min(1),
  label: z.string().min(1),
  provenance: provenanceSchema,
  ownerVerified: z.boolean().optional(),
  correctedFrom: z.string().optional(),
  ownerNote: z.string().optional(),
};

/** Zod schema of one dataset row (one JSONL line). */
export const benchRowSchema = z.discriminatedUnion('site', [
  z.object({
    ...rowBase,
    site: z.literal('duplicateDetection'),
    input: z.object({ a: taskTextSchema, b: taskTextSchema }),
  }),
  z.object({
    ...rowBase,
    site: z.literal('observationType'),
    input: z.object({ id: z.string().min(1), title: z.string(), text: z.string() }),
  }),
  z.object({
    ...rowBase,
    site: z.literal('decisionContradiction'),
    input: z.object({ newer: decisionTextSchema, older: decisionTextSchema }),
  }),
]);

/** One labelled, redacted benchmark row. */
export type BenchRow = z.infer<typeof benchRowSchema>;

/** Where a row came from and why it carries its label. */
export type BenchProvenance = BenchRow['provenance'];

/** A task as the dataset builder reads it (from the task accessor). */
export interface BenchTaskRecord {
  /** Task id. */
  readonly id: string;
  /** Title. */
  readonly title: string;
  /** Description (empty when absent). */
  readonly description: string;
  /** Status. */
  readonly status: string;
  /** Parent id, when any. */
  readonly parentId: string | null;
  /** Cancellation reason, when cancelled with one. */
  readonly cancellationReason?: string;
  /** Free-text notes. */
  readonly notes: readonly string[];
  /** Typed relations to other tasks. */
  readonly relates: readonly {
    readonly taskId: string;
    readonly type: string;
    readonly reason?: string;
  }[];
}

/** An observation as the dataset builder reads it (from the brain accessor). */
export interface BenchObservationRecord {
  /** Observation id. */
  readonly id: string;
  /** Stored type. */
  readonly type: string;
  /** Title. */
  readonly title: string;
  /** Narrative (the text the keyword heuristic classifies). */
  readonly narrative: string;
}

/** A decision as the dataset builder reads it (from the brain accessor). */
export interface BenchDecisionRecord {
  /** Decision id. */
  readonly id: string;
  /** Decision type. */
  readonly type: string;
  /** Decision text. */
  readonly decision: string;
  /** Rationale. */
  readonly rationale: string;
  /** Id of the decision this one supersedes, when any. */
  readonly supersedes?: string | null;
  /** Id of the decision that superseded this one, when any. */
  readonly supersededBy?: string | null;
}

/**
 * The store port the dataset builder reads through. The default
 * implementation (`./source.ts`) uses the core task and brain accessors;
 * tests inject records directly.
 */
export interface BenchSource {
  /** Every task, including cancelled and archived ones. */
  tasks(): Promise<readonly BenchTaskRecord[]>;
  /** Every observation, including invalidated ones. */
  observations(): Promise<readonly BenchObservationRecord[]>;
  /** Every decision, including superseded ones. */
  decisions(): Promise<readonly BenchDecisionRecord[]>;
}

/**
 * One provider connection the benchmark compares. The key is sent only as a
 * bearer token and is never written to the results, the report or the log.
 */
export interface BenchConnection {
  /** Profile name shown in the results (e.g. `layahost`, `jev`). */
  readonly name: string;
  /** Provider kind (`layahost`, `jev`, …); informational. */
  readonly provider: string;
  /** Jev-compatible base URL. */
  readonly baseUrl: string;
  /** API key. */
  readonly apiKey: string;
  /** Model; absent → the provider's default. */
  readonly model?: string;
}
