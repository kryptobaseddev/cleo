import { z } from 'zod';
import { Base64, DeviceId, Hlc, ProjectId, ReplicaId, Sha256Hex, StreamId } from './ids.js';

/**
 * Wire contract for the Cleo Nexus API (v1).
 *
 * Privacy rule: the server never receives plaintext content (ADR-093). Everything below is
 * routing or integrity metadata. Content travels only as ciphertext (`Base64`) or as blobs
 * addressed by the sha256 of their ciphertext.
 */

export const API_VERSION = 'v1' as const;

/** Largest inline segment. Larger segments go to R2 as a blob and are referenced by sha256. */
export const MAX_INLINE_SEGMENT_BYTES = 1_048_576;
export const MAX_PULL_LIMIT = 500;

// ---------- devices ----------

export const Platform = z.enum(['darwin', 'linux', 'win32', 'other']);

export const RegisterDeviceRequest = z.object({
  deviceId: DeviceId,
  name: z.string().min(1).max(120),
  platform: Platform,
  /** X25519 public key, base64 (32 bytes). Used to wrap the user master key for this device. */
  encryptionPublicKey: Base64,
  /** Ed25519 public key, base64 (32 bytes). Verifies segments this device's replicas sign. */
  signingPublicKey: Base64,
  cliVersion: z.string().max(40),
});
export type RegisterDeviceRequest = z.infer<typeof RegisterDeviceRequest>;

export const Device = z.object({
  deviceId: DeviceId,
  name: z.string(),
  platform: Platform,
  encryptionPublicKey: Base64,
  signingPublicKey: Base64,
  cliVersion: z.string(),
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
});
export type Device = z.infer<typeof Device>;

// ---------- projects ----------

export const RegisterProjectRequest = z.object({
  projectId: ProjectId,
  /**
   * Optional plaintext label for the web view. The client decides whether to reveal a name;
   * the default is the encrypted name only.
   */
  label: z.string().max(120).optional(),
  /** The project name, encrypted with the project data key. */
  encryptedName: Base64.optional(),
  /** The git origin, only if the user opts in (it can reveal a private repo's name). */
  remoteUrl: z.string().max(500).optional(),
  /**
   * The organization that will own the project. The caller must be a member of it. Defaults to the
   * caller's personal organization, which every account has.
   */
  organizationId: z.string().uuid().optional(),
});
export type RegisterProjectRequest = z.infer<typeof RegisterProjectRequest>;

export const Project = z.object({
  projectId: ProjectId,
  label: z.string().nullable(),
  encryptedName: Base64.nullable(),
  remoteUrl: z.string().nullable(),
  /** Projects are owned by an organization. Access derives from membership (ADR-095, ownership). */
  organizationId: z.string().uuid(),
  /** Who registered the project. Provenance only: it grants nothing. Null once that account is deleted. */
  createdByUserId: z.string().uuid().nullable(),
  createdAt: z.iso.datetime(),
});
export type Project = z.infer<typeof Project>;

/**
 * Which devices hold a project. The server stores NO filesystem path, not even as a hint.
 * Paths are per-device local state (cleo-dev review, 2026-09-27).
 */
export const AttachProjectDeviceRequest = z.object({
  deviceId: DeviceId,
  replicaId: ReplicaId,
});

/**
 * Path-free presence of one replica, for fleet status (cleo-dev SG-AGENTIC-CORE, T12479).
 * The device keeps the full record, including paths. The cloud mirrors only this.
 */
export const ReplicaPresence = z.object({
  git: z
    .object({
      /** Sent only when the user opts in: branch names can be sensitive. */
      branch: z.string().max(200).optional(),
      dirty: z.boolean(),
      ahead: z.number().int().nonnegative(),
      behind: z.number().int().nonnegative(),
      /** The remote tracking state: in sync, diverged, no upstream, or unknown. */
      remote: z.enum(['in-sync', 'ahead', 'behind', 'diverged', 'no-upstream', 'unknown']),
      lastCommitAt: z.iso.datetime().optional(),
    })
    .optional(),
  cliVersion: z.string().max(40),
  schemaVersion: z.number().int().positive(),
  /** When the device measured this. The server also records when it received it. */
  observedAt: z.iso.datetime(),
});
export type ReplicaPresence = z.infer<typeof ReplicaPresence>;

