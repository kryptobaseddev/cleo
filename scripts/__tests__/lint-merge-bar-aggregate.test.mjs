/**
 * Tests for scripts/lint-merge-bar-aggregate.mjs (T11955 · DHQ-072).
 *
 * Strategy
 * --------
 *   - The lint pins its target workflows to a hardcoded GATED_WORKFLOWS list
 *     keyed on `.github/workflows/*.yml`, resolved from `process.cwd()`. Tests
 *     create a synthetic repo root with those two files and run the real
 *     script with `cwd` set there, so `import 'yaml'` still resolves through
 *     the repo node_modules.
 *
 * Cases covered
 * -------------
 *   - PASS: both workflows have a complete aggregate gate
 *   - PASS: single-job workflow is exempt (no aggregate required)
 *   - FAIL: aggregate job missing entirely
 *   - FAIL: aggregate job omits a sibling from `needs:`
 *   - FAIL: aggregate job has a stale `needs:` reference
 *   - FAIL: aggregate job lacks `if: always()`
 *   - FAIL: aggregate job does not inspect `needs.*.result`
 *   - ERROR (exit 2): a gated workflow file is missing
 *   - REAL: the script passes against the repo's actual workflows
 *
 * @task T11955
 * @epic T11679
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '../..');
const SCRIPT = join(REPO_ROOT, 'scripts/lint-merge-bar-aggregate.mjs');

/** A multi-job workflow with a COMPLETE aggregate gate. */
const CI_OK = `name: CI
on:
  pull_request:
    branches: [main]
jobs:
  biome:
    runs-on: ubuntu-latest
    steps:
      - run: echo lint
  unit-tests:
    runs-on: ubuntu-latest
    steps:
      - run: echo test
  arch-gates:
    name: Arch Gates
    uses: ./.github/workflows/arch-boundary-check.yml
  ci:
    name: CI
    if: always()
    runs-on: ubuntu-latest
    needs:
      - biome
      - unit-tests
      - arch-gates
    steps:
      - name: gate
        env:
          RESULTS: \${{ join(needs.*.result, ',') }}
        run: |
          if printf '%s' "$RESULTS" | tr ',' '\\n' | grep -qE '^(failure|cancelled)$'; then exit 1; fi
`;

/** arch workflow with a COMPLETE aggregate gate. */
const ARCH_OK = `name: Arch Boundary Check
on:
  workflow_call:
jobs:
  db-open-guard:
    runs-on: ubuntu-latest
    steps:
      - run: echo a
  llm-chokepoint-guard:
    runs-on: ubuntu-latest
    steps:
      - run: echo b
  arch-boundary-check:
    name: Arch Boundary Check
    if: always()
    runs-on: ubuntu-latest
    needs:
      - db-open-guard
      - llm-chokepoint-guard
    steps:
      - name: gate
        env:
          RESULTS: \${{ join(needs.*.result, ',') }}
        run: |
          if printf '%s' "$RESULTS" | tr ',' '\\n' | grep -qE '^(failure|cancelled)$'; then exit 1; fi
`;

let tmpRoot;

/**
 * The ADVISORY_WORKFLOWS files, read from the script itself so the fixture
 * cannot drift from it (T13263).
 */
const ADVISORY_FILES = [
  ...readFileSync(SCRIPT, 'utf8')
    .slice(readFileSync(SCRIPT, 'utf8').indexOf('const ADVISORY_WORKFLOWS'))
    .split('};')[0]
    .matchAll(/'(\.github\/workflows\/[^']+\.yml)'/g),
].map((m) => m[1]);

/** A standalone single-job pull_request workflow. */
const standalone = (name) => `name: ${name}
on:
  pull_request:
    branches: [main]
jobs:
  only:
    runs-on: ubuntu-latest
    steps:
      - run: echo ${name}
`;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cleo-merge-bar-aggregate-'));
  mkdirSync(join(tmpRoot, '.github', 'workflows'), { recursive: true });
  // The advisory workflows exist, as in the real repo (a missing one is stale).
  for (const file of ADVISORY_FILES) writeFileSync(join(tmpRoot, file), standalone(file));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** Run the real lint with cwd=tmpRoot. */
function runLint() {
  return spawnSync('node', [SCRIPT], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: tmpRoot,
  });
}

function writeCi(content) {
  writeFileSync(join(tmpRoot, '.github/workflows/ci.yml'), content);
}
function writeArch(content) {
  writeFileSync(join(tmpRoot, '.github/workflows/arch-boundary-check.yml'), content);
}

describe('lint-merge-bar-aggregate — PASS cases', () => {
  it('exits 0 when both workflows have a complete aggregate gate', () => {
    writeCi(CI_OK);
    writeArch(ARCH_OK);
    const r = runLint();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PASS');
  });

  it('exempts a single-job workflow (no aggregate required)', () => {
    writeCi(CI_OK);
    writeArch(`name: Arch Boundary Check
on:
  workflow_call:
jobs:
  only-job:
    runs-on: ubuntu-latest
    steps:
      - run: echo solo
`);
    const r = runLint();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PASS');
  });
});

