/**
 * Portable bundle ⇄ credentials (T12326, on top of the T12318 bundle v2).
 *
 * Device A and device B are two throwaway CLEO homes, each with its OWN
 * machine-key; the project moves to a different path on B. Proves:
 *   1. An encrypted export on A → import on B leaves the service connection and
 *      the project agent credential decryptable on B, under B's key.
 *   2. The machine-key never enters the bundle, and B's key is not replaced.
 *   3. A wrong passphrase fails the import and places nothing.
 *   4. An unencrypted export lists each credential with its re-entry command.
 *   5. The migration trigger (`migrateProjectCredentialsAtRoot`) previews,
 *      applies, and is idempotent.
 *
 * Homes are passed explicitly; every path is under os.tmpdir(); all secrets
 * are synthetic.
 *
 * @task T12326
 */

import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import { list as tarList } from 'tar';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decryptGlobal,
  decryptProjectSecret,
  encryptGlobal,
  encryptProjectSecret,
  getMachineKeyPath,
} from '../../crypto/credentials.js';
import { generateProjectHash } from '../../nexus/hash.js';
import { migrateProjectCredentialsAtRoot } from '../credential-transfer.js';
import { exportPortableBundle } from '../portable-bundle.js';
import { importPortableBundle } from '../portable-bundle-import.js';

const _require = createRequire(import.meta.url);
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => _DatabaseSyncType;
};

const PROJECT_ID = 'b1f2c3d4-0000-4000-8000-000000012326';
const AGENT_SECRET = 'sk_live_SYNTHETIC_bundle_agent_0001';
const SERVICE_TOKENS = JSON.stringify({ accessToken: 'gho_SYNTHETIC_bundle_0002' });
const SERVICE_ID = 'service:github:personal';
const PASSPHRASE = 'bundle passphrase for a synthetic test';

let tmp: string;
let homeA: string;
let homeB: string;
let projectRoot: string;
let movedRoot: string;

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

