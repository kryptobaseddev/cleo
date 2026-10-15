import {
  type AppendSegmentRequest,
  AppendSegmentResult,
  BlobDownload,
  type Checkpoint,
  CheckpointId,
  CompleteUploadResult,
  CreateCheckpointResult,
  DeleteStreamAttachmentResult,
  GetStreamAttachmentResult,
  ListCheckpointsResult,
  MAX_INLINE_SEGMENT_BYTES,
  MAX_PULL_LIMIT,
  type Manifest,
  PresignUploadResult,
  PullSegmentsResult,
  PutStreamAttachmentResult,
  type ReplicaHeads,
  type RevocationPins,
  type Segment,
} from '@cleocode/contracts/cloud';
import {
  DecryptError,
  deriveKey,
  hmacSha256,
  type KeyPair,
  open,
  SEAL_OVERHEAD,
  seal,
  sha256Hex,
  signEd25519,
  uuidv7,
  verifyEd25519,
} from './crypto.js';
import {
  type ClientErrorCode,
  type FetchLike,
  type Http,
  isSecureUrl,
  NexusError,
} from './http.js';
import { liveKeys, type SignerKey, signerKeys, type TrustedSigners } from './keys.js';
import { manifestVersion } from './manifest-check.js';
import {
  type CheckpointSigningParts,
  checkpointEndorsementMessage,
  checkpointSigningMessage,
  manifestCanonical,
  replicasCanonical,
  type SegmentMetaFields,
  segmentMetaCanonical,
  segmentSigningMessage,
  segmentSigningVersion,
} from './signing.js';

export type Uploader = (
  url: string,
  headers: Record<string, string>,
  bytes: Buffer,
) => Promise<void>;
/** Download `url`, refusing (and no longer reading) once more than `maxBytes` arrive. */
export type Downloader = (url: string, maxBytes: number) => Promise<Buffer>;

/**
 * Why the client refused what the server sent. Every refusal carries one in `details.reason`, so the
 * caller (and the tests) can tell the checks apart. None of them is retryable as is.
 */
export type RefusalReason =
  | 'unknown-signer'
  | 'bad-signature'
  | 'hash-mismatch'
  | 'blob-hash'
  | 'blob-size'
  | 'decrypt'
  | 'payload'
  | 'seq-order'
  | 'replica-device'
  | 'replica-replay'
  | 'replica-gap'
  | 'page'
  | 'checkpoint-stream'
  | 'checkpoint-rollback'
  | 'checkpoint-replicas'
  | 'revoked-signer'
  | 'too-large';

const refuse = (code: ClientErrorCode, reason: RefusalReason, message: string) =>
  new NexusError(code, message, 0, null, { reason });

/**
 * Whether `err` is this client refusing what the server sent (status 0, a {@link RefusalReason}), as
 * opposed to a server or network error.
 *
 * @param err - Anything thrown.
 * @returns True for a client refusal.
 */
export const isClientRefusal = (err: unknown): err is NexusError =>
  err instanceof NexusError && err.status === 0 && typeof err.details?.reason === 'string';

/** An attachment's ciphertext size is its plaintext size plus this ({@link SEAL_OVERHEAD}). */
export const AEAD_OVERHEAD = SEAL_OVERHEAD;

/**
 * Whether a refusal proves the recorded content wrong, not just its delivery: the ciphertext matched
 * its announced sha256 and still failed the AEAD or the plaintext sha256. A size or hash mismatch of the
 * download (a flaky proxy, a lying server) or a client cap proves nothing about the record.
 *
 * @param err - Anything thrown.
 * @returns True for `decrypt` and `hash-mismatch` refusals.
 */
export const provesContentWrong = (err: unknown): boolean =>
  isClientRefusal(err) &&
  (err.details?.reason === 'decrypt' || err.details?.reason === 'hash-mismatch');

function uploaderFor(fetchImpl: FetchLike): Uploader {
  return async (url, headers, bytes) => {
    if (!isSecureUrl(url)) throw refuse('E_PROTOCOL', 'payload', 'upload URL must be https');
    const res = await fetchImpl(url, { method: 'PUT', headers, body: bytes, redirect: 'error' });
    if (!res.ok)
      throw new NexusError(
        'E_BLOB_INTEGRITY',
        `upload refused: HTTP ${res.status}`,
        res.status,
        null,
      );
  };
}

