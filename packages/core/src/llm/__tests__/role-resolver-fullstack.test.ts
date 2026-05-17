/**
 * Full-stack tests for `resolveLLMForRole` (T9259).
 *
 * The file is named `role-resolver-fullstack.test.ts` (not
 * `*-integration.test.ts`) so the default `pnpm test` sweep picks it up —
 * the package vitest config excludes the `*-integration.test.ts` and
 * `*.integration.test.ts` patterns and routes them through
 * `pnpm run test:integration` instead.
 *
 * Where `role-resolver.test.ts` exercises individual resolution paths in
 * isolation, this file walks the cross-cutting matrix of:
 *
 *   • Every {@link RoleName} value, end-to-end, with a representative config
 *   • Every adjacent pair in the 6-tier credential precedence chain
 *     (env > cred-file > claude-creds > global-config > project-config),
 *     asserting the higher-priority tier wins every time
 *   • A multi-role config where each role pins to a different credential
 *     label, asserting per-role isolation
 *
 * Isolation is identical to `credentials-store.test.ts` and the existing
 * `role-resolver.test.ts`: fresh tmpdirs for `XDG_DATA_HOME`, `HOME`, and the
 * project root per test; env restored in `afterEach`.
 *
 * @task T9259
 * @epic T-LLM-CRED-CENTRALIZATION
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RoleName } from '@cleocode/contracts';
import { _resetCleoPlatformPathsCache } from '@cleocode/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAnthropicKeyCache } from '../credentials.js';
import {
  _resetPermsWarningForTests,
  _resetRoundRobinForTests,
  addCredential,
} from '../credentials-store.js';
import { _resetGlobalConfigMigrationLatch } from '../global-config-migration.js';
import { resolveLLMForRole } from '../role-resolver.js';

const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'MOONSHOT_API_KEY',
  'XDG_DATA_HOME',
  // T9405: getCleoPlatformPaths().config reads XDG_CONFIG_HOME — must be
  // isolated per-test so the global-config-dir tier doesn't leak across runs.
  'XDG_CONFIG_HOME',
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

function isolate(): { xdgRoot: string; home: string; projectRoot: string } {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const xdgRoot = join(tmpdir(), `cleo-rri-xdg-${stamp}`);
  const xdgConfigHome = join(tmpdir(), `cleo-rri-cfg-${stamp}`);
  const home = join(tmpdir(), `cleo-rri-home-${stamp}`);
  const projectRoot = join(tmpdir(), `cleo-rri-proj-${stamp}`);
  mkdirSync(join(xdgRoot, 'cleo'), { recursive: true });
  mkdirSync(xdgConfigHome, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
  process.env['XDG_DATA_HOME'] = xdgRoot;
  // T9405: pin XDG_CONFIG_HOME so getCleoPlatformPaths().config resolves to
  // a per-test temp dir — without this, the global-config-dir tier leaks
  // across tests within the same process.
  process.env['XDG_CONFIG_HOME'] = xdgConfigHome;
  // T9403: mirror XDG layout under CLEO_HOME for getCleoHome().
  process.env['CLEO_HOME'] = join(xdgRoot, 'cleo');
  process.env['HOME'] = home;
  // T9405: env-paths reads fresh, but our cleo-paths system-info cache and
  // the global-config migration latch must be re-armed for each test.
  _resetCleoPlatformPathsCache();
  _resetGlobalConfigMigrationLatch();
  return { xdgRoot, home, projectRoot };
}

function seedProjectConfig(projectRoot: string, llm: unknown): void {
  writeFileSync(
    join(projectRoot, '.cleo', 'config.json'),
    JSON.stringify({ llm }, null, 2),
    'utf-8',
  );
}

function seedClaudeOauth(home: string, accessToken: string): void {
  const claudeDir = join(home, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(
    join(claudeDir, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: { accessToken, expiresAt: Date.now() + 60 * 60_000 },
    }),
    'utf-8',
  );
}

function seedGlobalConfig(xdgRoot: string, llm: unknown): void {
  const cleoDir = join(xdgRoot, 'cleo');
  mkdirSync(cleoDir, { recursive: true });
  writeFileSync(join(cleoDir, 'config.json'), JSON.stringify({ llm }, null, 2), 'utf-8');
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
// Full-stack: every role resolves end-to-end
// ---------------------------------------------------------------------------

const ALL_ROLES: readonly RoleName[] = [
  'extraction',
  'consolidation',
  'derivation',
  'hygiene',
  'judgement',
] as const;

describe('resolveLLMForRole — full-stack for every RoleName', () => {
  it('every role resolves with the env-tier credential when no cred-file is present', async () => {
    const { projectRoot } = isolate();
    seedProjectConfig(projectRoot, {
      default: { provider: 'anthropic', model: 'integration-default-model' },
    });
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-integration-env';

    for (const role of ALL_ROLES) {
      const llm = await resolveLLMForRole(role, { projectRoot });
      expect(llm.source).toBe('default');
      expect(llm.provider).toBe('anthropic');
      expect(llm.model).toBe('integration-default-model');
      expect(llm.credential?.source).toBe('env');
      expect(llm.credential?.apiKey).toBe('sk-ant-integration-env');
      expect(llm.client).not.toBeNull();
    }
  });

  it('every role honours its own roles[role] override', async () => {
    const { projectRoot } = isolate();
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-shared';
    // Seed a different model per role; all should round-trip through the
    // resolver to the same call-site.
    seedProjectConfig(projectRoot, {
      default: { provider: 'anthropic', model: 'never-picked' },
      roles: {
        extraction: { provider: 'anthropic', model: 'model-extraction' },
        consolidation: { provider: 'anthropic', model: 'model-consolidation' },
        derivation: { provider: 'anthropic', model: 'model-derivation' },
        hygiene: { provider: 'anthropic', model: 'model-hygiene' },
        judgement: { provider: 'anthropic', model: 'model-judgement' },
      },
    });

    for (const role of ALL_ROLES) {
      const llm = await resolveLLMForRole(role, { projectRoot });
      expect(llm.source).toBe('role');
      expect(llm.model).toBe(`model-${role}`);
      expect(llm.credential?.apiKey).toBe('sk-ant-shared');
    }
  });
});

// ---------------------------------------------------------------------------
// Tier precedence — assert higher-priority tier always wins
// ---------------------------------------------------------------------------

describe('resolveLLMForRole — credential tier precedence (full chain)', () => {
  it('env (tier 2) beats claude-creds (tier 4) when no cred-file is present', async () => {
    // role-resolver consults `pickCredentialForProvider` FIRST when no
    // `credentialLabel` is pinned; with no cred-file entry, that returns
    // null and `resolveCredentials` runs, where env (tier 2) beats
    // claude-creds (tier 4).
    const { home, projectRoot } = isolate();
    seedProjectConfig(projectRoot, { default: { provider: 'anthropic', model: 'm' } });
    process.env['ANTHROPIC_API_KEY'] = 'sk-env-wins';
    seedClaudeOauth(home, 'sk-ant-oat-loses');

    const llm = await resolveLLMForRole('consolidation', { projectRoot });
    expect(llm.credential?.source).toBe('env');
    expect(llm.credential?.apiKey).toBe('sk-env-wins');
  });

  it('cred-file (tier 3) beats claude-creds (tier 4)', async () => {
    const { home, projectRoot } = isolate();
    seedProjectConfig(projectRoot, { default: { provider: 'anthropic', model: 'm' } });
    seedClaudeOauth(home, 'sk-ant-oat-claude-loses');
    await addCredential({
      provider: 'anthropic',
      label: 'pool',
      authType: 'oauth',
      accessToken: 'sk-ant-oat-credfile-wins',
      priority: 1,
      expiresAt: Date.now() + 60 * 60_000,
    });

    const llm = await resolveLLMForRole('consolidation', { projectRoot });
    expect(llm.credential?.source).toBe('cred-file');
    expect(llm.credential?.apiKey).toBe('sk-ant-oat-credfile-wins');
  });

  it('claude-creds (tier 4) beats global-config (tier 4a)', async () => {
    const { home, xdgRoot, projectRoot } = isolate();
    seedProjectConfig(projectRoot, { default: { provider: 'anthropic', model: 'm' } });
    seedClaudeOauth(home, 'sk-ant-oat-claude-wins');
    seedGlobalConfig(xdgRoot, {
      providers: { anthropic: { apiKey: 'sk-ant-global-loses' } },
    });

    const llm = await resolveLLMForRole('consolidation', { projectRoot });
    expect(llm.credential?.source).toBe('claude-creds');
    expect(llm.credential?.apiKey).toBe('sk-ant-oat-claude-wins');
  });

  it('global-config (tier 4a) beats project-config (tier 5)', async () => {
    const { xdgRoot, projectRoot } = isolate();
    seedProjectConfig(projectRoot, {
      default: { provider: 'anthropic', model: 'm' },
      providers: { anthropic: { apiKey: 'sk-project-loses' } },
    });
    seedGlobalConfig(xdgRoot, {
      providers: { anthropic: { apiKey: 'sk-global-wins' } },
    });

    const llm = await resolveLLMForRole('consolidation', { projectRoot });
    expect(llm.credential?.source).toBe('global-config');
    expect(llm.credential?.apiKey).toBe('sk-global-wins');
  });

  it('project-config (tier 5) is the floor when every higher tier is empty', async () => {
    const { projectRoot } = isolate();
    seedProjectConfig(projectRoot, {
      default: { provider: 'anthropic', model: 'm' },
      providers: { anthropic: { apiKey: 'sk-project-floor' } },
    });

    const llm = await resolveLLMForRole('consolidation', { projectRoot });
    expect(llm.credential?.source).toBe('project-config');
    expect(llm.credential?.apiKey).toBe('sk-project-floor');
  });
});

// ---------------------------------------------------------------------------
// Per-role credential pinning — distinct labels for distinct roles
// ---------------------------------------------------------------------------

describe('resolveLLMForRole — per-role credentialLabel isolation', () => {
  it('different roles pinned to different labels each get their own credential', async () => {
    const { projectRoot } = isolate();

    await addCredential({
      provider: 'anthropic',
      label: 'extract-key',
      authType: 'api_key',
      accessToken: 'sk-for-extraction',
      priority: 50,
    });
    await addCredential({
      provider: 'anthropic',
      label: 'judge-key',
      authType: 'api_key',
      accessToken: 'sk-for-judgement',
      priority: 50,
    });

    seedProjectConfig(projectRoot, {
      roles: {
        extraction: {
          provider: 'anthropic',
          model: 'extract-model',
          credentialLabel: 'extract-key',
        },
        judgement: {
          provider: 'anthropic',
          model: 'judge-model',
          credentialLabel: 'judge-key',
        },
      },
    });

    const ext = await resolveLLMForRole('extraction', { projectRoot });
    expect(ext.credentialLabel).toBe('extract-key');
    expect(ext.credential?.apiKey).toBe('sk-for-extraction');
    expect(ext.model).toBe('extract-model');

    const jud = await resolveLLMForRole('judgement', { projectRoot });
    expect(jud.credentialLabel).toBe('judge-key');
    expect(jud.credential?.apiKey).toBe('sk-for-judgement');
    expect(jud.model).toBe('judge-model');
  });
});
