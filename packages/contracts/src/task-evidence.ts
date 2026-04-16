/**
 * TaskEvidence discriminated union — typed evidence references for verification records.
 *
 * Replaces free-text evidence fields in verification records with structured,
 * kind-specific evidence artifacts. Each variant carries a SHA-256 attachment
 * reference, a timestamp, and optional description.
 *
 * Five evidence kinds are supported:
 * - `file`           — a file artifact (source file, output artifact, config)
 * - `log`            — a log stream captured from a process
 * - `screenshot`     — a visual capture (PNG/JPEG/WEBP)
 * - `test-output`    — structured test-runner output
 * - `command-output` — raw stdout/stderr from a shell command
 *
 * @epic T760
 * @task T801
 * @see {@link AcceptanceGateResult} — `evidence` field
 */

import { z } from 'zod';

// ─── Variant interfaces ───────────────────────────────────────────────────────

/**
 * Evidence for a file artifact produced or inspected during verification.
 *
 * The `sha256` is the content hash of the file at capture time, used to
 * look up the blob in the attachment store.
 */
export interface FileEvidence {
  kind: 'file';
  /** SHA-256 hex digest of the file at capture time (attachment ref). */
  sha256: string;
  /** ISO 8601 timestamp when evidence was captured. */
  timestamp: string;
  /** Path to the file, relative to the project root. */
  path: string;
  /** IANA MIME type of the file (e.g. `"text/typescript"`, `"application/pdf"`). */
  mime?: string;
  /** Optional human-readable note about this evidence artifact. */
  description?: string;
}

/**
 * Evidence for a log stream captured from a running process.
 *
 * The `sha256` is the content hash of the captured log text.
 */
export interface LogEvidence {
  kind: 'log';
  /** SHA-256 hex digest of the captured log content. */
  sha256: string;
  /** ISO 8601 timestamp when evidence was captured. */
  timestamp: string;
  /**
   * Source process name or description (e.g. `"pnpm test"`, `"node server.js"`).
   */
  source: string;
  /** Optional human-readable note about this log artifact. */
  description?: string;
}

/**
 * Evidence for a screenshot or visual capture taken during verification.
 *
 * Used for manual gates and UI smoke tests. The `sha256` references the
 * image blob in the attachment store.
 */
export interface ScreenshotEvidence {
  kind: 'screenshot';
  /** SHA-256 hex digest of the image file. */
  sha256: string;
  /** ISO 8601 timestamp when evidence was captured. */
  timestamp: string;
  /**
   * MIME type of the image.
   *
   * @defaultValue "image/png"
   */
  mime?: 'image/png' | 'image/jpeg' | 'image/webp';
  /** Optional human-readable note (e.g. `"dark mode toggle on macOS Chrome"`). */
  description?: string;
}

/**
 * Evidence for structured test-runner output.
 *
 * Carries the summary metrics from the test run alongside the SHA-256
 * reference to the full output blob.
 */
export interface TestOutputEvidence {
  kind: 'test-output';
  /** SHA-256 hex digest of the full test-runner output. */
  sha256: string;
  /** ISO 8601 timestamp when evidence was captured. */
  timestamp: string;
  /** Number of tests that passed. */
  passed: number;
  /** Number of tests that failed. */
  failed: number;
  /** Number of tests skipped or pending. */
  skipped: number;
  /** Exit code of the test process. */
  exitCode: number;
  /** Optional human-readable note about the test run. */
  description?: string;
}

/**
 * Evidence for raw stdout/stderr output from a shell command.
 *
 * The `sha256` references the full output blob in the attachment store.
 */
export interface CommandOutputEvidence {
  kind: 'command-output';
  /** SHA-256 hex digest of the full command output. */
  sha256: string;
  /** ISO 8601 timestamp when evidence was captured. */
  timestamp: string;
  /** The command that was run (e.g. `"pnpm run build"`). */
  cmd: string;
  /** Exit code of the command process. */
  exitCode: number;
  /** Optional human-readable note about the command run. */
  description?: string;
}

// ─── Discriminated union ──────────────────────────────────────────────────────

/**
 * A typed evidence artifact attached to a verification record.
 *
 * Replaces the bare `evidence?: string` field on {@link AcceptanceGateResult}
 * with structured, kind-specific references backed by the attachment store.
 *
 * The `kind` field is the discriminant. All variants carry `sha256` (the
 * attachment store ref), `timestamp`, and optional `description`.
 *
 * @example
 * ```ts
 * const ev: TaskEvidence = {
 *   kind: 'test-output',
 *   sha256: 'a1b2c3...ff',
 *   timestamp: '2026-04-15T10:00:00.000Z',
 *   passed: 42,
 *   failed: 0,
 *   skipped: 2,
 *   exitCode: 0,
 * };
 * ```
 */
export type TaskEvidence =
  | FileEvidence
  | LogEvidence
  | ScreenshotEvidence
  | TestOutputEvidence
  | CommandOutputEvidence;

/** All valid `kind` discriminants for `TaskEvidence`. */
export type TaskEvidenceKind = TaskEvidence['kind'];

// ─── Zod schemas ─────────────────────────────────────────────────────────────

/** Zod schema for {@link FileEvidence}. */
export const fileEvidenceSchema = z.object({
  kind: z.literal('file'),
  sha256: z.string().length(64),
  timestamp: z.string().datetime(),
  path: z.string().min(1),
  mime: z.string().optional(),
  description: z.string().optional(),
});

/** Zod schema for {@link LogEvidence}. */
export const logEvidenceSchema = z.object({
  kind: z.literal('log'),
  sha256: z.string().length(64),
  timestamp: z.string().datetime(),
  source: z.string().min(1),
  description: z.string().optional(),
});

/** Zod schema for {@link ScreenshotEvidence}. */
export const screenshotEvidenceSchema = z.object({
  kind: z.literal('screenshot'),
  sha256: z.string().length(64),
  timestamp: z.string().datetime(),
  mime: z.enum(['image/png', 'image/jpeg', 'image/webp']).optional(),
  description: z.string().optional(),
});

/** Zod schema for {@link TestOutputEvidence}. */
export const testOutputEvidenceSchema = z.object({
  kind: z.literal('test-output'),
  sha256: z.string().length(64),
  timestamp: z.string().datetime(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  exitCode: z.number().int(),
  description: z.string().optional(),
});

/** Zod schema for {@link CommandOutputEvidence}. */
export const commandOutputEvidenceSchema = z.object({
  kind: z.literal('command-output'),
  sha256: z.string().length(64),
  timestamp: z.string().datetime(),
  cmd: z.string().min(1),
  exitCode: z.number().int(),
  description: z.string().optional(),
});

/**
 * Zod discriminated-union schema for {@link TaskEvidence}.
 *
 * Uses `z.discriminatedUnion('kind', [...])` for O(1) variant lookup.
 *
 * @example
 * ```ts
 * const ev = taskEvidenceSchema.parse({
 *   kind: 'command-output',
 *   sha256: 'a'.repeat(64),
 *   timestamp: '2026-04-15T10:00:00.000Z',
 *   cmd: 'pnpm run build',
 *   exitCode: 0,
 * });
 * ```
 */
export const taskEvidenceSchema = z.discriminatedUnion('kind', [
  fileEvidenceSchema,
  logEvidenceSchema,
  screenshotEvidenceSchema,
  testOutputEvidenceSchema,
  commandOutputEvidenceSchema,
]);

/** Inferred TypeScript type from {@link taskEvidenceSchema}. */
export type TaskEvidenceInput = z.input<typeof taskEvidenceSchema>;