// ---------- journal segments ----------

/**
 * Per-table row deltas in a segment: plaintext counts, no content. They let the server check a
 * checkpoint manifest for regressions without reading any row (E_REGRESSION).
 */
export const TableDeltas = z.record(
  z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
  z.object({ created: z.number().int().nonnegative(), deleted: z.number().int().nonnegative() }),
);
export type TableDeltas = z.infer<typeof TableDeltas>;

export const AppendSegmentRequest = z
  .object({
    replicaId: ReplicaId,
    deviceId: DeviceId,
    /** sha256 of the ciphertext bytes. With `replicaId`, it is the idempotency key. */
    segmentHash: Sha256Hex,
    /** The replica's own monotonically increasing segment counter, so gaps are detectable. */
    replicaSeq: z.number().int().nonnegative(),
    schemaVersion: z.number().int().positive(),
    opCount: z.number().int().positive(),
    hlcMin: Hlc,
    hlcMax: Hlc,
    deltas: TableDeltas,
    /** Ed25519 signature over segmentSigningMessage(...) by the device signing key. Base64. */
    signature: Base64,
    ciphertext: Base64.optional(),
    /** Set instead of `ciphertext` for segments over MAX_INLINE_SEGMENT_BYTES (uploaded first). */
    blobSha256: Sha256Hex.optional(),
  })
  .refine((r) => (r.ciphertext === undefined) !== (r.blobSha256 === undefined), {
    message: 'exactly one of ciphertext or blobSha256 is required',
  })
  .refine((r) => r.hlcMin <= r.hlcMax, { message: 'hlcMin must not exceed hlcMax' });
export type AppendSegmentRequest = z.infer<typeof AppendSegmentRequest>;

export const AppendSegmentResult = z.object({
  streamId: StreamId,
  /** The server-assigned position in the stream. */
  seq: z.number().int().positive(),
  /** True when this exact segment was already stored. The retry was a no-op. */
  duplicate: z.boolean(),
});
export type AppendSegmentResult = z.infer<typeof AppendSegmentResult>;

export const Segment = z.object({
  seq: z.number().int().positive(),
  replicaId: ReplicaId,
  deviceId: DeviceId,
  replicaSeq: z.number().int().nonnegative(),
  segmentHash: Sha256Hex,
  schemaVersion: z.number().int().positive(),
  opCount: z.number().int().positive(),
  hlcMin: Hlc,
  hlcMax: Hlc,
  deltas: TableDeltas,
  signature: Base64,
  ciphertext: Base64.nullable(),
  blobSha256: Sha256Hex.nullable(),
  receivedAt: z.iso.datetime(),
});
export type Segment = z.infer<typeof Segment>;

export const PullSegmentsQuery = z.object({
  after: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().positive().max(MAX_PULL_LIMIT).default(100),
});

export const PullSegmentsResult = z.object({
  streamId: StreamId,
  segments: z.array(Segment),
  /** The stream head at read time. When `nextAfter < head`, keep pulling. */
  head: z.number().int().nonnegative(),
  nextAfter: z.number().int().nonnegative(),
});
export type PullSegmentsResult = z.infer<typeof PullSegmentsResult>;

// ---------- checkpoints ----------

export const TableManifestEntry = z.object({
  rows: z.number().int().nonnegative(),
  /** Canonical content hash keyed by uid (Gate D). The same algorithm runs in core and on replay. */
  hash: Sha256Hex,
});

/** Plaintext manifest: per-table counts and uid-keyed hashes. No content (ADR-093 §3). */
export const Manifest = z.object({
  schemaVersion: z.number().int().positive(),
  tables: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,62}$/), TableManifestEntry),
});
export type Manifest = z.infer<typeof Manifest>;

export const CreateCheckpointRequest = z.object({
  replicaId: ReplicaId,
  /** null only for a stream's genesis checkpoint. */
  parentCheckpointId: z.string().uuid().nullable(),
  /** The last stream seq whose ops are folded into this checkpoint. */
  coversSeq: z.number().int().nonnegative(),
  manifest: Manifest,
  /** The encrypted checkpoint bundle, uploaded to R2 first. */
  blobSha256: Sha256Hex,
  sizeBytes: z.number().int().positive(),
});
export type CreateCheckpointRequest = z.infer<typeof CreateCheckpointRequest>;

