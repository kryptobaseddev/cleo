#!/usr/bin/env node
/**
 * Top-N skills selector for the SG-CLEO-SKILLS owner-CI council pipeline.
 *
 * Reads `docs/skills/telemetry-aggregate.json` (produced by operator PRs per
 * ADR-074), aggregates `loadCount` across submissions, and emits the top-N
 * canonical skills as a JSON file that `skills-council.yml` consumes.
 *
 * Bootstrap-tolerant: when the aggregate file is missing (first run after
 * the workflows land) or malformed, the script exits 0 with an empty
 * selection so the surrounding cron stays green during rollout.
 *
 * Aggregate file shape (per ADR-074):
 *   {
 *     submissions: [
 *       {
 *         installId: string,
 *         period: string,
 *         skills: [{ canonicalSkillName: string, loadCount: number }]
 *       }
 *     ]
 *   }
 *
 * Output shape:
 *   {
 *     selectedAt: ISO-8601 string,
 *     totalSubmissions: number,
 *     skills: [{ canonicalSkillName: string, loadCount: number, submitters: number }]
 *   }
 *
 * Usage:
 *   node scripts/skills/select-top-n.mjs \
 *     --aggregate docs/skills/telemetry-aggregate.json \
 *     --n 5 \
 *     --out /tmp/top-n.json
 *
 * @task T9678
 * @epic T9572
 * @see .cleo/adrs/ADR-074-skills-telemetry-pr-diff-transport.md
 * @see .github/workflows/skills-council.yml
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { exit, stderr, stdout } from 'node:process';

/**
 * Parse CLI flags into a structured options bag.
 *
 * The script accepts long-form flags only (`--aggregate`, `--n`, `--out`) to
 * keep the GHA invocation grep-friendly. Unrecognised flags are tolerated
 * (logged to stderr) so future hardening (e.g. `--min-submissions`) can land
 * additively without breaking existing workflow invocations.
 *
 * @param {string[]} argv - Raw argv slice (no `node` / script path).
 * @returns {{ aggregate: string, n: number, out: string }} Parsed options.
 */
function parseArgs(argv) {
  /** @type {{ aggregate: string, n: number, out: string }} */
  const out = { aggregate: '', n: 5, out: '' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--aggregate' && i + 1 < argv.length) {
      out.aggregate = argv[++i];
    } else if (arg === '--n' && i + 1 < argv.length) {
      const n = Number.parseInt(argv[++i], 10);
      if (!Number.isFinite(n) || n <= 0) {
        stderr.write(`select-top-n: --n must be a positive integer, got '${argv[i]}'\n`);
        exit(2);
      }
      out.n = n;
    } else if (arg === '--out' && i + 1 < argv.length) {
      out.out = argv[++i];
    } else {
      stderr.write(`select-top-n: ignoring unknown flag '${arg}'\n`);
    }
  }
  if (!out.aggregate || !out.out) {
    stderr.write('select-top-n: --aggregate and --out are required\n');
    exit(2);
  }
  return out;
}

/**
 * Validate a single submission against the locked schema from ADR-074.
 *
 * Rejects (returns `false`) any submission carrying extra fields or
 * missing required ones. This is the CI-side hardening of the prohibition
 * in ADR-074 §2.1: only the locked schema is honoured.
 *
 * @param {unknown} entry - Candidate submission record.
 * @returns {boolean} `true` when the record is shaped correctly.
 */
function isValidSubmission(entry) {
  if (entry === null || typeof entry !== 'object') return false;
  const sub = /** @type {Record<string, unknown>} */ (entry);
  if (typeof sub.installId !== 'string' || sub.installId.length === 0) return false;
  if (typeof sub.period !== 'string' || sub.period.length === 0) return false;
  if (!Array.isArray(sub.skills)) return false;
  for (const skill of sub.skills) {
    if (skill === null || typeof skill !== 'object') return false;
    const s = /** @type {Record<string, unknown>} */ (skill);
    if (typeof s.canonicalSkillName !== 'string' || s.canonicalSkillName.length === 0) return false;
    if (typeof s.loadCount !== 'number' || !Number.isFinite(s.loadCount) || s.loadCount < 0) {
      return false;
    }
  }
  // Reject any extra top-level keys — schema lockdown per ADR-074 §2.3.
  const allowed = new Set(['installId', 'period', 'skills']);
  for (const key of Object.keys(sub)) {
    if (!allowed.has(key)) return false;
  }
  return true;
}