/** The default downloader: https only, no redirects, and it stops reading past `maxBytes`. */
export function cappedDownloader(fetchImpl: FetchLike): Downloader {
  return async (url, maxBytes) => {
    if (!isSecureUrl(url)) throw refuse('E_PROTOCOL', 'payload', 'download URL must be https');
    const abort = new AbortController();
    const res = await fetchImpl(url, { redirect: 'error', signal: abort.signal });
    if (!res.ok)
      throw new NexusError(
        'E_BLOB_MISSING',
        `download failed: HTTP ${res.status}`,
        res.status,
        null,
      );
    const tooLarge = () => {
      abort.abort();
      return refuse(
        'E_PAYLOAD_TOO_LARGE',
        'too-large',
        `download exceeds the expected ${maxBytes} bytes`,
      );
    };
    const declared = Number(res.headers.get('content-length') ?? Number.NaN);
    if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
    if (!res.body) return Buffer.alloc(0);
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  };
}

export type SegmentMeta = SegmentMetaFields;

export interface PulledSegment {
  seq: number;
  replicaId: string;
  replicaSeq: number;
  deviceId: string;
  plaintext: Buffer;
  meta: SegmentMeta;
}

/**
 * Where a replica's pull stands. The caller persists it in the same local transaction that applies the
 * pulled ops, and passes it back to the next pull. It is what lets the client refuse replayed,
 * reordered, re-attributed and gapped segments across pages and restarts.
 */
export interface PullCursor {
  /** The last stream seq applied. The next pull asks for segments strictly after it. */
  after: number;
  /**
   * True when `replicas` lists every replica with a segment at or below `after`: the cursor started at
   * genesis, or was seeded from a checkpoint's signed replica map (cursorFromCheckpoint). A replica first
   * seen later must then start at replicaSeq 0. False only for a cursor built some other way.
   */
  knowsAllReplicas: boolean;
  /** Per replica: the device that signs its segments (pinned at first sight) and the last replicaSeq applied. */
  replicas: Record<string, { deviceId: string; replicaSeq: number }>;
}

export const initialPullCursor = (): PullCursor => ({
  after: 0,
  knowsAllReplicas: true,
  replicas: {},
});

/** A cursor that resumes right after a (verified) checkpoint, seeded from its signed replica map. */
export function cursorFromCheckpoint(cp: Pick<Checkpoint, 'coversSeq' | 'replicas'>): PullCursor {
  const replicas: PullCursor['replicas'] = {};
  for (const [id, h] of Object.entries(cp.replicas)) {
    replicas[id] = { deviceId: h.deviceId, replicaSeq: h.lastReplicaSeq };
  }
  return { after: cp.coversSeq, knowsAllReplicas: true, replicas };
}

/**
 * The pins for revoking `deviceId`'s key: the last replicaSeq of each of its replicas in the given
 * cursors, and the highest coversSeq of its checkpoints in the given (already verified) lists. Compute
 * them from pulls this client verified itself, with the key trusted as pending (certifiedSigners with
 * includePending), before signing the revocation.
 */
export function revocationPins(
  deviceId: string,
  streams: readonly { streamId: string; cursor: PullCursor; checkpoints?: readonly Checkpoint[] }[],
): RevocationPins {
  const pins: RevocationPins = { replicas: {}, checkpoints: {} };
  for (const st of streams) {
    for (const [id, r] of Object.entries(st.cursor.replicas)) {
      if (r.deviceId === deviceId)
        pins.replicas[id] = Math.max(pins.replicas[id] ?? 0, r.replicaSeq);
    }
    for (const cp of st.checkpoints ?? []) {
      if (cp.deviceId === deviceId && cp.streamId === st.streamId) {
        pins.checkpoints[st.streamId] = Math.max(pins.checkpoints[st.streamId] ?? 0, cp.coversSeq);
      }
    }
  }
  return pins;
}

export interface JournalOptions {
  http: Http;
  streamId: string;
  replicaId: string;
  deviceId: string;
  signing: KeyPair;
  /** The stream data key: a project data key (PDK) or the home stream key (HSK). */
  key: Buffer;
  uploader?: Uploader;
  downloader?: Downloader;
  /** Used by the default uploader and downloader. Defaults to the global fetch. */
  fetch?: FetchLike;
  /** The largest segment blob a pull will download. Default 256 MiB. */
  maxSegmentBlobBytes?: number;
}

const DEFAULT_MAX_SEGMENT_BLOB_BYTES = 256 * 1024 * 1024;

const utf8 = (s: string) => Buffer.from(s, 'utf8');

/** sha256 of the canonical segment metadata. Covered by the segment signature and the ciphertext AAD. */
export const segmentMetaHash = (m: SegmentMetaFields) => sha256Hex(utf8(segmentMetaCanonical(m)));
/** sha256 of the canonical manifest. Covered by the checkpoint signature. */
export const manifestHash = (m: Manifest) => sha256Hex(utf8(manifestCanonical(m)));

/** sha256 of the canonical replica map. Covered by the checkpoint signature. */
export const replicasHash = (r: ReplicaHeads) => sha256Hex(utf8(replicasCanonical(r)));