/** Device A: a project with one agent credential, a home with one service connection. */
async function seedDeviceA(): Promise<void> {
  const cleo = path.join(projectRoot, '.cleo');
  fs.mkdirSync(cleo, { recursive: true });
  fs.writeFileSync(
    path.join(cleo, 'project-info.json'),
    JSON.stringify({
      projectId: PROJECT_ID,
      projectHash: generateProjectHash(projectRoot),
      name: 'demo',
    }),
  );
  const project = new DatabaseSync(path.join(cleo, 'cleo.db'));
  project.exec(`CREATE TABLE tasks_agent_credentials (
      agent_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, api_key_encrypted TEXT NOT NULL);
    CREATE TABLE tasks_tasks (id TEXT PRIMARY KEY, title TEXT);
    INSERT INTO tasks_tasks VALUES ('T1', 'one');`);
  project
    .prepare('INSERT INTO tasks_agent_credentials VALUES (?, ?, ?)')
    .run(
      'agent-alpha',
      'Agent Alpha',
      await encryptProjectSecret(AGENT_SECRET, PROJECT_ID, { cleoHome: homeA }),
    );
  project.close();

  const global = new DatabaseSync(path.join(homeA, 'cleo.db'));
  global.exec(`CREATE TABLE nexus_project_registry (
      project_id TEXT PRIMARY KEY, project_hash TEXT NOT NULL, project_path TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL, last_seen TEXT, brain_db_path TEXT, tasks_db_path TEXT);
    CREATE TABLE service_connections (
      id INTEGER PRIMARY KEY, provider TEXT NOT NULL, label TEXT NOT NULL, credentials_enc TEXT);`);
  global
    .prepare('INSERT INTO nexus_project_registry VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(PROJECT_ID, generateProjectHash(projectRoot), projectRoot, 'demo', 'x', null, null);
  global
    .prepare('INSERT INTO service_connections (provider, label, credentials_enc) VALUES (?, ?, ?)')
    .run(
      'github',
      'personal',
      await encryptGlobal(SERVICE_TOKENS, SERVICE_ID, { cleoHome: homeA }),
    );
  global.close();
}

/** Export from device A. */
async function exportFromA(encrypt: boolean): Promise<string> {
  const bundle = path.join(
    tmp,
    'out',
    encrypt ? 'enc.cleobundle.tar.gz' : 'plain.cleobundle.tar.gz',
  );
  await exportPortableBundle({
    scope: 'all',
    projectRoot,
    outputPath: bundle,
    label: 'credentials',
    cleoHome: homeA,
    configHome: path.join(tmp, 'config-a'),
    ...(encrypt ? { encrypt: true, passphrase: PASSPHRASE } : {}),
  });
  return bundle;
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cleo-t12326-bundle-'));
  homeA = path.join(tmp, 'device-a', 'cleo-home');
  homeB = path.join(tmp, 'device-b', 'cleo-home');
  projectRoot = path.join(tmp, 'device-a', 'code', 'demo');
  movedRoot = path.join(tmp, 'device-b', 'work', 'renamed-demo');
  fs.mkdirSync(homeA, { recursive: true });
  fs.mkdirSync(homeB, { recursive: true });
  await seedDeviceA();
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('encrypted bundle carries credentials, never the machine-key', () => {
  it('restores the service connection and the agent credential on a device with a different key', async () => {
    const bundle = await exportFromA(true);

    // Device B already has its own machine-key.
    await encryptProjectSecret('warm-up', 'device-b-self', { cleoHome: homeB });
    const keyA = fs.readFileSync(getMachineKeyPath(homeA));
    const keyB = fs.readFileSync(getMachineKeyPath(homeB));
    expect(keyB.equals(keyA)).toBe(false);

    const result = await importPortableBundle({
      bundlePath: bundle,
      passphrase: PASSPHRASE,
      target: movedRoot,
      cleoHome: homeB,
      configHome: path.join(tmp, 'config-b'),
    });

    expect(result.credentials?.reentry).toEqual([]);
    expect(result.credentials?.restored.map((c) => `${c.store}/${c.id}`).sort()).toEqual([
      'project-agent/agent-alpha',
      'service-connection/github:personal',
    ]);

    // B's machine-key was not replaced by anything from the bundle.
    expect(fs.readFileSync(getMachineKeyPath(homeB)).equals(keyB)).toBe(true);

    // Both credentials decrypt on B, at the NEW project path, under B's key.
    const agentCt = cell(
      path.join(movedRoot, '.cleo', 'cleo.db'),
      'SELECT api_key_encrypted FROM tasks_agent_credentials',
    );
    const agent = await decryptProjectSecret(agentCt ?? '', {
      projectId: PROJECT_ID,
      cleoHome: homeB,
    });
    expect(agent.plaintext).toBe(AGENT_SECRET);
    const serviceCt = cell(
      path.join(homeB, 'cleo.db'),
      'SELECT credentials_enc FROM service_connections',
    );
    expect(await decryptGlobal(serviceCt ?? '', SERVICE_ID, { cleoHome: homeB })).toBe(
      SERVICE_TOKENS,
    );

    // Control: the restored ciphertexts are B's, not A's — A's key no longer opens them.
    await expect(
      decryptProjectSecret(agentCt ?? '', { projectId: PROJECT_ID, cleoHome: homeA }),
    ).rejects.toThrow(/machine key differs/);
  });

  it('never puts machine-key in the archive and carries the sealed payloads instead', async () => {
    const bundle = await exportFromA(true);
    const extract = path.join(tmp, 'peek');
    fs.mkdirSync(extract);
    // Read the archive exactly as the importer sees it: through its own decryptor.
    const { decryptFileStream } = await import('../backup-crypto.js');
    const tarPath = path.join(extract, 'bundle.tar.gz');
    await decryptFileStream(bundle, tarPath, PASSPHRASE);
    const entries: string[] = [];
    await tarList({ file: tarPath, onReadEntry: (e) => entries.push(e.path) });

    expect(entries.filter((e) => path.basename(e) === 'machine-key')).toEqual([]);
    expect(entries).toContain('secrets/global-home.sealed');
    expect(entries).toContain('secrets/project-000.sealed');

    const keyA = fs.readFileSync(getMachineKeyPath(homeA));
    const tarBytes = fs.readFileSync(tarPath);
    // The tar is gzip-compressed, so also check the raw bundle bytes; the
    // sealed payloads themselves are checked for key material in
    // credential-transfer.test.ts.
    expect(tarBytes.includes(keyA)).toBe(false);
    expect(fs.readFileSync(bundle).includes(keyA)).toBe(false);
  });

  it('a wrong passphrase fails the import and places nothing', async () => {
    const bundle = await exportFromA(true);
    await expect(
      importPortableBundle({
        bundlePath: bundle,
        passphrase: 'wrong passphrase',
        target: movedRoot,
        cleoHome: homeB,
        configHome: path.join(tmp, 'config-b'),
      }),
    ).rejects.toMatchObject({ code: 'E_BUNDLE_DECRYPT' });
    expect(fs.existsSync(path.join(movedRoot, '.cleo'))).toBe(false);
    expect(fs.existsSync(path.join(homeB, 'cleo.db'))).toBe(false);
    expect(fs.existsSync(getMachineKeyPath(homeB))).toBe(false);
  });
});

describe('unencrypted bundle', () => {
  it('lists every credential with the command that re-enters it', async () => {
    const bundle = await exportFromA(false);
    const result = await importPortableBundle({
      bundlePath: bundle,
      target: movedRoot,
      cleoHome: homeB,
      configHome: path.join(tmp, 'config-b'),
    });
    expect(result.credentials).toBeUndefined();
    const commands = result.requiresReentry.flatMap((r) =>
      (r.credentials ?? []).map((c) => c.reentryCommand),
    );
    expect(commands.sort()).toEqual([
      "cleo agent register --id agent-alpha --name 'Agent Alpha' --api-key <API_KEY>",
      'cleo service connect github --label personal --token <TOKEN>',
    ]);
    expect(
      cell(
        path.join(movedRoot, '.cleo', 'cleo.db'),
        'SELECT api_key_encrypted FROM tasks_agent_credentials',
      ),
    ).toBe('');
    expect(
      cell(path.join(homeB, 'cleo.db'), 'SELECT credentials_enc FROM service_connections'),
    ).toBeNull();
  });
});

describe('migration trigger (cleo upgrade / cleo doctor credentials)', () => {
  /** A ciphertext exactly as the pre-T12326 path-bound KDF wrote it. */
  function legacyCiphertext(plaintext: string, projectPath: string): string {
    const key = createHmac('sha256', fs.readFileSync(getMachineKeyPath(homeA)))
      .update(projectPath)
      .digest();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([Buffer.from([0x01]), iv, body, cipher.getAuthTag()]).toString('base64');
  }

  it('previews, applies, then reports everything current', async () => {
    const dbPath = path.join(projectRoot, '.cleo', 'cleo.db');
    const legacy = legacyCiphertext(AGENT_SECRET, projectRoot);
    const db = new DatabaseSync(dbPath);
    db.prepare('UPDATE tasks_agent_credentials SET api_key_encrypted = ?').run(legacy);
    db.close();

    const preview = await migrateProjectCredentialsAtRoot(projectRoot, {
      dryRun: true,
      cleoHome: homeA,
    });
    expect(preview.projectId).toBe(PROJECT_ID);
    expect(preview.migrated.map((d) => d.id)).toEqual(['agent-alpha']);
    expect(cell(dbPath, 'SELECT api_key_encrypted FROM tasks_agent_credentials')).toBe(legacy);

    const applied = await migrateProjectCredentialsAtRoot(projectRoot, { cleoHome: homeA });
    expect(applied.migrated.map((d) => d.id)).toEqual(['agent-alpha']);
    expect(cell(dbPath, 'SELECT api_key_encrypted FROM tasks_agent_credentials')).not.toBe(legacy);

    const again = await migrateProjectCredentialsAtRoot(projectRoot, { cleoHome: homeA });
    expect(again.migrated).toEqual([]);
    expect(again.current.map((d) => d.id)).toEqual(['agent-alpha']);
    expect(again.reentry).toEqual([]);
  });
});
