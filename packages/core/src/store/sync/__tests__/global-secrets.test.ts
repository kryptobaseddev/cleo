/**
 * Global credential tables on the home stream with their secrets (T12915 +
 * T13467; uid spec D4 as amended, design `t13467-global-secrets-sync-design`).
 *
 * Two devices' GLOBAL stores, each with its OWN machine key: a credential
 * written on A is sealed in `cloud sync`'s phase A, travels sealed, and is
 * re-encrypted under B's machine key before B's apply frame, so it is usable
 * on B and never appears in plaintext (or as A's ciphertext) in any segment.
 * The real capture, sealer, segments, signatures, push, pull and applier run;
 * only the server is a fake ordered stream.
 *
 * @task T13467
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { inflateRawSync } from 'node:zlib';
import type { LedgerTxn } from '@cleocode/contracts/ledger';
import { SYNC_SCHEMA_VERSION } from '@cleocode/contracts/sync-schema.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateEd25519 } from '../../../cloud/crypto.js';
import {
  prepareSecretOpens,
  prepareSecretSeals,
  secretValuesKey,
} from '../../../cloud/secret-seal.js';
import { decryptGlobal, encryptGlobal } from '../../../crypto/credentials.js';
import {
  _resetDualScopeDbCache,
  getDualScopeNativeDb,
  openDualScopeDbAtPath,
} from '../../dual-scope-db.js';
import { missingRowIdentitySchema, naturalRowUid } from '../../row-identity.js';
import { rowIdentitySpec } from '../../row-identity-registry.js';
import { finishCaptureFrame, openCaptureFrame, setCaptureEnabled } from '../capture.js';
import { setSyncFlag } from '../flags.js';
import { completeGenesis, cutGenesis, joinStream } from '../genesis.js';
import {
  type PulledStreamSegment,
  type PullStreamOptions,
  pullStream,
  type StreamCursor,
} from '../pull.js';
import { pushStream } from '../push.js';
import { activeReplica, ensureGlobalReplica } from '../replica.js';
import { ReplicaRegistry } from '../replica-registry.js';
import { type SecretSeals, sealPending } from '../sealer.js';
import { firstBadTxnSignature, signTxn } from '../txn-signing.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../../migrations/sync-journal');
const STREAM = 'home:0192ffff-7f00-7000-8000-0000000134a7';
const KEYS = { 'dev-a': generateEd25519(), 'dev-b': generateEd25519() } as const;
type Device = keyof typeof KEYS;
const SECRET = 'sk-live-T13467-do-not-leak';
let clock = Date.now();
let dir: string;
let secretKey: Buffer;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-global-secrets-'));
  mkdirSync(join(dir, 'cleo'), { recursive: true });
  vi.stubEnv('CLEO_HOME', join(dir, 'cleo'));
  vi.stubEnv('XDG_STATE_HOME', join(dir, 'state'));
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  secretKey = secretValuesKey(randomBytes(32));
});

afterEach(() => {
  _resetDualScopeDbCache();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

interface Replica {
  readonly db: DatabaseSync;
  readonly device: Device;
  /** This device's own CLEO home: its machine key encrypts its credentials. */
  readonly home: string;
}

const START: StreamCursor = { after: 0, knowsAllReplicas: true, replicas: {} };

async function open(name: string, device: Device): Promise<Replica> {
  const home = join(dir, `home-${name}`);
  mkdirSync(join(dir, name), { recursive: true });
  mkdirSync(home, { recursive: true });
  const path = join(dir, name, 'cleo.db');
  const db = getDualScopeNativeDb(await openDualScopeDbAtPath('global', path));
  setCaptureEnabled(db, 'global', true, { schemaRoot: SYNC_SCHEMA });
  for (const flag of ['sync.seal', 'sync.push', 'sync.pull'] as const) {
    setSyncFlag(db, flag, true, { schemaRoot: SYNC_SCHEMA, allowUnreleased: true });
  }
  const registry = new ReplicaRegistry(join(dir, `registry-${name}.json`), device);
  ensureGlobalReplica(db, { dbPath: path, mode: 'test', registry });
  return { db, device, home };
}

const replicaOf = (r: Replica): string => activeReplica(r.db, 'global')?.replicaId ?? '';

