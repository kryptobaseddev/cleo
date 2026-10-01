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

/**
 * The highest key version any schema accepts. Key versions go up by one per rotation, so this is far above
 * any real account, and it keeps an absurd value (2^53 - 1, say) out of client state.
 */
export const MAX_KEY_VERSION = 1_000_000;

/** A master key or project key version: a positive integer, at most MAX_KEY_VERSION. */
export const KeyVersion = z.number().int().positive().max(MAX_KEY_VERSION);

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
  /**
   * The device certificate from this device's current key grant: an HMAC under a key derived from the
   * user master key over deviceCertificateMessage(...). Only a holder of the master key can make one,
   * so a client that holds the master key can tell the user's real devices from rows the server
   * invented (docs/security/e2e-keys.md, "Device trust"). Null until the device holds a grant.
   */
  certificate: Base64.nullable(),
  /** The master key version the certificate was made under. */
  certificateKeyVersion: KeyVersion.nullable(),
});
export type Device = z.infer<typeof Device>;

export const ListDevicesResult = z.object({ devices: z.array(Device) });
export type ListDevicesResult = z.infer<typeof ListDevicesResult>;

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

export const RegisterProjectResult = z.object({ project: Project, streamId: StreamId });
export type RegisterProjectResult = z.infer<typeof RegisterProjectResult>;

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

// ---------- home-stream replicas (T084) ----------

/**
 * `POST /v1/account/home/replicas`: the calling device attaches the replica of its global store (the one that
 * writes `home:<userId>`) to the account. Like a project replica, the replica is pinned to one device for good.
 */
export const AttachHomeReplicaRequest = z.object({
  /** The calling device. */
  deviceId: DeviceId,
  replicaId: ReplicaId,
});
export type AttachHomeReplicaRequest = z.infer<typeof AttachHomeReplicaRequest>;

/** A home-stream replica as the account lists it (`GET /v1/account/home/replicas`). */
export const HomeReplica = z.object({
  replicaId: ReplicaId,
  deviceId: DeviceId,
  deviceState: z.enum(['active', 'signed-out', 'revoked']),
  attachedAt: z.iso.datetime(),
  /** The last segment this replica appended to the home stream. */
  lastSyncAt: z.iso.datetime().nullable(),
  presence: ReplicaPresence.nullable(),
  presenceAt: z.iso.datetime().nullable(),
});
export type HomeReplica = z.infer<typeof HomeReplica>;

/**
 * `POST /v1/account/home/replicas`: the attached replica, flat like the project attach answer (`replicaId` at the
 * top). 201 on the first attach, 200 when this device already holds it.
 */
export const AttachHomeReplicaResult = HomeReplica;
export type AttachHomeReplicaResult = z.infer<typeof AttachHomeReplicaResult>;

/** `PUT /v1/account/home/replicas/:replicaId/presence` (body: ReplicaPresence). */
export const HomeReplicaPresenceResult = z.object({
  replicaId: ReplicaId,
  presenceAt: z.iso.datetime(),
});
export type HomeReplicaPresenceResult = z.infer<typeof HomeReplicaPresenceResult>;

/** `GET /v1/account/home/replicas`: every home replica of the caller's account, oldest attachment first. */
export const ListHomeReplicasResult = z.object({ replicas: z.array(HomeReplica) });
export type ListHomeReplicasResult = z.infer<typeof ListHomeReplicasResult>;

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
    /**
     * Ed25519 signature by the device signing key over segmentSigningMessage (v2), which covers the
     * stream, replica, device, replicaSeq, the ciphertext hash and the hash of every metadata field
     * above (segmentMetaCanonical). The server verifies it on append; every client re-verifies it on pull.
     */
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

/**
 * A checkpoint id (UUIDv7). The authoring client mints it, because its signature and the bundle's AAD
 * both cover it, so the id must exist before the bundle is encrypted.
 */
export const CheckpointId = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    'expected a UUIDv7 checkpoint id',
  );
export type CheckpointId = z.infer<typeof CheckpointId>;

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

/**
 * Where one replica stood at a checkpoint: the device that signs its segments and the last replicaSeq
 * folded in. A checkpoint lists every replica with a segment at or below its coversSeq, so a client that
 * restores it can check every later segment for gaps and re-attribution (PullCursor).
 */
