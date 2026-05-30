/**
 * Tests for scripts/lint-tools-vs-skills-boundary.mjs (T11409 · E3 · SG-PACKAGE-ARCH).
 *
 * @task T11409
 * @epic T11390
 * @saga T11387
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PRIMITIVE_HOMES, scanToolBoundaryViolations } from '../lint-tools-vs-skills-boundary.mjs';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '../..');
const SCRIPT = join(REPO_ROOT, 'scripts/lint-tools-vs-skills-boundary.mjs');

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

  it('FLAGS a primitive redefined in a consumer package (mcp-adapter)', () => {
    writeFile('packages/mcp-adapter/src/x.ts', 'export async function executeShell(){return 1}');
    expect(scanToolBoundaryViolations(root)).toEqual([
      'packages/mcp-adapter/src/x.ts:executeShell',
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

describe('integration: real repo tree (baseline mode)', () => {
  it('the committed tree passes baseline mode (exit 0)', () => {
    const res = spawnSync('node', [SCRIPT], { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/no net-new/);
  });
});
