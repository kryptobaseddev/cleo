/**
 * Cloud vault contracts: `cleo cloud push | pull | restore | verify | activity | lease`.
 *
 * The vault keeps encrypted snapshots of a project's (or this account's
 * global) CLEO state on Cleo Nexus, as checkpoints on the project's journal
 * stream (or the account's `home:` stream). The server stores ciphertext plus
 * a plaintext manifest of per-table row counts and keyed hashes, and refuses a
 * snapshot that does not descend from the stream head or whose counts do not
 * reconcile with the journal.
 *
 * Keys (owner decision 2026-10-01): adding a device needs only `cleo login`
 * and the one-time browser approval. The account master key is escrowed on
 * the server (stored encrypted under a server-held key, cleo-nexus T082) and
 * released only to an approved, active device, sealed to that device's X25519
 * key (`GET /v1/account/keys/escrow`). Snapshots are encrypted, but with keys
 * the server can recover: server-escrowed encryption, not zero-knowledge.
 *
 * The response schemas here parse what the API returns for the endpoints the
 * wire contract (`./cloud/api.ts`, mirrored from cleo-nexus) does not yet
 * carry; every object is loose so a newer server's extra fields survive.
 *
 * @task T12336
 * @task T12337
 * @task T12338
 * @epic T12322
 */

import { z } from 'zod';
import type { CloudWarning } from './nexus-cloud.js';

const isoTime = z.iso.datetime({ offset: true });
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

// ---------- wire: reads the vault parses leniently ----------

/** `GET /v1/account/keys` (only the fields the vault reads). */
export const nexusUserKeysSchema = z.looseObject({
  keyVersion: z.number().int().positive(),
  masterKeyVerifier: z.string(),
});

/** `GET /v1/projects/:projectId/keys`: the caller's wrapped project keys, newest first. */
export const nexusProjectKeysSchema = z.looseObject({
  keys: z.array(
    z.looseObject({ wrappedProjectKey: z.string(), keyVersion: z.number().int().positive() }),
  ),
});

// ---------- wire: leases (cleo-nexus T083) ----------

/** The lease role of the vault's single writer. */
export const NEXUS_VAULT_LEASE_ROLE = 'writer';

/** A lease as `POST /v1/streams/:streamId/leases` answers it (parsed leniently). */
export const nexusLeaseSchema = z.looseObject({
  streamId: z.string(),
  role: z.string(),
  replicaId: uuid,
  expiresAt: isoTime,
  forkedFromReplicaId: uuid.nullable().optional(),
});

/** `POST /v1/streams/:streamId/leases`. */
export const nexusLeaseAcquireSchema = z.looseObject({ lease: nexusLeaseSchema });

/** `GET /v1/streams/:streamId`. */
export const nexusStreamHeadSchema = z.looseObject({
  streamId: z.string(),
  kind: z.string().optional(),
  headSeq: z.number().int().nonnegative(),
  headCheckpointId: z.string().nullable(),
  /**
   * The highest segment `schemaVersion` the stream holds (the server raises it on every append).
   * Absent from an older server.
   */
  maxSchemaVersion: z.number().int().nonnegative().optional(),
});

// ---------- wire: activity (E18 `GET /v1/account/activity`) ----------

/** One audit event of the caller's own activity. */
export const nexusActivityEventSchema = z.looseObject({
  id: z.union([z.string(), z.number()]),
  at: isoTime,
  actorUserId: z.string().nullable().optional(),
  actorDeviceId: z.string().nullable().optional(),
  requestId: z.string().nullable().optional(),
  action: z.string(),
  target: z.string().nullable().optional(),
  detail: z.unknown().optional(),
});

/** `GET /v1/account/activity`, one page. */
export const nexusActivityPageSchema = z.looseObject({
  events: z.array(nexusActivityEventSchema),
  nextBefore: z.union([z.string(), z.number()]).nullable().optional(),
});

/** Parsed activity event. */
export type NexusActivityEvent = z.infer<typeof nexusActivityEventSchema>;

// ---------- results ----------

/** Which store a vault command acts on: the current project, or this account's global store. */
export type CloudVaultScope = 'project' | 'global';

/** One table of a snapshot manifest. */
export interface CloudVaultTable {
  /** Manifest key (the table name). */
  table: string;
  /** Row count. */
  rows: number;
  /** Keyed hash of the rows (hex). */
  hash: string;
}

/** A per-table comparison line. */
export interface CloudVaultTableDiff {
  table: string;
  /** Rows on this machine, or `null` when the table is absent here. */
  localRows: number | null;
  /** Rows in the compared snapshot, or `null` when absent there. */
  cloudRows: number | null;
  /** Rows and hash both equal. */
  match: boolean;
}

/** One snapshot (checkpoint) in a stream's lineage. */
export interface CloudVaultSnapshot {
  checkpointId: string;
  parentCheckpointId: string | null;
  deviceId: string;
  /** The device's name, when the account's device list has it. */
  deviceName: string | null;
  replicaId: string;
  coversSeq: number;
  createdAt: string | null;
  sizeBytes: number;
  /** Total rows over the manifest. */
  rows: number;
  /** Devices that endorsed (co-signed) it. */
  endorsedBy: string[];
}

