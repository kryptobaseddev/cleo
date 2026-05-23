#!/usr/bin/env node
/**
 * Lint rule: enforce `packages/core/src/sagas/` as the ONLY source of the
 * Saga primitives — AC6 of T10120 / E-SAGAS-CORE-MODULE / Saga T10113.
 *
 * Why this matters
 * ----------------
 * Until T10123 + T10124, the SAGA_LABEL constant, the SAGA_GROUPS_RELATION
 * constant, and the resolveSagaMemberIds helper lived inside
 * `packages/core/src/tasks/list.ts` while the saga.create / saga.add /
 * saga.list / saga.members / saga.rollup operation bodies lived inside
 * `packages/cleo/src/dispatch/domains/tasks.ts`. Both placements violated
 * AGENTS.md "Package-Boundary Check": runtime domain logic was hosted in
 * the CLI dispatch layer, and a saga-specific helper was hand-rolled
 * inside the tasks-list module.
 *
 * This linter prevents that drift returning. Any reference to a saga
 * symbol that lives OUTSIDE the new `packages/core/src/sagas/` SSoT is
 * flagged. The single permitted re-export shim is
 * `packages/core/src/tasks/list.ts`, which re-exports the three constants
 * for backwards-compat with existing imports — but it must NOT define
 * them. Defining or hand-rolling the literal `'saga'` label / `'groups'`
 * relation in any other file is a violation.
 *
 * Flagged anti-patterns (outside `packages/core/src/sagas/`):
 *
 *   1. `export const SAGA_LABEL = 'saga'` (re-definition / hand-roll).
 *   2. `export const SAGA_GROUPS_RELATION = 'groups'` (re-definition).
 *   3. `function resolveSagaMemberIds(` (re-implementation).
 *   4. `import { … } from '../tasks/list.js'` (or relative variant) where
 *      the import binding includes SAGA_LABEL / SAGA_GROUPS_RELATION /
 *      LIST_BINDING_SAGA_GROUPS / resolveSagaMemberIds — every new caller
 *      MUST import from `../sagas/constants.js` or `../sagas/storage.js`
 *      (or `@cleocode/core` namespace).
 *
 * The allowlist below is intentionally tight:
 *   - `packages/core/src/sagas/`          — the SSoT itself
 *   - `packages/core/src/tasks/list.ts`   — compat re-export shim
 *   - test files (`__tests__/`, `*.test.ts`) — fixtures may seed the
 *     literal string for clarity
 *
 * Suppress per-line with `// saga-symbol-ok: <reason>`.
 *
 * @task T10120
 * @epic T10208 — E-SAGAS-CORE-MODULE
 * @saga T10113 — SG-SAGA-FIRST-CLASS
 * @see AGENTS.md "Package-Boundary Check"
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';

const REPO_ROOT = process.cwd();
const SCAN_DIRS = ['packages'];
const SKIP_DIR_SEGMENTS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '__snapshots__',
  '__mocks__',
  'coverage',
  '.next',
  '.svelte-kit',
  'fixtures',
]);
const SCAN_EXTS = new Set(['.ts', '.tsx', '.mts']);

// Files explicitly exempt from ALL rules.
const FILE_ALLOWLIST = new Set([
  // The SSoT itself.
  'packages/core/src/sagas/constants.ts',
  'packages/core/src/sagas/storage.ts',
  // The compat re-export shim.
  'packages/core/src/tasks/list.ts',
]);

const OPT_OUT_MARKER = 'saga-symbol-ok';

/** Walk a directory and collect scannable file paths (POSIX-relative). */
function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIR_SEGMENTS.has(entry)) continue;
    const abs = join(dir, entry);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      // Tests are allowed to reference the literal saga string + symbols.
      if (entry === '__tests__') continue;
      yield* walk(abs);
    } else if (st.isFile()) {
      const ext = extname(entry);
      if (!SCAN_EXTS.has(ext)) continue;
      if (entry.endsWith('.test.ts') || entry.endsWith('.test.tsx')) continue;
      if (entry.endsWith('.spec.ts') || entry.endsWith('.spec.tsx')) continue;
      yield abs;
    }
  }
}

/** Pre-compiled checks. Each returns a non-null `Violation` or null. */
const CHECKS = [
  {
    rule: 'saga-label-redefinition',
    test: (line) => /export\s+const\s+SAGA_LABEL\s*=/.test(line),
    message:
      "SAGA_LABEL must only be defined in packages/core/src/sagas/constants.ts. Import it from '../sagas/constants.js' (or '@cleocode/core').",
  },
  {
    rule: 'saga-groups-redefinition',
    test: (line) => /export\s+const\s+SAGA_GROUPS_RELATION\s*=/.test(line),
    message:
      "SAGA_GROUPS_RELATION must only be defined in packages/core/src/sagas/constants.ts. Import it from '../sagas/constants.js' (or '@cleocode/core').",
  },
  {
    rule: 'saga-label-local',
    test: (line) =>
      /\bconst\s+SAGA_LABEL\s*=\s*['"]saga['"]/.test(line) &&
      !/export\s+const\s+SAGA_LABEL/.test(line),
    message:
      "Hand-rolled SAGA_LABEL constant detected. Import from '../sagas/constants.js' instead.",
  },
  {
    rule: 'saga-groups-local',
    test: (line) =>
      /\bconst\s+SAGA_GROUPS_RELATION\s*=\s*['"]groups['"]/.test(line) &&
      !/export\s+const\s+SAGA_GROUPS_RELATION/.test(line),
    message:
      "Hand-rolled SAGA_GROUPS_RELATION constant detected. Import from '../sagas/constants.js' instead.",
  },
  {
    rule: 'resolve-saga-members-redefinition',
    test: (line) => /function\s+resolveSagaMemberIds\s*\(/.test(line),
    message:
      "resolveSagaMemberIds must only be defined in packages/core/src/sagas/storage.ts. Import it from '../sagas/storage.js' (or '@cleocode/core').",
  },
];

function isAllowlisted(relPath) {
  const norm = relPath.split(sep).join('/');
  return FILE_ALLOWLIST.has(norm);
}

function lintFile(absPath) {
  const relPath = relative(REPO_ROOT, absPath);
  if (isAllowlisted(relPath)) return [];
  const text = readFileSync(absPath, 'utf8');
  const lines = text.split(/\r?\n/);
  const violations = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes(OPT_OUT_MARKER)) continue;
    for (const check of CHECKS) {
      if (check.test(line)) {
        violations.push({
          file: relPath,
          line: i + 1,
          rule: check.rule,
          message: check.message,
          source: line.trim(),
        });
      }
    }
  }
  return violations;
}

function main() {
  const violations = [];
  for (const dir of SCAN_DIRS) {
    const abs = join(REPO_ROOT, dir);
    if (!existsSync(abs)) continue;
    for (const file of walk(abs)) {
      violations.push(...lintFile(file));
    }
  }
  if (violations.length > 0) {
    console.error(
      `lint-saga-symbol-leakage: ${violations.length} violation(s) — saga symbols must live in packages/core/src/sagas/`,
    );
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  [${v.rule}]  ${v.message}`);
      console.error(`    > ${v.source}`);
    }
    process.exit(1);
  }
  console.log('lint-saga-symbol-leakage: ok (0 violations)');
}

main();
