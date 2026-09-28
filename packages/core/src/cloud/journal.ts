import {
  type AppendSegmentRequest,
  AppendSegmentResult,
  BlobDownload,
  type Checkpoint,
  CheckpointId,
  CompleteUploadResult,
  CreateCheckpointResult,
  ListCheckpointsResult,
  MAX_INLINE_SEGMENT_BYTES,
  MAX_PULL_LIMIT,
  type Manifest,
  PresignUploadResult,
  PullSegmentsResult,
  type Segment,
} from '@cleocode/contracts/cloud';
import {
  DecryptError,
  type KeyPair,
  open,
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
import {
  checkpointSigningMessage,
  manifestCanonical,
  type SegmentMetaFields,
  segmentMetaCanonical,
  segmentSigningMessage,
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
  | 'too-large';

const refuse = (code: ClientErrorCode, reason: RefusalReason, message: string) =>
  new NexusError(code, message, 0, null, { reason });

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
   * True when this cursor has seen every segment since seq 1. A replica's first segment must then have
   * replicaSeq 0. A cursor seeded from a checkpoint is false: a replica first seen after it may start higher.
   */
  sinceGenesis: boolean;
  /** Per replica: the device that signs its segments (pinned at first sight) and the last replicaSeq applied. */
  replicas: Record<string, { deviceId: string; replicaSeq: number }>;
}

export const initialPullCursor = (): PullCursor => ({ after: 0, sinceGenesis: true, replicas: {} });

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

const segmentContext = (
  streamId: string,
  replicaId: string,
  replicaSeq: number,
  metaHash: string,
) => `segment/v2\n${streamId}\n${replicaId}\n${replicaSeq}\n${metaHash}`;
const checkpointContext = (streamId: string, checkpointId: string, coversSeq: number) =>
  `checkpoint/v2\n${streamId}\n${checkpointId}\n${coversSeq}`;

const metaOf = (s: SegmentMetaFields): SegmentMeta => ({
  opCount: s.opCount,
  hlcMin: s.hlcMin,
  hlcMax: s.hlcMax,
  deltas: s.deltas,
  schemaVersion: s.schemaVersion,
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
   * Encrypt, sign and append one segment of ops. Safe to retry with the same replicaSeq, metadata and
   * `sealed` bytes (from sealSegment): re-encrypting would change the hash and defeat idempotency.
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
      segmentSigningMessage({ streamId, replicaId, deviceId, replicaSeq, segmentHash, metaHash }),
    ).toString('base64');
    const body: AppendSegmentRequest = {
      replicaId,
      deviceId,
      segmentHash,
      replicaSeq,
      signature,
      ...metaOf(meta),
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
   * - has bytes that do not match its hash (`hash-mismatch`, `blob-hash`, `blob-size`) or fail to decrypt.
   * Returns the next cursor; persist it with the applied ops.
   */
  async pull(cursor: PullCursor, trustedSigners: ReadonlyMap<string, Uint8Array>, limit = 200) {
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
      const expected = pin ? pin.replicaSeq + 1 : cursor.sinceGenesis ? 0 : s.replicaSeq;
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
    const next: PullCursor = { after: last, sinceGenesis: cursor.sinceGenesis, replicas };
    return { segments: out, head: page.head, cursor: next };
  }

  private async verifyAndOpen(
    s: Segment,
    trusted: ReadonlyMap<string, Uint8Array>,
  ): Promise<PulledSegment> {
    const signer = trusted.get(s.deviceId);
    if (!signer) {
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
    });
    if (!verifyEd25519(signer, msg, Buffer.from(s.signature, 'base64'))) {
      throw refuse('E_FORBIDDEN', 'bad-signature', `segment ${s.seq} has an invalid signature`);
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
   * because the signature and the bundle's AAD both cover it. The server verifies the signature and
   * refuses lineage breaks and regressions.
   */
  async pushCheckpoint(args: {
    bundle: Uint8Array;
    manifest: Manifest;
    coversSeq: number;
    parentCheckpointId: string | null;
  }): Promise<Checkpoint> {
    const { streamId, replicaId, deviceId } = this.o;
    const checkpointId = uuidv7();
    const ciphertext = seal(
      this.o.key,
      args.bundle,
      'checkpoint',
      checkpointContext(streamId, checkpointId, args.coversSeq),
    );
    const blobSha256 = await this.uploadBlob(ciphertext, 'checkpoint');
    const fields = {
      checkpointId,
      parentCheckpointId: args.parentCheckpointId,
      replicaId,
      deviceId,
      coversSeq: args.coversSeq,
      blobSha256,
      sizeBytes: ciphertext.length,
    };
    const signature = signEd25519(
      this.o.signing,
      checkpointSigningMessage({ ...fields, streamId, manifestHash: manifestHash(args.manifest) }),
    ).toString('base64');
    const res = await this.o.http.request(
      'POST',
      `${this.base}/checkpoints`,
      CreateCheckpointResult,
      {
        ...fields,
        manifest: args.manifest,
        signature,
      },
    );
    if (res.checkpoint.checkpointId !== checkpointId || res.checkpoint.signature !== signature) {
      throw refuse('E_PROTOCOL', 'payload', 'the server recorded a different checkpoint');
    }
    return res.checkpoint;
  }

  /**
   * Check a checkpoint record: it belongs to this stream and its signature verifies under a trusted
   * device over every field that matters (ids, lineage, coversSeq, manifest, bundle hash and size).
   */
  verifyCheckpoint(cp: Checkpoint, trustedSigners: ReadonlyMap<string, Uint8Array>): void {
    if (cp.streamId !== this.o.streamId) {
      throw refuse(
        'E_PROTOCOL',
        'checkpoint-stream',
        `checkpoint ${cp.checkpointId} belongs to another stream`,
      );
    }
    const signer = trustedSigners.get(cp.deviceId);
    if (!signer) {
      throw refuse(
        'E_FORBIDDEN',
        'unknown-signer',
        `checkpoint ${cp.checkpointId} is signed by an unknown device ${cp.deviceId}`,
      );
    }
    const msg = checkpointSigningMessage({ ...cp, manifestHash: manifestHash(cp.manifest) });
    if (!verifyEd25519(signer, msg, Buffer.from(cp.signature, 'base64'))) {
      throw refuse(
        'E_FORBIDDEN',
        'bad-signature',
        `checkpoint ${cp.checkpointId} has an invalid signature`,
      );
    }
  }

  /**
   * Download, verify and decrypt a checkpoint bundle (point-in-time restore). `minCoversSeq` is the
   * highest checkpoint coversSeq this replica has already seen (the caller persists it): an older
   * checkpoint is refused, so the server cannot roll the replica back.
   */
  async restoreCheckpoint(
    checkpointId: string,
    trustedSigners: ReadonlyMap<string, Uint8Array>,
    opts: { minCoversSeq?: number } = {},
  ): Promise<{ bundle: Buffer; checkpoint: Checkpoint }> {
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
    return { bundle, checkpoint: cp };
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
}
