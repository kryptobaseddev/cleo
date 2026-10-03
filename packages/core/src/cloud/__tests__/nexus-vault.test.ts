/**
 * The cloud vault (`cleo cloud push | pull | restore | verify | lease`) and
 * `cleo cloud activity` against an in-process fake Cleo Nexus API: two
 * simulated devices (separate CLEO homes, device stores and project copies)
 * share one fake server's state. The fake follows the cleo-nexus route
 * semantics the vault relies on: segment and checkpoint signatures (v2 and
 * v3 domains), the segment contract (txnDeltas sum check), replicaSeq
 * continuity (E_CONFLICT), lineage (E_LINEAGE), the exact checkpoint rule of
 * journal spec §2.11 with the v3 ratchet (E_REGRESSION, E_MANIFEST_ACCOUNTING,
 * E_STREAM_VERSION via checkManifestV3) and the stream's voided set, the
 * replica map check, blob presign/upload/complete, writer leases
 * (E_LEASE_HELD, forced takes labelled as forks) and key escrow.
 *
 * No request leaves the process; every store lives in a temp directory.
 *
 * @task T12336
 * @task T12337
 * @task T12338
 * @task T12951
 * @task T13034
 * @epic T12322
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { type PortableBundleManifest, SYNC_SCHEMA_VERSION } from '@cleocode/contracts';
import {
  AppendSegmentRequest,
  type Checkpoint,
  type DeviceCertificateRecord,
  Manifest,
  type ReplicaHeads,
  type Segment,
  type TableDeltas,
} from '@cleocode/contracts/cloud';
import { create as tarCreate, extract as tarExtract } from 'tar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetDualScopeDbCache, openDualScopeDb } from '../../store/dual-scope-db.js';
import { computeManifestHash, exportPortableBundle } from '../../store/portable-bundle.js';
import { ensureSyncSchema } from '../../store/sync/schema.js';
import {
  emptyVaultTableHash,
  VAULT_FORMAT_KEY,
  VAULT_MANIFEST_FORMAT_VERSION,
  vaultFormatEntry,
} from '../../store/vault-manifest.js';
import {
  deriveKey,
  generateEd25519,
  generateX25519,
  type KeyPair,
  open as openAead,
  sealTo,
  sha256Hex,
  uuidv7,
  verifyEd25519,
} from '../crypto.js';
import { type FetchLike, Http } from '../http.js';
import {
  cursorFromCheckpoint,
  Journal,
  manifestHash,
  replicasHash,
  segmentMetaHash,
} from '../journal.js';
import { masterKeyVerifier, unwrapProjectKey } from '../keys.js';
import {
  checkManifestV3,
  type DeclaredTxn,
  manifestVersion,
  nextVoidedSet,
  schemaRises,
  txnRefKey,
  windowOf,
} from '../manifest-check.js';
import { NexusAccountError } from '../nexus-auth.js';
import { nexusCloudActivity } from '../nexus-cloud-activity.js';
import { FileNexusTokenStore } from '../nexus-credentials.js';
import {
  applyEnrolment,
  NEXUS_DEVICE_ENV,
  NexusDeviceEnrolment,
  NexusDeviceStore,
} from '../nexus-device.js';
import { hasUnsyncedNexusBackup, runNexusFirstRun } from '../nexus-first-run.js';
import { listNexusNamedProjects, resolveNexusProjectRef } from '../nexus-project-names.js';
import {
  nexusVaultStatus,
  pushNexusVault,
  releaseNexusVaultLease,
  restoreNexusVault,
  verifyNexusVault,
} from '../nexus-vault.js';
import {
  connectNexusVault,
  escrowContext,
  nexusHomeDataKey,
  unlockNexusAccountKey,
} from '../nexus-vault-keys.js';
import { NexusVaultState } from '../nexus-vault-state.js';
import {
  checkpointSigningMessage,
  replicasCanonical,
  segmentSigningMessage,
  segmentSigningVersion,
} from '../signing.js';

/** Runs just before the vault places a verified snapshot (after its safety export). */
const importHooks = vi.hoisted(() => ({ beforeImport: null as (() => void) | null }));
vi.mock('../../store/portable-bundle-import.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../store/portable-bundle-import.js')>();
  return {
    ...mod,
    importPortableBundle: async (input: Parameters<typeof mod.importPortableBundle>[0]) => {
      importHooks.beforeImport?.();
      return mod.importPortableBundle(input);
    },
  };
});

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
  /** The stream's cumulative voided set (journal spec §2.11 §4), moved by each accepted checkpoint. */
  voided: DeclaredTxn[];
}

