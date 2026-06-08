/**
 * E10 sealed-credential boundary tests (T11753 — AC3).
 *
 * The security invariant this file enforces: **no bare plaintext secret string
 * crosses the resolver boundary.** After `resolveLLMForRole` /
 * `resolveLLMForSystem` returns, the only way to reach the plaintext is to call
 * `sealedCredential.fetch()` — the handle's provider/account are non-secret, and
 * a deep walk of the returned envelope finds the secret nowhere else (not on
 * `credential`, not serialized, not in any string field).
 *
 * NOTE on the `client` field: the resolver may construct a provider SDK client
 * (`new Anthropic(...)`) — the ONE sanctioned credential-holder named in the
 * Gate-13 chokepoint allowlist. That SDK object legitimately retains the key
 * internally to authenticate requests; it is a runtime object, NOT a bare
 * secret string the resolver "leaked". The walk below therefore EXCLUDES
 * `client` (and `sealedCredential.fetch`, whose closure is the intended secret
 * home) and asserts the plaintext appears on no OTHER envelope field. This is
 * the precise expression of the E10 invariant: the secret is no longer carried
 * as inline data up the stack — it lives only in the SDK client (sanctioned)
 * and the sealed `fetch()` closure (on-demand).
 *
 * These tests use the SAME filesystem-isolation harness as `role-resolver.test.ts`
 * so the resolver exercises real config/credential tiers rather than mocks.
 *
 * @task T11753
 * @epic T11746
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { makeSealedCredential } from '../sealed-credential.js';

const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
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

/** Fresh per-test tmp roots so no developer credential leaks in. */
function isolate(): { projectRoot: string } {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const xdgRoot = join(tmpdir(), `cleo-seal-xdg-${stamp}`);
  const xdgConfigHome = join(tmpdir(), `cleo-seal-cfg-${stamp}`);
  const home = join(tmpdir(), `cleo-seal-home-${stamp}`);
  const projectRoot = join(tmpdir(), `cleo-seal-proj-${stamp}`);
  mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
  mkdirSync(xdgRoot, { recursive: true });
  mkdirSync(xdgConfigHome, { recursive: true });
  mkdirSync(home, { recursive: true });
  process.env['XDG_DATA_HOME'] = xdgRoot;
  process.env['XDG_CONFIG_HOME'] = xdgConfigHome;
  process.env['HOME'] = home;
  delete process.env['CLEO_HOME'];
  delete process.env['CLEO_DIR'];
  _resetCleoPlatformPathsCache();
  return { projectRoot };
}

function seedProjectConfig(projectRoot: string, llm: Record<string, unknown>): void {
  writeFileSync(join(projectRoot, '.cleo', 'config.json'), JSON.stringify({ llm }, null, 2));
}

/**
 * Recursively collect every primitive string reachable from `value`, descending
 * into plain objects and arrays but NOT into functions (a function body is
 * opaque — the closure-captured secret is exactly what we WANT to be unreachable
 * by a structural/serialization walk).
 */
function reachableStrings(value: unknown, seen = new Set<unknown>()): string[] {
  if (typeof value === 'string') return [value];
  if (value === null || typeof value !== 'object') return [];
  if (seen.has(value)) return [];
  seen.add(value);
  const out: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) out.push(...reachableStrings(item, seen));
    return out;
  }
  for (const v of Object.values(value as Record<string, unknown>)) {
    out.push(...reachableStrings(v, seen));
  }
  return out;
}

const SECRET = 'sk-ant-SECRET-boundary-do-not-leak-0123456789';

/**
 * Project the resolved envelope to its DATA surface — everything EXCEPT the
 * sanctioned credential-holders: the provider SDK `client` (the one allowed
 * `new Anthropic(...)` instance, which retains the key to authenticate) and the
 * `sealedCredential.fetch` closure (the intended on-demand secret home). What
 * remains is the data that genuinely crosses the resolver boundary inline.
 */
function envelopeDataSurface(llm: {
  client?: unknown;
  sealedCredential?: {
    provider: string;
    account: string;
    tokenPreview?: string;
    fetch: unknown;
  } | null;
  [k: string]: unknown;
}): Record<string, unknown> {
  const { client: _client, sealedCredential, ...rest } = llm;
  return {
    ...rest,
    // Keep the handle's NON-secret identity fields (incl. the redacted
    // tokenPreview); drop the fetch closure.
    sealedCredential: sealedCredential
      ? {
          provider: sealedCredential.provider,
          account: sealedCredential.account,
          tokenPreview: sealedCredential.tokenPreview,
        }
      : sealedCredential,
  };
}