describe('lint-merge-bar-aggregate — FAIL cases', () => {
  it('fails when the aggregate job is missing entirely', () => {
    writeCi(CI_OK);
    writeArch(`name: Arch Boundary Check
on:
  workflow_call:
jobs:
  db-open-guard:
    runs-on: ubuntu-latest
    steps:
      - run: echo a
  llm-chokepoint-guard:
    runs-on: ubuntu-latest
    steps:
      - run: echo b
`);
    const r = runLint();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("aggregate job 'arch-boundary-check' is missing");
  });

  it('fails when the aggregate omits a sibling from needs:', () => {
    writeCi(CI_OK);
    writeArch(ARCH_OK.replace('      - llm-chokepoint-guard\n', ''));
    const r = runLint();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("does not 'needs:' sibling job 'llm-chokepoint-guard'");
  });

  it('fails when the aggregate has a stale needs: reference', () => {
    writeCi(CI_OK);
    writeArch(ARCH_OK.replace('      - llm-chokepoint-guard\n', '      - ghost-job\n'));
    const r = runLint();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('stale reference');
  });

  it('fails when the aggregate lacks if: always()', () => {
    writeCi(CI_OK);
    writeArch(ARCH_OK.replace('    if: always()\n', ''));
    const r = runLint();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('if: always()');
  });

  it('fails when the aggregate does not inspect needs.*.result', () => {
    writeCi(CI_OK);
    writeArch(`name: Arch Boundary Check
on:
  workflow_call:
jobs:
  db-open-guard:
    runs-on: ubuntu-latest
    steps:
      - run: echo a
  llm-chokepoint-guard:
    runs-on: ubuntu-latest
    steps:
      - run: echo b
  arch-boundary-check:
    name: Arch Boundary Check
    if: always()
    runs-on: ubuntu-latest
    needs:
      - db-open-guard
      - llm-chokepoint-guard
    steps:
      - run: echo "no result inspection"
`);
    const r = runLint();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('needs.*.result');
  });
});

describe('lint-merge-bar-aggregate — coverage: nothing gates outside CI (T13263)', () => {
  const write = (file, content) => writeFileSync(join(tmpRoot, '.github/workflows', file), content);

  it('fails on a new standalone pull_request workflow that nothing requires', () => {
    writeCi(CI_OK);
    writeArch(ARCH_OK);
    write('new-gate.yml', standalone('New Gate'));
    const r = runLint();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('new-gate.yml: runs on pull_request but nothing requires it');
  });

  it('passes once that workflow is called from ci.yml and the aggregate needs it', () => {
    writeCi(
      CI_OK.replace(
        '  ci:\n',
        '  new-gate:\n    uses: ./.github/workflows/new-gate.yml\n  ci:\n',
      ).replace('      - arch-gates\n', '      - arch-gates\n      - new-gate\n'),
    );
    writeArch(ARCH_OK);
    write(
      'new-gate.yml',
      standalone('New Gate').replace(
        '  pull_request:\n    branches: [main]\n',
        '  workflow_call:\n',
      ),
    );
    const r = runLint();
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('fails when the calling job is not a need of the ci aggregate', () => {
    writeCi(CI_OK.replace('      - arch-gates\n', ''));
    writeArch(ARCH_OK);
    const r = runLint();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("does not 'needs:' sibling job 'arch-gates'");
  });

  it('fails when a called workflow still triggers on pull_request (a redundant second run)', () => {
    writeCi(CI_OK);
    writeArch(
      ARCH_OK.replace(
        '  workflow_call:\n',
        '  workflow_call:\n  pull_request:\n    branches: [main]\n',
      ),
    );
    const r = runLint();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('must trigger ONLY on workflow_call');
  });

  it('fails when a called workflow declares workflow-level concurrency', () => {
    writeCi(CI_OK);
    writeArch(
      ARCH_OK.replace(
        '  workflow_call:\n',
        '  workflow_call:\nconcurrency:\n  group: x\n  cancel-in-progress: true\n',
      ),
    );
    const r = runLint();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("must not declare workflow-level 'concurrency'");
  });

  it('fails on a stale advisory entry (the workflow no longer runs on pull_request)', () => {
    writeCi(CI_OK);
    writeArch(ARCH_OK);
    const file = ADVISORY_FILES[0];
    writeFileSync(
      join(tmpRoot, file),
      standalone('x').replace('  pull_request:\n    branches: [main]\n', '  push:\n'),
    );
    const r = runLint();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`ADVISORY_WORKFLOWS: ${file} no longer runs on pull_request`);
  });

  it('the real ci.yml calls the arch gates and its aggregate needs them', () => {
    const ci = readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain('uses: ./.github/workflows/arch-boundary-check.yml');
    const needs = ci.slice(ci.indexOf('\n  ci:\n'));
    expect(needs).toContain('      - arch-gates\n');
  });
});

describe('lint-merge-bar-aggregate — error surface', () => {
  it('exits 2 when a gated workflow file is missing', () => {
    writeCi(CI_OK);
    // arch-boundary-check.yml intentionally not written.
    const r = runLint();
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('file not found');
  });
});

describe('lint-merge-bar-aggregate — real repo workflows', () => {
  it('passes against the actual checked-in workflows', () => {
    const r = spawnSync('node', [SCRIPT], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: REPO_ROOT,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PASS');
  });
});