export const ReplicaHead = z.object({
  deviceId: DeviceId,
  lastReplicaSeq: z.number().int().nonnegative(),
});
export type ReplicaHead = z.infer<typeof ReplicaHead>;

/** Per replica id, keys are replica ids. Covered by the checkpoint signature (replicasCanonical). */
export const ReplicaHeads = z.record(ReplicaId, ReplicaHead);
export type ReplicaHeads = z.infer<typeof ReplicaHeads>;

export const CreateCheckpointRequest = z.object({
  /** Minted by the author: the signature and the bundle's AAD both cover it. */
  checkpointId: CheckpointId,
  replicaId: ReplicaId,
  /** The authoring device. It must be the calling device. */
  deviceId: DeviceId,
  /** null only for a stream's genesis checkpoint. */
  parentCheckpointId: z.string().uuid().nullable(),
  /** The last stream seq whose ops are folded into this checkpoint. */
  coversSeq: z.number().int().nonnegative(),
  manifest: Manifest,
  /** Every replica with a segment at or below coversSeq. The server checks it against the journal. */
  replicas: ReplicaHeads,
  /** The encrypted checkpoint bundle, uploaded to R2 first. */
  blobSha256: Sha256Hex,
  sizeBytes: z.number().int().positive(),
  /**
   * Ed25519 signature by the authoring device over checkpointSigningMessage(...): the stream, the
   * checkpoint and parent ids, replica, device, coversSeq, the manifest hash (manifestCanonical), the
   * replica map hash (replicasCanonical), the bundle sha256 and size. The server verifies it on create;
   * a client verifies it before restoring. Creating the same checkpoint again is a no-op.
   */
  signature: Base64,
});
export type CreateCheckpointRequest = z.infer<typeof CreateCheckpointRequest>;

export const Checkpoint = z.object({
  checkpointId: CheckpointId,
  streamId: StreamId,
  parentCheckpointId: CheckpointId.nullable(),
  replicaId: ReplicaId,
  deviceId: DeviceId,
  coversSeq: z.number().int().nonnegative(),
  manifest: Manifest,
  replicas: ReplicaHeads,
  blobSha256: Sha256Hex,
  sizeBytes: z.number().int().positive(),
  signature: Base64,
  /**
   * Re-signatures by other devices (checkpointEndorsementMessage). A client accepts a checkpoint whose
   * author it no longer trusts without a pin (a revoked device) when a live device endorsed it.
   */
  endorsements: z.array(z.object({ deviceId: DeviceId, signature: Base64 })),
  createdAt: z.iso.datetime(),
});
export type Checkpoint = z.infer<typeof Checkpoint>;

/** A live device re-signs a checkpoint. The device must be the calling device. */
export const EndorseCheckpointRequest = z.object({ deviceId: DeviceId, signature: Base64 });
export type EndorseCheckpointRequest = z.infer<typeof EndorseCheckpointRequest>;

export const CreateCheckpointResult = z.object({ checkpoint: Checkpoint });
export type CreateCheckpointResult = z.infer<typeof CreateCheckpointResult>;

/** Newest first, at most 100. */
export const ListCheckpointsResult = z.object({ checkpoints: z.array(Checkpoint) });
export type ListCheckpointsResult = z.infer<typeof ListCheckpointsResult>;

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

export const CompleteUploadResult = z.object({ sha256: Sha256Hex, verified: z.literal(true) });
export type CompleteUploadResult = z.infer<typeof CompleteUploadResult>;

/**
 * A short-lived presigned download URL. The response of `GET /v1/streams/:streamId/segments/:seq/blob`
 * and of `GET /v1/streams/:streamId/checkpoints/:checkpointId/download`. The client downloads at most
 * `sizeBytes` and checks the bytes against the sha256 it already trusts, never against this one alone.
 */
export const BlobDownload = z.object({
  url: z.string().min(1),
  sha256: Sha256Hex,
  sizeBytes: z.number().int().positive(),
  expiresInSeconds: z.number().int().positive(),
});
export type BlobDownload = z.infer<typeof BlobDownload>;

// ---------- elected-writer leases (T12338) ----------

/**
 * Roles that must run on exactly one replica per stream (cleo-dev review R4). Consolidation
 * writes (invalid_at, citation_count), sentient proposals and checkpoint authoring would otherwise
 * produce op storms or duplicates. Ordinary journal appends are not leased, because merge handles concurrency.
 * `writer` is the CLI's single-writer lease (T083): the one replica that pushes a stream while concurrent
 * writers are not supported.
 */
