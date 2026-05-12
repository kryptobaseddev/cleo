#!/usr/bin/env node
/**
 * scripts/check-ct-cleo-thin.mjs
 *
 * CI gate: ensures ct-cleo SKILL.md remains a thin pointer and does NOT
 * contain protocol content that belongs in CLEO-INJECTION.md.
 *
 * Failure criteria:
 *   - LOC > 50 (thin-pointer contract per T9148)
 *   - Contains any `## ` section heading that is NOT in the allowed set
 *     (thin pointers may only have: Quick Reference, Skill-Specific Extensions)
 *   - Missing the `<!-- thin-pointer: ... -->` marker
 *
 * Usage:
 *   node scripts/check-ct-cleo-thin.mjs
 *   node scripts/check-ct-cleo-thin.mjs --exit-on-fail
 *
 * Exit codes:
 *   0 — passes all checks
 *   1 — violations found (only in --exit-on-fail mode)
 *
 * @task T9148
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const SKILL_PATH = join(REPO, 'packages/skills/skills/ct-cleo/SKILL.md');
const MAX_LOC = 50;
const THIN_POINTER_MARKER = '<!-- thin-pointer:';
const ALLOWED_HEADINGS = new Set(['Quick Reference', 'Skill-Specific Extensions']);

const exitOnFail = process.argv.includes('--exit-on-fail');

let violations = 0;

function report(msg) {
  process.stdout.write(`  ct-cleo-thin  ${msg}\n`);
  violations++;
}

let content;
try {
  content = readFileSync(SKILL_PATH, 'utf-8');
} catch {
  process.stderr.write(`check-ct-cleo-thin: cannot read ${SKILL_PATH}\n`);
  process.exit(1);
}

const lines = content.split('\n');
const loc = lines.filter((l) => l.trim().length > 0).length;

// Check 1: LOC budget
if (loc > MAX_LOC) {
  report(
    `${SKILL_PATH}: ${loc} non-blank lines exceeds max ${MAX_LOC}. ` +
      `Protocol content must live in CLEO-INJECTION.md, not ct-cleo SKILL.md.`,
  );
}

// Check 2: thin-pointer marker present
if (!content.includes(THIN_POINTER_MARKER)) {
  report(
    `${SKILL_PATH}: missing <!-- thin-pointer: ... --> marker. ` +
      `Add it immediately after the frontmatter block.`,
  );
}

// Check 3: no disallowed ## section headings
for (const line of lines) {
  const m = line.match(/^## (.+)$/);
  if (!m) continue;
  const heading = m[1].trim();
  if (!ALLOWED_HEADINGS.has(heading)) {
    report(
      `${SKILL_PATH}: disallowed section "## ${heading}". ` +
        `Only "## Quick Reference" and "## Skill-Specific Extensions" are permitted. ` +
        `Move content to CLEO-INJECTION.md or delete as stale.`,
    );
  }
}

if (violations === 0) {
  process.stdout.write(`check-ct-cleo-thin: OK (${loc} non-blank lines, all checks pass)\n`);
  process.exit(0);
} else {
  process.stdout.write(`\ncheck-ct-cleo-thin: ${violations} violation(s) found.\n`);
  if (exitOnFail) {
    process.exit(1);
  }
  process.exit(0);
}
