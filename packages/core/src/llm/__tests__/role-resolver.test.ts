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
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import { clearAnthropicKeyCache } from '../credentials.js';
import {
  _resetPermsWarningForTests,
  _resetRoundRobinForTests,
  addCredential,
} from '../credentials-store.js';
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
  'XDG_DATA_HOME',
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
  const home = join(tmpdir(), `cleo-rr-home-${stamp}`);
  const projectRoot = join(tmpdir(), `cleo-rr-proj-${stamp}`);
  mkdirSync(join(xdgRoot, 'cleo'), { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
  process.env['XDG_DATA_HOME'] = xdgRoot;
  process.env['HOME'] = home;
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

  it('resolves role with no daemon field configured — falls back to implicit', async () => {
    const { projectRoot } = isolate();
    // No llm.daemon, no llm.default, no llm.roles → implicit fallback.
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-no-daemon';
    const llm = await resolveLLMForRole('consolidation', { projectRoot });
    expect(llm.source).toBe('implicit-fallback');
    expect(llm.provider).toBe(IMPLICIT_FALLBACK_PROVIDER);
    expect(llm.model).toBe(IMPLICIT_FALLBACK_MODEL);
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

  it("source='implicit-fallback' when nothing is configured", async () => {
    const { projectRoot } = isolate();
    // No project config + no global config → all three tiers absent.
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-fb';
    const llm = await resolveLLMForRole('consolidation', { projectRoot });
    expect(llm.source).toBe('implicit-fallback');
    expect(llm.provider).toBe(IMPLICIT_FALLBACK_PROVIDER);
    expect(llm.model).toBe(IMPLICIT_FALLBACK_MODEL);
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
    expect(llm.client).toBeNull();
  });

  it('falls back to resolveCredentials (env tier) when cred-store empty', async () => {
    const { projectRoot } = isolate();
    seedProjectConfig(projectRoot, {
      default: { provider: 'anthropic', model: 'mx' },
    });
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-env';
    const llm = await resolveLLMForRole('consolidation', { projectRoot });
    expect(llm.credential?.apiKey).toBe('sk-ant-env');
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
    expect(llm.credential?.apiKey).toBe('sk-ant-credfile');
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
    expect(llm.credential?.apiKey).toBe('sk-work');
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
    expect(llm.credential?.apiKey).toBe('sk-env-rescue');
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
    expect(llm.credential?.apiKey).toBe('sk-ant-default-pinned');
    expect(llm.credential?.source).toBe('cred-file');
    expect(llm.credentialLabel).toBe('default');
    // The key assertion for the T9360 AC: hasCredential equivalence.
    expect(!!llm.credential?.apiKey).toBe(true);
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
    expect(llm.credential?.apiKey).toBe('sk-ant-no-label-default');
    expect(llm.credential?.source).toBe('cred-file');
    expect(llm.credentialLabel).toBe('default');
    expect(!!llm.credential?.apiKey).toBe(true);
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