export const LeaseRole = z.enum(['consolidator', 'sentient', 'checkpointer', 'writer']);
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

/** A live lease as `GET /v1/streams/:streamId/leases` lists it (T083). */
export const ListedLease = Lease.extend({
  /**
   * The device holding the lease: the device that acquired it, else the device the replica is attached
   * from (project streams). Null when neither is known (a lease from before this was recorded).
   */
  deviceId: DeviceId.nullable(),
  /** When the current holder took the lease (a renewal keeps it). */
  acquiredAt: z.iso.datetime(),
});
export type ListedLease = z.infer<typeof ListedLease>;

/** `GET /v1/streams/:streamId/leases`: the stream's live leases, by role. Expired leases are omitted. */
export const ListLeasesResult = z.object({ leases: z.array(ListedLease) });
export type ListLeasesResult = z.infer<typeof ListLeasesResult>;

// ---------- keys (E2E; the server stores wrapped keys only) ----------

/**
 * Bounds on Argon2id parameters. The server stores the parameters, so a client must not trust them: too
 * low weakens the passphrase, too high is a denial of service (a 64 GiB allocation). Both sides enforce these.
 */
export const KDF_LIMITS = {
  memoryKiB: { min: 65_536, max: 1_048_576 },
  iterations: { min: 2, max: 10 },
  parallelism: { min: 1, max: 16 },
} as const;

export const KdfParams = z.object({
  algorithm: z.literal('argon2id'),
  memoryKiB: z.number().int().min(KDF_LIMITS.memoryKiB.min).max(KDF_LIMITS.memoryKiB.max),
  iterations: z.number().int().min(KDF_LIMITS.iterations.min).max(KDF_LIMITS.iterations.max),
  parallelism: z.number().int().min(KDF_LIMITS.parallelism.min).max(KDF_LIMITS.parallelism.max),
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
  keyVersion: KeyVersion,
});

/** What the server returns for `GET /v1/account/keys`. */
export const UserKeys = PutUserKeysRequest.extend({
  /** The account the keys belong to. */
  userId: z.string().uuid(),
  updatedAt: z.iso.datetime(),
});
export type UserKeys = z.infer<typeof UserKeys>;

/**
 * A device key grant: the master key sealed to the recipient device, signed by a device that holds the
 * master key (docs/security/e2e-keys.md, "Device trust"). The sealed box alone is anonymous, so anyone,
 * the server included, could seal a key of their choosing to a device. The signature is what the
 * recipient checks, against a signer it already trusts, before it accepts the key.
 */
export const PutDeviceWrappedKeyRequest = z.object({
  /** The master key sealed to the recipient device's X25519 key. */
  sealedMasterKey: Base64,
  keyVersion: KeyVersion,
  /** The recipient's device certificate (see Device.certificate), made by the signer under the master key. */
  certificate: Base64,
  /** The device that made the grant. It must be the calling device: a self-grant names the recipient. */
  signerDeviceId: DeviceId,
  /** Ed25519 by the signer over deviceGrantMessage(...). */
  grantSignature: Base64,
});
export type PutDeviceWrappedKeyRequest = z.infer<typeof PutDeviceWrappedKeyRequest>;

/** What the server returns for `GET /v1/devices/:deviceId/key`. */
export const DeviceKeyGrant = PutDeviceWrappedKeyRequest.extend({ deviceId: DeviceId });
export type DeviceKeyGrant = z.infer<typeof DeviceKeyGrant>;

// ---------- account key escrow (T082) ----------

/** Unpadded base64url (RFC 4648 §5). */
const Base64Url = z.string().regex(/^[A-Za-z0-9_-]*$/, 'expected unpadded base64url');

/** Exactly 32 bytes as unpadded base64url: 43 characters, the last carrying 2 bits of padding. */
const Key32Base64Url = z
  .string()
  .regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/, 'expected 32 bytes as unpadded base64url');

/**
 * `PUT /v1/account/keys/escrow`: a device that holds the master key escrows it with the server, so a new
 * device needs only `cleo login` and its browser approval to receive it (owner decision, T082). The server
 * stores it encrypted under a server-held key and hands it out only sealed to an active device of the account.
 */
