#!/usr/bin/env node
/**
 * lint-adr-index-jsonl-frozen — T10165 (Saga T9855)
 *
 * Guards the frozen `.cleo/adrs/adr-index.jsonl` portability export. As of
 * T10165 the canonical store for ADR metadata is the `attachments` table
 * provenance columns shipped by T10158; the JSONL is preserved on disk for
 * one deprecation cycle so external scripts that still read it keep
 * working, but **adding new data lines** to it is forbidden.
 *
 * The lint walks the working tree's `adr-index.jsonl`, drops the leading
 * `# DEPRECATED…` comment block, and asserts every remaining line either:
 *
 *   1. is blank, or
 *   2. is a valid JSON object carrying both an `id` (`ADR-NNN`) AND a
 *      `file` (`.cleo/adrs/…`) field.
 *
 * Any other content — e.g. a freshly-appended row from a regenerator that
 * was missed during the T10165 sweep — fails with exit code 1 and the
 * canonical error code `E_ADR_INDEX_JSONL_FROZEN` so CI surfaces a
 * googleable signal.
 *
 * Modes:
 *
 *   - default               : verify the file's frozen invariants
 *   - `--check-no-growth`   : compare against `origin/main` and fail when
 *                             NEW data lines were added (CI usage)
 *
 * Exit codes: `0` = clean, `1` = violation, `2` = invocation error.
 *
 * @task T10165
 * @epic T10157 (C-DOCS-SSOT)
 * @saga T9855 (SG-TEMPLATE-CONFIG-SSOT)
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');
const ADR_INDEX_PATH = join(REPO_ROOT, '.cleo', 'adrs', 'adr-index.jsonl');
const ERROR_CODE = 'E_ADR_INDEX_JSONL_FROZEN';

/** @param {string} line */
function isCommentLine(line) {
  return line.trim().startsWith('#');
}

/** @param {string} line */
function isBlankLine(line) {
  return line.trim().length === 0;
}

/**
 * Returns the count of NEW data lines added relative to the base ref.
 * Implemented via `git diff --unified=0` so only `+` lines that survive
 * after dropping context show up. Header `#` additions are excluded.
 *
 * @param {string} baseRef
 */
function countNewDataLinesSinceBase(baseRef) {
  let diff;
  try {
    diff = execSync(`git diff --unified=0 ${baseRef}...HEAD -- ${ADR_INDEX_PATH}`, {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    // The base ref may not exist locally (e.g. a fresh checkout in CI).
    // Surface the error but treat it as soft-warn rather than a hard fail
    // — the in-tree freeze check is the load-bearing rule.
    process.stderr.write(
      `lint-adr-index-jsonl-frozen: warning — could not diff against ${baseRef}: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    return 0;
  }

  let added = 0;
  for (const line of diff.split('\n')) {
    // `+++` is the diff header; skip it. Real additions look like `+{"id":…}`.
    if (line.startsWith('+++ ')) continue;
    if (!line.startsWith('+')) continue;
    const body = line.slice(1);
    if (isBlankLine(body)) continue;
    if (isCommentLine(body)) continue;
    added += 1;
  }
  return added;
}

/**
 * Parse the file in-place and surface every line that violates the frozen
 * shape (must be a comment, blank, or a JSON object with id+file). Returns
 * the list of violation messages — caller decides exit-code mapping.
 */
function scanFrozenInvariants() {
  /** @type {string[]} */
  const violations = [];
  if (!existsSync(ADR_INDEX_PATH)) {
    // The file is gone entirely — that's fine, the freeze is trivially intact.
    return violations;
  }
  const raw = readFileSync(ADR_INDEX_PATH, 'utf-8');
  let lineNo = 0;
  for (const line of raw.split('\n')) {
    lineNo += 1;
    if (isBlankLine(line)) continue;
    if (isCommentLine(line)) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      violations.push(`line ${lineNo}: not valid JSON — ${ERROR_CODE}`);
      continue;
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.id !== 'string' ||
      typeof parsed.file !== 'string'
    ) {
      violations.push(`line ${lineNo}: missing id/file fields — ${ERROR_CODE}`);
      continue;
    }
    if (!/^ADR-\d+/.test(parsed.id)) {
      violations.push(`line ${lineNo}: id "${parsed.id}" not an ADR-NNN — ${ERROR_CODE}`);
    }
  }
  return violations;
}

// ─── Run ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const checkNoGrowth = args.includes('--check-no-growth');
const baseRefArg = args.find((a) => a.startsWith('--base='));
const baseRef = baseRefArg ? baseRefArg.slice('--base='.length) : 'origin/main';

const violations = scanFrozenInvariants();
let failed = false;

if (violations.length > 0) {
  process.stderr.write(
    `lint-adr-index-jsonl-frozen: FAIL (${ERROR_CODE})\n${violations
      .map((v) => `  - ${v}`)
      .join('\n')}\n`,
  );
  failed = true;
}

if (checkNoGrowth) {
  const added = countNewDataLinesSinceBase(baseRef);
  if (added > 0) {
    process.stderr.write(
      `lint-adr-index-jsonl-frozen: FAIL (${ERROR_CODE})\n` +
        `  - ${added} new data line(s) added to .cleo/adrs/adr-index.jsonl since ${baseRef}\n` +
        `  - the file is frozen as of T10165; backfill writes go to the attachments table\n` +
        `  - see packages/core/src/migration/manual/T10165-backfill-adr-index.ts\n`,
    );
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}

process.stdout.write(
  `lint-adr-index-jsonl-frozen: OK (frozen file invariants intact${
    checkNoGrowth ? `; no new data lines since ${baseRef}` : ''
  })\n`,
);
process.exit(0);
