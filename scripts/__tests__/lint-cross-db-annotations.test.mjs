/**
 * Poison tests for scripts/lint-cross-db-annotations.mjs.
 *
 * Strategy:
 *   - Each test materialises a synthetic Drizzle schema file into a tmp
 *     directory laid out like `packages/core/src/store/<fixture>-schema.ts`,
 *     points the linter at that tmp root via `cwd`, and asserts on exit code
 *     plus the JSON envelope.
 *   - The synthetic schemas exercise every classification branch:
 *       (1) annotated cross-DB column → exit 0
 *       (2) un-annotated cross-DB column → exit 1
 *       (3) `.references()` intra-DB FK → exit 0 (column-name pattern matches
 *           but the chained call proves intra-DB)
 *       (4) opt-out comment → exit 0
 *       (5) inline single-line JSDoc tag → exit 0
 *       (6) multi-line JSDoc with @cross-db tag → exit 0
 *       (7) baseline mode persists the count; --check tolerates the baseline
 *           but fails on net-add.
 *
 * @task T10324
 * @saga T10281
 * @adr ADR-068
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '../..');
const SCRIPT = join(REPO_ROOT, 'scripts/lint-cross-db-annotations.mjs');

/** @type {string} */
let tmpRoot;
/** @type {string} */
let schemaDir;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cleo-cross-db-lint-'));
  schemaDir = join(tmpRoot, 'packages/core/src/store');
  mkdirSync(schemaDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Write a synthetic Drizzle schema file under the tmp root.
 *
 * @param {string} basename
 * @param {string} body
 */
function writeSchema(basename, body) {
  writeFileSync(join(schemaDir, basename), body);
}

/**
 * Spawn the linter against the tmp root.
 *
 * @param {string[]} extraArgs
 */
function runLint(extraArgs = []) {
  return spawnSync('node', [SCRIPT, '--json', ...extraArgs], {
    encoding: 'utf8',
    cwd: tmpRoot,
  });
}

// ============================================================================
// Annotated → clean
// ============================================================================

describe('lint-cross-db-annotations — annotated column', () => {
  it('exits 0 when a cross-DB column has a @cross-db JSDoc tag', () => {
    writeSchema(
      'fixture-schema.ts',
      `
      import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
      export const fixture = sqliteTable('fixture', {
        /** @cross-db tasks.tasks.id — fixture→tasks soft FK. */
        taskId: text('task_id').notNull(),
      });
      `,
    );
    const result = runLint();
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.count).toBe(0);
  });

  it('exits 0 when @cross-db is inside a multi-line JSDoc block', () => {
    writeSchema(
      'fixture-schema.ts',
      `
      import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
      export const fixture = sqliteTable('fixture', {
        /**
         * Owning session ID.
         *
         * @cross-db tasks.sessions.id — fixture→tasks soft FK.
         */
        sessionId: text('session_id'),
      });
      `,
    );
    const result = runLint();
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.count).toBe(0);
  });
});

// ============================================================================
// Un-annotated → violation
// ============================================================================

describe('lint-cross-db-annotations — un-annotated column', () => {
  it('exits 1 and reports a violation when @cross-db is missing', () => {
    writeSchema(
      'fixture-schema.ts',
      `
      import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
      export const fixture = sqliteTable('fixture', {
        taskId: text('task_id').notNull(),
      });
      `,
    );
    const result = runLint();
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.count).toBe(1);
    expect(parsed.violations[0].column).toBe('task_id');
    expect(parsed.violations[0].property).toBe('taskId');
  });

  it('reports each un-annotated cross-DB column separately', () => {
    writeSchema(
      'fixture-schema.ts',
      `
      import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
      export const fixture = sqliteTable('fixture', {
        agentId: text('agent_id').notNull(),
        epicId: text('epic_id'),
        sessionId: text('session_id'),
      });
      `,
    );
    const result = runLint();
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.count).toBe(3);
    const columns = parsed.violations.map((/** @type {{column: string}} */ v) => v.column).sort();
    expect(columns).toEqual(['agent_id', 'epic_id', 'session_id']);
  });
});

