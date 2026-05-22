#!/usr/bin/env node

/**
 * Lint rule: block new `SSoT-EXEMPT` comments without a linked open follow-up task.
 *
 * Why this matters
 * ----------------
 * Saga T9831 SG-ARCH-SOLID introduced `SSoT-EXEMPT` as an escape-hatch comment
 * for code that legitimately deviates from the Architectural SSoT contracts. To
 * prevent the escape-hatch from becoming a dumping ground, every NEW exemption
 * added in a PR MUST include a linked `T####` task ID pointing at an open
 * follow-up task that tracks the eventual removal of the exemption.
 *
 * Valid SSoT-EXEMPT comment formats:
 *
 *   // SSoT-EXEMPT:<reason> (T1234)
 *   // SSoT-EXEMPT: reason T1234
 *   // SSoT-EXEMPT:reason — tracked in T1234
 *
 * The task ID MUST match `T\d+` and the referenced task MUST NOT be in a
 * terminal state (`completed`, `cancelled`, or `deleted`).
 *
 * Modes
 * -----
 *
 * --strict (CI default):
 *   Zero tolerance — NO new SSoT-EXEMPT comments are allowed in the diff at all.
 *   The task-ID check is still run for informational purposes, but any new
 *   exemption immediately fails the gate.
 *
 * --baseline (default when --strict is absent):
 *   Newly added SSoT-EXEMPT comments WITHOUT a linked open task ID fail.
 *   Newly added SSoT-EXEMPT comments WITH a valid open task ID pass.
 *   Comments not in the PR diff are ignored entirely.
 *
 * Base ref
 * --------
 *   --base <ref>   Git ref to diff against (default: origin/main)
 *
 * Opt-out per line
 * ----------------
 *   Append `// ssot-exempt-ok: <reason>` on the SAME line as the SSoT-EXEMPT
 *   comment to suppress this linter for that specific line. Use sparingly.
 *
 * Fallback behaviour
 * ------------------
 *   When no git diff is available (e.g. local run outside a PR context), the
 *   script scans all TypeScript files under `packages/` instead, applying
 *   baseline-mode checks to every SSoT-EXEMPT comment found.
 *
 * @task T10075
 * @epic T9837
 * @saga T9831 SG-ARCH-SOLID
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, posix, relative, sep } from 'node:path';

// ============================================================================
// Patterns & constants
// ============================================================================

/** Matches any SSoT-EXEMPT comment in code. */
const SSOT_EXEMPT_REGEX = /\/\/\s*SSoT-EXEMPT/;

/** Per-line opt-out marker that suppresses this linter for one line. */
const LINT_OPT_OUT_MARKER = 'ssot-exempt-ok:';

/** Extracts a task ID (`T####`) from an SSoT-EXEMPT comment. */
const TASK_ID_REGEX = /\bT(\d+)\b/;

/** Terminal task statuses — tasks in these states are NOT open. */
const CLOSED_STATUSES = new Set(['completed', 'cancelled', 'deleted']);

/** Directories to skip when walking source trees. */
const SKIP_DIR_SEGMENTS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '__snapshots__',
  '__mocks__',
  '__tests__',
  'coverage',
  '.next',
  '.svelte-kit',
  'fixtures',
]);

/** TypeScript-like extensions to scan. */
const SCAN_EXTS = new Set(['.ts', '.tsx', '.mts']);

// ============================================================================
// Violation type (JSDoc)
// ============================================================================

/**
 * @typedef {object} Violation
 * @property {string} file       - POSIX-relative path from repo root.
 * @property {number} lineNumber - 1-based line number.
 * @property {string} content    - Trimmed line content.
 * @property {'no-task-id' | 'task-closed' | 'task-unknown' | 'new-exempt-strict'} kind
 * @property {string} [taskId]
 * @property {string} [taskStatus]
 * @property {string} [taskError]
 */

// ============================================================================
// Git diff helpers
// ============================================================================

/**
 * Get lines ADDED in this PR using `git diff --unified=0 --diff-filter=AM`.
 * Returns an empty array when git is unavailable or the diff is empty.
 *
 * @param {string} baseRef - e.g. `origin/main`
 * @param {string} cwd
 * @returns {Array<{file: string, lineNumber: number, content: string}>}
 */