export const Checkpoint = z.object({
  checkpointId: z.string().uuid(),
  streamId: StreamId,
  parentCheckpointId: z.string().uuid().nullable(),
  replicaId: ReplicaId,
  coversSeq: z.number().int().nonnegative(),
  manifest: Manifest,
  blobSha256: Sha256Hex,
  sizeBytes: z.number().int().positive(),
  createdAt: z.iso.datetime(),
});
export type Checkpoint = z.infer<typeof Checkpoint>;

// ---------- blobs ----------

export const PresignUploadRequest = z.object({
  sha256: Sha256Hex,
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(5 * 1024 ** 3),
  purpose: z.enum(['segment', 'checkpoint', 'attachment']),
});
export const PresignUploadResult = z.object({
  /** True when the blob is already stored and verified. Skip the upload. */
  alreadyPresent: z.boolean(),
  uploadUrl: z.string().nullable(),
  /** Headers the uploader must send exactly (signed). They include the sha256 checksum the store enforces. */
  uploadHeaders: z.record(z.string(), z.string()).nullable(),
  expiresAt: z.iso.datetime().nullable(),
});
export type PresignUploadResult = z.infer<typeof PresignUploadResult>;

// ---------- elected-writer leases (T12338) ----------

/**
 * Roles that must run on exactly one replica per stream (cleo-dev review R4). Consolidation
 * writes (invalid_at, citation_count), sentient proposals and checkpoint authoring would otherwise
 * produce op storms or duplicates. Ordinary journal appends are not leased, because merge handles concurrency.
 */
export const LeaseRole = z.enum(['consolidator', 'sentient', 'checkpointer']);
export type LeaseRole = z.infer<typeof LeaseRole>;

export const AcquireLeaseRequest = z.object({
  role: LeaseRole,
  replicaId: ReplicaId,
  ttlSeconds: z.number().int().min(15).max(3600).default(300),
  /** Take the lease from a live holder. The server records a labelled fork event. */
  force: z.boolean().default(false),
  reason: z.string().max(300).optional(),
});
export const Lease = z.object({
  streamId: StreamId,
  role: LeaseRole,
  leaseId: z.string().uuid(),
  replicaId: ReplicaId,
  expiresAt: z.iso.datetime(),
  /** Set when this lease was taken by force from another replica. */
  forkedFromReplicaId: ReplicaId.nullable(),
});
export type Lease = z.infer<typeof Lease>;

// ---------- keys (E2E; the server stores wrapped keys only) ----------

export const KdfParams = z.object({
  algorithm: z.literal('argon2id'),
  memoryKiB: z.number().int().min(65536),
  iterations: z.number().int().min(2),
  parallelism: z.number().int().min(1),
  salt: Base64,
});

export const PutUserKeysRequest = z.object({
  /** The user master key wrapped by a passphrase-derived key (XChaCha20-Poly1305). */
  passphraseWrappedMasterKey: Base64,
  kdf: KdfParams,
  /** The master key wrapped by the recovery key, which is shown to the user once. */
  recoveryWrappedMasterKey: Base64,
  /** sha256 of the master key's public verifier, so a wrong unwrap is detected client-side. */
  masterKeyVerifier: Sha256Hex,
  keyVersion: z.number().int().positive(),
});

export const PutDeviceWrappedKeyRequest = z.object({
  /** The master key sealed to this device's X25519 key. */
  sealedMasterKey: Base64,
  keyVersion: z.number().int().positive(),
});

export const PutProjectKeyRequest = z.object({
  /** The project data key, wrapped by the member's master key. */
  wrappedProjectKey: Base64,
  keyVersion: z.number().int().positive(),
});

// ---------- conflicts (metadata only; the content stays E2E) ----------

export const ConflictSummary = z.object({
  replicaId: ReplicaId,
  open: z.number().int().nonnegative(),
  byKind: z.record(z.string().max(60), z.number().int().nonnegative()),
  reportedAt: z.iso.datetime(),
});
