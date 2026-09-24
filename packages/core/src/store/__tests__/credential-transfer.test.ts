/**
 * Portable credentials (T12326).
 *
 * Proves, against real files in throwaway CLEO homes with SYNTHETIC secrets:
 *   1. A project credential survives moving the project directory
 *      (project-identity KDF), and legacy path-bound ciphertexts migrate
 *      without loss — or stay untouched and are reported when unopenable.
 *   2. Credentials sealed with a passphrase on device A restore on device B
 *      (a different machine-key) and decrypt there.
 *   3. A wrong passphrase fails with a clear error and writes nothing.
 *   4. Unencrypted bundles: staged ciphertexts are blanked and every
 *      credential is listed with its re-entry command; live stores are refused.
 *   5. The sealed payload never contains machine-key material.
 *
 * Each "device" is a separate CLEO_HOME under os.tmpdir(); the vitest setup
 * already pins HOME/XDG/CLEO_HOME to a sandbox, and this suite asserts it
 * never leaves os.tmpdir().
 *
 * @task T12326
 */

import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decryptGlobal,
  decryptProjectSecret,
  encryptGlobal,
  encryptProjectSecret,
  getMachineKeyPath,
} from '../../crypto/credentials.js';
import {
  addCredential,
  credentialsStorePath,
  listCredentials,
} from '../../llm/credentials-store.js';
import { decryptBundle } from '../backup-crypto.js';
import {
  CredentialTransferError,
  listCredentialsForReentry,
  migrateProjectCredentials,
  redactCredentialCiphertexts,
  sealCredentials,
  unsealCredentials,
} from '../credential-transfer.js';
import { __clearGlobalSaltCache } from '../global-salt.js';

const _require = createRequire(import.meta.url);
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => _DatabaseSyncType;
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROJECT_ID = 'c7d1a1f0-0000-4000-8000-000000012326';
const AGENT_SECRET = 'sk_live_SYNTHETIC_agent_key_0001';
const SERVICE_TOKENS = JSON.stringify({ accessToken: 'gho_SYNTHETIC_0002' });
const LLM_SECRET = 'sk-ant-api03-SYNTHETIC-0003';
const PASSPHRASE = 'correct horse battery staple';

let sandbox: string;
const savedCleoHome = process.env['CLEO_HOME'];

/** Point every CLEO-home reader at `home` (a fresh "device"). */
function useDevice(home: string): void {
  fs.mkdirSync(home, { recursive: true });
  process.env['CLEO_HOME'] = home;
  __clearGlobalSaltCache();
}

/** Create a project `cleo.db` with the credentials table and one row. */
function makeProjectDb(dbPath: string, ciphertext: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(
    `CREATE TABLE tasks_agent_credentials (
       agent_id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
       api_key_encrypted TEXT NOT NULL, api_base_url TEXT NOT NULL DEFAULT '')`,
  );
  db.prepare(
    'INSERT INTO tasks_agent_credentials (agent_id, display_name, api_key_encrypted) VALUES (?, ?, ?)',
  ).run('agent-alpha', 'Agent Alpha', ciphertext);
  db.close();
}

/** Create a global `cleo.db` with one service connection. */
function makeGlobalDb(dbPath: string, ciphertext: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(
    'CREATE TABLE service_connections (id INTEGER PRIMARY KEY, provider TEXT NOT NULL, label TEXT NOT NULL, credentials_enc TEXT)',
  );
  db.prepare(
    'INSERT INTO service_connections (provider, label, credentials_enc) VALUES (?, ?, ?)',
  ).run('github', 'personal', ciphertext);
  db.close();
}

/** Read one scalar cell. */
function cell(dbPath: string, sql: string): string | null {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare(sql).get() as Record<string, string | null> | undefined;
    return row === undefined ? null : (Object.values(row)[0] ?? null);
  } finally {
    db.close();
  }
}

