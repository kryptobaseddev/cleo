/**
 * Agent API key storage (T12352).
 *
 * Before T12352 `agent_registry_agents.api_key_encrypted` held a derived HMAC
 * and the real key was discarded, including the key the cloud returned from
 * `rotate-key`. These tests prove that the real key is now stored encrypted
 * and recovered:
 *   1. after register (`createProjectAgent`);
 *   2. after a process restart (fresh module graph);
 *   3. after `update({ apiKey })` and `rotateKey()`;
 *   4. after a portable restore onto a device with a different machine-key.
 * And that legacy rows keep their exact pre-fix read value, are flagged
 * `requiresReauth`, and are reported with the command that re-registers them,
 * without their stored value ever being modified.
 *
 * Temp homes only, synthetic keys only; the paths module is mocked to the
 * temp home exactly as `agent-registry-accessor.test.ts` does.
 *
 * @task T12352
 */

import { createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { removeTempDirSync } from '../../__tests__/test-cleanup.js';

const AGENT_ID = 'agent-t12352';
const REAL_KEY = 'sk_live_SYNTHETIC_t12352_real_key';

const SPEC = {
  agentId: AGENT_ID,
  displayName: 'Key Storage Agent',
  apiKey: REAL_KEY,
  apiBaseUrl: 'https://api.signaldock.invalid',
  privacyTier: 'public' as const,
  capabilities: ['chat'],
  skills: ['coding'],
  transportType: 'http' as const,
  transportConfig: {},
  isActive: true,
};

let base: string;
let cleoHome: string;
let projectRoot: string;

/** Read the raw stored value. */
function storedValue(home: string): { value: string | null; reauth: number } {
  const db = new DatabaseSync(join(home, 'cleo.db'), { readOnly: true });
  try {
    const row = db
      .prepare(
        'SELECT api_key_encrypted AS value, requires_reauth AS reauth FROM agent_registry_agents WHERE agent_id = ?',
      )
      .get(AGENT_ID) as { value: string | null; reauth: number } | undefined;
    return row ?? { value: null, reauth: -1 };
  } finally {
    db.close();
  }
}

/** Overwrite the stored value (to seed a pre-T12352 row). */
function setStoredValue(value: string): void {
  const db = new DatabaseSync(join(cleoHome, 'cleo.db'));
  try {
    db.prepare(
      'UPDATE agent_registry_agents SET api_key_encrypted = ?, requires_reauth = 0 WHERE agent_id = ?',
    ).run(value, AGENT_ID);
  } finally {
    db.close();
  }
}

/** Load the accessor against the temp home (fresh module graph each call). */
async function loadAccessor(): Promise<typeof import('../agent-registry-accessor.js')> {
  vi.resetModules();
  vi.doMock('../../paths.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../paths.js')>()),
    getCleoHome: () => cleoHome,
    resolveCleoDir: (cwd?: string) => join(cwd ?? projectRoot, '.cleo'),
  }));
  const { ensureGlobalAgentRegistryDb } = await import('../agent-registry-store.js');
  const { ensureConduitDb, closeConduitDb } = await import('../conduit-sqlite.js');
  await ensureGlobalAgentRegistryDb();
  await ensureConduitDb(projectRoot);
  closeConduitDb();
  return import('../agent-registry-accessor.js');
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'cleo-t12352-'));
  cleoHome = join(base, 'cleo-home');
  projectRoot = join(base, 'project');
  mkdirSync(cleoHome, { recursive: true });
  mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
  writeFileSync(join(cleoHome, 'machine-key'), Buffer.alloc(32, 0xab), { mode: 0o600 });
  writeFileSync(join(cleoHome, 'global-salt'), Buffer.alloc(32, 0xcd), { mode: 0o600 });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock('../../paths.js');
  removeTempDirSync(base);
});