async function twoDevices(): Promise<{ a: Replica; b: Replica }> {
  const a = await open('a', 'dev-a');
  expect(
    cutGenesis(a.db, {
      scope: 'global',
      stream: STREAM,
      now: () => ++clock,
      env: {},
      allowUnreleased: true,
    }).refused,
  ).toBeNull();
  completeGenesis(a.db, {
    stream: STREAM,
    replica: replicaOf(a),
    replicaSeqFloor: null,
    nowIso: new Date(++clock).toISOString(),
  });
  const b = await open('b', 'dev-b');
  expect(
    joinStream(b.db, {
      scope: 'global',
      stream: STREAM,
      cursor: START,
      now: () => ++clock,
      allowUnreleased: true,
    }).refused,
  ).toBeNull();
  return { a, b };
}

function write(db: DatabaseSync, sql: string, ...params: Array<string | number | null>): void {
  db.exec('BEGIN IMMEDIATE');
  const frame = openCaptureFrame(db, 'write', null);
  db.prepare(sql).run(...params);
  finishCaptureFrame(db, frame);
  db.exec('COMMIT');
}

function fakeStream() {
  const segments: PulledStreamSegment[] = [];
  return {
    segments,
    append(plaintext: Uint8Array, replicaSeq: number, replicaId: string, deviceId: string): number {
      segments.push({
        seq: segments.length + 1,
        replicaId,
        replicaSeq,
        deviceId,
        plaintext,
        schemaVersion: SYNC_SCHEMA_VERSION,
      });
      return segments.length;
    },
    pull: async (cursor: StreamCursor) => {
      const page = segments.filter((s) => s.seq > cursor.after).slice(0, 2);
      const replicas = { ...cursor.replicas };
      for (const s of page) {
        replicas[s.replicaId] = { deviceId: s.deviceId, replicaSeq: s.replicaSeq };
      }
      return {
        segments: page,
        cursor: { after: page.at(-1)?.seq ?? cursor.after, knowsAllReplicas: true, replicas },
        head: segments.length,
      };
    },
    /** Every segment's decoded plaintext, as one string. */
    text(): string {
      return segments
        .map((s) => {
          try {
            return inflateRawSync(Buffer.from(s.plaintext)).toString('utf8');
          } catch {
            return Buffer.from(s.plaintext).toString('utf8');
          }
        })
        .join('\n');
    },
  };
}
type Stream = ReturnType<typeof fakeStream>;

/** Phase A for a device, as `cloud sync` runs it. */
const sealsOf = (r: Replica): Promise<SecretSeals> =>
  prepareSecretSeals(r.db, 'global', secretKey, { cleoHome: r.home });

async function push(r: Replica, stream: Stream, secrets?: SecretSeals) {
  const replica = replicaOf(r);
  const out = await pushStream(r.db, {
    scope: 'global',
    stream: STREAM,
    replica,
    project: null,
    sealer: (_seq, plaintext) => Buffer.from(plaintext),
    signTxn: (s, txn) => signTxn(KEYS[r.device], s, txn),
    upload: async (seg) => ({
      seq: stream.append(seg.sealed, seg.replicaSeq, replica, r.device),
      duplicate: false,
    }),
    serverOffsetMs: 0,
    serverLastReplicaSeq: null,
    now: () => ++clock,
    env: {},
    allowUnreleased: true,
    ...(secrets ? { secrets } : {}),
  });
  expect(out.refused).toBeNull();
  return out;
}

async function pull(r: Replica, stream: Stream, opts: { open?: boolean } = {}) {
  const replica = replicaOf(r);
  const secrets = await sealsOf(r);
  const o: PullStreamOptions = {
    scope: 'global',
    stream: STREAM,
    replica,
    pull: stream.pull,
    verify: (deviceId: string, txns: readonly LedgerTxn[]) =>
      deviceId in KEYS ? firstBadTxnSignature(KEYS[deviceId as Device].publicKey, STREAM, txns) : 0,
    initialCursor: START,
    now: () => ++clock,
    env: {},
    seal: () => {
      sealPending(r.db, {
        scope: 'global',
        replica,
        now: () => ++clock,
        env: {},
        allowUnreleased: true,
        secrets,
      });
    },
    ...(opts.open === false
      ? {}
      : {
          openSecrets: () =>
            prepareSecretOpens(r.db, 'global', STREAM, secretKey, { cleoHome: r.home }),
        }),
  };
  const out = await pullStream(r.db, o);
  expect(out.refused).toBeNull();
  return out;
}

