#!/usr/bin/env node
/**
 * Lint rule: `engines.node` SSoT — every workspace package's `engines.node`
 * MUST equal the root `package.json` floor, and the runtime gate's
 * `FALLBACK_MIN_NODE` MUST match it.
 *
 * Why this matters
 * ----------------
 * The Node runtime gate (`@cleocode/paths` `node-version-gate.ts`,
 * `enforceNodeVersion`) reads its OWN package's `engines.node` at runtime as the
 * single source of truth for the minimum Node version. That only stays
 * authoritative if every package agrees with root — otherwise the gate could
 * read a stale floor (e.g. `>=24.0.0`) and wave through a Node below the real
 * floor (`>=24.16.0`), which is exactly the 24.13.1-vs-24.16 hole this gate
 * was built to close (24.13.1 passes a major-only check but lacks the SQLite
 * 3.53.0 WAL-reset fix). Bumping the floor must therefore be ONE edit to root
 * `engines.node`; this gate propagates the requirement to every package.
 *
 * Checks (all fail-closed):
 *   1. Every `packages/<x>/package.json` declares `engines.node` === root's.
 *      (Absent `engines.node` is a violation — drift hides via omission.)
 *   2. `FALLBACK_MIN_NODE` in `packages/paths/src/node-version-gate.ts` equals
 *      root's semver triple.
 *
 * Exit 0 = clean; exit 1 = violations (printed).
 *
 * @task T11281
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** First `x.y.z` triple in a version/range string, or null. */
function triple(raw) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(raw ?? '').trim());
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const violations = [];

// ── Root floor (the SSoT) ───────────────────────────────────────────────────
const rootPkg = readJson(join(REPO_ROOT, 'package.json'));
const rootEngine = rootPkg.engines?.node;
const rootTriple = triple(rootEngine);
if (!rootEngine || !rootTriple) {
  console.error(
    `FATAL: root package.json engines.node is missing or unparseable: ${JSON.stringify(rootEngine)}`,
  );
  process.exit(1);
}

// ── 1. Every workspace package must match root ───────────────────────────────
const pkgsDir = join(REPO_ROOT, 'packages');
for (const name of readdirSync(pkgsDir, { withFileTypes: true })) {
  if (!name.isDirectory()) continue;
  const pkgJsonPath = join(pkgsDir, name.name, 'package.json');
  let pkg;
  try {
    pkg = readJson(pkgJsonPath);
  } catch {
    continue; // no package.json (not a package dir)
  }
  const declared = pkg.engines?.node;
  if (declared !== rootEngine) {
    violations.push(
      `packages/${name.name}/package.json: engines.node = ${JSON.stringify(declared)} ` +
        `(expected root value ${JSON.stringify(rootEngine)})`,
    );
  }
}

// ── 2. Gate FALLBACK_MIN_NODE must match root triple ─────────────────────────
const gatePath = join(REPO_ROOT, 'packages', 'paths', 'src', 'node-version-gate.ts');
const gateSrc = readFileSync(gatePath, 'utf8');
const fallbackMatch = /FALLBACK_MIN_NODE\s*=\s*['"]([^'"]+)['"]/.exec(gateSrc);
const fallbackTriple = fallbackMatch ? triple(fallbackMatch[1]) : null;
if (fallbackTriple !== rootTriple) {
  violations.push(
    `packages/paths/src/node-version-gate.ts: FALLBACK_MIN_NODE = ${JSON.stringify(
      fallbackMatch?.[1] ?? null,
    )} (expected root triple ${rootTriple})`,
  );
}

// ── Report ───────────────────────────────────────────────────────────────────
if (violations.length > 0) {
  console.error(`\n✗ engines.node SSoT drift (root floor = ${rootEngine}):\n`);
  for (const v of violations) console.error(`  - ${v}`);
  console.error(
    `\nFix: set engines.node = ${JSON.stringify(rootEngine)} in each package above, or ` +
      `re-sync from root. To bump the floor, edit ROOT package.json engines.node ` +
      `(+ FALLBACK_MIN_NODE) — this gate propagates it.\n`,
  );
  process.exit(1);
}

console.log(`✓ engines.node SSoT: all workspace packages match root floor ${rootEngine}`);
