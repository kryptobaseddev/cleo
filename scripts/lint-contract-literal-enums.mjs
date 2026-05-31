#!/usr/bin/env node
/**
 * Lint rule: contract-literal enum SSoT pre-gate (T11483 · DHQ-035).
 *
 * JSON-Schema `enum: [...]` literals authored inside the input-contract
 * documents in `packages/contracts/src/operations/*.ts` HAND-DUPLICATE the
 * canonical task-axis enum SSoTs (`TASK_KINDS`, `TASK_SCOPES`,
 * `TASK_SEVERITIES`, `TASK_SIZES`, `TASK_STATUSES`, `TaskPriority`, `TaskType`).
 * A single typo or drifted member in one of those literals (`'criticl'`,
 * `'P4'`, a dropped `'spike'`) sails past `tsc` — JSON-Schema literals are
 * `string[]`, not the canonical union — and then detonates as a CASCADE of red
 * CI gates (envelope-compliance, registry-parity, dispatch round-trips) far
 * from the edit. This validator catches the bad enum LOCALLY, at the source,
 * BEFORE it reaches CI.
 *
 * Why this also closes the stale-`dist/` false-pass class: the checker parses
 * the canonical SSoT and the contract literals straight from `*.ts` SOURCE — it
 * never reads `dist/`. So `rm -rf dist` (or a stale `dist/` that still type-
 * checks against old declarations) cannot hide a freshly-introduced bad enum.
 *
 * Rule: every JSON-Schema `enum: [...]` literal attached to a recognised
 * task-axis field name MUST be a SUBSET of that field's canonical enum SSoT.
 * (Subset — not equality — because some operations deliberately expose a
 * partial enum, e.g. `tasks.update` omits `'archived'`/`'proposed'` from
 * `status`. Any value NOT in the canonical set is a typo/drift and fails.)
 *
 * Modes:
 *   --check (default)  FAIL on any out-of-SSoT enum member.
 *   --strict           alias for --check (kept for arch-gate symmetry).
 *   --json             machine-readable report on stdout.
 *   --root <dir>       point the scanner at a synthetic tree (unit tests).
 *
 * Exit 0 = clean; exit 1 = at least one out-of-SSoT enum member.
 *
 * @task T11483
 * @epic T11480
 * @saga T11387
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Recognised task-axis field names mapped to the SSoT that backs each one.
 *
 * `kind` declares the SSoT identifier so violation messages can point the
 * author straight at the canonical definition to fix the drift.
 *
 * @typedef {object} AxisSsot
 * @property {'const-array' | 'union'} kind   How the SSoT is declared in source.
 * @property {string} file                    Repo-relative source file.
 * @property {string} symbol                  `const`/`type` identifier in `file`.
 */

/** @type {Readonly<Record<string, AxisSsot>>} */
const AXIS_SSOTS = {
  kind: { kind: 'const-array', file: 'packages/contracts/src/enums.ts', symbol: 'TASK_KINDS' },
  scope: { kind: 'const-array', file: 'packages/contracts/src/enums.ts', symbol: 'TASK_SCOPES' },
  severity: {
    kind: 'const-array',
    file: 'packages/contracts/src/enums.ts',
    symbol: 'TASK_SEVERITIES',
  },
  size: { kind: 'const-array', file: 'packages/contracts/src/enums.ts', symbol: 'TASK_SIZES' },
  status: {
    kind: 'const-array',
    file: 'packages/contracts/src/status-registry.ts',
    symbol: 'TASK_STATUSES',
  },
  priority: { kind: 'union', file: 'packages/contracts/src/task.ts', symbol: 'TaskPriority' },
  type: { kind: 'union', file: 'packages/contracts/src/task.ts', symbol: 'TaskType' },
};

/** Contract-literal source files scanned for JSON-Schema `enum` literals. */
const CONTRACT_LITERAL_FILES = ['packages/contracts/src/operations/tasks.ts'];

/**
 * Extract the string members of an `export const NAME = [ ... ] as const`
 * array from a source file.
 *
 * @param {string} src    File contents.
 * @param {string} symbol The const identifier.
 * @returns {string[] | null} Ordered members, or `null` when not found.
 */
function parseConstArray(src, symbol) {
  const re = new RegExp(`export const ${symbol}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`, 'm');
  const m = re.exec(src);
  if (!m) return null;
  return extractStringLiterals(m[1]);
}

/**
 * Extract the string members of an `export type NAME = 'a' | 'b' | ...` union.
 *
 * @param {string} src    File contents.
 * @param {string} symbol The type identifier.
 * @returns {string[] | null} Ordered members, or `null` when not found.
 */
function parseUnion(src, symbol) {
  const re = new RegExp(`export type ${symbol}\\s*=\\s*([^;]+);`, 'm');
  const m = re.exec(src);
  if (!m) return null;
  return extractStringLiterals(m[1]);
}

/**
 * Pull every single- or double-quoted string literal out of a text span.
 *
 * @param {string} span
 * @returns {string[]}
 */
function extractStringLiterals(span) {
  const out = [];
  for (const m of span.matchAll(/'([^']*)'|"([^"]*)"/g)) {
    out.push(m[1] ?? m[2]);
  }
  return out;
}

