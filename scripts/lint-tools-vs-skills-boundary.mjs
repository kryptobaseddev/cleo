#!/usr/bin/env node
/**
 * Lint rule: TOOLS-vs-SKILLS boundary (E3 · T11409 · SG-PACKAGE-ARCH).
 *
 * The CORE-SDK tool layer has a strict home-and-consumption boundary (encoded as
 * `ATOMIC_TOOL_BOUNDARY` in `packages/contracts/src/boundary.ts`):
 *   - Atomic tool **primitives** + their contracts are DEFINED only under
 *     `packages/core/src/tools/` and `packages/contracts/src/tools/`.
 *   - Composite **skills** live in `packages/skills`.
 *   - Harness/provider packages (`mcp-adapter`, `caamp`, `cleo-os`) CONSUME the
 *     primitives via import and MUST NOT redefine them.
 *
 * This gate fails when an atomic-primitive name (see {@link PRIMITIVE_NAMES}) is
 * `export`-defined OUTSIDE the primitive homes — i.e. a transport/provider (or
 * any other package) re-implements a primitive instead of importing it. Runs in
 * baseline mode: current definitions are pinned in
 * `scripts/.lint-tools-vs-skills-boundary-baseline.json`; only NET-NEW
 * redefinitions fail. `--strict` fails on ANY out-of-home definition.
 *
 * Modeled on `scripts/lint-paths-ssot.mjs` (self-contained; REPO_ROOT from cwd
 * so unit tests can target a synthetic tree).
 *
 * @task T11409
 * @epic T11390
 * @saga T11387
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Packages that MAY define atomic-tool primitives + contracts. */
export const PRIMITIVE_HOMES = ['packages/core/src/tools', 'packages/contracts/src/tools'];

/**
 * The distinctive atomic-tool primitive names (from the
 * `@cleocode/contracts/tools/atomic` registry). Deliberately excludes the
 * generic `search`/`fetch` names — too ambiguous to flag without noise; the
 * registry still documents them.
 */
export const PRIMITIVE_NAMES = [
  'readFileText',
  'readJson',
  'writeFileAtomic',
  'pathExists',
  'executeShell',
  'runGit',
  'notebookEdit',
];

const BASELINE_REL = 'scripts/.lint-tools-vs-skills-boundary-baseline.json';

/** Recursively collect `.ts` source files under a dir (skip tests/decls/dist). */
function collectTsFiles(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['__tests__', 'node_modules', 'dist', '.git'].includes(entry.name)) continue;
      collectTsFiles(full, acc);
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.d.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.spec.ts')
    ) {
      acc.push(full);
    }
  }
  return acc;
}

/** True when `relPath` is under one of the primitive homes. */
function inPrimitiveHome(relPath) {
  return PRIMITIVE_HOMES.some((home) => relPath === home || relPath.startsWith(`${home}/`));
}

/**
 * Find out-of-home atomic-primitive redefinitions across `packages/`.
 *
 * @param {string} repoRoot
 * @returns {string[]} sorted violation identities `relPath:name`
 */
export function scanToolBoundaryViolations(repoRoot) {
  const pkgsDir = join(repoRoot, 'packages');
  if (!existsSync(pkgsDir)) return [];
  const nameAlt = PRIMITIVE_NAMES.join('|');
  const re = new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+(${nameAlt})\\b`, 'g');
  const violations = [];
  for (const file of collectTsFiles(pkgsDir)) {
    const rel = relative(repoRoot, file).split('\\').join('/');
    if (inPrimitiveHome(rel)) continue; // primitives legitimately live here
    const text = readFileSync(file, 'utf8');
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      violations.push(`${rel}:${m[1]}`);
    }
  }
  return [...new Set(violations)].sort();
}

/** CLI entry. */
function main() {
  const repoRoot = process.cwd();
  const mode = process.argv.includes('--strict')
    ? 'strict'
    : process.argv.includes('--update-baseline')
      ? 'update'
      : 'check';
  const baselinePath = join(repoRoot, BASELINE_REL);
  const current = scanToolBoundaryViolations(repoRoot);

  if (mode === 'update') {
    writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    console.log(`lint-tools-vs-skills-boundary: baseline updated — ${current.length} entr(ies).`);
    return 0;
  }

  if (mode === 'strict') {
    if (current.length > 0) {
      console.error(
        `\n✗ tools-vs-skills boundary (strict): ${current.length} out-of-home primitive definition(s):\n`,
      );
      for (const v of current) console.error(`  - ${v}`);
      console.error(
        `\nAtomic tool primitives may only be defined under: ${PRIMITIVE_HOMES.join(', ')}.\n` +
          'Import the primitive from @cleocode/core/tools or @cleocode/contracts/tools/atomic instead.\n',
      );
      return 1;
    }
    console.log('✓ tools-vs-skills boundary (strict): no out-of-home primitive definitions.');
    return 0;
  }

  const baseline = existsSync(baselinePath)
    ? new Set(JSON.parse(readFileSync(baselinePath, 'utf8')))
    : new Set();
  const netNew = current.filter((v) => !baseline.has(v));
  if (netNew.length > 0) {
    console.error(
      `\n✗ tools-vs-skills boundary: ${netNew.length} NEW out-of-home primitive definition(s):\n`,
    );
    for (const v of netNew) console.error(`  - ${v}`);
    console.error(
      `\nAtomic tool primitives belong in ${PRIMITIVE_HOMES.join(' / ')}; consumers (mcp-adapter,` +
        ` caamp, cleo-os, …) IMPORT them, never redefine. See ATOMIC_TOOL_BOUNDARY in boundary.ts.\n`,
    );
    return 1;
  }
  console.log(
    `✓ tools-vs-skills boundary: no net-new out-of-home primitive definitions (baseline ${baseline.size}).`,
  );
  return 0;
}

if (process.argv[1]?.endsWith('lint-tools-vs-skills-boundary.mjs')) {
  process.exit(main());
}
