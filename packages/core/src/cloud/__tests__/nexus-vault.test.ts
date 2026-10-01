/**
 * The cloud vault (`cleo cloud push | pull | restore | verify | lease`) and
 * `cleo cloud activity` against an in-process fake Cleo Nexus API: two
 * simulated devices (separate CLEO homes, device stores and project copies)
 * share one fake server's state. The fake follows the cleo-nexus route
 * semantics the vault relies on: replicaSeq continuity (E_CONFLICT), lineage
 * (E_LINEAGE), the count-regression rule (E_REGRESSION via checkManifest),
 * the replica map check, blob presign/upload/complete, writer leases
 * (E_LEASE_HELD, forced takes labelled as forks) and key escrow.
 *
 * No request leaves the process; every store lives in a temp directory.
 *
 * @task T12336
 * @task T12337
 * @task T12338
 * @task T12951
 * @epic T12322
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import type {
  Checkpoint,
  DeviceCertificateRecord,
  Manifest,
  ReplicaHeads,
  Segment,
  TableDeltas,
} from '@cleocode/contracts/cloud';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetDualScopeDbCache, openDualScopeDb } from '../../store/dual-scope-db.js';
import { exportPortableBundle } from '../../store/portable-bundle.js';
import {
  generateEd25519,
  generateX25519,
  type KeyPair,
  sealTo,
  sha256Hex,
  uuidv7,
} from '../crypto.js';
import { type FetchLike, Http } from '../http.js';
import { cursorFromCheckpoint, Journal } from '../journal.js';
import { masterKeyVerifier, unwrapProjectKey } from '../keys.js';
import { checkManifest, sumDeltas } from '../manifest-check.js';
import { NexusAccountError } from '../nexus-auth.js';
import { nexusCloudActivity } from '../nexus-cloud-activity.js';
import { FileNexusTokenStore } from '../nexus-credentials.js';
import {
  applyEnrolment,
  NEXUS_DEVICE_ENV,
  NexusDeviceEnrolment,
  NexusDeviceStore,
} from '../nexus-device.js';
import {
  nexusVaultStatus,
  pushNexusVault,
  releaseNexusVaultLease,
  restoreNexusVault,
  verifyNexusVault,
} from '../nexus-vault.js';
import { connectNexusVault, escrowContext, unlockNexusAccountKey } from '../nexus-vault-keys.js';
import { NexusVaultState } from '../nexus-vault-state.js';
import { replicasCanonical } from '../signing.js';

const _require = createRequire(import.meta.url);
type DatabaseSync = _DatabaseSyncType;
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => DatabaseSync;
};

const API = 'https://api.nexus.test';
const BLOB_HOST = 'https://blobs.nexus.test';
const USER = '0198a1b2-0000-7000-8000-0000000000aa';
const DEVICE_A = '0198a1b2-0000-7000-8000-0000000000d1';
const DEVICE_B = '0198a1b2-0000-7000-8000-0000000000d2';
const REPLICA_A = '0198a1b2-0000-7000-8000-0000000000e1';
const REPLICA_B = '0198a1b2-0000-7000-8000-0000000000e2';
const REMOTE_PROJECT = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a99';
const LOCAL_PROJECT = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const OTHER_PROJECT = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a77';
const ORG = '0198a1b2-0000-7000-8000-0000000000f1';
const NOW = '2026-10-01T12:00:00.000Z';
const STREAM = `project:${REMOTE_PROJECT}`;
const HOME_STREAM = `home:${USER}`;

// ---------------------------------------------------------------------------
// Fake Cleo Nexus
// ---------------------------------------------------------------------------

interface FakeDevice {
  deviceId: string;
  name: string;
  token: string;
  encryptionPublicKey: string;
  signingPublicKey: string;
}

interface FakeLease {
  streamId: string;
  role: string;
  leaseId: string;
  replicaId: string;
  expiresAt: Date;
  forkedFromReplicaId: string | null;
  /** The device that acquired it (listed, not returned on acquire). */
  deviceId: string;
  acquiredAt: string;
}

interface FakeStream {
  streamId: string;
  kind: 'project' | 'home';
  headSeq: number;
  headCheckpointId: string | null;
  segments: Segment[];
  checkpoints: Checkpoint[];
}

interface FakeActivity {
  id: number;
  at: string;
  actorUserId: string;
  actorDeviceId: string | null;
  action: string;
  target: string | null;
}

class ApiFail extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(code);
  }
}

function json(status: number, body: object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req-test' },
  });
}

/** An in-process Cleo Nexus with just the state the vault touches. */
class FakeNexus {
  devices = new Map<string, FakeDevice>();
  certificates: DeviceCertificateRecord[] = [];
  escrow: { mk: Buffer; keyVersion: number; verifier: string; updatedAt: string } | null = null;
  /** Runs before an escrow PUT is applied (simulates a concurrent first device). */
  beforeEscrowPut: (() => void) | null = null;
  projectKeys = new Map<string, Array<{ wrappedProjectKey: string; keyVersion: number }>>();
  /** projectId -> replicaId -> deviceId. */
  replicas = new Map<string, Map<string, string>>();
  streams = new Map<string, FakeStream>();
  blobs = new Map<string, { size: number; bytes: Buffer | null; verified: boolean }>();
  leases = new Map<string, FakeLease>();
  activity: FakeActivity[] = [];
  /** When set, the next checkpoint create is refused with this code. */
  refuseCheckpoint: string | null = null;
  /** Largest activity page this server serves (the real one: 200). */
  activityPageSize = 200;
  now = () => new Date();
  private seq = 0;

  addDevice(d: FakeDevice): void {
    this.devices.set(d.deviceId, d);
  }

  addProject(projectId: string, replicas: Record<string, string>): void {
    this.replicas.set(projectId, new Map(Object.entries(replicas)));
    this.streams.set(`project:${projectId}`, {
      streamId: `project:${projectId}`,
      kind: 'project',
      headSeq: 0,
      headCheckpointId: null,
      segments: [],
      checkpoints: [],
    });
  }

  stream(streamId: string): FakeStream {
    let s = this.streams.get(streamId);
    if (!s && streamId === HOME_STREAM) {
      s = {
        streamId,
        kind: 'home',
        headSeq: 0,
        headCheckpointId: null,
        segments: [],
        checkpoints: [],
      };
      this.streams.set(streamId, s);
    }
    if (!s) throw new ApiFail(404, 'E_NOT_FOUND');
    return s;
  }

  record(device: FakeDevice | null, action: string, target: string | null): void {
    this.activity.push({
      id: ++this.seq,
      at: new Date(Date.parse(NOW) + this.seq * 1000).toISOString(),
      actorUserId: USER,
      actorDeviceId: device?.deviceId ?? null,
      action,
      target,
    });
  }

