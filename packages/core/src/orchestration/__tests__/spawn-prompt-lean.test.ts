/**
 * T13422 — the ct-lean rules reach every spawned agent and every session.
 *
 * Spawn prompts carry the lean-change block at every tier; the always-loaded
 * CLEO-INJECTION.md carries the pointer to the `ct-lean` skill; the skill
 * itself keeps its MIT attribution to Ponytail.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Task } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { LEAN_CHANGE_LINE } from '../lean-change.js';
import { buildSpawnPrompt } from '../spawn-prompt.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');

const TASK: Task = {
  id: 'T9101',
  title: 'Lean block fixture',
  description: 'Fixture for the lean-change block.',
  status: 'pending',
  priority: 'medium',
  type: 'task',
  acceptance: ['AC1'],
  createdAt: '2026-10-10T00:00:00Z',
};

describe('ct-lean delivery (T13422)', () => {
  it.each([0, 1, 2] as const)('emits the lean-change block at tier %i', (tier) => {
    const { prompt } = buildSpawnPrompt({
      task: TASK,
      protocol: 'implementation',
      tier,
      projectRoot: '/tmp/spawn-prompt-lean',
    });
    expect(prompt).toContain('## Lean Change (ct-lean)');
    expect(prompt).toContain(LEAN_CHANGE_LINE);
  });

  it('keeps the never-cut list in the spawn line', () => {
    for (const clause of ['evidence gates', 'type safety', 'package boundary', 'validation']) {
      expect(LEAN_CHANGE_LINE).toContain(clause);
    }
  });

  it('points every session at the ct-lean skill from CLEO-INJECTION.md', () => {
    const injection = readFileSync(join(REPO, 'packages/core/templates/CLEO-INJECTION.md'), 'utf8');
    expect(injection).toContain('**Lean change (`ct-lean`).**');
  });

  it('ships the skill as core with its MIT attribution', () => {
    const dir = join(REPO, 'packages/skills/skills/ct-lean');
    const skill = readFileSync(join(dir, 'SKILL.md'), 'utf8');
    expect(skill).toMatch(/^ {2}tier: core$/m);
    expect(skill).toContain('DietrichGebert');
    expect(skill).toContain('MIT');
    expect(readFileSync(join(dir, 'LICENSE-ponytail'), 'utf8')).toContain('MIT License');
  });
});
