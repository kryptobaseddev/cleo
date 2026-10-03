/**
 * One governed path for heavy work on every agent surface (T13134).
 *
 * P0 snapshot 2 (2026-10-03) showed agents improvising: private wrapper
 * queues, wrappers nested inside `cleo run` (deadlock, T13133), explicit
 * `NODE_OPTIONS=--max-old-space-size=8192` overrides, and whole-suite runs as
 * evidence. Every surface an agent reads now carries the same recipe:
 *
 *   1. `CLEO-INJECTION.md`, injected into every session (Rules);
 *   2. the `ct-cleo` skill (Evidence must prove task criteria) and the
 *      `ct-orchestrator` skill (Evidence-Based Completion);
 *   3. the spawn prompt at every tier (Quality Gates), whose commands
 *      gate 23 checks.
 *
 * The markers are short, stable phrases: wording can be tightened, but
 * deleting the recipe from one surface fails here.
 *
 * @task T13134
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Task } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { buildSpawnPrompt, GOVERNED_HEAVY_WORK_LINE, type SpawnTier } from '../spawn-prompt.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE = resolve(HERE, '..', '..', '..');
const INJECTION = readFileSync(resolve(CORE, 'templates', 'CLEO-INJECTION.md'), 'utf-8');
const skill = (name: string) =>
  readFileSync(resolve(CORE, '..', 'skills', 'skills', name, 'SKILL.md'), 'utf-8');
const CT_CLEO = skill('ct-cleo');
const CT_ORCHESTRATOR = skill('ct-orchestrator');

/** What every surface must say (case-insensitive substrings). */
const MARKERS: readonly string[] = [
  'cleo run --wait --class <test|build|full-build> --',
  'exit 75',
  'never wrap `cleo run`',
  '`cleo verify`',
  'NODE_OPTIONS',
  '--maxWorkers',
];

const TASK: Task = {
  id: 'T9000',
  title: 'Example task for spawn prompt tests',
  description: 'A task used to validate the governed heavy-work recipe.',
  status: 'pending',
  priority: 'high',
  type: 'task',
  size: 'medium',
  acceptance: ['AC1: verify first criterion'],
  createdAt: '2026-04-17T00:00:00Z',
};

function prompt(protocol: string, tier: SpawnTier): string {
  return buildSpawnPrompt({
    task: TASK,
    protocol,
    tier,
    projectRoot: '/tmp/spawn-prompt-governed-heavy',
  }).prompt;
}

function missing(text: string): string[] {
  const lower = text.toLowerCase();
  return MARKERS.filter((m) => !lower.includes(m.toLowerCase()));
}

describe('the governed heavy-work recipe reaches every agent surface (T13134)', () => {
  it('CLEO-INJECTION.md carries it', () => {
    expect(missing(INJECTION)).toEqual([]);
    expect(INJECTION).toMatch(/`tool:test-affected` or `ci:<pr>`, never a whole suite/);
  });

  it('the ct-cleo and ct-orchestrator skills carry it', () => {
    expect(missing(CT_CLEO)).toEqual([]);
    expect(missing(CT_ORCHESTRATOR)).toEqual([]);
  });

  it.each([
    ['implementation', 0],
    ['implementation', 1],
    ['implementation', 2],
    ['testing', 1],
    ['validation', 1],
  ] as const)('the %s spawn prompt at tier %s carries it', (protocol, tier) => {
    const p = prompt(protocol, tier);
    expect(missing(p)).toEqual([]);
    expect(p).toContain(GOVERNED_HEAVY_WORK_LINE);
  });

  it('the spawn prompt runs its own heavy quality gates through cleo run', () => {
    const p = prompt('implementation', 1);
    expect(p).toContain('cleo run --wait --class build -- pnpm biome ci .');
    expect(p).toContain('cleo run --wait --class full-build -- pnpm run build');
    expect(p).not.toMatch(/^pnpm (biome ci|run build)\b/m);
  });
});
