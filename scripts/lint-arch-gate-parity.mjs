#!/usr/bin/env node
/**
 * Gate 20 — the gate on the gates (T12122 · GH #1251).
 *
 * Asserts that the gate list bundled into `cleo check arch`
 * (`packages/cleo/src/cli/commands/check.ts`) and the gate table documented in
 * `AGENTS.md` name the SAME set of lint scripts.
 *
 * Why this exists
 * ---------------
 * Measured 2026-09-12: `cleo check arch` bundled 10 gates while the AGENTS.md
 * table documented 15, and the two had drifted in BOTH directions — 9
 * documented gates the runner never ran, and 4 runner gates the table never
 * listed. Every agent is instructed to run `cleo check arch` to self-check
 * before pushing, so the command was handing out a green that covered
 * two-thirds of its own documentation.
 *
 * That is the same defect class as a filter flag that is accepted and then not
 * applied (GH #1245): the tool reports success for work it did not do, and the
 * caller cannot tell. A count mismatch is silent; this gate makes it loud.
 *
 * The join key is the SCRIPT PATH, never the gate number. The two numbering
 * schemes are independent and already collide (runner `gate-6` is the
 * getActiveSession gate; table row 6 is the CLI package boundary), so matching
 * on numbers would be fragile and would invite renumbering churn.
 *
 * Zero-tolerance: there is no baseline. A gate is either in both places or the
 * build fails.
 *
 * Usage: node scripts/lint-arch-gate-parity.mjs [--check|--strict]
 *
 * @task T12122
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK_TS = join(REPO_ROOT, 'packages/cleo/src/cli/commands/check.ts');
const AGENTS_MD = join(REPO_ROOT, 'AGENTS.md');

/** This gate itself — present in the runner by definition, and in the table. */
const SELF = 'scripts/lint-arch-gate-parity.mjs';

/**
 * Scripts bundled into the `cleo check arch` gate array.
 *
 * Read from SOURCE, never `dist/`, so the gate needs no build (same contract
 * as gates 14 and 15).
 */
export function bundledScripts(source) {
  const out = new Set();
  for (const m of source.matchAll(/script:\s*'(scripts\/[A-Za-z0-9._-]+\.mjs)'/g)) {
    out.add(m[1]);
  }
  return out;
}

/**
 * Scripts named in the AGENTS.md architectural-gate table.
 *
 * Scoped to the table itself: AGENTS.md references other scripts elsewhere
 * (migration helpers, the worktree location lint) that are not arch gates.
 * A trailing `--strict` inside the cell is stripped — the table documents the
 * invocation, the runner supplies the mode flag.
 */
export function documentedScripts(source) {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => l.startsWith('## SSoT & Architectural Gates'));
  if (start === -1) {
    throw new Error(
      'lint-arch-gate-parity: could not find the "## SSoT & Architectural Gates" heading in AGENTS.md',
    );
  }
  const out = new Set();
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('## ')) break;
    if (!line.startsWith('|')) continue;
    for (const m of line.matchAll(/`(scripts\/[A-Za-z0-9._-]+\.mjs)(?:\s+--strict)?`/g)) {
      out.add(m[1]);
    }
  }
  return out;
}

export function main() {
  const bundled = bundledScripts(readFileSync(CHECK_TS, 'utf-8'));
  const documented = documentedScripts(readFileSync(AGENTS_MD, 'utf-8'));

  const undocumented = [...bundled].filter((s) => !documented.has(s)).sort();
  const unbundled = [...documented].filter((s) => !bundled.has(s)).sort();

  if (undocumented.length === 0 && unbundled.length === 0) {
    console.log(
      `✓ arch-gate parity: ${bundled.size} gate(s) bundled in \`cleo check arch\` == ${documented.size} documented in AGENTS.md.`,
    );
    process.exit(0);
  }

  console.error('ARCH-GATE PARITY FAIL — `cleo check arch` and the AGENTS.md table disagree.');
  console.error('');
  if (unbundled.length > 0) {
    console.error(
      `  ${unbundled.length} gate(s) DOCUMENTED but not bundled — agents running \`cleo check arch\``,
    );
    console.error('  get a green that never exercised them:');
    for (const s of unbundled) console.error(`    - ${s}`);
    console.error('');
    console.error(
      '  Fix: add each to the `gates` array in packages/cleo/src/cli/commands/check.ts.',
    );
    console.error('');
  }
  if (undocumented.length > 0) {
    console.error(`  ${undocumented.length} gate(s) BUNDLED but not documented:`);
    for (const s of undocumented) console.error(`    - ${s}`);
    console.error('');
    console.error(
      '  Fix: add a row for each to the gate table under "## SSoT & Architectural Gates" in AGENTS.md.',
    );
    console.error('');
  }
  console.error(`  (This gate is itself ${SELF}; it has no baseline by design.)`);
  process.exit(1);
}

// Only run main() when invoked directly (not when imported by tests).
const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main();
}
