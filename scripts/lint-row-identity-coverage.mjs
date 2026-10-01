#!/usr/bin/env node
/**
 * Gate 37 — row-identity coverage (T12897 · epic T12323).
 *
 * Every table whose Gate A class syncs (the portable classes, minus frozen
 * legacy twins) must be either declared in `ROW_IDENTITY` or exempt with a
 * reason and a task in `ROW_IDENTITY_EXEMPT`
 * (`packages/core/src/store/row-identity-registry.ts`). A syncing table in
 * neither place merges on a local primary key nobody decided was safe, so the
 * gate fails on it. It also fails on a stale exemption (its table is gone,
 * no longer syncs, or is now declared), on an exemption without a reason or
 * task, and when the exemption count differs from `ROW_IDENTITY_EXEMPT_PINNED`
 * (it may only fall, lowered in the change that declares a table).
 *
 * The syncing set comes from the classification registry source, so the gate
 * needs no build and no store. A portable PATTERN rule would hide its tables
 * from that set, so one fails the gate too. The physical check, against
 * `sqlite_master` of fresh stores, is the row-identity gate test
 * (`packages/core/src/store/__tests__/row-identity-gate.test.ts`).
 *
 * Zero-tolerance, no baseline: `--check` and `--strict` behave the same.
 *
 * Usage: node scripts/lint-row-identity-coverage.mjs [--check|--strict]
 *
 * @task T12897
 */

import {
  checkRowIdentityCoverage,
  ROW_IDENTITY,
  ROW_IDENTITY_EXEMPT,
  ROW_IDENTITY_EXEMPT_PINNED,
  rowIdentityExemptionSummary,
} from '../packages/core/src/store/row-identity-registry.ts';
import {
  getTableRegistry,
  isPortableTableClass,
} from '../packages/core/src/store/table-classification.ts';
import { isMain } from './lib/is-main.mjs';

/** @type {readonly ('project' | 'global')[]} */
export const SCOPES = ['project', 'global'];

/**
 * The syncing tables a scope registry names: explicit entries whose class is
 * portable and whose status is not `frozen-legacy`.
 *
 * @param {import('@cleocode/contracts').TableScopeRegistry} registry
 * @returns {string[]}
 */
export function registrySyncTables(registry) {
  return Object.entries(registry.tables)
    .filter(([, entry]) => isPortableTableClass(entry.class) && entry.status !== 'frozen-legacy')
    .map(([table]) => table);
}

/**
 * Every coverage problem of one scope.
 *
 * @param {{
 *   registry: import('@cleocode/contracts').TableScopeRegistry,
 *   declared: readonly { table: string }[],
 *   exempt: Readonly<Record<string, import('../packages/core/src/store/row-identity-registry.ts').RowIdentityExemption>>,
 *   pinned?: number,
 * }} input
 * @returns {{ kind: string, table?: string, message: string }[]}
 */
export function scopeProblems({ registry, declared, exempt, pinned }) {
  const problems = registry.patterns
    .filter((rule) => isPortableTableClass(rule.class))
    .map((rule) => ({
      kind: 'pattern',
      message: `pattern rule /${rule.match}/ is ${rule.class}: its tables cannot be enumerated from the registry; classify them by explicit entry`,
    }));
  problems.push(
    ...checkRowIdentityCoverage({
      syncing: registrySyncTables(registry),
      declared: declared.map((spec) => spec.table),
      exempt,
      pinned,
    }),
  );
  return problems;
}

/**
 * Run the gate against the repository's registries.
 *
 * @returns {number} 0 when every syncing table is covered, 1 otherwise.
 */
export function main() {
  let failed = false;
  const counts = [];
  for (const scope of SCOPES) {
    const problems = scopeProblems({
      registry: getTableRegistry(scope),
      declared: ROW_IDENTITY[scope],
      exempt: ROW_IDENTITY_EXEMPT[scope],
      pinned: ROW_IDENTITY_EXEMPT_PINNED[scope],
    });
    for (const p of problems) {
      process.stderr.write(`FAIL [${scope}] ${p.kind}: ${p.message}\n`);
    }
    failed ||= problems.length > 0;
    const summary = rowIdentityExemptionSummary(scope);
    const byTask = Object.entries(summary.byTask)
      .map(([key, n]) => `${key}: ${n}`)
      .join(', ');
    counts.push(
      `${scope}: ${ROW_IDENTITY[scope].length} declared, ${summary.total} exempt (${byTask})`,
    );
  }
  if (failed) {
    process.stderr.write(
      'lint-row-identity-coverage: FAIL — declare the table in ROW_IDENTITY or give it a ROW_IDENTITY_EXEMPT reason (packages/core/src/store/row-identity-registry.ts).\n',
    );
    return 1;
  }
  process.stdout.write(
    `lint-row-identity-coverage: OK — every syncing table is declared or exempt (${counts.join('; ')}).\n`,
  );
  return 0;
}

if (isMain(import.meta.url)) process.exit(main());
