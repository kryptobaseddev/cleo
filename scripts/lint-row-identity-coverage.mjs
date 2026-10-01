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
 * The exempt names are pinned too, as a sha256 of the sorted list
 * (`ROW_IDENTITY_EXEMPT_NAMES_SHA256`), so swapping one exempt table for
 * another at the same count fails.
 *
 * ## PR mode (`--base <ref>`, #1764 review M1)
 *
 * The pins live in the same file a PR edits, so on their own they only make
 * a raise visible. With `--base <ref>` (CI passes the PR base) the gate
 * reads the registry at that ref (`git show`) and fails when, in either
 * scope, `ROW_IDENTITY_EXEMPT_PINNED` rose or the exempt name set gained a
 * table. A base without the registry (before this gate) is skipped.
 *
 * ## Task check (`--verify-tasks`, #1764 review L3)
 *
 * Every exemption names the task that ends it. `--verify-tasks` checks that
 * each one exists and is open with the released CLI
 * (`${CLEO_BIN:-cleo} show <id> --field /data/task/status`, run in
 * `$CLEO_TASKS_CWD` or the repo root), like gate 5
 * (`lint-no-ssot-exempt.mjs`). CI has no task store (`.cleo/cleo.db` is not
 * in the checkout), so CI does not pass it; run it locally.
 *
 * Zero-tolerance, no baseline: `--check` and `--strict` behave the same. Any
 * other flag is refused with exit 2 (#1764 review L6).
 *
 * Usage: node scripts/lint-row-identity-coverage.mjs [--check|--strict] [--base <ref>] [--verify-tasks]
 *
 * @task T12897
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  checkRowIdentityCoverage,
  ROW_IDENTITY,
  ROW_IDENTITY_EXEMPT,
  ROW_IDENTITY_EXEMPT_NAMES_SHA256,
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

const REPO_ROOT = resolve(import.meta.dirname, '..');
const REGISTRY_PATH = 'packages/core/src/store/row-identity-registry.ts';

/** Task statuses that are not open. */
export const CLOSED_STATUSES = new Set(['done', 'cancelled', 'archived', 'completed', 'deleted']);

/**
 * Parse the command line. Only `--check`, `--strict`, `--base <ref>` and
 * `--verify-tasks` are accepted.
 *
 * @param {readonly string[]} argv
 * @returns {{ ok: true, base?: string, verifyTasks: boolean } | { ok: false, error: string }}
 */
export function parseArgs(argv) {
  let base;
  let verifyTasks = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check' || arg === '--strict') continue;
    if (arg === '--verify-tasks') verifyTasks = true;
    else if (arg === '--base') {
      base = argv[++i];
      if (!base || base.startsWith('--')) return { ok: false, error: '--base needs a git ref' };
    } else if (arg.startsWith('--base=')) {
      base = arg.slice('--base='.length);
      if (!base) return { ok: false, error: '--base needs a git ref' };
    } else return { ok: false, error: `unknown argument ${arg}` };
  }
  return { ok: true, base, verifyTasks };
}

/**
 * Problems of a head registry against its base: a pin that rose, or an
 * exempt table that is new. Pure.
 *
 * @param {{ exempt: Record<string, Record<string, unknown>>, pinned: Record<string, number> }} head
 * @param {{ exempt: Record<string, Record<string, unknown>>, pinned: Record<string, number> } | null} base
 * @returns {string[]}
 */
export function baseProblems(head, base) {
  if (!base) return [];
  const problems = [];
  for (const scope of SCOPES) {
    const before = base.pinned?.[scope];
    if (before !== undefined && head.pinned[scope] > before) {
      problems.push(
        `[${scope}] ROW_IDENTITY_EXEMPT_PINNED rose from ${before} to ${head.pinned[scope]}: the pin only falls`,
      );
    }
    const baseNames = new Set(Object.keys(base.exempt?.[scope] ?? {}));
    const added = Object.keys(head.exempt[scope])
      .filter((t) => !baseNames.has(t))
      .sort();
    if (added.length > 0) {
      problems.push(
        `[${scope}] new exemption(s) against the base: ${added.join(', ')}. Declare their row identity instead`,
      );
    }
  }
  return problems;
}

/**
 * The registry at a git ref, or `null` when that ref has no exemptions yet.
 *
 * @param {string} root
 * @param {string} ref
 */
