/**
 * Spawn-prompt attention digest injection tests (T11374 · Epic T11288).
 *
 * Verifies the Tier-2 attention digest lines are injected into the
 * `## PSYCHE-MEMORY` block for tier-1 spawns, that the empty case injects
 * nothing (and does not crash), and that tier-0 worker prompts never carry it.
 *
 * @task T11374
 * @epic T11288
 */

import type { RetrievalBundle } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { buildSpawnPrompt } from '../spawn-prompt.js';

const baseTask = {
  id: 'T11374',
  title: 'Inject attention digest into spawn prompt',
  status: 'pending',
  type: 'task',
  priority: 'medium',
  size: 'small',
  createdAt: '2026-05-30T00:00:00.000Z',
  updatedAt: '2026-05-30T00:00:00.000Z',
} as const;

/** A minimal, empty retrieval bundle — enough to trigger PSYCHE-MEMORY emission. */
function emptyBundle(): RetrievalBundle {
  return {
    cold: { userProfile: [], peerInstructions: '', sigilCard: null },
    warm: { peerLearnings: [], peerPatterns: [], decisions: [] },
    hot: { sessionNarrative: '', recentObservations: [], activeTasks: [] },
    tokenCounts: { cold: 0, warm: 0, hot: 0, total: 0 },
  };
}

const DIGEST_LINES = [
  '### Attention (Tier-2 working memory)',
  '> 2 open attention items',
  '- [task] remember the WAL reset',
  '- [epic] dispatch op auto-scopes via E0',
  '> expand: cleo attention show',
];

describe('spawn prompt attention digest (T11374 · Epic T11288)', () => {
  it('injects the attention digest into PSYCHE-MEMORY for a tier-1 spawn', () => {
    const result = buildSpawnPrompt({
      task: baseTask,
      protocol: 'implementation',
      tier: 1,
      projectRoot: '/project',
      skipCleoInjectionEmbed: true,
      retrievalBundle: emptyBundle(),
      attentionDigestLines: DIGEST_LINES,
    });

    expect(result.prompt).toContain('## PSYCHE-MEMORY');
    expect(result.prompt).toContain('### Attention (Tier-2 working memory)');
    expect(result.prompt).toContain('> 2 open attention items');
    expect(result.prompt).toContain('- [task] remember the WAL reset');
    expect(result.prompt).toContain('> expand: cleo attention show');
    // Attention content counts as PSYCHE content — the empty-bundle notice is suppressed.
    expect(result.prompt).not.toContain('No memory context available');
  });

  it('injects nothing and does not crash when the digest is empty', () => {
    const result = buildSpawnPrompt({
      task: baseTask,
      protocol: 'implementation',
      tier: 1,
      projectRoot: '/project',
      skipCleoInjectionEmbed: true,
      retrievalBundle: emptyBundle(),
      attentionDigestLines: [],
    });

    // Empty-attention contract: PSYCHE-MEMORY still renders, but NO attention
    // section is injected and the build does not throw.
    expect(result.prompt).toContain('## PSYCHE-MEMORY');
    expect(result.prompt).not.toContain('Attention (Tier-2 working memory)');
    expect(result.unresolvedTokens).toEqual([]);
  });

  it('omits the attention digest for tier-0 worker prompts', () => {
    const result = buildSpawnPrompt({
      task: baseTask,
      protocol: 'implementation',
      tier: 0,
      projectRoot: '/project',
      attentionDigestLines: DIGEST_LINES,
    });

    expect(result.prompt).not.toContain('## PSYCHE-MEMORY');
    expect(result.prompt).not.toContain('Attention (Tier-2 working memory)');
  });
});