async function addAccount(r: Replica, provider: string, label: string, secret: string) {
  const enc = await encryptGlobal(secret, `account:${provider}:${label}`, { cleoHome: r.home });
  write(
    r.db,
    `INSERT INTO accounts (provider, label, auth_type, secret_enc, priority, created_at, updated_at)
     VALUES (?, ?, 'api-key', ?, 1, '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z')`,
    provider,
    label,
    enc,
  );
  return enc;
}

const accountRow = (r: Replica, provider: string, label: string) =>
  r.db
    .prepare('SELECT id, uid, secret_enc, priority FROM accounts WHERE provider = ? AND label = ?')
    .get(provider, label) as
    | { id: number; uid: string | null; secret_enc: string | null; priority: number }
    | undefined;

const pendingInbox = (r: Replica): number =>
  (
    r.db
      .prepare("SELECT count(*) AS n FROM _sync_inbox WHERE status IN ('staged', 'pending')")
      .get() as { n: number }
  ).n;

describe('global credential identity (T12915 / T13467, D4 amended)', () => {
  it('declares the four tables natural on their non-secret identifiers', () => {
    expect(rowIdentitySpec('global', 'accounts')).toMatchObject({
      kind: 'natural',
      key: ['provider', 'label'],
      localKey: 'id',
    });
    expect(rowIdentitySpec('global', 'service_connections')?.key).toEqual(['provider', 'label']);
    expect(rowIdentitySpec('global', 'service_configs')?.key).toEqual(['provider']);
    expect(rowIdentitySpec('global', 'agent_service_grants')?.keyRefs?.map((r) => r.table)).toEqual(
      ['agent_registry_agents', 'service_connections'],
    );
  });

  it('two stores derive the same uid for one credential, and an old store heals', async () => {
    const { a, b } = await twoDevices();
    await addAccount(a, 'anthropic', 'work', SECRET);
    await addAccount(b, 'anthropic', 'work', 'another-secret');
    const want = naturalRowUid('global', 'accounts', ['anthropic', 'work']);
    expect(accountRow(a, 'anthropic', 'work')?.uid).toBe(want);
    expect(accountRow(b, 'anthropic', 'work')?.uid).toBe(want);
    a.db.exec('DROP INDEX IF EXISTS main."uq_accounts_uid"');
    expect(missingRowIdentitySchema(a.db, 'global')).toContain('index uq_accounts_uid');
  });

  it('captures exactly one I for a filled insert (no stray K)', async () => {
    const { a } = await twoDevices();
    await addAccount(a, 'openai', 'p', SECRET);
    const ops = a.db
      .prepare("SELECT op FROM _sync_capture WHERE tbl = 'accounts' ORDER BY seq")
      .all() as Array<{ op: string }>;
    expect(ops.map((o) => o.op)).toEqual(['I']);
  });
});

