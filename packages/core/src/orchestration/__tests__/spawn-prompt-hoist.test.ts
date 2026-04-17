/**
 * Tests for the spawn-prompt Task/Return-Format hoist (W3-4 / T894).
 *
 * The opening ~500 characters of every tier-1 prompt MUST carry the task
 * identity and the return-format contract so the subagent sees them before
 * the protocol boilerplate.
 *
 * @task T889
 * @task T894
 */

import type { Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSpawnPrompt, resetSpawnPromptCache } from '../spawn-prompt.js';

const BASE_TASK: Task = {
  id: 'T999',
  title: 'TEST HOIST TASK',
  description: 'Task used to verify section hoist.',
  status: 'pending',
  priority: 'high',
  type: 'task',
  size: 'small',
  acceptance: [],
  createdAt: '2026-04-17T00:00:00Z',
};

const PROJECT_ROOT = '/tmp/spawn-prompt-hoist-test';

beforeEach(() => {
  resetSpawnPromptCache();
});

afterEach(() => {
  resetSpawnPromptCache();
});

describe('buildSpawnPrompt — hoist contract (W3-4)', () => {
  it('hoists Task section to first 500 chars (tier 1)', () => {
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'implementation',
      tier: 1,
      projectRoot: PROJECT_ROOT,
    });
    const head = result.prompt.slice(0, 500);
    expect(head).toContain('T999');
    expect(head).toContain('TEST HOIST TASK');
    expect(head).toContain('## Task Identity');
  });

  it('places Return Format Contract before Stage-Specific Guidance', () => {
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'implementation',
      tier: 1,
      projectRoot: PROJECT_ROOT,
    });
    const rfcIdx = result.prompt.indexOf('## Return Format Contract');
    const stageIdx = result.prompt.indexOf('## Stage-Specific Guidance');
    const evidenceIdx = result.prompt.indexOf('## Evidence-Based Gate Ritual');
    expect(rfcIdx).toBeGreaterThanOrEqual(0);
    expect(stageIdx).toBeGreaterThan(rfcIdx);
    expect(evidenceIdx).toBeGreaterThan(rfcIdx);
  });

  it('places Task Identity before Return Format Contract', () => {
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'implementation',
      tier: 1,
      projectRoot: PROJECT_ROOT,
    });
    const taskIdx = result.prompt.indexOf('## Task Identity');
    const rfcIdx = result.prompt.indexOf('## Return Format Contract');
    expect(taskIdx).toBeGreaterThanOrEqual(0);
    expect(rfcIdx).toBeGreaterThan(taskIdx);
  });

  it('hoist holds at tier 0', () => {
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'implementation',
      tier: 0,
      projectRoot: PROJECT_ROOT,
    });
    const head = result.prompt.slice(0, 500);
    expect(head).toContain('T999');
    expect(head).toContain('TEST HOIST TASK');
  });

  it('hoist holds at tier 2', () => {
    const result = buildSpawnPrompt({
      task: BASE_TASK,
      protocol: 'implementation',
      tier: 2,
      projectRoot: PROJECT_ROOT,
    });
    const head = result.prompt.slice(0, 500);
    expect(head).toContain('T999');
    expect(head).toContain('TEST HOIST TASK');
  });
});