/**
 * Load the canonical member set for every axis from its SSoT source.
 *
 * @param {string} root Repo root.
 * @returns {Record<string, Set<string>>} axis → canonical members.
 */
function loadCanonicalSets(root) {
  /** @type {Record<string, Set<string>>} */
  const sets = {};
  /** @type {Record<string, string>} */
  const cache = {};
  for (const [axis, ssot] of Object.entries(AXIS_SSOTS)) {
    const abs = join(root, ssot.file);
    if (!existsSync(abs)) {
      throw new Error(`SSoT source missing for axis "${axis}": ${ssot.file}`);
    }
    if (cache[abs] === undefined) cache[abs] = readFileSync(abs, 'utf8');
    const src = cache[abs];
    const members =
      ssot.kind === 'const-array'
        ? parseConstArray(src, ssot.symbol)
        : parseUnion(src, ssot.symbol);
    if (!members || members.length === 0) {
      throw new Error(`Could not parse SSoT ${ssot.symbol} in ${ssot.file} for axis "${axis}".`);
    }
    sets[axis] = new Set(members);
  }
  return sets;
}

/**
 * A single out-of-SSoT enum member found in a contract literal.
 *
 * @typedef {object} EnumViolation
 * @property {string} file    Repo-relative contract-literal file.
 * @property {number} line    1-based line number of the enum literal.
 * @property {string} axis    Recognised field name (kind/scope/...).
 * @property {string} value   The drifted member.
 * @property {string[]} canonical Sorted canonical members for the hint.
 * @property {string} ssot    Canonical SSoT identifier to fix.
 */

/**
 * Scan one contract-literal file for `<axis>: { ... enum: [ ... ] }` literals
 * and return every member that is NOT in the axis's canonical set.
 *
 * @param {string} src   File contents.
 * @param {string} rel   Repo-relative path (for reporting).
 * @param {Record<string, Set<string>>} canonical axis → canonical members.
 * @returns {EnumViolation[]}
 */
function scanContractFile(src, rel, canonical) {
  /** @type {EnumViolation[]} */
  const violations = [];
  // Match `<field>: { ...enum: [ ... ] }` where <field> is a recognised axis.
  // The property may carry a `type: 'string'` before `enum`; allow any chars up
  // to the `enum:` token within the same object literal (no nested `}`).
  const axisNames = Object.keys(canonical).join('|');
  const re = new RegExp(`\\b(${axisNames})\\s*:\\s*\\{[^{}]*?\\benum\\s*:\\s*\\[([^\\]]*)\\]`, 'g');
  for (const m of src.matchAll(re)) {
    const axis = m[1];
    const members = extractStringLiterals(m[2]);
    const canonSet = canonical[axis];
    const line = src.slice(0, m.index).split('\n').length;
    for (const value of members) {
      if (!canonSet.has(value)) {
        violations.push({
          file: rel,
          line,
          axis,
          value,
          canonical: [...canonSet].sort(),
          ssot: AXIS_SSOTS[axis].symbol,
        });
      }
    }
  }
  return violations;
}

/**
 * Run the full scan over the configured contract-literal files.
 *
 * @param {string} root Repo root.
 * @returns {EnumViolation[]}
 */
export function scanContractLiteralEnums(root) {
  const canonical = loadCanonicalSets(root);
  /** @type {EnumViolation[]} */
  const all = [];
  for (const rel of CONTRACT_LITERAL_FILES) {
    const abs = join(root, rel);
    if (!existsSync(abs)) continue;
    all.push(...scanContractFile(readFileSync(abs, 'utf8'), rel, canonical));
  }
  return all;
}

/** CLI entry. */
function main() {
  const argv = process.argv.slice(2);
  const rootIdx = argv.indexOf('--root');
  const root = rootIdx >= 0 && argv[rootIdx + 1] ? argv[rootIdx + 1] : process.cwd();
  const asJson = argv.includes('--json');

  let violations;
  try {
    violations = scanContractLiteralEnums(root);
  } catch (err) {
    console.error(`✗ lint-contract-literal-enums: ${err instanceof Error ? err.message : err}`);
    return 1;
  }

  if (asJson) {
    console.log(JSON.stringify({ ok: violations.length === 0, violations }, null, 2));
    return violations.length === 0 ? 0 : 1;
  }

  if (violations.length === 0) {
    console.log('✓ lint-contract-literal-enums: every contract-literal enum is in its SSoT.');
    return 0;
  }

  console.error(
    `\n✗ lint-contract-literal-enums: ${violations.length} out-of-SSoT enum member(s) in contract literals:\n`,
  );
  for (const v of violations) {
    console.error(
      `  - ${v.file}:${v.line} — field "${v.axis}" enum has "${v.value}", ` +
        `not in ${v.ssot} {${v.canonical.join(', ')}}`,
    );
  }
  console.error(
    '\nFix the typo, or — if this is a genuine new member — add it to the canonical SSoT ' +
      'FIRST, then mirror it in the contract literal. Contract-literal enums must be a subset ' +
      'of the canonical enum SSoT.\n',
  );
  return 1;
}

if (process.argv[1]?.endsWith('lint-contract-literal-enums.mjs')) {
  process.exit(main());
}
