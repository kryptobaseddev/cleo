/**
 * CI guard: detect new DatabaseSync opens that lack applyPerfPragmas — T9025.
 *
 * Every production DatabaseSync open MUST call applyPerfPragmas immediately
 * after construction to apply the pragma SSoT from specs/sqlite-pragmas.json
 * (ADR-068, T9023). This test scans source files and fails if a new open
 * violates this convention.
 *
 * Allowlist:
 *   - Test files (*__tests__*, *.test.ts, *.spec.ts) — test isolation often
 *     uses :memory: or stub DBs without performance pragmas.
 *   - Files that open :memory: DBs — in-memory databases are ephemeral and
 *     pragma tuning is irrelevant (WAL, mmap, etc. don't apply to :memory:).
 *   - Files where DatabaseSync is used for PRAGMA-only inspection
 *     (schema dump, pragma read) — read-only, no write contention.
 *
 * For each production file with a `new DatabaseSync` call, the test checks
 * that `applyPerfPragmas` appears within PRAGMA_PROXIMITY_LINES lines of the
 * constructor call. If not, it is reported as a violation.
 *
 * How to pass a new intentional escape hatch:
 *   Add the file's relative path (from repo root) to PRAGMA_ESCAPE_HATCHES
 *   below, with a comment explaining the intent.
 *
 * @task T9025
 * @see specs/sqlite-pragmas.json (SSoT for pragma values)
 * @see packages/core/src/store/sqlite-pragmas.ts (applyPerfPragmas implementation)
 * @see ADR-068 (DB Charter — per-DB write ownership)
 */

import { globSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'vitest';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Repo root — resolved relative to this test file. */
const REPO_ROOT = resolve(import.meta.dirname, '../../../../../');

/**
 * Number of lines after a `new DatabaseSync` call within which
 * `applyPerfPragmas` must appear to pass the guard.
 */
const PRAGMA_PROXIMITY_LINES = 5;

/**
 * Files (relative to repo root) that are INTENTIONALLY exempt from the
 * pragma guard. Add a comment for each exemption explaining why it is
 * safe to omit applyPerfPragmas.
 */
const PRAGMA_ESCAPE_HATCHES: ReadonlySet<string> = new Set([
  // Test fixtures — DatabaseSync(:memory:) for schema verification only
  'packages/adapters/src/__tests__/harness-interop.test.ts',
  // Test fixtures — migration integration tests use controlled DBs
  'packages/cleo/src/cli/commands/__tests__/migrate.test.ts',
  // Test fixtures — agent install seeds a real DB path; test teardown removes it
  'packages/cleo/src/cli/commands/__tests__/agent-install.test.ts',
  // Test fixture — doctor-projects opens a minimal DB to check schema
  'packages/cleo/src/cli/commands/__tests__/doctor-projects.test.ts',
  // Agent CLI: opens DBs in read-only diagnostic context (schema/PRAGMA inspect)
  // TODO T9025: review and apply applyPerfPragmas where writes are performed
  'packages/cleo/src/cli/commands/agent.ts',
  // Migration helper: one-shot migration runner, short-lived connection
  // TODO T9025: apply applyPerfPragmas after migration connections
  'packages/cleo/src/cli/commands/migrate-agents-v2.ts',
]);

/**
 * Glob patterns for TypeScript source files to scan.
 * Excludes dist/, node_modules/, and vendored code.
 */
const SCAN_PATTERNS = ['packages/*/src/**/*.ts', 'packages/*/src/**/*.tsx'];

/**
 * Patterns whose match indicates a test/spec file that is auto-excluded.
 */
const TEST_FILE_PATTERNS = [/__tests__/, /\.test\.ts$/, /\.spec\.ts$/];

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

interface PragmaViolation {
  file: string;
  line: number;
  context: string;
}

/**
 * Scan a source file for `new DatabaseSync` calls and verify that
 * `applyPerfPragmas` appears within PRAGMA_PROXIMITY_LINES lines.
 *
 * @param absolutePath - Absolute path to the file.
 * @param relPath - Relative path from repo root (for reporting + allowlist lookup).
 * @returns List of violations found in the file.
 */
function scanFile(absolutePath: string, relPath: string): PragmaViolation[] {
  const content = readFileSync(absolutePath, 'utf-8');
  const lines = content.split('\n');
  const violations: PragmaViolation[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    // Skip if this is not a DatabaseSync instantiation
    if (!line.includes('new DatabaseSync')) continue;

    // :memory: DBs are exempt — pragmas don't apply to in-memory databases
    if (line.includes(':memory:')) continue;

    // Check if any accepted pragma applicator appears within the proximity window.
    // Accepted: applyPerfPragmas (core/cleo) or applyBrainPragmas (brain package).
    const windowEnd = Math.min(i + PRAGMA_PROXIMITY_LINES, lines.length);
    const window = lines.slice(i, windowEnd).join('\n');
    if (window.includes('applyPerfPragmas') || window.includes('applyBrainPragmas')) continue;

    violations.push({
      file: relPath,
      line: i + 1,
      context: line.trim(),
    });
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('pragma drift guard (T9025)', () => {
  it('every production DatabaseSync open calls applyPerfPragmas', () => {
    const violations: PragmaViolation[] = [];

    // Collect all matching TS files
    const files: string[] = [];
    for (const pattern of SCAN_PATTERNS) {
      const matches = globSync(pattern, { cwd: REPO_ROOT });
      files.push(...matches);
    }

    for (const relPath of files) {
      // Auto-exclude test files
      if (TEST_FILE_PATTERNS.some((p) => p.test(relPath))) continue;

      // Skip explicitly allowlisted escape hatches
      if (PRAGMA_ESCAPE_HATCHES.has(relPath)) continue;

      const absolutePath = resolve(REPO_ROOT, relPath);
      const fileViolations = scanFile(absolutePath, relPath);
      violations.push(...fileViolations);
    }

    if (violations.length > 0) {
      const report = violations
        .map(
          (v) =>
            `  ${v.file}:${v.line}\n    ${v.context}\n    → Add applyPerfPragmas(db) within ${PRAGMA_PROXIMITY_LINES} lines, or add to PRAGMA_ESCAPE_HATCHES with justification`,
        )
        .join('\n\n');

      throw new Error(
        `Pragma drift detected: ${violations.length} DatabaseSync open(s) missing applyPerfPragmas:\n\n${report}\n\n` +
          `See packages/core/src/__tests__/pragma-drift-guard.test.ts for allowlist instructions.`,
      );
    }
  });
});
