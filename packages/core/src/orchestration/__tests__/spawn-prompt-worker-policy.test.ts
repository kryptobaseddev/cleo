import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import type { ProjectWorkerPolicy } from '@cleocode/contracts/config/worker-policy.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSpawnPrompt } from '../spawn-prompt.js';
import { resolveProjectWorkerPolicy } from '../worker-policy.js';

const TASK: Task = {
  id: 'T14456',
  title: 'Worker policy fixture',
  description: 'Exercise project verification placement.',
  status: 'active',
  priority: 'high',
  type: 'task',
  acceptance: ['Project policy reaches every tier.'],
  createdAt: '2026-11-10T00:00:00Z',
};
const POLICY: ProjectWorkerPolicy = {
  verification: { full: 'ci', local: 'single-file' },
  instructions: ['Respect AGENTS.md and preserve literal {{PROJECT_RULE}} text.'],
};
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'worker-policy-'));
  mkdirSync(join(root, '.cleo'));
  writeFileSync(
    join(root, '.cleo', 'project-context.json'),
    JSON.stringify({
      build: { command: 'make project-build' },
      testing: { command: 'make project-tests', affectedCommand: 'runner {projects}' },
    }),
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('project worker policy prompt fixtures', () => {
  for (const tier of [0, 1, 2] as const) {
    for (const harnessHint of ['claude-code', 'generic', 'bare'] as const) {
      it(`tier ${tier}, ${harnessHint}: CI placement has no contradictory local full commands`, async () => {
        writeFileSync(
          join(root, '.cleo', 'config.json'),
          JSON.stringify({ orchestrate: { workerPolicy: POLICY } }),
        );
        const workerPolicy = await resolveProjectWorkerPolicy(root);
        const result = buildSpawnPrompt({
          task: TASK,
          projectRoot: root,
          protocol: 'implementation',
          tier,
          harnessHint,
          skipCleoInjectionEmbed: harnessHint === 'claude-code',
          workerPolicy,
        });
        expect(result.prompt.match(/^## Project Worker Policy$/gm)).toHaveLength(1);
        expect(result.prompt).toContain('Explicit owner instructions remain authoritative');
        expect(result.prompt).toContain(POLICY.instructions?.[0]);
        expect(result.unresolvedTokens).toEqual([]);
        expect(result.prompt).toContain('required CI only');
        expect(result.prompt).toContain('build (`make project-build`)');
        expect(result.prompt).toContain('full tests (`make project-tests`)');
        expect(result.prompt).toContain('one changed or failing test file per invocation');
        expect(result.prompt).toContain('runner {projects}');
        expect(result.prompt).not.toContain(
          'cleo run --wait --class full-build -- make project-build',
        );
        expect(result.prompt).not.toMatch(
          /^cleo verify T14456 --gate qaPassed --evidence "tool:lint;tool:typecheck"/m,
        );
        expect(result.prompt).not.toContain('a full `tool:test` is only for root-config changes');
        expect(result.prompt).toContain('CI placement never waives a gate');
        expect(result.prompt).toContain('evidence.ciSatisfies');
        expect(result.prompt).toContain('Never review your own work');
      });
    }
  }

  it('preserves legacy local commands with no project policy', async () => {
    expect(await resolveProjectWorkerPolicy(root)).toBeUndefined();
    const { prompt } = buildSpawnPrompt({
      task: TASK,
      projectRoot: root,
      protocol: 'implementation',
    });
    expect(prompt).not.toContain('## Project Worker Policy');
    expect(prompt).toContain('cleo run --wait --class full-build -- make project-build');
    expect(prompt).toContain(
      'cleo verify T14456 --gate qaPassed --evidence "tool:lint;tool:typecheck"',
    );
  });

  it('supports project instructions without changing verification placement', () => {
    const { prompt } = buildSpawnPrompt({
      task: TASK,
      projectRoot: root,
      protocol: 'implementation',
      workerPolicy: { instructions: ['Keep the public API stable.'] },
    });
    expect(prompt).toContain('Keep the public API stable.');
    expect(prompt).toContain('cleo run --wait --class full-build -- make project-build');
  });

  it('supports local full verification with affected iteration', () => {
    const { prompt } = buildSpawnPrompt({
      task: TASK,
      projectRoot: root,
      protocol: 'implementation',
      workerPolicy: { verification: { full: 'local', local: 'affected' } },
    });
    expect(prompt).toContain('Local iteration checks: affected checks only');
    expect(prompt).toContain('cleo run --wait --class full-build -- make project-build');
  });

  it.each([
    null,
    'ci',
    { verification: { full: 'skip', local: 'single-file' } },
    { verification: { full: 'ci' } },
    { verification: { full: 'ci', local: 'suite' } },
    { instructions: [' '] },
    { instructions: [42] },
    { verification: { full: 'ci', local: 'single-file', disableEvidence: true } },
    { unknownRule: true },
  ])('refuses malformed policy %j with an actionable repair', async (workerPolicy) => {
    writeFileSync(
      join(root, '.cleo', 'config.json'),
      JSON.stringify({ orchestrate: { workerPolicy } }),
    );
    await expect(resolveProjectWorkerPolicy(root)).rejects.toMatchObject({
      code: 'E_WORKER_POLICY_INVALID',
      fix: expect.stringContaining('cleo config set orchestrate.workerPolicy'),
    });
  });

  it('refuses unreadable JSON instead of treating it as absent policy', async () => {
    writeFileSync(join(root, '.cleo', 'config.json'), '{');
    await expect(resolveProjectWorkerPolicy(root)).rejects.toMatchObject({
      code: 'E_WORKER_POLICY_INVALID',
      fix: expect.stringContaining('cleo config validate --scope project'),
    });
  });
});
