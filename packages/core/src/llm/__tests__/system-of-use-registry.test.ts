/**
 * Tests for `registerSystemOfUse` + the picker enumeration + the
 * runtime-registered resolution tier (T11751).
 *
 * Filesystem isolation mirrors `system-resolver.test.ts`: a fresh tmpdir
 * backing `XDG_DATA_HOME` and `HOME` per test, env restored in `afterEach`.
 * The runtime registry is cleared in `afterEach` so registrations never leak
 * between tests.
 *
 * @task T11751
 * @epic T11745
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_SYSTEMS_OF_USE } from '@cleocode/contracts';
import { _resetCleoPlatformPathsCache } from '@cleocode/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAnthropicKeyCache } from '../credentials.js';
import { _resetPermsWarningForTests, _resetRoundRobinForTests } from '../credentials-store.js';
import { _resetGlobalConfigMigrationLatch } from '../global-config-migration.js';
import { formatSystemKey, parseSystemKey, systemKeyKind } from '../system-key.js';
import {
  clearRegisteredSystemsOfUse,
  getRegisteredSystemDefault,
  isResolvableSystemDefault,
  listSystemsOfUse,
  registerSystemOfUse,
  registerSystemOfUseDescriptor,
} from '../system-of-use-registry.js';
import { resolveLLMForSystem } from '../system-resolver.js';

// ---------------------------------------------------------------------------
// Environment isolation (mirrors system-resolver.test.ts)
// ---------------------------------------------------------------------------

const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'MOONSHOT_API_KEY',
  'XDG_DATA_HOME',
  'XDG_CONFIG_HOME',
  'CLEO_CONFIG_HOME',
  'CLEO_HOME',
  'HOME',
  'CLEO_DIR',
];

function saveEnv(): void {
  for (const k of ENV_KEYS) SAVED_ENV[k] = process.env[k];
}

function restoreEnv(): void {
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
}

function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

function isolate(): { projectRoot: string } {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const xdgRoot = join(tmpdir(), `cleo-sor-xdg-${stamp}`);
  const xdgConfigHome = join(tmpdir(), `cleo-sor-cfg-${stamp}`);
  const home = join(tmpdir(), `cleo-sor-home-${stamp}`);
  const projectRoot = join(tmpdir(), `cleo-sor-proj-${stamp}`);
  mkdirSync(join(xdgRoot, 'cleo'), { recursive: true });
  mkdirSync(xdgConfigHome, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
  process.env['XDG_DATA_HOME'] = xdgRoot;
  process.env['XDG_CONFIG_HOME'] = xdgConfigHome;
  process.env['CLEO_CONFIG_HOME'] = xdgConfigHome;
  process.env['CLEO_HOME'] = join(xdgRoot, 'cleo');
  process.env['HOME'] = home;
  _resetCleoPlatformPathsCache();
  _resetGlobalConfigMigrationLatch();
  return { projectRoot };
}

function seedProjectConfig(projectRoot: string, llm: unknown): void {
  const cfgPath = join(projectRoot, '.cleo', 'config.json');
  writeFileSync(cfgPath, JSON.stringify({ llm }, null, 2), 'utf-8');
}

beforeEach(() => {
  saveEnv();
  clearEnv();
  clearRegisteredSystemsOfUse();
  clearAnthropicKeyCache();
  _resetPermsWarningForTests();
  _resetRoundRobinForTests();
});

afterEach(() => {
  restoreEnv();
  clearRegisteredSystemsOfUse();
  clearAnthropicKeyCache();
  _resetPermsWarningForTests();
  _resetRoundRobinForTests();
});

// ---------------------------------------------------------------------------
// System-key codec (formatSystemKey / parseSystemKey / systemKeyKind)
// ---------------------------------------------------------------------------

describe('system-key codec', () => {
  it('encodes open-axis descriptors with their prefix', () => {
    expect(formatSystemKey({ kind: 'tool', id: 'web-search' })).toBe('tool:web-search');
    expect(formatSystemKey({ kind: 'skill', id: 'ct-cleo' })).toBe('skill:ct-cleo');
    expect(formatSystemKey({ kind: 'cantbook-node', id: 'n1' })).toBe('cantbook:n1');
    expect(formatSystemKey({ kind: 'spawn-unit', id: 'T123' })).toBe('spawn-unit:T123');
  });

  it('encodes closed-axis descriptors to the bare id', () => {
    expect(formatSystemKey({ kind: 'aux', id: 'sentient' })).toBe('sentient');
    expect(formatSystemKey({ kind: 'role', id: 'consolidation' })).toBe('consolidation');
    expect(formatSystemKey({ kind: 'orchestration', id: 'frontier' })).toBe('frontier');
  });

  it('round-trips open-axis keys through parseSystemKey', () => {
    const sys = { kind: 'tool', id: 'web-search' } as const;
    const key = formatSystemKey(sys);
    expect(parseSystemKey(key)).toEqual(sys);
  });

  it('returns undefined for an un-prefixed (closed-axis) key', () => {
    expect(parseSystemKey('sentient')).toBeUndefined();
  });

  it('returns undefined for a prefix with an empty id', () => {
    expect(parseSystemKey('tool:')).toBeUndefined();
  });

  it('infers kind from key prefix (aux for un-prefixed)', () => {
    expect(systemKeyKind('tool:x')).toBe('tool');
    expect(systemKeyKind('skill:y')).toBe('skill');
    expect(systemKeyKind('sentient')).toBe('aux');
  });
});

// ---------------------------------------------------------------------------
// registerSystemOfUse + getRegisteredSystemDefault
// ---------------------------------------------------------------------------

describe('registerSystemOfUse', () => {
  it('stores a resolvable inline default and returns the record', () => {
    const rec = registerSystemOfUse('tool:web-search', 'Web Search', {
      provider: 'anthropic',
      model: 'reg-model',
    });
    expect(rec.key).toBe('tool:web-search');
    expect(rec.displayName).toBe('Web Search');
    expect(getRegisteredSystemDefault('tool:web-search')).toEqual({
      provider: 'anthropic',
      model: 'reg-model',
    });
  });

  it('defensively copies the defaults (caller mutation does not rewrite the binding)', () => {
    const defaults = { provider: 'anthropic' as const, model: 'orig' };
    registerSystemOfUse('tool:copy', 'Copy', defaults);
    defaults.model = 'mutated';
    expect(getRegisteredSystemDefault('tool:copy')?.model).toBe('orig');
  });

  it('last-write-wins for the same key', () => {
    registerSystemOfUse('tool:dup', 'First', { provider: 'anthropic', model: 'm1' });
    registerSystemOfUse('tool:dup', 'Second', { provider: 'anthropic', model: 'm2' });
    expect(getRegisteredSystemDefault('tool:dup')?.model).toBe('m2');
  });

  it('rejects an empty key / displayName', () => {
    expect(() => registerSystemOfUse('', 'x', { provider: 'anthropic', model: 'm' })).toThrow(
      RangeError,
    );
    expect(() =>
      registerSystemOfUse('tool:x', '   ', { provider: 'anthropic', model: 'm' }),
    ).toThrow(RangeError);
  });

  it('treats a structurally-incomplete default as non-binding (picker-only)', () => {
    registerSystemOfUse('tool:incomplete', 'Incomplete', { provider: 'anthropic' });
    // No model + no profile → not resolvable, so getRegisteredSystemDefault skips it.
    expect(getRegisteredSystemDefault('tool:incomplete')).toBeUndefined();
    expect(isResolvableSystemDefault({ provider: 'anthropic' })).toBe(false);
    expect(isResolvableSystemDefault({ profile: 'p' })).toBe(true);
    expect(isResolvableSystemDefault({ provider: 'anthropic', model: 'm' })).toBe(true);
  });

  it('registerSystemOfUseDescriptor encodes the descriptor key', () => {
    registerSystemOfUseDescriptor({ kind: 'tool', id: 'descr' }, 'Descr', {
      provider: 'anthropic',
      model: 'm',
    });
    expect(getRegisteredSystemDefault('tool:descr')?.model).toBe('m');
  });
});

// ---------------------------------------------------------------------------
// listSystemsOfUse — picker surface (AC2)
// ---------------------------------------------------------------------------

describe('listSystemsOfUse (AC2 — picker surface)', () => {
  it('enumerates every builtin system-of-use (de-duplicated by key)', () => {
    const entries = listSystemsOfUse();
    // The picker is keyed by encoded system key. Three closed-axis ids
    // (`hygiene`, `plugin`, `compression`) are BOTH a role AND an aux id, so
    // they encode to the same bare key and collapse to one picker entry — the
    // user picks one binding per key. So entries == unique builtin keys (18),
    // not the raw builtin count (21).
    const uniqueBuiltinKeys = new Set(BUILTIN_SYSTEMS_OF_USE.map((s) => formatSystemKey(s)));
    expect(entries.length).toBe(uniqueBuiltinKeys.size);
    // Every builtin key MUST appear in the picker, sourced as a builtin.
    for (const key of uniqueBuiltinKeys) {
      const hit = entries.find((e) => e.key === key);
      expect(hit, `builtin ${key} must appear in the picker`).toBeDefined();
      expect(hit?.source).toBe('builtin');
    }
  });

  it('appends runtime-registered systems with source=registered + defaults', () => {
    registerSystemOfUse('tool:web-search', 'Web Search', {
      provider: 'anthropic',
      model: 'reg-model',
    });
    const entries = listSystemsOfUse();
    const hit = entries.find((e) => e.key === 'tool:web-search');
    expect(hit).toBeDefined();
    expect(hit?.source).toBe('registered');
    expect(hit?.kind).toBe('tool');
    expect(hit?.defaults).toEqual({ provider: 'anthropic', model: 'reg-model' });
  });

  it('a registration for a builtin key overrides the builtin entry', () => {
    // 'sentient' is a builtin aux system (bare key).
    registerSystemOfUse('sentient', 'Custom Sentient', {
      provider: 'anthropic',
      model: 'm',
    });
    const entries = listSystemsOfUse();
    const sentient = entries.filter((e) => e.key === 'sentient');
    expect(sentient).toHaveLength(1); // de-duplicated by key
    expect(sentient[0]?.source).toBe('registered');
    expect(sentient[0]?.displayName).toBe('Custom Sentient');
  });

  it('filters by kind when requested', () => {
    registerSystemOfUse('tool:x', 'X', { provider: 'anthropic', model: 'm' });
    const tools = listSystemsOfUse('tool');
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((e) => e.kind === 'tool')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Resolution priority — user config ALWAYS wins (AC1)
// ---------------------------------------------------------------------------

describe('registered-default resolution tier (AC1 — user wins)', () => {
  it('applies the registered default when the user configured nothing', async () => {
    const { projectRoot } = isolate();
    // Empty llm block — no roles/default/defaultProfile/systems for the key.
    seedProjectConfig(projectRoot, {});
    registerSystemOfUse('tool:web-search', 'Web Search', {
      provider: 'anthropic',
      model: 'registered-model',
    });
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-reg';

    const result = await resolveLLMForSystem(
      // Open-axis key routed as a flat systemKey label.
      'tool:web-search' as never,
      { projectRoot, skipCatalogDefault: true },
    );
    expect(result.source).toBe('registered-default');
    expect(result.model).toBe('registered-model');
  });

  it('user llm.systems[key] BEATS the registered default (user wins)', async () => {
    const { projectRoot } = isolate();
    seedProjectConfig(projectRoot, {
      systems: {
        'tool:web-search': { provider: 'anthropic', model: 'user-model' },
      },
    });
    registerSystemOfUse('tool:web-search', 'Web Search', {
      provider: 'anthropic',
      model: 'registered-model',
    });
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-user';

    const result = await resolveLLMForSystem('tool:web-search' as never, {
      projectRoot,
      skipCatalogDefault: true,
    });
    expect(result.source).toBe('system');
    expect(result.model).toBe('user-model');
  });

  it('user llm.defaultProfile BEATS the registered default (user wins)', async () => {
    const { projectRoot } = isolate();
    seedProjectConfig(projectRoot, {
      profiles: { base: { provider: 'anthropic', model: 'profile-model' } },
      defaultProfile: 'base',
    });
    registerSystemOfUse('tool:web-search', 'Web Search', {
      provider: 'anthropic',
      model: 'registered-model',
    });
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-prof';

    const result = await resolveLLMForSystem('tool:web-search' as never, {
      projectRoot,
      skipCatalogDefault: true,
    });
    expect(result.source).toBe('default-profile');
    expect(result.model).toBe('profile-model');
  });

  it('a registered default that names a profile resolves it against llm.profiles', async () => {
    const { projectRoot } = isolate();
    seedProjectConfig(projectRoot, {
      profiles: { reg: { provider: 'anthropic', model: 'reg-profile-model' } },
    });
    registerSystemOfUse('tool:web-search', 'Web Search', { profile: 'reg' });
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-regprof';

    const result = await resolveLLMForSystem('tool:web-search' as never, {
      projectRoot,
      skipCatalogDefault: true,
    });
    expect(result.source).toBe('registered-default');
    expect(result.model).toBe('reg-profile-model');
  });

  it('an unregistered key falls through to implicit-fallback (registry never throws)', async () => {
    const { projectRoot } = isolate();
    seedProjectConfig(projectRoot, {});
    const result = await resolveLLMForSystem('tool:nothing-registered' as never, {
      projectRoot,
      skipCatalogDefault: true,
    });
    expect(result.source).toBe('implicit-fallback');
  });
});