// ============================================================================
// Intra-DB FK via .references() → exempt
// ============================================================================

describe('lint-cross-db-annotations — intra-DB FK via .references()', () => {
  it('exits 0 when the column chains .references()', () => {
    writeSchema(
      'fixture-schema.ts',
      `
      import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
      const tasks = sqliteTable('tasks', { id: text('id').primaryKey() });
      export const fixture = sqliteTable('fixture', {
        taskId: text('task_id')
          .notNull()
          .references(() => tasks.id, { onDelete: 'cascade' }),
      });
      `,
    );
    const result = runLint();
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.count).toBe(0);
  });
});

// ============================================================================
// Opt-out marker → exempt
// ============================================================================

describe('lint-cross-db-annotations — opt-out marker', () => {
  it('exits 0 when the column line carries // cross-db-annotation-ok', () => {
    writeSchema(
      'fixture-schema.ts',
      `
      import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
      export const fixture = sqliteTable('fixture', {
        taskId: text('task_id'), // cross-db-annotation-ok: intra-DB; FK declared on sibling row
      });
      `,
    );
    const result = runLint();
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.count).toBe(0);
  });
});

// ============================================================================
// Intra-DB file allow-list
// ============================================================================

describe('lint-cross-db-annotations — intra-DB file allowlist', () => {
  it('does NOT flag columns inside packages/core/src/store/schema/ subdir', () => {
    const subDir = join(tmpRoot, 'packages/core/src/store/schema');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      join(subDir, 'tasks.ts'),
      `
      import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
      export const audit = sqliteTable('audit', {
        // Lives in tasks.db alongside tasks.id — intra-DB by design.
        taskId: text('task_id').notNull(),
      });
      `,
    );
    const result = runLint();
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.count).toBe(0);
  });

  it('does NOT flag columns inside tasks-schema.ts', () => {
    writeSchema(
      'tasks-schema.ts',
      `
      import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
      export const audit = sqliteTable('audit', {
        taskId: text('task_id').notNull(),
        sessionId: text('session_id'),
      });
      `,
    );
    const result = runLint();
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.count).toBe(0);
  });
});

// ============================================================================
// Baseline + --check
// ============================================================================

describe('lint-cross-db-annotations — baseline + check', () => {
  it('writes a baseline and tolerates the existing count under --check', () => {
    writeSchema(
      'fixture-schema.ts',
      `
      import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
      export const fixture = sqliteTable('fixture', {
        taskId: text('task_id').notNull(),
      });
      `,
    );
    // First write the baseline (count=1).
    const baselineRun = spawnSync('node', [SCRIPT, '--baseline'], {
      encoding: 'utf8',
      cwd: tmpRoot,
    });
    expect(baselineRun.status).toBe(0);
    const baselineFile = JSON.parse(
      readFileSync(join(tmpRoot, 'scripts/.lint-cross-db-annotations-baseline.json'), 'utf8'),
    );
    expect(baselineFile.count).toBe(1);

    // --check should now pass because the count equals the baseline.
    const checkRun = runLint(['--check']);
    expect(checkRun.status).toBe(0);
  });

  it('fails under --check when a NEW un-annotated cross-DB column is added', () => {
    writeSchema(
      'fixture-schema.ts',
      `
      import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
      export const fixture = sqliteTable('fixture', {
        taskId: text('task_id').notNull(),
      });
      `,
    );
    // Capture baseline at count=1.
    spawnSync('node', [SCRIPT, '--baseline'], { encoding: 'utf8', cwd: tmpRoot });

    // Add a second un-annotated cross-DB column.
    writeSchema(
      'fixture-schema.ts',
      `
      import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
      export const fixture = sqliteTable('fixture', {
        taskId: text('task_id').notNull(),
        sessionId: text('session_id'),
      });
      `,
    );
    const checkRun = runLint(['--check']);
    expect(checkRun.status).toBe(1);
  });
});
