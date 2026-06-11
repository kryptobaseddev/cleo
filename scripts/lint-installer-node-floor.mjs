#!/usr/bin/env node
/**
 * Lint rule: installer Node floor SSoT — the embedded Node version constants
 * in `scripts/install.sh` and `scripts/install.ps1` MUST match root
 * `package.json engines.node`.
 *
 * Why this matters
 * ----------------
 * The one-line installer bakes in a Node floor constant so it can run on a
 * plain POSIX shell / PowerShell without parsing JSON.  If the constant drifts
 * from the repo's `engines.node` SSoT, new installs on machines just above the
 * stale floor succeed — then fail at runtime with cryptic native-module errors.
 *
 * This gate makes bumping the Node floor a single-edit operation:
 *   1. Edit root `package.json` engines.node (the SSoT).
 *   2. Run `node scripts/lint-node-engine-ssot.mjs` to propagate to packages.
 *   3. Update the constants in install.sh / install.ps1 (the only manual step).
 *   4. This gate (lint-installer-node-floor.mjs) fails in CI until step 3 is done.
 *
 * Pattern matched per installer:
 *   install.sh   — `NODE_FLOOR_MAJOR=<N>`, `NODE_FLOOR_MINOR=<N>`, `NODE_FLOOR_PATCH=<N>`
 *   install.ps1  — `$NODE_FLOOR_MAJOR = <N>`, `$NODE_FLOOR_MINOR = <N>`, `$NODE_FLOOR_PATCH = <N>`
 *
 * Exit 0 = clean; exit 1 = violations (printed to stdout).
 *
 * Exports `parseShFloor` and `parsePsFloor` for unit testing.
 *
 * @task T11981
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Parse helpers (exported for testing) ─────────────────────────────────────

/**
 * Extract NODE_FLOOR_MAJOR / NODE_FLOOR_MINOR / NODE_FLOOR_PATCH from a
 * POSIX sh script.  Expected pattern (one per line):
 *   NODE_FLOOR_MAJOR=24
 *   NODE_FLOOR_MINOR=16
 *   NODE_FLOOR_PATCH=0
 *
 * @param {string} src - script source
 * @returns {{ major: number, minor: number, patch: number } | null}
 */
export function parseShFloor(src) {
  const major = /^NODE_FLOOR_MAJOR=(\d+)\s*$/m.exec(src);
  const minor = /^NODE_FLOOR_MINOR=(\d+)\s*$/m.exec(src);
  const patch = /^NODE_FLOOR_PATCH=(\d+)\s*$/m.exec(src);
  if (!major || !minor || !patch) return null;
  return {
    major: Number(major[1]),
    minor: Number(minor[1]),
    patch: Number(patch[1]),
  };
}

/**
 * Extract $NODE_FLOOR_MAJOR / $NODE_FLOOR_MINOR / $NODE_FLOOR_PATCH from a
 * PowerShell script.  Expected pattern (one per line):
 *   $NODE_FLOOR_MAJOR = 24
 *   $NODE_FLOOR_MINOR = 16
 *   $NODE_FLOOR_PATCH = 0
 *
 * @param {string} src - script source
 * @returns {{ major: number, minor: number, patch: number } | null}
 */
export function parsePsFloor(src) {
  const major = /^\$NODE_FLOOR_MAJOR\s*=\s*(\d+)\s*$/m.exec(src);
  const minor = /^\$NODE_FLOOR_MINOR\s*=\s*(\d+)\s*$/m.exec(src);
  const patch = /^\$NODE_FLOOR_PATCH\s*=\s*(\d+)\s*$/m.exec(src);
  if (!major || !minor || !patch) return null;
  return {
    major: Number(major[1]),
    minor: Number(minor[1]),
    patch: Number(patch[1]),
  };
}

/**
 * Extract first x.y.z triple from an engines.node range string.
 *
 * @param {string | undefined} raw
 * @returns {{ major: number, minor: number, patch: number } | null}
 */
export function tripleFrom(raw) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(raw ?? '').trim());
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : null;
}

/**
 * Run the lint check against a given repo root.
 *
 * @param {string} repoRoot - absolute path to the repository root
 * @returns {{ violations: string[], engineNode: string, floor: { major: number, minor: number, patch: number } | null }}
 */
export function runLint(repoRoot) {
  const rootPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const engineNode = /** @type {string | undefined} */ (rootPkg.engines?.node);
  if (!engineNode) {
    return {
      violations: ['root package.json is missing engines.node — cannot lint installer floor.'],
      engineNode: '',
      floor: null,
    };
  }

  const floor = tripleFrom(engineNode);
  if (!floor) {
    return {
      violations: [
        `could not parse a x.y.z triple from engines.node: ${JSON.stringify(engineNode)}`,
      ],
      engineNode,
      floor: null,
    };
  }

  /** @type {string[]} */
  const violations = [];

  /** @type {Array<{ file: string, parser: (src: string) => ({major:number,minor:number,patch:number}|null) }>} */
  const INSTALLERS = [
    { file: join(repoRoot, 'scripts', 'install.sh'), parser: parseShFloor },
    { file: join(repoRoot, 'scripts', 'install.ps1'), parser: parsePsFloor },
  ];

  for (const { file, parser } of INSTALLERS) {
    let src;
    try {
      src = readFileSync(file, 'utf8');
    } catch (/** @type {any} */ err) {
      violations.push(`${file}: could not read file — ${err.message}`);
      continue;
    }

    const found = parser(src);
    if (!found) {
      violations.push(
        `${file}: could not parse NODE_FLOOR_MAJOR/MINOR/PATCH constants.\n` +
          `  Expected pattern in install.sh:   NODE_FLOOR_MAJOR=<N>  NODE_FLOOR_MINOR=<N>  NODE_FLOOR_PATCH=<N>\n` +
          `  Expected pattern in install.ps1:  $NODE_FLOOR_MAJOR = <N>  etc.`,
      );
      continue;
    }

    if (
      found.major !== floor.major ||
      found.minor !== floor.minor ||
      found.patch !== floor.patch
    ) {
      violations.push(
        `${file}: Node floor mismatch.\n` +
          `  Installer has:  ${found.major}.${found.minor}.${found.patch}\n` +
          `  SSoT requires:  ${floor.major}.${floor.minor}.${floor.patch}  (root package.json engines.node: "${engineNode}")\n` +
          `  Fix: update NODE_FLOOR_MAJOR/MINOR/PATCH in the installer to match.`,
      );
    }
  }

  return { violations, engineNode, floor };
}

// ── CLI entry point (only runs when executed directly, not when imported) ─────
const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  const { violations, engineNode, floor } = runLint(REPO_ROOT);

  if (violations.length > 0) {
    console.error(`lint-installer-node-floor: FAIL — ${violations.length} violation(s):`);
    for (const v of violations) {
      console.error(`\n  * ${v}`);
    }
    process.exit(1);
  } else {
    console.log(
      `lint-installer-node-floor: OK — both installers embed Node floor ` +
        `${floor?.major}.${floor?.minor}.${floor?.patch} matching engines.node "${engineNode}".`,
    );
    process.exit(0);
  }
}