describe('E10 resolver boundary — no bare secret crosses the resolver (T11753 · AC3)', () => {
  beforeEach(() => {
    saveEnv();
    clearEnv();
    _resetCleoPlatformPathsCache();
    _resetGlobalConfigMigrationLatch();
    _resetPermsWarningForTests();
    _resetRoundRobinForTests();
    clearAnthropicKeyCache();
  });

  afterEach(() => {
    restoreEnv();
    _resetCleoPlatformPathsCache();
  });

  it('the resolved envelope contains the plaintext NOWHERE — not credential, not any string field', async () => {
    const { projectRoot } = isolate();
    seedProjectConfig(projectRoot, { default: { provider: 'anthropic', model: 'mx' } });
    process.env['ANTHROPIC_API_KEY'] = SECRET;

    const llm = await resolveLLMForRole('consolidation', { projectRoot });

    // A credential WAS resolved (the sealed handle is present)…
    expect(llm.sealedCredential).not.toBeNull();
    // …but the plaintext is reachable on NO inline DATA field of the envelope
    // (excluding the sanctioned SDK client + the fetch() closure).
    const surface = envelopeDataSurface(llm);
    expect(reachableStrings(surface)).not.toContain(SECRET);
    // Belt-and-suspenders: serializing the data surface never reveals it.
    expect(JSON.stringify(surface)).not.toContain(SECRET);
  });

  it('the inline credential metadata carries provider/source/authType but NO apiKey', async () => {
    const { projectRoot } = isolate();
    seedProjectConfig(projectRoot, { default: { provider: 'anthropic', model: 'mx' } });
    process.env['ANTHROPIC_API_KEY'] = SECRET;

    const llm = await resolveLLMForRole('consolidation', { projectRoot });

    expect(llm.credential).toMatchObject({
      provider: 'anthropic',
      source: 'env',
      authType: 'api_key',
    });
    // The runtime object must not even have an `apiKey` key.
    expect(Object.keys(llm.credential ?? {})).not.toContain('apiKey');
  });

  it('the plaintext is reachable ONLY by calling sealedCredential.fetch()', async () => {
    const { projectRoot } = isolate();
    seedProjectConfig(projectRoot, { default: { provider: 'anthropic', model: 'mx' } });
    process.env['ANTHROPIC_API_KEY'] = SECRET;

    const llm = await resolveLLMForRole('consolidation', { projectRoot });
    const token = await llm.sealedCredential?.fetch();
    expect(token?.value).toBe(SECRET);
    // The non-secret handle fields are safe to surface.
    expect(llm.sealedCredential?.provider).toBe('anthropic');
    expect(typeof llm.sealedCredential?.account).toBe('string');
  });

  it('no credential resolved → both credential and sealedCredential are null', async () => {
    const { projectRoot } = isolate();
    seedProjectConfig(projectRoot, { default: { provider: 'anthropic', model: 'mx' } });
    // No env, no store, no config key.
    const llm = await resolveLLMForRole('consolidation', { projectRoot });
    expect(llm.credential).toBeNull();
    expect(llm.sealedCredential).toBeNull();
  });

  it('the resolver surfaces a non-secret tokenPreview on the handle, never the full token (T11754)', async () => {
    const { projectRoot } = isolate();
    seedProjectConfig(projectRoot, { default: { provider: 'anthropic', model: 'mx' } });
    process.env['ANTHROPIC_API_KEY'] = SECRET;

    const llm = await resolveLLMForRole('consolidation', { projectRoot });
    // Preview is present, redacted to the last 4 chars, and is NOT the secret.
    expect(llm.sealedCredential?.tokenPreview).toBe(`…${SECRET.slice(-4)}`);
    expect(llm.sealedCredential?.tokenPreview).not.toContain(SECRET);
    // The preview is reachable on the data surface (safe); the secret is not.
    const surface = envelopeDataSurface(llm);
    expect(reachableStrings(surface)).toContain(`…${SECRET.slice(-4)}`);
    expect(reachableStrings(surface)).not.toContain(SECRET);
  });

  it('a cred-store token is also fully sealed (not just the env tier)', async () => {
    const { projectRoot } = isolate();
    seedProjectConfig(projectRoot, { default: { provider: 'anthropic', model: 'mx' } });
    await addCredential({
      provider: 'anthropic',
      label: 'sealed-test',
      authType: 'api_key',
      accessToken: SECRET,
      priority: 1,
    });
    const llm = await resolveLLMForRole('consolidation', { projectRoot });
    expect(JSON.stringify(envelopeDataSurface(llm))).not.toContain(SECRET);
    expect((await llm.sealedCredential?.fetch())?.value).toBe(SECRET);
  });
});

describe('makeSealedCredential — the handle does not expose the secret structurally (T11753)', () => {
  it('serializing the handle never reveals the captured plaintext', async () => {
    const sealed = makeSealedCredential({
      provider: 'anthropic',
      account: 'work',
      tokenPreview: '…leak',
      resolveToken: () => SECRET,
    });
    // Provider + account are non-secret and safe to surface…
    expect(sealed.provider).toBe('anthropic');
    expect(sealed.account).toBe('work');
    // …but a structural walk / JSON dump of the handle never contains the secret
    // (it lives only in the fetch() closure).
    expect(reachableStrings(sealed)).not.toContain(SECRET);
    expect(JSON.stringify(sealed)).not.toContain(SECRET);
    // The secret materializes ONLY on fetch().
    expect((await sealed.fetch()).value).toBe(SECRET);
  });

  it('supports an async on-demand resolver (the T11754 vault-fetch shape)', async () => {
    const sealed = makeSealedCredential({
      provider: 'openai',
      account: 'default',
      tokenPreview: '…CRET',
      resolveToken: async () => {
        await Promise.resolve();
        return SECRET;
      },
    });
    expect((await sealed.fetch()).value).toBe(SECRET);
  });

  it('propagates resolver failure so callers degrade gracefully', async () => {
    const sealed = makeSealedCredential({
      provider: 'anthropic',
      account: 'broken',
      tokenPreview: '…oken',
      resolveToken: () => {
        throw new Error('vault unreachable');
      },
    });
    await expect(sealed.fetch()).rejects.toThrow('vault unreachable');
  });
});
