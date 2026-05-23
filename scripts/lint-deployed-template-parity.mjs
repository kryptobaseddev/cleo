#!/usr/bin/env node
/**
 * Lint rule: deployed-template parity gate (T9860 / SG-TEMPLATE-CONFIG-SSOT T9855).
 *
 * Why this matters
 * ----------------
 * `packages/cleo/templates/workflows/*.yml.tmpl` (being relocated to
 * `packages/core/templates/workflows/*.yml.tmpl` by T9858) are the canonical
 * sources for GitHub Actions workflows shipped to consuming projects via
 * `cleo init --workflows`. The deployed copies under `.github/workflows/`
 * in *this* repo are the rendered output of those templates and should
 * therefore track them faithfully (modulo project-context placeholder
 * substitution).
 *
 * Today the deployed `release-prepare.yml` has drifted: it lacks the
 * preflight job mandated by SPEC-T9345 R-200/R-260, hardcodes its node
 * version + install command + branch prefix, and skips the canonical
 * placeholder pass entirely. This gate documents that drift as a baseline
 * and prevents NEW divergence from creeping in.
 *
 * What this script does
 * ---------------------
 * 1. For each entry in PARITY_MAP, read the template file and substitute
 *    `{{KEY}}` placeholders using project-context defaults.
 * 2. Compare the rendered template against the deployed file structurally:
 *      - `on:` triggers and their inputs
 *      - `permissions`
 *      - `jobs.<name>.runs-on` and steps (`run:` set + `uses:` set)
 * 3. Report PASS or FAIL with the structural divergences enumerated.
 *
 * Modes
 * -----
 * (default)         Baseline mode. Compares finding count against the file
 *                   at `.lint-deployed-template-parity-baseline.json` and
 *                   fails only on net-add (regression prevention).
 * --strict          Zero-tolerance — any divergence fails the gate.
 * --update-baseline Regenerate the baseline JSON from current state, exit 0.
 *
 * @task T9860
 * @epic T9860 (E5-DOGFOOD-CI-GATES)
 * @saga T9855 SG-TEMPLATE-CONFIG-SSOT
 * @see AGENTS.md § "Dogfood: Deployed Template Parity (T9860 · Saga T9855)"
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

/**
 * REPO_ROOT resolves to `process.cwd()`. The script is intended to be
 * invoked from the repository root (either by CI or `pnpm`), and tests run
 * the script with `cwd` set to a synthetic project tmpdir. Pinning to cwd
 * (instead of `__dirname`-relative) keeps the script trivially testable
 * without copying it out of `node_modules` reach.
 */
const REPO_ROOT = process.cwd();

// ============================================================================
// CLI args
// ============================================================================

const args = process.argv.slice(2);
const MODE_STRICT = args.includes('--strict');
const MODE_UPDATE_BASELINE = args.includes('--update-baseline');

// ============================================================================
// Configuration
// ============================================================================

const BASELINE_PATH = join(REPO_ROOT, '.lint-deployed-template-parity-baseline.json');

/**
 * Default placeholder substitutions for cleocode itself. These mirror what
 * `cleo init --workflows` resolves from `.cleo/project-context.json` at
 * scaffold time. Keep them in sync with the cleocode root `package.json`
 * (engines.node) and the canonical `pnpm`-based commands.
 */
const DEFAULT_SUBSTITUTIONS = {
  NODE_VERSION: '24',
  INSTALL_CMD: 'pnpm install --frozen-lockfile',
  LINT_CMD: 'pnpm biome check .',
  TYPECHECK_CMD: 'pnpm run typecheck',
  TEST_CMD: 'pnpm run test',
  BUILD_CMD: 'pnpm run build',
  BRANCH_PREFIX: 'release',
  PR_LABEL: 'release',
};

/**
 * Mapping of canonical template → deployed-file pair. Each entry MAY include
 * a `fallbackTemplate` path to handle the cleo→core relocation window
 * (T9858) — if the primary template path doesn't exist on disk, the
 * fallback is read instead. This avoids a hard cross-PR dependency.
 */