  readonly fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    try {
      if (url.origin === BLOB_HOST) return this.blob(method, url, init);
      const token = (new Headers(init?.headers).get('authorization') ?? '').replace(/^Bearer /, '');
      const device = [...this.devices.values()].find((d) => d.token === token);
      if (!device) throw new ApiFail(401, 'E_UNAUTHENTICATED');
      const body =
        typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      return this.route(device, method, url, body);
    } catch (err) {
      if (err instanceof ApiFail) {
        return json(err.status, {
          success: false,
          error: {
            code: err.code,
            message: `${err.code} from fake`,
            requestId: 'r',
            ...(err.details ? { details: err.details } : {}),
          },
        });
      }
      throw err;
    }
  };

  private blob(method: string, url: URL, init?: RequestInit): Response {
    const sha = url.pathname.slice(1);
    const b = this.blobs.get(sha);
    if (!b) return new Response('missing', { status: 404 });
    if (method === 'PUT') {
      b.bytes = Buffer.from(init?.body as Uint8Array);
      return new Response(null, { status: 200 });
    }
    if (!b.bytes) return new Response('missing', { status: 404 });
    return new Response(new Uint8Array(b.bytes), {
      status: 200,
      headers: { 'content-length': String(b.bytes.length) },
    });
  }

  private ok(data: object, status = 200): Response {
    return json(status, { success: true, data, meta: { requestId: 'r' } });
  }

  private route(
    dev: FakeDevice,
    method: string,
    url: URL,
    body: Record<string, unknown>,
  ): Response {
    const p = url.pathname;
    const route = `${method} ${p}`;
    let m: RegExpMatchArray | null;

    if (route === 'GET /v1/devices') {
      return this.ok({
        devices: [...this.devices.values()].map((d) => ({
          deviceId: d.deviceId,
          name: d.name,
          platform: 'darwin',
          arch: 'arm64',
          cliVersion: '2026.10.1',
          createdAt: NOW,
          lastSeenAt: null,
          state: 'active',
          profile: 'device',
          current: d.deviceId === dev.deviceId,
        })),
        nextCursor: null,
        truncated: false,
      });
    }
    if (route === 'GET /v1/devices/trust') {
      return this.ok({ certificates: this.certificates, revocations: [] });
    }
    m = route.match(/^PUT \/v1\/devices\/([^/]+)\/key$/);
    if (m) {
      const id = decodeURIComponent(m[1] ?? '');
      if (id !== dev.deviceId) throw new ApiFail(403, 'E_FORBIDDEN');
      const record: DeviceCertificateRecord = {
        deviceId: id,
        encryptionPublicKey: dev.encryptionPublicKey,
        signingPublicKey: dev.signingPublicKey,
        keyVersion: body['keyVersion'] as number,
        certificate: body['certificate'] as string,
        live: true,
      };
      this.certificates = [
        ...this.certificates.filter(
          (c) => !(c.deviceId === id && c.keyVersion === record.keyVersion),
        ),
        record,
      ];
      return this.ok({ deviceId: id, keyVersion: record.keyVersion });
    }
    if (route === 'GET /v1/account/keys') throw new ApiFail(404, 'E_NOT_FOUND');
    if (route === 'GET /v1/account/keys/escrow') {
      if (!this.escrow) throw new ApiFail(404, 'E_NOT_FOUND');
      const sealed = sealTo(
        Buffer.from(dev.encryptionPublicKey, 'base64'),
        this.escrow.mk,
        escrowContext(USER, dev.deviceId),
      );
      return this.ok({
        sealedMasterKey: sealed.toString('base64url'),
        keyVersion: this.escrow.keyVersion,
        masterKeyVerifier: this.escrow.verifier,
        deviceId: dev.deviceId,
        updatedAt: this.escrow.updatedAt,
      });
    }
    if (route === 'PUT /v1/account/keys/escrow') {
      this.beforeEscrowPut?.();
      const mk = Buffer.from(body['masterKey'] as string, 'base64url');
      if (mk.length !== 32 || masterKeyVerifier(mk) !== body['masterKeyVerifier']) {
        throw new ApiFail(400, 'E_VALIDATION');
      }
      if (this.escrow) {
        if (this.escrow.mk.equals(mk)) {
          return this.ok({
            keyVersion: this.escrow.keyVersion,
            masterKeyVerifier: this.escrow.verifier,
            updatedAt: this.escrow.updatedAt,
          });
        }
        throw new ApiFail(409, 'E_CONFLICT', { reason: 'escrow-exists' });
      }
      this.escrow = {
        mk,
        keyVersion: body['keyVersion'] as number,
        verifier: body['masterKeyVerifier'] as string,
        updatedAt: NOW,
      };
      this.record(dev, 'keys.escrow', `user:${USER}`);
      return this.ok({
        keyVersion: this.escrow.keyVersion,
        masterKeyVerifier: this.escrow.verifier,
        updatedAt: NOW,
      });
    }
    m = route.match(/^GET \/v1\/projects\/([^/]+)\/keys$/);
    if (m) {
      return this.ok({ keys: this.projectKeys.get(decodeURIComponent(m[1] ?? '')) ?? [] });
    }
    m = route.match(/^PUT \/v1\/projects\/([^/]+)\/keys\/([^/]+)$/);
    if (m) {
      const projectId = decodeURIComponent(m[1] ?? '');
      if (decodeURIComponent(m[2] ?? '') !== USER) throw new ApiFail(403, 'E_FORBIDDEN');
      if ((this.projectKeys.get(projectId) ?? []).length > 0) {
        throw new ApiFail(409, 'E_CONFLICT', { reason: 'keys-exist' });
      }
      this.projectKeys.set(projectId, [
        {
          wrappedProjectKey: body['wrappedProjectKey'] as string,
          keyVersion: body['keyVersion'] as number,
        },
      ]);
      return this.ok({ projectId, keyVersion: body['keyVersion'] as number });
    }
    if (route === 'GET /v1/account/activity') {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), this.activityPageSize);
      const before = url.searchParams.get('before');
      const events = [...this.activity]
        .reverse()
        .filter((e) => before === null || e.id < Number(before))
        .slice(0, limit);
      return this.ok({
        events,
        nextBefore: events.length === limit ? (events.at(-1)?.id ?? null) : null,
      });
    }
    if (route === 'POST /v1/blobs/presign') {
      const sha = body['sha256'] as string;
      const size = body['sizeBytes'] as number;
      const existing = this.blobs.get(sha);
      if (existing?.verified) {
        return this.ok({
          alreadyPresent: true,
          uploadUrl: null,
          uploadHeaders: null,
          expiresAt: null,
        });
      }
      this.blobs.set(sha, existing ?? { size, bytes: null, verified: false });
      return this.ok({
        alreadyPresent: false,
        uploadUrl: `${BLOB_HOST}/${sha}`,
        uploadHeaders: { 'x-amz-checksum-sha256': Buffer.from(sha, 'hex').toString('base64') },
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      });
    }
    m = route.match(/^POST \/v1\/blobs\/([0-9a-f]{64})\/complete$/);
    if (m) {
      const sha = m[1] ?? '';
      const b = this.blobs.get(sha);
      if (!b) throw new ApiFail(404, 'E_NOT_FOUND');
      if (!b.bytes) throw new ApiFail(409, 'E_BLOB_MISSING');
      if (b.bytes.length !== b.size || sha256Hex(b.bytes) !== sha) {
        throw new ApiFail(409, 'E_BLOB_INTEGRITY');
      }
      b.verified = true;
      return this.ok({ sha256: sha, verified: true });
    }
    m = p.match(/^\/v1\/streams\/([^/]+)(\/.*)?$/);
    if (m) {
      return this.streamRoute(dev, method, decodeURIComponent(m[1] ?? ''), m[2] ?? '', url, body);
    }
    throw new ApiFail(404, 'E_NOT_FOUND');
  }

  private streamRoute(
    dev: FakeDevice,
    method: string,
    streamId: string,
    rest: string,
    url: URL,
    body: Record<string, unknown>,
  ): Response {
    const s = this.stream(streamId);
    const route = `${method} ${rest}`;
    let m: RegExpMatchArray | null;
    if (route === 'GET ') {
      return this.ok({
        streamId,
        kind: s.kind,
        headSeq: s.headSeq,
        headCheckpointId: s.headCheckpointId,
        maxSchemaVersion: 1,
      });
    }
    if (route === 'POST /segments') {
      if (body['deviceId'] !== dev.deviceId) throw new ApiFail(403, 'E_FORBIDDEN');
      const replicaId = body['replicaId'] as string;
      const dup = s.segments.find(
        (x) => x.replicaId === replicaId && x.segmentHash === body['segmentHash'],
      );
      if (dup) return this.ok({ streamId, seq: dup.seq, duplicate: true });
      if (s.kind === 'project') {
        const attached = this.replicas.get(streamId.slice('project:'.length))?.get(replicaId);
        if (!attached || attached !== dev.deviceId) throw new ApiFail(403, 'E_FORBIDDEN');
      }
      const last = s.segments.filter((x) => x.replicaId === replicaId).at(-1);
      const expected = last ? last.replicaSeq + 1 : 0;
      if (body['replicaSeq'] !== expected) {
        throw new ApiFail(409, 'E_CONFLICT', { expected, got: body['replicaSeq'] as number });
      }
      s.headSeq += 1;
      s.segments.push({
        seq: s.headSeq,
        replicaId,
        deviceId: dev.deviceId,
        replicaSeq: expected,
        segmentHash: body['segmentHash'] as string,
        schemaVersion: body['schemaVersion'] as number,
        opCount: body['opCount'] as number,
        hlcMin: body['hlcMin'] as string,
        hlcMax: body['hlcMax'] as string,
        deltas: body['deltas'] as TableDeltas,
        signature: body['signature'] as string,
        ciphertext: (body['ciphertext'] as string | undefined) ?? null,
        blobSha256: (body['blobSha256'] as string | undefined) ?? null,
        receivedAt: this.now().toISOString(),
      });
      this.record(dev, 'segment.append', streamId);
      return this.ok({ streamId, seq: s.headSeq, duplicate: false }, 201);
    }
    if (route === 'GET /segments') {
      const after = Number(url.searchParams.get('after') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 100);
      const rows = s.segments.filter((x) => x.seq > after).slice(0, limit);
      return this.ok({
        streamId,
        segments: rows,
        head: s.headSeq,
        nextAfter: rows.at(-1)?.seq ?? after,
      });
    }
    if (route === 'POST /checkpoints') {
      if (body['deviceId'] !== dev.deviceId) throw new ApiFail(403, 'E_FORBIDDEN');
      if (this.refuseCheckpoint !== null) {
        const code = this.refuseCheckpoint;
        this.refuseCheckpoint = null;
        throw new ApiFail(409, code);
      }
      const parentId = (body['parentCheckpointId'] as string | null) ?? null;
      if (parentId !== s.headCheckpointId) {
        throw new ApiFail(409, 'E_LINEAGE', {
          headCheckpointId: s.headCheckpointId,
          parentCheckpointId: parentId,
        });
      }
      const parent = parentId ? s.checkpoints.find((c) => c.checkpointId === parentId) : undefined;
      const coversSeq = body['coversSeq'] as number;
      const fromSeq = parent?.coversSeq ?? 0;
      if (coversSeq < fromSeq || coversSeq > s.headSeq) throw new ApiFail(400, 'E_VALIDATION');
      const expected: ReplicaHeads = {};
      for (const x of s.segments.filter((y) => y.seq <= coversSeq)) {
        expected[x.replicaId] = { deviceId: x.deviceId, lastReplicaSeq: x.replicaSeq };
      }
      if (replicasCanonical(expected) !== replicasCanonical(body['replicas'] as ReplicaHeads)) {
        throw new ApiFail(400, 'E_VALIDATION', { expected });
      }
      const blob = this.blobs.get(body['blobSha256'] as string);
      if (!blob?.verified) throw new ApiFail(409, 'E_BLOB_MISSING');
      if (blob.size !== body['sizeBytes']) throw new ApiFail(400, 'E_VALIDATION');
      const between = s.segments
        .filter((x) => x.seq > fromSeq && x.seq <= coversSeq)
        .map((x) => x.deltas);
      const verdict = checkManifest(
        parent?.manifest ?? null,
        body['manifest'] as Manifest,
        sumDeltas(between),
        1,
      );
      if (!verdict.ok) {
        this.record(dev, `checkpoint.refused.${verdict.code}`, streamId);
        throw new ApiFail(409, verdict.code, { verdict });
      }
      const cp: Checkpoint = {
        checkpointId: body['checkpointId'] as string,
        streamId,
        parentCheckpointId: parentId,
        replicaId: body['replicaId'] as string,
        deviceId: dev.deviceId,
        coversSeq,
        manifest: body['manifest'] as Manifest,
        replicas: body['replicas'] as ReplicaHeads,
        blobSha256: body['blobSha256'] as string,
        sizeBytes: body['sizeBytes'] as number,
        signature: body['signature'] as string,
        endorsements: [],
        createdAt: new Date(Date.parse(NOW) + s.checkpoints.length * 1000).toISOString(),
      };
      s.checkpoints.push(cp);
      s.headCheckpointId = cp.checkpointId;
      this.record(dev, 'checkpoint.create', streamId);
      return this.ok({ checkpoint: cp }, 201);
    }
    if (route === 'GET /checkpoints') {
      return this.ok({ checkpoints: [...s.checkpoints].reverse() });
    }
    m = route.match(/^GET \/checkpoints\/([^/]+)\/download$/);
    if (m) {
      const cp = s.checkpoints.find((c) => c.checkpointId === m?.[1]);
      if (!cp) throw new ApiFail(404, 'E_NOT_FOUND');
      return this.ok({
        url: `${BLOB_HOST}/${cp.blobSha256}`,
        sha256: cp.blobSha256,
        sizeBytes: cp.sizeBytes,
        expiresInSeconds: 300,
      });
    }
    if (route === 'POST /leases') {
      const role = body['role'] as string;
      const replicaId = body['replicaId'] as string;
      const key = `${streamId}|${role}`;
      const now = this.now();
      const held = this.leases.get(key);
      const live = held !== undefined && held.expiresAt > now && held.replicaId !== replicaId;
      if (live && body['force'] !== true) {
        throw new ApiFail(409, 'E_LEASE_HELD', {
          replicaId: held.replicaId,
          expiresAt: held.expiresAt.toISOString(),
        });
      }
      const renew = held !== undefined && held.replicaId === replicaId && held.expiresAt > now;
      const lease: FakeLease = {
        streamId,
        role,
        leaseId: renew ? held.leaseId : uuidv7(),
        replicaId,
        expiresAt: new Date(now.getTime() + (body['ttlSeconds'] as number) * 1000),
        forkedFromReplicaId: live ? held.replicaId : null,
        deviceId: dev.deviceId,
        acquiredAt: renew ? held.acquiredAt : now.toISOString(),
      };
      this.leases.set(key, lease);
      if (!renew) this.record(dev, live ? 'lease.force_take' : 'lease.acquire', streamId);
      const { deviceId: _d, acquiredAt: _a, ...wire } = lease;
      return this.ok({ lease: { ...wire, expiresAt: lease.expiresAt.toISOString() } });
    }
    m = route.match(/^DELETE \/leases\/([a-z]+)$/);
    if (m) {
      const key = `${streamId}|${m[1]}`;
      const held = this.leases.get(key);
      if (!held || held.replicaId !== url.searchParams.get('replicaId')) {
        throw new ApiFail(404, 'E_NOT_FOUND');
      }
      this.leases.delete(key);
      this.record(dev, 'lease.release', streamId);
      return this.ok({ released: m[1] ?? '' });
    }
    if (route === 'GET /leases') {
      const now = this.now();
      return this.ok({
        leases: [...this.leases.values()]
          .filter((l) => l.streamId === streamId && l.expiresAt > now)
          .map((l) => ({ ...l, expiresAt: l.expiresAt.toISOString() })),
      });
    }
    throw new ApiFail(404, 'E_NOT_FOUND');
  }
}