const checkpointParts = (
  cp: Omit<Checkpoint, 'endorsements' | 'createdAt' | 'signature'>,
): CheckpointSigningParts => ({
  streamId: cp.streamId,
  checkpointId: cp.checkpointId,
  parentCheckpointId: cp.parentCheckpointId,
  replicaId: cp.replicaId,
  deviceId: cp.deviceId,
  coversSeq: cp.coversSeq,
  manifestHash: manifestHash(cp.manifest),
  replicasHash: replicasHash(cp.replicas),
  blobSha256: cp.blobSha256,
  sizeBytes: cp.sizeBytes,
  version: manifestVersion(cp.manifest),
});

// The AAD contexts stay `segment/v2` and `checkpoint/v2` for v3 segments and manifests: the meta hash
// already covers `txnDeltas`, and the signature carries the version (cleo-nexus e2e-keys.md).
const segmentContext = (
  streamId: string,
  replicaId: string,
  replicaSeq: number,
  metaHash: string,
) => `segment/v2\n${streamId}\n${replicaId}\n${replicaSeq}\n${metaHash}`;
const checkpointContext = (streamId: string, checkpointId: string, coversSeq: number) =>
  `checkpoint/v2\n${streamId}\n${checkpointId}\n${coversSeq}`;
const attachmentContext = (streamId: string, sha256: string) =>
  `attachment/v1\n${streamId}\n${sha256}`;

const metaOf = (s: SegmentMetaFields): SegmentMeta => ({
  opCount: s.opCount,
  hlcMin: s.hlcMin,
  hlcMax: s.hlcMax,
  deltas: s.deltas,
  schemaVersion: s.schemaVersion,
  // segment/v3 only; a v2 segment (null, or absent from an older server) carries none.
  ...(s.txnDeltas !== undefined && s.txnDeltas !== null ? { txnDeltas: s.txnDeltas } : {}),
});

/**
 * One replica's view of one journal stream. The caller owns durable state (`nextReplicaSeq`, the
 * PullCursor and the highest checkpoint coversSeq seen) and must persist it in the same local
 * transaction that records what was sent or applied.
 */
export class Journal {
  private readonly up: Uploader;
  private readonly down: Downloader;
  private readonly base: string;
  private readonly maxSegmentBlobBytes: number;

  constructor(private readonly o: JournalOptions) {
    const f = o.fetch ?? ((i, init) => globalThis.fetch(i, init));
    this.up = o.uploader ?? uploaderFor(f);
    this.down = o.downloader ?? cappedDownloader(f);
    this.base = `/v1/streams/${encodeURIComponent(o.streamId)}`;
    this.maxSegmentBlobBytes = o.maxSegmentBlobBytes ?? DEFAULT_MAX_SEGMENT_BLOB_BYTES;
  }

  /**
   * Encrypt, sign and append one segment of ops: segment/v2, or segment/v3 when `meta` carries
   * `txnDeltas` (journal spec §2.11). Safe to retry with the same replicaSeq, metadata and `sealed`
   * bytes (from sealSegment): re-encrypting would change the hash and defeat idempotency.
   */
  async push(
    replicaSeq: number,
    plaintext: Uint8Array,
    meta: SegmentMeta,
    sealed?: Buffer,
  ): Promise<AppendSegmentResult> {
    const { streamId, replicaId, deviceId } = this.o;
    const metaHash = segmentMetaHash(meta);
    const ciphertext = sealed ?? this.sealSegment(replicaSeq, plaintext, meta);
    const segmentHash = sha256Hex(ciphertext);
    const signature = signEd25519(
      this.o.signing,
      segmentSigningMessage({
        streamId,
        replicaId,
        deviceId,
        replicaSeq,
        segmentHash,
        metaHash,
        version: segmentSigningVersion(meta),
      }),
    ).toString('base64');
    const { txnDeltas, ...v2Meta } = metaOf(meta);
    const body: AppendSegmentRequest = {
      replicaId,
      deviceId,
      segmentHash,
      replicaSeq,
      signature,
      ...v2Meta,
      ...(txnDeltas ? { txnDeltas: [...txnDeltas] } : {}),
      ...(ciphertext.length > MAX_INLINE_SEGMENT_BYTES
        ? { blobSha256: await this.uploadBlob(ciphertext, 'segment') }
        : { ciphertext: ciphertext.toString('base64') }),
    };
    return this.o.http.request('POST', `${this.base}/segments`, AppendSegmentResult, body);
  }

  /**
   * Encrypt a segment without sending it, so the caller can persist the exact bytes before pushing.
   * The AAD covers the metadata hash, so the same `meta` must be passed to push.
   */
  sealSegment(replicaSeq: number, plaintext: Uint8Array, meta: SegmentMeta): Buffer {
    return seal(
      this.o.key,
      plaintext,
      'segment',
      segmentContext(this.o.streamId, this.o.replicaId, replicaSeq, segmentMetaHash(meta)),
    );
  }

