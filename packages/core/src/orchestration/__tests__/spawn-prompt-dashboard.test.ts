import { describe, expect, it } from 'vitest';
import { buildSpawnPrompt } from '../spawn-prompt.js';

const baseTask = {
  id: 'T10464',
  title: 'Add dashboard metrics to spawn prompt context',
  status: 'pending',
  type: 'task',
  priority: 'medium',
  size: 'small',
  createdAt: '2026-05-24T00:00:00.000Z',
  updatedAt: '2026-05-24T00:00:00.000Z',
} as const;

describe('spawn prompt dashboard context', () => {
  it('injects the compact dashboard summary for tier-1 prompts', () => {
    const result = buildSpawnPrompt({
      task: baseTask,
      protocol: 'implementation',
      tier: 1,
      projectRoot: '/project',
      skipCleoInjectionEmbed: true,
      dashboardSummary:
        'queue=3 ready / 2 active; worktrees=5 active; adminMerge=0.25/h; forceBypass=0/h (24h)',
    });

    expect(result.prompt).toContain('## Orchestrate Dashboard Context');
    expect(result.prompt).toContain('queue=3 ready / 2 active; worktrees=5 active');
  });

  it('omits dashboard context for tier-0 worker prompts', () => {
    const result = buildSpawnPrompt({
      task: baseTask,
      protocol: 'implementation',
      tier: 0,
      projectRoot: '/project',
      dashboardSummary: 'queue=3 ready / 2 active; worktrees=5 active',
    });

    expect(result.prompt).not.toContain('## Orchestrate Dashboard Context');
  });
});