// ---------------------------------------------------------------------------
// Machines (one CLEO home, device store and project copy each)
// ---------------------------------------------------------------------------

interface Machine {
  name: string;
  deviceId: string;
  replicaId: string;
  home: string;
  configHome: string;
  root: string;
  devices: NexusDeviceStore;
  sessions: FileNexusTokenStore;
  state: NexusVaultState;
  token: string;
  keys: { encryption: KeyPair; signing: KeyPair };
}

let base: string;
let fake: FakeNexus;
let saved: Record<string, string | undefined>;
const ENV_KEYS = [NEXUS_DEVICE_ENV, 'CLEO_HOME', 'CLEO_DIR', 'CLEO_CONFIG_HOME'];

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-vault-'));
  fake = new FakeNexus();
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env[NEXUS_DEVICE_ENV] = '1';
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(base, { recursive: true, force: true });
});

const b64 = (b: Buffer) => b.toString('base64');

async function machine(name: string, deviceId: string, replicaId: string): Promise<Machine> {
  const home = path.join(base, name, 'cleo-home');
  const configHome = path.join(base, name, 'config');
  const root = path.join(base, name, 'proj');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(configHome, { recursive: true });
  const devices = new NexusDeviceStore(path.join(home, 'nexus-device.json'), {
    cleoHome: home,
    lockWaitMs: 10_000,
  });
  const sessions = new FileNexusTokenStore(path.join(home, 'nexus-credentials.json'));
  const token = `cnx_d1_${randomBytes(32).toString('base64url')}`;
  const encryption = generateX25519();
  const signing = generateEd25519();
  await devices.update((tx) => {
    tx.set(
      API,
      USER,
      applyEnrolment(
        tx.get(API, USER),
        new NexusDeviceEnrolment({
          deviceId,
          keys: {
            encryption: {
              publicKey: b64(encryption.publicKey),
              privateKey: b64(encryption.privateKey),
            },
            signing: { publicKey: b64(signing.publicKey), privateKey: b64(signing.privateKey) },
          },
          credential: {
            credentialId: uuidv7(),
            token,
            profile: 'device',
            scopes: ['account:read', 'devices:read', 'projects:read', 'sync:write', 'keys:write'],
            createdAt: NOW,
          },
        }),
      ),
    );
  });
  fake.addDevice({
    deviceId,
    name: `${name}-laptop`,
    token,
    encryptionPublicKey: b64(encryption.publicKey),
    signingPublicKey: b64(signing.publicKey),
  });
  return {
    name,
    deviceId,
    replicaId,
    home,
    configHome,
    root,
    devices,
    sessions,
    state: new NexusVaultState(path.join(home, 'nexus-vault.json')),
    token,
    keys: { encryption, signing },
  };
}

