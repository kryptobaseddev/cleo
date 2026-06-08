/**
 * Phase 1 → Phase 2 migration tests (T-LLM-CRED-CENTRALIZATION / T9259).
 *
 * The acceptance criterion from the Phase 2 plan is:
 *
 *   *Existing `.cleo/config.json` with only `llm.providers.anthropic.apiKey`
 *   continues to resolve via the legacy tier when neither the new
 *   credentials-file nor `llm.default` is set.*
 *
 * These tests exercise the full stack (`loadConfig` → `resolveLLMForRole` →
 * `resolveCredentials` → `pickCredentialForProviderSync` → tier 4a/4b/5
 * fallback) against a tmpdir-isolated XDG/HOME/project root so a fresh Phase 1
 * install boots without any of the Phase 2 surface present.
 *
 * Filesystem isolation mirrors `role-resolver.test.ts` and
 * `credentials-store.test.ts`.
 *
 * @task T9259
 * @epic T-LLM-CRED-CENTRALIZATION
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetCleoPlatformPathsCache } from '@cleocode/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearAnthropicKeyCache } from '../credentials.js';
import {
  _resetPermsWarningForTests,
  _resetRoundRobinForTests,
  addCredential,
  credentialsStorePath,
} from '../credentials-store.js';
import { _resetGlobalConfigMigrationLatch } from '../global-config-migration.js';
import {
  IMPLICIT_FALLBACK_MODEL,
  IMPLICIT_FALLBACK_PROVIDER,
  resolveLLMForRole,
} from '../role-resolver.js';

const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'MOONSHOT_API_KEY',
  'XDG_DATA_HOME',
  // T9405: pin XDG_CONFIG_HOME so getCleoPlatformPaths().config resolves to
  // a per-test temp dir; without this the global-config-dir tier leaks
  // across tests within the same process.
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
 * Provision fresh tmpdirs for XDG_DATA_HOME, HOME, and the project root, and
 * point env vars at them. Guarantees that no developer credentials, no real
 * `~/.cleo/llm-credentials.json`, and no real `~/.claude/.credentials.json`
 * leak into the test.
 */
