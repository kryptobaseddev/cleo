/**
 * Zod validation schemas for {@link AcceptanceGate} and related types.
 *
 * Kept in a separate file from the plain TypeScript types so that consumers
 * that do not need runtime validation (e.g. type-only imports) pay zero cost.
 *
 * All schemas are named `*Schema` and derive their inferred types from the
 * canonical TypeScript interfaces in `./acceptance-gate.ts`.
 *
 * @epic T760
 * @task T763
 * @task T779
 */

import { z } from 'zod';

// ─── Base schema ──────────────────────────────────────────────────────────────

/**
 * Zod schema for {@link GateBase} — fields every gate variant carries.
 *
 * Not exported as a standalone validator because it is always composed into a
 * full gate schema via `z.discriminatedUnion`. Exported so downstream packages
 * can extend it (e.g. for migration or testing).
 */
export const gateBaseSchema = z.object({
  /** Optional GSD-style REQ-ID, e.g. `"TIMER-03"`. */
  req: z.string().optional(),
  /** Human-readable description of what the gate checks. Required. */
  description: z.string().min(1),
  /** When true, failure is recorded as a warning rather than a block. */
  advisory: z.boolean().optional(),
  /** Per-gate timeout override in milliseconds. */
  timeoutMs: z.number().int().positive().optional(),
});

// ─── File assertion schemas ───────────────────────────────────────────────────

/**
 * Zod schema for {@link FileAssertion}.
 *
 * Each variant carries a `type` literal that drives the discriminated union.
 */
export const fileAssertionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('exists') }),
  z.object({ type: z.literal('absent') }),
  z.object({ type: z.literal('nonEmpty') }),
  z.object({ type: z.literal('maxBytes'), value: z.number().int().nonnegative() }),
  z.object({ type: z.literal('minBytes'), value: z.number().int().nonnegative() }),
  z.object({ type: z.literal('contains'), value: z.string() }),
  z.object({
    type: z.literal('matches'),
    /** Serialized `RegExp` source string. */
    regex: z.string().min(1),
    /** Optional `RegExp` flags, e.g. `"gim"`. */
    flags: z.string().optional(),
  }),
  z.object({ type: z.literal('sha256'), value: z.string().length(64) }),
]);

/** Inferred TypeScript type from {@link fileAssertionSchema}. */
export type FileAssertionInput = z.input<typeof fileAssertionSchema>;

// ─── Individual gate schemas ──────────────────────────────────────────────────

/**
 * Zod schema for {@link TestGate}.
 *
 * Validates that `command` is present and `expect` is one of the two allowed
 * literal values.
 */
export const testGateSchema = gateBaseSchema.extend({
  kind: z.literal('test'),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  expect: z.enum(['pass', 'exit0']),
  minCount: z.number().int().nonnegative().optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
});

/** Zod schema for {@link FileGate}. */
export const fileGateSchema = gateBaseSchema.extend({
  kind: z.literal('file'),
  /** Absolute or project-root-relative file path. Mutually exclusive with `attachmentSha256`. */
  path: z.string().min(1).optional(),
  /**
   * SHA-256 hex of an attachment blob. Gate runner resolves the on-disk path
   * via AttachmentStore. Mutually exclusive with `path`.
   */
  attachmentSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'attachmentSha256 must be a 64-char hex string')
    .optional(),
  assertions: z.array(fileAssertionSchema).min(1),
});

/** Zod schema for {@link CommandGate}. */
export const commandGateSchema = gateBaseSchema.extend({
  kind: z.literal('command'),
  cmd: z.string().min(1),
  args: z.array(z.string()).optional(),
  exitCode: z.number().int().optional(),
  stdoutMatches: z.string().optional(),
  stderrMatches: z.string().optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
});

/** Zod schema for {@link LintGate}. */
export const lintGateSchema = gateBaseSchema.extend({
  kind: z.literal('lint'),
  tool: z.enum(['biome', 'eslint', 'tsc', 'prettier', 'rustc', 'clippy']),
  args: z.array(z.string()).optional(),
  expect: z.enum(['clean', 'noErrors']),
  cwd: z.string().optional(),
});

