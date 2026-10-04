/**
 * `cleo doctor` checks that a workspace's `tool:test` evidence is scoped to the
 * affected packages, proposes an `affectedCommand` where one derives, and names
 * `ci:<pr>` as the preferred testsPassed evidence when the project accepts it
 * (T13125).
 *
 * @task T13125
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkAffectedTestScope } from '../doctor/checks.js';

let root: string;

function context(value: object): void {
  mkdirSync(join(root, '.cleo'), { recursive: true });
  writeFileSync(join(root, '.cleo', 'project-context.json'), JSON.stringify(value));
}

function workspace(): void {
  writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'root', private: true }));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'doctor-affected-'));
  mkdirSync(join(root, '.cleo'), { recursive: true });
  // The test harness pins a project root through the environment; this one wins.
  vi.stubEnv('CLEO_ROOT', root);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('checkAffectedTestScope (T13125)', () => {
  it('warns about a workspace whose every tool:test runs the whole suite', () => {
    workspace();
    context({ testing: { command: 'node scripts/all-tests.mjs' } });
    const r = checkAffectedTestScope(root);
    expect(r.status).toBe('warning');
    expect(r.message).toMatch(/every cleo verify --evidence tool:test runs the whole suite/);
    expect(r.fix).toMatch(/testing\.affectedCommand/);
    expect(r.fix).toMatch(/evidence\.ciSatisfies/);
  });

  it('proposes the derived command when one derives (the VidaPeps shape)', () => {
    workspace();
    context({ testing: { command: 'pnpm -r --no-bail --if-present run test' } });
    const r = checkAffectedTestScope(root);
    expect(r.status).toBe('info');
    expect(r.details).toMatchObject({
      proposed: 'pnpm {filters} --no-bail --if-present run test',
      basis: 'pnpm -r --no-bail --if-present run test',
    });
    expect(r.fix).toContain('"pnpm {filters} --no-bail --if-present run test"');
  });

  it('passes a declared template, and names ci:<pr> when evidence.ciSatisfies is set', () => {
    workspace();
    context({
      testing: { command: 'pnpm test', affectedCommand: 'pnpm exec vitest run {projects}' },
      evidence: { ciSatisfies: true },
    });
    const r = checkAffectedTestScope(root);
    expect(r.status).toBe('passed');
    expect(r.message).toMatch(
      /ci:<pr> \(the merged PR's CI\) is the preferred testsPassed evidence/,
    );
  });

  it('names ci:<pr> on the warning too when ciSatisfies is set, and stops suggesting it', () => {
    workspace();
    context({ testing: { command: 'node all.mjs' }, evidence: { ciSatisfies: true } });
    const r = checkAffectedTestScope(root);
    expect(r.status).toBe('warning');
    expect(r.message).toMatch(/ci:<pr>/);
    expect(r.fix).not.toMatch(/evidence\.ciSatisfies/);
  });

  it('passes a single-package project, which has no scope to narrow', () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'solo' }));
    context({ testing: { command: 'npm test' } });
    expect(checkAffectedTestScope(root).status).toBe('passed');
  });

  it('is info, not passed, when project-context.json cannot be read', () => {
    rmSync(join(root, '.cleo', 'project-context.json'), { force: true });
    expect(checkAffectedTestScope(root).status).toBe('info');
  });
});
