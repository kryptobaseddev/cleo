#!/usr/bin/env node
/**
 * Gate: the skills manifest is generated from SKILL.md frontmatter, and the
 * frontmatter is valid (T12648 · spec `skills-curation-and-automation` §3.2.1,
 * §3.2.4 · owner decision D11157).
 *
 * ## What this prevents
 *
 * The skills audit (2026-09-28) found the same skill with three different
 * versions across metadata files, tiers that disagreed, a skill directory the
 * manifest omitted (`ct-codebase-mapper`), a manifest entry with no directory
 * (`loom`), and a SKILL.md with two `metadata:` blocks — invalid YAML that
 * each reader resolved differently. None of it failed anything, because no
 * check tied the index to the files it describes.
 *
 * ## What it checks
 *
 * 1. Every `packages/skills/skills/<dir>/SKILL.md` frontmatter is valid:
 *    `name` equals the directory, a description of at most 1024 characters,
 *    no duplicate keys, no top-level `tier`, and `metadata.version` (X.Y.Z),
 *    `metadata.tier` (core|on-demand|internal) and `metadata.install`
 *    (harness|internal). A top-level `version`, where kept for older readers,
 *    must equal `metadata.version`.
 * 2. ct-cleo's `metadata.version` equals the `Version:` line of
 *    `CLEO-INJECTION.md` and `CLEO-REFERENCE.md`, the protocol it documents.
 * 3. `packages/skills/skills/manifest.json` is byte-identical to what
 *    `scripts/skills/generate-manifest.mjs` produces — so every directory is
 *    listed, no entry lacks a directory, and no identity field is hand-edited.
 *
 * Zero tolerance: `--check` and `--strict` behave the same. The fix is always
 * `node scripts/skills/generate-manifest.mjs` after correcting frontmatter.
 *
 * Usage: node scripts/lint-skills-manifest.mjs [--check|--strict] [--json]
 *
 * @task T12648
 */

import { isMain } from './lib/is-main.mjs';
import { checkManifest } from './skills/generate-manifest.mjs';

/**
 * Run the gate.
 *
 * @param {string} root - Repository root.
 * @param {{ json?: boolean }} [opts] - Output options.
 * @returns {number} Exit code: 0 clean, 1 on any problem or drift.
 */
export function runGate(root, opts = {}) {
  const { problems, drift } = checkManifest(root);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ problems, drift }, null, 2)}\n`);
    return problems.length + drift.length > 0 ? 1 : 0;
  }
  if (problems.length + drift.length === 0) {
    process.stdout.write(
      'Skills manifest matches SKILL.md frontmatter; all frontmatter valid (T12648).\n',
    );
    return 0;
  }
  if (problems.length > 0) {
    process.stderr.write(`${problems.length} invalid SKILL.md frontmatter field(s):\n`);
    for (const p of problems) process.stderr.write(`  ✗ ${p.skill}: ${p.problem}\n`);
  }
  if (drift.length > 0) {
    process.stderr.write('packages/skills/skills/manifest.json drifted from frontmatter:\n');
    for (const d of drift) process.stderr.write(`  ✗ ${d}\n`);
  }
  process.stderr.write(
    'Fix the frontmatter, then run: node scripts/skills/generate-manifest.mjs\n',
  );
  return 1;
}

if (isMain(import.meta.url)) {
  process.exit(runGate(process.cwd(), { json: process.argv.includes('--json') }));
}