  /**
   * Pull, verify and decrypt the segments after `cursor.after`. Nothing unverified is ever returned for
   * applying: the pull stops with a NexusError (see RefusalReason) when a segment
   * - is not strictly after the previous one (replayed or reordered: `seq-order`);
   * - is signed by a device outside `trustedSigners` (`unknown-signer`), or its signature fails over the
   *   stream, replica, device, position, ciphertext hash and metadata hash (`bad-signature`);
   * - belongs to a replica pinned to another device (`replica-device`), repeats a replicaSeq
   *   (`replica-replay`) or skips one (`replica-gap`);
   * - is signed by a revoked key past its revocation pin (`revoked-signer`);
   * - has bytes that do not match its hash (`hash-mismatch`, `blob-hash`, `blob-size`) or fail to decrypt.
   * Returns the next cursor; persist it with the applied ops, together with the TrustState returned by the
   * certifiedSigners call that built `trustedSigners`, in the same local transaction. Nothing in core does
   * this yet; the caller must.
   */
  async pull(cursor: PullCursor, trustedSigners: TrustedSigners, limit = 200) {
    if (!Number.isSafeInteger(cursor.after) || cursor.after < 0)
      throw refuse('E_VALIDATION', 'page', 'cursor.after must be a non-negative integer');
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PULL_LIMIT)
      throw refuse('E_VALIDATION', 'page', `limit must be between 1 and ${MAX_PULL_LIMIT}`);
    const page = await this.o.http.request(
      'GET',
      `${this.base}/segments?after=${cursor.after}&limit=${limit}`,
      PullSegmentsResult,
    );
    if (page.streamId !== this.o.streamId)
      throw refuse('E_PROTOCOL', 'page', 'pull answered for another stream');
    if (page.segments.length > limit)
      throw refuse('E_PROTOCOL', 'page', 'pull returned more than the limit');

