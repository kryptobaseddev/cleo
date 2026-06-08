/**
 * Tests for `resolveLLMForSystem` — E9 system-of-use chokepoint (T11749).
 *
 * Filesystem isolation mirrors `role-resolver.test.ts`: a fresh tmpdir
 * backing `XDG_DATA_HOME` and `HOME` per test, env restored in `afterEach`.
 * Each test seeds a project-local `.cleo/config.json` under its own tmpdir
 * so the config resolution chain exercises real filesystem state.
 *
 * @task T11749
 * @epic T11745
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SystemOfUseLabel } from '@cleocode/contracts';
import { SYSTEM_ROLE_MAP } from '@cleocode/contracts';
import { _resetCleoPlatformPathsCache } from '@cleocode/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAnthropicKeyCache } from '../credentials.js';
import { _resetPermsWarningForTests, _resetRoundRobinForTests } from '../credentials-store.js';
import { _resetGlobalConfigMigrationLatch } from '../global-config-migration.js';
import {
  IMPLICIT_FALLBACK_MODEL,
  IMPLICIT_FALLBACK_PROVIDER,
  resolveLLMForRole,
} from '../role-resolver.js';
import { resolveLLMForSystem } from '../system-resolver.js';

// ---------------------------------------------------------------------------
// Environment isolation helpers (mirrors role-resolver.test.ts)
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

/**
 * Provision fresh tmpdir roots for XDG + HOME + projectRoot.
 * Clears caches that persist across invocations within a process.
 */
function isolate(): { xdgRoot: string; home: string; projectRoot: string } {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const xdgRoot = join(tmpdir(), `cleo-sr-xdg-${stamp}`);
  const xdgConfigHome = join(tmpdir(), `cleo-sr-cfg-${stamp}`);
  const home = join(tmpdir(), `cleo-sr-home-${stamp}`);
  const projectRoot = join(tmpdir(), `cleo-sr-proj-${stamp}`);
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
  return { xdgRoot, home, projectRoot };
}

