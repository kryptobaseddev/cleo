#!/usr/bin/env node
/**
 * scripts/check-ct-cleo-thin.mjs
 *
 * Gate: ct-cleo SKILL.md stays a thin pointer and does NOT accumulate
 * protocol content that belongs in CLEO-INJECTION.md / CLEO-REFERENCE.md.
 *
 * Rules (T9148):
 *   - at most 50 non-blank lines;
 *   - the `<!-- thin-pointer: ... -->` marker is present;
 *   - `## ` headings only from the allowed set (Quick Reference,
 *     Skill-Specific Extensions).
 *
 * ct-cleo is far past that budget today, so the gate ratchets (T12124):
 * `--check` (what `cleo check arch` runs) fails when the line count rises
 * above the baseline, the marker disappears, or a `## ` section not in the
 * baseline appears; a baselined section that is gone must leave the
 * baseline. `--strict` (and the legacy `--exit-on-fail`) applies the full
 * T9148 rules. Plain invocation reports and exits 0. `--baseline` rewrites
 * the baseline from the current file.
 *
 * Usage:
 *   node scripts/check-ct-cleo-thin.mjs [--check|--strict|--exit-on-fail|--baseline]
 *
 * @task T9148
 * @task T12124
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMain } from './lib/is-main.mjs';

/** Repo-relative path of the checked skill. */
export const SKILL_REL = 'packages/skills/skills/ct-cleo/SKILL.md';

/** Repo-relative path of the ratchet baseline. */
export const BASELINE_REL = 'scripts/.check-ct-cleo-thin-baseline.json';

/** T9148 non-blank line budget. */
export const MAX_LOC = 50;

const THIN_POINTER_MARKER = '<!-- thin-pointer:';
const ALLOWED_HEADINGS = new Set(['Quick Reference', 'Skill-Specific Extensions']);

/**
 * Measure the skill.
 *
 * @param {string} content - SKILL.md text.
 * @returns {{ loc: number, extraHeadings: string[], hasMarker: boolean }}
 */
export function measure(content) {
  const lines = content.split('\n');
  return {
    loc: lines.filter((l) => l.trim().length > 0).length,
    extraHeadings: lines
      .map((l) => l.match(/^## (.+)$/)?.[1].trim())
      .filter((h) => h && !ALLOWED_HEADINGS.has(h)),
    hasMarker: content.includes(THIN_POINTER_MARKER),
  };
}

/**
 * Violations for a measured skill.
 *
 * @param {ReturnType<typeof measure>} m - Measurement.
 * @param {{ maxNonBlankLines: number, extraHeadings: string[] } | null} baseline
 *   Ratchet baseline, or `null` for the strict T9148 rules.
 * @returns {string[]}
 */
export function findViolations(m, baseline) {
  const violations = [];
  if (baseline) {
    const allowed = new Set(baseline.extraHeadings);
    if (m.loc > baseline.maxNonBlankLines) {
      violations.push(
        `${SKILL_REL}: ${m.loc} non-blank lines exceeds the baseline ${baseline.maxNonBlankLines} (target ${MAX_LOC}). Move protocol content to CLEO-INJECTION.md / CLEO-REFERENCE.md or a references/ file.`,
      );
    }
    for (const h of m.extraHeadings) {
      if (!allowed.has(h)) {
        violations.push(
          `${SKILL_REL}: new section "## ${h}". Put it in references/ or under "## Skill-Specific Extensions".`,
        );
      }
    }
    for (const h of allowed) {
      if (!m.extraHeadings.includes(h)) {
        violations.push(
          `${BASELINE_REL}: section "## ${h}" is gone — remove it from the baseline.`,
        );
      }
    }
  } else {
    if (m.loc > MAX_LOC)
      violations.push(`${SKILL_REL}: ${m.loc} non-blank lines exceeds max ${MAX_LOC}.`);
    for (const h of m.extraHeadings) {
      violations.push(
        `${SKILL_REL}: disallowed section "## ${h}". Only "## Quick Reference" and "## Skill-Specific Extensions" are permitted.`,
      );
    }
  }
  if (!m.hasMarker) violations.push(`${SKILL_REL}: missing <!-- thin-pointer: ... --> marker.`);
  return violations;
}

/**
 * Run the gate.
 *
 * @param {string} root - Repository root.
 * @param {string[]} args - CLI flags.
 * @returns {number} Exit code.
 */
export function runGate(root, args) {
  const strict = args.includes('--strict') || args.includes('--exit-on-fail');
  const ratchet = args.includes('--check') && !strict;
  let content;
  try {
    content = readFileSync(join(root, SKILL_REL), 'utf-8');
  } catch {
    process.stderr.write(`check-ct-cleo-thin: cannot read ${SKILL_REL}\n`);
    return 1;
  }
  const m = measure(content);

  if (args.includes('--baseline')) {
    writeFileSync(
      join(root, BASELINE_REL),
      `${JSON.stringify({ maxNonBlankLines: m.loc, extraHeadings: m.extraHeadings }, null, 2)}\n`,
    );
    process.stdout.write(
      `check-ct-cleo-thin: baseline written (${m.loc} lines, ${m.extraHeadings.length} extra sections)\n`,
    );
    return 0;
  }

  const baseline = ratchet ? JSON.parse(readFileSync(join(root, BASELINE_REL), 'utf-8')) : null;
  const violations = findViolations(m, baseline);
  if (violations.length === 0) {
    process.stdout.write(
      `check-ct-cleo-thin: OK (${m.loc} non-blank lines, ${m.extraHeadings.length} extra sections${ratchet ? ', within baseline' : ''})\n`,
    );
    return 0;
  }
  for (const v of violations) process.stdout.write(`  ct-cleo-thin  ${v}\n`);
  process.stdout.write(`\ncheck-ct-cleo-thin: ${violations.length} violation(s) found.\n`);
  return ratchet || strict ? 1 : 0;
}

if (isMain(import.meta.url)) {
  process.exit(runGate(process.cwd(), process.argv.slice(2)));
}
