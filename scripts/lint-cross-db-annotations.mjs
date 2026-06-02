#!/usr/bin/env node
/**
 * Lint rule: enforce `@cross-db <targetRole>.<table>.<column>` JSDoc tags on
 * every cross-database reference column declared in a Drizzle schema.
 *
 * Why this matters (T10324 · Saga T10281 SG-BRAIN-DB-RESILIENCE · Epic T10285 E4-DB-CROSS-LINKS)
 * --------------------------------------------------------------------------
 * SQLite cannot enforce foreign-key constraints across attached database
 * files. Today every cross-DB invariant (brain→tasks, conduit→agent-registry,
 * nexus→tasks, skills→tasks, etc.) is documented inconsistently — some
 * columns carry a `// soft FK to tasks.id in tasks.db` trailing comment,
 * others say nothing, and the accessor layer that performs the actual
 * cross-DB join is the only place the contract is encoded.
 *
 * The `@cross-db` tag formalises the contract at the column declaration:
 *
 *   /\\** @cross-db tasks.tasks.id — brain→tasks soft FK (...) ... *\\/
 *   contextTaskId: text('context_task_id'),
 *
 * The accessor layer can then assert that every cross-DB join it issues is
 * backed by an annotated column, and the T10323 doctor orphan-row report can
 * walk every annotation to identify dangling references on disk.
 *
 * Cross-DB column-name patterns flagged by this linter:
 *   - `task_id`        (foreign tier — tasks.db tasks.id)
 *   - `session_id`     (foreign tier — tasks.db sessions.id)
 *   - `epic_id`        (foreign tier — tasks.db tasks.id WHERE type='epic')
 *   - `project_id`     (foreign tier — nexus.db project_registry.project_id OR project-context.json)
 *   - `agent_id`       (foreign tier — agent_registry_agents.agent_id)
 *   - `*_agent_id`     (foreign tier — agent_registry_agents.agent_id; e.g. from_agent_id)
 *   - `parent_agent_id`
 *   - `brain_anchor`   (foreign tier — brain.db brain_observations.id)
 *   - `derived_from_message_id`
 *   - `*DbPath`        (filesystem pointer to another DB file)
 *
 * Modes
 * -----
 *   (default / --strict)   Fail on ANY un-annotated cross-DB column.
 *   --baseline             Write current count to baseline file; always exit 0.
 *   --check (CI default)   Fail only when current count EXCEEDS baseline count.
 *   --json                 Emit machine-readable JSON to stdout.
 *
 * Intra-DB columns (where the referenced row lives in the SAME DB) are NOT
 * cross-DB references and are EXEMPT from this rule. The linter recognises
 * intra-DB columns by checking for an inline `.references(() => …)` call on
 * the same column — Drizzle's `.references()` only works for columns that
 * reference a table imported from the same schema graph (i.e. the same
 * SQLite file). The presence of `.references(` therefore proves intra-DB.
 *
 * Opt-out
 * -------
 * Append `// cross-db-annotation-ok: <reason>` on the column line for
 * genuinely intra-DB columns that the heuristic mis-classifies. Use sparingly.
 *
 * @task T10324
 * @epic T10285
 * @saga T10281
 * @adr ADR-068 (CLEO Database Charter — Cross-DB Reference Columns subsection)
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, sep } from 'node:path';

// ============================================================================
// CLI args
// ============================================================================

const args = process.argv.slice(2);
const MODE_BASELINE = args.includes('--baseline');
const MODE_CHECK = args.includes('--check');
const MODE_STRICT = args.includes('--strict') || (!MODE_BASELINE && !MODE_CHECK);
const EMIT_JSON = args.includes('--json');

// ============================================================================
// Configuration
// ============================================================================

const ROOT = process.cwd();
const BASELINE_PATH = join(ROOT, 'scripts', '.lint-cross-db-annotations-baseline.json');

/**
 * Directories that contain Drizzle schemas. Each entry is a directory relative
 * to ROOT — every `*-schema.ts` / `schema.ts` / `schema/*.ts` file under these
 * paths is scanned.
 */
const SCAN_DIRS = ['packages/core/src/store', 'packages/core/src/agents'];

/** Directory segments that are never descended into. */
const SKIP_DIR_SEGMENTS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '__snapshots__',
  '__mocks__',
  '__tests__',
  'coverage',
  'migrations',
]);

/** File-name suffixes that are NOT Drizzle schemas. */
const NON_SCHEMA_FILES = new Set(['validation-schemas.ts', 'nexus-validation-schemas.ts']);

const OPT_OUT_MARKER = 'cross-db-annotation-ok';

/**
 * Snake-case column-name patterns that MUST be annotated with `@cross-db`
 * when declared in a Drizzle column expression. Each entry is a string that
 * matches the second argument of `text('...')` / `integer('...')`.
 */
