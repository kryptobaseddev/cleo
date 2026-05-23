/**
 * Tests for scripts/lint-deployed-template-parity.mjs (T9860 / Saga T9855).
 *
 * Strategy
 * --------
 *   - Create an isolated tmpdir with a synthetic template + deployed workflow
 *     pair under the same relative paths the script expects.
 *   - The script resolves REPO_ROOT from `process.cwd()`. Tests invoke the
 *     real script with `cwd` set to the synthetic tmpdir, so `import 'yaml'`
 *     still resolves through the repo's node_modules.
 *
 * Cases covered
 * -------------
 *   - PASS (strict): template + deployed are structurally identical
 *   - FAIL (strict): deployed missing a job present in template
 *   - FAIL (strict): deployed has different `on:` triggers
 *   - FAIL (strict): deployed missing run-steps
 *   - PASS (baseline, no file): clean state → exit 0
 *   - FAIL (baseline, no file): drift present → exit 1 with hint
 *   - PASS (baseline, count <= baseline): baseline accepts existing drift
 *   - FAIL (baseline, count > baseline): regression detected, mentions REGRESSION
 *   - --update-baseline writes the JSON file and exits 0
 *
 * @task T9860
 * @saga T9855
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '../..');
const SCRIPT = join(REPO_ROOT, 'scripts/lint-deployed-template-parity.mjs');

// A template that, when rendered, defines a `preflight` + `prepare` shape
// mirroring the canonical release-prepare.yml.tmpl skeleton.
const TEMPLATE_YAML = `name: Test Workflow
on:
  workflow_dispatch:
    inputs:
      version:
        type: string
        required: true
permissions:
  contents: write
  pull-requests: write
jobs:
  preflight:
    name: Preflight
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: {{INSTALL_CMD}}
      - run: {{LINT_CMD}}
      - run: {{TEST_CMD}}
  prepare:
    name: Prepare
    runs-on: ubuntu-latest
    needs: preflight
    steps:
      - uses: actions/checkout@v4
      - run: echo "prepared"
`;

const DEPLOYED_MATCHING = `name: Test Workflow
on:
  workflow_dispatch:
    inputs:
      version:
        type: string
        required: true
permissions:
  contents: write
  pull-requests: write
jobs:
  preflight:
    name: Preflight
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm install --frozen-lockfile
      - run: pnpm biome check .
      - run: pnpm run test
  prepare:
    name: Prepare
    runs-on: ubuntu-latest
    needs: preflight
    steps:
      - uses: actions/checkout@v4
      - run: echo "prepared"
`;

const DEPLOYED_MISSING_JOB = `name: Test Workflow
on:
  workflow_dispatch:
    inputs:
      version:
        type: string
        required: true
permissions:
  contents: write
  pull-requests: write
jobs:
  prepare:
    name: Prepare
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: echo "prepared"
`;

const DEPLOYED_DIFFERENT_ON = `name: Test Workflow
on:
  push:
    branches: [main]
permissions:
  contents: write
  pull-requests: write
jobs:
  preflight:
    name: Preflight
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm install --frozen-lockfile
      - run: pnpm biome check .
      - run: pnpm run test
  prepare:
    name: Prepare
    runs-on: ubuntu-latest
    needs: preflight
    steps:
      - uses: actions/checkout@v4
      - run: echo "prepared"
`;

const DEPLOYED_MISSING_RUN_STEPS = `name: Test Workflow
on:
  workflow_dispatch:
    inputs:
      version:
        type: string
        required: true
permissions:
  contents: write
  pull-requests: write
jobs:
  preflight:
    name: Preflight
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm install --frozen-lockfile
  prepare:
    name: Prepare
    runs-on: ubuntu-latest
    needs: preflight
    steps:
      - uses: actions/checkout@v4
      - run: echo "prepared"
`;

/** Synthetic repo root with a templates dir and a .github/workflows dir. */
let tmpRoot;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cleo-deployed-tmpl-parity-'));

  // Create the directories the script expects relative to its cwd.
  const templateDir = join(tmpRoot, 'packages', 'core', 'templates', 'workflows');
  const deployedDir = join(tmpRoot, '.github', 'workflows');
  mkdirSync(templateDir, { recursive: true });
  mkdirSync(deployedDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Run the lint script with cwd=tmpRoot so REPO_ROOT resolves to the synthetic
 * project. The script itself lives at the real path under the repo's
 * scripts/ dir, so `import 'yaml'` still resolves through node_modules.
 * @param {string[]} extraArgs
 */
function runLint(extraArgs = []) {
  return spawnSync('node', [SCRIPT, ...extraArgs], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: tmpRoot,
  });
}

/** Write the template at the canonical path. */
function writeTemplate(content) {
  writeFileSync(
    join(tmpRoot, 'packages/core/templates/workflows/release-prepare.yml.tmpl'),
    content,
  );
}

/** Write the deployed workflow at the canonical path. */
function writeDeployed(content) {
  writeFileSync(join(tmpRoot, '.github/workflows/release-prepare.yml'), content);
}

