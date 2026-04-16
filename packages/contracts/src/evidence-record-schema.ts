/**
 * Zod validation schemas for {@link EvidenceRecord} and its variants.
 *
 * Kept in a separate file from the plain TypeScript types so that consumers
 * that do not need runtime validation (e.g. type-only imports) pay zero cost.
 *
 * All schemas are named `*RecordSchema` and derive their inferred types from
 * the canonical TypeScript interfaces in `./evidence-record.ts`.
 *
 * The top-level {@link evidenceRecordSchema} is a `z.discriminatedUnion` on
 * `"kind"` so Zod can route to the correct variant in O(1).
 *
 * @epic T810
 * @task T816
 */

import { z } from 'zod';

// ─── Shared base fields ───────────────────────────────────────────────────────

/**
 * Zod schema for the provenance fields shared by every EvidenceRecord variant.
 *
 * Not exported as a standalone validator; always composed into a full record
 * schema via `.extend()`.
 */
const evidenceBaseSchema = z.object({
  /** Identity string of the agent that produced this record. */
  agentIdentity: z.string().min(1),
  /** SHA-256 hex digest (64 chars) of the attached artifact. */
  attachmentSha256: z.string().length(64),
  /** ISO 8601 timestamp at which the action ran. */
  ranAt: z.string().datetime(),
  /** Wall-clock duration of the action in milliseconds. */
  durationMs: z.number().nonnegative(),
});

// ─── Individual variant schemas ───────────────────────────────────────────────

/**
 * Zod schema for {@link ImplDiffRecord}.
 *
 * Validates that `filesChanged` is a non-empty array and that `linesAdded` /
 * `linesRemoved` are non-negative integers.
 */
export const implDiffRecordSchema = evidenceBaseSchema.extend({
  kind: z.literal('impl-diff'),
  phase: z.literal('implement'),
  filesChanged: z.array(z.string().min(1)).min(1),
  linesAdded: z.number().int().nonnegative(),
  linesRemoved: z.number().int().nonnegative(),
});

/** Inferred TypeScript type from {@link implDiffRecordSchema}. */
export type ImplDiffRecordInput = z.input<typeof implDiffRecordSchema>;

/**
 * Zod schema for {@link ValidateSpecCheckRecord}.
 *
 * Validates that `reqIdsChecked` is non-empty and `details` is non-blank.
 */
export const validateSpecCheckRecordSchema = evidenceBaseSchema.extend({
  kind: z.literal('validate-spec-check'),
  phase: z.literal('validate'),
  reqIdsChecked: z.array(z.string().min(1)).min(1),
  passed: z.boolean(),
  details: z.string().min(1),
});

/** Inferred TypeScript type from {@link validateSpecCheckRecordSchema}. */
export type ValidateSpecCheckRecordInput = z.input<typeof validateSpecCheckRecordSchema>;

/**
 * Zod schema for {@link TestOutputRecord}.
 *
 * Validates that `command` is non-blank and test counts are non-negative.
 */
export const testOutputRecordSchema = evidenceBaseSchema.extend({
  kind: z.literal('test-output'),
  phase: z.literal('test'),
  command: z.string().min(1),
  exitCode: z.number().int(),
  testsPassed: z.number().int().nonnegative(),
  testsFailed: z.number().int().nonnegative(),
});

/** Inferred TypeScript type from {@link testOutputRecordSchema}. */
export type TestOutputRecordInput = z.input<typeof testOutputRecordSchema>;

/**
 * Zod schema for {@link LintReportRecord}.
 *
 * `phase` is restricted to `'implement' | 'test'`.
 * `warnings` and `errors` are non-negative integers.
 */
export const lintReportRecordSchema = evidenceBaseSchema.extend({
  kind: z.literal('lint-report'),
  phase: z.enum(['implement', 'test']),
  tool: z.string().min(1),
  passed: z.boolean(),
  warnings: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
});

/** Inferred TypeScript type from {@link lintReportRecordSchema}. */
export type LintReportRecordInput = z.input<typeof lintReportRecordSchema>;

/**
 * Zod schema for {@link CommandOutputRecord}.
 *
 * `phase` can be `'implement'`, `'validate'`, or `'test'`.
 * `cmd` must be non-blank.
 */
export const commandOutputRecordSchema = evidenceBaseSchema.extend({
  kind: z.literal('command-output'),
  phase: z.enum(['implement', 'validate', 'test']),
  cmd: z.string().min(1),
  exitCode: z.number().int(),
});

/** Inferred TypeScript type from {@link commandOutputRecordSchema}. */
export type CommandOutputRecordInput = z.input<typeof commandOutputRecordSchema>;

// ─── Discriminated union ──────────────────────────────────────────────────────

/**
 * Zod discriminated-union schema for {@link EvidenceRecord}.
 *
 * Uses `z.discriminatedUnion('kind', [...])` for O(1) variant lookup.
 * Parse with `evidenceRecordSchema.parse(input)` or
 * `evidenceRecordSchema.safeParse(input)`.
 *
 * @example
 * ```ts
 * const rec = evidenceRecordSchema.parse({
 *   kind: 'test-output',
 *   phase: 'test',
 *   agentIdentity: 'T816-worker',
 *   attachmentSha256: 'a'.repeat(64),
 *   command: 'pnpm test',
 *   exitCode: 0,
 *   testsPassed: 10,
 *   testsFailed: 0,
 *   ranAt: '2026-04-16T00:00:00.000Z',
 *   durationMs: 1234,
 * });
 * ```
 */
export const evidenceRecordSchema = z.discriminatedUnion('kind', [
  implDiffRecordSchema,
  validateSpecCheckRecordSchema,
  testOutputRecordSchema,
  lintReportRecordSchema,
  commandOutputRecordSchema,
]);

/** Inferred TypeScript type from {@link evidenceRecordSchema}. */
export type EvidenceRecordInput = z.input<typeof evidenceRecordSchema>;