/**
 * Aggregate submissions into a `(canonicalSkillName → { total, submitters })`
 * map. Submitters are counted per-`installId` to keep the ranking honest
 * (one chatty machine cannot dominate the top-N).
 *
 * @param {Array<{ installId: string, skills: Array<{ canonicalSkillName: string, loadCount: number }> }>} submissions
 * @returns {Map<string, { loadCount: number, submitters: Set<string> }>}
 */
function aggregate(submissions) {
  /** @type {Map<string, { loadCount: number, submitters: Set<string> }>} */
  const tally = new Map();
  for (const sub of submissions) {
    for (const skill of sub.skills) {
      const existing = tally.get(skill.canonicalSkillName);
      if (existing) {
        existing.loadCount += skill.loadCount;
        existing.submitters.add(sub.installId);
      } else {
        tally.set(skill.canonicalSkillName, {
          loadCount: skill.loadCount,
          submitters: new Set([sub.installId]),
        });
      }
    }
  }
  return tally;
}

/**
 * Sort the aggregated tally and return the top-N entries.
 *
 * Ranking: descending `loadCount`, ties broken by descending submitter
 * count, then by `canonicalSkillName` ascending for determinism.
 *
 * @param {Map<string, { loadCount: number, submitters: Set<string> }>} tally
 * @param {number} n
 * @returns {Array<{ canonicalSkillName: string, loadCount: number, submitters: number }>}
 */
function rank(tally, n) {
  const entries = Array.from(tally.entries()).map(([name, agg]) => ({
    canonicalSkillName: name,
    loadCount: agg.loadCount,
    submitters: agg.submitters.size,
  }));
  entries.sort((a, b) => {
    if (b.loadCount !== a.loadCount) return b.loadCount - a.loadCount;
    if (b.submitters !== a.submitters) return b.submitters - a.submitters;
    return a.canonicalSkillName.localeCompare(b.canonicalSkillName);
  });
  return entries.slice(0, n);
}

/**
 * Main entry point — exits 0 on success, 0 (with empty selection) on missing
 * aggregate, 2 on bad CLI args.
 */
function main() {
  const opts = parseArgs(process.argv.slice(2));
  const aggregatePath = resolve(opts.aggregate);

  if (!existsSync(aggregatePath)) {
    stderr.write(
      `select-top-n: aggregate '${aggregatePath}' missing — emitting empty selection (bootstrap path).\n`,
    );
    writeFileSync(
      opts.out,
      JSON.stringify({ selectedAt: new Date().toISOString(), totalSubmissions: 0, skills: [] }),
    );
    exit(0);
  }

  /** @type {{ submissions?: unknown }} */
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(aggregatePath, 'utf-8'));
  } catch (err) {
    stderr.write(
      `select-top-n: failed to parse '${aggregatePath}' (${err instanceof Error ? err.message : String(err)}) — emitting empty selection.\n`,
    );
    writeFileSync(
      opts.out,
      JSON.stringify({ selectedAt: new Date().toISOString(), totalSubmissions: 0, skills: [] }),
    );
    exit(0);
  }

  const rawSubmissions = Array.isArray(parsed.submissions) ? parsed.submissions : [];
  const validSubmissions = rawSubmissions.filter(isValidSubmission);
  if (validSubmissions.length !== rawSubmissions.length) {
    stderr.write(
      `select-top-n: dropped ${rawSubmissions.length - validSubmissions.length} schema-invalid submission(s) (ADR-074 §2.1).\n`,
    );
  }

  const tally = aggregate(validSubmissions);
  const skills = rank(tally, opts.n);

  const payload = {
    selectedAt: new Date().toISOString(),
    totalSubmissions: validSubmissions.length,
    skills,
  };

  writeFileSync(opts.out, JSON.stringify(payload, null, 2));
  stdout.write(`select-top-n: wrote ${skills.length} skill(s) to ${opts.out}\n`);
}

main();
