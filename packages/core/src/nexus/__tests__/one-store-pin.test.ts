/**
 * T14153: the nexus graph and trait identity follow the store that is open.
 * `nexus analyze <path>` is refused when the store it would write is not the
 * path's own project store; without a pin, a project path writes its own store
 * and stays allowed.
 *
 * @task T14153
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analysisStoreMismatch } from '../analyze-orchestrator.js';
import { resolveTraitProjectId } from '../user-profile.js';

const PINNED = ['CLEO_DIR', 'CLEO_ROOT', 'CLEO_PROJECT_ROOT'] as const;
const saved: Partial<Record<(typeof PINNED)[number], string>> = {};
let base: string;
let projectA: string;
let projectB: string;

/** A CLEO project: `.cleo/project-info.json` declaring `projectId`. */
function makeProject(name: string, projectId: string): string {
  const root = join(base, name);
  mkdirSync(join(root, '.cleo'), { recursive: true });
  writeFileSync(join(root, '.cleo', 'project-info.json'), JSON.stringify({ projectId }));
  return root;
}

beforeEach(() => {
  for (const key of PINNED) saved[key] = process.env[key];
  base = mkdtempSync(join(tmpdir(), 'cleo-one-store-pin-'));
  projectA = makeProject('project-a', 'aaaaaaaaaaaa');
  projectB = makeProject('project-b', 'bbbbbbbbbbbb');
});

afterEach(() => {
  for (const key of PINNED) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(base, { recursive: true, force: true });
});

function pinTo(root: string): void {
  process.env['CLEO_DIR'] = join(root, '.cleo');
  process.env['CLEO_ROOT'] = root;
  delete process.env['CLEO_PROJECT_ROOT'];
}

function unpin(): void {
  for (const key of PINNED) delete process.env[key];
}

describe('analysisStoreMismatch (nexus analyze <path>)', () => {
  it('under CLEO_DIR=A, analyzing B is a mismatch: the graph would land in A', () => {
    pinTo(projectA);
    expect(analysisStoreMismatch(projectB)).toMatchObject({
      storeDir: join(projectA, '.cleo'),
      pathProjectRoot: expect.stringContaining('project-b'),
    });
  });

  it('under CLEO_DIR=A, analyzing A or a path inside A is allowed', () => {
    pinTo(projectA);
    mkdirSync(join(projectA, 'packages', 'x'), { recursive: true });
    expect(analysisStoreMismatch(projectA)).toBeNull();
    expect(analysisStoreMismatch(join(projectA, 'packages', 'x'))).toBeNull();
  });

  it('with no pin, analyzing B writes B’s own store and stays allowed', () => {
    unpin();
    expect(analysisStoreMismatch(projectB)).toBeNull();
  });
});

describe('resolveTraitProjectId reads one store', () => {
  it('under CLEO_DIR=A with root B, both identities come from A', () => {
    pinTo(projectA);
    expect(resolveTraitProjectId(projectB)).toBe('aaaaaaaaaaaa');
  });

  it('with no pin, root B resolves B’s own id', () => {
    unpin();
    expect(resolveTraitProjectId(projectB)).toBe('bbbbbbbbbbbb');
  });
});
