/**
 * Spawn-prompt test guidance is CI-first and scoped (T12957).
 *
 * The prompt told every worker to run `pnpm run test` before each
 * `cleo complete` and then record `tool:test`, which runs the suite again.
 * With several agents working at once that was the main source of full-suite
 * churn. The prompt now points at `cleo done --plan`, `ci:<pr>` after merge
 * and `tool:test-affected` before it.
 *
 * @task T12957
 */

import type { Task } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { buildSpawnPrompt, type SpawnTier } from '../spawn-prompt.js';

const TASK: Task = {
  id: 'T9000',
  title: 'Example task for spawn prompt tests',
  description: 'A task used to validate test-evidence guidance.',
  status: 'pending',
  priority: 'high',
  type: 'task',
  size: 'medium',
  acceptance: ['AC1: verify first criterion'],
  createdAt: '2026-04-17T00:00:00Z',
};

function prompt(protocol: string, tier: SpawnTier = 1): string {
  return buildSpawnPrompt({
    task: TASK,
    protocol,
    tier,
    projectRoot: '/tmp/spawn-prompt-test-evidence',
  }).prompt;
}

describe('spawn prompt test-evidence guidance (T12957)', () => {
  it.each([
    0, 1, 2,
  ] as SpawnTier[])('tier %s recommends cleo done --plan, ci:<pr> and tool:test-affected', (tier) => {
    const p = prompt('implementation', tier);
    expect(p).toContain('cleo done T9000 --plan');
    expect(p).toContain('--evidence "ci:<pr>"');
    expect(p).toContain('--evidence "tool:test-affected"');
  });

  it.each([
    'implementation',
    'validation',
    'testing',
  ])('the %s prompt never tells a worker to run the full suite by hand', (protocol) => {
    const p = prompt(protocol);
    expect(p).not.toMatch(/^pnpm run test\b/m);
    expect(p).not.toContain('`pnpm run test` must show');
    expect(p).not.toContain('--evidence "tool:test"');
  });

  it('says a full tool:test is only for root-config changes', () => {
    expect(prompt('implementation')).toMatch(/full `tool:test` is only for root-config changes/);
  });
});