describe('the real key is stored encrypted and recovered', () => {
  it('register → stored as gk1: ciphertext (not plaintext, not an HMAC) → read back as the real key', async () => {
    const { createProjectAgent, lookupAgent } = await loadAccessor();
    await createProjectAgent(projectRoot, SPEC);

    const { value, reauth } = storedValue(cleoHome);
    expect(value?.startsWith('gk1:')).toBe(true);
    expect(value).not.toContain(REAL_KEY);
    expect(reauth).toBe(0);

    const agent = await lookupAgent(projectRoot, AGENT_ID, { includeGlobal: true });
    expect(agent?.apiKey).toBe(REAL_KEY);
    expect(agent?.requiresReauth).toBeUndefined();
  });

  it('survives a process restart (fresh module graph, key read from disk)', async () => {
    const first = await loadAccessor();
    await first.createProjectAgent(projectRoot, SPEC);

    const second = await loadAccessor();
    const agent = await new second.AgentRegistryAccessor(projectRoot).get(AGENT_ID, {
      includeGlobal: true,
    });
    expect(agent?.apiKey).toBe(REAL_KEY);
  });

  it('update({ apiKey }) stores the supplied key and clears requires_reauth', async () => {
    const { createProjectAgent, AgentRegistryAccessor } = await loadAccessor();
    await createProjectAgent(projectRoot, SPEC);
    setStoredValue('ab'.repeat(32));
    const registry = new AgentRegistryAccessor(projectRoot);

    await registry.update(AGENT_ID, { apiKey: 'sk_live_SYNTHETIC_updated' });
    expect(storedValue(cleoHome).reauth).toBe(0);
    const agent = await registry.get(AGENT_ID, { includeGlobal: true });
    expect(agent?.apiKey).toBe('sk_live_SYNTHETIC_updated');
  });

  it('rotateKey() keeps the key the cloud issued (it used to be discarded)', async () => {
    const { createProjectAgent, AgentRegistryAccessor } = await loadAccessor();
    await createProjectAgent(projectRoot, SPEC);
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: { headers?: Record<string, string> }) => {
        seen.push(init?.headers?.['Authorization'] ?? '');
        return new Response(JSON.stringify({ data: { apiKey: 'sk_live_SYNTHETIC_rotated' } }), {
          status: 200,
        });
      }),
    );
    const registry = new AgentRegistryAccessor(projectRoot);

    await registry.rotateKey(AGENT_ID);
    // The rotate call itself authenticated with the REAL current key.
    expect(seen).toEqual([`Bearer ${REAL_KEY}`]);
    const agent = await registry.get(AGENT_ID, { includeGlobal: true });
    expect(agent?.apiKey).toBe('sk_live_SYNTHETIC_rotated');
  });
});

describe('rows written before T12352', () => {
  it('keep their exact pre-fix read value, are flagged requiresReauth, and are listed for re-registration', async () => {
    const { createProjectAgent, lookupAgent } = await loadAccessor();
    await createProjectAgent(projectRoot, SPEC);
    // Exactly what the pre-fix code stored: hex(HMAC(machine-key ‖ salt, agentId)).
    const legacy = createHmac(
      'sha256',
      Buffer.concat([Buffer.alloc(32, 0xab), Buffer.alloc(32, 0xcd)]),
    )
      .update(AGENT_ID, 'utf8')
      .digest('hex');
    setStoredValue(legacy);

    const agent = await lookupAgent(projectRoot, AGENT_ID, { includeGlobal: true });
    // The pre-fix reader returned hex(utf8(stored)); nothing that depends on it changes.
    expect(agent?.apiKey).toBe(Buffer.from(legacy).toString('hex'));
    expect(agent?.requiresReauth).toBe(true);

    const { auditAgentRegistryKeys } = await import('../credential-transfer.js');
    const dbPath = join(cleoHome, 'cleo.db');
    const preview = await auditAgentRegistryKeys(dbPath, { dryRun: true });
    expect(preview.flagged).toBe(0);
    expect(preview.reentry.map((r) => r.reentryCommand)).toEqual([
      "cleo agent register --id agent-t12352 --name 'Key Storage Agent' --api-key <API_KEY>",
    ]);
    expect(storedValue(cleoHome).reauth).toBe(0);

    expect((await auditAgentRegistryKeys(dbPath)).flagged).toBe(1);
    expect((await auditAgentRegistryKeys(dbPath)).flagged).toBe(0);
    expect(storedValue(cleoHome)).toEqual({ value: legacy, reauth: 1 });
  });
});

describe('portable restore', () => {
  it('seals on device A, restores on device B (different machine-key), decrypts there', async () => {
    const { createProjectAgent } = await loadAccessor();
    await createProjectAgent(projectRoot, SPEC);

    const { sealCredentials, unsealCredentials } = await import('../credential-transfer.js');
    const { openAgentApiKey } = await import('../agent-api-key.js');
    const sealed = await sealCredentials(
      { globalDbPath: join(cleoHome, 'cleo.db'), cleoHome },
      'synthetic passphrase',
    );
    expect(sealed.sealedCredentials.map((c) => `${c.store}/${c.id}`)).toEqual([
      `agent-registry/${AGENT_ID}`,
    ]);

    const homeB = join(base, 'device-b');
    mkdirSync(homeB, { recursive: true });
    // Snapshot the store as a backup does (VACUUM INTO — the live file is in WAL mode).
    const live = new DatabaseSync(join(cleoHome, 'cleo.db'));
    live.exec(`VACUUM INTO '${join(homeB, 'cleo.db').replace(/'/g, "''")}'`);
    live.close();
    // The copied ciphertext is A's: B's (different) key cannot open it.
    const copied = storedValue(homeB).value;
    const before = await openAgentApiKey(copied, AGENT_ID, { cleoHome: homeB });
    expect(before.requiresReauth).toBe(true);

    const result = await unsealCredentials(sealed.sealed, 'synthetic passphrase', {
      globalDbPath: join(homeB, 'cleo.db'),
      cleoHome: homeB,
    });
    expect(result.reentry).toEqual([]);
    const after = await openAgentApiKey(storedValue(homeB).value, AGENT_ID, { cleoHome: homeB });
    expect(after).toEqual({ apiKey: REAL_KEY, kind: 'ciphertext', requiresReauth: false });
  });
});