/** Produce a ciphertext exactly as the pre-T12326 path-bound KDF wrote it. */
function legacyPathCiphertext(plaintext: string, projectPath: string): string {
  const machineKey = fs.readFileSync(getMachineKeyPath());
  const key = createHmac('sha256', machineKey).update(projectPath).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([0x01]), iv, body, cipher.getAuthTag()]).toString('base64');
}

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cleo-t12326-'));
  useDevice(path.join(sandbox, 'device-a'));
});

afterEach(() => {
  if (savedCleoHome === undefined) delete process.env['CLEO_HOME'];
  else process.env['CLEO_HOME'] = savedCleoHome;
  __clearGlobalSaltCache();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Isolation guard
// ---------------------------------------------------------------------------

describe('isolation', () => {
  it('keeps the machine key inside the throwaway device home', () => {
    const keyPath = getMachineKeyPath();
    expect(
      keyPath.startsWith(fs.realpathSync(os.tmpdir())) || keyPath.startsWith(os.tmpdir()),
    ).toBe(true);
    expect(keyPath).toBe(path.join(sandbox, 'device-a', 'machine-key'));
  });
});

// ---------------------------------------------------------------------------
// 1. Moving a project keeps its credentials
// ---------------------------------------------------------------------------

describe('project KDF is keyed by project identity, not path', () => {
  it('decrypts a project credential after the project directory moves', async () => {
    const oldRoot = path.join(sandbox, 'projects', 'before');
    const newRoot = path.join(sandbox, 'elsewhere', 'after-rename');
    const dbRel = path.join('.cleo', 'cleo.db');
    makeProjectDb(path.join(oldRoot, dbRel), await encryptProjectSecret(AGENT_SECRET, PROJECT_ID));

    fs.mkdirSync(path.dirname(newRoot), { recursive: true });
    fs.renameSync(oldRoot, newRoot);

    const stored = cell(
      path.join(newRoot, dbRel),
      'SELECT api_key_encrypted FROM tasks_agent_credentials',
    );
    expect(stored).not.toBeNull();
    const result = await decryptProjectSecret(stored ?? '', { projectId: PROJECT_ID });
    expect(result).toEqual({ plaintext: AGENT_SECRET, kdf: 'project-id', rewrapped: null });
  });

  it('migrates a legacy path-bound ciphertext, after which a move no longer matters', async () => {
    const oldRoot = path.join(sandbox, 'projects', 'legacy');
    const dbPath = path.join(oldRoot, '.cleo', 'cleo.db');
    await encryptProjectSecret('warm-up', PROJECT_ID); // materialize the machine key
    const legacy = legacyPathCiphertext(AGENT_SECRET, oldRoot);
    makeProjectDb(dbPath, legacy);

    const first = await migrateProjectCredentials({
      projectDbPath: dbPath,
      projectId: PROJECT_ID,
      legacyProjectPaths: [oldRoot],
    });
    expect(first.migrated.map((d) => d.id)).toEqual(['agent-alpha']);
    expect(first.reentry).toEqual([]);

    // Idempotent: nothing left to migrate.
    const second = await migrateProjectCredentials({
      projectDbPath: dbPath,
      projectId: PROJECT_ID,
      legacyProjectPaths: [oldRoot],
    });
    expect(second.migrated).toEqual([]);
    expect(second.current.map((d) => d.id)).toEqual(['agent-alpha']);

    const newRoot = path.join(sandbox, 'moved-legacy');
    fs.renameSync(oldRoot, newRoot);
    const stored = cell(
      path.join(newRoot, '.cleo', 'cleo.db'),
      'SELECT api_key_encrypted FROM tasks_agent_credentials',
    );
    const result = await decryptProjectSecret(stored ?? '', { projectId: PROJECT_ID });
    expect(result.plaintext).toBe(AGENT_SECRET);
    expect(result.kdf).toBe('project-id');
  });

  it('returns a re-wrapped ciphertext when a legacy one is opened directly', async () => {
    const root = path.join(sandbox, 'projects', 'direct');
    await encryptProjectSecret('warm-up', PROJECT_ID);
    const result = await decryptProjectSecret(legacyPathCiphertext(AGENT_SECRET, root), {
      projectId: PROJECT_ID,
      legacyProjectPaths: ['/nowhere', root],
    });
    expect(result.kdf).toBe('legacy-path');
    expect(result.rewrapped).not.toBeNull();
    const reopened = await decryptProjectSecret(result.rewrapped ?? '', { projectId: PROJECT_ID });
    expect(reopened.plaintext).toBe(AGENT_SECRET);
  });

  it('leaves an unopenable legacy ciphertext untouched and names the credential to re-enter', async () => {
    const oldRoot = path.join(sandbox, 'projects', 'lost');
    const dbPath = path.join(sandbox, 'moved-before-migration', '.cleo', 'cleo.db');
    await encryptProjectSecret('warm-up', PROJECT_ID);
    const legacy = legacyPathCiphertext(AGENT_SECRET, oldRoot);
    makeProjectDb(dbPath, legacy);

    const result = await migrateProjectCredentials({
      projectDbPath: dbPath,
      projectId: PROJECT_ID,
      legacyProjectPaths: [path.dirname(path.dirname(dbPath))],
    });
    expect(result.migrated).toEqual([]);
    expect(result.reentry).toHaveLength(1);
    expect(result.reentry[0]?.id).toBe('agent-alpha');
    expect(result.reentry[0]?.reentryCommand).toBe(
      "cleo agent register --id agent-alpha --name 'Agent Alpha' --api-key <API_KEY>",
    );
    expect(cell(dbPath, 'SELECT api_key_encrypted FROM tasks_agent_credentials')).toBe(legacy);
  });
});

// ---------------------------------------------------------------------------
// 2 + 3 + 5. Passphrase-sealed transfer between devices
// ---------------------------------------------------------------------------

describe('sealed transfer between devices', () => {
  /** Build device A's stores; returns their paths. */
  async function seedDeviceA(): Promise<{ projectDb: string; globalDb: string; llm: string }> {
    const projectDb = path.join(sandbox, 'a-project', '.cleo', 'cleo.db');
    const globalDb = path.join(sandbox, 'device-a', 'cleo.db');
    makeProjectDb(projectDb, await encryptProjectSecret(AGENT_SECRET, PROJECT_ID));
    makeGlobalDb(globalDb, await encryptGlobal(SERVICE_TOKENS, 'service:github:personal'));
    await addCredential({
      provider: 'anthropic',
      label: 'work',
      authType: 'api_key',
      accessToken: LLM_SECRET,
    });
    return { projectDb, globalDb, llm: credentialsStorePath() };
  }

  /** "Restore" the database files onto device B (bytes copied as a bundle would). */
  function restoreFilesOntoB(a: { projectDb: string; globalDb: string }): {
    projectDb: string;
    globalDb: string;
  } {
    const projectDb = path.join(sandbox, 'b-project', '.cleo', 'cleo.db');
    const globalDb = path.join(sandbox, 'device-b', 'cleo.db');
    fs.mkdirSync(path.dirname(projectDb), { recursive: true });
    fs.mkdirSync(path.dirname(globalDb), { recursive: true });
    fs.copyFileSync(a.projectDb, projectDb);
    fs.copyFileSync(a.globalDb, globalDb);
    return { projectDb, globalDb };
  }

  it('restores every credential under a different machine-key', async () => {
    const a = await seedDeviceA();
    const machineKeyA = fs.readFileSync(getMachineKeyPath());
    const sealed = await sealCredentials(
      {
        projectDbPath: a.projectDb,
        projectId: PROJECT_ID,
        globalDbPath: a.globalDb,
        llmStorePath: a.llm,
      },
      PASSPHRASE,
    );
    expect(sealed.sealedCredentials.map((d) => `${d.store}/${d.id}`).sort()).toEqual([
      'llm-pool/anthropic:work',
      'project-agent/agent-alpha',
      'service-connection/github:personal',
    ]);
    expect(sealed.reentry).toEqual([]);

    // AC3/§5: neither the sealed bytes nor the opened payload carry the machine key.
    const opened = decryptBundle(Buffer.from(sealed.sealed), PASSPHRASE);
    for (const haystack of [Buffer.from(sealed.sealed), opened]) {
      expect(haystack.includes(machineKeyA)).toBe(false);
      expect(haystack.includes(Buffer.from(machineKeyA.toString('hex')))).toBe(false);
      expect(haystack.includes(Buffer.from(machineKeyA.toString('base64')))).toBe(false);
    }

    // Device B: fresh home, new machine key.
    const b = restoreFilesOntoB(a);
    useDevice(path.join(sandbox, 'device-b'));
    await encryptProjectSecret('warm-up', PROJECT_ID);
    expect(fs.readFileSync(getMachineKeyPath()).equals(machineKeyA)).toBe(false);

    // The copied ciphertexts are useless on B — this is what the seal fixes.
    const copiedProject = cell(
      b.projectDb,
      'SELECT api_key_encrypted FROM tasks_agent_credentials',
    );
    await expect(
      decryptProjectSecret(copiedProject ?? '', { projectId: PROJECT_ID }),
    ).rejects.toThrow(/machine key differs/);

    const result = await unsealCredentials(sealed.sealed, PASSPHRASE, {
      projectDbPath: b.projectDb,
      projectId: PROJECT_ID,
      globalDbPath: b.globalDb,
    });
    expect(result.reentry).toEqual([]);
    expect(result.restored).toHaveLength(3);

    const projectCt = cell(b.projectDb, 'SELECT api_key_encrypted FROM tasks_agent_credentials');
    expect((await decryptProjectSecret(projectCt ?? '', { projectId: PROJECT_ID })).plaintext).toBe(
      AGENT_SECRET,
    );
    const serviceCt = cell(b.globalDb, 'SELECT credentials_enc FROM service_connections');
    expect(await decryptGlobal(serviceCt ?? '', 'service:github:personal')).toBe(SERVICE_TOKENS);
    const pool = await listCredentials('anthropic');
    expect(pool.map((c) => [c.label, c.accessToken])).toEqual([['work', LLM_SECRET]]);
    expect(credentialsStorePath().startsWith(path.join(sandbox, 'device-b'))).toBe(true);
  });

  it('rejects a wrong passphrase with a clear error and writes nothing', async () => {
    const a = await seedDeviceA();
    const sealed = await sealCredentials(
      {
        projectDbPath: a.projectDb,
        projectId: PROJECT_ID,
        globalDbPath: a.globalDb,
        llmStorePath: a.llm,
      },
      PASSPHRASE,
    );
    const b = restoreFilesOntoB(a);
    useDevice(path.join(sandbox, 'device-b'));
    const before = [fs.readFileSync(b.projectDb), fs.readFileSync(b.globalDb)];

    const attempt = unsealCredentials(sealed.sealed, 'not the passphrase', {
      projectDbPath: b.projectDb,
      projectId: PROJECT_ID,
      globalDbPath: b.globalDb,
    });
    await expect(attempt).rejects.toBeInstanceOf(CredentialTransferError);
    await expect(attempt).rejects.toMatchObject({
      code: 'E_CREDENTIAL_PASSPHRASE',
      message: expect.stringMatching(/wrong passphrase.*Nothing was written/),
    });

    expect(fs.readFileSync(b.projectDb).equals(before[0] ?? Buffer.alloc(0))).toBe(true);
    expect(fs.readFileSync(b.globalDb).equals(before[1] ?? Buffer.alloc(0))).toBe(true);
    expect(fs.existsSync(credentialsStorePath())).toBe(false);
    expect(fs.existsSync(getMachineKeyPath())).toBe(false);
  });

  it('reports credentials the exporting device could not decrypt, on both ends', async () => {
    const projectDb = path.join(sandbox, 'a-project', '.cleo', 'cleo.db');
    await encryptProjectSecret('warm-up', PROJECT_ID);
    makeProjectDb(projectDb, legacyPathCiphertext(AGENT_SECRET, '/a/path/nobody/knows'));
    const sealed = await sealCredentials(
      { projectDbPath: projectDb, projectId: PROJECT_ID },
      PASSPHRASE,
    );
    expect(sealed.sealedCredentials).toEqual([]);
    expect(sealed.reentry.map((r) => r.id)).toEqual(['agent-alpha']);

    const result = await unsealCredentials(sealed.sealed, PASSPHRASE, {});
    expect(result.restored).toEqual([]);
    expect(result.reentry.map((r) => r.reentryCommand)).toEqual([
      "cleo agent register --id agent-alpha --name 'Agent Alpha' --api-key <API_KEY>",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 4. Unencrypted bundles: redact + list
// ---------------------------------------------------------------------------

describe('unencrypted bundles carry no credentials', () => {
  it('blanks staged ciphertexts and lists each credential with its command', async () => {
    const staging = path.join(sandbox, 'staging', 'databases');
    const projectDb = path.join(staging, 'project-cleo.db');
    const globalDb = path.join(staging, 'global-cleo.db');
    makeProjectDb(projectDb, await encryptProjectSecret(AGENT_SECRET, PROJECT_ID));
    makeGlobalDb(globalDb, await encryptGlobal(SERVICE_TOKENS, 'service:github:personal'));
    await addCredential({
      provider: 'anthropic',
      label: 'work',
      authType: 'api_key',
      accessToken: LLM_SECRET,
    });

    const listed = redactCredentialCiphertexts({
      projectDbPath: projectDb,
      globalDbPath: globalDb,
      llmStorePath: credentialsStorePath(),
    });
    expect(listed.map((r) => r.reentryCommand)).toEqual([
      "cleo agent register --id agent-alpha --name 'Agent Alpha' --api-key <API_KEY>",
      'cleo service connect github --label personal --token <TOKEN>',
      `printf '%s' "$API_KEY" | cleo llm add anthropic --label work --api-key-stdin`,
    ]);
    expect(cell(projectDb, 'SELECT api_key_encrypted FROM tasks_agent_credentials')).toBe('');
    expect(cell(globalDb, 'SELECT credentials_enc FROM service_connections')).toBeNull();
    // Non-secret columns survive.
    expect(cell(projectDb, 'SELECT display_name FROM tasks_agent_credentials')).toBe('Agent Alpha');
    // After redaction nothing is left to list from the DB stores.
    expect(listCredentialsForReentry({ projectDbPath: projectDb, globalDbPath: globalDb })).toEqual(
      [],
    );
  });

  it('refuses to redact a live store', async () => {
    const liveProjectDb = path.join(sandbox, 'live', '.cleo', 'cleo.db');
    makeProjectDb(liveProjectDb, await encryptProjectSecret(AGENT_SECRET, PROJECT_ID));
    const liveGlobalDb = path.join(sandbox, 'device-a', 'cleo.db');
    makeGlobalDb(liveGlobalDb, await encryptGlobal(SERVICE_TOKENS, 'service:github:personal'));

    expect(() => redactCredentialCiphertexts({ projectDbPath: liveProjectDb })).toThrow(
      CredentialTransferError,
    );
    expect(() => redactCredentialCiphertexts({ globalDbPath: liveGlobalDb })).toThrow(/live store/);
    expect(cell(liveProjectDb, 'SELECT api_key_encrypted FROM tasks_agent_credentials')).not.toBe(
      '',
    );
  });
});