/** Run `fn` with `m`'s CLEO home, config home and project active. */
async function on<T>(m: Machine, fn: () => Promise<T>): Promise<T> {
  // Each call stands for one CLI process: no database handle survives it.
  _resetDualScopeDbCache();
  process.env['CLEO_HOME'] = m.home;
  process.env['CLEO_CONFIG_HOME'] = m.configHome;
  process.env['CLEO_DIR'] = path.join(m.root, '.cleo');
  return fn();
}

function vopts(m: Machine, extra: Record<string, unknown> = {}) {
  return {
    apiUrl: API,
    fetch: fake.fetch,
    deviceStore: m.devices,
    store: m.sessions,
    vaultState: m.state,
    projectRoot: m.root,
    ...extra,
  };
}

/** A project with a real `.cleo/cleo.db`: syncing, credential, secret and machine-local tables. */
function seedProject(m: Machine, tasks: number): void {
  const cleo = path.join(m.root, '.cleo');
  fs.mkdirSync(cleo, { recursive: true });
  fs.writeFileSync(path.join(cleo, 'project-id'), `${LOCAL_PROJECT}\n`);
  fs.writeFileSync(
    path.join(cleo, 'project-info.json'),
    JSON.stringify({ projectId: LOCAL_PROJECT, name: 'demo' }),
  );
  const db = new DatabaseSync(path.join(cleo, 'cleo.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE tasks_tasks (id TEXT PRIMARY KEY, title TEXT, file_path TEXT);
    CREATE TABLE brain_observations (id TEXT PRIMARY KEY, narrative TEXT);
    CREATE TABLE tasks_sessions (id TEXT PRIMARY KEY, owner_auth_token TEXT);
    CREATE TABLE tasks_agent_credentials (id TEXT PRIMARY KEY, api_key_encrypted TEXT);
    CREATE TABLE _sync_replica (replica_id TEXT PRIMARY KEY, device_id TEXT);
  `);
  const ins = db.prepare('INSERT INTO tasks_tasks VALUES (?, ?, ?)');
  for (let i = 0; i < tasks; i++) ins.run(`T${i}`, `task ${i}`, `${m.root}/src/t${i}.ts`);
  db.prepare('INSERT INTO brain_observations VALUES (?, ?)').run(
    'O1',
    `edited ${m.root}/src/app.ts`,
  );
  db.prepare('INSERT INTO tasks_sessions VALUES (?, ?)').run('S1', 'OWNER-TOKEN-SECRET');
  db.prepare('INSERT INTO tasks_agent_credentials VALUES (?, ?)').run('C1', 'API-KEY-SECRET');
  db.prepare('INSERT INTO _sync_replica VALUES (?, ?)').run(`local-${m.name}`, m.deviceId);
  db.close();
}

/** This project's link to the fake server, attached from `m`'s device. */
function link(m: Machine): void {
  fs.mkdirSync(path.join(m.root, '.cleo'), { recursive: true });
  fs.writeFileSync(
    path.join(m.root, '.cleo', 'nexus-link.json'),
    JSON.stringify({
      version: 1,
      links: {
        [API]: {
          apiUrl: API,
          localProjectId: LOCAL_PROJECT,
          remoteProjectId: REMOTE_PROJECT,
          organizationId: ORG,
          label: 'demo',
          streamId: STREAM,
          linkedAt: NOW,
          replicaId: m.replicaId,
          nexusDeviceId: m.deviceId,
          attachedAt: NOW,
        },
      },
    }),
  );
}

function sql<T>(m: Machine, query: string, ...params: Array<string | number>): T[] {
  const db = new DatabaseSync(path.join(m.root, '.cleo', 'cleo.db'));
  try {
    return db.prepare(query).all(...params) as T[];
  } finally {
    db.close();
  }
}

function exec(m: Machine, statement: string): void {
  const db = new DatabaseSync(path.join(m.root, '.cleo', 'cleo.db'));
  try {
    db.exec(statement);
  } finally {
    db.close();
  }
}

const taskCount = (m: Machine) =>
  sql<{ n: number }>(m, 'SELECT COUNT(*) AS n FROM tasks_tasks')[0]?.n ?? -1;

async function failure(p: Promise<object>): Promise<NexusAccountError> {
  const err = await p.then(
    () => null,
    (e: Error) => e,
  );
  expect(err).toBeInstanceOf(NexusAccountError);
  return err as NexusAccountError;
}

/** Device A has pushed the project once (genesis); B is enrolled with an empty CLEO home. */
async function twoMachines(): Promise<{ a: Machine; b: Machine }> {
  const a = await machine('a', DEVICE_A, REPLICA_A);
  const b = await machine('b', DEVICE_B, REPLICA_B);
  fake.addProject(REMOTE_PROJECT, { [REPLICA_A]: DEVICE_A, [REPLICA_B]: DEVICE_B });
  seedProject(a, 5);
  link(a);
  return { a, b };
}

/** B restores the project onto its machine and attaches its own replica. */
async function restoreOntoB(b: Machine) {
  const relinked: string[] = [];
  const result = await on(b, () =>
    restoreNexusVault(
      vopts(b, {
        mode: 'restore',
        projectId: REMOTE_PROJECT,
        into: b.root,
        relink: async (root: string) => {
          relinked.push(root);
          link(b);
          return [];
        },
      }),
    ),
  );
  return { result, relinked };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cloud vault push (lineage, regression rule)', () => {
  it('a: the first push creates a genesis snapshot; a repeat push is up-to-date', async () => {
    const { a } = await twoMachines();
    const first = await on(a, () => pushNexusVault(vopts(a)));
    expect(first.status).toBe('pushed');
    expect(first.scope).toBe('project');
    expect(first.streamId).toBe(STREAM);
    expect(first.parentCheckpointId).toBeNull();
    expect(first.deltaSegmentSeq).toBeNull();
    expect(first.forked).toBe(false);
    expect(first.lease?.mine).toBe(true);
    expect(first.snapshot?.deviceName).toBe('a-laptop');
    const cp = fake.stream(STREAM).checkpoints[0];
    expect(cp?.parentCheckpointId).toBeNull();
    // Only syncing, non-secret tables are in the plaintext manifest.
    expect(Object.keys(cp?.manifest.tables ?? {}).sort()).toEqual([
      'brain_observations',
      'tasks_sessions',
      'tasks_tasks',
    ]);
    expect(cp?.manifest.tables['tasks_tasks']?.rows).toBe(5);
    // The uploaded bundle is ciphertext: no plaintext row content or credential leaks.
    const blob = fake.blobs.get(cp?.blobSha256 ?? '')?.bytes ?? Buffer.alloc(0);
    expect(blob.length).toBeGreaterThan(0);
    expect(blob.includes(Buffer.from('task 1'))).toBe(false);
    expect(blob.includes(Buffer.from('OWNER-TOKEN-SECRET'))).toBe(false);

    const again = await on(a, () => pushNexusVault(vopts(a)));
    expect(again.status).toBe('up-to-date');
    expect(again.snapshot?.checkpointId).toBe(cp?.checkpointId);
    expect(fake.stream(STREAM).checkpoints).toHaveLength(1);
    // The account key was minted once and escrowed; the device certified itself.
    expect(fake.escrow).not.toBeNull();
    expect(fake.certificates.map((c) => c.deviceId)).toEqual([DEVICE_A]);

    const verify = await on(a, () => verifyNexusVault(vopts(a)));
    expect(verify.verdict).toBe('match');
    expect(verify.localIntegrity).toBe(true);
    expect(verify.remedy).toBeNull();
    expect(verify.warnings.some((w) => w.code === 'W_NEXUS_VAULT_FORK')).toBe(false);
  });

  it('b: new rows append a delta segment and the snapshot passes the regression rule', async () => {
    const { a } = await twoMachines();
    const first = await on(a, () => pushNexusVault(vopts(a)));
    exec(
      a,
      "INSERT INTO tasks_tasks (id, title) VALUES ('T100', 'new'), ('T101', 'new'), ('T102', 'new')",
    );
    exec(a, "DELETE FROM brain_observations WHERE id = 'O1'");
    const second = await on(a, () => pushNexusVault(vopts(a)));
    expect(second.status).toBe('pushed');
    expect(second.parentCheckpointId).toBe(first.snapshot?.checkpointId);
    expect(second.deltaSegmentSeq).toBe(1);
    const s = fake.stream(STREAM);
    expect(s.segments).toHaveLength(1);
    expect(s.segments[0]?.replicaId).toBe(REPLICA_A);
    expect(s.segments[0]?.replicaSeq).toBe(0);
    expect(s.segments[0]?.deltas).toEqual({
      tasks_tasks: { created: 3, deleted: 0 },
      brain_observations: { created: 0, deleted: 1 },
    });
    const cp = s.checkpoints[1];
    expect(cp?.coversSeq).toBe(1);
    expect(cp?.replicas).toEqual({ [REPLICA_A]: { deviceId: DEVICE_A, lastReplicaSeq: 0 } });
    expect(cp?.manifest.tables['tasks_tasks']?.rows).toBe(8);
    expect(cp?.manifest.tables['brain_observations']?.rows).toBe(0);

    // A third change continues the replica's sequence (replicaSeq 1, not a gap).
    exec(a, "INSERT INTO tasks_tasks (id, title) VALUES ('T103', 'more')");
    const third = await on(a, () => pushNexusVault(vopts(a)));
    expect(third.status).toBe('pushed');
    expect(s.segments[1]?.replicaSeq).toBe(1);
    expect(fake.activity.some((e) => e.action.startsWith('checkpoint.refused'))).toBe(false);

    const status = await on(a, () => nexusVaultStatus(vopts(a)));
    expect(status.lineage.map((x) => x.checkpointId)).toEqual(
      [...s.checkpoints].reverse().map((x) => x.checkpointId),
    );
    expect(status.head?.checkpointId).toBe(third.snapshot?.checkpointId);
    expect(status.pendingChanges).toEqual([]);
    expect(status.leases).toHaveLength(1);
    expect(status.leases[0]?.mine).toBe(true);
    expect(status.leases[0]?.deviceName).toBe('a-laptop');
  });
});

describe('cloud vault restore and verify across two devices', () => {
  it('c: a new machine restores the project and verifies it matches', async () => {
    const { a, b } = await twoMachines();
    exec(a, "INSERT INTO tasks_tasks (id, title) VALUES ('T100', 'new')");
    await on(a, () => pushNexusVault(vopts(a)));

    const { result, relinked } = await restoreOntoB(b);
    expect(result.status).toBe('restored');
    expect(result.verified).toBe(true);
    expect(result.target).toBe(b.root);
    expect(result.safetyBackup).toBeNull();
    expect(relinked).toEqual([b.root]);
    expect(taskCount(b)).toBe(6);
    // Path locators follow the store to its new root; history keeps the text it was written with.
    expect(sql(b, "SELECT file_path FROM tasks_tasks WHERE id = 'T0'")).toEqual([
      { file_path: `${b.root}/src/t0.ts` },
    ]);
    expect(sql<{ narrative: string }>(b, 'SELECT narrative FROM brain_observations')).toEqual([
      { narrative: `edited ${a.root}/src/app.ts` },
    ]);
    // Credentials never travel in a vault snapshot.
    expect(sql(b, 'SELECT owner_auth_token FROM tasks_sessions')).toEqual([
      { owner_auth_token: null },
    ]);
    // B obtained the same account key from escrow and certified itself.
    expect(fake.certificates.map((c) => c.deviceId).sort()).toEqual([DEVICE_A, DEVICE_B]);

    const vb = await on(b, () => verifyNexusVault(vopts(b)));
    const va = await on(a, () => verifyNexusVault(vopts(a)));
    expect(vb.verdict).toBe('match');
    expect(va.verdict).toBe('match');
    expect(vb.tables).toEqual(va.tables);
    expect(vb.tables.every((t) => t.match)).toBe(true);
    expect(vb.devices).toEqual([
      expect.objectContaining({ deviceId: DEVICE_A, deviceName: 'a-laptop', matchesHead: true }),
    ]);
  });

  it('d: a stale push is refused, a pull never overwrites local changes, --force does with a backup', async () => {
    const { a, b } = await twoMachines();
    await on(a, () => pushNexusVault(vopts(a)));
    await restoreOntoB(b);
    // A hands the write lease back so B can push.
    const released = await on(a, () => releaseNexusVaultLease(vopts(a)));
    expect(released.released).toBe(true);

    exec(b, "INSERT INTO tasks_tasks (id, title) VALUES ('B1', 'from b'), ('B2', 'from b')");
    const pushedB = await on(b, () => pushNexusVault(vopts(b)));
    expect(pushedB.status).toBe('pushed');
    expect(pushedB.forked).toBe(false);
    expect(fake.stream(STREAM).segments.map((x) => [x.replicaId, x.replicaSeq])).toEqual([
      [REPLICA_B, 0],
    ]);
    await on(b, () => releaseNexusVaultLease(vopts(b)));

    // A's view: the cloud moved on.
    const va = await on(a, () => verifyNexusVault(vopts(a)));
    expect(va.verdict).toBe('behind');
    expect(va.remedy).toContain('cleo cloud pull');

    exec(a, "INSERT INTO tasks_tasks (id, title) VALUES ('A1', 'from a')");
    const stale = await failure(on(a, () => pushNexusVault(vopts(a))));
    expect(stale.code).toBe('E_NEXUS_VAULT_BEHIND');

    const refused = await failure(on(a, () => restoreNexusVault(vopts(a, { mode: 'pull' }))));
    expect(refused.code).toBe('E_NEXUS_VAULT_LOCAL_CHANGES');
    expect(taskCount(a)).toBe(6);

    const forced = await on(a, () => restoreNexusVault(vopts(a, { mode: 'pull', force: true })));
    expect(forced.status).toBe('restored');
    expect(forced.snapshot?.checkpointId).toBe(pushedB.snapshot?.checkpointId);
    expect(forced.safetyBackup).not.toBeNull();
    expect(fs.existsSync(forced.safetyBackup ?? '')).toBe(true);
    expect(
      sql<{ id: string }>(a, 'SELECT id FROM tasks_tasks ORDER BY id').map((r) => r.id),
    ).toEqual(['B1', 'B2', 'T0', 'T1', 'T2', 'T3', 'T4']);
    // A's machine-local rows survive; its link still names A's own replica.
    expect(sql(a, 'SELECT replica_id FROM _sync_replica')).toEqual([{ replica_id: 'local-a' }]);
    const after = await on(a, () => verifyNexusVault(vopts(a)));
    expect(after.verdict).toBe('match');
    // A can push again from here (its replica binding was not replaced by B's).
    exec(a, "INSERT INTO tasks_tasks (id, title) VALUES ('A2', 'from a')");
    const pushedA = await on(a, () => pushNexusVault(vopts(a)));
    expect(pushedA.status).toBe('pushed');
    expect(pushedA.parentCheckpointId).toBe(pushedB.snapshot?.checkpointId);

    // A pull with nothing new is up-to-date.
    const again = await on(a, () => restoreNexusVault(vopts(a, { mode: 'pull' })));
    expect(again.status).toBe('up-to-date');
  });
});

describe('cloud vault point-in-time restore', () => {
  it('restores an older snapshot; a pull then returns to the head; a push from it is behind unless forced', async () => {
    const { a } = await twoMachines();
    const first = await on(a, () => pushNexusVault(vopts(a)));
    exec(a, "INSERT INTO tasks_tasks (id, title) VALUES ('T100', 'new'), ('T101', 'new')");
    const second = await on(a, () => pushNexusVault(vopts(a)));
    const older = first.snapshot?.checkpointId ?? '';
    const head = second.snapshot?.checkpointId ?? '';
    const stateKey = () =>
      a.state.stream(API, USER, STREAM, a.root) as {
        lastCheckpointId: string;
        lastCoversSeq: number;
      };
    expect(stateKey().lastCheckpointId).toBe(head);

    // Point in time: an explicit older checkpoint is not a rollback refusal.
    const restored = await on(a, () =>
      restoreNexusVault(vopts(a, { mode: 'restore', checkpointId: older, force: true })),
    );
    expect(restored.status).toBe('restored');
    expect(restored.verified).toBe(true);
    expect(restored.snapshot?.checkpointId).toBe(older);
    expect(restored.safetyBackup).not.toBeNull();
    expect(taskCount(a)).toBe(5);
    expect(stateKey()).toMatchObject({ lastCheckpointId: older, lastCoversSeq: 0 });
    const verify = await on(a, () => verifyNexusVault(vopts(a)));
    expect(verify.verdict).toBe('behind');
    expect(verify.lastSynced).toBe(older);

    // Pushing the older generation over the head is refused unless forced.
    const behind = await failure(on(a, () => pushNexusVault(vopts(a))));
    expect(behind.code).toBe('E_NEXUS_VAULT_BEHIND');
    expect(fake.stream(STREAM).checkpoints).toHaveLength(2);

    // A plain pull brings the store back to the head (not refused as a rollback or as local changes).
    const pulled = await on(a, () => restoreNexusVault(vopts(a, { mode: 'pull' })));
    expect(pulled.status).toBe('restored');
    expect(pulled.snapshot?.checkpointId).toBe(head);
    expect(taskCount(a)).toBe(7);
    expect(stateKey().lastCheckpointId).toBe(head);

    // Forced: the older generation becomes the new head, descending from the old head;
    // the shrink is carried by a delta segment so the regression rule holds.
    await on(a, () =>
      restoreNexusVault(vopts(a, { mode: 'restore', checkpointId: older, force: true })),
    );
    const forced = await on(a, () => pushNexusVault(vopts(a, { force: true })));
    expect(forced.status).toBe('pushed');
    expect(forced.parentCheckpointId).toBe(head);
    expect(fake.stream(STREAM).segments.at(-1)?.deltas).toEqual({
      tasks_tasks: { created: 0, deleted: 2 },
    });
    expect(fake.stream(STREAM).checkpoints.at(-1)?.manifest.tables['tasks_tasks']).toEqual(
      fake.stream(STREAM).checkpoints[0]?.manifest.tables['tasks_tasks'],
    );
    expect(fake.activity.some((e) => e.action.startsWith('checkpoint.refused'))).toBe(false);
  });
});

describe('cloud vault write lease', () => {
  it('e: a live lease refuses another device; --force takes it as a labelled fork', async () => {
    const { a, b } = await twoMachines();
    await on(a, () => pushNexusVault(vopts(a)));
    await restoreOntoB(b);
    exec(b, "INSERT INTO tasks_tasks (id, title) VALUES ('B1', 'from b')");

    const held = await failure(on(b, () => pushNexusVault(vopts(b))));
    expect(held.code).toBe('E_NEXUS_VAULT_LEASE_HELD');
    expect(held.message).toContain(REPLICA_A);

    const forced = await on(b, () => pushNexusVault(vopts(b, { force: true })));
    expect(forced.status).toBe('pushed');
    expect(forced.forked).toBe(true);
    expect(forced.lease?.forkedFromReplicaId).toBe(REPLICA_A);
    const lease = fake.leases.get(`${STREAM}|writer`);
    expect(lease?.replicaId).toBe(REPLICA_B);
    expect(lease?.forkedFromReplicaId).toBe(REPLICA_A);
    expect(fake.activity.some((e) => e.action === 'lease.force_take')).toBe(true);

    const verifyA = await on(a, () => verifyNexusVault(vopts(a)));
    expect(verifyA.verdict).toBe('behind');
    expect(verifyA.warnings.find((w) => w.code === 'W_NEXUS_VAULT_FORK')?.message).toContain(
      REPLICA_A,
    );

    const status = await on(a, () => nexusVaultStatus(vopts(a)));
    expect(status.leases).toEqual([
      expect.objectContaining({
        replicaId: REPLICA_B,
        deviceId: DEVICE_B,
        deviceName: 'b-laptop',
        forkedFromReplicaId: REPLICA_A,
        mine: false,
      }),
    ]);
  });
});

describe('cloud vault lease on a failed push', () => {
  it('a push refused as behind never takes the lease, even when another device holds it', async () => {
    const { a, b } = await twoMachines();
    await on(a, () => pushNexusVault(vopts(a)));
    await restoreOntoB(b);
    await on(a, () => releaseNexusVaultLease(vopts(a)));
    exec(b, "INSERT INTO tasks_tasks (id, title) VALUES ('B1', 'from b')");
    await on(b, () => pushNexusVault(vopts(b)));
    // B still holds its lease: A is told it is behind (the cheaper, truer refusal), not that the lease is held.
    exec(a, "INSERT INTO tasks_tasks (id, title) VALUES ('A1', 'from a')");
    const stale = await failure(on(a, () => pushNexusVault(vopts(a))));
    expect(stale.code).toBe('E_NEXUS_VAULT_BEHIND');
    expect(fake.leases.get(`${STREAM}|writer`)?.replicaId).toBe(REPLICA_B);

    await on(b, () => releaseNexusVaultLease(vopts(b)));
    const acquiresBefore = fake.activity.filter((e) => e.action === 'lease.acquire').length;
    const again = await failure(on(a, () => pushNexusVault(vopts(a))));
    expect(again.code).toBe('E_NEXUS_VAULT_BEHIND');
    expect(fake.leases.size).toBe(0);
    expect(fake.activity.filter((e) => e.action === 'lease.acquire')).toHaveLength(acquiresBefore);
  });

  it('a push that fails after taking the lease hands it back', async () => {
    const { a, b } = await twoMachines();
    await on(a, () => pushNexusVault(vopts(a)));
    await on(a, () => releaseNexusVaultLease(vopts(a)));
    exec(a, "INSERT INTO tasks_tasks (id, title) VALUES ('A1', 'from a')");
    fake.refuseCheckpoint = 'E_REGRESSION';
    const refused = await failure(on(a, () => pushNexusVault(vopts(a))));
    expect(refused.code).toBe('E_NEXUS_VAULT_REFUSED');
    expect(fake.leases.size).toBe(0);
    expect(fake.activity.slice(-2).map((e) => e.action)).toEqual([
      'segment.append',
      'lease.release',
    ]);
    // The other device can push straight away, without --force.
    await restoreOntoB(b);
    exec(b, "INSERT INTO tasks_tasks (id, title) VALUES ('B1', 'from b')");
    const pushedB = await on(b, () => pushNexusVault(vopts(b)));
    expect(pushedB.status).toBe('pushed');
    expect(pushedB.forked).toBe(false);
  });
});

describe('cloud vault verified restore', () => {
  it('f: a snapshot whose content does not match its signed manifest is refused, nothing placed', async () => {
    const { a, b } = await twoMachines();
    await on(a, () => pushNexusVault(vopts(a)));
    await restoreOntoB(b);
    const dbFile = path.join(b.root, '.cleo', 'cleo.db');
    const before = sha256Hex(fs.readFileSync(dbFile));
    const syncedBefore = fs.readFileSync(b.state.path, 'utf8');

    // A device holding the keys signs a snapshot whose manifest lies about one table's hash
    // (counts unchanged, so the server's regression rule accepts it).
    const mk = fake.escrow?.mk ?? Buffer.alloc(0);
    const wrapped = fake.projectKeys.get(REMOTE_PROJECT)?.[0];
    const pdk = unwrapProjectKey(mk, wrapped?.wrappedProjectKey ?? '', REMOTE_PROJECT, 1);
    const head = fake.stream(STREAM).checkpoints.at(-1) as Checkpoint;
    const bundlePath = path.join(base, 'tampered.cleobundle.tar.gz');
    await on(a, () =>
      exportPortableBundle({
        scope: 'project',
        projectRoot: a.root,
        outputPath: bundlePath,
        label: 't',
      }),
    );
    const lie: Manifest = structuredClone(head.manifest);
    const entry = lie.tables['tasks_tasks'];
    if (entry) entry.hash = 'f'.repeat(64);
    const journal = new Journal({
      http: new Http({ baseUrl: API, token: a.token, deviceId: a.deviceId, fetch: fake.fetch }),
      streamId: STREAM,
      replicaId: REPLICA_A,
      deviceId: DEVICE_A,
      signing: a.keys.signing,
      key: pdk,
      fetch: fake.fetch,
    });
    const tampered = await journal.pushCheckpoint({
      bundle: fs.readFileSync(bundlePath),
      manifest: lie,
      cursor: cursorFromCheckpoint(head),
      parentCheckpointId: head.checkpointId,
    });

    const err = await failure(
      on(b, () => restoreNexusVault(vopts(b, { mode: 'pull', force: true }))),
    );
    expect(err.code).toBe('E_NEXUS_VAULT_VERIFY_FAILED');
    expect(err.message).toContain('tasks_tasks');
    expect(err.message).toContain(tampered.checkpointId);
    expect(sha256Hex(fs.readFileSync(dbFile))).toBe(before);
    expect(fs.readFileSync(b.state.path, 'utf8')).toBe(syncedBefore);

    // A new-machine restore of it places nothing either.
    const c = await machine('c', '0198a1b2-0000-7000-8000-0000000000d3', uuidv7());
    const err2 = await failure(
      on(c, () =>
        restoreNexusVault(vopts(c, { mode: 'restore', projectId: REMOTE_PROJECT, into: c.root })),
      ),
    );
    expect(err2.code).toBe('E_NEXUS_VAULT_VERIFY_FAILED');
    expect(fs.existsSync(path.join(c.root, '.cleo', 'cleo.db'))).toBe(false);
  });
});

describe('cloud vault key escrow', () => {
  it('g: the first device mints and escrows; the next device opens the same key sealed to it', async () => {
    const a = await machine('a', DEVICE_A, REPLICA_A);
    const b = await machine('b', DEVICE_B, REPLICA_B);
    const ka = await on(a, async () => unlockNexusAccountKey(await connectNexusVault(vopts(a))));
    expect(fake.escrow?.mk.equals(ka.masterKey)).toBe(true);
    expect(ka.keyVersion).toBe(1);
    const kb = await on(b, async () => unlockNexusAccountKey(await connectNexusVault(vopts(b))));
    expect(kb.masterKey.equals(ka.masterKey)).toBe(true);
    // B trusts A's signing key (certified under the shared key) and its own.
    expect(kb.signers.has(DEVICE_A)).toBe(true);
    expect(kb.signers.has(DEVICE_B)).toBe(true);
    // Trust state persisted per machine.
    expect(b.state.trust(API, USER).keyVersion).toBe(1);
  });

  it('g: verify and status are read-only: no escrow is minted, no certificate written', async () => {
    const a = await machine('a', DEVICE_A, REPLICA_A);
    fake.addProject(REMOTE_PROJECT, { [REPLICA_A]: DEVICE_A });
    seedProject(a, 2);
    link(a);
    for (const run of [verifyNexusVault, nexusVaultStatus]) {
      const err = await failure(on(a, () => run(vopts(a))));
      expect(err.code).toBe('E_NEXUS_VAULT_KEY_UNAVAILABLE');
    }
    expect(fake.escrow).toBeNull();
    expect(fake.certificates).toEqual([]);
    expect(fake.projectKeys.size).toBe(0);
  });

  it('g: verify on a device that never certified reads trust without writing it', async () => {
    const { a, b } = await twoMachines();
    await on(a, () => pushNexusVault(vopts(a)));
    seedProject(b, 5);
    link(b);
    const before = fake.certificates.length;
    const vb = await on(b, () => verifyNexusVault(vopts(b)));
    expect(fake.certificates).toHaveLength(before);
    expect(vb.head?.deviceId).toBe(DEVICE_A);
    expect(vb.warnings.some((w) => w.code === 'W_NEXUS_VAULT_UNTRUSTED_SNAPSHOT')).toBe(false);
  });

  it('g: a device that loses the escrow race reads the winner key', async () => {
    const a = await machine('a', DEVICE_A, REPLICA_A);
    const winner = randomBytes(32);
    fake.beforeEscrowPut = () => {
      fake.beforeEscrowPut = null;
      fake.escrow = {
        mk: winner,
        keyVersion: 1,
        verifier: masterKeyVerifier(winner),
        updatedAt: NOW,
      };
    };
    const ka = await on(a, async () => unlockNexusAccountKey(await connectNexusVault(vopts(a))));
    expect(ka.masterKey.equals(winner)).toBe(true);
  });

  it('g: an escrow that does not match its verifier is refused', async () => {
    const a = await machine('a', DEVICE_A, REPLICA_A);
    fake.escrow = {
      mk: randomBytes(32),
      keyVersion: 1,
      verifier: masterKeyVerifier(randomBytes(32)),
      updatedAt: NOW,
    };
    const err = await failure(
      on(a, async () => unlockNexusAccountKey(await connectNexusVault(vopts(a)))),
    );
    expect(err.code).toBe('E_NEXUS_VAULT_KEY_UNAVAILABLE');
  });
});

describe('cloud activity', () => {
  it('h: names devices and filters by project', async () => {
    const a = await machine('a', DEVICE_A, REPLICA_A);
    await machine('b', DEVICE_B, REPLICA_B);
    fake.activity = [
      {
        id: 1,
        at: NOW,
        actorUserId: USER,
        actorDeviceId: DEVICE_A,
        action: 'project.link',
        target: `project:${REMOTE_PROJECT}`,
      },
      {
        id: 2,
        at: NOW,
        actorUserId: USER,
        actorDeviceId: DEVICE_B,
        action: 'checkpoint.create',
        target: STREAM,
      },
      {
        id: 3,
        at: NOW,
        actorUserId: USER,
        actorDeviceId: DEVICE_B,
        action: 'checkpoint.create',
        target: `project:${OTHER_PROJECT}`,
      },
      {
        id: 4,
        at: NOW,
        actorUserId: USER,
        actorDeviceId: null,
        action: 'device.enrol',
        target: null,
      },
      {
        id: 5,
        at: NOW,
        actorUserId: USER,
        actorDeviceId: '0198a1b2-0000-7000-8000-0000000000ff',
        action: 'lease.acquire',
        target: HOME_STREAM,
      },
    ];
    const all = await on(a, () => nexusCloudActivity(vopts(a)));
    expect(all.items.map((i) => i.action)).toEqual([
      'lease.acquire',
      'device.enrol',
      'checkpoint.create',
      'checkpoint.create',
      'project.link',
    ]);
    expect(all.items[0]).toMatchObject({ deviceName: null, thisDevice: false });
    expect(all.items[1]).toMatchObject({ deviceId: null, deviceName: null, target: null });
    expect(all.items[2]).toMatchObject({ deviceName: 'b-laptop', thisDevice: false });
    expect(all.items[4]).toMatchObject({ deviceName: 'a-laptop', thisDevice: true });
    expect(all.nextBefore).toBeNull();

    const one = await on(a, () =>
      nexusCloudActivity(vopts(a, { projectId: REMOTE_PROJECT, limit: 10 })),
    );
    expect(one.projectId).toBe(REMOTE_PROJECT);
    expect(one.items.map((i) => i.target)).toEqual([STREAM, `project:${REMOTE_PROJECT}`]);

    const paged = await on(a, () => nexusCloudActivity(vopts(a, { limit: 2 })));
    expect(paged.items).toHaveLength(2);
    expect(paged.nextBefore).toBe('4');

    const byDevice = await on(a, () => nexusCloudActivity(vopts(a, { deviceId: DEVICE_B })));
    expect(byDevice.items.map((i) => [i.deviceId, i.target])).toEqual([
      [DEVICE_B, `project:${OTHER_PROJECT}`],
      [DEVICE_B, STREAM],
    ]);
    const both = await on(a, () =>
      nexusCloudActivity(vopts(a, { deviceId: DEVICE_B, projectId: REMOTE_PROJECT })),
    );
    expect(both.items.map((i) => i.target)).toEqual([STREAM]);
  });

  it('h: follows nextBefore across pages under a filter, within the page budget', async () => {
    const a = await machine('a', DEVICE_A, REPLICA_A);
    await machine('b', DEVICE_B, REPLICA_B);
    fake.activityPageSize = 2;
    fake.activity = Array.from({ length: 9 }, (_, i) => ({
      id: i + 1,
      at: NOW,
      actorUserId: USER,
      // B acted at ids 1, 2 and 6; A at every other id.
      actorDeviceId: [1, 2, 6].includes(i + 1) ? DEVICE_B : DEVICE_A,
      action: 'checkpoint.create',
      target: STREAM,
    }));
    const calls: string[] = [];
    const counting: FetchLike = (input, init) => {
      if (new URL(input).pathname === '/v1/account/activity') calls.push(input);
      return fake.fetch(input, init);
    };
    const all = await on(a, () =>
      nexusCloudActivity({ ...vopts(a), fetch: counting, deviceId: DEVICE_B }),
    );
    // Pages (9,8) (7,6) (5,4) (3,2) (1): five requests, all of B's events, server exhausted.
    expect(all.items.map((i) => i.deviceId)).toEqual([DEVICE_B, DEVICE_B, DEVICE_B]);
    expect(calls).toHaveLength(5);
    expect(calls.every((u) => new URL(u).searchParams.get('limit') === '200')).toBe(true);
    expect(new URL(calls[1] ?? '').searchParams.get('before')).toBe('8');
    expect(all.nextBefore).toBeNull();

    // A budget of two pages stops early and hands back where the server stopped.
    const budget = await on(a, () =>
      nexusCloudActivity(vopts(a, { deviceId: DEVICE_B, maxPages: 2 })),
    );
    expect(budget.items).toHaveLength(1);
    expect(budget.nextBefore).toBe('6');

    // Filling the limit mid-page: nextBefore is the last event returned.
    const filled = await on(a, () =>
      nexusCloudActivity(vopts(a, { deviceId: DEVICE_B, limit: 2 })),
    );
    expect(filled.items).toHaveLength(2);
    expect(filled.nextBefore).toBe('2');
  });
});

describe('cloud vault global scope', () => {
  /** A global store with the real schema and a few registry rows. */
  async function seedHome(m: Machine, registry: string[]): Promise<void> {
    await on(m, async () => {
      await openDualScopeDb('global');
      _resetDualScopeDbCache();
    });
    const db = new DatabaseSync(path.join(m.home, 'cleo.db'));
    const ins = db.prepare(
      'INSERT INTO nexus_project_registry (project_id, project_hash, project_path, name) VALUES (?, ?, ?, ?)',
    );
    for (const id of registry) ins.run(id, `hash-${id}`, `/projects/${id}`, id);
    db.close();
  }

  function homeSql<T>(m: Machine, query: string): T[] {
    const db = new DatabaseSync(path.join(m.home, 'cleo.db'));
    try {
      return db.prepare(query).all() as T[];
    } finally {
      db.close();
    }
  }

  it('i: pushes the home stream and restores it on another device, keeping machine-local rows', async () => {
    const a = await machine('a', DEVICE_A, REPLICA_A);
    const b = await machine('b', DEVICE_B, REPLICA_B);
    await seedHome(a, ['p1', 'p2']);
    await seedHome(b, []);
    // Each machine binds its own global replica (machine-local `_sync_replica` rows).
    const replicaRows = (m: Machine) =>
      homeSql<{ replica_id: string }>(m, 'SELECT replica_id FROM _sync_replica ORDER BY 1');

    const pushed = await on(a, () => pushNexusVault(vopts(a, { scope: 'global' })));
    expect(pushed.status).toBe('pushed');
    expect(pushed.scope).toBe('global');
    expect(pushed.streamId).toBe(HOME_STREAM);
    const cp = fake.stream(HOME_STREAM).checkpoints[0];
    expect(cp?.manifest.tables['nexus_project_registry']?.rows).toBe(2);
    expect(cp?.manifest.tables['_sync_replica']).toBeUndefined();
    // The snapshot names A's own global replica.
    const replicasA = replicaRows(a);
    expect(replicasA.map((r) => r.replica_id)).toContain(cp?.replicaId);
    const again = await on(a, () => pushNexusVault(vopts(a, { scope: 'global' })));
    expect(again.status).toBe('up-to-date');

    // B binds its replica on its first vault command (a status read).
    await on(b, () => nexusVaultStatus(vopts(b, { scope: 'global' })));
    const replicasB = replicaRows(b);
    expect(replicasB.length).toBeGreaterThan(0);
    expect(replicasB).not.toEqual(replicasA);
    const restored = await on(b, () =>
      restoreNexusVault(vopts(b, { scope: 'global', mode: 'pull' })),
    );
    expect(restored.status).toBe('restored');
    expect(restored.verified).toBe(true);
    expect(restored.target).toBe(b.home);
    expect(
      homeSql<{ project_id: string }>(
        b,
        'SELECT project_id FROM nexus_project_registry ORDER BY 1',
      ),
    ).toEqual([{ project_id: 'p1' }, { project_id: 'p2' }]);
    expect(replicaRows(b)).toEqual(replicasB);
    // B's device credential and vault state are still its own.
    expect(fs.existsSync(path.join(b.home, 'nexus-device.json'))).toBe(true);
    const vb = await on(b, () => verifyNexusVault(vopts(b, { scope: 'global' })));
    expect(vb.verdict).toBe('match');

    // B changes the global store and pushes; A pulls it.
    const db = new DatabaseSync(path.join(b.home, 'cleo.db'));
    db.exec(
      "INSERT INTO nexus_project_registry (project_id, project_hash, project_path, name) VALUES ('p3', 'hash-p3', '/projects/p3', 'p3')",
    );
    db.close();
    await on(a, () => releaseNexusVaultLease(vopts(a, { scope: 'global' })));
    const pushedB = await on(b, () => pushNexusVault(vopts(b, { scope: 'global' })));
    expect(pushedB.status).toBe('pushed');
    expect(pushedB.parentCheckpointId).toBe(cp?.checkpointId);
    const pulled = await on(a, () =>
      restoreNexusVault(vopts(a, { scope: 'global', mode: 'pull' })),
    );
    expect(pulled.status).toBe('restored');
    expect(homeSql(a, 'SELECT COUNT(*) AS n FROM nexus_project_registry')).toEqual([{ n: 3 }]);
    expect(replicaRows(a)).toEqual(replicasA);
  });
});
