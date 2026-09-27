#!/usr/bin/env node
/**
 * Gate: no raw `args['no-<flag>']` reads in the CLI (T12528).
 *
 * ## What this prevents
 *
 * citty's `parseArgs` treats every `--no-<name>` token as the NEGATION of
 * `<name>`: it yields `{ <name>: false }` and never `{ 'no-<name>': true }` —
 * even when the command declares `'no-<name>'` as its own boolean. A handler
 * that reads `args['no-<name>']` therefore never sees the flag, and the opt-out
 * silently does nothing. Measured 2026-09-27: `orchestrate spawn --no-worktree`
 * still provisioned a worktree (T12520), and fifteen more handlers carried the
 * same read — `check --no-keep-going`, `release plan --no-changelog`,
 * `upgrade --no-auto-migrate`, `dash --no-hygiene`, and others.
 *
 * Every handler routes through `negatedFlag(args, '<name>')` in
 * `packages/cleo/src/cli/lib/negated-flag.ts`, which reads both forms.
 *
 * ## Checks
 *
 * Every `*.ts` under `packages/cleo/src/` (tests and the helper excluded) is
 * scanned, comments stripped, for:
 *
 *   1. `args['no-…']` / `args["no-…"]` / ``args[`no-…`]`` — the direct read.
 *   2. `args.noFoo` — the camelCase spelling, equally unreachable from
 *      `--no-foo` (citty produces `{ foo: false }`).
 *   3. `someReader(args, 'no-…')` — the same read laundered through a local
 *      wrapper (`backup-recover.ts` had one).
 *
 * ## Baseline
 *
 * `orchestrate.ts` is owned by PR #1577 (T12520), which fixes `--no-worktree`
 * with an inline `args.worktree === false || args['no-worktree'] === true`.
 * It is baselined at its current count so the two PRs do not conflict; the
 * entry is removed when that read moves to `negatedFlag`. A count ABOVE the
 * baseline fails; `--strict` ignores the baseline entirely.
 *
 * Usage: node scripts/lint-no-negated-flag-reads.mjs [--check|--strict]
 *
 * @task T12528
 */

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Directory scanned, relative to the repo root (the process cwd). */
export const SCAN_ROOT = 'packages/cleo/src';

/** The one file allowed to read `'no-…'` keys — it reads BOTH forms. */
export const HELPER = 'packages/cleo/src/cli/lib/negated-flag.ts';

/**
 * Per-file allowed counts. Each entry names the task that removes it.
 *
 * @type {Readonly<Record<string, number>>}
 */
export const BASELINE = Object.freeze({
  // PR #1577 (T12520) owns this file's --no-worktree fix; migrate to
  // negatedFlag once it lands, then delete this entry.
  'packages/cleo/src/cli/commands/orchestrate.ts': 1,
});

/** Patterns, each a raw negated-flag read that citty can never satisfy. */
const PATTERNS = [
  { name: "args['no-…']", re: /\bargs\s*\[\s*['"`]no-[a-z0-9-]+['"`]\s*\]/g },
  { name: 'args.noFoo', re: /\bargs\s*\??\.\s*no[A-Z][A-Za-z0-9]*/g },
  { name: "reader(args, 'no-…')", re: /\(\s*args\s*,\s*['"`]no-[a-z0-9-]+['"`]/g },
];

/**
 * Strip line and block comments so documentation of the bug is not a violation.
 *
 * @param {string} src
 * @returns {string}
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

/**
 * Find every raw negated-flag read in one source text.
 *
 * @param {string} src - TypeScript source.
 * @returns {{ line: number, pattern: string, text: string }[]}
 */
export function findNegatedFlagReads(src) {
  const stripped = stripComments(src);
  const hits = [];
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(stripped); m !== null; m = re.exec(stripped)) {
      const line = stripped.slice(0, m.index).split('\n').length;
      hits.push({ line, pattern: name, text: m[0] });
    }
  }
  return hits.sort((a, b) => a.line - b.line);
}

/**
 * Recursively list scannable `.ts` files under a directory.
 *
 * @param {string} dir - Absolute directory.
 * @returns {string[]} Absolute paths.
 */
function listSourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      out.push(...listSourceFiles(abs));
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.d.ts') &&
      !/\.(test|spec)\.ts$/.test(entry.name)
    ) {
      out.push(abs);
    }
  }
  return out;
}

/**
 * Run the gate against a repo root.
 *
 * @param {string} repoRoot - Repository root.
 * @param {{ strict?: boolean }} [opts]
 * @returns {{ ok: boolean, scanned: number, violations: string[], notes: string[] }}
 */
export function runGate(repoRoot, opts = {}) {
  const root = join(repoRoot, SCAN_ROOT);
  if (!existsSync(root)) {
    return {
      ok: false,
      scanned: 0,
      violations: [`${SCAN_ROOT} does not exist — the scan lost its input.`],
      notes: [],
    };
  }
  const files = listSourceFiles(root);
  const violations = [];
  const notes = [];
  for (const abs of files) {
    const rel = relative(repoRoot, abs).split(sep).join('/');
    if (rel === HELPER) continue;
    const hits = findNegatedFlagReads(readFileSync(abs, 'utf8'));
    const allowed = opts.strict ? 0 : (BASELINE[rel] ?? 0);
    if (hits.length > allowed) {
      for (const h of hits) {
        violations.push(`${rel}:${h.line}: ${h.text}  (${h.pattern})`);
      }
    } else if (hits.length < allowed) {
      notes.push(`${rel}: baseline allows ${allowed}, found ${hits.length} — tighten BASELINE.`);
    }
  }
  return {
    ok: files.length > 0 && violations.length === 0,
    scanned: files.length,
    violations,
    notes,
  };
}

/** Entry point. */
function main() {
  const strict = process.argv.includes('--strict');
  const result = runGate(process.cwd(), { strict });
  for (const n of result.notes) console.log(`lint-no-negated-flag-reads: note — ${n}`);
  if (result.scanned === 0) {
    console.error(
      'lint-no-negated-flag-reads: FAIL — found no source files to scan. ' +
        'The scan lost its input; this is not a clean repo.',
    );
    process.exit(1);
  }
  if (!result.ok) {
    console.error(
      `lint-no-negated-flag-reads: FAIL — ${result.violations.length} raw negated-flag read(s):\n`,
    );
    for (const v of result.violations) console.error(`  • ${v}`);
    console.error(
      "\ncitty parses `--no-<name>` as `{ <name>: false }`, never `{ 'no-<name>': true }`, " +
        'so these reads never see the flag. Use `negatedFlag(args, "<name>")` from ' +
        `${HELPER}.`,
    );
    process.exit(1);
  }
  console.log(
    `lint-no-negated-flag-reads: OK — ${result.scanned} file(s) under ${SCAN_ROOT}, ` +
      'no raw negated-flag reads.',
  );
}

const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (realpathSync(fileURLToPath(import.meta.url)) === invokedPath) {
  main();
}
