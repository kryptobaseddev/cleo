#!/usr/bin/env node
/**
 * Lint rule: every `.changeset/*.md` file (excluding `README.md`) MUST be a
 * valid CLEO-native changeset entry parseable by
 * `@cleocode/core/src/changesets/parser.ts`.
 *
 * Iterates every file in `.changeset/` (sorted, deterministic) and parses
 * each one independently — collecting EVERY violation instead of bailing
 * on the first one. The aggregator surface (`cleo release plan`) blows up
 * silently when N entries share a class of bug, and only ever localises
 * the first; surfacing all of them in CI in one shot lets authors fix the
 * batch in a single round-trip.
 *
 * The previous "first-error wins" behaviour was the contributing factor
 * behind the T9936 drift case (4 changesets with `kind: feature` shipped
 * past lint because the first malformed file masked the rest).
 *
 * @epic T9738
 * @task T9738
 * @task T9936  — fail-fast → collect-all, kind-drift regression guard
 */

import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Configuration ────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');
// Tests redirect at the directory boundary via `CLEO_LINT_CHANGESET_DIR`
// — production CI runs always use the repo-root `.changeset/`.
const CHANGESET_DIR = process.env.CLEO_LINT_CHANGESET_DIR ?? join(REPO_ROOT, '.changeset');

// ─── Resolve the parser from built core, or fall back to a TS-loader hint ─────
// The parser lives in `@cleocode/core` — when running in CI the package has
// been built and `dist/changesets/index.js` exists. For local dev we fall
// back to telling the user to build first rather than spinning up a TS
// loader (avoids tsx/ts-node coupling).
//
// gh#1367: import the DEEP changesets module, not the `dist/index.js` barrel.
// This script's runtime is ~96% module loading and ~4% actual parsing, and the
// barrel drags the full 1266-module core graph in to reach one function.
// Measured 2026-09-14 over 315 entries:
//
//   parse 315 entries                  65.9 ms   (0.21 ms/entry)
//   `dist/index.js` (barrel) import   1750.4 ms
//   `dist/changesets/index.js` import  605.4 ms
//
// The same substitution on the ntfs-3g mount the repo used to live on takes the
// whole script from 346.7 s to ~36 s, because every avoided module is a FUSE
// round-trip. This is the same cost that arch gate 19 ratchets in the CLI.

const corePkgRoot = join(REPO_ROOT, 'packages/core');
const changesetsDist = join(corePkgRoot, 'dist/changesets/index.js');

if (!existsSync(changesetsDist)) {
  process.stderr.write(
    `lint-changesets: @cleocode/core has not been built — ${changesetsDist} is missing. ` +
      `Run 'pnpm run build' first.\n`,
  );
  process.exit(2);
}

// Per-file parsing lets us collect every error in one pass rather than bailing
// on the first one.
/** @type {{ parseChangesetFile: (path: string) => unknown }} */
const changesetsMod = await import(`file://${changesetsDist}`);
const { parseChangesetFile } = changesetsMod;

if (typeof parseChangesetFile !== 'function') {
  // A renamed or moved export must fail loudly here. Left unchecked it would
  // throw once per entry inside the loop below and be collected as N invalid
  // changesets — a tooling break wearing the costume of a content failure,
  // which is the whole defect this file is being changed for.
  process.stderr.write(
    `lint-changesets: ${changesetsDist} does not export parseChangesetFile — ` +
      `the build layout changed and this gate cannot validate anything.\n`,
  );
  process.exit(2);
}

// ─── Run ──────────────────────────────────────────────────────────────────────

if (!existsSync(CHANGESET_DIR)) {
  process.stderr.write(`lint-changesets: ${CHANGESET_DIR} does not exist.\n`);
  process.exit(2);
}

const files = readdirSync(CHANGESET_DIR)
  .filter((name) => name.endsWith('.md') && name !== 'README.md')
  .sort();

/** @type {{ file: string; message: string }[]} */
const failures = [];
let okCount = 0;

for (const name of files) {
  const path = join(CHANGESET_DIR, name);
  try {
    parseChangesetFile(path);
    okCount += 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failures.push({ file: name, message });
  }
}

if (failures.length === 0) {
  process.stdout.write(`lint-changesets: ${okCount} entry/entries validated successfully.\n`);
  process.exit(0);
}

// Surface EVERY failing entry so authors can fix the batch in one round.
process.stderr.write(
  `lint-changesets: FAIL — ${failures.length} of ${files.length} entries rejected.\n\n`,
);
for (const { file, message } of failures) {
  process.stderr.write(`✗ ${file}\n${message}\n\n`);
}
process.stderr.write(
  `lint-changesets: ${okCount} valid · ${failures.length} invalid\n` +
    'Fix each entry above and re-run. Canonical kinds: feat|fix|perf|refactor|docs|test|chore|breaking.\n',
);
process.exit(1);
