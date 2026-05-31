/**
 * Tests for scripts/lint-tools-vs-skills-boundary.mjs (T11409 · E3 · SG-PACKAGE-ARCH).
 *
 * @task T11409
 * @epic T11390
 * @saga T11387
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PRIMITIVE_HOMES, scanToolBoundaryViolations } from '../lint-tools-vs-skills-boundary.mjs';

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cleo-tools-boundary-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeFile(rel, content) {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

describe('scanToolBoundaryViolations', () => {
  it('does NOT flag a primitive defined in a primitive home', () => {
    writeFile('packages/core/src/tools/fs.ts', 'export function readFileText(){return 1}');
    expect(scanToolBoundaryViolations(root)).toEqual([]);
  });

  it('FLAGS a primitive redefined in a consumer package (runtime)', () => {
    // packages/mcp-adapter was deleted (R8 · T11259); runtime is now the consumer example.
    writeFile(
      'packages/runtime/src/gateway/x.ts',
      'export async function executeShell(){return 1}',
    );
    expect(scanToolBoundaryViolations(root)).toEqual([
      'packages/runtime/src/gateway/x.ts:executeShell',
    ]);
  });

  it('FLAGS an out-of-home const-arrow redefinition', () => {
    writeFile('packages/caamp/src/y.ts', 'export const writeFileAtomic = () => 1;');
    expect(scanToolBoundaryViolations(root)).toEqual(['packages/caamp/src/y.ts:writeFileAtomic']);
  });

  it('ignores test files', () => {
    writeFile('packages/cleo-os/src/__tests__/z.test.ts', 'export function runGit(){return 1}');
    expect(scanToolBoundaryViolations(root)).toEqual([]);
  });

  it('does not flag unrelated exports', () => {
    writeFile('packages/caamp/src/u.ts', 'export function doSomethingElse(){return 1}');
    expect(scanToolBoundaryViolations(root)).toEqual([]);
  });

  it('PRIMITIVE_HOMES is the documented two-home set', () => {
    expect(PRIMITIVE_HOMES).toEqual(['packages/core/src/tools', 'packages/contracts/src/tools']);
  });
});

// NOTE: there is intentionally NO "spawn the lint against the live repo tree"
// integration test here. Unlike the other lint gates (which scan a single
// narrow file/dir), this lint scans ALL of packages/*/src for primitive NAMES,
// so spawning it during the parallel vitest run races any concurrent test that
// transiently writes a primitive-named fixture under packages/ — a flaky
// false-positive (observed on T11404). The deterministic CI job
// `Tools-vs-Skills Boundary Lint` enforces the real-tree check on its own;
// the synthetic-tree unit tests above fully cover the classifier logic.
