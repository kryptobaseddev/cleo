/**
 * Delivery regression (T14303, gate 23 style): no agent surface teaches
 * `cleo verify --gate implemented --evidence commit:` as the primary way to
 * close work. PR work closes through the PR's `Closes:`/`Refs:` line and the
 * merge sweep (ADR-099); a surface that still shows the hand-recorded gate
 * for no-PR work must name that PR path too, and the spawn prompt shows no
 * hand-recorded `implemented` gate at all.
 *
 * @task T14303
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Task } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { buildSpawnPrompt, type SpawnTier } from '../spawn-prompt.js';

const repo = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../../${rel}`, import.meta.url)), 'utf-8');

/** The always-loaded and on-demand surfaces that describe closing a task. */
const SURFACES = [
  'packages/core/templates/CLEO-INJECTION.md',
  'packages/core/templates/CLEO-REFERENCE.md',
  'packages/skills/skills/ct-cleo/SKILL.md',
  'packages/skills/skills/ct-orchestrator/SKILL.md',
  'packages/skills/skills/ct-task-executor/SKILL.md',
  'packages/skills/skills/ct-task-executor/references/evidence-and-gates.md',
];

const HAND_IMPLEMENTED = /--gate implemented[\s\\]*--evidence\s*"commit:/;

const TASK: Task = {
  id: 'T9100',
  title: 'Closure path fixture',
  description: 'A task for the closure-path delivery regression.',
  status: 'pending',
  priority: 'medium',
  type: 'task',
  acceptance: ['AC1: something'],
  createdAt: '2026-11-05T00:00:00Z',
};

describe('closure-path delivery (T14303)', () => {
  it.each(SURFACES)('%s names the PR path wherever it shows the hand-recorded gate', (rel) => {
    const text = repo(rel);
    if (!HAND_IMPLEMENTED.test(text)) return;
    expect(text, rel).toContain('Closes:');
    expect(text.toLowerCase(), rel).toContain('merge sweep');
  });

  it('the spawn prompt, at every tier, leads with the PR path and teaches no hand-recorded commit: implemented gate', () => {
    for (const tier of [0, 1, 2] as SpawnTier[]) {
      const p = buildSpawnPrompt({
        task: TASK,
        protocol: 'implementation',
        tier,
        projectRoot: '/tmp/closure-path-delivery',
      }).prompt;
      expect(p).not.toMatch(HAND_IMPLEMENTED);
      const closes = p.indexOf('Closes: T9100');
      expect(closes).toBeGreaterThan(-1);
      expect(p.indexOf('cleo done T9100 --plan')).toBeGreaterThan(closes);
    }
  });
});