const CROSS_DB_COLUMN_NAMES = new Set([
  'task_id',
  'session_id',
  'epic_id',
  'agent_id',
  'parent_agent_id',
  'from_agent_id',
  'to_agent_id',
  'author_agent_id',
  'reviewer_agent_id',
  'subscriber_agent_id',
  'created_by', // conduit-side topics.created_by ⇒ agent-registry agent
  'brain_anchor',
  'context_epic_id',
  'context_task_id',
  'source_session_id',
  'project_path',
  'brain_db_path',
  'tasks_db_path',
  'derived_from_message_id',
]);

/**
 * Files that are INTRA-DB only by design — they live in the same database as
 * everything they reference, so cross-DB rules do not apply. Currently this
 * is `tasks-schema.ts` (re-export barrel) and every file under
 * `packages/core/src/store/schema/` because that whole subtree models the
 * tasks.db schema and any `task_id` / `session_id` there is an intra-DB FK
 * via `.references(() => …)`.
 */
const INTRA_DB_FILES = new Set([
  'packages/core/src/store/tasks-schema.ts',
  // chain-schema.ts + agent-registry-schema.ts relocated into store/schema/ (T11359);
  // that whole subtree is already exempt via INTRA_DB_DIR_PREFIXES below, so no
  // explicit entries are needed here.
]);

const INTRA_DB_DIR_PREFIXES = ['packages/core/src/store/schema/'];

/**
 * Drizzle Column declaration regex. Captures `column_name` from a row like:
 *   taskId: text('task_id').notNull(),
 *   sessionId: integer('session_id', { ... }),
 *   id: text('id').primaryKey(),
 */
const COLUMN_DECL_RE =
  /^\s*([a-zA-Z_$][\w$]*)\s*:\s*(?:text|integer|real|blob|numeric)\s*\(\s*['"]([a-z][a-z0-9_]*)['"]/;

// ============================================================================
// Disk walk
// ============================================================================

/**
 * Recursively walk a directory and yield Drizzle schema file paths.
 *
 * @param {string} dir Absolute directory.
 * @returns {Generator<string>}
 */
function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIR_SEGMENTS.has(entry)) continue;
    const abs = join(dir, entry);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      yield* walk(abs);
    } else if (st.isFile()) {
      if (extname(entry) !== '.ts') continue;
      if (entry.endsWith('.test.ts') || entry.endsWith('.spec.ts')) continue;
      if (entry.endsWith('.d.ts')) continue;
      if (NON_SCHEMA_FILES.has(entry)) continue;
      // Only schema files: *-schema.ts | schema.ts | files inside a schema/ dir
      const isSchemaFile =
        entry.endsWith('-schema.ts') || entry === 'schema.ts' || dir.split(sep).includes('schema');
      if (!isSchemaFile) continue;
      yield abs;
    }
  }
}

// ============================================================================
// JSDoc lookback
// ============================================================================

/**
 * Determine whether the column declaration at line `idx` has an `@cross-db`
 * tag in the immediately-preceding JSDoc block (including single-line `/** ... *\/`
 * comments and trailing inline `/** @cross-db ... *\/` placed on the same line).
 *
 * @param {string[]} lines File lines.
 * @param {number} idx Zero-based index of the column declaration line.
 * @returns {boolean}
 */
function hasCrossDbTag(lines, idx) {
  // Same-line trailing JSDoc.
  if (/@cross-db\b/.test(lines[idx])) return true;
  // Walk upward past blank lines and contiguous comment lines.
  let i = idx - 1;
  while (i >= 0) {
    const line = lines[i];
    if (line.trim() === '') {
      i -= 1;
      continue;
    }
    // Single-line JSDoc immediately above:  /** @cross-db ... */
    if (/^\s*\/\*\*.*\*\/\s*$/.test(line)) {
      return /@cross-db\b/.test(line);
    }
    // Multi-line JSDoc — closing `*/` on this line. Walk up to the opener.
    if (/^\s*\*\/\s*$/.test(line)) {
      let j = i;
      while (j >= 0) {
        if (/@cross-db\b/.test(lines[j])) return true;
        if (/^\s*\/\*\*/.test(lines[j])) return false;
        j -= 1;
      }
      return false;
    }
    // Anything else above the declaration breaks the JSDoc chain.
    return false;
  }
  return false;
}

/**
 * Check whether the column has an inline `.references(...)` chained call
 * indicating it is an intra-DB FK (Drizzle requires the target table to be
 * importable from the same schema graph, which means the same DB file).
 *
 * Drizzle column declarations can span multiple lines via fluent chains:
 *   taskId: text('task_id')
 *     .notNull()
 *     .references(() => tasks.id, { onDelete: 'cascade' }),
 * The check therefore scans ahead until a line ending with `,` or `})` that
 * closes the column declaration.
 *
 * @param {string[]} lines File lines.
 * @param {number} idx Zero-based index of the column declaration line.
 * @returns {boolean}
 */