export const PutKeyEscrowRequest = z.object({
  /** The user master key, in clear over TLS: 32 bytes. */
  masterKey: Key32Base64Url,
  keyVersion: KeyVersion,
  /** masterKeyVerifier(masterKey). The server recomputes it and refuses a mismatch. */
  masterKeyVerifier: Sha256Hex,
});
export type PutKeyEscrowRequest = z.infer<typeof PutKeyEscrowRequest>;

/** What the server returns for `PUT /v1/account/keys/escrow`: the stored escrow's identity, never the key. */
export const PutKeyEscrowResult = z.object({
  keyVersion: KeyVersion,
  masterKeyVerifier: Sha256Hex,
  updatedAt: z.iso.datetime(),
});
export type PutKeyEscrowResult = z.infer<typeof PutKeyEscrowResult>;

/**
 * What the server returns for `GET /v1/account/keys/escrow`: the master key sealed (sealTo) to the calling
 * device's X25519 key, under the context `cleo-nexus/escrow/v1:<userId>:<deviceId>`. The device opens it
 * and checks it against `masterKeyVerifier` before use.
 */
export const KeyEscrowGrant = z.object({
  sealedMasterKey: Base64Url,
  keyVersion: KeyVersion,
  masterKeyVerifier: Sha256Hex,
  /** The device the key is sealed to: the calling device. */
  deviceId: DeviceId,
  updatedAt: z.iso.datetime(),
});
export type KeyEscrowGrant = z.infer<typeof KeyEscrowGrant>;

/**
 * Where a revoked signing key stops being trusted: per replica, the last replicaSeq it may have signed,
 * and per stream, the highest coversSeq of a checkpoint it may have signed. Keys are replica ids and
 * stream ids. Covered by the revocation signature (revocationPinsCanonical).
 */
export const RevocationPins = z.object({
  replicas: z.record(ReplicaId, z.number().int().nonnegative()),
  checkpoints: z.record(StreamId, z.number().int().nonnegative()),
});
export type RevocationPins = z.infer<typeof RevocationPins>;

/**
 * A revocation record (docs/security/e2e-keys.md, "Revocation"): a certified device signs that one
 * signing key of a device is revoked, and pins what it signed before. History up to the pins stays
 * verifiable; anything past them is refused. The signer must be the calling device.
 */
export const CreateDeviceRevocationRequest = z.object({
  /** The revoked key (base64 Ed25519 public key): the device's current key or an earlier one. */
  signingPublicKey: Base64,
  pins: RevocationPins,
  signerDeviceId: DeviceId,
  /** Ed25519 by the signer over deviceRevocationMessage(...). */
  signature: Base64,
});
export type CreateDeviceRevocationRequest = z.infer<typeof CreateDeviceRevocationRequest>;

export const DeviceRevocation = CreateDeviceRevocationRequest.extend({ deviceId: DeviceId });
export type DeviceRevocation = z.infer<typeof DeviceRevocation>;

/**
 * One device certificate ever issued, kept for as long as the device's history exists. A revoke or a
 * re-registration with new keys never deletes one. `live` is the server's claim that the key is the
 * device's current key and the device is not revoked; clients trust it only in the safe direction.
 */
export const DeviceCertificateRecord = z.object({
  deviceId: DeviceId,
  encryptionPublicKey: Base64,
  signingPublicKey: Base64,
  keyVersion: KeyVersion,
  certificate: Base64,
  live: z.boolean(),
});
export type DeviceCertificateRecord = z.infer<typeof DeviceCertificateRecord>;

/** `GET /v1/devices/trust`: everything a client needs to build its trusted signer set (certifiedSigners). */
export const DeviceTrust = z.object({
  certificates: z.array(DeviceCertificateRecord),
  revocations: z.array(DeviceRevocation),
});
export type DeviceTrust = z.infer<typeof DeviceTrust>;

export const PutProjectKeyRequest = z.object({
  /** The project data key, wrapped by the member's master key. */
  wrappedProjectKey: Base64,
  keyVersion: KeyVersion,
});

// ---------- conflicts (metadata only; the content stays E2E) ----------

export const ConflictSummary = z.object({
  replicaId: ReplicaId,
  open: z.number().int().nonnegative(),
  byKind: z.record(z.string().max(60), z.number().int().nonnegative()),
  reportedAt: z.iso.datetime(),
});
