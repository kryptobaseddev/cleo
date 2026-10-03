/**
 * Tests for the core side of heavy-command hook delivery (T13124): loading the
 * adapters delivery module at run time, the mode init/upgrade install from,
 * the init/upgrade report lines, and the briefing warning.
 *
 * @task T13124
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  HeavyCommandHookMode,
  HeavyHookDeliveryApi,
  HeavyHookDeliveryOptions,
  HeavyHookDeliveryOutcome,
  HeavyHookInspection,
} from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deliverHeavyCommandHooks,
  heavyHookBriefingWarning,
  heavyHookReportLines,
  inspectHeavyCommandHooks,
  loadHeavyHookDelivery,
} from '../heavy-command-hook-delivery.js';

let dir: string;
let project: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-heavy-delivery-core-'));
  project = join(dir, 'project');
  mkdirSync(join(project, '.cleo'), { recursive: true });
  mkdirSync(join(dir, 'home'));
  mkdirSync(join(dir, 'bin'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const env = () => ({ HOME: join(dir, 'home'), PATH: join(dir, 'bin') });

/** A fake delivery module that records the mode it was given. */
function fakeApi(
  outcomes: readonly HeavyHookDeliveryOutcome[],
  inspections: readonly HeavyHookInspection[],
): HeavyHookDeliveryApi & {
  modes: HeavyCommandHookMode[];
  inspectOptions: Array<HeavyHookDeliveryOptions | undefined>;
} {
  const modes: HeavyCommandHookMode[] = [];
  const inspectOptions: Array<HeavyHookDeliveryOptions | undefined> = [];
  return {
    modes,
    inspectOptions,
    syncProjectHeavyCommandHooks: async (_dir, mode) => {
      modes.push(mode);
      return outcomes;
    },
    inspectProjectHeavyCommandHooks: (_dir, mode, options) => {
      modes.push(mode);
      inspectOptions.push(options);
      return inspections;
    },
    probeHeavyHookCli: () => ({ state: 'current', path: '/bin/cleo', detail: 'd' }),
  };
}

describe('loadHeavyHookDelivery', () => {
  it('loads the adapters delivery module and installs through it', async () => {
    const api = await loadHeavyHookDelivery();
    expect(typeof api.syncProjectHeavyCommandHooks).toBe('function');
    mkdirSync(join(project, '.claude'));
    const { mode, outcomes } = await deliverHeavyCommandHooks(project, { env: env() });
    expect(mode).toBe('rewrite');
    expect(outcomes.find((o) => o.provider === 'claude-code')?.status).toBe('installed');
    expect(existsSync(join(project, '.claude', 'settings.local.json'))).toBe(true);
    const { inspections } = await inspectHeavyCommandHooks(project, { env: env() });
    expect(inspections.find((i) => i.provider === 'claude-code')?.state).toBe('installed');
  });
});

describe('deliverHeavyCommandHooks', () => {
  it('installs from resources.heavyCommandHook, never from the environment variable', async () => {
    writeFileSync(
      join(project, '.cleo', 'config.json'),
      JSON.stringify({ resources: { heavyCommandHook: 'off' } }),
    );
    const api = fakeApi([], []);
    const saved = process.env.CLEO_HEAVY_COMMAND_HOOK;
    process.env.CLEO_HEAVY_COMMAND_HOOK = 'rewrite';
    try {
      expect((await deliverHeavyCommandHooks(project, { api })).mode).toBe('off');
    } finally {
      if (saved === undefined) delete process.env.CLEO_HEAVY_COMMAND_HOOK;
      else process.env.CLEO_HEAVY_COMMAND_HOOK = saved;
    }
    expect(api.modes).toEqual(['off']);
  });
});

describe('heavyHookReportLines', () => {
  it('reports every write and every provider whose hook could not be put in place', () => {
    const lines = heavyHookReportLines([
      { provider: 'claude-code', status: 'installed', target: '/p/.claude/settings.local.json' },
      {
        provider: 'codex',
        status: 'blocked',
        target: '/p/.codex/hooks.json',
        reason: 'r',
        remedy: 'fix it',
      },
      { provider: 'opencode', status: 'unchanged', target: '/p/.opencode/plugins/x.js' },
      { provider: 'kimi', status: 'skipped', target: '/h/.kimi/config.toml', reason: 'not in use' },
    ]);
    expect(lines).toEqual([
      {
        status: 'applied',
        details: 'heavy-command hook (claude-code): installed /p/.claude/settings.local.json',
      },
      {
        status: 'skipped',
        details: 'heavy-command hook (codex): blocked, /p/.codex/hooks.json',
        reason: 'codex blocked: r',
        fix: 'fix it',
      },
    ]);
    expect(
      heavyHookReportLines([
        { provider: 'codex', status: 'failed', target: 't', reason: 'boom' },
      ])[0]?.status,
    ).toBe('skipped');
  });
});

describe('heavyHookBriefingWarning', () => {
  const inspection = (
    provider: HeavyHookInspection['provider'],
    state: HeavyHookInspection['state'],
  ): HeavyHookInspection => ({ provider, detected: true, state, target: 't', detail: 'd' });

  it('names each provider in use without a working hook, with the remedy', async () => {
    const api = fakeApi(
      [],
      [
        inspection('claude-code', 'missing'),
        inspection('codex', 'blocked'),
        inspection('opencode', 'installed'),
        inspection('kimi', 'unsupported'),
      ],
    );
    const consent = fakeApi([], [inspection('codex', 'needs-consent')]);
    // A team's needs-consent is doctor's to report, not every briefing's.
    expect(await heavyHookBriefingWarning(project, { api: consent })).toBeNull();
    const warning = await heavyHookBriefingWarning(project, { api });
    expect(warning).toMatch(/claude-code \(missing\), codex \(blocked\):/);
    expect(warning).not.toMatch(/kimi|opencode/);
    expect(warning).toMatch(/Remedy: cleo doctor heavy-command-hook --fix/);
    // The briefing skips the git checks (review LOW-5); doctor keeps them.
    expect(api.inspectOptions).toEqual([{ gitChecks: false }]);
  });

  it('says nothing when every provider in use is covered, or when the check fails', async () => {
    const covered = fakeApi([], [inspection('claude-code', 'installed')]);
    expect(await heavyHookBriefingWarning(project, { api: covered })).toBeNull();
    const broken: HeavyHookDeliveryApi = {
      syncProjectHeavyCommandHooks: async () => [],
      inspectProjectHeavyCommandHooks: () => {
        throw new Error('boom');
      },
      probeHeavyHookCli: () => ({ state: 'unknown', path: null, detail: 'd' }),
    };
    expect(await heavyHookBriefingWarning(project, { api: broken })).toBeNull();
  });
});