function hasReferencesCall(lines, idx) {
  let depth = 0;
  for (let i = idx; i < lines.length && i < idx + 12; i += 1) {
    const line = lines[i];
    if (/\.references\s*\(/.test(line)) return true;
    // Track paren balance so we stop at the column declaration's trailing comma.
    for (const ch of line) {
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
    }
    if (depth <= 0 && i > idx && /,\s*$/.test(line)) return false;
  }
  return false;
}

// ============================================================================
// File classification
// ============================================================================

/**
 * @param {string} relPath POSIX-normalised path relative to ROOT.
 * @returns {boolean}
 */
function isIntraDbFile(relPath) {
  if (INTRA_DB_FILES.has(relPath)) return true;
  for (const prefix of INTRA_DB_DIR_PREFIXES) {
    if (relPath.startsWith(prefix)) return true;
  }
  return false;
}

// ============================================================================
// Lint pass
// ============================================================================

/**
 * @typedef {object} Violation
 * @property {string} file
 * @property {number} line
 * @property {string} column        — snake_case column literal
 * @property {string} property      — TS property name
 * @property {string} message
 */

/**
 * Lint a single schema file.
 *
 * @param {string} abs Absolute path.
 * @returns {Violation[]}
 */
function lintFile(abs) {
  const relPath = relative(ROOT, abs).split(sep).join('/');
  if (isIntraDbFile(relPath)) return [];
  const text = readFileSync(abs, 'utf8');
  const lines = text.split(/\r?\n/);
  const violations = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.includes(OPT_OUT_MARKER)) continue;
    const match = COLUMN_DECL_RE.exec(line);
    if (!match) continue;
    const [, property, column] = match;
    if (!CROSS_DB_COLUMN_NAMES.has(column)) continue;
    // Intra-DB FK via Drizzle .references() — exempt.
    if (hasReferencesCall(lines, i)) continue;
    if (hasCrossDbTag(lines, i)) continue;
    violations.push({
      file: relPath,
      line: i + 1,
      column,
      property,
      message: `Cross-DB column '${column}' missing @cross-db JSDoc tag. Add /** @cross-db <targetRole>.<table>.<column> — ... */ above the declaration, or chain '.references(() => ...)' if the FK is intra-DB.`,
    });
  }
  return violations;
}

// ============================================================================
// Baseline I/O
// ============================================================================

/**
 * @param {{count: number, violations: Violation[]}} payload
 */
function writeBaseline(payload) {
  const dir = dirname(BASELINE_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const body = {
    generatedAt: new Date().toISOString(),
    note: 'Generated by scripts/lint-cross-db-annotations.mjs --baseline. Run --check to detect regressions.',
    gate: 'cross-db-annotations',
    count: payload.count,
    violations: payload.violations,
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(body, null, 2)}\n`);
}

/**
 * @returns {number | null}
 */
function readBaselineCount() {
  if (!existsSync(BASELINE_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
    if (typeof parsed.count === 'number') return parsed.count;
  } catch {
    return null;
  }
  return null;
}

// ============================================================================
// Entry point
// ============================================================================

function main() {
  /** @type {Violation[]} */
  const violations = [];
  for (const relDir of SCAN_DIRS) {
    const abs = join(ROOT, relDir);
    if (!existsSync(abs)) continue;
    for (const file of walk(abs)) {
      violations.push(...lintFile(file));
    }
  }

  const count = violations.length;

  if (EMIT_JSON) {
    process.stdout.write(`${JSON.stringify({ ok: count === 0, count, violations }, null, 2)}\n`);
  }

  if (MODE_BASELINE) {
    writeBaseline({ count, violations });
    if (!EMIT_JSON) {
      process.stdout.write(
        `lint-cross-db-annotations: baseline written (count=${count}) → ${relative(ROOT, BASELINE_PATH)}\n`,
      );
    }
    process.exit(0);
  }

  if (MODE_CHECK) {
    const baselineCount = readBaselineCount();
    if (baselineCount === null) {
      process.stderr.write(
        'lint-cross-db-annotations --check: baseline file missing. Run with --baseline first.\n',
      );
      process.exit(2);
    }
    if (count > baselineCount) {
      process.stderr.write(
        `lint-cross-db-annotations --check: ${count} violations (baseline ${baselineCount}). Net-add of ${count - baselineCount} not allowed.\n`,
      );
      for (const v of violations) {
        process.stderr.write(`  ${v.file}:${v.line}  [${v.column}]  ${v.message}\n`);
      }
      process.exit(1);
    }
    if (!EMIT_JSON) {
      process.stdout.write(
        `lint-cross-db-annotations --check: ok (${count} violations, baseline ${baselineCount})\n`,
      );
    }
    process.exit(0);
  }

  // Strict (default).
  if (count > 0) {
    if (!EMIT_JSON) {
      process.stderr.write(
        `lint-cross-db-annotations: ${count} un-annotated cross-DB column(s).\n`,
      );
      for (const v of violations) {
        process.stderr.write(`  ${v.file}:${v.line}  [${v.column}]  ${v.message}\n`);
      }
    }
    process.exit(MODE_STRICT ? 1 : 0);
  }
  if (!EMIT_JSON) {
    process.stdout.write('lint-cross-db-annotations: ok (0 violations)\n');
  }
  process.exit(0);
}

main();