/** Zod schema for {@link HttpGate}. */
export const httpGateSchema = gateBaseSchema.extend({
  kind: z.literal('http'),
  url: z.string().url(),
  method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'DELETE']).optional(),
  status: z.number().int().min(100).max(599),
  bodyMatches: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  startCommand: z.string().optional(),
  startupDelayMs: z.number().int().nonnegative().optional(),
});

/** Zod schema for {@link ManualGate}. */
export const manualGateSchema = gateBaseSchema.extend({
  kind: z.literal('manual'),
  prompt: z.string().min(1),
  verdicts: z.array(z.enum(['pass', 'fail', 'warn'])).optional(),
});

// ─── Discriminated union ──────────────────────────────────────────────────────

/**
 * Zod discriminated-union schema for {@link AcceptanceGate}.
 *
 * Uses `z.discriminatedUnion('kind', [...])` for O(1) variant lookup.
 * Parse with `acceptanceGateSchema.parse(input)` or
 * `acceptanceGateSchema.safeParse(input)`.
 *
 * @example
 * ```ts
 * const gate = acceptanceGateSchema.parse({
 *   kind: 'test',
 *   command: 'pnpm test',
 *   expect: 'pass',
 *   description: 'Test suite must pass',
 * });
 * ```
 */
export const acceptanceGateSchema = z.discriminatedUnion('kind', [
  testGateSchema,
  fileGateSchema,
  commandGateSchema,
  lintGateSchema,
  httpGateSchema,
  manualGateSchema,
]);

/** Inferred TypeScript type from {@link acceptanceGateSchema}. */
export type AcceptanceGateSchemaInput = z.input<typeof acceptanceGateSchema>;

// ─── GateResultDetails schema (T802) ─────────────────────────────────────────

/**
 * Zod discriminated-union schema for {@link GateResultDetails}.
 *
 * Each variant mirrors the corresponding {@link AcceptanceGate} kind so
 * callers can narrow `details` using the `kind` discriminant.
 *
 * @epic T760
 * @task T802
 */
export const gateResultDetailsSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('test'),
    exitCode: z.number().int(),
    stdout: z.string(),
    stderr: z.string(),
    duration: z.number().nonnegative(),
  }),
  z.object({
    kind: z.literal('file'),
    path: z.string().min(1),
    passedAssertions: z.array(z.string()),
    failedAssertions: z.array(z.string()),
  }),
  z.object({
    kind: z.literal('command'),
    cmd: z.string().min(1),
    exitCode: z.number().int(),
    stdout: z.string(),
  }),
  z.object({
    kind: z.literal('lint'),
    tool: z.string().min(1),
    warnings: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal('http'),
    url: z.string(),
    status: z.number().int().min(100).max(599),
    body: z.string(),
  }),
  z.object({
    kind: z.literal('manual'),
    prompt: z.string().min(1),
    accepted: z.boolean(),
  }),
]);

/** Inferred TypeScript type from {@link gateResultDetailsSchema}. */
export type GateResultDetailsInput = z.input<typeof gateResultDetailsSchema>;

// ─── Result schema ────────────────────────────────────────────────────────────

/**
 * Zod schema for {@link AcceptanceGateResult}.
 *
 * Validates the shape produced by the gate runner and stored in
 * `lifecycle_gate_results`.
 */
export const acceptanceGateResultSchema = z.object({
  index: z.number().int().nonnegative(),
  req: z.string().optional(),
  kind: z.enum(['test', 'file', 'command', 'lint', 'http', 'manual']),
  result: z.enum(['pass', 'fail', 'warn', 'skipped', 'error']),
  durationMs: z.number().nonnegative(),
  /** Typed kind-specific detail payload (T802). */
  details: gateResultDetailsSchema.optional(),
  evidence: z.string().optional(),
  errorMessage: z.string().optional(),
  /** ISO 8601 timestamp. */
  checkedAt: z.string().datetime(),
  checkedBy: z.string().min(1),
});

/** Inferred TypeScript type from {@link acceptanceGateResultSchema}. */
export type AcceptanceGateResultInput = z.input<typeof acceptanceGateResultSchema>;

