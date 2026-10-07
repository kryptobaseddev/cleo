import type {
  Manifest,
  RefDeltas,
  ReplicaHeads,
  RevocationPins,
  TableDeltas,
  TxnDelta,
  TxnRef,
} from '@cleocode/contracts/cloud';

/*
 * The exact bytes every signature and MAC in the E2E protocol covers (docs/security/e2e-keys.md).
 * Each message starts with its own domain string, so a signature made for one purpose never verifies
 * for another. Hashes are lowercase hex sha256; public keys and other binary values are lowercase hex of
 * their raw bytes, so two base64 spellings of one key cannot yield two messages.
 *
 * Hashing is left to the caller (node:crypto), which keeps these helpers identical to the cleo-nexus copy
 * (packages/shared/src/signing.ts). Always hash the UTF-8 bytes of the canonical strings below.
 */

const enc = new TextEncoder();
const lines = (...parts: (string | number)[]) => enc.encode(parts.join('\n'));

/** The metadata a segment carries in plaintext beside its ciphertext. */
export interface SegmentMetaFields {
  schemaVersion: number;
  opCount: number;
  hlcMin: string;
  hlcMax: string;
  deltas: TableDeltas;
  /** segment/v3 only: per-transaction declared deltas (journal spec §2.11). Null or absent: v2. */
  txnDeltas?: readonly TxnDelta[] | null | undefined;
}

const sortedDeltas = (deltas: TableDeltas) =>
  Object.fromEntries(
    Object.keys(deltas)
      .sort()
      .map((t) => {
        const d = deltas[t] ?? { created: 0, deleted: 0 };
        return [t, { created: d.created, deleted: d.deleted }];
      }),
  );

/**
 * Canonical JSON of a segment's plaintext metadata: keys sorted at every level, only the listed fields.
 * Its sha256 (the "meta hash") is covered by the segment signature and by the ciphertext's AAD, so the
 * server cannot change a count, an HLC or a delta without the client noticing. Table names are never
 * integer-like (they start with a letter), so JSON.stringify keeps the sorted insertion order.
 */
export function segmentMetaCanonical(m: SegmentMetaFields): string {
  return JSON.stringify({
    deltas: sortedDeltas(m.deltas),
    hlcMax: m.hlcMax,
    hlcMin: m.hlcMin,
    opCount: m.opCount,
    schemaVersion: m.schemaVersion,
    // v3: in transaction order, each { deltas, txn } with sorted tables.
    ...(m.txnDeltas === undefined || m.txnDeltas === null
      ? {}
      : {
          txnDeltas: [...m.txnDeltas]
            .sort((a, b) => a.txn - b.txn)
            .map((t) => ({ deltas: sortedDeltas(t.deltas), txn: t.txn })),
        }),
  });
}

/** 3 when the segment metadata carries per-transaction deltas (segment/v3), else 2. */
export function segmentSigningVersion(m: {
  txnDeltas?: readonly TxnDelta[] | null | undefined;
}): 2 | 3 {
  return m.txnDeltas === undefined || m.txnDeltas === null ? 2 : 3;
}

/**
 * The bytes a device signs (Ed25519) for a journal segment. It binds the ciphertext hash and the
 * metadata hash to the stream, the replica, the signing device and the replica's position, so a valid
 * segment cannot be replayed into another stream or position, claimed for another device's replica, or
 * served with forged metadata. v3 ({@link segmentSigningVersion}) is the same message under its own
 * domain, for metadata whose hash covers `txnDeltas`.
 */
export function segmentSigningMessage(parts: {
  streamId: string;
  replicaId: string;
  deviceId: string;
  replicaSeq: number;
  segmentHash: string;
  metaHash: string;
  /** 3 when the metadata carries txnDeltas ({@link segmentSigningVersion}), else 2. No default. */
  version: 2 | 3;
}): Uint8Array {
  return lines(
    `cleo-nexus/segment/v${parts.version}`,
    parts.streamId,
    parts.replicaId,
    parts.deviceId,
    parts.replicaSeq,
    parts.segmentHash,
    parts.metaHash,
  );
}

/** Canonical order of transaction refs: replica id, then replicaSeq, then txn. */
export function compareTxnRefs(a: TxnRef, b: TxnRef): number {
  if (a.replicaId !== b.replicaId) return a.replicaId < b.replicaId ? -1 : 1;
  return a.replicaSeq - b.replicaSeq || a.txn - b.txn;
}