function getAddedLines(baseRef, cwd) {
  const result = spawnSync(
    'git',
    [
      'diff',
      '--unified=0',
      '--diff-filter=AM',
      `${baseRef}...HEAD`,
      '--',
      '*.ts',
      '*.tsx',
      '*.mts',
    ],
    { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  if (result.error || result.status !== 0 || !result.stdout.trim()) {
    return [];
  }
  return parseDiffAddedLines(result.stdout);
}

/**
 * Parse unified diff output and return only the added (`+`) lines with their
 * destination file path and 1-based line numbers.
 *
 * @param {string} diffOutput
 * @returns {Array<{file: string, lineNumber: number, content: string}>}
 */
function parseDiffAddedLines(diffOutput) {
  /** @type {Array<{file: string, lineNumber: number, content: string}>} */
  const added = [];
  let currentFile = '';
  let newLineNum = 0;

  for (const rawLine of diffOutput.split('\n')) {
    if (rawLine.startsWith('+++ b/')) {
      currentFile = rawLine.slice('+++ b/'.length);
      continue;
    }
    if (rawLine.startsWith('@@')) {
      const m = rawLine.match(/@@ -\d+(?:,\d+)? \+(\d+)/);
      if (m) newLineNum = parseInt(m[1], 10) - 1;
      continue;
    }
    if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
      newLineNum++;
      added.push({ file: currentFile, lineNumber: newLineNum, content: rawLine.slice(1) });
      continue;
    }
    if (!rawLine.startsWith('-')) {
      newLineNum++;
    }
  }
  return added;
}

// ============================================================================
// Fallback: full file scan
// ============================================================================

/**
 * Walk `packages/` and return every line in every TypeScript source file.
 * Used as a fallback when no git diff is available (e.g. local runs).
 *
 * @param {string} cwd
 * @returns {Array<{file: string, lineNumber: number, content: string}>}
 */
function scanAllPackageLines(cwd) {
  /** @type {Array<{file: string, lineNumber: number, content: string}>} */
  const lines = [];

  /** @param {string} dir */
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith('.') || SKIP_DIR_SEGMENTS.has(name)) continue;
      const full = join(dir, name);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full);
      } else if (stat.isFile() && SCAN_EXTS.has(extname(name))) {
        let text;
        try {
          text = readFileSync(full, 'utf8');
        } catch {
          continue;
        }
        const relPath = relative(cwd, full).split(sep).join(posix.sep);
        text.split('\n').forEach((content, idx) => {
          lines.push({ file: relPath, lineNumber: idx + 1, content });
        });
      }
    }
  }

  walk(join(cwd, 'packages'));
  return lines;
}

// ============================================================================
// Cleo task verification
// ============================================================================

/** Result cache to avoid duplicate `cleo show` invocations. */
/** @type {Map<string, {open: boolean, status: string, error?: string}>} */
const taskCache = new Map();

/**
 * Check whether a task is in an open state (not completed/cancelled/deleted).
 * Calls `cleo show <taskId>` and parses the JSON envelope.
 *
 * @param {string} taskId - e.g. `T1234`
 * @param {string} cleoBin - path to the cleo CLI binary
 * @param {string} cwd
 * @returns {{open: boolean, status: string, error?: string}}
 */
function isTaskOpen(taskId, cleoBin, cwd) {
  const cached = taskCache.get(taskId);
  if (cached) return cached;

  const result = spawnSync(cleoBin, ['show', taskId], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 15_000,
  });

  if (result.error) {
    const code = /** @type {NodeJS.ErrnoException} */ (result.error).code;
    const err =
      code === 'ENOENT'
        ? `cleo binary not found at '${cleoBin}'`
        : `cleo spawn error: ${result.error.message}`;
    const entry = { open: false, status: 'unknown', error: err };
    taskCache.set(taskId, entry);
    return entry;
  }

  /** @type {unknown} */
  let parsed;
  try {
    const lines = (result.stdout || '').split('\n').filter((l) => l.trim().startsWith('{'));
    const jsonLine = lines[lines.length - 1];
    if (!jsonLine) throw new Error('no JSON found in output');
    parsed = JSON.parse(jsonLine);
  } catch (e) {
    const entry = {
      open: false,
      status: 'unknown',
      error: `could not parse cleo show output: ${e instanceof Error ? e.message : String(e)}`,
    };
    taskCache.set(taskId, entry);
    return entry;
  }

  const envelope = /** @type {Record<string, unknown>} */ (parsed);
  if (envelope?.success !== true) {
    const errMsg =
      /** @type {Record<string, Record<string, string>>} */ (envelope)?.error?.message ??
      `cleo show ${taskId} returned success=false (task may not exist)`;
    const entry = { open: false, status: 'not-found', error: String(errMsg) };
    taskCache.set(taskId, entry);
    return entry;
  }

  const task = /** @type {Record<string, Record<string, string>>} */ (envelope)?.data?.task;
  const status = String(task?.status ?? 'unknown');
  const open = !CLOSED_STATUSES.has(status);
  const entry = { open, status };
  taskCache.set(taskId, entry);
  return entry;
}

// ============================================================================
// Core lint pass
// ============================================================================

