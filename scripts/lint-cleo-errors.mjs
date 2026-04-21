#!/usr/bin/env node
/**
 * Lint rule: reject two-argument `new CleoError(code, message)` construction.
 *
 * Every actionable CleoError throw MUST include a third argument with at least
 * a `fix` hint so the CLI error envelope (Wave 1 of T335) can surface recovery
 * actions to agents.
 *
 * Opt-out: append `/* internal invariant *\/` as a trailing comment on the
 * `throw new CleoError(` line to suppress the check for genuine internal
 * assertions that users cannot act on.
 *
 * @task T341
 * @epic T335
 */

import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';

// ============================================================================
// Configuration
// ============================================================================

/**
 * Directories to scan. Scoped to files backfilled in T335 Wave 2b.
 * Expand this list as future waves backfill additional directories.
 */
const SCAN_DIRS = ['packages/core/src/tasks', 'packages/core/src/validation'];

/** Skip files matching these patterns. */
const EXCLUDE_PATTERNS = [
  /\.test\.ts$/,
  /\.spec\.ts$/,
  /__tests__/,
  /\/dist\//,
  /\/node_modules\//,
];

/** Marker that opts a specific throw out of this rule. */
const INTERNAL_INVARIANT_MARKER = 'internal invariant';

// ============================================================================
// File discovery
// ============================================================================

/**
 * Recursively collect all .ts files under a directory, excluding EXCLUDE_PATTERNS.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function collectTsFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (EXCLUDE_PATTERNS.some((p) => p.test(fullPath))) continue;
    if (entry.isDirectory()) {
      results.push(...collectTsFiles(fullPath));
    } else if (entry.isFile() && extname(entry.name) === '.ts') {
      results.push(fullPath);
    }
  }
  return results;
}

// ============================================================================
// Argument counting — state-machine based parser
// ============================================================================

// Parser states
const S_NORMAL = 0;
const S_STRING_SQ = 1; // inside '...'
const S_STRING_DQ = 2; // inside "..."
const S_TEMPLATE = 3; // inside `...`
const S_LINE_COMMENT = 4;
const S_BLOCK_COMMENT = 5;

/**
 * Count top-level comma-separated arguments in a CleoError call.
 * Uses a proper state machine to handle strings, template literals,
 * nested parens/brackets/braces, and comments.
 *
 * @param {string} source
 * @param {number} callStart - index of 'n' in 'new CleoError('
 * @returns {{ argCount: number }}
 */
