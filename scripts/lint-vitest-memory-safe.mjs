#!/usr/bin/env node
/**
 * Gate: every vitest config MUST spread the memory-safe fork bounds (T12087).
 *
 * ## What this prevents
 *
 * `pool: 'forks'` at vitest's default `maxWorkers` (CPU-1) spawns ~23 forks on a
 * 24-core box. Each loads the `@cleocode/core` graph (~2.7 GB), and with no V8
 * ceiling one leaky test grows without bound: ~62 GB → kernel OOM → the machine
 * freezes and the session dies. It happened twice on 2026-08-06.
 *
 * T11839 fixed it in the ROOT config and leaned on `test.extends: true` to
 * propagate. That covers `pnpm run test` but NOT the convenient path:
 *
 *     vitest run --root packages/core     # this package IS the root
 *     pnpm run test:pkg <name>            # same
 *
 * A guard present on one invocation path and absent on another is no guard, so
 * `vitest.memory-safe.ts` is now the SSoT and every config spreads it directly.
 * This gate keeps a new package (or a well-meaning edit) from silently opting
 * out again.
 *
 * ## Checks
 *
 *   1. `vitest.memory-safe.ts` exists and exports MEMORY_SAFE_TEST_DEFAULTS.
 *   2. Every git-tracked `vitest.config.*` ANYWHERE in the repo imports AND
 *      spreads it (gh#1354 — the previous root+`packages/*` glob could not see
 *      `scripts/vitest.config.ts`, which was the one file still inheriting).
 *   3. No config re-declares `maxWorkers` / `poolOptions.forks.execArgv` after
 *      the spread — that would silently override the ceiling.
 *   4. No config overrides `pool` away from `'forks'` (per-worker V8 flags do
 *      not apply to worker_threads, so the heap cap would evaporate).
 *
 * Zero-tolerance: there is no baseline. A machine-freezing default is not
 * something to burn down gradually.
 *
 * @task T12087
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.cwd();
const SSOT = 'vitest.memory-safe.ts';
const MARKER = 'MEMORY_SAFE_TEST_DEFAULTS';

/** Strip line + block comments so a commented-out override is not a violation. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const violations = [];

// 1 — the SSoT itself.
const ssotPath = join(REPO, SSOT);
if (!existsSync(ssotPath)) {
  violations.push(`${SSOT} is missing — it is the single source of the fork bounds.`);
} else if (!readFileSync(ssotPath, 'utf8').includes(`export const ${MARKER}`)) {
  violations.push(`${SSOT} does not export ${MARKER}.`);
}

// 2-4 — every config.
//
// gh#1354: this was `['vitest.config.ts', ...globSync('packages/*/vitest.config.ts')]`
// — root plus one directory level. `scripts/vitest.config.ts` is git-tracked and
// live, sat outside that glob, and was the ONE config in the repo still relying
// on `extends: true` instead of spreading the defaults. The gate reported
// "OK — 20 vitest config(s)" and 20 was a count of the files it had chosen to
// look at, not of the files that exist. A zero-tolerance gate reporting a total
// it derived from its own blind spot is the worst available shape.
//
// Derived from `git ls-files` rather than enumerated, so the set is "every
// config in the repo" by construction. A future `tools/vitest.config.ts` is
// covered the day it is committed, with no edit here — which is the only kind
// of fix that survives the next directory.
function trackedVitestConfigs() {
  const out = execFileSync('git', ['ls-files', '-z', '*vitest.config.*'], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return out
    .split('\0')
    .filter(Boolean)
    .filter((f) => /(^|\/)vitest\.config\.(ts|mts|cts|js|mjs|cjs)$/.test(f))
    .sort();
}

const configs = trackedVitestConfigs();
if (configs.length === 0) {
  // An empty scan is not a pass. If `git ls-files` returns nothing the gate has
  // lost its input, and reporting OK would be exactly the failure above.
  console.error(
    'lint-vitest-memory-safe: FAIL — found no tracked vitest config files. ' +
      'The scan lost its input; this is not a clean repo.',
  );
  process.exit(1);
}

for (const rel of configs) {
  const abs = join(REPO, rel);
  if (!existsSync(abs)) continue;
  const src = stripComments(readFileSync(abs, 'utf8'));

  if (!src.includes(MARKER)) {
    violations.push(
      `${rel}: does not spread ${MARKER}. A direct \`vitest run --root <pkg>\` would ` +
        `then run with vitest's default fork count and NO heap ceiling. ` +
        `Add \`import { ${MARKER} } from '<rel>/vitest.memory-safe.js'\` and spread it ` +
        `first inside \`test: { … }\`.`,
    );
    continue;
  }

  const spreadIdx = src.indexOf(`...${MARKER}`);
  if (spreadIdx === -1) {
    violations.push(`${rel}: imports ${MARKER} but never spreads it (\`...${MARKER}\`).`);
    continue;
  }

  // Vitest 4 REMOVED `test.poolOptions` and ignores it with only a stderr
  // deprecation warning. T11839's heap cap was written in that shape, so it was
  // dead from the Vitest 4 upgrade onward while still reading as present in the
  // config — the machine kept freezing behind a fix that looked applied.
  if (/\bpoolOptions\s*:/.test(src)) {
    violations.push(
      `${rel}: uses \`poolOptions\`, which Vitest 4 REMOVED and silently ignores. ` +
        `Move the setting to its top-level equivalent (\`execArgv\`, \`isolate\`, ` +
        `\`maxWorkers\`, \`vmMemoryLimit\`). A silently-ignored guard is worse than a ` +
        `missing one: it passes review and is absent at runtime.`,
    );
  }

  const after = src.slice(spreadIdx);
  if (/\bmaxWorkers\s*:/.test(after)) {
    violations.push(
      `${rel}: re-declares \`maxWorkers\` AFTER the spread, overriding the RAM-derived ` +
        `ceiling. Remove it, or raise the ceiling in ${SSOT} where the reasoning lives.`,
    );
  }
  if (/execArgv\s*:/.test(after)) {
    violations.push(
      `${rel}: re-declares \`execArgv\` AFTER the spread, dropping ` +
        `\`--max-old-space-size\`. One leaky test then grows until the kernel intervenes.`,
    );
  }
  const poolOverride = after.match(/\bpool\s*:\s*'([a-z]+)'/);
  if (poolOverride && poolOverride[1] !== 'forks') {
    violations.push(
      `${rel}: overrides \`pool\` to '${poolOverride[1]}' after the spread. Per-worker V8 ` +
        `flags only apply to the fork pool, so the heap ceiling would not exist.`,
    );
  }
}

if (violations.length > 0) {
  console.error(`lint-vitest-memory-safe: FAIL — ${violations.length} violation(s):\n`);
  for (const v of violations) console.error(`  • ${v}`);
  console.error(
    `\nWhy this is zero-tolerance: an unbounded fork pool on a large dev box is a ` +
      `machine-freezing default, and it only ever bites locally — CI runners have ` +
      `2-4 cores, so it passes there and takes down the developer instead.`,
  );
  process.exit(1);
}

console.log(`lint-vitest-memory-safe: OK — ${configs.length} vitest config(s) spread ${MARKER}.`);
