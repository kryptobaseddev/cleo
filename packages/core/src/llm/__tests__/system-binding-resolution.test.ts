/**
 * Tests for the `llm.systems[key]` per-system override tier + the
 * `LlmProfileConfig.tier` / `defaultAuxModel` config fields (E9 · T11748).
 *
 * Verifies the codified resolution priority
 *   explicit-arg → `llm.systems[key]` → `llm.defaultProfile` → implicit fallback
 * end-to-end through `resolveLLMForSystem` (which threads the system label as
 * the `systems[key]` lookup key) and `resolveLLMForRole` (which honours an
 * explicit `opts.systemKey`).
 *
 * Filesystem isolation mirrors `role-resolver.test.ts`: a fresh tmpdir backing
 * `XDG_DATA_HOME` / `XDG_CONFIG_HOME` / `HOME` per test, env restored in
 * `afterEach`, and a seeded project-local `.cleo/config.json` so the chain runs
 * against real `loadConfig` round-tripped state rather than mocks.
 *
 * @task T11748
 * @epic T11745
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LlmConfig } from '@cleocode/contracts';
import { _resetCleoPlatformPathsCache } from '@cleocode/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../config.js';
import { clearAnthropicKeyCache } from '../credentials.js';
import { _resetPermsWarningForTests, _resetRoundRobinForTests } from '../credentials-store.js';
import { _resetGlobalConfigMigrationLatch } from '../global-config-migration.js';
import { IMPLICIT_FALLBACK_MODEL, resolveLLMForRole } from '../role-resolver.js';
import { resolveLLMForSystem } from '../system-resolver.js';

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

/** Point XDG/HOME at fresh tmp dirs and provision a project root. */
function isolate(): { projectRoot: string } {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const xdgRoot = join(tmpdir(), `cleo-sb-xdg-${stamp}`);
  const xdgConfigHome = join(tmpdir(), `cleo-sb-cfg-${stamp}`);
  const home = join(tmpdir(), `cleo-sb-home-${stamp}`);
  const projectRoot = join(tmpdir(), `cleo-sb-proj-${stamp}`);
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

/** Seed `<projectRoot>/.cleo/config.json` with an `llm` block. */
function seedProjectConfig(projectRoot: string, llm: LlmConfig): void {
  const cfgPath = join(projectRoot, '.cleo', 'config.json');
  writeFileSync(cfgPath, JSON.stringify({ llm }, null, 2), 'utf-8');
}

beforeEach(() => {
  saveEnv();
  clearEnv();
  clearAnthropicKeyCache();
  _resetPermsWarningForTests();
  _resetRoundRobinForTests();
});

afterEach(() => {
  restoreEnv();
  clearAnthropicKeyCache();
  _resetPermsWarningForTests();
  _resetRoundRobinForTests();
});

// ---------------------------------------------------------------------------
// Config round-trip: the new fields survive loadConfig
// ---------------------------------------------------------------------------

describe('LlmConfig.systems + profile tier/defaultAuxModel — config round-trip (T11748)', () => {
  it('round-trips llm.systems + profile tier/defaultAuxModel through loadConfig', async () => {
    const { projectRoot } = isolate();
    const llm: LlmConfig = {
      profiles: {
        prime: {
          provider: 'anthropic',
          model: 'prime-model',
          tier: 'prime',
          defaultAuxModel: 'aux-model',
        },
      },
      defaultProfile: 'prime',
      systems: {
        sentient: { provider: 'anthropic', model: 'sentient-model' },
        'tool:web-search': { profile: 'prime' },
      },
    };
    seedProjectConfig(projectRoot, llm);

    const config = await loadConfig(projectRoot);
    // The whole structured block survives the JSON write → loadConfig read.
    expect(config.llm?.systems?.['sentient']).toEqual({
      provider: 'anthropic',
      model: 'sentient-model',
    });
    expect(config.llm?.systems?.['tool:web-search']).toEqual({ profile: 'prime' });
    expect(config.llm?.profiles?.['prime']?.tier).toBe('prime');
    expect(config.llm?.profiles?.['prime']?.defaultAuxModel).toBe('aux-model');
  });
});

// ---------------------------------------------------------------------------
// resolveLLMForSystem — the codified priority
// ---------------------------------------------------------------------------

describe('resolveLLMForSystem — llm.systems[key] override tier (T11748)', () => {
  it("source='system' when llm.systems[label] has an inline provider/model", async () => {
    const { projectRoot } = isolate();
    seedProjectConfig(projectRoot, {
      systems: { sentient: { provider: 'anthropic', model: 'system-model-x' } },
    });
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-system';
    const llm = await resolveLLMForSystem('sentient', { projectRoot, skipCatalogDefault: true });
    expect(llm.source).toBe('system');
    expect(llm.model).toBe('system-model-x');
    expect(llm.provider).toBe('anthropic');
  });

  it('llm.systems[label] can reference a named profile', async () => {
    const { projectRoot } = isolate();
    seedProjectConfig(projectRoot, {
      profiles: { fast: { provider: 'anthropic', model: 'profile-model-z' } },
      systems: { memory: { profile: 'fast' } },
    });
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-system-profile';
    const llm = await resolveLLMForSystem('memory', { projectRoot, skipCatalogDefault: true });
    expect(llm.source).toBe('system');
    expect(llm.model).toBe('profile-model-z');
  });

  it('llm.systems[key] beats llm.defaultProfile (granular override > global base)', async () => {
    const { projectRoot } = isolate();
    seedProjectConfig(projectRoot, {
      profiles: {
        base: { provider: 'anthropic', model: 'default-profile-loses' },
        override: { provider: 'anthropic', model: 'system-wins' },
      },
      defaultProfile: 'base',
      systems: { sentient: { profile: 'override' } },
    });
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant';
    const llm = await resolveLLMForSystem('sentient', { projectRoot, skipCatalogDefault: true });
    expect(llm.source).toBe('system');
    expect(llm.model).toBe('system-wins');
  });

  it('falls through to defaultProfile when no system binding exists for the key', async () => {
    const { projectRoot } = isolate();
    seedProjectConfig(projectRoot, {
      profiles: { base: { provider: 'anthropic', model: 'default-profile-model' } },
      defaultProfile: 'base',
      // 'sentient' has no systems[] entry; 'memory' does.
      systems: { memory: { provider: 'anthropic', model: 'unused-here' } },
    });
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant';
    const llm = await resolveLLMForSystem('sentient', { projectRoot, skipCatalogDefault: true });
    expect(llm.source).toBe('default-profile');
    expect(llm.model).toBe('default-profile-model');
  });

  it('explicit-arg (role override) beats llm.systems[key]', async () => {
    const { projectRoot } = isolate();
    seedProjectConfig(projectRoot, {
      // The role override 'judgement' pins its own model — must win over the
      // systems[] entry keyed by the same 'task-executor' label.
      roles: { judgement: { provider: 'anthropic', model: 'role-wins' } },
      systems: { 'task-executor': { provider: 'anthropic', model: 'system-loses' } },
    });
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant';
    const llm = await resolveLLMForSystem('task-executor', {
      projectRoot,
      roleOverride: 'judgement',
      skipCatalogDefault: true,
    });
    expect(llm.source).toBe('role');
    expect(llm.model).toBe('role-wins');
  });

  it('structurally incomplete system binding is skipped (falls through)', async () => {
    const { projectRoot } = isolate();
    seedProjectConfig(projectRoot, {
      default: { provider: 'anthropic', model: 'default-rescue' },
      // No provider/model and an unknown profile → incomplete → skipped.
      systems: { sentient: { profile: 'missing' } },
    });
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant';
    const llm = await resolveLLMForSystem('sentient', { projectRoot, skipCatalogDefault: true });
    expect(llm.source).toBe('default');
    expect(llm.model).toBe('default-rescue');
  });

  it('falls through to implicit-fallback when nothing matches', async () => {
    const { projectRoot } = isolate();
    seedProjectConfig(projectRoot, {
      systems: { memory: { provider: 'anthropic', model: 'unrelated' } },
    });
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant';
    const llm = await resolveLLMForSystem('sentient', { projectRoot, skipCatalogDefault: true });
    expect(llm.source).toBe('implicit-fallback');
    expect(llm.model).toBe(IMPLICIT_FALLBACK_MODEL);
  });
});

// ---------------------------------------------------------------------------
// resolveLLMForRole — systemKey opt activates the tier; absent leaves it off
// ---------------------------------------------------------------------------

describe('resolveLLMForRole — systemKey opt activates the systems[] tier (T11748)', () => {
  it('honours opts.systemKey when set', async () => {
    const { projectRoot } = isolate();
    seedProjectConfig(projectRoot, {
      systems: { 'tool:web-search': { provider: 'anthropic', model: 'tool-model' } },
    });
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant';
    const llm = await resolveLLMForRole('consolidation', {
      projectRoot,
      systemKey: 'tool:web-search',
    });
    expect(llm.source).toBe('system');
    expect(llm.model).toBe('tool-model');
  });

  it('role resolution is unchanged when systemKey is absent (systems[] not consulted)', async () => {
    const { projectRoot } = isolate();
    seedProjectConfig(projectRoot, {
      default: { provider: 'anthropic', model: 'default-model' },
      // A systems[] entry keyed by a role name must NOT leak into a plain role
      // call that does not pass systemKey.
      systems: { consolidation: { provider: 'anthropic', model: 'should-not-win' } },
    });
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant';
    const llm = await resolveLLMForRole('consolidation', { projectRoot });
    expect(llm.source).toBe('default');
    expect(llm.model).toBe('default-model');
  });

  it('a system binding credentialLabel pins the credential', async () => {
    const { projectRoot } = isolate();
    seedProjectConfig(projectRoot, {
      systems: {
        sentient: { provider: 'anthropic', model: 'm', credentialLabel: 'pinned' },
      },
    });
    const { addCredential } = await import('../credentials-store.js');
    await addCredential({
      provider: 'anthropic',
      label: 'pinned',
      authType: 'api_key',
      accessToken: 'sk-ant-system-pinned',
      priority: 100,
    });
    const llm = await resolveLLMForRole('consolidation', { projectRoot, systemKey: 'sentient' });
    expect(llm.source).toBe('system');
    expect(llm.credentialLabel).toBe('pinned');
    // E10 (T11753): plaintext only via the sealed handle's fetch().
    expect((await llm.sealedCredential?.fetch())?.value).toBe('sk-ant-system-pinned');
  });
});