const PARITY_MAP = [
  {
    template: 'packages/core/templates/workflows/release-prepare.yml.tmpl',
    deployed: '.github/workflows/release-prepare.yml',
    fallbackTemplate: 'packages/cleo/templates/workflows/release-prepare.yml.tmpl',
  },
];

// ============================================================================
// Helpers
// ============================================================================

/**
 * Substitute `{{KEY}}` placeholders using the supplied substitution map.
 *
 * Keys not present in `subs` are left as-is so that the diff surfaces
 * missing substitutions rather than silently rendering `undefined`.
 *
 * @param {string} source
 * @param {Record<string, string>} subs
 */
function renderTemplate(source, subs) {
  return source.replace(/{{\s*([A-Z_]+)\s*}}/g, (match, key) => {
    if (Object.hasOwn(subs, key)) return subs[key];
    return match;
  });
}

/**
 * Parse a YAML workflow document, returning a normalized JS object. Throws
 * a descriptive error if parsing fails.
 *
 * @param {string} yamlText
 * @param {string} label
 */
function parseWorkflow(yamlText, label) {
  try {
    return parseYaml(yamlText) ?? {};
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse ${label} as YAML: ${msg}`);
  }
}

/**
 * Build a structural fingerprint of a workflow document — just the bits we
 * care about for parity:
 *   - top-level `on:` shape (trigger names + input names)
 *   - top-level `permissions:` map
 *   - jobs map → { runsOn, runs: string[], uses: string[] }
 *
 * Whitespace, comments, and step ordering for steps with identical `run:`
 * content do not affect the fingerprint.
 *
 * @param {Record<string, unknown>} doc
 */
function fingerprint(doc) {
  const out = {
    on: undefined,
    permissions: undefined,
    jobs: {},
  };

  if (doc && typeof doc === 'object') {
    // YAML's `on:` key collides with the JS boolean true — yaml@2 emits the
    // string 'on' AND occasionally `true` depending on quoting. Accept both.
    const onValue = doc.on ?? doc[true];
    out.on = normalizeOn(onValue);

    if (doc.permissions !== undefined) {
      out.permissions = sortObject(doc.permissions);
    }

    if (doc.jobs && typeof doc.jobs === 'object') {
      for (const [jobName, job] of Object.entries(doc.jobs)) {
        if (!job || typeof job !== 'object') continue;
        const j = /** @type {Record<string, unknown>} */ (job);
        const steps = Array.isArray(j.steps) ? j.steps : [];
        const runs = [];
        const uses = [];
        for (const step of steps) {
          if (!step || typeof step !== 'object') continue;
          const s = /** @type {Record<string, unknown>} */ (step);
          if (typeof s.run === 'string') runs.push(s.run.trim());
          if (typeof s.uses === 'string') uses.push(s.uses.trim());
        }
        runs.sort();
        uses.sort();
        out.jobs[jobName] = {
          runsOn: j['runs-on'] ?? null,
          runs,
          uses,
        };
      }
    }
  }

  return out;
}

/**
 * Normalize the `on:` trigger to a `{ <triggerName>: { inputs: string[] } }`
 * shape, sorted for stable comparison.
 *
 * @param {unknown} on
 */
function normalizeOn(on) {
  if (!on || typeof on !== 'object') return on ?? null;
  const result = {};
  for (const [trigger, body] of Object.entries(on)) {
    if (body && typeof body === 'object' && 'inputs' in body) {
      const inputs = Object.keys(/** @type {Record<string, unknown>} */ (body).inputs ?? {}).sort();
      result[trigger] = { inputs };
    } else {
      result[trigger] = body ?? null;
    }
  }
  return result;
}

/**
 * Sort object keys recursively so JSON.stringify output is deterministic.
 *
 * @param {unknown} value
 */
function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === 'object') {
    const sorted = {};
    for (const k of Object.keys(value).sort()) {
      sorted[k] = sortObject(/** @type {Record<string, unknown>} */ (value)[k]);
    }
    return sorted;
  }
  return value;
}

/**
 * Diff two fingerprints and return an array of human-readable divergence
 * descriptions. Empty array means "structurally identical".
 *
 * @param {ReturnType<typeof fingerprint>} expected
 * @param {ReturnType<typeof fingerprint>} actual
 */
function diffFingerprints(expected, actual) {
  const findings = [];

  const expOn = JSON.stringify(expected.on);
  const actOn = JSON.stringify(actual.on);
  if (expOn !== actOn) {
    findings.push(`on: triggers/inputs differ — expected ${expOn}, got ${actOn}`);
  }

  const expPerm = JSON.stringify(expected.permissions ?? null);
  const actPerm = JSON.stringify(actual.permissions ?? null);
  if (expPerm !== actPerm) {
    findings.push(`permissions: differ — expected ${expPerm}, got ${actPerm}`);
  }

  const expJobNames = Object.keys(expected.jobs).sort();
  const actJobNames = Object.keys(actual.jobs).sort();
  const missingJobs = expJobNames.filter((j) => !actJobNames.includes(j));
  const extraJobs = actJobNames.filter((j) => !expJobNames.includes(j));
  for (const j of missingJobs) findings.push(`jobs.${j}: missing in deployed`);
  for (const j of extraJobs) findings.push(`jobs.${j}: extra in deployed (not in template)`);

  for (const jobName of expJobNames) {
    if (!actJobNames.includes(jobName)) continue;
    const e = expected.jobs[jobName];
    const a = actual.jobs[jobName];

    const expRuns = JSON.stringify(e.runs);
    const actRuns = JSON.stringify(a.runs);
    if (expRuns !== actRuns) {
      const missingRuns = e.runs.filter((r) => !a.runs.includes(r));
      const extraRuns = a.runs.filter((r) => !e.runs.includes(r));
      if (missingRuns.length > 0) {
        findings.push(
          `jobs.${jobName}.steps: missing ${missingRuns.length} run-step(s) — ${truncateList(missingRuns)}`,
        );
      }
      if (extraRuns.length > 0) {
        findings.push(
          `jobs.${jobName}.steps: extra ${extraRuns.length} run-step(s) — ${truncateList(extraRuns)}`,
        );
      }
    }

    const expUses = JSON.stringify(e.uses);
    const actUses = JSON.stringify(a.uses);
    if (expUses !== actUses) {
      const missingUses = e.uses.filter((u) => !a.uses.includes(u));
      const extraUses = a.uses.filter((u) => !e.uses.includes(u));
      if (missingUses.length > 0) {
        findings.push(`jobs.${jobName}.uses: missing ${JSON.stringify(missingUses)}`);
      }
      if (extraUses.length > 0) {
        findings.push(`jobs.${jobName}.uses: extra ${JSON.stringify(extraUses)}`);
      }
    }
  }

  return findings;
}

/** Truncate the list to its first 3 entries (each shortened) so output stays readable. */
function truncateList(items) {
  const head = items.slice(0, 3).map((s) => {
    const oneLine = s.replace(/\s+/g, ' ').trim();
    return oneLine.length > 80 ? `${oneLine.slice(0, 77)}...` : oneLine;
  });
  const more = items.length > 3 ? ` (+${items.length - 3} more)` : '';
  return `[${head.map((h) => JSON.stringify(h)).join(', ')}]${more}`;
}

/**
 * Process one PARITY_MAP entry and return its structured result.
 *
 * @param {(typeof PARITY_MAP)[number]} entry
 */
function processEntry(entry) {
  const deployedPath = join(REPO_ROOT, entry.deployed);
  if (!existsSync(deployedPath)) {
    return {
      template: entry.template,
      deployed: entry.deployed,
      status: 'error',
      reason: 'deployed file not found',
      findings: [],
    };
  }

  const templateCandidates = [entry.template, entry.fallbackTemplate].filter(Boolean);
  let templatePath = null;
  for (const candidate of templateCandidates) {
    const abs = join(REPO_ROOT, candidate);
    if (existsSync(abs)) {
      templatePath = abs;
      break;
    }
  }
  if (!templatePath) {
    return {
      template: entry.template,
      deployed: entry.deployed,
      status: 'error',
      reason: `template file not found (tried: ${templateCandidates.join(', ')})`,
      findings: [],
    };
  }

  const templateRaw = readFileSync(templatePath, 'utf-8');
  const deployedRaw = readFileSync(deployedPath, 'utf-8');

  const rendered = renderTemplate(templateRaw, DEFAULT_SUBSTITUTIONS);

  let expectedDoc;
  let actualDoc;
  try {
    expectedDoc = parseWorkflow(rendered, `rendered ${entry.template}`);
    actualDoc = parseWorkflow(deployedRaw, `deployed ${entry.deployed}`);
  } catch (err) {
    return {
      template: entry.template,
      deployed: entry.deployed,
      status: 'error',
      reason: err instanceof Error ? err.message : String(err),
      findings: [],
    };
  }

  const expectedFp = fingerprint(expectedDoc);
  const actualFp = fingerprint(actualDoc);
  const findings = diffFingerprints(expectedFp, actualFp);

  return {
    template: entry.template,
    templateActual: templatePath.replace(`${REPO_ROOT}/`, ''),
    deployed: entry.deployed,
    status: findings.length === 0 ? 'pass' : 'fail',
    reason: null,
    findings,
  };
}

// ============================================================================
// Main
// ============================================================================

function main() {
  const results = PARITY_MAP.map(processEntry);
  const totalFindings = results.reduce((sum, r) => sum + r.findings.length, 0);
  const errors = results.filter((r) => r.status === 'error');

  if (errors.length > 0) {
    for (const e of errors) {
      process.stderr.write(`ERROR: ${e.template} -> ${e.deployed}: ${e.reason}\n`);
    }
    return 2;
  }

  if (MODE_UPDATE_BASELINE) {
    const baseline = {
      gate: 'deployed-template-parity',
      task: 'T9860',
      saga: 'T9855',
      total: totalFindings,
      generatedAt: new Date().toISOString(),
      results: results.map((r) => ({
        template: r.template,
        deployed: r.deployed,
        findings: r.findings,
      })),
    };
    writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
    process.stdout.write(`Baseline written: ${BASELINE_PATH} (total=${totalFindings})\n`);
    return 0;
  }

  if (MODE_STRICT) {
    if (totalFindings === 0) {
      process.stdout.write('PASS — deployed matches template (strict mode)\n');
      return 0;
    }
    emitFailureReport(results, totalFindings);
    process.stderr.write('Strict mode — any divergence fails the gate.\n');
    return 1;
  }

  // Default: baseline mode.
  if (!existsSync(BASELINE_PATH)) {
    if (totalFindings === 0) {
      process.stdout.write('PASS — deployed matches template (no baseline; clean)\n');
      return 0;
    }
    emitFailureReport(results, totalFindings);
    process.stderr.write(
      `\nBaseline file not found at ${BASELINE_PATH}. Run with --update-baseline to accept the current state.\n`,
    );
    return 1;
  }

  let baseline;
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`ERROR: failed to read baseline ${BASELINE_PATH}: ${msg}\n`);
    return 2;
  }

  const baselineTotal = typeof baseline.total === 'number' ? baseline.total : 0;
  if (totalFindings <= baselineTotal) {
    process.stdout.write(
      `PASS — deployed matches template (findings=${totalFindings}, baseline=${baselineTotal})\n`,
    );
    return 0;
  }

  emitFailureReport(results, totalFindings);
  process.stderr.write(
    `\nREGRESSION — findings=${totalFindings} exceeds baseline=${baselineTotal}.\n` +
      `If this is intentional, run: node scripts/lint-deployed-template-parity.mjs --update-baseline\n`,
  );
  return 1;
}

function emitFailureReport(results, totalFindings) {
  process.stderr.write(`FAIL — ${totalFindings} divergence(s):\n`);
  for (const r of results) {
    if (r.findings.length === 0) continue;
    process.stderr.write(`\n  ${r.template} -> ${r.deployed}\n`);
    for (const f of r.findings) {
      process.stderr.write(`    - ${f}\n`);
    }
  }
}

process.exit(main());