function isolate(): { xdgRoot: string; home: string; projectRoot: string } {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const xdgRoot = join(tmpdir(), `cleo-mig-xdg-${stamp}`);
  const xdgConfigHome = join(tmpdir(), `cleo-mig-cfg-${stamp}`);
  const home = join(tmpdir(), `cleo-mig-home-${stamp}`);
  const projectRoot = join(tmpdir(), `cleo-mig-proj-${stamp}`);
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

/**
 * Seed a Phase 1-style project config: only `llm.providers.<provider>.apiKey`.
 * Nothing else under `llm` — explicitly no `default`, `roles`, or `daemon`.
 */
function seedPhase1ProjectConfig(projectRoot: string, provider: string, apiKey: string): void {
  const cfgPath = join(projectRoot, '.cleo', 'config.json');
  const cfg = {
    llm: {
      providers: {
        [provider]: { apiKey },
      },
    },
  };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf-8');
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
// Acceptance criterion — legacy `llm.providers[p].apiKey` still resolves
// ---------------------------------------------------------------------------

describe('Phase 1 → Phase 2 migration — legacy project-config REJECTED (T9413)', () => {
  it('a Phase 1 .cleo/config.json with only llm.providers.anthropic.apiKey NO LONGER resolves (footgun kill)', async () => {
    // T9413 (E-CONFIG-AUTH-UNIFY §5.2 T-E2-6): project-config apiKey is now
    // rejected. The legacy Phase 1 path no longer resolves — operators
    // must migrate via `cleo auth migrate-project-secrets`.
    const { projectRoot } = isolate();
    seedPhase1ProjectConfig(projectRoot, 'anthropic', 'sk-ant-api03-FIXTURE');

    // Pre-conditions: no env var, no cred-file, no claude-creds OAuth, no
    // llm.default, no llm.roles, no llm.daemon, no global config key.
    expect(process.env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(existsSync(credentialsStorePath())).toBe(false);

    const llm = await resolveLLMForRole('consolidation', { projectRoot });

    // Provider/model fall through to the implicit fallback because no
    // role/default/daemon block exists.
    expect(llm.source).toBe('implicit-fallback');
    expect(llm.provider).toBe(IMPLICIT_FALLBACK_PROVIDER);
    expect(llm.model).toBe(IMPLICIT_FALLBACK_MODEL);

    // The project-config tier is rejected — credential MUST be null.
    expect(llm.credential).toBeNull();
    expect(llm.client).toBeNull();
  });

  it('every RoleName falls through to null credential from a Phase 1 config (T9413)', async () => {
    const { projectRoot } = isolate();
    seedPhase1ProjectConfig(projectRoot, 'anthropic', 'sk-ant-api03-LEGACY');

    const roles = ['extraction', 'consolidation', 'derivation', 'hygiene', 'judgement'] as const;
    for (const role of roles) {
      const llm = await resolveLLMForRole(role, { projectRoot });
      expect(llm.source).toBe('implicit-fallback');
      expect(llm.credential).toBeNull();
      expect(llm.client).toBeNull();
    }
  });

  it('Phase 1 openai-only config still resolves without anthropic interference', async () => {
    const { projectRoot } = isolate();
    seedPhase1ProjectConfig(projectRoot, 'openai', 'sk-openai-FIXTURE');

    // No anthropic env, no cred-file, no openai env.
    const llm = await resolveLLMForRole('consolidation', { projectRoot });

    // Provider/model still fall through to the anthropic implicit fallback
    // because Phase 1 configs never declared a "role-default provider".
    // The credential resolver is called for the implicit-fallback provider
    // (anthropic) so it sees NO project config key for anthropic and the
    // whole resolver returns `credential: null`.
    expect(llm.source).toBe('implicit-fallback');
    expect(llm.provider).toBe('anthropic');
    expect(llm.credential).toBeNull();
    expect(llm.client).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Phase 1 + Phase 2 coexistence — adding `llm.default` flips the provider
// ---------------------------------------------------------------------------

describe('Phase 1 → Phase 2 migration — additive upgrade', () => {
  it('adding only llm.default upgrades provider/model but project-config apiKey is REJECTED (T9413)', async () => {
    const { projectRoot } = isolate();
    // Phase 1 fixture: providers map only.
    seedPhase1ProjectConfig(projectRoot, 'anthropic', 'sk-ant-api03-LEGACY-KEY');

    // Phase 2 augmentation: layer in llm.default by re-writing the file. A
    // real upgrade path is `cleo config llm.default.provider anthropic ...`.
    const cfgPath = join(projectRoot, '.cleo', 'config.json');
    writeFileSync(
      cfgPath,
      JSON.stringify(
        {
          llm: {
            providers: { anthropic: { apiKey: 'sk-ant-api03-LEGACY-KEY' } },
            default: { provider: 'anthropic', model: 'phase2-default-model' },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const llm = await resolveLLMForRole('consolidation', { projectRoot });
    // Provider/model now come from llm.default.
    expect(llm.source).toBe('default');
    expect(llm.model).toBe('phase2-default-model');
    // The project-config apiKey is now rejected (T9413 footgun kill); the
    // credential resolves to null until the operator migrates via
    // `cleo auth migrate-project-secrets`.
    expect(llm.credential).toBeNull();
  });

  it('seeding ~/.cleo/llm-credentials.json (Phase 2) overtakes legacy project-config tier', async () => {
    const { projectRoot } = isolate();
    seedPhase1ProjectConfig(projectRoot, 'anthropic', 'sk-ant-api03-OLD');

    // Phase 2 upgrade: write a Phase 2 cred-file entry. The cred-file tier
    // (tier 3) MUST beat the project-config tier (tier 5).
    await addCredential({
      provider: 'anthropic',
      label: 'personal',
      authType: 'api_key',
      accessToken: 'sk-ant-api03-NEW',
      priority: 1,
    });
    clearAnthropicKeyCache();

    const llm = await resolveLLMForRole('consolidation', { projectRoot });
    expect(llm.credential?.source).toBe('cred-file');
    expect((await llm.sealedCredential?.fetch())?.value).toBe('sk-ant-api03-NEW');
    expect(llm.credentialLabel).toBe('personal');
  });
});