// ─── Mixed acceptance item schema (T780 + T800) ───────────────────────────────

/**
 * Zod schema for a single acceptance criterion — either a non-empty string
 * (legacy) or a structured {@link AcceptanceGate} (machine-verifiable).
 *
 * **Tightened (T800)**: Rejects empty strings, whitespace-only strings, and
 * any non-gate objects. Clear error messages guide callers toward valid input.
 *
 * Strings are validated with `z.string().trim().min(1)` to eliminate empty
 * and whitespace-only criteria. The gate branch uses the existing discriminated-union
 * schema so all six gate kinds (`test`, `file`, `command`, `lint`, `http`, `manual`)
 * are accepted.
 *
 * @example
 * ```ts
 * acceptanceItemSchema.parse('must render in <100ms');      // => 'must render in <100ms'
 * acceptanceItemSchema.parse({ kind: 'test', command: 'pnpm test', expect: 'pass', description: '...' }); // => TestGate
 * acceptanceItemSchema.parse('');                            // ERROR: string must be non-empty
 * acceptanceItemSchema.parse({ foo: 'bar' });               // ERROR: invalid gate object
 * ```
 *
 * @epic T760
 * @task T780
 * @task T800
 */
export const acceptanceItemSchema = z.union([
  z
    .string()
    .trim()
    .min(1, {
      message:
        'Acceptance string criterion must be non-empty. Provide a non-blank description or a valid AcceptanceGate object.',
    })
    .describe('Free-text legacy acceptance criterion (non-empty string)'),
  acceptanceGateSchema.describe('Structured machine-verifiable acceptance gate'),
]);

/** Inferred TypeScript type from {@link acceptanceItemSchema}. */
export type AcceptanceItemInput = z.input<typeof acceptanceItemSchema>;

/**
 * Zod schema for a mixed acceptance array — `(string | AcceptanceGate)[]`.
 *
 * **Tightened (T800)**:
 * - Requires at least 1 item (matching CLEO's anti-hallucination policy).
 * - Rejects duplicate `req:` GSD-style REQ-IDs within the same array.
 *
 * Use this to validate the full `Task.acceptance` field after widening (T780).
 *
 * @example
 * ```ts
 * // Valid: mixed types with unique req IDs
 * acceptanceArraySchema.parse([
 *   'must render in <100ms',
 *   { kind: 'test', command: 'pnpm test', expect: 'pass', description: 'Tests pass', req: 'TEST-01' }
 * ]);
 *
 * // ERROR: empty array
 * acceptanceArraySchema.parse([]);
 *
 * // ERROR: duplicate req:'TEST-01' across two gates
 * acceptanceArraySchema.parse([
 *   { kind: 'test', command: 'pnpm test', expect: 'pass', description: 'Tests pass', req: 'TEST-01' },
 *   { kind: 'file', path: 'README.md', assertions: [{ type: 'exists' }], description: 'README exists', req: 'TEST-01' }
 * ]);
 * ```
 *
 * @epic T760
 * @task T780
 * @task T800
 */
export const acceptanceArraySchema = z
  .array(acceptanceItemSchema)
  .min(1, {
    message:
      'Task must have at least one acceptance criterion. Provide a non-empty string or a valid AcceptanceGate object.',
  })
  .refine(
    (items) => {
      // Extract all req: values from gates (skip plain strings)
      const reqIds = new Set<string>();
      for (const item of items) {
        if (typeof item === 'object' && item !== null && 'req' in item && item.req) {
          if (reqIds.has(item.req)) {
            return false; // Duplicate found
          }
          reqIds.add(item.req);
        }
      }
      return true; // No duplicates
    },
    {
      message:
        'Duplicate req: (REQ-ID) values within the same acceptance array. Each GSD-style requirement ID must be unique. Check for repeated req fields and ensure each gate has a distinct identifier.',
    },
  );

/** Inferred TypeScript type from {@link acceptanceArraySchema}. */
export type AcceptanceArrayInput = z.input<typeof acceptanceArraySchema>;
