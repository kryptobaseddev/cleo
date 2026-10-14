/**
 * T13663 — ct-lean levels: resolution order, per-level rules, session scope,
 * config writes and the spawn-prompt block.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildLeanChangeBlock,
  effectiveLeanLevel,
  LEAN_CHANGE_LINE,
  readSessionLeanLevel,
  resolveLeanLevel,
  setLeanLevel,
} from '../lean-change.js';
import { buildSpawnPrompt } from '../spawn-prompt.js';

const TASK: Task = {
  id: 'T9102',
  title: 'Lean level fixture',
  description: 'Fixture for lean levels.',
  status: 'pending',
  priority: 'medium',
  type: 'task',
  acceptance: ['AC1'],
  createdAt: '2026-10-13T00:00:00Z',
};

describe('resolveLeanLevel (T13663)', () => {
  it('takes env, then session, then config, then full', () => {
    expect(resolveLeanLevel({ env: 'ultra', session: 'lite', config: 'off' })).toEqual({
      level: 'ultra',
      source: 'env',
    });
    expect(resolveLeanLevel({ session: 'lite', config: 'off' })).toEqual({
      level: 'lite',
      source: 'session',
    });
    expect(resolveLeanLevel({ config: 'OFF ' })).toEqual({ level: 'off', source: 'config' });
    expect(resolveLeanLevel({})).toEqual({ level: 'full', source: 'default' });
  });

  it('ignores unknown values at every layer', () => {
    expect(resolveLeanLevel({ env: 'max', session: 'x', config: 'lite' })).toEqual({
      level: 'lite',
      source: 'config',
    });
  });
});

describe('buildLeanChangeBlock per level (T13663)', () => {
  it('emits nothing at off and the full line by default', () => {
    expect(buildLeanChangeBlock('off')).toBeNull();
    expect(buildLeanChangeBlock()).toBe(
      ['## Lean Change (ct-lean)', '', LEAN_CHANGE_LINE].join('\n'),
    );
  });

  it('lite names the smaller option; ultra pushes back; both keep the never-cut list', () => {
    const lite = buildLeanChangeBlock('lite') ?? '';
    const ultra = buildLeanChangeBlock('ultra') ?? '';
    expect(lite).toContain('## Lean Change (ct-lean, lite)');
    expect(lite).toContain('name it in one line and let the owner pick');
    expect(ultra).toContain('question the request');
    for (const block of [lite, ultra]) expect(block).toContain('Never cut validation');
  });

  it('flows into the spawn prompt, and off removes the block', () => {
    const prompt = (leanLevel: 'off' | 'ultra') =>
      buildSpawnPrompt({
        task: TASK,
        protocol: 'implementation',
        tier: 0,
        projectRoot: '/tmp/lean-level',
        leanLevel,
      }).prompt;
    expect(prompt('off')).not.toContain('## Lean Change');
    expect(prompt('ultra')).toContain('## Lean Change (ct-lean, ultra)');
  });
});

describe('session and config scope (T13663)', () => {
  let root: string;
  let home: string;
  const saved = { CLEO_HOME: process.env.CLEO_HOME };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lean-level-'));
    home = mkdtempSync(join(tmpdir(), 'lean-level-home-'));
    mkdirSync(join(root, '.cleo'));
    process.env.CLEO_HOME = home;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    if (saved.CLEO_HOME === undefined) delete process.env.CLEO_HOME;
    else process.env.CLEO_HOME = saved.CLEO_HOME;
  });

  it('a session level applies to its own session only', async () => {
    await setLeanLevel({ projectRoot: root, level: 'ultra', scope: 'session', sessionId: 'ses_a' });
    expect(readSessionLeanLevel(root, 'ses_a')).toBe('ultra');
    expect(readSessionLeanLevel(root, 'ses_b')).toBeUndefined();
    expect(readSessionLeanLevel(root, null)).toBeUndefined();
  });

  it('refuses a session level without a session', async () => {
    await expect(
      setLeanLevel({ projectRoot: root, level: 'lite', scope: 'session', sessionId: null }),
    ).rejects.toThrow(/no bound CLEO session/);
  });

  it('writes lean.level to the project config and resolves it', async () => {
    await setLeanLevel({ projectRoot: root, level: 'lite', scope: 'project' });
    const config = JSON.parse(readFileSync(join(root, '.cleo', 'config.json'), 'utf-8'));
    expect(config.lean.level).toBe('lite');
    expect(await effectiveLeanLevel({ projectRoot: root, env: {} })).toEqual({
      level: 'lite',
      source: 'config',
    });
  });

  it('env beats session beats config', async () => {
    writeFileSync(join(root, '.cleo', 'config.json'), JSON.stringify({ lean: { level: 'off' } }));
    await setLeanLevel({ projectRoot: root, level: 'ultra', scope: 'session', sessionId: 'ses_a' });
    expect(
      (await effectiveLeanLevel({ projectRoot: root, sessionId: 'ses_a', env: {} })).level,
    ).toBe('ultra');
    expect(
      (
        await effectiveLeanLevel({
          projectRoot: root,
          sessionId: 'ses_a',
          env: { CLEO_LEAN_LEVEL: 'lite' },
        })
      ).level,
    ).toBe('lite');
    expect((await effectiveLeanLevel({ projectRoot: root, env: {} })).level).toBe('off');
  });
});