/**
 * Examine a set of lines (from diff or full scan) and return violations.
 *
 * @param {Array<{file: string, lineNumber: number, content: string}>} lines
 * @param {{strict: boolean, cleoBin: string, cwd: string}} opts
 * @returns {Violation[]}
 */
function lintLines(lines, opts) {
  /** @type {Violation[]} */
  const violations = [];

  for (const { file, lineNumber, content } of lines) {
    if (!SSOT_EXEMPT_REGEX.test(content)) continue;
    if (content.includes(LINT_OPT_OUT_MARKER)) continue;

    if (opts.strict) {
      violations.push({ file, lineNumber, content: content.trim(), kind: 'new-exempt-strict' });
      continue;
    }

    // Baseline mode: require a linked open task.
    const taskMatch = content.match(TASK_ID_REGEX);
    if (!taskMatch) {
      violations.push({ file, lineNumber, content: content.trim(), kind: 'no-task-id' });
      continue;
    }

    const taskId = `T${taskMatch[1]}`;
    const { open, status, error } = isTaskOpen(taskId, opts.cleoBin, opts.cwd);

    if (!open) {
      if (error) {
        violations.push({
          file,
          lineNumber,
          content: content.trim(),
          kind: 'task-unknown',
          taskId,
          taskStatus: status,
          taskError: error,
        });
      } else {
        violations.push({
          file,
          lineNumber,
          content: content.trim(),
          kind: 'task-closed',
          taskId,
          taskStatus: status,
        });
      }
    }
  }

  return violations;
}

// ============================================================================
// CLI entry point
// ============================================================================

const argv = process.argv.slice(2);
const STRICT = argv.includes('--strict');
const BASE_REF_IDX = argv.indexOf('--base');
const BASE_REF =
  BASE_REF_IDX !== -1 && argv[BASE_REF_IDX + 1] ? argv[BASE_REF_IDX + 1] : 'origin/main';
const CLEO_BIN = process.env.CLEO_BIN || 'cleo';
const CWD = process.cwd();

// Collect lines to lint: prefer PR diff, fall back to full scan.
let linesToLint = getAddedLines(BASE_REF, CWD);
const usingDiff = linesToLint.length > 0;
if (!usingDiff) {
  linesToLint = scanAllPackageLines(CWD);
}

const violations = lintLines(linesToLint, { strict: STRICT, cleoBin: CLEO_BIN, cwd: CWD });

if (violations.length === 0) {
  const modeLabel = STRICT ? 'STRICT' : 'BASELINE';
  const sourceLabel = usingDiff ? `diff against ${BASE_REF}` : 'full packages/ scan';
  console.info(`lint-no-ssot-exempt: ${modeLabel} OK — no violations in ${sourceLabel}`);
  process.exit(0);
}

// Report
const modeLabel = STRICT ? 'STRICT' : 'BASELINE';
console.error(
  `lint-no-ssot-exempt: ${modeLabel} FAIL — ${violations.length} SSoT-EXEMPT violation(s):\n`,
);

for (const v of violations) {
  console.error(`  ${v.file}:${v.lineNumber}`);
  console.error(`    ${v.content}`);
  switch (v.kind) {
    case 'new-exempt-strict':
      console.error(
        `    -> STRICT: no new SSoT-EXEMPT comments are allowed.\n` +
          `       Remove the exemption, or file a follow-up task and switch to baseline mode.`,
      );
      break;
    case 'no-task-id':
      console.error(
        `    -> Missing T#### task ID. Add an open follow-up task, e.g.:\n` +
          `       // SSoT-EXEMPT: <reason> (T####)`,
      );
      break;
    case 'task-closed':
      console.error(
        `    -> Task ${v.taskId} is ${v.taskStatus} (not open).\n` +
          `       Reopen or link a new open follow-up task, or remove the exemption.`,
      );
      break;
    case 'task-unknown':
      console.error(
        `    -> Could not verify task ${v.taskId}: ${v.taskError ?? 'unknown error'}.\n` +
          `       Ensure the task exists and the cleo CLI is available (CLEO_BIN env or $PATH).`,
      );
      break;
  }
  console.error('');
}

console.error(
  `Fix:\n` +
    `  • --baseline mode (default): link an open T#### task in every new SSoT-EXEMPT comment.\n` +
    `    Format: // SSoT-EXEMPT: <reason> (T####)\n` +
    `  • --strict mode: no new SSoT-EXEMPT comments are allowed at all.\n` +
    `  • Per-line opt-out (use sparingly): append // ssot-exempt-ok: <reason> to that line.\n` +
    `  • See Saga T9831 SG-ARCH-SOLID and Epic T9837 for context.\n`,
);

process.exit(1);
