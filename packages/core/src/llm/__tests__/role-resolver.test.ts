/**
 * Tests for `resolveLLMForRole` (T-LLM-CRED-CENTRALIZATION Phase 4 / T9306).
 *
 * Filesystem isolation mirrors `credentials-store.test.ts`: a fresh tmpdir
 * backing `XDG_DATA_HOME` and `HOME` per test, env restored in `afterEach`.
 * Each test seeds a project-local `.cleo/config.json` under its own tmpdir
 * so the chain `roles[role]` → `default` → `implicit-fallback`
 * exercises real filesystem state rather than mocks.
 *
 * @task T9306
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RoleName } from '@cleocode/contracts';
import { _resetCleoPlatformPathsCache } from '@cleocode/paths';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import { clearAnthropicKeyCache } from '../credentials.js';
import {
  _resetPermsWarningForTests,
  _resetRoundRobinForTests,
  addCredential,
} from '../credentials-store.js';
import { _resetGlobalConfigMigrationLatch } from '../global-config-migration.js';
import {
  IMPLICIT_FALLBACK_MODEL,
  IMPLICIT_FALLBACK_PROVIDER,
  type ResolvedLLM,
  resolveLLMForRole,
} from '../role-resolver.js';

const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'MOONSHOT_API_KEY',
  // DHQ-081 (T11978): cross-provider selector enumerates all builtin providers.
  // Clearing these prevents real env-var credentials from leaking into tests
  // that assert `source === 'implicit-fallback'`.
  'DEEPSEEK_API_KEY',
  'XAI_API_KEY',
  'GROQ_API_KEY',
  'KIMI_CODE_API_KEY',
  'OPENROUTER_API_KEY',
  'AWS_PROFILE',
  'OLLAMA_HOST',
  'OLLAMA_API_KEY',
  'OLLAMA_BASE_URL',
  'XDG_DATA_HOME',
  // T9405: pin XDG_CONFIG_HOME so getCleoPlatformPaths().config resolves
  // to a per-test temp dir — without this, the global-config-dir tier
  // leaks across tests within the same process.
  'XDG_CONFIG_HOME',
  'CLEO_CONFIG_HOME',
  // T9403: getCleoHome() honours CLEO_HOME first; save/restore here.
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
 * Point XDG_DATA_HOME + HOME at fresh tmp dirs so neither the cred-file
 * tier nor the claude-creds tier picks up developer credentials. Also
 * provisions a project root under a per-test tmpdir so `loadConfig` reads
 * the seeded `.cleo/config.json`.
 */