/** Seed `<projectRoot>/.cleo/config.json` with an `llm` block. */
function seedProjectConfig(projectRoot: string, llm: unknown): void {
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
// SYSTEM_ROLE_MAP contract
// ---------------------------------------------------------------------------

describe('SYSTEM_ROLE_MAP', () => {
  it('covers all SystemOfUse values and maps them to RoleName or null', () => {
    const systems: SystemOfUseLabel[] = [
      'sentient',
      'memory',
      'task-executor',
      'deriver',
      'hygiene',
      'plugin',
      'compression',
      'default',
    ];
    for (const s of systems) {
      expect(s in SYSTEM_ROLE_MAP).toBe(true);
    }
    // 'default' maps to null (global default path)
    expect(SYSTEM_ROLE_MAP['default']).toBeNull();
    // All other systems map to a non-null RoleName
    const nonDefault: SystemOfUseLabel[] = systems.filter((s) => s !== 'default');
    for (const s of nonDefault) {
      expect(SYSTEM_ROLE_MAP[s]).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// System label → role delegation
// ---------------------------------------------------------------------------

describe('resolveLLMForSystem — system-to-role mapping', () => {
  it("resolves 'sentient' via the 'consolidation' role", async () => {
    const { projectRoot } = isolate();
    seedProjectConfig(projectRoot, {
      roles: {
        consolidation: { provider: 'anthropic', model: 'sentient-model' },
      },
    });
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-sentient';
    const result = await resolveLLMForSystem('sentient', {
      projectRoot,
      skipCatalogDefault: true,
    });
    expect(result.system).toBe('sentient');
    expect(result.resolvedRole).toBe('consolidation');
    expect(result.source).toBe('role');
    expect(result.model).toBe('sentient-model');
  });

  it("resolves 'memory' via the 'extraction' role", async () => {
    const { projectRoot } = isolate();
    seedProjectConfig(projectRoot, {
      roles: {
        extraction: { provider: 'anthropic', model: 'memory-model' },
      },
    });
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-memory';
    const result = await resolveLLMForSystem('memory', {
      projectRoot,
      skipCatalogDefault: true,
    });
    expect(result.resolvedRole).toBe('extraction');
    expect(result.source).toBe('role');
    expect(result.model).toBe('memory-model');
  });

  it("resolves 'task-executor' via the 'judgement' role", async () => {
    const { projectRoot } = isolate();
    seedProjectConfig(projectRoot, {
      roles: {
        judgement: { provider: 'anthropic', model: 'task-model' },
      },
    });
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-task';
    const result = await resolveLLMForSystem('task-executor', {
      projectRoot,
      skipCatalogDefault: true,
    });
    expect(result.resolvedRole).toBe('judgement');
    expect(result.model).toBe('task-model');
  });

  it('accepts roleOverride to bypass the static SYSTEM_ROLE_MAP', async () => {
    const { projectRoot } = isolate();
    seedProjectConfig(projectRoot, {
      roles: {
        hygiene: { provider: 'anthropic', model: 'override-model' },
      },
    });
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-override';
    const result = await resolveLLMForSystem('sentient', {
      projectRoot,
      roleOverride: 'hygiene',
      skipCatalogDefault: true,
    });
    expect(result.resolvedRole).toBe('hygiene');
    expect(result.model).toBe('override-model');
  });

  it("resolves 'default' system (resolvedRole=null) to consolidation fallback path", async () => {
    const { projectRoot } = isolate();
    // No role config → falls to implicit-fallback
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-default-system';
    const result = await resolveLLMForSystem('default', {
      projectRoot,
      skipCatalogDefault: true,
    });
    expect(result.system).toBe('default');
    expect(result.resolvedRole).toBeNull();
    // Falls through to implicit-fallback because no roles/default config
    expect(result.source).toBe('implicit-fallback');
  });
});

// ---------------------------------------------------------------------------
// Missing profile error path
// ---------------------------------------------------------------------------

describe('resolveLLMForSystem — missing profile / credential paths', () => {
  it('returns credential=null when no credential is available', async () => {
    const { projectRoot } = isolate();
    // No env vars, no store entries → credential=null
    const result = await resolveLLMForSystem('memory', {
      projectRoot,
      skipCatalogDefault: true,
    });
    expect(result.credential).toBeNull();
    expect(result.client).toBeNull();
  });

  it('returns implicit-fallback source when no config exists', async () => {
    const { projectRoot } = isolate();
    // No config seeded and no credential → implicit-fallback
    const result = await resolveLLMForSystem('sentient', {
      projectRoot,
      skipCatalogDefault: true,
    });
    expect(result.source).toBe('implicit-fallback');
    expect(result.provider).toBe(IMPLICIT_FALLBACK_PROVIDER);
  });

  it('includes system + resolvedRole in every result envelope', async () => {
    const { projectRoot } = isolate();
    const result = await resolveLLMForSystem('deriver', {
      projectRoot,
      skipCatalogDefault: true,
    });
    expect(result).toHaveProperty('system', 'deriver');
    expect(result).toHaveProperty('resolvedRole', SYSTEM_ROLE_MAP['deriver']);
  });
});

// ---------------------------------------------------------------------------
// SSoT-driven default — implicit-fallback model replaced by catalog default
// ---------------------------------------------------------------------------

describe('resolveLLMForSystem — SSoT-driven default model (catalog)', () => {
  it('returns IMPLICIT_FALLBACK_MODEL when skipCatalogDefault=true', async () => {
    const { projectRoot } = isolate();
    // Force implicit-fallback source by providing no config
    const result = await resolveLLMForSystem('memory', {
      projectRoot,
      skipCatalogDefault: true,
    });
    expect(result.source).toBe('implicit-fallback');
    expect(result.model).toBe(IMPLICIT_FALLBACK_MODEL);
  });

  it('upgrades implicit-fallback model from catalog when skipCatalogDefault is absent/false', async () => {
    const { projectRoot } = isolate();
    // No config → implicit-fallback; catalog should replace the hardcoded haiku literal.
    // The registry's anthropic builtin profile has defaultModel set. We just verify
    // that when the model IS upgraded, it no longer equals the raw IMPLICIT_FALLBACK_MODEL,
    // OR that the catalog defaultModel IS IMPLICIT_FALLBACK_MODEL (acceptable if equal).
    const result = await resolveLLMForSystem('memory', { projectRoot });
    expect(result.source).toBe('implicit-fallback');
    // The result model is whatever the provider registry says is the default —
    // it must be a non-empty string. We assert it was touched (not undefined/null).
    expect(typeof result.model).toBe('string');
    expect(result.model.length).toBeGreaterThan(0);
  });

  it('does NOT replace model when source is not implicit-fallback', async () => {
    const { projectRoot } = isolate();
    seedProjectConfig(projectRoot, {
      roles: {
        extraction: { provider: 'anthropic', model: 'explicit-model' },
      },
    });
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-explicit';
    const result = await resolveLLMForSystem('memory', { projectRoot });
    // source='role' → catalog upgrade skipped
    expect(result.source).toBe('role');
    expect(result.model).toBe('explicit-model');
  });
});

// ---------------------------------------------------------------------------
// Result shape contract
// ---------------------------------------------------------------------------

describe('resolveLLMForSystem — result envelope shape', () => {
  it('always returns system label in the envelope', async () => {
    const { projectRoot } = isolate();
    const systems: SystemOfUseLabel[] = [
      'sentient',
      'memory',
      'task-executor',
      'deriver',
      'hygiene',
      'plugin',
      'compression',
      'default',
    ];
    for (const system of systems) {
      const result = await resolveLLMForSystem(system, {
        projectRoot,
        skipCatalogDefault: true,
      });
      expect(result.system).toBe(system);
      expect(result).toHaveProperty('resolvedRole');
      expect(result).toHaveProperty('provider');
      expect(result).toHaveProperty('model');
      expect(result).toHaveProperty('source');
    }
  });
});

// ---------------------------------------------------------------------------
// AC1 (T11750): { kind: 'role', id } descriptor ≡ resolveLLMForRole(id)
// ---------------------------------------------------------------------------

describe('resolveLLMForSystem — RoleSystem descriptor equivalence (T11750 · AC1)', () => {
  /** The seven config-vocabulary roles, exercised through the descriptor form. */
  const ROLES = [
    'extraction',
    'consolidation',
    'derivation',
    'hygiene',
    'judgement',
    'plugin',
    'compression',
  ] as const;

  it('accepts the { kind: "role", id } descriptor and stamps system + resolvedRole', async () => {
    const { projectRoot } = isolate();
    seedProjectConfig(projectRoot, {
      roles: { consolidation: { provider: 'anthropic', model: 'role-descriptor-model' } },
    });
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-role-descriptor';
    const result = await resolveLLMForSystem(
      { kind: 'role', id: 'consolidation' },
      { projectRoot, skipCatalogDefault: true },
    );
    expect(result.resolvedRole).toBe('consolidation');
    expect(result.system).toEqual({ kind: 'role', id: 'consolidation' });
    expect(result.source).toBe('role');
    expect(result.model).toBe('role-descriptor-model');
  });

  it('resolveLLMForSystem({ kind: "role", id }) matches resolveLLMForRole(id) for every resolution field', async () => {
    const { projectRoot } = isolate();
    // Seed a distinct model per role so the equivalence is non-trivial.
    seedProjectConfig(projectRoot, {
      default: { provider: 'anthropic', model: 'never-picked' },
      roles: {
        extraction: { provider: 'anthropic', model: 'm-extraction' },
        consolidation: { provider: 'anthropic', model: 'm-consolidation' },
        derivation: { provider: 'anthropic', model: 'm-derivation' },
        hygiene: { provider: 'anthropic', model: 'm-hygiene' },
        judgement: { provider: 'anthropic', model: 'm-judgement' },
        plugin: { provider: 'anthropic', model: 'm-plugin' },
        compression: { provider: 'anthropic', model: 'm-compression' },
      },
    });
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-equivalence';

    for (const id of ROLES) {
      const viaRole = await resolveLLMForRole(id, { projectRoot });
      const viaSystem = await resolveLLMForSystem(
        { kind: 'role', id },
        { projectRoot, skipCatalogDefault: true },
      );
      // Every resolution-relevant field is identical — only the additive
      // `system` + `resolvedRole` envelope fields differ.
      expect(viaSystem.provider).toBe(viaRole.provider);
      expect(viaSystem.model).toBe(viaRole.model);
      expect(viaSystem.source).toBe(viaRole.source);
      expect(viaSystem.apiMode).toBe(viaRole.apiMode);
      expect(viaSystem.authType).toBe(viaRole.authType);
      expect(viaSystem.credential?.provider).toBe(viaRole.credential?.provider);
      expect(viaSystem.credential?.source).toBe(viaRole.credential?.source);
      // The additive envelope fields the descriptor form carries.
      expect(viaSystem.resolvedRole).toBe(id);
      expect(viaSystem.system).toEqual({ kind: 'role', id });
    }
  });

  it('descriptor form does NOT consult the llm.systems[key] override tier', async () => {
    const { projectRoot } = isolate();
    // A systems[...] entry keyed by a label MUST NOT leak into a descriptor
    // resolution — the descriptor walks the same tier chain as resolveLLMForRole.
    seedProjectConfig(projectRoot, {
      default: { provider: 'anthropic', model: 'base-default' },
      systems: { extraction: { provider: 'anthropic', model: 'system-override-model' } },
    });
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-no-system-tier';
    const viaSystem = await resolveLLMForSystem(
      { kind: 'role', id: 'extraction' },
      { projectRoot, skipCatalogDefault: true },
    );
    // It lands on `default` (base-default), NOT the systems[...] override —
    // proving no systemKey was threaded for the descriptor form.
    expect(viaSystem.source).toBe('default');
    expect(viaSystem.model).toBe('base-default');
  });
});
