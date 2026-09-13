#!/usr/bin/env node

/**
 * Duplicate Test Filename Gate (T12154 · gh#1286)
 *
 * Test files are not identifiable by name. **71 filenames are shared by two or
 * more test files** out of ~1600, and `registry.test.ts` exists eleven times.
 * So any discussion that names "the prune test" or "the registry test" — in an
 * issue, a commit message, or between two agents — starts from an unstated
 * assumption about WHICH file is meant, and nothing in the conversation
 * reveals the mismatch.
 *
 * ## It is a coordination defect, not a tidiness one
 *
 * Measured 2026-09-12: two agents debugged a failing `worktree-prune.test.ts`
 * for an extended exchange while reasoning about DIFFERENT FILES —
 * `packages/core/src/__tests__/` (3 tests), `packages/worktree/src/__tests__/`
 * (5 tests) and `packages/core/src/spawn/__tests__/` (12 tests) all share that
 * name. One produced a correct module-graph analysis proving the failure was
 * impossible, of the file that was never failing. The other read the test-count
 * mismatch (3 vs 5) as evidence about how the tests were RUN rather than about
 * which file was meant.
 *
 * The mismatch was visible in both messages and neither noticed, because a
 * basename looks like an identifier.
 *
 * A developer holds the path in their editor; agents exchange NAMES in prose.
 * That is why this bites hardest in exactly the workflow this repo provisions.
 *
 * ## What this gate does
 *
 * Baselined, forward-only: the existing duplicates are recorded and the count
 * per name may only go DOWN. A name that is newly duplicated fails, and an
 * existing duplicate gaining another file fails. Renaming the 71 today is not
 * required — stopping the 72nd is.
 *
 * Modes:
 *   (default)           fail on any regression against the baseline
 *   --update-baseline   regenerate after a deliberate improvement
 *   --strict            zero tolerance: fail on ANY duplicate at all
 *
 * @task T12154 (gh#1286)
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const BASELINE = resolve(REPO_ROOT, 'scripts/.lint-duplicate-test-filenames-baseline.json');

const args = new Set(process.argv.slice(2));
const UPDATE = args.has('--update-baseline');
const STRICT = args.has('--strict');

/**
 * Every test file tracked by git, as repo-relative paths.
 *
 * `git ls-files` rather than a filesystem walk: it respects .gitignore for
 * free, so a stray build artefact or a sibling worktree's `node_modules`
 * cannot inflate the count and make the gate fail for a reason unrelated to
 * the tree under review.
 */
function testFiles() {
  const out = execFileSync('git', ['ls-files', '*.test.ts', '*.test.tsx'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  });
  return out.split('\n').filter(Boolean);
}

/** basename -> sorted list of repo-relative paths sharing it. */
function groupByBasename(files) {
  const groups = new Map();
  for (const f of files) {
    const base = f.slice(f.lastIndexOf('/') + 1);
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(f);
  }
  return groups;
}

const files = testFiles();
const groups = groupByBasename(files);
const duplicates = new Map(
  [...groups.entries()]
    .filter(([, paths]) => paths.length > 1)
    .sort(([a], [b]) => a.localeCompare(b)),
);

if (UPDATE) {
  const record = {
    generatedAt: new Date().toISOString(),
    note:
      'Duplicate test filenames (gh#1286). Counts may only DECREASE. ' +
      'Regenerate with: node scripts/lint-duplicate-test-filenames.mjs --update-baseline',
    totalTestFiles: files.length,
    duplicatedNames: duplicates.size,
    counts: Object.fromEntries([...duplicates].map(([name, paths]) => [name, paths.length])),
  };
  writeFileSync(BASELINE, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
  console.log(
    `lint-duplicate-test-filenames: baseline written — ${duplicates.size} duplicated name(s) across ${files.length} test files.`,
  );
  process.exit(0);
}

if (STRICT) {
  if (duplicates.size === 0) {
    console.log('lint-duplicate-test-filenames: STRICT OK — every test filename is unique.');
    process.exit(0);
  }
  console.error(
    `lint-duplicate-test-filenames: STRICT FAIL — ${duplicates.size} duplicated test filename(s).`,
  );
  for (const [name, paths] of duplicates) {
    console.error(`\n  ${name}  (${paths.length})`);
    for (const p of paths) console.error(`    ${p}`);
  }
  process.exit(1);
}

let baseline;
try {
  baseline = JSON.parse(readFileSync(BASELINE, 'utf-8'));
} catch {
  console.error(
    `lint-duplicate-test-filenames: no baseline at ${relative(REPO_ROOT, BASELINE)}.\n` +
      '  Create it with: node scripts/lint-duplicate-test-filenames.mjs --update-baseline',
  );
  process.exit(1);
}

const baseCounts = baseline.counts ?? {};
const regressions = [];

for (const [name, paths] of duplicates) {
  const was = baseCounts[name] ?? 1;
  if (paths.length > was) {
    regressions.push({ name, was, now: paths.length, paths });
  }
}

if (regressions.length === 0) {
  const improved = Object.entries(baseCounts).filter(
    ([name, was]) => (duplicates.get(name)?.length ?? 1) < was,
  );
  const suffix =
    improved.length > 0
      ? ` (${improved.length} name(s) improved — consider --update-baseline)`
      : '';
  console.log(
    `lint-duplicate-test-filenames: OK — ${duplicates.size} duplicated name(s), no regression against baseline${suffix}.`,
  );
  process.exit(0);
}

console.error(
  `lint-duplicate-test-filenames: FAIL — ${regressions.length} test filename(s) became MORE ambiguous:\n`,
);
for (const r of regressions) {
  console.error(`  ${r.name}: ${r.was} -> ${r.now}`);
  for (const p of r.paths) console.error(`    ${p}`);
  console.error('');
}
console.error(
  'A basename that names several files is not an identifier. Two agents debugging\n' +
    '"the prune test" reasoned about different files for an extended exchange because\n' +
    'of exactly this (gh#1286).\n\n' +
    '  FIX: give the new file a name that carries its package or subject, e.g.\n' +
    '       worktree-prune.spawn.test.ts rather than a third worktree-prune.test.ts\n\n' +
    '  If a duplicate is genuinely unavoidable, regenerate the baseline with\n' +
    '  --update-baseline and say why in the commit message.',
);
process.exit(1);