/** The declared transactions of segments: a v2 segment is one transaction (txn 0) with its deltas. */
function txnsOf(segments: readonly Segment[]): DeclaredTxn[] {
  return segments.flatMap((x) =>
    (x.txnDeltas ?? [{ txn: 0, deltas: x.deltas }]).map((t) => ({
      ref: { replicaId: x.replicaId, replicaSeq: x.replicaSeq, txn: t.txn },
      deltas: t.deltas,
    })),
  );
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
    /** The server's message, when a test depends on it (cleo-nexus's "route not found", T13049). */
    readonly serverMessage?: string,
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
  /** `false` plays a server older than account key escrow (cleo-nexus T082): no escrow routes (T13049). */
  escrowRoutes = true;
  /** `true` answers the escrow route with a bare HTML 404, as a proxy or a wrong URL would (T13049). */
  escrowHtml404 = false;
  /** Runs before an escrow PUT is applied (simulates a concurrent first device). */
  beforeEscrowPut: (() => void) | null = null;
  projectKeys = new Map<string, Array<{ wrappedProjectKey: string; keyVersion: number }>>();
  /** projectId -> what `GET /v1/projects` (E13) reports as its label and encrypted name (T13102). */
  projectNames = new Map<string, { label: string | null; encryptedName: string | null }>();
  /** projectId -> replicaId -> deviceId. */
  replicas = new Map<string, Map<string, string>>();
  streams = new Map<string, FakeStream>();
  blobs = new Map<string, { size: number; bytes: Buffer | null; verified: boolean }>();
  leases = new Map<string, FakeLease>();
  activity: FakeActivity[] = [];
  /** Every mutating API request (method and path), in order. */
  writes: string[] = [];
  /** Runs once before the next segment append by `deviceId` (simulates a concurrent device). */
  beforeSegment: { deviceId: string; run: () => Promise<void> } | null = null;
  /** Codes the next checkpoint creates are refused with, in order. */
  refuseCheckpoint: string[] = [];
  /** Runs once before the next checkpoint create by `deviceId` (simulates a concurrent author). */
  beforeCheckpoint: { deviceId: string; run: () => Promise<void> } | null = null;
  /** The server's MAX_SCHEMA_VERSION. */
  maxSchemaVersion = 10_000;
  /** Whether the stream head carries `maxSchemaVersion` (a server from before it does not). */
  reportMaxSchemaVersion = true;
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
      voided: [],
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
        voided: [],
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
    if (this.escrowHtml404 && url.pathname.endsWith('/v1/account/keys/escrow')) {
      return new Response('<html><body>Not Found</body></html>', {
        status: 404,
        headers: { 'content-type': 'text/html' },
      });
    }
    try {
      if (url.origin === BLOB_HOST) return this.blob(method, url, init);
      const token = (new Headers(init?.headers).get('authorization') ?? '').replace(/^Bearer /, '');
      const device = [...this.devices.values()].find((d) => d.token === token);
      if (!device) throw new ApiFail(401, 'E_UNAUTHENTICATED');
      const body =
        typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      if (method !== 'GET') this.writes.push(`${method} ${url.pathname}`);
      const hook = this.beforeSegment;
      if (
        hook !== null &&
        hook.deviceId === device.deviceId &&
        method === 'POST' &&
        url.pathname.endsWith('/segments')
      ) {
        this.beforeSegment = null;
        await hook.run();
      }
      const cpHook = this.beforeCheckpoint;
      if (
        cpHook !== null &&
        cpHook.deviceId === device.deviceId &&
        method === 'POST' &&
        url.pathname.endsWith('/checkpoints')
      ) {
        this.beforeCheckpoint = null;
        await cpHook.run();
      }
      return this.route(device, method, url, body);
    } catch (err) {
      if (err instanceof ApiFail) {
        return json(err.status, {
          success: false,
          error: {
            code: err.code,
            message: err.serverMessage ?? `${err.code} from fake`,
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
    if (!this.escrowRoutes && route.endsWith(' /v1/account/keys/escrow')) {
      throw new ApiFail(404, 'E_NOT_FOUND', undefined, 'route not found');
    }
    if (route === 'GET /v1/account/keys/escrow') {
      if (!this.escrow) throw new ApiFail(404, 'E_NOT_FOUND', undefined, 'key escrow not found');
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
    m = route.match(/^GET \/v1\/projects\/([^/]+)$/);
    if (m) {
      // E14 (T13102): enough of the project detail for the first run's unsynced-backup check.
      const projectId = decodeURIComponent(m[1] ?? '');
      const replicas = this.replicas.get(projectId);
      if (!replicas) throw new ApiFail(404, 'E_NOT_FOUND');
      const s = this.streams.get(`project:${projectId}`);
      return this.ok({
        project: {
          projectId,
          label: this.projectNames.get(projectId)?.label ?? null,
          organizationId: ORG,
        },
        role: 'owner',
        openConflicts: 0,
        replicas: [],
        devices: { active: replicas.size, total: replicas.size },
        truncated: false,
        stream: s
          ? { streamId: s.streamId, headSeq: s.headSeq, headCheckpointId: s.headCheckpointId }
          : null,
      });
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
    if (route === 'GET /v1/projects') {
      return this.ok({
        projects: [...this.replicas].map(([projectId, replicas]) => {
          const s = this.streams.get(`project:${projectId}`);
          const names = this.projectNames.get(projectId);
          return {
            projectId,
            label: names?.label ?? null,
            encryptedName: names?.encryptedName ?? null,
            remoteUrl: null,
            organizationId: ORG,
            organizationName: 'Personal',
            createdByUserId: USER,
            createdAt: NOW,
            role: 'owner',
            streamId: `project:${projectId}`,
            headSeq: s?.headSeq ?? 0,
            headCheckpointId: s?.headCheckpointId ?? null,
            openConflicts: 0,
            replicas: [...replicas].map(([replicaId, deviceId]) => ({
              projectId,
              replicaId,
              deviceId,
              deviceName: this.devices.get(deviceId)?.name ?? 'device',
              attachedAt: NOW,
              lastSyncAt: null,
              presence: null,
              presenceAt: null,
            })),
            replicasTruncated: false,
          };
        }),
        nextCursor: null,
        truncated: false,
      });
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
        // As the server keeps it: 0, raised to each appended segment's schemaVersion.
        ...(this.reportMaxSchemaVersion
          ? { maxSchemaVersion: Math.max(0, ...s.segments.map((x) => x.schemaVersion)) }
          : {}),
      });
    }
    if (route === 'POST /segments') {
      // The server parses the contract (with the txnDeltas sum check) and verifies the signature
      // under the domain the metadata picks (segment/v2, or v3 with txnDeltas).
      const parsed = AppendSegmentRequest.safeParse(body);
      if (!parsed.success) throw new ApiFail(400, 'E_VALIDATION');
      const req = parsed.data;
      if (req.deviceId !== dev.deviceId) throw new ApiFail(403, 'E_FORBIDDEN');
      if (req.schemaVersion > this.maxSchemaVersion) throw new ApiFail(422, 'E_SCHEMA_AHEAD');
      const signed = segmentSigningMessage({
        streamId,
        replicaId: req.replicaId,
        deviceId: dev.deviceId,
        replicaSeq: req.replicaSeq,
        segmentHash: req.segmentHash,
        metaHash: segmentMetaHash(req),
        version: segmentSigningVersion(req),
      });
      if (
        !verifyEd25519(
          Buffer.from(dev.signingPublicKey, 'base64'),
          signed,
          Buffer.from(req.signature, 'base64'),
        )
      ) {
        throw new ApiFail(403, 'E_FORBIDDEN', { reason: 'bad-segment-signature' });
      }
      const replicaId = req.replicaId;
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
        txnDeltas: req.txnDeltas ?? null,
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
      const parsedManifest = Manifest.safeParse(body['manifest']);
      if (!parsedManifest.success) throw new ApiFail(400, 'E_VALIDATION');
      const manifest = parsedManifest.data;
      const signed = checkpointSigningMessage({
        streamId,
        checkpointId: body['checkpointId'] as string,
        parentCheckpointId: (body['parentCheckpointId'] as string | null) ?? null,
        replicaId: body['replicaId'] as string,
        deviceId: dev.deviceId,
        coversSeq: body['coversSeq'] as number,
        manifestHash: manifestHash(manifest),
        replicasHash: replicasHash(body['replicas'] as ReplicaHeads),
        blobSha256: body['blobSha256'] as string,
        sizeBytes: body['sizeBytes'] as number,
        version: manifestVersion(manifest),
      });
      if (
        !verifyEd25519(
          Buffer.from(dev.signingPublicKey, 'base64'),
          signed,
          Buffer.from(body['signature'] as string, 'base64'),
        )
      ) {
        throw new ApiFail(403, 'E_FORBIDDEN', { reason: 'bad-checkpoint-signature' });
      }
      const refuse = this.refuseCheckpoint.shift();
      if (refuse === 'E_STREAM_VERSION') {
        // As the server words its v3 ratchet refusal.
        throw new ApiFail(409, refuse, {
          verdict: {
            ok: false,
            code: 'E_STREAM_VERSION',
            reason: 'stream-v3',
            parentVersion: 3,
            nextVersion: 2,
          },
        });
      }
      if (refuse !== undefined) throw new ApiFail(409, refuse);
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
      // The exact rule of journal spec §2.11 (cleo-nexus checkManifestV3): a v2 manifest is the v3
      // one with empty lists, a v2 segment one transaction; after a v3 checkpoint a v2 one is refused.
      const window = s.segments.filter((x) => x.seq > fromSeq && x.seq <= coversSeq);
      const parentPending = new Set((parent?.manifest.pending ?? []).map(txnRefKey));
      const verdict = checkManifestV3({
        parent: parent?.manifest ?? null,
        next: manifest,
        window: windowOf(
          txnsOf(window),
          window.map((x) => ({ seq: x.seq, schemaVersion: x.schemaVersion })),
        ),
        parentPending: txnsOf(s.segments.filter((x) => x.seq <= fromSeq)).filter((t) =>
          parentPending.has(txnRefKey(t.ref)),
        ),
        voidedBefore: s.voided,
        maxAcceptedSchemaVersion: this.maxSchemaVersion,
      });
      if (!verdict.ok) {
        this.record(dev, `checkpoint.refused.${verdict.code}`, streamId);
        throw new ApiFail(verdict.code === 'E_SCHEMA_AHEAD' ? 422 : 409, verdict.code, {
          verdict,
        });
      }
      const cp: Checkpoint = {
        checkpointId: body['checkpointId'] as string,
        streamId,
        parentCheckpointId: parentId,
        replicaId: body['replicaId'] as string,
        deviceId: dev.deviceId,
        coversSeq,
        manifest,
        replicas: body['replicas'] as ReplicaHeads,
        blobSha256: body['blobSha256'] as string,
        sizeBytes: body['sizeBytes'] as number,
        signature: body['signature'] as string,
        endorsements: [],
        createdAt: new Date(Date.parse(NOW) + s.checkpoints.length * 1000).toISOString(),
      };
      s.checkpoints.push(cp);
      s.headCheckpointId = cp.checkpointId;
      s.voided = nextVoidedSet(s.voided, manifest.voided ?? [], manifest.revived ?? []);
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
  importHooks.beforeImport = null;
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
    // The lease is handed back once the push is done (T12971).
    expect(first.lease).toBeNull();
    expect(fake.leases.size).toBe(0);
    expect(first.snapshot?.deviceName).toBe('a-laptop');
    const cp = fake.stream(STREAM).checkpoints[0];
    expect(cp?.parentCheckpointId).toBeNull();
    // Only syncing, non-secret tables are in the plaintext manifest.
    // (plus the plain-file inventory, T12969, and the format record, T13034).
    expect(Object.keys(cp?.manifest.tables ?? {}).sort()).toEqual([
      'brain_observations',
      'tasks_sessions',
      'tasks_tasks',
      'zz_vault_files',
      'zz_vault_format',
    ]);
    expect(cp?.manifest.tables['tasks_tasks']?.rows).toBe(5);
    // The uploaded bundle is ciphertext: no plaintext row content or credential leaks.
    const blob = fake.blobs.get(cp?.blobSha256 ?? '')?.bytes ?? Buffer.alloc(0);
    expect(blob.length).toBeGreaterThan(0);
    expect(blob.includes(Buffer.from('task 1'))).toBe(false);
    expect(blob.includes(Buffer.from('OWNER-TOKEN-SECRET'))).toBe(false);

    const again = await on(a, () => pushNexusVault(vopts(a)));
    expect(again.status).toBe('up-to-date');
    expect(again.lease).toBeNull();
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
    expect(status.leases).toEqual([]);
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
    // B's restore is read-only: it opened the escrowed key but certified nothing (T12974).
    expect(fake.certificates.map((c) => c.deviceId)).toEqual([DEVICE_A]);

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

  it('a project restore refuses a target holding another project unless --force (T12976)', async () => {
    const { a } = await twoMachines();
    await on(a, () => pushNexusVault(vopts(a)));
    const c = await machine('c', '0198a1b2-0000-7000-8000-0000000000d3', uuidv7());
    fs.mkdirSync(path.join(c.root, '.cleo'), { recursive: true });
    fs.writeFileSync(path.join(c.root, '.cleo', 'project-id'), `${OTHER_PROJECT}\n`);
    const opts = { mode: 'restore', projectId: REMOTE_PROJECT, into: c.root } as const;
    const err = await failure(on(c, () => restoreNexusVault(vopts(c, opts))));
    expect(err.code).toBe('E_NEXUS_VAULT_TARGET_OCCUPIED');
    expect(err.message).toContain(OTHER_PROJECT);
    expect(fs.existsSync(path.join(c.root, '.cleo', 'cleo.db'))).toBe(false);
    const forced = await on(c, () => restoreNexusVault(vopts(c, { ...opts, force: true })));
    expect(forced.status).toBe('restored');
    expect(taskCount(c)).toBe(5);
  });

  it('d: a stale push is refused, a pull never overwrites local changes, --force does with a backup', async () => {
    const { a, b } = await twoMachines();
    await on(a, () => pushNexusVault(vopts(a)));
    await restoreOntoB(b);
    // A's push already handed the write lease back.
    const released = await on(a, () => releaseNexusVaultLease(vopts(a)));
    expect(released.released).toBe(false);

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
    // A's credentials survive: the snapshot carried them cleared (T12966).
    expect(sql(a, 'SELECT owner_auth_token FROM tasks_sessions')).toEqual([
      { owner_auth_token: 'OWNER-TOKEN-SECRET' },
    ]);
    expect(sql(a, 'SELECT api_key_encrypted FROM tasks_agent_credentials')).toEqual([
      { api_key_encrypted: 'API-KEY-SECRET' },
    ]);
    expect(forced.warnings.some((w) => w.code === 'W_NEXUS_VAULT_CREDENTIALS_LOST')).toBe(false);
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
    const heldPush = await on(a, () => pushNexusVault(vopts(a, { hold: true })));
    expect(heldPush.lease?.mine).toBe(true);
    await restoreOntoB(b);
    exec(b, "INSERT INTO tasks_tasks (id, title) VALUES ('B1', 'from b')");

    const held = await failure(on(b, () => pushNexusVault(vopts(b))));
    expect(held.code).toBe('E_NEXUS_VAULT_LEASE_HELD');
    expect(held.message).toContain(REPLICA_A);

    const forced = await on(b, () => pushNexusVault(vopts(b, { force: true, hold: true })));
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
    exec(b, "INSERT INTO tasks_tasks (id, title) VALUES ('B1', 'from b')");
    await on(b, () => pushNexusVault(vopts(b, { hold: true })));
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
    exec(a, "INSERT INTO tasks_tasks (id, title) VALUES ('A1', 'from a')");
    // Refused twice: the retry after a re-replay (T12975) is refused too.
    fake.refuseCheckpoint = ['E_REGRESSION', 'E_REGRESSION'];
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

describe('cloud vault snapshot coverage beyond cleo.db (T12969)', () => {
  it('a new doc is pushed, and an unsynced doc change blocks a pull without --force', async () => {
    const { a, b } = await twoMachines();
    await on(a, () => pushNexusVault(vopts(a)));
    const filesBefore = fake.stream(STREAM).checkpoints[0]?.manifest.tables['zz_vault_files'];

    // `cleo docs add` writes a document and a blob manifest row.
    fs.mkdirSync(path.join(a.root, '.cleo', 'adrs'), { recursive: true });
    fs.writeFileSync(path.join(a.root, '.cleo', 'adrs', 'adr-1.md'), '# ADR 1\n');
    fs.mkdirSync(path.join(a.root, '.cleo', 'blobs'), { recursive: true });
    const blobs = new DatabaseSync(path.join(a.root, '.cleo', 'blobs', 'manifest.db'));
    blobs.exec(
      "CREATE TABLE blobs (sha TEXT PRIMARY KEY, size INTEGER); INSERT INTO blobs VALUES ('aa', 1);",
    );
    blobs.close();
    const pushed = await on(a, () => pushNexusVault(vopts(a)));
    expect(pushed.status).toBe('pushed');
    const cp = fake.stream(STREAM).checkpoints.at(-1);
    expect(cp?.manifest.tables['zz_vault_files']?.rows).toBe((filesBefore?.rows ?? 0) + 1);
    expect(cp?.manifest.tables['zz_vault_db_blobs_manifest_db']?.rows).toBe(1);
    expect(fake.stream(STREAM).segments.at(-1)?.deltas).toEqual({
      zz_vault_files: { created: 1, deleted: 0 },
      zz_vault_db_blobs_manifest_db: { created: 1, deleted: 0 },
    });
    // Editing the doc alone is a change too (same count, new hash).
    fs.writeFileSync(path.join(a.root, '.cleo', 'adrs', 'adr-1.md'), '# ADR 1, revised\n');
    const edited = await on(a, () => pushNexusVault(vopts(a)));
    expect(edited.status).toBe('pushed');
    expect(edited.deltaSegmentSeq).toBeNull();

    // B gets the doc; B pushes; A changes the doc without pushing, so A's pull refuses.
    await restoreOntoB(b);
    expect(fs.readFileSync(path.join(b.root, '.cleo', 'adrs', 'adr-1.md'), 'utf8')).toBe(
      '# ADR 1, revised\n',
    );
    const vb = await on(b, () => verifyNexusVault(vopts(b)));
    expect(vb.verdict).toBe('match');
    exec(b, "INSERT INTO tasks_tasks (id, title) VALUES ('B1', 'from b')");
    await on(b, () => pushNexusVault(vopts(b)));
    fs.writeFileSync(path.join(a.root, '.cleo', 'adrs', 'adr-1.md'), '# ADR 1, local edit\n');
    const refused = await failure(on(a, () => restoreNexusVault(vopts(a, { mode: 'pull' }))));
    expect(refused.code).toBe('E_NEXUS_VAULT_LOCAL_CHANGES');
    expect(refused.message).toContain('zz_vault_files');
    expect(fs.readFileSync(path.join(a.root, '.cleo', 'adrs', 'adr-1.md'), 'utf8')).toBe(
      '# ADR 1, local edit\n',
    );
    const forced = await on(a, () => restoreNexusVault(vopts(a, { mode: 'pull', force: true })));
    expect(forced.status).toBe('restored');
    expect(fs.readFileSync(path.join(a.root, '.cleo', 'adrs', 'adr-1.md'), 'utf8')).toBe(
      '# ADR 1, revised\n',
    );
  });
});

describe('cloud vault concurrency', () => {
  it('a segment another device appends mid-push is replayed once, and the push lands (T12975)', async () => {
    const { a, b } = await twoMachines();
    await on(a, () => pushNexusVault(vopts(a)));
    // B is certified, so A trusts its signature.
    await on(b, async () => unlockNexusAccountKey(await connectNexusVault(vopts(b))));
    const mk = fake.escrow?.mk ?? Buffer.alloc(0);
    const wrapped = fake.projectKeys.get(REMOTE_PROJECT)?.[0];
    const pdk = unwrapProjectKey(mk, wrapped?.wrappedProjectKey ?? '', REMOTE_PROJECT, 1);
    fake.beforeSegment = {
      deviceId: DEVICE_A,
      run: async () => {
        const journal = new Journal({
          http: new Http({ baseUrl: API, token: b.token, deviceId: b.deviceId, fetch: fake.fetch }),
          streamId: STREAM,
          replicaId: REPLICA_B,
          deviceId: DEVICE_B,
          signing: b.keys.signing,
          key: pdk,
          fetch: fake.fetch,
        });
        const hlc = `${String(Date.now()).padStart(13, '0')}-000000-${REPLICA_B}`;
        await journal.push(0, Buffer.from('{}'), {
          opCount: 1,
          hlcMin: hlc,
          hlcMax: hlc,
          deltas: { tasks_tasks: { created: 1, deleted: 0 } },
          schemaVersion: 1,
        });
      },
    };
    exec(a, "INSERT INTO tasks_tasks (id, title) VALUES ('A1', 'from a')");
    const pushed = await on(a, () => pushNexusVault(vopts(a)));
    expect(pushed.status).toBe('pushed');
    const s = fake.stream(STREAM);
    expect(s.segments.map((x) => [x.replicaId, x.replicaSeq])).toEqual([
      [REPLICA_B, 0],
      [REPLICA_A, 0],
      [REPLICA_A, 1],
    ]);
    // The retry's own correction makes the counts reconcile with B's segment counted.
    expect(s.segments[2]?.deltas).toEqual({ tasks_tasks: { created: 0, deleted: 1 } });
    expect(s.checkpoints.at(-1)?.coversSeq).toBe(3);
    expect(s.checkpoints.at(-1)?.manifest.tables['tasks_tasks']?.rows).toBe(6);
    expect(fake.leases.size).toBe(0);
  });

  it('a restore refuses while another process holds a writer lease on the store (T12973)', async () => {
    const { a, b } = await twoMachines();
    await on(a, () => pushNexusVault(vopts(a)));
    await restoreOntoB(b);
    exec(b, "INSERT INTO tasks_tasks (id, title) VALUES ('B1', 'from b')");
    await on(b, () => pushNexusVault(vopts(b)));
    exec(
      a,
      `CREATE TABLE _writer_leases (id INTEGER PRIMARY KEY, scope TEXT NOT NULL, lane TEXT NOT NULL,
         holder_id TEXT NOT NULL, holder_pid INTEGER NOT NULL, epoch INTEGER NOT NULL,
         acquired_at INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL, ttl_ms INTEGER NOT NULL,
         reentrancy_depth INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1);
       INSERT INTO _writer_leases (scope, lane, holder_id, holder_pid, epoch, acquired_at, heartbeat_at, ttl_ms)
         VALUES ('project', 'tasks', 'other', ${process.pid + 100000}, 1, ${Date.now()}, ${Date.now()}, 60000);`,
    );
    const dbFile = path.join(a.root, '.cleo', 'cleo.db');
    const before = sha256Hex(fs.readFileSync(dbFile));
    const busy = await failure(
      on(a, () => restoreNexusVault(vopts(a, { mode: 'pull', force: true }))),
    );
    expect(busy.code).toBe('E_NEXUS_VAULT_STORE_BUSY');
    expect(busy.message).toContain('tasks lane');
    expect(sha256Hex(fs.readFileSync(dbFile))).toBe(before);
    expect(taskCount(a)).toBe(5);

    // An idle connection another process holds open blocks too (#1773 M4).
    exec(a, 'UPDATE _writer_leases SET heartbeat_at = 0');
    const beforeIdle = sha256Hex(fs.readFileSync(dbFile));
    const idle = new DatabaseSync(dbFile);
    idle.prepare('SELECT COUNT(*) FROM tasks_tasks').get();
    const open = await failure(
      on(a, () => restoreNexusVault(vopts(a, { mode: 'pull', force: true }))),
    );
    expect(open.code).toBe('E_NEXUS_VAULT_STORE_BUSY');
    expect(open.message).toContain('open');
    idle.close();
    expect(sha256Hex(fs.readFileSync(dbFile))).toBe(beforeIdle);
    expect(taskCount(a)).toBe(5);

    // So does another database the restore replaces, held open elsewhere (T13007).
    const blobsFile = path.join(a.root, '.cleo', 'blobs', 'manifest.db');
    fs.mkdirSync(path.dirname(blobsFile), { recursive: true });
    const blobsHeld = new DatabaseSync(blobsFile);
    blobsHeld.exec('PRAGMA journal_mode = WAL; CREATE TABLE blobs (sha TEXT PRIMARY KEY);');
    blobsHeld.prepare('SELECT COUNT(*) FROM blobs').get();
    const blobsBusy = await failure(
      on(a, () => restoreNexusVault(vopts(a, { mode: 'pull', force: true }))),
    );
    expect(blobsBusy.code).toBe('E_NEXUS_VAULT_STORE_BUSY');
    expect(blobsBusy.message).toContain('manifest.db');
    blobsHeld.close();
    expect(taskCount(a)).toBe(5);

    // An expired lease (its holder died) and no open connection do not block.
    const restored = await on(a, () => restoreNexusVault(vopts(a, { mode: 'pull', force: true })));
    expect(restored.status).toBe('restored');
    expect(taskCount(a)).toBe(6);
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
      expect(err.code).toBe('E_NEXUS_VAULT_EMPTY');
    }
    expect(fake.escrow).toBeNull();
    expect(fake.certificates).toEqual([]);
    expect(fake.projectKeys.size).toBe(0);
    expect(fake.writes).toEqual([]);
  });

  it('a server without key escrow is UNSUPPORTED on push, pull, restore, verify and status, writing nothing (T13049)', async () => {
    fake.escrowRoutes = false;
    const a = await machine('a', DEVICE_A, REPLICA_A);
    fake.addProject(REMOTE_PROJECT, { [REPLICA_A]: DEVICE_A });
    seedProject(a, 2);
    link(a);
    const runs: Array<[string, () => Promise<object>]> = [
      ['push', () => pushNexusVault(vopts(a))],
      ['pull', () => restoreNexusVault(vopts(a, { mode: 'pull' }))],
      [
        'restore',
        () =>
          restoreNexusVault(
            vopts(a, { mode: 'restore', projectId: REMOTE_PROJECT, into: path.join(a.root, 'x') }),
          ),
      ],
      ['verify', () => verifyNexusVault(vopts(a))],
      ['status', () => nexusVaultStatus(vopts(a))],
    ];
    for (const [name, run] of runs) {
      const err = await failure(on(a, run));
      expect({ name, code: err.code }).toEqual({ name, code: 'E_NEXUS_VAULT_UNSUPPORTED' });
      expect(err.message).toMatch(/does not support the cloud vault/);
      expect(err.fix).toMatch(/key escrow/);
    }
    expect(fake.escrow).toBeNull();
    expect(fake.certificates).toEqual([]);
    expect(fake.writes).toEqual([]);
  });

  it('a 404 page that is not from Cleo Nexus is a failed request, not an empty vault (T13049)', async () => {
    fake.escrowHtml404 = true;
    const a = await machine('a', DEVICE_A, REPLICA_A);
    fake.addProject(REMOTE_PROJECT, { [REPLICA_A]: DEVICE_A });
    seedProject(a, 2);
    link(a);
    for (const run of [() => verifyNexusVault(vopts(a)), () => pushNexusVault(vopts(a))]) {
      const err = await failure(on(a, run));
      expect(err.code).toBe('E_NEXUS_REQUEST_FAILED');
    }
    expect(fake.escrow).toBeNull();
    expect(fake.writes).toEqual([]);
  });

  it('a supporting server with nothing escrowed yet stays EMPTY, not UNSUPPORTED (T13049)', async () => {
    const a = await machine('a', DEVICE_A, REPLICA_A);
    fake.addProject(REMOTE_PROJECT, { [REPLICA_A]: DEVICE_A });
    seedProject(a, 2);
    link(a);
    const err = await failure(on(a, () => verifyNexusVault(vopts(a))));
    expect(err.code).toBe('E_NEXUS_VAULT_EMPTY');
  });

  it('a restore on an account that never pushed is EMPTY and writes nothing (T12974)', async () => {
    const c = await machine('c', DEVICE_B, REPLICA_B);
    fake.addProject(REMOTE_PROJECT, { [REPLICA_B]: DEVICE_B });
    const err = await failure(
      on(c, () =>
        restoreNexusVault(vopts(c, { mode: 'restore', projectId: REMOTE_PROJECT, into: c.root })),
      ),
    );
    expect(err.code).toBe('E_NEXUS_VAULT_EMPTY');
    expect(fake.writes).toEqual([]);
    expect(fake.escrow).toBeNull();
    expect(fs.existsSync(path.join(c.root, '.cleo', 'cleo.db'))).toBe(false);
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
    for (const id of registry) ins.run(id, `hash-${m.name}-${id}`, `${m.home}/projects/${id}`, id);
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

  it('a vault snapshot carries no local change journal: capture, undo, frame, quarantine (T13042)', async () => {
    const a = await machine('a', DEVICE_A, REPLICA_A);
    await seedHome(a, ['p1']);
    const journal = ['_sync_capture', '_sync_undo', '_sync_frame', '_sync_quarantine'];
    const sentinel = 'JOURNAL-IMAGE-SENTINEL-T13042';
    const live = new DatabaseSync(path.join(a.home, 'cleo.db'));
    ensureSyncSchema(live, {
      root: path.resolve(import.meta.dirname, '../../../migrations/sync-journal'),
    });
    const img = JSON.stringify({ name: sentinel });
    live
      .prepare(
        "INSERT INTO _sync_capture (tbl, op, rk, img, at_ms, frame) VALUES ('nexus_project_registry', 'U', 'p1', ?, 0, 'f1')",
      )
      .run(img);
    live.exec("INSERT INTO _sync_frame (frame, kind) VALUES ('f1', 'test')");
    live
      .prepare(
        "INSERT INTO _sync_undo (seq, tbl, rk, op, before_full) VALUES (1, 'nexus_project_registry', 'p1', 'U', ?)",
      )
      .run(img);
    live
      .prepare(
        "INSERT INTO _sync_quarantine (seq, tbl, op, rk, img, at_ms, reason, quarantined_at_ms) VALUES (1, 'nexus_project_registry', 'U', 'p1', ?, 0, 'test', 0)",
      )
      .run(img);
    live.close();
    await on(a, () => pushNexusVault(vopts(a, { scope: 'global' })));
    const head = fake.stream(HOME_STREAM).checkpoints.at(-1);
    if (!head || !fake.escrow) throw new Error('fixture');
    const dir = path.join(base, 'opened');
    fs.mkdirSync(dir, { recursive: true });
    const gz = path.join(base, 'opened.tar.gz');
    fs.writeFileSync(
      gz,
      openAead(
        nexusHomeDataKey(fake.escrow.mk),
        fake.blobs.get(head.blobSha256)?.bytes ?? Buffer.alloc(0),
        'checkpoint',
        `checkpoint/v2\n${head.streamId}\n${head.checkpointId}\n${head.coversSeq}`,
      ),
    );
    expect(gunzipSync(fs.readFileSync(gz)).includes(Buffer.from(sentinel))).toBe(false);
    await tarExtract({ file: gz, cwd: dir });
    const manifest = JSON.parse(
      fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'),
    ) as PortableBundleManifest;
    const entry = manifest.global?.home.databases.find((d) => d.relPath === 'cleo.db');
    if (!entry) throw new Error('fixture: no cleo.db in the snapshot');
    const shipped = new DatabaseSync(path.join(dir, entry.bundlePath), { readOnly: true });
    try {
      for (const t of journal) {
        const n = (shipped.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
        expect({ t, n }).toEqual({ t, n: 0 });
      }
    } finally {
      shipped.close();
    }
    // The live journal is this device's and stays.
    for (const t of journal) {
      expect(homeSql<{ n: number }>(a, `SELECT count(*) AS n FROM ${t}`)).toEqual([{ n: 1 }]);
    }
  });

  it('i: pushes the home stream and restores it on another device, keeping machine-local state', async () => {
    const a = await machine('a', DEVICE_A, REPLICA_A);
    const b = await machine('b', DEVICE_B, REPLICA_B);
    await seedHome(a, ['p1', 'p2']);
    await seedHome(b, ['p1']);
    for (const m of [a, b]) {
      // Machine identity and runtime state (T12968).
      fs.writeFileSync(path.join(m.home, 'device-id'), `device-${m.name}\n`);
      fs.mkdirSync(path.join(m.home, 'state', 'sync'), { recursive: true });
      fs.writeFileSync(
        path.join(m.home, 'state', 'sync', `replicas-${m.name}.json`),
        `{"m":"${m.name}"}`,
      );
      // Credentials (T12966): an account secret (portable-secret table) and an agent key.
      const db = new DatabaseSync(path.join(m.home, 'cleo.db'));
      db.prepare(
        "INSERT INTO accounts (id, provider, label, auth_type, secret_enc) VALUES (?, 'p', ?, 'key', ?)",
      ).run(m.name === 'a' ? 1 : 2, `acct-${m.name}`, `SECRET-${m.name}`);
      db.prepare(
        "INSERT INTO agent_registry_agents (id, agent_id, name, created_at, updated_at, api_key_encrypted) VALUES ('ag1', 'ag1', 'agent', '2026-10-01', '2026-10-01', ?)",
      ).run(`KEY-${m.name}`);
      db.close();
    }
    for (const f of [
      'web-server.json',
      'sentient-state.json',
      'device-heartbeat.stamp',
      'nexus.db',
    ]) {
      fs.writeFileSync(path.join(a.home, f), 'machine a');
    }
    fs.mkdirSync(path.join(a.home, 'keys'), { recursive: true });
    fs.writeFileSync(path.join(a.home, 'keys', 'evidence-cache.key'), 'key a');
    // A git remote URL can embed a token: a `strip` column, never in a snapshot (T13007).
    const gitDb = new DatabaseSync(path.join(a.home, 'cleo.db'));
    gitDb
      .prepare(
        "INSERT INTO nexus_project_git_state (project_id, device_id, path, remote_url, probed_at) VALUES ('p2', 'device-a', '/a/p2', ?, '2026-10-01T00:00:00Z')",
      )
      .run('https://user:SEKRIT-TOKEN@git.example/r.git');
    gitDb.close();
    const tableExists = (m: Machine, t: string) =>
      homeSql(m, `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${t}'`).length >
      0;

    const pushed = await on(a, () => pushNexusVault(vopts(a, { scope: 'global' })));
    expect(pushed.status).toBe('pushed');
    expect(pushed.scope).toBe('global');
    expect(pushed.streamId).toBe(HOME_STREAM);
    const cp = fake.stream(HOME_STREAM).checkpoints[0];
    expect(cp?.manifest.tables['nexus_project_registry']?.rows).toBe(2);
    if (!cp || !fake.escrow) throw new Error('fixture');
    const sealed = fake.blobs.get(cp.blobSha256)?.bytes ?? Buffer.alloc(0);
    const tar = gunzipSync(
      openAead(
        nexusHomeDataKey(fake.escrow.mk),
        sealed,
        'checkpoint',
        `checkpoint/v2\n${cp.streamId}\n${cp.checkpointId}\n${cp.coversSeq}`,
      ),
    );
    expect(tar.includes(Buffer.from('nexus_project_git_state'))).toBe(true);
    expect(tar.includes(Buffer.from('SEKRIT-TOKEN'))).toBe(false);
    expect(cp?.manifest.tables['_sync_replica']).toBeUndefined();
    expect(cp?.manifest.tables['accounts']).toBeUndefined();
    // The snapshot names A's own global replica (bound by the push).
    const replicaRows = (m: Machine) =>
      tableExists(m, '_sync_replica')
        ? homeSql<{ replica_id: string }>(m, 'SELECT replica_id FROM _sync_replica ORDER BY 1')
        : [];
    const replicasA = replicaRows(a);
    expect(replicasA.map((r) => r.replica_id)).toContain(cp?.replicaId);
    const again = await on(a, () => pushNexusVault(vopts(a, { scope: 'global' })));
    expect(again.status).toBe('up-to-date');

    // Reads never write (T12974): B's status binds no replica.
    await on(b, () => nexusVaultStatus(vopts(b, { scope: 'global' })));
    expect(tableExists(b, '_sync_replica')).toBe(false);

    // B never synced its registry row, so the pull needs --force.
    const refused = await failure(
      on(b, () => restoreNexusVault(vopts(b, { scope: 'global', mode: 'pull' }))),
    );
    expect(refused.code).toBe('E_NEXUS_VAULT_LOCAL_CHANGES');
    const restored = await on(b, () =>
      restoreNexusVault(vopts(b, { scope: 'global', mode: 'pull', force: true })),
    );
    expect(restored.status).toBe('restored');
    expect(restored.verified).toBe(true);
    expect(restored.target).toBe(b.home);
    // The registry rows come from the snapshot, but this machine keeps its own paths (T12967).
    expect(
      homeSql<{ project_id: string; project_path: string }>(
        b,
        'SELECT project_id, project_path FROM nexus_project_registry ORDER BY 1',
      ),
    ).toEqual([
      { project_id: 'p1', project_path: `${b.home}/projects/p1` },
      // p2 lives on A only: its path is a placeholder here, never A's path (#1773 H2).
      {
        project_id: 'p2',
        project_path: 'cleo-vault-remote:nexus_project_registry:["p2"]:project_path',
      },
    ]);
    // B's credentials survive (T12966); A's account arrives without its secret.
    expect(
      homeSql<{ label: string; secret_enc: string | null }>(
        b,
        'SELECT label, secret_enc FROM accounts ORDER BY id',
      ),
    ).toEqual([
      { label: 'acct-a', secret_enc: null },
      { label: 'acct-b', secret_enc: 'SECRET-b' },
    ]);
    expect(
      homeSql(b, "SELECT api_key_encrypted FROM agent_registry_agents WHERE agent_id = 'ag1'"),
    ).toEqual([{ api_key_encrypted: 'KEY-b' }]);
    // Machine identity and runtime state are not in the snapshot (T12968).
    expect(fs.readFileSync(path.join(b.home, 'device-id'), 'utf8')).toBe('device-b\n');
    expect(fs.readFileSync(path.join(b.home, 'state', 'sync', 'replicas-b.json'), 'utf8')).toBe(
      '{"m":"b"}',
    );
    expect(fs.existsSync(path.join(b.home, 'state', 'sync', 'replicas-a.json'))).toBe(false);
    for (const f of [
      'web-server.json',
      'sentient-state.json',
      'device-heartbeat.stamp',
      'nexus.db',
      'keys',
    ]) {
      expect(fs.existsSync(path.join(b.home, f))).toBe(false);
    }
    // Machine-local tables are never taken from another machine.
    expect(replicaRows(b)).toEqual([]);
    expect(fs.existsSync(path.join(b.home, 'nexus-device.json'))).toBe(true);
    const vb = await on(b, () => verifyNexusVault(vopts(b, { scope: 'global' })));
    expect(vb.verdict).toBe('match');

    // B changes the global store and pushes; A pulls it, keeping its own paths and secrets.
    const db = new DatabaseSync(path.join(b.home, 'cleo.db'));
    db.exec(
      "INSERT INTO nexus_project_registry (project_id, project_hash, project_path, name) VALUES ('p3', 'hash-p3', '/projects/p3', 'p3')",
    );
    db.exec("DELETE FROM agent_registry_agents WHERE agent_id = 'ag1'");
    db.close();
    const pushedB = await on(b, () => pushNexusVault(vopts(b, { scope: 'global' })));
    expect(pushedB.status).toBe('pushed');
    expect(pushedB.parentCheckpointId).toBe(cp?.checkpointId);
    const pulled = await on(a, () =>
      restoreNexusVault(vopts(a, { scope: 'global', mode: 'pull' })),
    );
    expect(pulled.status).toBe('restored');
    expect(homeSql(a, 'SELECT COUNT(*) AS n FROM nexus_project_registry')).toEqual([{ n: 3 }]);
    expect(
      homeSql(a, "SELECT project_path FROM nexus_project_registry WHERE project_id = 'p1'"),
    ).toEqual([{ project_path: `${a.home}/projects/p1` }]);
    // A `strip` column is NULL after a restore, for this machine to re-probe (T13022).
    expect(homeSql(a, 'SELECT remote_url FROM nexus_project_git_state')).toEqual([
      { remote_url: null },
    ]);
    expect(replicaRows(a)).toEqual(replicasA);
    expect(fs.readFileSync(path.join(a.home, 'device-id'), 'utf8')).toBe('device-a\n');
    // A's agent key had nowhere to go (B deleted the agent): reported with its remedy.
    const lost = pulled.warnings.find((w) => w.code === 'W_NEXUS_VAULT_CREDENTIALS_LOST');
    expect(lost?.message).toContain('agent_registry_agents');
    expect(lost?.message).toContain('re-issue agent keys');
    const va = await on(a, () => verifyNexusVault(vopts(a, { scope: 'global' })));
    expect(va.verdict).toBe('match');
  });

  it('CLEO-installed content and the install id stay per machine (T13022)', async () => {
    const a = await machine('a', DEVICE_A, REPLICA_A);
    const b = await machine('b', DEVICE_B, REPLICA_B);
    await seedHome(a, ['p1']);
    await seedHome(b, ['p1']);
    const installed = [
      'templates/CLEO-INJECTION.md',
      'skills/ct-x/SKILL.md',
      'hooks/nexus-augment.sh',
      'extensions/cleo-startup.js',
      'pi-extensions/orchestrator.ts',
      'llm-catalog/latest.json',
      '.migrations/m1.done',
      'CLEOOS-IDENTITY.md',
      'cant/starter/team.cant',
    ];
    const config = (m: Machine, model: string, installId: string | null) =>
      fs.writeFileSync(
        path.join(m.home, 'config.json'),
        JSON.stringify({
          llm: { model },
          telemetry: { enabled: false, ...(installId ? { installId } : {}) },
        }),
      );
    for (const m of [a, b]) {
      for (const rel of installed) {
        fs.mkdirSync(path.dirname(path.join(m.home, rel)), { recursive: true });
        fs.writeFileSync(path.join(m.home, rel), `cleo version on ${m.name}`);
      }
      config(m, `model-${m.name}`, `install-${m.name}`);
    }
    // B runs a newer CLEO that installed one more skill.
    fs.mkdirSync(path.join(b.home, 'skills', 'ct-new'), { recursive: true });
    fs.writeFileSync(path.join(b.home, 'skills', 'ct-new', 'SKILL.md'), 'newer');

    await on(a, () => pushNexusVault(vopts(a, { scope: 'global' })));
    const cp = fake.stream(HOME_STREAM).checkpoints.at(-1);
    if (!cp || !fake.escrow) throw new Error('fixture');
    const tar = gunzipSync(
      openAead(
        nexusHomeDataKey(fake.escrow.mk),
        fake.blobs.get(cp.blobSha256)?.bytes ?? Buffer.alloc(0),
        'checkpoint',
        `checkpoint/v2\n${cp.streamId}\n${cp.checkpointId}\n${cp.coversSeq}`,
      ),
    );
    // None of A's installed files is in the snapshot (the manifest may name an exclusion).
    expect(tar.includes(Buffer.from('cleo version on a'))).toBe(false);
    expect(tar.includes(Buffer.from('model-a'))).toBe(true);

    const pulled = await on(b, () =>
      restoreNexusVault(vopts(b, { scope: 'global', mode: 'pull', force: true })),
    );
    expect(pulled.status).toBe('restored');
    for (const rel of installed) {
      expect(fs.readFileSync(path.join(b.home, rel), 'utf8')).toBe('cleo version on b');
    }
    expect(fs.readFileSync(path.join(b.home, 'skills', 'ct-new', 'SKILL.md'), 'utf8')).toBe(
      'newer',
    );
    // The user's settings come from the snapshot; the install id stays this machine's.
    expect(JSON.parse(fs.readFileSync(path.join(b.home, 'config.json'), 'utf8'))).toEqual({
      llm: { model: 'model-a' },
      telemetry: { enabled: false, installId: 'install-b' },
    });
    expect((await on(b, () => verifyNexusVault(vopts(b, { scope: 'global' })))).verdict).toBe(
      'match',
    );

    // A's next push reaches B with a plain pull; B's installed files and id never count as changes.
    config(a, 'model-a2', 'install-a');
    await on(a, () => pushNexusVault(vopts(a, { scope: 'global' })));
    const plain = await on(b, () => restoreNexusVault(vopts(b, { scope: 'global', mode: 'pull' })));
    expect(plain.status).toBe('restored');
    expect(JSON.parse(fs.readFileSync(path.join(b.home, 'config.json'), 'utf8'))).toEqual({
      llm: { model: 'model-a2' },
      telemetry: { enabled: false, installId: 'install-b' },
    });

    // A machine with no install id does not take the snapshot's.
    config(b, 'model-a2', null);
    const forced = await on(b, () =>
      restoreNexusVault(vopts(b, { scope: 'global', mode: 'pull', force: true })),
    );
    expect(forced.status).toBe('restored');
    expect(JSON.parse(fs.readFileSync(path.join(b.home, 'config.json'), 'utf8'))).toEqual({
      llm: { model: 'model-a2' },
      telemetry: { enabled: false },
    });
  });

  it('a global snapshot never carries git marks: a crafted flag hides nothing (T13038)', async () => {
    const a = await machine('a', DEVICE_A, REPLICA_A);
    const b = await machine('b', DEVICE_B, REPLICA_B);
    await seedHome(a, ['p1']);
    await seedHome(b, ['p1']);
    fs.mkdirSync(path.join(a.home, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(a.home, 'notes', 'global.md'), 'g1\n');
    await on(a, () => pushNexusVault(vopts(a, { scope: 'global' })));
    const head = fake.stream(HOME_STREAM).checkpoints.at(-1);
    if (!head || !fake.escrow) throw new Error('fixture');
    const homeKey = nexusHomeDataKey(fake.escrow.mk);

    // A key holder re-pushes the same bundle with the file flagged as git-tracked.
    const work = path.join(base, 'crafted');
    const dir = path.join(work, 'x');
    fs.mkdirSync(dir, { recursive: true });
    const gz = path.join(work, 'in.tar.gz');
    fs.writeFileSync(
      gz,
      openAead(
        homeKey,
        fake.blobs.get(head.blobSha256)?.bytes ?? Buffer.alloc(0),
        'checkpoint',
        `checkpoint/v2\n${head.streamId}\n${head.checkpointId}\n${head.coversSeq}`,
      ),
    );
    await tarExtract({ file: gz, cwd: dir });
    const manifestFile = path.join(dir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as PortableBundleManifest;
    const entry = manifest.global?.home.files.find((f) => f.relPath === 'notes/global.md');
    if (!entry) throw new Error('fixture');
    entry.gitTracked = true;
    manifest.integrity.manifestHash = computeManifestHash(manifest);
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
    const out = path.join(work, 'out.tar.gz');
    await tarCreate({ gzip: true, file: out, cwd: dir }, fs.readdirSync(dir));
    const journal = new Journal({
      http: new Http({ baseUrl: API, token: a.token, deviceId: a.deviceId, fetch: fake.fetch }),
      streamId: HOME_STREAM,
      replicaId: head.replicaId,
      deviceId: DEVICE_A,
      signing: a.keys.signing,
      key: homeKey,
      fetch: fake.fetch,
    });
    await journal.pushCheckpoint({
      bundle: fs.readFileSync(out),
      manifest: structuredClone(head.manifest),
      cursor: cursorFromCheckpoint(head),
      parentCheckpointId: head.checkpointId,
    });

    // The flag is ignored: the snapshot verifies with the file counted, and B owns its copy.
    const pulled = await on(b, () =>
      restoreNexusVault(vopts(b, { scope: 'global', mode: 'pull', force: true })),
    );
    expect(pulled.status).toBe('restored');
    expect(fs.readFileSync(path.join(b.home, 'notes', 'global.md'), 'utf8')).toBe('g1\n');
    expect(b.state.stream(API, USER, HOME_STREAM, b.home)?.gitTracked).toBeUndefined();
    fs.writeFileSync(path.join(b.home, 'notes', 'global.md'), 'b edit\n');
    const vb = await on(b, () => verifyNexusVault(vopts(b, { scope: 'global' })));
    expect(vb.verdict).toBe('ahead');
    const pushed = await on(b, () => pushNexusVault(vopts(b, { scope: 'global' })));
    expect(pushed.status).toBe('pushed');
  });
});

describe('cloud vault round 3 (#1773)', () => {
  const insertTask = (m: Machine, id: string, title = 'new') =>
    exec(m, `INSERT INTO tasks_tasks (id, title) VALUES ('${id}', '${title}')`);
  const warning = (r: { warnings: Array<{ code: string; message: string }> }, code: string) =>
    r.warnings.find((w) => w.code === code);

  it('R3PROBE-1: a file or database another device deleted is deleted here too (T13004)', async () => {
    const { a, b } = await twoMachines();
    const adr = (m: Machine) => path.join(m.root, '.cleo', 'adrs', 'old.md');
    const blobsDb = (m: Machine) => path.join(m.root, '.cleo', 'blobs', 'manifest.db');
    fs.mkdirSync(path.dirname(adr(a)), { recursive: true });
    fs.writeFileSync(adr(a), '# old\n');
    fs.mkdirSync(path.dirname(blobsDb(a)), { recursive: true });
    const blobs = new DatabaseSync(blobsDb(a));
    blobs.exec("CREATE TABLE blobs (sha TEXT PRIMARY KEY); INSERT INTO blobs VALUES ('aa');");
    blobs.close();
    // The docs audit key is a secret: never in a snapshot (T13007).
    fs.mkdirSync(path.join(a.root, '.cleo', 'audit'), { recursive: true });
    fs.writeFileSync(path.join(a.root, '.cleo', 'audit', '.audit-secret'), 'a'.repeat(64));
    await on(a, () => pushNexusVault(vopts(a)));
    await restoreOntoB(b);
    expect(fs.existsSync(adr(b))).toBe(true);
    expect(fs.existsSync(blobsDb(b))).toBe(true);
    expect(fs.existsSync(path.join(b.root, '.cleo', 'audit', '.audit-secret'))).toBe(false);
    // B's own machine-local files and secrets are never removed.
    fs.writeFileSync(path.join(b.root, '.cleo', 'worktrees.json'), '{"b":1}');
    fs.mkdirSync(path.join(b.root, '.cleo', 'audit'), { recursive: true });
    fs.writeFileSync(path.join(b.root, '.cleo', 'audit', '.audit-secret'), 'b'.repeat(64));
    fs.mkdirSync(path.join(b.root, '.cleo', 'keys'), { recursive: true });
    fs.writeFileSync(path.join(b.root, '.cleo', 'keys', 'identity.key'), 'B-KEY');

    fs.rmSync(adr(a));
    fs.rmSync(blobsDb(a));
    const pushed = await on(a, () => pushNexusVault(vopts(a)));
    expect(pushed.status).toBe('pushed');
    const pulled = await on(b, () => restoreNexusVault(vopts(b, { mode: 'pull' })));
    expect(pulled.status).toBe('restored');
    expect(fs.existsSync(adr(b))).toBe(false);
    expect(fs.existsSync(path.dirname(adr(b)))).toBe(false);
    expect(fs.existsSync(blobsDb(b))).toBe(false);
    const removed = warning(pulled, 'W_NEXUS_VAULT_REMOVED')?.message;
    expect(removed).toContain('adrs/old.md');
    expect(removed).toContain('blobs/manifest.db');
    expect(fs.readFileSync(path.join(b.root, '.cleo', 'worktrees.json'), 'utf8')).toBe('{"b":1}');
    expect(fs.readFileSync(path.join(b.root, '.cleo', 'audit', '.audit-secret'), 'utf8')).toBe(
      'b'.repeat(64),
    );
    expect(fs.readFileSync(path.join(b.root, '.cleo', 'keys', 'identity.key'), 'utf8')).toBe(
      'B-KEY',
    );
    expect(fs.existsSync(path.join(b.root, '.cleo', 'nexus-link.json'))).toBe(true);
    const vb = await on(b, () => verifyNexusVault(vopts(b)));
    expect(vb.verdict).toBe('match');

    // A's next push: B's plain pull works (nothing stale is left to look like a local change).
    insertTask(a, 'A1');
    await on(a, () => pushNexusVault(vopts(a)));
    const again = await on(b, () => restoreNexusVault(vopts(b, { mode: 'pull' })));
    expect(again.status).toBe('restored');
    expect(taskCount(b)).toBe(6);
  });

  it('R3PROBE-2: a local config.json edit blocks a plain pull; machine-local files stay (T13005)', async () => {
    const { a, b } = await twoMachines();
    const cfg = (m: Machine) => path.join(m.root, '.cleo', 'config.json');
    const worktrees = (m: Machine) => path.join(m.root, '.cleo', 'worktrees.json');
    fs.writeFileSync(
      cfg(a),
      JSON.stringify({ storage: { root: `${a.root}/data` }, mode: 'a' }, null, 2),
    );
    fs.writeFileSync(path.join(a.root, '.cleo', 'project-context.json'), '{"primaryType":"node"}');
    fs.writeFileSync(worktrees(a), '{"from":"a"}');
    await on(a, () => pushNexusVault(vopts(a)));
    await restoreOntoB(b);
    // The config's paths follow the store, and the relocated copy still verifies.
    expect(JSON.parse(fs.readFileSync(cfg(b), 'utf8'))).toEqual({
      storage: { root: `${b.root}/data` },
      mode: 'a',
    });
    // A's worktree index never arrives: it names A's worktrees.
    expect(fs.existsSync(worktrees(b))).toBe(false);
    expect((await on(b, () => verifyNexusVault(vopts(b)))).verdict).toBe('match');
    fs.writeFileSync(worktrees(b), '{"from":"b"}');

    // B edits its config after its last sync, then A pushes.
    fs.writeFileSync(
      cfg(b),
      JSON.stringify({ storage: { root: `${b.root}/data` }, mode: 'b' }, null, 2),
    );
    const vb = await on(b, () => verifyNexusVault(vopts(b)));
    expect(vb.verdict).toBe('ahead');
    insertTask(a, 'A1');
    await on(a, () => pushNexusVault(vopts(a)));
    const refused = await failure(on(b, () => restoreNexusVault(vopts(b, { mode: 'pull' }))));
    expect(refused.code).toBe('E_NEXUS_VAULT_LOCAL_CHANGES');
    expect(refused.message).toContain('zz_vault_files');
    expect(JSON.parse(fs.readFileSync(cfg(b), 'utf8')).mode).toBe('b');

    // --force takes the cloud's config (relocated here) and keeps B's worktree index.
    const forced = await on(b, () => restoreNexusVault(vopts(b, { mode: 'pull', force: true })));
    expect(forced.status).toBe('restored');
    expect(JSON.parse(fs.readFileSync(cfg(b), 'utf8'))).toEqual({
      storage: { root: `${b.root}/data` },
      mode: 'a',
    });
    expect(fs.readFileSync(worktrees(b), 'utf8')).toBe('{"from":"b"}');
    expect((await on(b, () => verifyNexusVault(vopts(b)))).verdict).toBe('match');
  });

  it('N4: --force over a newer head with no lease is a labelled fork; synced past it, no warning', async () => {
    const { a, b } = await twoMachines();
    await on(a, () => pushNexusVault(vopts(a)));
    await restoreOntoB(b);
    insertTask(a, 'A1');
    const a2 = await on(a, () => pushNexusVault(vopts(a)));
    insertTask(b, 'B1');
    const stale = await failure(on(b, () => pushNexusVault(vopts(b))));
    expect(stale.code).toBe('E_NEXUS_VAULT_BEHIND');

    // No hold: the lease is handed back, and the label stays on the snapshot.
    const forked = await on(b, () => pushNexusVault(vopts(b, { force: true })));
    expect(forked.status).toBe('pushed');
    expect(forked.forked).toBe(true);
    expect(forked.parentCheckpointId).toBe(a2.snapshot?.checkpointId);
    expect(fake.leases.size).toBe(0);
    expect(fake.activity.some((e) => e.action === 'lease.force_take')).toBe(false);
    expect(fake.stream(STREAM).checkpoints.at(-1)?.manifest.tables['zz_vault_fork']?.rows).toBe(0);

    const va = await on(a, () => verifyNexusVault(vopts(a)));
    expect(va.verdict).toBe('behind');
    expect(va.tables.map((t) => t.table)).not.toContain('zz_vault_fork');
    const fork = warning(va, 'W_NEXUS_VAULT_FORK')?.message;
    expect(fork).toContain(forked.snapshot?.checkpointId);
    expect(fork).toContain(REPLICA_A);
    // The device that forked is not warned about its own fork.
    const vb = await on(b, () => verifyNexusVault(vopts(b)));
    expect(vb.verdict).toBe('match');
    expect(warning(vb, 'W_NEXUS_VAULT_FORK')).toBeUndefined();

    // A fork older than this machine's last sync is no news: no warning once A pulled it.
    const pulled = await on(a, () => restoreNexusVault(vopts(a, { mode: 'pull' })));
    expect(pulled.status).toBe('restored');
    const after = await on(a, () => verifyNexusVault(vopts(a)));
    expect(after.verdict).toBe('match');
    expect(warning(after, 'W_NEXUS_VAULT_FORK')).toBeUndefined();

    // The next ordinary push is not a fork and does not carry the label.
    insertTask(a, 'A2');
    const next = await on(a, () => pushNexusVault(vopts(a)));
    expect(next.forked).toBe(false);
    expect(
      fake.stream(STREAM).checkpoints.at(-1)?.manifest.tables['zz_vault_fork'],
    ).toBeUndefined();
    expect(fake.activity.some((e) => e.action.startsWith('checkpoint.refused'))).toBe(false);
  });

  it('N5: a project restored onto a new machine carries none of the pusher machine state', async () => {
    const { a, b } = await twoMachines();
    exec(
      a,
      `ALTER TABLE tasks_tasks ADD COLUMN claimed_by_session TEXT;
       ALTER TABLE tasks_tasks ADD COLUMN lease_expires_at INTEGER;
       UPDATE tasks_tasks SET claimed_by_session = 'sess-a', lease_expires_at = 99 WHERE id = 'T0';
       CREATE TABLE _writer_leases (id INTEGER PRIMARY KEY, scope TEXT NOT NULL, lane TEXT NOT NULL,
         holder_id TEXT NOT NULL, holder_pid INTEGER NOT NULL, epoch INTEGER NOT NULL,
         acquired_at INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL, ttl_ms INTEGER NOT NULL,
         reentrancy_depth INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1);
       INSERT INTO _writer_leases (scope, lane, holder_id, holder_pid, epoch, acquired_at, heartbeat_at, ttl_ms)
         VALUES ('project', 'tasks', 'a-writer', 4242, 1, ${Date.now()}, ${Date.now()}, 60000);`,
    );
    await on(a, () => pushNexusVault(vopts(a)));
    await restoreOntoB(b);
    // Machine-local tables arrive empty, and another machine's claim is not B's.
    expect(sql(b, 'SELECT replica_id FROM _sync_replica')).toEqual([]);
    expect(sql(b, 'SELECT holder_pid FROM _writer_leases')).toEqual([]);
    expect(
      sql(b, "SELECT claimed_by_session, lease_expires_at FROM tasks_tasks WHERE id = 'T0'"),
    ).toEqual([{ claimed_by_session: null, lease_expires_at: null }]);
    expect((await on(b, () => verifyNexusVault(vopts(b)))).verdict).toBe('match');

    // A later pull keeps B's own claim on a row it has, and brings none for a new row.
    exec(b, "UPDATE tasks_tasks SET claimed_by_session = 'sess-b' WHERE id = 'T1'");
    exec(
      a,
      "INSERT INTO tasks_tasks (id, title, claimed_by_session, lease_expires_at) VALUES ('A1', 'new', 'sess-a', 7)",
    );
    await on(a, () => pushNexusVault(vopts(a)));
    const pulled = await on(b, () => restoreNexusVault(vopts(b, { mode: 'pull' })));
    expect(pulled.status).toBe('restored');
    expect(
      sql(
        b,
        "SELECT id, claimed_by_session, lease_expires_at FROM tasks_tasks WHERE id IN ('A1', 'T1') ORDER BY id",
      ),
    ).toEqual([
      { id: 'A1', claimed_by_session: null, lease_expires_at: null },
      { id: 'T1', claimed_by_session: 'sess-b', lease_expires_at: null },
    ]);
  });

  it('N6: a push whose state write was lost does not leave the device behind its own snapshot', async () => {
    const { a, b } = await twoMachines();
    await on(a, () => pushNexusVault(vopts(a)));
    insertTask(a, 'A1');
    // The crash: the checkpoint lands, the state write never happens.
    const saveStream = a.state.saveStream.bind(a.state);
    a.state.saveStream = () => {
      throw new Error('crashed before recording the snapshot');
    };
    await expect(on(a, () => pushNexusVault(vopts(a)))).rejects.toThrow(/crashed/);
    a.state.saveStream = saveStream;
    const pushed = { snapshot: fake.stream(STREAM).checkpoints.at(-1) ?? null };
    expect(pushed.snapshot?.deviceId).toBe(DEVICE_A);
    const v = await on(a, () => verifyNexusVault(vopts(a)));
    expect(v.verdict).toBe('match');
    expect(v.lastSynced).toBe(pushed.snapshot?.checkpointId);
    const pull = await on(a, () => restoreNexusVault(vopts(a, { mode: 'pull' })));
    expect(pull.status).toBe('up-to-date');
    insertTask(a, 'A2');
    const next = await on(a, () => pushNexusVault(vopts(a)));
    expect(next.status).toBe('pushed');
    expect(next.parentCheckpointId).toBe(pushed.snapshot?.checkpointId);

    // Another device's snapshot is never taken as this store's own.
    await restoreOntoB(b);
    insertTask(a, 'A3');
    await on(a, () => pushNexusVault(vopts(a)));
    insertTask(b, 'B1');
    const behind = await failure(on(b, () => pushNexusVault(vopts(b))));
    expect(behind.code).toBe('E_NEXUS_VAULT_BEHIND');
  });

  it('verify and pull decide nothing from a snapshot whose signature fails', async () => {
    const { a, b } = await twoMachines();
    const v1 = await on(a, () => pushNexusVault(vopts(a)));
    await restoreOntoB(b);
    insertTask(a, 'X1', 'same');
    const v2 = await on(a, () => pushNexusVault(vopts(a)));
    // B makes exactly A's change: its store now hashes like v2, not like v1.
    insertTask(b, 'X1', 'same');
    insertTask(a, 'X2', 'more');
    await on(a, () => pushNexusVault(vopts(a)));
    // The server swaps v1's manifest for v2's, so B would look unchanged since its sync.
    const s = fake.stream(STREAM);
    const forged = s.checkpoints.find((c) => c.checkpointId === v1.snapshot?.checkpointId);
    const real = s.checkpoints.find((c) => c.checkpointId === v2.snapshot?.checkpointId);
    if (!forged || !real) throw new Error('fixture');
    forged.manifest = structuredClone(real.manifest);
    const refused = await failure(on(b, () => restoreNexusVault(vopts(b, { mode: 'pull' }))));
    expect(refused.code).toBe('E_NEXUS_VAULT_LOCAL_CHANGES');
    expect(taskCount(b)).toBe(6);
    const vb = await on(b, () => verifyNexusVault(vopts(b)));
    expect(
      vb.warnings.some(
        (w) =>
          w.code === 'W_NEXUS_VAULT_UNTRUSTED_SNAPSHOT' && w.message.includes(forged.checkpointId),
      ),
    ).toBe(true);

    // A forged head: nothing is compared with it.
    const head = s.checkpoints.at(-1);
    if (!head) throw new Error('fixture');
    head.signature = Buffer.alloc(64).toString('base64');
    const va = await on(a, () => verifyNexusVault(vopts(a)));
    expect(va.verdict).toBe('untrusted');
    expect(va.tables).toEqual([]);
    expect(va.head).toBeNull();
    expect(va.remedy).toContain('do not pull it');
    expect(va.devices.map((d) => d.checkpointId)).not.toContain(head.checkpointId);
  });

  it('safety bundles are rotated, keeping the newest ten', async () => {
    const { a, b } = await twoMachines();
    await on(a, () => pushNexusVault(vopts(a)));
    await restoreOntoB(b);
    const dir = path.join(b.root, '.cleo', 'backups', 'vault');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 1; i <= 12; i++) {
      const day = String(i).padStart(2, '0');
      fs.writeFileSync(
        path.join(dir, `pre-restore-2026-01-${day}T00-00-00-000Z.cleobundle.tar.gz`),
        'old',
      );
    }
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'kept');
    const forced = await on(b, () => restoreNexusVault(vopts(b, { mode: 'pull', force: true })));
    const left = fs
      .readdirSync(dir)
      .filter((n) => n.startsWith('pre-restore-'))
      .sort();
    expect(left).toHaveLength(10);
    expect(left[0]).toBe('pre-restore-2026-01-04T00-00-00-000Z.cleobundle.tar.gz');
    expect(left).toContain(path.basename(forced.safetyBackup ?? ''));
    expect(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8')).toBe('kept');
  });

  it('a project restored onto a new machine records its sync under the stream its link names', async () => {
    const { a, b } = await twoMachines();
    const pushed = await on(a, () => pushNexusVault(vopts(a)));
    const linkedStream = `project:${REMOTE_PROJECT}:linked`;
    await on(b, () =>
      restoreNexusVault(
        vopts(b, {
          mode: 'restore',
          projectId: REMOTE_PROJECT,
          into: b.root,
          relink: async () => {
            link(b);
            const file = path.join(b.root, '.cleo', 'nexus-link.json');
            const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as {
              links: Record<string, { streamId: string }>;
            };
            const entry = doc.links[API];
            if (entry) entry.streamId = linkedStream;
            fs.writeFileSync(file, JSON.stringify(doc));
            return [];
          },
        }),
      ),
    );
    expect(b.state.stream(API, USER, linkedStream, b.root)?.lastCheckpointId).toBe(
      pushed.snapshot?.checkpointId,
    );
  });
});

describe('cloud vault round 4 (#1773)', () => {
  const cleoFile = (m: Machine, rel: string) => path.join(m.root, '.cleo', rel);
  const write = (m: Machine, rel: string, text: string) => {
    fs.mkdirSync(path.dirname(cleoFile(m, rel)), { recursive: true });
    fs.writeFileSync(cleoFile(m, rel), text);
  };
  const read = (m: Machine, rel: string) =>
    fs.existsSync(cleoFile(m, rel)) ? fs.readFileSync(cleoFile(m, rel), 'utf8') : null;
  const insertTask = (m: Machine, id: string) =>
    exec(m, `INSERT INTO tasks_tasks (id, title) VALUES ('${id}', 'new')`);
  const warning = (r: { warnings: Array<{ code: string; message: string }> }, code: string) =>
    r.warnings.find((w) => w.code === code);
  /** git in `m`'s project, with no user hooks, signing or ambient repository. */
  const git = (m: Machine, ...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.email=vault@test.invalid',
        '-c',
        'user.name=vault test',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        ...args,
      ],
      {
        cwd: m.root,
        encoding: 'utf8',
        env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
      },
    );
  const commit = (m: Machine, ...rels: string[]) => {
    if (!fs.existsSync(path.join(m.root, '.git'))) git(m, 'init', '-q');
    git(m, 'add', '--', ...rels.map((r) => `.cleo/${r}`));
    git(m, 'commit', '-q', '-m', 'track');
  };

  it('R4PROBE-7: a plain pull never deletes or overwrites a git-tracked path (T13019)', async () => {
    const { a, b } = await twoMachines();
    await on(a, () => pushNexusVault(vopts(a)));
    await restoreOntoB(b);
    // Two checkouts on different branches: B tracks a research note A lacks,
    // and both track a shared ADR with different content.
    write(a, 'adrs/shared.md', 'A branch\n');
    commit(a, 'adrs/shared.md');
    write(b, 'rcasd/T1/research.md', '# research\n');
    write(b, 'adrs/shared.md', 'B branch\n');
    commit(b, 'rcasd/T1/research.md', 'adrs/shared.md');
    // Tracked paths are git's: a branch difference is not a local change.
    expect((await on(b, () => verifyNexusVault(vopts(b)))).verdict).toBe('match');

    insertTask(a, 'A1');
    await on(a, () => pushNexusVault(vopts(a)));
    const pulled = await on(b, () => restoreNexusVault(vopts(b, { mode: 'pull' })));
    expect(pulled.status).toBe('restored');
    expect(taskCount(b)).toBe(6);
    expect(read(b, 'rcasd/T1/research.md')).toBe('# research\n');
    expect(read(b, 'adrs/shared.md')).toBe('B branch\n');
    expect(git(b, 'status', '--porcelain', '--', '.cleo/rcasd', '.cleo/adrs')).toBe('');
    expect((await on(b, () => verifyNexusVault(vopts(b)))).verdict).toBe('match');
    // And the next round still works: A pushes, B's plain pull lands (T13038).
    insertTask(a, 'A2');
    await on(a, () => pushNexusVault(vopts(a)));
    expect((await on(b, () => restoreNexusVault(vopts(b, { mode: 'pull' })))).status).toBe(
      'restored',
    );
    expect(read(b, 'rcasd/T1/research.md')).toBe('# research\n');
    expect((await on(b, () => verifyNexusVault(vopts(b)))).verdict).toBe('match');
  });

  it('a directory that is not a git checkout gets the tracked files, and both sides keep pulling (T13019)', async () => {
    const { a, b } = await twoMachines();
    write(a, 'adrs/tracked.md', 'tracked\n');
    commit(a, 'adrs/tracked.md');
    await on(a, () => pushNexusVault(vopts(a)));
    await restoreOntoB(b);
    expect(read(b, 'adrs/tracked.md')).toBe('tracked\n');
    expect((await on(b, () => verifyNexusVault(vopts(b)))).verdict).toBe('match');

    insertTask(a, 'A1');
    await on(a, () => pushNexusVault(vopts(a)));
    expect((await on(b, () => restoreNexusVault(vopts(b, { mode: 'pull' })))).status).toBe(
      'restored',
    );
    // B (no git) pushes; its snapshot still marks the path tracked, so A's plain pull works.
    insertTask(b, 'B1');
    await on(b, () => pushNexusVault(vopts(b)));
    const pa = await on(a, () => restoreNexusVault(vopts(a, { mode: 'pull' })));
    expect(pa.status).toBe('restored');
    expect(taskCount(a)).toBe(7);
    expect((await on(a, () => verifyNexusVault(vopts(a)))).verdict).toBe('match');
  });

  it('when git cannot list the tracked files, no file is compared, overwritten or removed (T13019)', async () => {
    const { a, b } = await twoMachines();
    write(a, 'adrs/x.md', 'x1\n');
    write(a, 'adrs/gone.md', 'gone\n');
    await on(a, () => pushNexusVault(vopts(a)));
    await restoreOntoB(b);
    // B's checkout is broken: git fails.
    fs.writeFileSync(path.join(b.root, '.git'), 'gitdir: /nonexistent/cleo-vault-test\n');
    write(b, 'adrs/x.md', 'b edit\n');
    write(b, 'adrs/extra.md', 'extra\n');
    write(a, 'adrs/x.md', 'x2\n');
    fs.rmSync(cleoFile(a, 'adrs/gone.md'));
    insertTask(a, 'A1');
    await on(a, () => pushNexusVault(vopts(a)));
    const pulled = await on(b, () => restoreNexusVault(vopts(b, { mode: 'pull' })));
    expect(pulled.status).toBe('restored');
    expect(warning(pulled, 'W_NEXUS_VAULT_GIT_UNKNOWN')?.message).toContain(b.root);
    expect(taskCount(b)).toBe(6);
    expect(read(b, 'adrs/x.md')).toBe('b edit\n');
    expect(read(b, 'adrs/extra.md')).toBe('extra\n');
    expect(read(b, 'adrs/gone.md')).toBe('gone\n');
  });

  it('R4PROBE-4: without a synced snapshot, a restore never removes or overwrites local files unless forced (T13020)', async () => {
    const { a } = await twoMachines();
    write(a, 'adrs/shared.md', 'from a\n');
    await on(a, () => pushNexusVault(vopts(a)));
    // C holds the same project with an empty store and files the cloud never saw.
    const c = await machine('c', '0198a1b2-0000-7000-8000-0000000000d3', uuidv7());
    fs.mkdirSync(path.join(c.root, '.cleo'), { recursive: true });
    fs.writeFileSync(path.join(c.root, '.cleo', 'project-id'), `${LOCAL_PROJECT}\n`);
    const empty = new DatabaseSync(path.join(c.root, '.cleo', 'cleo.db'));
    empty.exec('CREATE TABLE tasks_tasks (id TEXT PRIMARY KEY, title TEXT, file_path TEXT)');
    empty.close();
    write(c, 'adrs/my-draft.md', 'draft\n');
    write(c, 'adrs/shared.md', 'c version\n');
    const opts = { mode: 'restore', projectId: REMOTE_PROJECT, into: c.root } as const;
    const restored = await on(c, () => restoreNexusVault(vopts(c, opts)));
    expect(restored.status).toBe('restored');
    expect(taskCount(c)).toBe(5);
    expect(read(c, 'adrs/my-draft.md')).toBe('draft\n');
    expect(read(c, 'adrs/shared.md')).toBe('c version\n');
    expect(warning(restored, 'W_NEXUS_VAULT_KEPT_LOCAL')?.message).toContain('adrs/shared.md');
    expect(warning(restored, 'W_NEXUS_VAULT_REMOVED')).toBeUndefined();

    // --force takes the snapshot, after the safety bundle.
    const forced = await on(c, () => restoreNexusVault(vopts(c, { ...opts, force: true })));
    expect(forced.safetyBackup).not.toBeNull();
    expect(read(c, 'adrs/my-draft.md')).toBeNull();
    expect(read(c, 'adrs/shared.md')).toBe('from a\n');
  });

  it('a file created or edited after the safety export is never removed (T13020)', async () => {
    const { a, b } = await twoMachines();
    write(a, 'adrs/gone.md', 'gone\n');
    write(a, 'adrs/edited.md', 'v1\n');
    await on(a, () => pushNexusVault(vopts(a)));
    await restoreOntoB(b);
    fs.rmSync(cleoFile(a, 'adrs/gone.md'));
    fs.rmSync(cleoFile(a, 'adrs/edited.md'));
    await on(a, () => pushNexusVault(vopts(a)));
    // Between B's safety export and the removal step, B edits one file and writes another.
    importHooks.beforeImport = () => {
      write(b, 'adrs/edited.md', 'edited late\n');
      write(b, 'adrs/late.md', 'late\n');
    };
    const pulled = await on(b, () => restoreNexusVault(vopts(b, { mode: 'pull' })));
    expect(pulled.status).toBe('restored');
    expect(read(b, 'adrs/gone.md')).toBeNull();
    expect(read(b, 'adrs/edited.md')).toBe('edited late\n');
    expect(read(b, 'adrs/late.md')).toBe('late\n');
  });

  it('project-info.json stays per checkout (T13022)', async () => {
    const { a, b } = await twoMachines();
    await on(a, () => pushNexusVault(vopts(a)));
    await restoreOntoB(b);
    const info = JSON.stringify({ projectId: LOCAL_PROJECT, name: 'demo', checkoutNonce: 'b' });
    fs.writeFileSync(cleoFile(b, 'project-info.json'), info);
    expect((await on(b, () => verifyNexusVault(vopts(b)))).verdict).toBe('match');
    fs.writeFileSync(
      cleoFile(a, 'project-info.json'),
      JSON.stringify({ projectId: LOCAL_PROJECT, name: 'demo', checkoutNonce: 'a' }),
    );
    insertTask(a, 'A1');
    await on(a, () => pushNexusVault(vopts(a)));
    expect((await on(b, () => restoreNexusVault(vopts(b, { mode: 'pull' })))).status).toBe(
      'restored',
    );
    expect(read(b, 'project-info.json')).toBe(info);
  });

  it('R5PROBE-1: on a machine without git, an edit to a marked file is a local change (T13038)', async () => {
    const { a, b } = await twoMachines();
    write(a, 'adrs/tracked.md', 'v1\n');
    commit(a, 'adrs/tracked.md');
    await on(a, () => pushNexusVault(vopts(a)));
    // The documented new-machine flow: B restores into a directory with no git.
    await restoreOntoB(b);
    expect(read(b, 'adrs/tracked.md')).toBe('v1\n');
    write(b, 'adrs/tracked.md', 'b edit\n');
    const vb = await on(b, () => verifyNexusVault(vopts(b)));
    expect(vb.verdict).toBe('ahead');
    expect(vb.tables.find((x) => x.table === 'zz_vault_files')?.match).toBe(false);
    const pushed = await on(b, () => pushNexusVault(vopts(b)));
    expect(pushed.status).toBe('pushed');
    expect((await on(b, () => verifyNexusVault(vopts(b)))).verdict).toBe('match');

    // A's checkout leaves the tracked file to git and keeps going.
    expect((await on(a, () => restoreNexusVault(vopts(a, { mode: 'pull' })))).status).toBe(
      'restored',
    );
    expect(read(a, 'adrs/tracked.md')).toBe('v1\n');
    write(b, 'adrs/tracked.md', 'b edit 2\n');
    insertTask(a, 'A1');
    await on(a, () => pushNexusVault(vopts(a)));
    const refused = await failure(on(b, () => restoreNexusVault(vopts(b, { mode: 'pull' }))));
    expect(refused.code).toBe('E_NEXUS_VAULT_LOCAL_CHANGES');
    expect(refused.message).toContain('adrs/tracked.md');
    expect(read(b, 'adrs/tracked.md')).toBe('b edit 2\n');
  });

  it('R5PROBE-2: checkouts that track different files reach match and keep pulling (T13038)', async () => {
    const { a, b } = await twoMachines();
    write(a, 'notes/y.md', 'y\n');
    write(a, 'notes/z.md', 'z\n');
    await on(a, () => pushNexusVault(vopts(a)));
    await restoreOntoB(b);
    // Both hold both files; A's git tracks y, B's tracks z.
    commit(a, 'notes/y.md');
    commit(b, 'notes/z.md');
    insertTask(a, 'A1');
    await on(a, () => pushNexusVault(vopts(a)));
    expect((await on(b, () => restoreNexusVault(vopts(b, { mode: 'pull' })))).status).toBe(
      'restored',
    );
    expect((await on(b, () => verifyNexusVault(vopts(b)))).verdict).toBe('match');
    insertTask(b, 'B1');
    await on(b, () => pushNexusVault(vopts(b)));
    expect((await on(a, () => restoreNexusVault(vopts(a, { mode: 'pull' })))).status).toBe(
      'restored',
    );
    expect((await on(a, () => verifyNexusVault(vopts(a)))).verdict).toBe('match');
    insertTask(a, 'A2');
    await on(a, () => pushNexusVault(vopts(a)));
    expect((await on(b, () => restoreNexusVault(vopts(b, { mode: 'pull' })))).status).toBe(
      'restored',
    );
    expect((await on(b, () => verifyNexusVault(vopts(b)))).verdict).toBe('match');
    expect(taskCount(b)).toBe(8);
    expect([read(a, 'notes/y.md'), read(a, 'notes/z.md')]).toEqual(['y\n', 'z\n']);
    expect([read(b, 'notes/y.md'), read(b, 'notes/z.md')]).toEqual(['y\n', 'z\n']);
  });

  it('R6PROBE-2: without digests, a machine without git counts its marked files as changed (#1773 R6)', async () => {
    const { a, b } = await twoMachines();
    write(a, 'adrs/tracked.md', 'v1\n');
    commit(a, 'adrs/tracked.md');
    await on(a, () => pushNexusVault(vopts(a)));
    await restoreOntoB(b);
    // An older state: marks, but no per-path digests.
    const doc = JSON.parse(fs.readFileSync(b.state.path, 'utf8')) as {
      accounts: Record<
        string,
        { streams: Record<string, { files?: object; gitTracked?: string[] }> }
      >;
    };
    for (const account of Object.values(doc.accounts)) {
      for (const stream of Object.values(account.streams)) {
        expect(stream.gitTracked).toEqual(['adrs/tracked.md']);
        delete stream.files;
      }
    }
    fs.writeFileSync(b.state.path, JSON.stringify(doc, null, 2));
    write(b, 'adrs/tracked.md', 'b edit\n');
    expect((await on(b, () => verifyNexusVault(vopts(b)))).verdict).not.toBe('match');
    insertTask(a, 'A1');
    await on(a, () => pushNexusVault(vopts(a)));
    const refused = await failure(on(b, () => restoreNexusVault(vopts(b, { mode: 'pull' }))));
    expect(refused.code).toBe('E_NEXUS_VAULT_LOCAL_CHANGES');
    expect(read(b, 'adrs/tracked.md')).toBe('b edit\n');
  });

  it('a recovered push keeps its per-path digests, so a later edit is still seen (#1773 R6)', async () => {
    const { a, b } = await twoMachines();
    write(a, 'adrs/tracked.md', 'v1\n');
    commit(a, 'adrs/tracked.md');
    await on(a, () => pushNexusVault(vopts(a)));
    await restoreOntoB(b);
    insertTask(b, 'B1');
    // B's push lands, but the crash loses its state write.
    const saveStream = b.state.saveStream.bind(b.state);
    b.state.saveStream = () => {
      throw new Error('crashed before recording the snapshot');
    };
    await expect(on(b, () => pushNexusVault(vopts(b)))).rejects.toThrow(/crashed/);
    b.state.saveStream = saveStream;
    // The next command adopts B's own snapshot, with its digests.
    expect((await on(b, () => restoreNexusVault(vopts(b, { mode: 'pull' })))).status).toBe(
      'up-to-date',
    );
    const recorded = b.state.stream(API, USER, STREAM, b.root);
    expect(recorded?.lastCheckpointId).toBe(fake.stream(STREAM).checkpoints.at(-1)?.checkpointId);
    expect(Object.keys(recorded?.files ?? {})).toContain('adrs/tracked.md');
    expect((await on(b, () => verifyNexusVault(vopts(b)))).verdict).toBe('match');
    write(b, 'adrs/tracked.md', 'b edit\n');
    expect((await on(b, () => verifyNexusVault(vopts(b)))).verdict).toBe('ahead');
  });
});

describe('cloud vault on a stream the change journal writes (segment/v3, checkpoint/v3; T13034)', () => {
  const PIN_HASH = 'c'.repeat(64);
  const insertTask = (m: Machine, id: string) =>
    exec(m, `INSERT INTO tasks_tasks (id, title) VALUES ('${id}', 'new')`);
  const hlc = (replicaId: string, n: number) =>
    `${String(Date.now()).padStart(13, '0')}-${String(n).padStart(6, '0')}-${replicaId}`;
  /** Stream, blob and lease writes since `from` (a refusal before the lease makes none). */
  const streamWrites = (from: number) =>
    fake.writes.slice(from).filter((w) => w.includes('/v1/streams/') || w.includes('/blobs/'));

  /** The project data key, as every device unwraps it. */
  function projectDataKey(): Buffer {
    const wrapped = fake.projectKeys.get(REMOTE_PROJECT)?.[0];
    return unwrapProjectKey(
      fake.escrow?.mk ?? Buffer.alloc(0),
      wrapped?.wrappedProjectKey ?? '',
      REMOTE_PROJECT,
      1,
    );
  }

  /** `m`'s replica as the change journal drives it: its own segments and checkpoints. */
  function journalOf(m: Machine): Journal {
    return new Journal({
      http: new Http({ baseUrl: API, token: m.token, deviceId: m.deviceId, fetch: fake.fetch }),
      streamId: STREAM,
      replicaId: m.replicaId,
      deviceId: m.deviceId,
      signing: m.keys.signing,
      key: projectDataKey(),
      fetch: fake.fetch,
    });
  }

  /** Both devices certified: each trusts the other's signatures. */
  async function certify(...ms: Machine[]): Promise<Map<string, Uint8Array>> {
    for (const m of ms) {
      await on(m, async () => unlockNexusAccountKey(await connectNexusVault(vopts(m))));
    }
    return new Map(ms.map((m) => [m.deviceId, m.keys.signing.publicKey]));
  }

  /**
   * A checkpoint/v3 by `m`'s journal over the head `parent`: the parent's bundle and tables (the
   * journal applied nothing the vault counts), every window transaction listed in `voided` whole,
   * and the replay pin's transitions computed by the server's rise rule.
   */
  async function journalCheckpointV3(
    m: Machine,
    parent: Checkpoint,
    signers: Map<string, Uint8Array>,
    voided: Array<{
      ref: { replicaId: string; replicaSeq: number; txn: number };
      deltas: TableDeltas;
    }>,
  ): Promise<Checkpoint> {
    const j = journalOf(m);
    const page = await j.pull(cursorFromCheckpoint(parent), signers, 200);
    const window = fake.stream(STREAM).segments.filter((x) => x.seq > parent.coversSeq);
    const transitions = schemaRises(
      parent.manifest.schemaVersion,
      window.map((x) => ({ seq: x.seq, schemaVersion: x.schemaVersion })),
    ).map((t) => ({ ...t, journal: PIN_HASH }));
    const { bundle } = await j.restoreCheckpoint(parent.checkpointId, signers);
    return j.pushCheckpoint({
      bundle,
      manifest: {
        schemaVersion: Math.max(
          parent.manifest.schemaVersion,
          ...transitions.map((t) => t.schemaVersion),
        ),
        tables: parent.manifest.tables,
        pending: [],
        voided,
        revived: [],
        pruned: {},
        replayPin: { journal: PIN_HASH, triggerSetHash: PIN_HASH, transitions },
      },
      cursor: page.cursor,
      parentCheckpointId: parent.checkpointId,
    });
  }

  it('mixed v2-then-v3 lineage: a segment/v3 window folds into a v2 snapshot; a checkpoint/v3 head pulls, verifies and refuses a push', async () => {
    const { a, b } = await twoMachines();
    const s = fake.stream(STREAM);
    await on(a, () => pushNexusVault(vopts(a)));
    // The vault stamps the shared sync schema on what it writes, not its manifest format.
    expect(s.checkpoints[0]?.manifest.schemaVersion).toBe(SYNC_SCHEMA_VERSION);
    const signers = await certify(a, b);

    // B's journal appends a segment/v3: two transactions, per-transaction deltas.
    await journalOf(b).push(0, Buffer.from('{"txns":2}'), {
      opCount: 2,
      hlcMin: hlc(REPLICA_B, 0),
      hlcMax: hlc(REPLICA_B, 1),
      deltas: { tasks_tasks: { created: 2, deleted: 0 } },
      txnDeltas: [
        { txn: 0, deltas: { tasks_tasks: { created: 1, deleted: 0 } } },
        { txn: 1, deltas: { tasks_tasks: { created: 1, deleted: 0 } } },
      ],
      schemaVersion: SYNC_SCHEMA_VERSION,
    });
    expect(s.segments[0]?.txnDeltas).toHaveLength(2);
    expect(segmentSigningVersion(s.segments[0] ?? {})).toBe(3);

    // A holds the same two rows: its replay verifies the v3 segment and needs no delta of its own.
    insertTask(a, 'J1');
    insertTask(a, 'J2');
    const folded = await on(a, () => pushNexusVault(vopts(a)));
    expect(folded.status).toBe('pushed');
    expect(folded.deltaSegmentSeq).toBeNull();
    const v2Head = s.checkpoints.at(-1);
    if (!v2Head) throw new Error('fixture');
    expect(manifestVersion(v2Head.manifest)).toBe(2);
    expect(v2Head.coversSeq).toBe(1);
    expect(v2Head.replicas[REPLICA_B]).toEqual({ deviceId: DEVICE_B, lastReplicaSeq: 0 });
    expect(v2Head.manifest.tables['tasks_tasks']?.rows).toBe(7);

    // A pushes a new row; while it uploads, B's journal checkpoints v3 over the head. Its window holds
    // A's cleo-vault-delta/v1 segment, accounted as one transaction (txn 0) and voided whole.
    insertTask(a, 'A1');
    let v3Head: Checkpoint | null = null;
    fake.beforeCheckpoint = {
      deviceId: DEVICE_A,
      run: async () => {
        const delta = s.segments.at(-1);
        if (!delta || delta.replicaId !== REPLICA_A) throw new Error('fixture: no vault delta');
        expect(delta.schemaVersion).toBe(SYNC_SCHEMA_VERSION);
        expect(delta.txnDeltas).toBeNull();
        v3Head = await journalCheckpointV3(b, v2Head, signers, [
          {
            ref: { replicaId: REPLICA_A, replicaSeq: delta.replicaSeq, txn: 0 },
            deltas: delta.deltas,
          },
        ]);
      },
    };
    const raced = await failure(on(a, () => pushNexusVault(vopts(a))));
    expect(raced.code).toBe('E_NEXUS_VAULT_BEHIND');
    const head = v3Head as Checkpoint | null;
    if (!head) throw new Error('fixture: no v3 checkpoint');
    expect(s.headCheckpointId).toBe(head.checkpointId);
    expect(manifestVersion(head.manifest)).toBe(3);
    expect(s.voided.map((v) => v.ref)).toEqual([{ replicaId: REPLICA_A, replicaSeq: 0, txn: 0 }]);

    // A push onto the v3 head writes nothing: no lease, no upload, and no delta segment left
    // orphaned in the journal (A still holds a row the head does not). Not synced to it, A is told
    // to pull first, never to fork with --force; with --force the change itself is refused.
    const writes = fake.writes.length;
    const segments = s.segments.length;
    const behind = await failure(on(a, () => pushNexusVault(vopts(a))));
    expect(behind.code).toBe('E_NEXUS_VAULT_BEHIND');
    expect(behind.fix).toContain('cleo cloud pull');
    expect(behind.fix).toContain('change journal (`sync.push`)');
    expect(behind.fix).not.toContain('--force');
    const refused = await failure(on(a, () => pushNexusVault(vopts(a, { force: true }))));
    expect(refused.code).toBe('E_NEXUS_VAULT_STREAM_UPGRADED');
    expect(refused.message).toContain('checkpoint/v3');
    expect(refused.fix).toContain('nothing was written');
    expect(refused.fix).toContain('change journal (`sync.push`)');
    expect(refused.fix).toContain('T12999');
    expect(refused.fix).toContain('cleo cloud pull');
    expect(streamWrites(writes)).toEqual([]);
    expect(s.segments).toHaveLength(segments);
    expect(s.headCheckpointId).toBe(head.checkpointId);
    expect(fake.leases.size).toBe(0);

    // Verify trusts the v3 head (its checkpoint/v3 signature verifies) and compares with it; its
    // remedy never points at a push the server would refuse.
    const verify = await on(a, () => verifyNexusVault(vopts(a)));
    expect(verify.head?.checkpointId).toBe(head.checkpointId);
    expect(verify.warnings.some((w) => w.code === 'W_NEXUS_VAULT_UNTRUSTED_SNAPSHOT')).toBe(false);
    expect(verify.verdict).toBe('diverged');
    expect(verify.remedy).toContain('change journal (`sync.push`)');
    expect(verify.remedy).toContain('cleo cloud pull --force');
    expect(verify.remedy).not.toContain('cleo cloud push');
    // A plain pull keeps the local change and says how it travels on this stream.
    const kept = await failure(on(a, () => restoreNexusVault(vopts(a, { mode: 'pull' }))));
    expect(kept.code).toBe('E_NEXUS_VAULT_LOCAL_CHANGES');
    expect(kept.fix).toContain('change journal (`sync.push`)');
    expect(kept.fix).not.toContain('cleo cloud push');

    // Pull restores the v3 head (signature, bundle and manifest verified); the stores then match.
    const pulled = await on(a, () => restoreNexusVault(vopts(a, { mode: 'pull', force: true })));
    expect(pulled.status).toBe('restored');
    expect(pulled.verified).toBe(true);
    expect(pulled.snapshot?.checkpointId).toBe(head.checkpointId);
    expect(taskCount(a)).toBe(7);
    expect((await on(a, () => verifyNexusVault(vopts(a)))).verdict).toBe('match');

    // An unchanged store reports up-to-date on the v3 head, and writes nothing.
    const quiet = fake.writes.length;
    const upToDate = await on(a, () => pushNexusVault(vopts(a)));
    expect(upToDate.status).toBe('up-to-date');
    expect(upToDate.snapshot?.checkpointId).toBe(head.checkpointId);
    expect(streamWrites(quiet)).toEqual([]);

    // A local change: status and verify say it travels through the change journal; a push is refused.
    insertTask(a, 'A2');
    const status = await on(a, () => nexusVaultStatus(vopts(a)));
    expect(status.pendingChanges.map((d) => d.table)).toContain('tasks_tasks');
    expect(
      status.warnings.find((w) => w.code === 'W_NEXUS_VAULT_JOURNAL_STREAM')?.message,
    ).toContain('change journal (`sync.push`)');
    const ahead = await on(a, () => verifyNexusVault(vopts(a)));
    expect(ahead.verdict).toBe('ahead');
    expect(ahead.remedy).toContain('change journal (`sync.push`)');
    expect(ahead.remedy).not.toContain('cleo cloud push');
    const changed = await failure(on(a, () => pushNexusVault(vopts(a))));
    expect(changed.code).toBe('E_NEXUS_VAULT_STREAM_UPGRADED');
    expect(changed.fix).toContain('nothing was written');
    expect(streamWrites(quiet)).toEqual([]);

    // A new machine restores the v3 head too.
    const { result } = await restoreOntoB(b);
    expect(result.status).toBe('restored');
    expect(result.verified).toBe(true);
    expect(result.snapshot?.checkpointId).toBe(head.checkpointId);
    expect((await on(b, () => verifyNexusVault(vopts(b)))).verdict).toBe('match');
  });

  it("the server's E_STREAM_VERSION maps to E_NEXUS_VAULT_STREAM_UPGRADED, with nothing left behind", async () => {
    const { a } = await twoMachines();
    const s = fake.stream(STREAM);
    await on(a, () => pushNexusVault(vopts(a)));
    // Same counts, new content: the push needs no delta segment, only a checkpoint.
    exec(a, "UPDATE tasks_tasks SET title = 'renamed' WHERE id = 'T0'");
    fake.refuseCheckpoint = ['E_STREAM_VERSION'];
    const refused = await failure(on(a, () => pushNexusVault(vopts(a))));
    expect(refused.code).toBe('E_NEXUS_VAULT_STREAM_UPGRADED');
    expect(refused.message).toContain('checkpoint/v3');
    expect(refused.fix).toContain('cleo cloud pull');
    expect(refused.fix).toContain('change journal (`sync.push`)');
    expect(s.segments).toHaveLength(0);
    expect(s.checkpoints).toHaveLength(1);
    expect(fake.leases.size).toBe(0);
  });

  /** A's genesis, then B's journal appends a segment of the next sync schema; A then needs a delta. */
  async function newerSchemaSegment(): Promise<{ a: Machine; b: Machine; s: FakeStream }> {
    const { a, b } = await twoMachines();
    const s = fake.stream(STREAM);
    await on(a, () => pushNexusVault(vopts(a)));
    await certify(a, b);
    await journalOf(b).push(0, Buffer.from('{}'), {
      opCount: 1,
      hlcMin: hlc(REPLICA_B, 0),
      hlcMax: hlc(REPLICA_B, 0),
      deltas: { tasks_tasks: { created: 1, deleted: 0 } },
      schemaVersion: SYNC_SCHEMA_VERSION + 1,
    });
    // Two new rows here against one declared: this push would need a delta segment.
    insertTask(a, 'A1');
    insertTask(a, 'A2');
    return { a, b, s };
  }

  it('a stream holding a newer sync schema refuses the push before the export and the lease, even with --force', async () => {
    const { a, s } = await newerSchemaSegment();
    // Another device's live lease, which a forced push would take.
    fake.leases.set(`${STREAM}|writer`, {
      streamId: STREAM,
      role: 'writer',
      leaseId: uuidv7(),
      replicaId: REPLICA_B,
      expiresAt: new Date(Date.now() + 600_000),
      forkedFromReplicaId: null,
      deviceId: DEVICE_B,
      acquiredAt: NOW,
    });
    const held = fake.leases.get(`${STREAM}|writer`);
    const writes = fake.writes.length;
    for (const force of [false, true]) {
      const refused = await failure(on(a, () => pushNexusVault(vopts(a, { force }))));
      expect(refused.code).toBe('E_NEXUS_VAULT_STREAM_UPGRADED');
      expect(refused.message).toContain(`sync schema ${SYNC_SCHEMA_VERSION + 1}`);
      expect(refused.fix).toContain('upgrade CLEO');
    }
    // The server's stream head reported it (maxSchemaVersion): no lease taken, nothing written.
    expect(streamWrites(writes)).toEqual([]);
    expect(fake.writes.slice(writes).filter((w) => w.includes('/leases'))).toEqual([]);
    expect(fake.leases.get(`${STREAM}|writer`)).toEqual(held);
    expect(fake.activity.some((e) => e.action === 'lease.force_take')).toBe(false);
    expect(s.segments.map((x) => x.replicaId)).toEqual([REPLICA_B]);
    expect(s.checkpoints).toHaveLength(1);
  });

  it('against a server that does not report maxSchemaVersion, the replayed window refuses before the delta segment', async () => {
    const { a, s } = await newerSchemaSegment();
    fake.reportMaxSchemaVersion = false;
    const refused = await failure(on(a, () => pushNexusVault(vopts(a))));
    expect(refused.code).toBe('E_NEXUS_VAULT_STREAM_UPGRADED');
    expect(refused.message).toContain(`sync schema ${SYNC_SCHEMA_VERSION + 1}`);
    expect(s.segments.map((x) => x.replicaId)).toEqual([REPLICA_B]);
    expect(s.checkpoints).toHaveLength(1);
    // The lease this push took is handed back.
    expect(fake.leases.size).toBe(0);
  });

  it('a snapshot records its manifest format; one hashed under a newer format is refused clearly, not as a mismatch', async () => {
    const { a, b } = await twoMachines();
    const s = fake.stream(STREAM);
    await on(a, () => pushNexusVault(vopts(a)));
    const genesis = s.checkpoints[0];
    if (!genesis) throw new Error('fixture');
    const hashKey = deriveKey(projectDataKey(), 'vault-manifest');
    // The record: 0 rows (no count moves), a keyed hash naming this CLEO's format; never compared.
    expect(genesis.manifest.tables[VAULT_FORMAT_KEY]).toEqual(vaultFormatEntry(hashKey));
    expect((await on(a, () => verifyNexusVault(vopts(a)))).verdict).toBe('match');

    // The same data, recorded as hashed under the next format (as a newer CLEO would push it).
    const signers = await certify(a, b);
    const j = journalOf(a);
    const { bundle } = await j.restoreCheckpoint(genesis.checkpointId, signers);
    const newer = await j.pushCheckpoint({
      bundle,
      manifest: {
        schemaVersion: SYNC_SCHEMA_VERSION,
        tables: {
          ...genesis.manifest.tables,
          [VAULT_FORMAT_KEY]: vaultFormatEntry(hashKey, VAULT_MANIFEST_FORMAT_VERSION + 1),
        },
      },
      cursor: cursorFromCheckpoint(genesis),
      parentCheckpointId: genesis.checkpointId,
    });
    expect(s.headCheckpointId).toBe(newer.checkpointId);

    // A restore says why it cannot verify the snapshot, and places nothing.
    const refused = await failure(restoreOntoB(b));
    expect(refused.code).toBe('E_NEXUS_VAULT_VERIFY_FAILED');
    expect(refused.message).toContain('vault manifest format this CLEO does not recognise');
    expect(refused.message).toContain(`this CLEO hashes format ${VAULT_MANIFEST_FORMAT_VERSION}`);
    expect(refused.message).not.toContain('does not match its manifest');
    expect(refused.fix).toContain('upgrade CLEO');
    expect(fs.existsSync(path.join(b.root, '.cleo', 'cleo.db'))).toBe(false);

    // Verify warns that its comparison means nothing, and says to upgrade.
    const verify = await on(a, () => verifyNexusVault(vopts(a)));
    expect(verify.warnings.some((w) => w.code === 'W_NEXUS_VAULT_FORMAT')).toBe(true);
    expect(verify.remedy).toContain('upgrade CLEO');

    // A push, even forced, is refused before the export and the lease.
    const writes = fake.writes.length;
    const pushed = await failure(on(a, () => pushNexusVault(vopts(a, { force: true }))));
    expect(pushed.code).toBe('E_NEXUS_VAULT_STREAM_UPGRADED');
    expect(pushed.message).toContain('vault manifest format this CLEO does not recognise');
    expect(streamWrites(writes)).toEqual([]);
  });

  it('a head whose format record a pre-record build carried forward as an emptied table restores and pushes (#1785 LOW-3)', async () => {
    const { a, b } = await twoMachines();
    const s = fake.stream(STREAM);
    await on(a, () => pushNexusVault(vopts(a)));
    const genesis = s.checkpoints[0];
    if (!genesis) throw new Error('fixture');
    const hashKey = deriveKey(projectDataKey(), 'vault-manifest');
    // A build from before the record pushes next: it carries every parent table forward as an
    // emptied one, the format record included (it skipped only the fork label).
    const signers = await certify(a, b);
    const j = journalOf(b);
    const { bundle } = await j.restoreCheckpoint(genesis.checkpointId, signers);
    const carried = await j.pushCheckpoint({
      bundle,
      manifest: {
        schemaVersion: SYNC_SCHEMA_VERSION,
        tables: {
          ...genesis.manifest.tables,
          [VAULT_FORMAT_KEY]: { rows: 0, hash: emptyVaultTableHash(hashKey, VAULT_FORMAT_KEY) },
        },
      },
      cursor: cursorFromCheckpoint(genesis),
      parentCheckpointId: genesis.checkpointId,
    });
    expect(s.headCheckpointId).toBe(carried.checkpointId);

    // It reads as format 2: a new machine restores and verifies it.
    const { result } = await restoreOntoB(b);
    expect(result.status).toBe('restored');
    expect(result.verified).toBe(true);
    const vb = await on(b, () => verifyNexusVault(vopts(b)));
    expect(vb.verdict).toBe('match');
    expect(vb.warnings.some((w) => w.code === 'W_NEXUS_VAULT_FORMAT')).toBe(false);

    // A pulls it and pushes a change over it; the new head records the format again.
    const pulled = await on(a, () => restoreNexusVault(vopts(a, { mode: 'pull' })));
    expect(pulled.status).toBe('restored');
    insertTask(a, 'A1');
    const pushed = await on(a, () => pushNexusVault(vopts(a)));
    expect(pushed.status).toBe('pushed');
    expect(pushed.parentCheckpointId).toBe(carried.checkpointId);
    expect(s.checkpoints.at(-1)?.manifest.tables[VAULT_FORMAT_KEY]).toEqual(
      vaultFormatEntry(hashKey),
    );
  });

  it('the fake holds the server v3 rules: a v2 checkpoint after a v3 one is E_STREAM_VERSION', async () => {
    const { a, b } = await twoMachines();
    const s = fake.stream(STREAM);
    await on(a, () => pushNexusVault(vopts(a)));
    const signers = await certify(a, b);
    const genesis = s.checkpoints[0];
    if (!genesis) throw new Error('fixture');
    const v3 = await journalCheckpointV3(b, genesis, signers, []);
    // A v2 checkpoint over it, signed correctly, as an older vault (without the pre-check) would send.
    const j = journalOf(b);
    const { bundle } = await j.restoreCheckpoint(v3.checkpointId, signers);
    const err = await j
      .pushCheckpoint({
        bundle,
        manifest: { schemaVersion: SYNC_SCHEMA_VERSION, tables: v3.manifest.tables },
        cursor: cursorFromCheckpoint(v3),
        parentCheckpointId: v3.checkpointId,
      })
      .then(
        () => null,
        (e: Error & { code?: string; details?: Record<string, unknown> }) => e,
      );
    expect(err?.code).toBe('E_STREAM_VERSION');
    expect(err?.details?.['verdict']).toMatchObject({ reason: 'stream-v3' });
    expect(s.headCheckpointId).toBe(v3.checkpointId);
  });
});

describe('guided first run against the fake server (T13102)', () => {
  /** The first run's link step for machine `m`: the binding `cleo project link` would write. */
  function linkStep(m: Machine) {
    return async () => {
      link(m);
      return {
        link: {
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
        alreadyLinked: false,
        linkPath: path.join(m.root, '.cleo', 'nexus-link.json'),
        replica: {
          replicaId: m.replicaId,
          deviceId: m.deviceId,
          reboundFrom: null,
          presenceAt: NOW,
        },
        attachError: null,
        warnings: [],
      };
    };
  }

  /** A: `cleo login nexus --yes` inside its unlinked project; B: an empty folder outside any project. */
  async function firstRunOnA() {
    const a = await machine('a', DEVICE_A, REPLICA_A);
    const b = await machine('b', DEVICE_B, REPLICA_B);
    fake.addProject(REMOTE_PROJECT, { [REPLICA_A]: DEVICE_A });
    seedProject(a, 5);
    const result = await on(a, () =>
      runNexusFirstRun({
        ...vopts(a),
        consent: 'yes',
        deviceId: DEVICE_A,
        link: linkStep(a),
      }),
    );
    return { a, b, result };
  }

  /** The server's label and an opaque encryptedName (its format is not specified yet: T098). */
  function nameOnServer(label: string): void {
    fake.projectNames.set(REMOTE_PROJECT, { label, encryptedName: 'c2VhbGVkLW5hbWU=' });
  }

  it('--yes links, then takes the first encrypted backup with the real push', async () => {
    const { result } = await firstRunOnA();
    expect(result.state).toBe('backed-up');
    expect(result.backup?.status).toBe('pushed');
    const head = fake.streams.get(STREAM)?.headCheckpointId ?? null;
    expect(head).not.toBeNull();
    expect(result.backup?.snapshot?.checkpointId).toBe(head);
    // The push minted the account and project keys (the fallback path until onboarding A/B land).
    expect(fake.escrow).not.toBeNull();
    expect(fake.projectKeys.get(REMOTE_PROJECT)).toHaveLength(1);
  });

  it('on a machine with no linked project, login lists the project by name with the restore command, writing nothing', async () => {
    const { b } = await firstRunOnA();
    nameOnServer('Demo Board');
    const emptyDir = path.join(base, 'b', 'empty');
    fs.mkdirSync(emptyDir, { recursive: true });
    const writesBefore = fake.writes.length;
    const result = await on(b, () =>
      runNexusFirstRun({
        ...vopts(b, { projectRoot: emptyDir }),
        consent: 'never',
        deviceId: DEVICE_B,
      }),
    );
    expect(result.state).toBe('projects');
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0]).toMatchObject({
      projectId: REMOTE_PROJECT,
      // The encryptedName is not opened: no reader for its format exists yet.
      name: 'Demo Board',
      nameSource: 'label',
      hasBackup: true,
      onThisDevice: false,
      // The fake API is not the default origin, so the commands name it. The machine-read
      // command is by id; the by-name one is for a person.
      restoreCommand: `cleo cloud restore ${REMOTE_PROJECT} --api-url ${API}`,
      restoreByNameCommand: `cleo cloud restore 'Demo Board' --api-url ${API}`,
    });
    expect(result.nextCommand).toBe(`cleo cloud restore ${REMOTE_PROJECT} --api-url ${API}`);
    // Listing is a read: no mint, escrow, certify or key write.
    expect(fake.writes.slice(writesBefore)).toEqual([]);
    // A, which holds the project, is told it is already there.
    const onA = await listNexusNamedProjects(vopts(b, { deviceId: DEVICE_A }));
    expect(onA.projects[0]?.onThisDevice).toBe(true);
    expect(onA.projects[0]?.restoreCommand).toBeNull();
  });

  it('cleo cloud restore <name> resolves the name and restores the project onto the new machine', async () => {
    const { b } = await firstRunOnA();
    nameOnServer('Demo Board');
    const ref = await on(b, () => resolveNexusProjectRef('demo board', vopts(b)));
    expect(ref).toEqual({ projectId: REMOTE_PROJECT, name: 'Demo Board', matchedBy: 'name' });
    const restored = await on(b, () =>
      restoreNexusVault(
        vopts(b, {
          mode: 'restore',
          projectId: ref.projectId,
          into: b.root,
          relink: async () => {
            link(b);
            return [];
          },
        }),
      ),
    );
    expect(restored.status).toBe('restored');
    expect(taskCount(b)).toBe(5);
    // The id resolves without listing.
    expect((await on(b, () => resolveNexusProjectRef(REMOTE_PROJECT, vopts(b)))).matchedBy).toBe(
      'id',
    );
  });

  it('a non-interactive run inside the unlinked project pushes nothing and prints the next command', async () => {
    const a = await machine('a', DEVICE_A, REPLICA_A);
    fake.addProject(REMOTE_PROJECT, { [REPLICA_A]: DEVICE_A });
    seedProject(a, 2);
    const result = await on(a, () =>
      runNexusFirstRun({ ...vopts(a), consent: 'never', deviceId: DEVICE_A }),
    );
    expect(result.state).toBe('offered');
    expect(result.nextCommand).toBe(
      `cleo project link --api-url ${API} && cleo cloud push --api-url ${API}`,
    );
    expect(fake.writes).toEqual([]);
    expect(fs.existsSync(path.join(a.root, '.cleo', 'nexus-link.json'))).toBe(false);
  });
  /** This project's link with the server id equal to the tracked local id, as in production. */
  function linkSameId(m: Machine): void {
    fs.mkdirSync(path.join(m.root, '.cleo'), { recursive: true });
    fs.writeFileSync(
      path.join(m.root, '.cleo', 'nexus-link.json'),
      JSON.stringify({
        version: 1,
        links: {
          [API]: {
            apiUrl: API,
            localProjectId: LOCAL_PROJECT,
            remoteProjectId: LOCAL_PROJECT,
            organizationId: ORG,
            label: 'demo',
            streamId: `project:${LOCAL_PROJECT}`,
            linkedAt: NOW,
            replicaId: m.replicaId,
            nexusDeviceId: m.deviceId,
            attachedAt: NOW,
          },
        },
      }),
    );
  }

  /** A pushed the project (server id = local id); B holds a fresh git clone: the tracked id, no store. */
  async function backedUpAndCloned() {
    const a = await machine('a', DEVICE_A, REPLICA_A);
    const b = await machine('b', DEVICE_B, REPLICA_B);
    fake.addProject(LOCAL_PROJECT, { [REPLICA_A]: DEVICE_A, [REPLICA_B]: DEVICE_B });
    seedProject(a, 5);
    linkSameId(a);
    await on(a, () => pushNexusVault(vopts(a)));
    fs.mkdirSync(path.join(b.root, '.cleo'), { recursive: true });
    fs.writeFileSync(path.join(b.root, '.cleo', 'project-id'), `${LOCAL_PROJECT}\n`);
    return { a, b };
  }

  function sameIdLinkResult(m: Machine) {
    return async () => {
      linkSameId(m);
      return {
        link: {
          apiUrl: API,
          localProjectId: LOCAL_PROJECT,
          remoteProjectId: LOCAL_PROJECT,
          organizationId: ORG,
          label: 'demo',
          streamId: `project:${LOCAL_PROJECT}`,
          linkedAt: NOW,
        },
        alreadyLinked: true,
        linkPath: path.join(m.root, '.cleo', 'nexus-link.json'),
        replica: {
          replicaId: m.replicaId,
          deviceId: m.deviceId,
          reboundFrom: null,
          presenceAt: NOW,
        },
        attachError: null,
        warnings: [],
      };
    };
  }

  it('the unsynced-backup check: true for a fresh clone, false for the copy that pushed it', async () => {
    const { a, b } = await backedUpAndCloned();
    const query = (m: Machine) => ({
      ...vopts(m),
      apiUrl: API,
      projectRoot: m.root,
      projectId: LOCAL_PROJECT,
    });
    expect(await on(b, () => hasUnsyncedNexusBackup(query(b)))).toBe(true);
    expect(await on(a, () => hasUnsyncedNexusBackup(query(a)))).toBe(false);
    // A project the server does not have, or with no snapshot, needs a backup, not a restore.
    expect(
      await on(b, () => hasUnsyncedNexusBackup({ ...query(b), projectId: OTHER_PROJECT })),
    ).toBe(false);
  });

  it('a fresh clone on a new machine: --yes restores the backup there and links it, pushing nothing', async () => {
    const { b } = await backedUpAndCloned();
    const writesBefore = fake.writes.length;
    const result = await on(b, () =>
      runNexusFirstRun({
        ...vopts(b),
        consent: 'yes',
        deviceId: DEVICE_B,
        link: sameIdLinkResult(b),
      }),
    );
    expect(result.state).toBe('restored');
    expect(result.offer).toBe('restore');
    expect(result.restore?.status).toBe('restored');
    expect(result.link?.remoteProjectId).toBe(LOCAL_PROJECT);
    expect(taskCount(b)).toBe(5);
    // Restoring reads the snapshot; it never pushes a segment or checkpoint.
    expect(
      fake.writes.slice(writesBefore).filter((w) => /segments|checkpoints|blobs/.test(w)),
    ).toEqual([]);
  });

  it('a fresh clone, non-interactive: restores nothing and names the restore command', async () => {
    const { b } = await backedUpAndCloned();
    const result = await on(b, () =>
      runNexusFirstRun({ ...vopts(b), consent: 'never', deviceId: DEVICE_B }),
    );
    expect(result.state).toBe('offered');
    expect(result.offer).toBe('restore');
    expect(result.nextCommand).toContain(`cleo cloud restore ${LOCAL_PROJECT} --into `);
    expect(result.nextCommand).toContain(`--api-url ${API}`);
    expect(fs.existsSync(path.join(b.root, '.cleo', 'cleo.db'))).toBe(false);
  });
});