const refCanonical = (r: TxnRef) => ({
  replicaId: r.replicaId,
  replicaSeq: r.replicaSeq,
  txn: r.txn,
});
const refDeltasCanonical = (list: readonly RefDeltas[]) =>
  [...list]
    .sort((a, b) => compareTxnRefs(a.ref, b.ref))
    .map((v) => ({ deltas: sortedDeltas(v.deltas), ref: refCanonical(v.ref) }));

/**
 * Canonical JSON of a checkpoint manifest: keys sorted at every level. A v3 manifest adds `pending`,
 * `pruned`, `replayPin`, `revived` and `voided` in key order, each list sorted by transaction ref.
 */
export function manifestCanonical(m: Manifest): string {
  const tables = Object.fromEntries(
    Object.keys(m.tables)
      .sort()
      .map((t) => {
        const e = m.tables[t] ?? { rows: 0, hash: '' };
        return [t, { hash: e.hash, rows: e.rows }];
      }),
  );
  if (m.replayPin === undefined) {
    return JSON.stringify({ schemaVersion: m.schemaVersion, tables });
  }
  const pin = m.replayPin;
  return JSON.stringify({
    pending: [...(m.pending ?? [])].sort(compareTxnRefs).map(refCanonical),
    pruned: sortedRecord(m.pruned ?? {}, (n) => n),
    replayPin: {
      journal: pin.journal,
      transitions: [...pin.transitions]
        .sort((a, b) => a.seq - b.seq)
        .map((t) => ({ journal: t.journal, schemaVersion: t.schemaVersion, seq: t.seq })),
      triggerSetHash: pin.triggerSetHash,
    },
    revived: refDeltasCanonical(m.revived ?? []),
    schemaVersion: m.schemaVersion,
    tables,
    voided: refDeltasCanonical(m.voided ?? []),
  });
}

const sortedRecord = <V, W>(r: Record<string, V>, f: (v: V) => W) =>
  Object.fromEntries(
    Object.keys(r)
      .sort()
      .map((k) => [k, f(r[k] as V)]),
  );

/** Canonical JSON of a checkpoint's replica map: replica ids sorted, then `deviceId`, `lastReplicaSeq`. */
export function replicasCanonical(r: ReplicaHeads): string {
  return JSON.stringify(
    sortedRecord(r, (h) => ({ deviceId: h.deviceId, lastReplicaSeq: h.lastReplicaSeq })),
  );
}

/** Canonical JSON of revocation pins: `checkpoints` then `replicas`, each with sorted keys. */
export function revocationPinsCanonical(p: RevocationPins): string {
  return JSON.stringify({
    checkpoints: sortedRecord(p.checkpoints, (n) => n),
    replicas: sortedRecord(p.replicas, (n) => n),
  });
}

/** The fields a checkpoint signature covers, in message order. */
export interface CheckpointSigningParts {
  streamId: string;
  checkpointId: string;
  parentCheckpointId: string | null;
  replicaId: string;
  deviceId: string;
  coversSeq: number;
  manifestHash: string;
  /** sha256 hex of replicasCanonical(replicas). */
  replicasHash: string;
  blobSha256: string;
  sizeBytes: number;
  /** 3 for a v3 manifest (manifestVersion), else 2. No default: the caller derives it from the manifest. */
  version: 2 | 3;
}

const checkpointFields = (p: CheckpointSigningParts) => [
  p.streamId,
  p.checkpointId,
  p.parentCheckpointId ?? '-',
  p.replicaId,
  p.deviceId,
  p.coversSeq,
  p.manifestHash,
  p.replicasHash,
  p.blobSha256,
  p.sizeBytes,
];

/**
 * The bytes the authoring device signs (Ed25519) for a checkpoint: `cleo-nexus/checkpoint/v2`, or `/v3`
 * for a v3 manifest. `parentCheckpointId` is `-` for a genesis checkpoint. A client verifies this before
 * restoring, so an older checkpoint cannot be served under a newer id, a record's fields cannot be
 * edited, and the replica map that seeds the pull cursor is the author's.
 */
export function checkpointSigningMessage(parts: CheckpointSigningParts): Uint8Array {
  return lines(`cleo-nexus/checkpoint/v${parts.version}`, ...checkpointFields(parts));
}

/**
 * The bytes another device signs to endorse (re-sign) a checkpoint: the same fields, under their own
 * domain and the endorser's id, so an endorsement is never mistaken for an authorship.
 */
export function checkpointEndorsementMessage(
  endorserDeviceId: string,
  parts: CheckpointSigningParts,
): Uint8Array {
  return lines(
    'cleo-nexus/checkpoint-endorsement/v1',
    endorserDeviceId,
    ...checkpointFields(parts),
  );
}

/**
 * The bytes a certified device signs to revoke one signing key of a device and pin its history.
 */