    const replicas: PullCursor['replicas'] = {};
    for (const [id, r] of Object.entries(cursor.replicas)) replicas[id] = { ...r };
    let last = cursor.after;
    const out: PulledSegment[] = [];
    for (const s of page.segments) {
      if (s.seq <= last) {
        throw refuse(
          'E_PROTOCOL',
          'seq-order',
          `segment ${s.seq} is not after ${last}: replayed or reordered`,
        );
      }
      const pin = replicas[s.replicaId];
      if (pin && pin.deviceId !== s.deviceId) {
        throw refuse(
          'E_PROTOCOL',
          'replica-device',
          `segment ${s.seq}: replica ${s.replicaId} belongs to device ${pin.deviceId}, not ${s.deviceId}`,
        );
      }
      const expected = pin ? pin.replicaSeq + 1 : cursor.knowsAllReplicas ? 0 : s.replicaSeq;
      if (s.replicaSeq !== expected) {
        const replay = pin !== undefined && s.replicaSeq <= pin.replicaSeq;
        throw refuse(
          'E_PROTOCOL',
          replay ? 'replica-replay' : 'replica-gap',
          `segment ${s.seq}: replica ${s.replicaId} sent replicaSeq ${s.replicaSeq}, expected ${expected}`,
        );
      }
      out.push(await this.verifyAndOpen(s, trustedSigners));
      replicas[s.replicaId] = { deviceId: s.deviceId, replicaSeq: s.replicaSeq };
      last = s.seq;
    }
    if (page.nextAfter !== last)
      throw refuse('E_PROTOCOL', 'page', 'nextAfter does not match the last segment');
    if (page.head < last)
      throw refuse('E_PROTOCOL', 'page', 'head is behind the segments returned');
    const next: PullCursor = { after: last, knowsAllReplicas: cursor.knowsAllReplicas, replicas };
    return { segments: out, head: page.head, cursor: next };
  }

  private async verifyAndOpen(s: Segment, trusted: TrustedSigners): Promise<PulledSegment> {
    const keys = signerKeys(trusted, s.deviceId);
    if (keys.length === 0) {
      throw refuse(
        'E_FORBIDDEN',
        'unknown-signer',
        `segment ${s.seq} is signed by an unknown device ${s.deviceId}`,
      );
    }
    const metaHash = segmentMetaHash(s);
    const msg = segmentSigningMessage({
      streamId: this.o.streamId,
      replicaId: s.replicaId,
      deviceId: s.deviceId,
      replicaSeq: s.replicaSeq,
      segmentHash: s.segmentHash,
      metaHash,
      version: segmentSigningVersion(s),
    });
    const signature = Buffer.from(s.signature, 'base64');
    const signer = keys.find((k) => verifyEd25519(k.publicKey, msg, signature));
    if (!signer) {
      throw refuse('E_FORBIDDEN', 'bad-signature', `segment ${s.seq} has an invalid signature`);
    }
    const pinned = signer.pin?.replicas[s.replicaId];
    if (signer.pin && (pinned === undefined || s.replicaSeq > pinned)) {
      throw refuse(
        'E_FORBIDDEN',
        'revoked-signer',
        `segment ${s.seq} was signed by a revoked key past its pin (replica ${s.replicaId}, replicaSeq ${s.replicaSeq})`,
      );
    }
    if ((s.ciphertext === null) === (s.blobSha256 === null)) {
      throw refuse(
        'E_PROTOCOL',
        'payload',
        `segment ${s.seq} must carry exactly one of ciphertext or blob`,
      );
    }
    const ciphertext =
      s.ciphertext !== null
        ? Buffer.from(s.ciphertext, 'base64')
        : await this.downloadSegmentBlob(s);
    if (sha256Hex(ciphertext) !== s.segmentHash) {
      throw refuse(
        'E_BLOB_INTEGRITY',
        'hash-mismatch',
        `segment ${s.seq} ciphertext does not match its hash`,
      );
    }
    const plaintext = this.decrypt(
      ciphertext,
      'segment',
      segmentContext(this.o.streamId, s.replicaId, s.replicaSeq, metaHash),
      `segment ${s.seq}`,
    );
    return {
      seq: s.seq,
      replicaId: s.replicaId,
      replicaSeq: s.replicaSeq,
      deviceId: s.deviceId,
      plaintext,
      meta: metaOf(s),
    };
  }

  private decrypt(ciphertext: Buffer, purpose: string, context: string, what: string): Buffer {
    try {
      return open(this.o.key, ciphertext, purpose, context);
    } catch (err) {
      if (err instanceof DecryptError)
        throw refuse('E_BLOB_INTEGRITY', 'decrypt', `${what} does not decrypt`);
      throw err;
    }
  }

  /**
   * Encrypt, upload and sign a checkpoint bundle, then register it. The client mints the checkpoint id,
   * because the signature and the bundle's AAD both cover it. `cursor` is this replica's pull cursor at
   * the point the bundle captures: it gives coversSeq and the signed replica map, so it must know every
   * replica. The signature is checkpoint/v2, or checkpoint/v3 for a manifest with the §2.11 accounting
   * fields ({@link manifestVersion}). The server verifies the signature and the replica map, and refuses
   * lineage breaks and regressions. A retry of the same checkpoint returns it again.
   */
  async pushCheckpoint(args: {
    bundle: Uint8Array;
    manifest: Manifest;
    cursor: PullCursor;
    parentCheckpointId: string | null;
    /**
     * The id to register it under, minted by the caller so it can be recorded
     * before the upload (a genesis push adopts its own stored checkpoint after
     * a crash by this id, T13302). A fresh uuidv7 when absent.
     */
    checkpointId?: string;
  }): Promise<Checkpoint> {
    const { streamId, replicaId, deviceId } = this.o;
    if (!args.cursor.knowsAllReplicas)
      throw refuse(
        'E_VALIDATION',
        'checkpoint-replicas',
        'a checkpoint needs a cursor that knows every replica',
      );
    const replicas: ReplicaHeads = {};
    for (const [id, r] of Object.entries(args.cursor.replicas)) {
      replicas[id] = { deviceId: r.deviceId, lastReplicaSeq: r.replicaSeq };
    }
    const coversSeq = args.cursor.after;
    const checkpointId = args.checkpointId ?? uuidv7();
    const ciphertext = seal(
      this.o.key,
      args.bundle,
      'checkpoint',
      checkpointContext(streamId, checkpointId, coversSeq),
    );
    const blobSha256 = await this.uploadBlob(ciphertext, 'checkpoint');
    const record = {
      checkpointId,
      streamId,
      parentCheckpointId: args.parentCheckpointId,
      replicaId,
      deviceId,
      coversSeq,
      manifest: args.manifest,
      replicas,
      blobSha256,
      sizeBytes: ciphertext.length,
    };
    const signature = signEd25519(
      this.o.signing,
      checkpointSigningMessage(checkpointParts(record)),
    ).toString('base64');
    const { streamId: _stream, ...body } = record;
    const res = await this.o.http.request(
      'POST',
      `${this.base}/checkpoints`,
      CreateCheckpointResult,
      {
        ...body,
        signature,
      },
    );
    if (res.checkpoint.checkpointId !== checkpointId || res.checkpoint.signature !== signature) {
      throw refuse('E_PROTOCOL', 'payload', 'the server recorded a different checkpoint');
    }
    return res.checkpoint;
  }

  /**
   * Check a checkpoint record: it belongs to this stream, and a trusted key signed every field that
   * matters (ids, lineage, coversSeq, manifest, replica map, bundle hash and size), under the domain its
   * manifest's format picks (checkpoint/v2 or /v3, so v3 fields can be neither dropped nor added after
   * signing). Accepted signers:
   * - the author, with a live key, or with a revoked key whose pin for this stream covers coversSeq;
   * - otherwise, any live device that endorsed (re-signed) it.
   */
  verifyCheckpoint(cp: Checkpoint, trustedSigners: TrustedSigners): void {
    if (cp.streamId !== this.o.streamId) {
      throw refuse(
        'E_PROTOCOL',
        'checkpoint-stream',
        `checkpoint ${cp.checkpointId} belongs to another stream`,
      );
    }
    const parts = checkpointParts(cp);
    const endorsed = cp.endorsements.some((e) => {
      const msg = checkpointEndorsementMessage(e.deviceId, parts);
      const sig = Buffer.from(e.signature, 'base64');
      return liveKeys(trustedSigners, e.deviceId).some((k) => verifyEd25519(k.publicKey, msg, sig));
    });
    const keys = signerKeys(trustedSigners, cp.deviceId);
    const msg = checkpointSigningMessage(parts);
    const sig = Buffer.from(cp.signature, 'base64');
    const author: SignerKey | undefined = keys.find((k) => verifyEd25519(k.publicKey, msg, sig));
    const pinned = author?.pin?.checkpoints[cp.streamId];
    const authorOk =
      author !== undefined &&
      (author.pin === null || (pinned !== undefined && cp.coversSeq <= pinned));
    if (authorOk || endorsed) return;
    if (keys.length === 0) {
      throw refuse(
        'E_FORBIDDEN',
        'unknown-signer',
        `checkpoint ${cp.checkpointId} is signed by an unknown device ${cp.deviceId}`,
      );
    }
    if (!author) {
      throw refuse(
        'E_FORBIDDEN',
        'bad-signature',
        `checkpoint ${cp.checkpointId} has an invalid signature`,
      );
    }
    throw refuse(
      'E_FORBIDDEN',
      'revoked-signer',
      `checkpoint ${cp.checkpointId} was signed by a revoked key past its pin, and no live device endorsed it`,
    );
  }

  /**
   * Re-sign (endorse) a checkpoint with this device's key, after checking it against `trustedSigners`,
   * for example so that a checkpoint written by a device about to be revoked stays restorable without its pin.
   */
  async endorseCheckpoint(cp: Checkpoint, trustedSigners: TrustedSigners): Promise<Checkpoint> {
    this.verifyCheckpoint(cp, trustedSigners);
    const signature = signEd25519(
      this.o.signing,
      checkpointEndorsementMessage(this.o.deviceId, checkpointParts(cp)),
    ).toString('base64');
    const res = await this.o.http.request(
      'POST',
      `${this.base}/checkpoints/${cp.checkpointId}/endorsements`,
      CreateCheckpointResult,
      { deviceId: this.o.deviceId, signature },
    );
    return res.checkpoint;
  }

  /**
   * Download, verify and decrypt a checkpoint bundle (point-in-time restore). `minCoversSeq` is the
   * highest checkpoint coversSeq this replica has already seen (the caller persists it): an older
   * checkpoint is refused, so the server cannot roll the replica back. The returned cursor resumes the
   * pull after the checkpoint, seeded from its signed replica map.
   */
  async restoreCheckpoint(
    checkpointId: string,
    trustedSigners: TrustedSigners,
    opts: { minCoversSeq?: number } = {},
  ): Promise<{ bundle: Buffer; checkpoint: Checkpoint; cursor: PullCursor }> {
    if (!CheckpointId.safeParse(checkpointId).success)
      throw refuse('E_VALIDATION', 'payload', 'not a checkpoint id');
    const list = await this.o.http.request(
      'GET',
      `${this.base}/checkpoints`,
      ListCheckpointsResult,
    );
    const cp = list.checkpoints.find((c) => c.checkpointId === checkpointId);
    if (!cp) throw new NexusError('E_NOT_FOUND', 'checkpoint not found', 404, null);
    this.verifyCheckpoint(cp, trustedSigners);
    if (cp.coversSeq < (opts.minCoversSeq ?? 0)) {
      throw refuse(
        'E_PROTOCOL',
        'checkpoint-rollback',
        `checkpoint ${cp.checkpointId} covers seq ${cp.coversSeq}, older than ${opts.minCoversSeq} already seen`,
      );
    }
    const dl = await this.o.http.request(
      'GET',
      `${this.base}/checkpoints/${cp.checkpointId}/download`,
      BlobDownload,
    );
    if (dl.sha256 !== cp.blobSha256 || dl.sizeBytes !== cp.sizeBytes) {
      throw refuse('E_BLOB_INTEGRITY', 'blob-hash', 'checkpoint download names a different bundle');
    }
    const ciphertext = await this.down(dl.url, cp.sizeBytes);
    if (ciphertext.length !== cp.sizeBytes) {
      throw refuse('E_BLOB_INTEGRITY', 'blob-size', 'checkpoint bundle does not match its size');
    }
    if (sha256Hex(ciphertext) !== cp.blobSha256) {
      throw refuse('E_BLOB_INTEGRITY', 'blob-hash', 'checkpoint bundle does not match its hash');
    }
    const bundle = this.decrypt(
      ciphertext,
      'checkpoint',
      checkpointContext(this.o.streamId, cp.checkpointId, cp.coversSeq),
      `checkpoint ${cp.checkpointId}`,
    );
    return { bundle, checkpoint: cp, cursor: cursorFromCheckpoint(cp) };
  }

  private async uploadBlob(
    bytes: Buffer,
    purpose: 'segment' | 'checkpoint' | 'attachment',
  ): Promise<string> {
    const sha256 = sha256Hex(bytes);
    const pre = await this.o.http.request('POST', '/v1/blobs/presign', PresignUploadResult, {
      sha256,
      sizeBytes: bytes.length,
      purpose,
    });
    if (!pre.alreadyPresent) {
      if (!pre.uploadUrl || !pre.uploadHeaders)
        throw new NexusError('E_INTERNAL', 'presign returned no URL', 0, null);
      await this.up(pre.uploadUrl, pre.uploadHeaders, bytes);
      const done = await this.o.http.request(
        'POST',
        `/v1/blobs/${sha256}/complete`,
        CompleteUploadResult,
      );
      if (done.sha256 !== sha256)
        throw refuse('E_PROTOCOL', 'payload', 'upload completed for another blob');
    }
    return sha256;
  }

  /**
   * Download a segment stored as a blob. The blob may have been uploaded by another member, so it is
   * fetched through the stream (`GET …/segments/:seq/blob`), not the caller's own blob scope. At most the
   * announced size is read, and the bytes must match that size and the segment's sha256.
   */
  async downloadSegmentBlob(s: Pick<Segment, 'seq' | 'blobSha256'>): Promise<Buffer> {
    if (!Number.isSafeInteger(s.seq) || s.seq < 1)
      throw refuse('E_VALIDATION', 'payload', 'invalid segment seq');
    if (!s.blobSha256)
      throw refuse('E_VALIDATION', 'payload', `segment ${s.seq} is inline, not a blob`);
    const r = await this.o.http.request('GET', `${this.base}/segments/${s.seq}/blob`, BlobDownload);
    if (r.sha256 !== s.blobSha256) {
      throw refuse(
        'E_BLOB_INTEGRITY',
        'blob-hash',
        `segment ${s.seq} blob download names a different sha256`,
      );
    }
    if (r.sizeBytes > this.maxSegmentBlobBytes) {
      throw refuse(
        'E_PAYLOAD_TOO_LARGE',
        'too-large',
        `segment ${s.seq} blob exceeds the client limit`,
      );
    }
    const bytes = await this.down(r.url, r.sizeBytes);
    if (bytes.length !== r.sizeBytes) {
      throw refuse(
        'E_BLOB_INTEGRITY',
        'blob-size',
        `segment ${s.seq} blob does not match its size`,
      );
    }
    if (sha256Hex(bytes) !== s.blobSha256) {
      throw refuse(
        'E_BLOB_INTEGRITY',
        'blob-hash',
        `segment ${s.seq} blob does not match its sha256`,
      );
    }
    return bytes;
  }

  /** The stream path of an attachment's ref: an HMAC of its plaintext sha256, so the server learns nothing. */
  private attachmentPath(sha256: string): string {
    const ref = hmacSha256(deriveKey(this.o.key, 'attachment-ref'), utf8(sha256)).toString('hex');
    return `${this.base}/attachments/${ref}`;
  }

  /**
   * Put a content-addressed attachment (a doc body) on the stream (T13721): encrypted under the stream
   * key, bound to the stream and its plaintext sha256, uploaded as an `attachment` blob and recorded
   * under its ref (E32). A ref already recorded is checked like a pull would check it: a good one is not
   * uploaded again; a junk one (a squat, a buggy client) is cleared (E34) and replaced with these bytes.
   *
   * @param sha256 - The plaintext sha256 the synced row names.
   * @param plaintext - The bytes; they must hash to `sha256`.
   * @returns `sent` when this call recorded it, `present` when the stream already had a good copy,
   *   `contested` when the ref holds another blob this caller may not clear, or a racer recorded first,
   *   and `unverified` when the recorded blob could not be checked (a size or hash fault of its
   *   download): nothing is cleared, and the next push checks it again.
   */
  async pushAttachment(
    sha256: string,
    plaintext: Buffer,
  ): Promise<'sent' | 'present' | 'contested' | 'unverified'> {
    if (sha256Hex(plaintext) !== sha256)
      throw refuse('E_VALIDATION', 'payload', `attachment ${sha256} does not match its bytes`);
    const path = this.attachmentPath(sha256);
    const { download: d } = await this.o.http.request('GET', path, GetStreamAttachmentResult);
    if (d !== null) {
      // A record of another size cannot hold these bytes; one of the right size is downloaded and
      // cleared only when its content is provably wrong. A delivery fault proves nothing: unverified.
      if (d.sizeBytes === plaintext.length + AEAD_OVERHEAD) {
        try {
          await this.readAttachment(sha256, d, d.sizeBytes);
          return 'present';
        } catch (err) {
          if (isClientRefusal(err) && !provesContentWrong(err)) return 'unverified';
          if (!provesContentWrong(err)) throw err;
        }
      }
      try {
        await this.clearAttachment(sha256);
      } catch (err) {
        if (err instanceof NexusError && err.status === 403) return 'contested';
        throw err;
      }
    }
    const ciphertext = seal(
      this.o.key,
      plaintext,
      'attachment',
      attachmentContext(this.o.streamId, sha256),
    );
    const blobSha256 = await this.uploadBlob(ciphertext, 'attachment');
    const put = await this.o.http.request('PUT', path, PutStreamAttachmentResult, {
      blobSha256,
      sizeBytes: ciphertext.length,
    });
    // First writer wins (E32): a racer's blob is not ours; the next push checks it like any other.
    return put.created || put.blobSha256 === blobSha256 ? 'sent' : 'contested';
  }

  /**
   * Read a content-addressed attachment from the stream (T13721), uploaded by any member (E33). The
   * ciphertext must match the announced size and sha256, decrypt under the stream key in this stream
   * and sha256's context, and hash to `sha256`; anything else is refused before a byte is returned.
   *
   * @param sha256 - The plaintext sha256 the synced row names.
   * @param maxBytes - The largest ciphertext to download.
   * @returns The verified plaintext, or null when no member has put it on the stream yet.
   */
  async pullAttachment(sha256: string, maxBytes: number): Promise<Buffer | null> {
    const { download: d } = await this.o.http.request(
      'GET',
      this.attachmentPath(sha256),
      GetStreamAttachmentResult,
    );
    return d === null ? null : this.readAttachment(sha256, d, maxBytes);
  }

  /**
   * Whether some member has recorded a blob for an attachment (E33), without downloading it.
   *
   * @param sha256 - The plaintext sha256 the synced row names.
   * @returns True when a record exists.
   */
  async attachmentRecorded(sha256: string): Promise<boolean> {
    const { download } = await this.o.http.request(
      'GET',
      this.attachmentPath(sha256),
      GetStreamAttachmentResult,
    );
    return download !== null;
  }

  /**
   * Clear an attachment's record (E34), so a holder of the real bytes can record them again. Allowed
   * for the member who recorded it and for a project owner; the server refuses anyone else.
   *
   * @param sha256 - The plaintext sha256 the synced row names.
   * @returns True when this call removed a record.
   */
  async clearAttachment(sha256: string): Promise<boolean> {
    const r = await this.o.http.request(
      'DELETE',
      this.attachmentPath(sha256),
      DeleteStreamAttachmentResult,
    );
    return r.deleted;
  }

  /** Download and verify the blob behind an attachment ref; any mismatch is a client refusal. */
  private async readAttachment(sha256: string, d: BlobDownload, maxBytes: number): Promise<Buffer> {
    if (d.sizeBytes > maxBytes)
      throw refuse('E_PAYLOAD_TOO_LARGE', 'too-large', `attachment ${sha256} exceeds the limit`);
    const ciphertext = await this.down(d.url, d.sizeBytes);
    if (ciphertext.length !== d.sizeBytes)
      throw refuse('E_BLOB_INTEGRITY', 'blob-size', `attachment ${sha256} does not match its size`);
    if (sha256Hex(ciphertext) !== d.sha256)
      throw refuse('E_BLOB_INTEGRITY', 'blob-hash', `attachment ${sha256} does not match its hash`);
    const plaintext = this.decrypt(
      ciphertext,
      'attachment',
      attachmentContext(this.o.streamId, sha256),
      `attachment ${sha256}`,
    );
    if (sha256Hex(plaintext) !== sha256)
      throw refuse('E_BLOB_INTEGRITY', 'hash-mismatch', `attachment ${sha256} has other content`);
    return plaintext;
  }
}