export async function loadBaseRegistry(root, ref) {
  let source;
  try {
    source = execFileSync('git', ['show', `${ref}:${REGISTRY_PATH}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const stderr = String(err?.stderr ?? '');
    if (/does not exist|exists on disk, but not in/.test(stderr)) return null;
    throw new Error(`git show ${ref}:${REGISTRY_PATH} failed: ${stderr.trim() || err}`);
  }
  if (!source.includes('ROW_IDENTITY_EXEMPT')) return null;
  const dir = mkdtempSync(join(tmpdir(), 'row-identity-base-'));
  try {
    const file = join(dir, 'row-identity-registry.ts');
    writeFileSync(file, source);
    const mod = await import(pathToFileURL(file).href);
    return { exempt: mod.ROW_IDENTITY_EXEMPT, pinned: mod.ROW_IDENTITY_EXEMPT_PINNED };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Check that every exemption task exists and is open.
 *
 * @param {Iterable<string>} tasks
 * @param {(task: string) => { status?: string, error?: string }} statusOf
 * @returns {string[]}
 */
export function taskProblems(tasks, statusOf) {
  const problems = [];
  for (const task of [...new Set(tasks)].sort()) {
    const { status, error } = statusOf(task);
    if (error) problems.push(`task ${task}: ${error}`);
    else if (status && CLOSED_STATUSES.has(status))
      problems.push(`task ${task} is ${status}: an exemption must name an open task`);
  }
  return problems;
}

/** `cleo show <id>` status through the released CLI. */
function cliStatusOf(task) {
  const bin = process.env.CLEO_BIN || 'cleo';
  const run = spawnSync(bin, ['show', task, '--field', '/data/task/status'], {
    cwd: process.env.CLEO_TASKS_CWD || REPO_ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (run.error) return { error: `cannot run ${bin}: ${run.error.message}` };
  if (run.status !== 0) return { error: `not found (cleo show exited ${run.status})` };
  return { status: run.stdout.trim() };
}

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
 *   pinnedDigest?: string,
 * }} input
 * @returns {{ kind: string, table?: string, message: string }[]}
 */
export function scopeProblems({ registry, declared, exempt, pinned, pinnedDigest }) {
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
      pinnedDigest,
    }),
  );
  return problems;
}

/**
 * Run the gate against the repository's registries.
 *
 * @param {readonly string[]} [argv] - Command-line arguments.
 * @param {{ root?: string }} [opts] - `root`: the git checkout `--base` reads
 *   the base registry from (default: this repository; tests pass a temp repo).
 * @returns {Promise<number>} 0 when every syncing table is covered, 1 on a
 *   problem, 2 on a bad argument.
 */
export async function main(argv = process.argv.slice(2), { root = REPO_ROOT } = {}) {
  const args = parseArgs(argv);
  if (!args.ok) {
    process.stderr.write(
      `lint-row-identity-coverage: ${args.error}\n  usage: node scripts/lint-row-identity-coverage.mjs [--check|--strict] [--base <ref>] [--verify-tasks]\n`,
    );
    return 2;
  }
  let failed = false;
  const counts = [];
  for (const scope of SCOPES) {
    const problems = scopeProblems({
      registry: getTableRegistry(scope),
      declared: ROW_IDENTITY[scope],
      exempt: ROW_IDENTITY_EXEMPT[scope],
      pinned: ROW_IDENTITY_EXEMPT_PINNED[scope],
      pinnedDigest: ROW_IDENTITY_EXEMPT_NAMES_SHA256[scope],
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
  const extra = [];
  if (args.base) {
    const base = await loadBaseRegistry(root, args.base);
    if (!base) counts.push(`base ${args.base} has no exemptions yet`);
    extra.push(
      ...baseProblems({ exempt: ROW_IDENTITY_EXEMPT, pinned: ROW_IDENTITY_EXEMPT_PINNED }, base),
    );
  }
  if (args.verifyTasks) {
    const tasks = SCOPES.flatMap((scope) =>
      Object.values(ROW_IDENTITY_EXEMPT[scope]).map((e) => e.task),
    );
    extra.push(...taskProblems(tasks, cliStatusOf));
  }
  for (const p of extra) process.stderr.write(`FAIL ${p}\n`);
  failed ||= extra.length > 0;
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

if (isMain(import.meta.url)) process.exit(await main());