/** A live lease on the stream. */
export interface CloudVaultLease {
  role: string;
  replicaId: string;
  deviceId: string | null;
  deviceName: string | null;
  expiresAt: string;
  /** Set when the lease was taken by force: a labelled fork. */
  forkedFromReplicaId: string | null;
  /** When the current holder took it, when the server says. */
  acquiredAt?: string | null;
  /** This machine holds it. */
  mine: boolean;
}

/** `cleo cloud push`. */
export interface CloudPushResult {
  apiUrl: string;
  scope: CloudVaultScope;
  streamId: string;
  /** `pushed`: a new snapshot; `up-to-date`: nothing changed since the head snapshot. */
  status: 'pushed' | 'up-to-date';
  snapshot: CloudVaultSnapshot | null;
  /** The snapshot this one descends from. */
  parentCheckpointId: string | null;
  /** The delta segment appended so the counts reconcile, if one was needed. */
  deltaSegmentSeq: number | null;
  /** The lease this push holds. */
  lease: CloudVaultLease | null;
  /**
   * A labelled fork: pushed with `--force` over a head this store had not synced, or after
   * taking another device's live lease. The label is on the snapshot itself (T13007).
   */
  forked: boolean;
  warnings: CloudWarning[];
}

/** `cleo cloud pull` / `cleo cloud restore`. */
export interface CloudRestoreResult {
  apiUrl: string;
  scope: CloudVaultScope;
  streamId: string;
  /** `restored`: the snapshot was activated; `up-to-date`: this machine already holds the head. */
  status: 'restored' | 'up-to-date';
  snapshot: CloudVaultSnapshot | null;
  /** Where the store was placed (project root, or the CLEO home for global). */
  target: string;
  /** Every table's count and hash matched the manifest before activation. */
  verified: boolean;
  /** Tables checked. */
  tables: number;
  /** Local safety backup taken before activation, if any. */
  safetyBackup: string | null;
  /**
   * The placed file is a new store instance, so the replica this store had is
   * retired and a new one bound (journal spec §1.5; T13109). The server keeps
   * the retired one as history until S4 announces its retirement. `null` when
   * nothing was placed or the store had no replica yet (a first restore here).
   *
   * `reason` is `vault-restore` when the retired replica was this device's
   * replica of the replaced file (a retire candidate), `file-identity` or
   * `foreign-device` when the store was a copy or another device's (nothing to
   * retire), and `null` when the rebind's registry record failed.
   */
  replica: {
    retired: string;
    current: string;
    reason: 'vault-restore' | 'file-identity' | 'foreign-device' | null;
  } | null;
  warnings: CloudWarning[];
}

/** `cleo cloud verify`. */
export interface CloudVerifyResult {
  apiUrl: string;
  scope: CloudVaultScope;
  streamId: string;
  /** `match`: local equals the head snapshot; `ahead`: local changed since this machine's last snapshot; `behind`: the cloud has a newer snapshot; `diverged`: both; `empty`: no snapshot yet; `untrusted`: the head snapshot's signature does not verify against a trusted device key (nothing is compared with it). */
  verdict: 'match' | 'ahead' | 'behind' | 'diverged' | 'empty' | 'untrusted';
  /** What to do about a verdict other than `match` (or a failed integrity check); `null` when nothing. */
  remedy: string | null;
  /** Local store passed SQLite integrity_check. */
  localIntegrity: boolean;
  head: CloudVaultSnapshot | null;
  /** This machine's last pushed or restored snapshot. */
  lastSynced: string | null;
  /** Local vs head snapshot, per table. */
  tables: CloudVaultTableDiff[];
  /** The newest snapshot each device wrote, and whether its manifest equals the head's. */
  devices: Array<{
    deviceId: string;
    deviceName: string | null;
    checkpointId: string;
    createdAt: string | null;
    matchesHead: boolean;
  }>;
  warnings: CloudWarning[];
}

/** `cleo cloud vault` (status of the vault for the current store). */
export interface CloudVaultStatusResult {
  apiUrl: string;
  scope: CloudVaultScope;
  streamId: string;
  headSeq: number;
  head: CloudVaultSnapshot | null;
  /** Newest first, at most 100 (the server's list ceiling). */
  lineage: CloudVaultSnapshot[];
  /** Newest snapshot per device. */
  lastPushByDevice: Array<{
    deviceId: string;
    deviceName: string | null;
    checkpointId: string;
    createdAt: string | null;
  }>;
  /** Tables whose local rows or hash differ from this machine's last snapshot. */
  pendingChanges: CloudVaultTableDiff[];
  lastSynced: string | null;
  leases: CloudVaultLease[];
  warnings: CloudWarning[];
}

/** `cleo cloud lease release`. */
export interface CloudLeaseReleaseResult {
  apiUrl: string;
  scope: CloudVaultScope;
  streamId: string;
  released: boolean;
  warnings: CloudWarning[];
}

/** One line of `cleo cloud activity`. */
export interface CloudActivityItem {
  at: string;
  action: string;
  target: string | null;
  deviceId: string | null;
  deviceName: string | null;
  /** This machine did it. */
  thisDevice: boolean;
}

/** `cleo cloud activity`. */
export interface CloudActivityResult {
  apiUrl: string;
  /** The project the list is filtered to, if any. */
  projectId: string | null;
  items: CloudActivityItem[];
  /** The server has older events (`--before` this). */
  nextBefore: string | null;
  warnings: CloudWarning[];
}