// ============================================================================
// Strict mode — detects drift unconditionally
// ============================================================================

describe('lint-deployed-template-parity — --strict', () => {
  it('exits 0 when deployed matches the rendered template', () => {
    writeTemplate(TEMPLATE_YAML);
    writeDeployed(DEPLOYED_MATCHING);
    const result = runLint(['--strict']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS');
  });

  it('exits 1 when a job is missing in the deployed file', () => {
    writeTemplate(TEMPLATE_YAML);
    writeDeployed(DEPLOYED_MISSING_JOB);
    const result = runLint(['--strict']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('jobs.preflight');
    expect(result.stderr).toContain('missing');
  });

  it('exits 1 when on: triggers differ', () => {
    writeTemplate(TEMPLATE_YAML);
    writeDeployed(DEPLOYED_DIFFERENT_ON);
    const result = runLint(['--strict']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('on:');
  });

  it('exits 1 when run-steps are missing inside a job', () => {
    writeTemplate(TEMPLATE_YAML);
    writeDeployed(DEPLOYED_MISSING_RUN_STEPS);
    const result = runLint(['--strict']);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/jobs\.preflight\.steps:.*missing/);
  });
});

// ============================================================================
// Default (baseline) mode
// ============================================================================

describe('lint-deployed-template-parity — baseline (default) mode', () => {
  it('exits 0 when no baseline exists and no drift is present', () => {
    writeTemplate(TEMPLATE_YAML);
    writeDeployed(DEPLOYED_MATCHING);
    const result = runLint();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS');
  });

  it('exits 1 when no baseline exists and drift is present', () => {
    writeTemplate(TEMPLATE_YAML);
    writeDeployed(DEPLOYED_MISSING_JOB);
    const result = runLint();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Baseline file not found');
  });

  it('exits 0 when finding count is at-or-below baseline (accepted drift)', () => {
    writeTemplate(TEMPLATE_YAML);
    writeDeployed(DEPLOYED_MISSING_JOB);
    // First update-baseline to lock in the current drift.
    runLint(['--update-baseline']);
    // Default run should now accept it.
    const result = runLint();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS');
  });

  it('exits 1 with REGRESSION when finding count exceeds baseline', () => {
    writeTemplate(TEMPLATE_YAML);
    // Lock in a baseline where deployed matches template (0 findings).
    writeDeployed(DEPLOYED_MATCHING);
    runLint(['--update-baseline']);
    // Now introduce drift.
    writeDeployed(DEPLOYED_MISSING_JOB);
    const result = runLint();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('REGRESSION');
  });
});

// ============================================================================
// --update-baseline
// ============================================================================

describe('lint-deployed-template-parity — --update-baseline', () => {
  it('writes a JSON baseline file and exits 0', () => {
    writeTemplate(TEMPLATE_YAML);
    writeDeployed(DEPLOYED_MISSING_JOB);
    const result = runLint(['--update-baseline']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Baseline written');

    const baselinePath = join(tmpRoot, '.lint-deployed-template-parity-baseline.json');
    expect(existsSync(baselinePath)).toBe(true);
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf-8'));
    expect(baseline.gate).toBe('deployed-template-parity');
    expect(baseline.task).toBe('T9860');
    expect(baseline.total).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(baseline.results)).toBe(true);
  });

  it('baseline captures per-entry findings', () => {
    writeTemplate(TEMPLATE_YAML);
    writeDeployed(DEPLOYED_MISSING_JOB);
    runLint(['--update-baseline']);

    const baselinePath = join(tmpRoot, '.lint-deployed-template-parity-baseline.json');
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf-8'));
    expect(baseline.results.length).toBeGreaterThanOrEqual(1);
    const r = baseline.results[0];
    expect(r).toHaveProperty('template');
    expect(r).toHaveProperty('deployed');
    expect(r).toHaveProperty('findings');
    expect(Array.isArray(r.findings)).toBe(true);
  });
});

// ============================================================================
// Error surface
// ============================================================================

describe('lint-deployed-template-parity — error surface', () => {
  it('exits 2 when deployed file is missing', () => {
    writeTemplate(TEMPLATE_YAML);
    // No deployed file written.
    const result = runLint();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('deployed file not found');
  });

  it('exits 2 when neither template nor fallback exists', () => {
    writeDeployed(DEPLOYED_MATCHING);
    // No template written.
    const result = runLint();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('template file not found');
  });
});

// ============================================================================
// Fallback template resolution (cleo→core relocation window)
// ============================================================================

describe('lint-deployed-template-parity — fallback template', () => {
  it('falls back to packages/cleo/... when packages/core/... missing', () => {
    // Write template ONLY at the fallback path.
    const fallbackDir = join(tmpRoot, 'packages/cleo/templates/workflows');
    mkdirSync(fallbackDir, { recursive: true });
    writeFileSync(join(fallbackDir, 'release-prepare.yml.tmpl'), TEMPLATE_YAML);
    writeDeployed(DEPLOYED_MATCHING);

    const result = runLint(['--strict']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS');
  });
});