function isolate(): { xdgRoot: string; home: string; projectRoot: string } {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const xdgRoot = join(tmpdir(), `cleo-rr-xdg-${stamp}`);
  const xdgConfigHome = join(tmpdir(), `cleo-rr-cfg-${stamp}`);
  const home = join(tmpdir(), `cleo-rr-home-${stamp}`);
  const projectRoot = join(tmpdir(), `cleo-rr-proj-${stamp}`);
  mkdirSync(join(xdgRoot, 'cleo'), { recursive: true });
  mkdirSync(xdgConfigHome, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
  process.env['XDG_DATA_HOME'] = xdgRoot;
  // T9405: pin XDG_CONFIG_HOME so getCleoPlatformPaths().config resolves to
  // a per-test temp dir; without this the global-config-dir tier leaks
  // across tests within the same process.
  process.env['XDG_CONFIG_HOME'] = xdgConfigHome;
  process.env['CLEO_CONFIG_HOME'] = xdgConfigHome;
  // T9403: mirror XDG layout under CLEO_HOME for getCleoHome().
  process.env['CLEO_HOME'] = join(xdgRoot, 'cleo');
  process.env['HOME'] = home;
  // T9405: re-arm the path-cache and migration latch so each test runs the
  // migration against its own fresh env.
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
// Provider/model resolution chain
// ---------------------------------------------------------------------------

describe('resolveLLMForRole — provider/model resolution chain', () => {
  it("source='role' when llm.roles[role] is configured", async () => {
    const { projectRoot } = isolate();
    seedProjectConfig(projectRoot, {
      roles: {
        consolidation: { provider: 'anthropic', model: 'role-model-x' },
      },
    });
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-role';
    const llm = await resolveLLMForRole('consolidation', { projectRoot });
    expect(llm.source).toBe('role');
    expect(llm.provider).toBe('anthropic');
    expect(llm.model).toBe('role-model-x');
  });

  it("source='default' when only llm.default is configured", async () => {
    const { projectRoot } = isolate();
    seedProjectConfig(projectRoot, {
      default: { provider: 'anthropic', model: 'default-model-y' },
    });
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-default';
    const llm = await resolveLLMForRole('consolidation', { projectRoot });
    expect(llm.source).toBe('default');
    expect(llm.model).toBe('default-model-y');
  });

  it('resolves role with no config but a valid API key — routes via cross-provider selector (DHQ-081 T11978)', async () => {
    const { projectRoot } = isolate();
    // No llm config at all, but ANTHROPIC_API_KEY is set.
    // Tier 7 (cross-provider selector) picks up the provisioned anthropic credential
    // and returns source='cross-provider'. This is the correct behavior post-DHQ-081:
    // the implicit-fallback is only reached when NO provider has any credential.
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-no-daemon';
    const llm = await resolveLLMForRole('consolidation', { projectRoot });
    expect(llm.source).toBe('cross-provider');
    expect(llm.provider).toBe(IMPLICIT_FALLBACK_PROVIDER); // anthropic wins (frontier + PROVISIONED_CLOUD_BIAS)
  });

  it('falls back to llm.default when role-specific override absent', async () => {
    const { projectRoot } = isolate();
    seedProjectConfig(projectRoot, {
      default: { provider: 'anthropic', model: 'default-model' },
    });
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-default-fb';
    // 'hygiene' not configured in roles → should fall to default.
    const llm = await resolveLLMForRole('hygiene', { projectRoot });
    expect(llm.source).toBe('default');
    expect(llm.model).toBe('default-model');
    expect(llm.provider).toBe('anthropic');
  });

  it("source='cross-provider' when no config but anthropic key is set (DHQ-081 T11978)", async () => {
    const { projectRoot } = isolate();
    // No project config + no global config, but ANTHROPIC_API_KEY is set.
    // Post-DHQ-081: tier 7 (cross-provider) picks up the key and returns
    // source='cross-provider'. The 'implicit-fallback' source is only reached
    // when absolutely no provider has any credential whatsoever.
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-fb';
    const llm = await resolveLLMForRole('consolidation', { projectRoot });
    expect(llm.source).toBe('cross-provider');
    expect(llm.provider).toBe(IMPLICIT_FALLBACK_PROVIDER); // anthropic wins scoring
  });

  it('role beats default (priority chain)', async () => {
    const { projectRoot } = isolate();
    seedProjectConfig(projectRoot, {
      roles: { consolidation: { provider: 'anthropic', model: 'role-wins' } },
      default: { provider: 'anthropic', model: 'default-loses' },
    });
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant';
    const llm = await resolveLLMForRole('consolidation', { projectRoot });
    expect(llm.source).toBe('role');
    expect(llm.model).toBe('role-wins');
  });

  it('default beats implicit-fallback when role is unconfigured', async () => {
    const { projectRoot } = isolate();
    seedProjectConfig(projectRoot, {
      default: { provider: 'anthropic', model: 'default-wins' },
    });
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant';
    const llm = await resolveLLMForRole('extraction', { projectRoot });
    expect(llm.source).toBe('default');
    expect(llm.model).toBe('default-wins');
  });
});

// ---------------------------------------------------------------------------
// Named profile + defaultProfile binding (T11617)
// ---------------------------------------------------------------------------

describe('resolveLLMForRole — named profile + defaultProfile binding (T11617)', () => {
  it("source='profile' when a role pins a named profile", async () => {
    const { projectRoot } = isolate();
    seedProjectConfig(projectRoot, {
      profiles: {
        'codex-bg': { provider: 'anthropic', model: 'profile-model-z' },
      },
      roles: {
        consolidation: { provider: 'openai', model: 'inline-ignored', profile: 'codex-bg' },
      },
    });
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-profile';
    const llm = await resolveLLMForRole('consolidation', { projectRoot });
    expect(llm.source).toBe('profile');
    expect(llm.provider).toBe('anthropic');
    expect(llm.model).toBe('profile-model-z');
  });

  it("source='default-profile' when only defaultProfile is configured", async () => {
    const { projectRoot } = isolate();
    seedProjectConfig(projectRoot, {
      profiles: {
        'codex-bg': { provider: 'anthropic', model: 'default-profile-model' },
      },
      defaultProfile: 'codex-bg',
    });
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-defprofile';
    const llm = await resolveLLMForRole('consolidation', { projectRoot });
    expect(llm.source).toBe('default-profile');
    expect(llm.model).toBe('default-profile-model');
  });

  it('a role profile reference beats llm.default', async () => {
    const { projectRoot } = isolate();
    seedProjectConfig(projectRoot, {
      profiles: { fast: { provider: 'anthropic', model: 'profile-wins' } },
      roles: { consolidation: { provider: 'anthropic', model: 'unused', profile: 'fast' } },
      default: { provider: 'anthropic', model: 'default-loses' },
    });
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant';
    const llm = await resolveLLMForRole('consolidation', { projectRoot });
    expect(llm.source).toBe('profile');
    expect(llm.model).toBe('profile-wins');
  });

  it('llm.default beats defaultProfile (default-profile is a last-resort binding)', async () => {
    const { projectRoot } = isolate();
    seedProjectConfig(projectRoot, {
      profiles: { 'codex-bg': { provider: 'anthropic', model: 'default-profile-loses' } },
      defaultProfile: 'codex-bg',
      default: { provider: 'anthropic', model: 'default-wins' },
    });
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant';
    const llm = await resolveLLMForRole('extraction', { projectRoot });
    expect(llm.source).toBe('default');
    expect(llm.model).toBe('default-wins');
  });

  it('falls through to implicit-fallback when a role references an unknown profile', async () => {
    const { projectRoot } = isolate();
    seedProjectConfig(projectRoot, {
      roles: {
        consolidation: { provider: 'anthropic', model: 'inline-model', profile: 'missing' },
      },
    });
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant';
    // Unknown profile name → resolveNamedProfile returns undefined → falls to
    // the inline {provider, model} tuple on the same role entry.
    const llm = await resolveLLMForRole('consolidation', { projectRoot });
    expect(llm.source).toBe('role');
    expect(llm.model).toBe('inline-model');
  });

  it('a profile credentialLabel pins the credential for the role', async () => {
    const { projectRoot } = isolate();
    seedProjectConfig(projectRoot, {
      profiles: {
        'codex-bg': {
          provider: 'anthropic',
          model: 'profile-model',
          credentialLabel: 'pinned-label',
        },
      },
      roles: { consolidation: { provider: 'anthropic', model: 'x', profile: 'codex-bg' } },
    });
    // Seed a cred-file entry under the pinned label.
    await addCredential({
      provider: 'anthropic',
      label: 'pinned-label',
      authType: 'api_key',
      accessToken: 'sk-ant-pinned',
      priority: 100,
    });
    const llm = await resolveLLMForRole('consolidation', { projectRoot });
    expect(llm.source).toBe('profile');
    expect(llm.credentialLabel).toBe('pinned-label');
    // E10 (T11753): plaintext is reachable ONLY via the sealed handle's fetch().
    expect((await llm.sealedCredential?.fetch())?.value).toBe('sk-ant-pinned');
  });
});

// ---------------------------------------------------------------------------
// Credential resolution
// ---------------------------------------------------------------------------

describe('resolveLLMForRole — credential resolution', () => {
  it('returns credential=null when no tier produces a token', async () => {
    const { projectRoot } = isolate();
    seedProjectConfig(projectRoot, {
      default: { provider: 'anthropic', model: 'mx' },
    });
    // No env, no cred-file, no claude-creds, no global / project config key.
    const llm = await resolveLLMForRole('consolidation', { projectRoot });
    expect(llm.credential).toBeNull();
    // E10 (T11753): no credential → null sealed handle, paired with null metadata.
    expect(llm.sealedCredential).toBeNull();
    expect(llm.client).toBeNull();
  });

  it('falls back to resolveCredentials (env tier) when cred-store empty', async () => {
    const { projectRoot } = isolate();
    seedProjectConfig(projectRoot, {
      default: { provider: 'anthropic', model: 'mx' },
    });
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-env';
    const llm = await resolveLLMForRole('consolidation', { projectRoot });
    expect((await llm.sealedCredential?.fetch())?.value).toBe('sk-ant-env');
    expect(llm.credential?.source).toBe('env');
    expect(llm.client).not.toBeNull();
  });

  it('cred-file pool (no label pinned) wins over env-only fallback', async () => {
    const { projectRoot } = isolate();
    seedProjectConfig(projectRoot, {
      default: { provider: 'anthropic', model: 'mx' },
    });
    // Note: resolveCredentials tier 2 (env) beats tier 3 (cred-file). With no
    // env var set, the cred-store picker wins.
    await addCredential({
      provider: 'anthropic',
      label: 'workspace-default',
      authType: 'api_key',
      accessToken: 'sk-ant-credfile',
      priority: 1,
    });
    const llm = await resolveLLMForRole('consolidation', { projectRoot });
    expect((await llm.sealedCredential?.fetch())?.value).toBe('sk-ant-credfile');
    expect(llm.credential?.source).toBe('cred-file');
    expect(llm.credentialLabel).toBe('workspace-default');
  });

  it('credentialLabel pin selects the matching cred-store entry', async () => {
    const { projectRoot } = isolate();
    seedProjectConfig(projectRoot, {
      roles: {
        consolidation: {
          provider: 'anthropic',
          model: 'mx',
          credentialLabel: 'work',
        },
      },
    });
    await addCredential({
      provider: 'anthropic',
      label: 'personal',
      authType: 'api_key',
      accessToken: 'sk-personal',
      priority: 1, // lowest priority — would win without preferLabel
    });
    await addCredential({
      provider: 'anthropic',
      label: 'work',
      authType: 'api_key',
      accessToken: 'sk-work',
      priority: 100,
    });
    const llm = await resolveLLMForRole('consolidation', { projectRoot });
    expect(llm.credentialLabel).toBe('work');
    expect((await llm.sealedCredential?.fetch())?.value).toBe('sk-work');
    expect(llm.credential?.source).toBe('cred-file');
  });

  it('credentialLabel mismatch falls through to resolveCredentials chain', async () => {
    const { projectRoot } = isolate();
    seedProjectConfig(projectRoot, {
      roles: {
        consolidation: {
          provider: 'anthropic',
          model: 'mx',
          credentialLabel: 'ghost',
        },
      },
    });
    await addCredential({
      provider: 'anthropic',
      label: 'real',
      authType: 'api_key',
      accessToken: 'sk-real',
      priority: 1,
    });
    process.env['ANTHROPIC_API_KEY'] = 'sk-env-rescue';
    const llm = await resolveLLMForRole('consolidation', { projectRoot });
    // Label did not match — picker is bypassed; tier 2 (env) wins.
    expect(llm.credentialLabel).toBeUndefined();
    expect((await llm.sealedCredential?.fetch())?.value).toBe('sk-env-rescue');
    expect(llm.credential?.source).toBe('env');
  });

  // T9360 — hasCredential lookup AC tests
  it('hasCredential is true when role pins credentialLabel and matching default credential exists (T9360)', async () => {
    const { projectRoot } = isolate();
    // Role explicitly pins credentialLabel='default'.
    seedProjectConfig(projectRoot, {
      roles: {
        extraction: {
          provider: 'anthropic',
          model: 'claude-haiku-4-5-20251001',
          credentialLabel: 'default',
        },
      },
    });
    await addCredential({
      provider: 'anthropic',
      label: 'default',
      authType: 'api_key',
      accessToken: 'sk-ant-default-pinned',
      priority: 1,
    });
    const llm = await resolveLLMForRole('extraction', { projectRoot });
    expect((await llm.sealedCredential?.fetch())?.value).toBe('sk-ant-default-pinned');
    expect(llm.credential?.source).toBe('cred-file');
    expect(llm.credentialLabel).toBe('default');
    // The key assertion for the T9360 AC: hasCredential equivalence — now the
    // sealed-handle presence is the post-E10 hasCredential signal (T11753).
    expect(!!llm.sealedCredential).toBe(true);
  });

  it('hasCredential is true when no credentialLabel but default-labelled credential exists (T9360)', async () => {
    const { projectRoot } = isolate();
    // Role has provider+model but NO credentialLabel set — picker should
    // find the 'default' entry from the cred-store automatically.
    seedProjectConfig(projectRoot, {
      roles: {
        extraction: {
          provider: 'anthropic',
          model: 'claude-haiku-4-5-20251001',
        },
      },
    });
    await addCredential({
      provider: 'anthropic',
      label: 'default',
      authType: 'api_key',
      accessToken: 'sk-ant-no-label-default',
      priority: 1,
    });
    const llm = await resolveLLMForRole('extraction', { projectRoot });
    expect((await llm.sealedCredential?.fetch())?.value).toBe('sk-ant-no-label-default');
    expect(llm.credential?.source).toBe('cred-file');
    expect(llm.credentialLabel).toBe('default');
    expect(!!llm.sealedCredential).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Type-level coverage of RoleName
// ---------------------------------------------------------------------------

describe('resolveLLMForRole — type coverage', () => {
  it('accepts every RoleName at the type level', async () => {
    const { projectRoot } = isolate();
    seedProjectConfig(projectRoot, {
      default: { provider: 'anthropic', model: 'mx' },
    });
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant';

    const roles: RoleName[] = ['extraction', 'consolidation', 'derivation', 'hygiene', 'judgement'];
    for (const role of roles) {
      const llm = await resolveLLMForRole(role, { projectRoot });
      expectTypeOf(llm).toMatchTypeOf<ResolvedLLM>();
      expect(llm.provider).toBe('anthropic');
      expect(llm.model).toBe('mx');
    }
  });
});