function countCleoErrorArgs(source, callStart) {
  const prefix = 'new CleoError(';
  let i = callStart + prefix.length;

  // Stack tracks what we're inside. Each frame: { type, depth }
  // type: 'call' = top-level call parens, 'paren', 'bracket', 'brace', 'template-expr'
  // We start already inside the top-level call paren.
  let callDepth = 1; // depth relative to the outer CleoError(
  let innerDepth = 0; // depth of nested (, [, { — separate from top-level
  let argCount = 1;

  // Template literal nesting stack: each level is number of open ${} inside
  const templateStack = [];

  let state = S_NORMAL;

  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1] ?? '';

    switch (state) {
      case S_LINE_COMMENT:
        if (c === '\n') state = S_NORMAL;
        i++;
        continue;

      case S_BLOCK_COMMENT:
        if (c === '*' && next === '/') {
          state = S_NORMAL;
          i += 2;
          continue;
        }
        i++;
        continue;

      case S_STRING_SQ:
        if (c === '\\') {
          i += 2;
          continue;
        }
        if (c === "'") state = S_NORMAL;
        i++;
        continue;

      case S_STRING_DQ:
        if (c === '\\') {
          i += 2;
          continue;
        }
        if (c === '"') state = S_NORMAL;
        i++;
        continue;

      case S_TEMPLATE:
        if (c === '\\') {
          i += 2;
          continue;
        }
        if (c === '`') {
          // End of template literal
          templateStack.pop();
          state = templateStack.length > 0 ? S_TEMPLATE : S_NORMAL;
          i++;
          continue;
        }
        if (c === '$' && next === '{') {
          // Template expression start — enter normal mode, track brace
          templateStack[templateStack.length - 1]++;
          innerDepth++;
          state = S_NORMAL;
          i += 2;
          continue;
        }
        i++;
        continue;
      default:
        // Enter comments
        if (c === '/' && next === '/') {
          state = S_LINE_COMMENT;
          i++;
          continue;
        }
        if (c === '/' && next === '*') {
          state = S_BLOCK_COMMENT;
          i += 2;
          continue;
        }

        // Enter strings
        if (c === "'") {
          state = S_STRING_SQ;
          i++;
          continue;
        }
        if (c === '"') {
          state = S_STRING_DQ;
          i++;
          continue;
        }
        if (c === '`') {
          templateStack.push(0);
          state = S_TEMPLATE;
          i++;
          continue;
        }

        // Brackets/braces at inner depth
        if (c === '(' || c === '[' || c === '{') {
          // Check if this closes a template expression
          if (
            c === '{' &&
            templateStack.length > 0 &&
            templateStack[templateStack.length - 1] > 0
          ) {
            // This is an OPEN brace inside a template expression — track it
          }
          innerDepth++;
          i++;
          continue;
        }

        if (c === ')' || c === ']' || c === '}') {
          if (innerDepth > 0) {
            innerDepth--;
            // Check if this closes a template expression
            if (
              c === '}' &&
              templateStack.length > 0 &&
              templateStack[templateStack.length - 1] > 0
            ) {
              templateStack[templateStack.length - 1]--;
              state = S_TEMPLATE;
            }
            i++;
            continue;
          }
          // innerDepth === 0: this closes the top-level call
          callDepth--;
          if (callDepth === 0) {
            return { argCount };
          }
          i++;
          continue;
        }

        // Top-level comma (innerDepth === 0)
        if (c === ',' && innerDepth === 0) {
          argCount++;
        }

        i++;
    }
  }

  return { argCount };
}

// ============================================================================
// Main lint logic
// ============================================================================

let errorCount = 0;
const violations = [];

const allFiles = SCAN_DIRS.flatMap(collectTsFiles).sort();

for (const file of allFiles) {
  let source;
  try {
    source = readFileSync(file, 'utf-8');
  } catch {
    continue;
  }

  if (!source.includes('CleoError')) continue;

  const pattern = /new CleoError\(/g;
  let match = pattern.exec(source);

  while (match !== null) {
    const callStart = match.index;
    const lineNumber = source.slice(0, callStart).split('\n').length;

    // Opt-out check: look at the line containing the throw keyword
    // and the line with 'new CleoError(' itself
    const lineStart = source.lastIndexOf('\n', callStart) + 1;
    const lineEnd = source.indexOf('\n', callStart);
    const line = source.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);

    // Also check the preceding line (the throw statement)
    const prevLineStart = source.lastIndexOf('\n', lineStart - 2) + 1;
    const prevLine = source.slice(prevLineStart, lineStart);

    if (
      !line.includes(INTERNAL_INVARIANT_MARKER) &&
      !prevLine.includes(INTERNAL_INVARIANT_MARKER)
    ) {
      const { argCount } = countCleoErrorArgs(source, callStart);

      if (argCount < 3) {
        errorCount++;
        const msg = `${file}:${lineNumber}: new CleoError() called with ${argCount} arg(s) — must include third {fix, details} argument. Add /* internal invariant */ to opt out.`;
        violations.push(msg);
      }
    }

    match = pattern.exec(source);
  }
}

// ============================================================================
// Report
// ============================================================================

if (violations.length > 0) {
  console.error('\n[lint-cleo-errors] FAIL: Two-argument CleoError throws detected:\n');
  for (const v of violations) {
    console.error(`  ${v}`);
  }
  console.error(
    `\n[lint-cleo-errors] ${errorCount} violation(s) found. Add a third argument with {fix, details} or /* internal invariant */ to opt out.\n`,
  );
  process.exit(1);
} else {
  console.log(
    `[lint-cleo-errors] OK — all CleoError calls in ${allFiles.length} TypeScript file(s) carry agent-friendly hints.`,
  );
}