describe('global secrets travel sealed on the home stream (T13467)', () => {
  it('a credential written on A is usable on B, and never in plaintext in a segment', async () => {
    const { a, b } = await twoDevices();
    const stream = fakeStream();
    const aCipher = await addAccount(a, 'anthropic', 'work', SECRET);
    await push(a, stream, await sealsOf(a));
    expect(stream.segments.length).toBeGreaterThan(0);
    const text = stream.text();
    expect(text).toContain('accounts');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(aCipher);
    await pull(b, stream);
    const onB = accountRow(b, 'anthropic', 'work');
    expect(onB?.uid).toBe(accountRow(a, 'anthropic', 'work')?.uid);
    expect(onB?.secret_enc).not.toBeNull();
    expect(onB?.secret_enc).not.toBe(aCipher);
    expect(
      await decryptGlobal(onB?.secret_enc ?? '', 'account:anthropic:work', { cleoHome: b.home }),
    ).toBe(SECRET);
    expect(onB?.priority).toBe(1);
    expect(pendingInbox(b)).toBe(0);
  });

  it('without phase A (no master key: a logged-out device) the open-time sealer holds the row', async () => {
    const { a } = await twoDevices();
    await addAccount(a, 'anthropic', 'work', SECRET);
    const r = sealPending(a.db, {
      scope: 'global',
      replica: replicaOf(a),
      now: () => ++clock,
      env: {},
      allowUnreleased: true,
    });
    expect(r.txns).toBe(0);
    expect(r.pending[0]?.reason).toMatch(/phase A/);
    const live = a.db
      .prepare("SELECT count(*) AS n FROM _sync_capture WHERE state = 'live' AND tbl = 'accounts'")
      .get() as { n: number };
    expect(live.n).toBe(1);
  });

  it('a secret another machine encrypted never blocks the rest: it is held and named (T13532)', async () => {
    const { a, b } = await twoDevices();
    const stream = fakeStream();
    await addAccount(a, 'anthropic', 'work', SECRET);
    // A restored or copied row: its ciphertext is under B's machine key, not A's.
    const foreign = await encryptGlobal('other-secret', 'account:openai:home', {
      cleoHome: b.home,
    });
    write(
      a.db,
      `INSERT INTO accounts (provider, label, auth_type, secret_enc, priority, created_at, updated_at)
       VALUES ('openai', 'home', 'api-key', ?, 1, '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z')`,
      foreign,
    );
    const warnings: Array<{ code: string; message: string }> = [];
    const secrets = await prepareSecretSeals(a.db, 'global', secretKey, {
      cleoHome: a.home,
      warn: (w) => warnings.push(w),
    });
    const homeUid = accountRow(a, 'openai', 'home')?.uid ?? '';
    expect(warnings).toEqual([
      expect.objectContaining({
        code: 'W_SYNC_SECRET_UNREADABLE',
        message: expect.stringContaining(`credential account:openai:home (accounts ${homeUid})`),
      }),
    ]);
    const out = await push(a, stream, secrets);
    expect(out.held).toEqual([
      expect.objectContaining({ reason: expect.stringMatching(/accounts .*secret_enc/) }),
    ]);
    await pull(b, stream);
    expect(accountRow(b, 'anthropic', 'work')).toBeDefined();
    expect(accountRow(b, 'openai', 'home')).toBeUndefined();
    expect(stream.text()).not.toContain('other-secret');
  });

  it('a held credential written FIRST never stalls later changes; re-entered, it syncs (T13534)', async () => {
    const { a, b } = await twoDevices();
    const stream = fakeStream();
    // First in capture order: a row whose ciphertext only B's machine key opens.
    const foreign = await encryptGlobal('other-secret', 'account:openai:home', {
      cleoHome: b.home,
    });
    write(
      a.db,
      `INSERT INTO accounts (provider, label, auth_type, secret_enc, refresh_enc, priority, created_at, updated_at)
       VALUES ('openai', 'home', 'api-key', ?, ?, 1, '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z')`,
      foreign,
      foreign,
    );
    // Later: another account and an unrelated brain write.
    await addAccount(a, 'anthropic', 'work', SECRET);
    write(
      a.db,
      "INSERT INTO brain_observations (id, type, title, created_at, valid_at) VALUES ('O-t13534a', 'discovery', 'after the held row', '2026-10-11T00:00:01.000Z', '2026-10-11 00:00:01')",
    );
    const warnings: Array<{ code: string; message: string }> = [];
    const secrets = await prepareSecretSeals(a.db, 'global', secretKey, {
      cleoHome: a.home,
      warn: (w) => warnings.push(w),
    });
    // One warning for the row (two unreadable columns), naming the credential.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain('credential account:openai:home');
    const out = await push(a, stream, secrets);
    expect(out.held).toHaveLength(1);
    await pull(b, stream);
    expect(accountRow(b, 'anthropic', 'work')).toBeDefined();
    expect(
      b.db.prepare("SELECT title FROM brain_observations WHERE id = 'O-t13534a'").get(),
    ).toEqual({ title: 'after the held row' });
    expect(accountRow(b, 'openai', 'home')).toBeUndefined();

    // Re-entered on A under A's key: the held row is retried and syncs.
    const fresh = await encryptGlobal('re-entered', 'account:openai:home', { cleoHome: a.home });
    write(
      a.db,
      "UPDATE accounts SET secret_enc = ?, refresh_enc = NULL WHERE provider = 'openai' AND label = 'home'",
      fresh,
    );
    expect((await push(a, stream, await sealsOf(a))).held).toEqual([]);
    await pull(b, stream);
    const home = accountRow(b, 'openai', 'home');
    expect(
      await decryptGlobal(home?.secret_enc ?? '', 'account:openai:home', { cleoHome: b.home }),
    ).toBe('re-entered');
  });

  it('a later re-key of a held row waits behind it, so the receiver never sees a change before its insert (T13601)', async () => {
    const { a, b } = await twoDevices();
    const stream = fakeStream();
    const foreign = await encryptGlobal('other-secret', 'account:openai:home', {
      cleoHome: b.home,
    });
    write(
      a.db,
      `INSERT INTO accounts (provider, label, auth_type, secret_enc, priority, created_at, updated_at)
       VALUES ('openai', 'home', 'api-key', ?, 1, '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z')`,
      foreign,
    );
    // A later transaction re-keys the held row (its uid moves, as a collision
    // re-key does); netting drops that K, leaving the old uid only in `renames`.
    // A third changes the row under the new uid only.
    write(
      a.db,
      "UPDATE accounts SET uid = '0192ffff-7f00-7000-8000-00000013601a' WHERE provider = 'openai'",
    );
    write(a.db, "UPDATE accounts SET priority = 2 WHERE provider = 'openai'");
    await addAccount(a, 'anthropic', 'work', SECRET);
    const out = await push(a, stream, await sealsOf(a));
    // The insert, the re-key and the change under the new uid all wait; the
    // unrelated account seals.
    expect(out.held.map((h) => h.firstSeq)).toEqual([1, 2, 3]);
    await pull(b, stream);
    expect(accountRow(b, 'anthropic', 'work')).toBeDefined();
    expect(accountRow(b, 'openai', 'home')).toBeUndefined();
    // Nothing for the held row reached B ahead of its insert.
    expect(pendingInbox(b)).toBe(0);
  });

  it('a held row that is re-keyed, once re-entered, seals and arrives on B under its new uid (T13603)', async () => {
    const { a, b } = await twoDevices();
    const stream = fakeStream();
    const NEW_UID = '0192ffff-7f00-7000-8000-00000013603a';
    write(
      a.db,
      `INSERT INTO accounts (provider, label, auth_type, secret_enc, priority, created_at, updated_at)
       VALUES ('openai', 'home', 'api-key', ?, 1, '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z')`,
      await encryptGlobal('other-secret', 'account:openai:home', { cleoHome: b.home }),
    );
    write(a.db, `UPDATE accounts SET uid = '${NEW_UID}' WHERE provider = 'openai'`);
    write(a.db, "UPDATE accounts SET priority = 2 WHERE provider = 'openai'");
    expect((await push(a, stream, await sealsOf(a))).held.length).toBeGreaterThan(0);

    // Re-entered under A's own key: the insert, the re-key and the change all seal.
    write(
      a.db,
      "UPDATE accounts SET secret_enc = ? WHERE provider = 'openai' AND label = 'home'",
      await encryptGlobal('re-entered', 'account:openai:home', { cleoHome: a.home }),
    );
    expect((await push(a, stream, await sealsOf(a))).held).toEqual([]);
    await pull(b, stream);
    const home = accountRow(b, 'openai', 'home');
    expect(home?.uid).toBe(NEW_UID);
    expect(home?.priority).toBe(2);
    expect(
      await decryptGlobal(home?.secret_enc ?? '', 'account:openai:home', { cleoHome: b.home }),
    ).toBe('re-entered');
    expect(pendingInbox(b)).toBe(0);
    expect(stream.text()).not.toContain('re-entered');
  });

  it('a receiver that cannot open the secrets holds the op, never writes a row without them', async () => {
    const { a, b } = await twoDevices();
    const stream = fakeStream();
    await addAccount(a, 'anthropic', 'work', SECRET);
    await push(a, stream, await sealsOf(a));
    await pull(b, stream, { open: false });
    expect(accountRow(b, 'anthropic', 'work')).toBeUndefined();
    expect(pendingInbox(b)).toBeGreaterThan(0);
  });

  it("a grant on B points at B's own local connection id", async () => {
    const { a, b } = await twoDevices();
    const stream = fakeStream();
    // B already holds another connection, so the ids differ between devices.
    write(
      b.db,
      `INSERT INTO service_connections (provider, label, status, connected_at, updated_at)
       VALUES ('google', 'other', 'active', '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z')`,
    );
    write(
      a.db,
      `INSERT INTO agent_registry_agents (id, agent_id, name, created_at, updated_at)
       VALUES ('agent-local-a', 'cleo-dev', 'cleo-dev', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`,
    );
    const cred = await encryptGlobal('{"access_token":"tok"}', 'service:github:personal', {
      cleoHome: a.home,
    });
    write(
      a.db,
      `INSERT INTO service_connections (provider, label, status, credentials_enc, connected_at, updated_at)
       VALUES ('github', 'personal', 'active', ?, '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z')`,
      cred,
    );
    const connA = (
      a.db.prepare("SELECT id FROM service_connections WHERE provider = 'github'").get() as {
        id: number;
      }
    ).id;
    write(
      a.db,
      `INSERT INTO agent_service_grants (agent_id, service_connection_id, created_at, updated_at)
       VALUES ('agent-local-a', ?, '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z')`,
      connA,
    );
    await push(a, stream, await sealsOf(a));
    await pull(b, stream);
    const connB = b.db
      .prepare("SELECT id, credentials_enc FROM service_connections WHERE provider = 'github'")
      .get() as { id: number; credentials_enc: string };
    expect(connB.id).not.toBe(connA);
    const grant = b.db
      .prepare('SELECT agent_id, service_connection_id FROM agent_service_grants')
      .get() as { agent_id: string; service_connection_id: number };
    const agentB = b.db
      .prepare("SELECT id FROM agent_registry_agents WHERE agent_id = 'cleo-dev'")
      .get() as { id: string };
    expect(agentB.id).not.toBe('agent-local-a');
    expect(grant).toEqual({ agent_id: agentB.id, service_connection_id: connB.id });
    expect(
      await decryptGlobal(connB.credentials_enc, 'service:github:personal', { cleoHome: b.home }),
    ).toBe('{"access_token":"tok"}');
  });

  it('the same credential on two devices converges to one row', async () => {
    const { a, b } = await twoDevices();
    const stream = fakeStream();
    await addAccount(a, 'anthropic', 'work', 'secret-from-a');
    await addAccount(b, 'anthropic', 'work', 'secret-from-b');
    await push(a, stream, await sealsOf(a));
    await push(b, stream, await sealsOf(b));
    await pull(a, stream);
    await pull(b, stream);
    const rows = (r: Replica) =>
      r.db.prepare("SELECT uid FROM accounts WHERE provider = 'anthropic'").all() as unknown[];
    expect(rows(a)).toHaveLength(1);
    expect(rows(b)).toHaveLength(1);
    const plain = async (r: Replica) =>
      decryptGlobal(
        accountRow(r, 'anthropic', 'work')?.secret_enc ?? '',
        'account:anthropic:work',
        {
          cleoHome: r.home,
        },
      );
    expect(await plain(a)).toBe(await plain(b));
  });

  it("an agent's API key never travels (per-machine credentials stay home)", async () => {
    const { a, b } = await twoDevices();
    const stream = fakeStream();
    write(
      a.db,
      `INSERT INTO agent_registry_agents (id, agent_id, name, api_key_encrypted, created_at, updated_at)
       VALUES ('agent-a', 'cleo-dev', 'cleo-dev', 'machine-bound-key-ciphertext', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`,
    );
    await push(a, stream, await sealsOf(a));
    expect(stream.text()).not.toContain('machine-bound-key-ciphertext');
    await pull(b, stream);
    const agent = b.db
      .prepare("SELECT api_key_encrypted FROM agent_registry_agents WHERE agent_id = 'cleo-dev'")
      .get() as { api_key_encrypted: string | null } | undefined;
    expect(agent).toBeDefined();
    expect(agent?.api_key_encrypted ?? null).toBeNull();
  });
});