export function deviceRevocationMessage(parts: {
  userId: string;
  revokedDeviceId: string;
  /** Hex of the raw 32-byte Ed25519 public key being revoked. */
  revokedSigningPublicKeyHex: string;
  /** sha256 hex of revocationPinsCanonical(pins). */
  pinsHash: string;
  signerDeviceId: string;
}): Uint8Array {
  return lines(
    'cleo-nexus/device-revocation/v1',
    parts.userId,
    parts.revokedDeviceId,
    parts.revokedSigningPublicKeyHex,
    parts.pinsHash,
    parts.signerDeviceId,
  );
}

/**
 * The bytes a device signs (Ed25519) to retire a replica of a stream (cleo-nexus T123, contract v2.28): the replica
 * writes no segment past `lastReplicaSeq`, or none at all when it is null (it wrote nothing). `successor`,
 * `lastReplicaSeq` and `txnId` (the journal `retire` transaction, absent for an owner's retirement) are `-` when null.
 * It names the signer, so a retirement cannot be re-attributed.
 */
export function replicaRetireMessage(parts: {
  streamId: string;
  replicaId: string;
  successor: string | null;
  lastReplicaSeq: number | null;
  signerDeviceId: string;
  txnId: string | null;
}): Uint8Array {
  return lines(
    'cleo-nexus/replica-retire/v1',
    parts.streamId,
    parts.replicaId,
    parts.successor ?? '-',
    parts.lastReplicaSeq === null ? '-' : String(parts.lastReplicaSeq),
    parts.signerDeviceId,
    parts.txnId ?? '-',
  );
}

/**
 * The bytes a device certificate MACs: HMAC-SHA256 keyed by HKDF(masterKey, "device-cert"). It binds a
 * device's public keys to the user and a master key version. Only a master key holder can make one.
 */
export function deviceCertificateMessage(parts: {
  userId: string;
  deviceId: string;
  /** Hex of the raw 32-byte X25519 public key. */
  encryptionPublicKeyHex: string;
  /** Hex of the raw 32-byte Ed25519 public key. */
  signingPublicKeyHex: string;
  keyVersion: number;
}): Uint8Array {
  return lines(
    'cleo-nexus/device-cert/v1',
    parts.userId,
    parts.deviceId,
    parts.encryptionPublicKeyHex,
    parts.signingPublicKeyHex,
    parts.keyVersion,
  );
}

/**
 * The bytes the granting device signs (Ed25519) for a device key grant. It covers the recipient and
 * its keys, the key version, the sealed box (by hash) and the recipient's certificate, and names the
 * signer, so the grant can be neither redirected nor re-attributed.
 */
export function deviceGrantMessage(parts: {
  userId: string;
  recipientDeviceId: string;
  recipientEncryptionPublicKeyHex: string;
  recipientSigningPublicKeyHex: string;
  keyVersion: number;
  /** sha256 hex of the raw sealed-box bytes. */
  sealedMasterKeyHash: string;
  /** Hex of the raw certificate bytes. */
  certificateHex: string;
  signerDeviceId: string;
}): Uint8Array {
  return lines(
    'cleo-nexus/device-grant/v1',
    parts.userId,
    parts.recipientDeviceId,
    parts.recipientEncryptionPublicKeyHex,
    parts.recipientSigningPublicKeyHex,
    parts.keyVersion,
    parts.sealedMasterKeyHash,
    parts.certificateHex,
    parts.signerDeviceId,
  );
}

/**
 * The bytes a device signs (Ed25519, with its signing key) to enrol through E1
 * (cleo-nexus device contract §2.4, §4.1): the proof of possession of the
 * signing private key. It binds the user, the device, both public keys and the
 * profile, so a proof cannot be moved to another account, device or profile.
 * Mirrors cleo-nexus `packages/shared/src/signing.ts`.
 *
 * @param parts - The enrolment fields; public keys as lowercase hex of the raw 32 bytes.
 * @returns `cleo-nexus/device-enroll/v1\nuserId\ndeviceId\nencHex\nsigHex\nprofile` as UTF-8.
 * @task T12868
 */
export function deviceEnrollmentMessage(parts: {
  userId: string;
  deviceId: string;
  /** Hex of the raw 32-byte X25519 public key. */
  encryptionPublicKeyHex: string;
  /** Hex of the raw 32-byte Ed25519 public key. */
  signingPublicKeyHex: string;
  profile: 'device' | 'read-only';
}): Uint8Array {
  return lines(
    'cleo-nexus/device-enroll/v1',
    parts.userId,
    parts.deviceId,
    parts.encryptionPublicKeyHex,
    parts.signingPublicKeyHex,
    parts.profile,
  );
}
