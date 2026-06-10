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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  ci:
    name: CI
    if: always()
    runs-on: ubuntu-latest
    needs:
      - biome
      - unit-tests
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
  pull_request:
    branches: [main]
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

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cleo-merge-bar-aggregate-'));
  mkdirSync(join(tmpRoot, '.github', 'workflows'), { recursive: true });
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
  pull_request:
    branches: [main]
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
  pull_request:
    branches: [main]
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
  pull_request:
    branches: [main]
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
