import {
  type AppendSegmentRequest,
  type AppendSegmentResult,
  type Checkpoint,
  MAX_INLINE_SEGMENT_BYTES,
  type Manifest,
  type PresignUploadResult,
  type PullSegmentsResult,
  type Segment,
  type TableDeltas,
} from '@cleocode/contracts/cloud';
import { type KeyPair, open, seal, sha256Hex, signEd25519, verifyEd25519 } from './crypto.js';
import { type FetchLike, type Http, NexusError } from './http.js';
import { segmentSigningMessage } from './signing.js';

export type Uploader = (
  url: string,
  headers: Record<string, string>,
  bytes: Buffer,
) => Promise<void>;
export type Downloader = (url: string) => Promise<Buffer>;

const defaultUploader: Uploader = async (url, headers, bytes) => {
  const res = await fetch(url, { method: 'PUT', headers, body: bytes });
  if (!res.ok)
    throw new NexusError(
      'E_BLOB_INTEGRITY',
      `upload refused: HTTP ${res.status}`,
      res.status,
      null,
    );
};
const defaultDownloader: Downloader = async (url) => {
  const res = await fetch(url);
  if (!res.ok)
    throw new NexusError('E_BLOB_MISSING', `download failed: HTTP ${res.status}`, res.status, null);
  return Buffer.from(await res.arrayBuffer());
};

/** Response of `GET /v1/streams/:streamId/segments/:seq/blob`: a short-lived presigned download URL. */
export interface SegmentBlobDownload {
  url: string;
  sha256: string;
  sizeBytes: number;
  expiresInSeconds: number;
}

export interface SegmentMeta {
  opCount: number;
  hlcMin: string;
  hlcMax: string;
  deltas: TableDeltas;
  schemaVersion: number;
}

export interface PulledSegment {
  seq: number;
  replicaId: string;
  replicaSeq: number;
  deviceId: string;
  plaintext: Buffer;
  meta: SegmentMeta;
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
  fetch?: FetchLike;
}

const segmentContext = (streamId: string, replicaId: string, replicaSeq: number) =>
  `segment\n${streamId}\n${replicaId}\n${replicaSeq}`;
const checkpointContext = (streamId: string, coversSeq: number) =>
  `checkpoint\n${streamId}\n${coversSeq}`;

/**
 * One replica's view of one journal stream. The caller owns durable state (`nextReplicaSeq` and the
 * pull cursor) and must persist both in the same local transaction that records what was sent or applied.
 */
export class Journal {
  private readonly up: Uploader;
  private readonly down: Downloader;
  private readonly base: string;

  constructor(private readonly o: JournalOptions) {
    this.up = o.uploader ?? defaultUploader;
    this.down = o.downloader ?? defaultDownloader;
    this.base = `/v1/streams/${encodeURIComponent(o.streamId)}`;
  }

  /** Encrypt, sign and append one segment of ops. Safe to retry with the same replicaSeq and plaintext. */
  async push(
    replicaSeq: number,
    plaintext: Uint8Array,
    meta: SegmentMeta,
    sealed?: Buffer,
  ): Promise<AppendSegmentResult> {
    const { streamId, replicaId, deviceId } = this.o;
    // Reuse the ciphertext on retries: re-encrypting would change the hash and defeat idempotency.
    const ciphertext =
      sealed ??
      seal(this.o.key, plaintext, 'segment', segmentContext(streamId, replicaId, replicaSeq));
    const segmentHash = sha256Hex(ciphertext);
    const signature = signEd25519(
      this.o.signing,
      segmentSigningMessage({ streamId, replicaId, replicaSeq, segmentHash }),
    ).toString('base64');
    const body: AppendSegmentRequest = {
      replicaId,
      deviceId,
      segmentHash,
      replicaSeq,
      signature,
      ...meta,
      ...(ciphertext.length > MAX_INLINE_SEGMENT_BYTES
        ? { blobSha256: await this.uploadBlob(ciphertext, 'segment') }
        : { ciphertext: ciphertext.toString('base64') }),
    };
    return this.o.http.request<AppendSegmentResult>('POST', `${this.base}/segments`, body);
  }

  /** Encrypt a segment without sending it, so the caller can persist the exact bytes before pushing. */
  sealSegment(replicaSeq: number, plaintext: Uint8Array): Buffer {
    return seal(
      this.o.key,
      plaintext,
      'segment',
      segmentContext(this.o.streamId, this.o.replicaId, replicaSeq),
    );
  }

  /**
   * Pull, verify and decrypt segments after `after`. A segment whose signer is not in
   * `trustedSigners`, whose signature fails, or whose ciphertext fails to decrypt stops the pull
   * with an error. Nothing unverified is ever returned for applying.
   */
  async pull(after: number, trustedSigners: ReadonlyMap<string, Buffer>, limit = 200) {
    const page = await this.o.http.request<PullSegmentsResult>(
      'GET',
      `${this.base}/segments?after=${after}&limit=${limit}`,
    );
    const out: PulledSegment[] = [];
    for (const s of page.segments) out.push(await this.verifyAndOpen(s, trustedSigners));
    return { segments: out, head: page.head, nextAfter: page.nextAfter };
  }

  private async verifyAndOpen(
    s: Segment,
    trusted: ReadonlyMap<string, Buffer>,
  ): Promise<PulledSegment> {
    const signer = trusted.get(s.deviceId);
    if (!signer)
      throw new NexusError(
        'E_FORBIDDEN',
        `segment ${s.seq} is signed by an unknown device ${s.deviceId}`,
        0,
        null,
      );
    const msg = segmentSigningMessage({
      streamId: this.o.streamId,
      replicaId: s.replicaId,
      replicaSeq: s.replicaSeq,
      segmentHash: s.segmentHash,
    });
    if (!verifyEd25519(signer, msg, Buffer.from(s.signature, 'base64'))) {
      throw new NexusError('E_FORBIDDEN', `segment ${s.seq} has an invalid signature`, 0, null);
    }
    const ciphertext = s.ciphertext
      ? Buffer.from(s.ciphertext, 'base64')
      : await this.downloadSegmentBlob(s);
    if (sha256Hex(ciphertext) !== s.segmentHash) {
      throw new NexusError(
        'E_BLOB_INTEGRITY',
        `segment ${s.seq} ciphertext does not match its hash`,
        0,
        null,
      );
    }
    const plaintext = open(
      this.o.key,
      ciphertext,
      'segment',
      segmentContext(this.o.streamId, s.replicaId, s.replicaSeq),
    );
    return {
      seq: s.seq,
      replicaId: s.replicaId,
      replicaSeq: s.replicaSeq,
      deviceId: s.deviceId,
      plaintext,
      meta: {
        opCount: s.opCount,
        hlcMin: s.hlcMin,
        hlcMax: s.hlcMax,
        deltas: s.deltas,
        schemaVersion: s.schemaVersion,
      },
    };
  }

  /** Encrypt and upload a checkpoint bundle, then register it. The server refuses lineage breaks and regressions. */
  async pushCheckpoint(args: {
    bundle: Uint8Array;
    manifest: Manifest;
    coversSeq: number;
    parentCheckpointId: string | null;
  }): Promise<Checkpoint> {
    const ciphertext = seal(
      this.o.key,
      args.bundle,
      'checkpoint',
      checkpointContext(this.o.streamId, args.coversSeq),
    );
    const sha = await this.uploadBlob(ciphertext, 'checkpoint');
    const res = await this.o.http.request<{ checkpoint: Checkpoint }>(
      'POST',
      `${this.base}/checkpoints`,
      {
        replicaId: this.o.replicaId,
        parentCheckpointId: args.parentCheckpointId,
        coversSeq: args.coversSeq,
        manifest: args.manifest,
        blobSha256: sha,
        sizeBytes: ciphertext.length,
      },
    );
    return res.checkpoint;
  }

  /** Download and decrypt a checkpoint bundle (point-in-time restore). */
  async restoreCheckpoint(
    checkpointId: string,
  ): Promise<{ bundle: Buffer; checkpoint: Checkpoint }> {
    const list = await this.o.http.request<{ checkpoints: Checkpoint[] }>(
      'GET',
      `${this.base}/checkpoints`,
    );
    const cp = list.checkpoints.find((c) => c.checkpointId === checkpointId);
    if (!cp) throw new NexusError('E_NOT_FOUND', 'checkpoint not found', 404, null);
    const dl = await this.o.http.request<{ url: string }>(
      'GET',
      `${this.base}/checkpoints/${checkpointId}/download`,
    );
    const ciphertext = await this.down(dl.url);
    if (sha256Hex(ciphertext) !== cp.blobSha256) {
      throw new NexusError(
        'E_BLOB_INTEGRITY',
        'checkpoint bundle does not match its hash',
        0,
        null,
      );
    }
    return {
      bundle: open(
        this.o.key,
        ciphertext,
        'checkpoint',
        checkpointContext(this.o.streamId, cp.coversSeq),
      ),
      checkpoint: cp,
    };
  }

  private async uploadBlob(
    bytes: Buffer,
    purpose: 'segment' | 'checkpoint' | 'attachment',
  ): Promise<string> {
    const sha256 = sha256Hex(bytes);
    const pre = await this.o.http.request<PresignUploadResult>('POST', '/v1/blobs/presign', {
      sha256,
      sizeBytes: bytes.length,
      purpose,
    });
    if (!pre.alreadyPresent) {
      if (!pre.uploadUrl || !pre.uploadHeaders)
        throw new NexusError('E_INTERNAL', 'presign returned no URL', 0, null);
      await this.up(pre.uploadUrl, pre.uploadHeaders, bytes);
      await this.o.http.request('POST', `/v1/blobs/${sha256}/complete`);
    }
    return sha256;
  }

  /**
   * Download a segment stored as a blob. The blob may have been uploaded by another member, so it is
   * fetched through the stream (`GET …/segments/:seq/blob`), not the caller's own blob scope. The
   * bytes are checked against the segment's sha256 before anything uses them.
   */
  async downloadSegmentBlob(s: Pick<Segment, 'seq' | 'blobSha256'>): Promise<Buffer> {
    if (!s.blobSha256)
      throw new NexusError('E_VALIDATION', `segment ${s.seq} is inline, not a blob`, 0, null);
    const r = await this.o.http.request<SegmentBlobDownload>(
      'GET',
      `${this.base}/segments/${s.seq}/blob`,
    );
    if (r.sha256 !== s.blobSha256) {
      throw new NexusError(
        'E_BLOB_INTEGRITY',
        `segment ${s.seq} blob download names a different sha256`,
        0,
        null,
      );
    }
    const bytes = await this.down(r.url);
    if (bytes.length !== r.sizeBytes || sha256Hex(bytes) !== s.blobSha256) {
      throw new NexusError(
        'E_BLOB_INTEGRITY',
        `segment ${s.seq} blob does not match its sha256`,
        0,
        null,
      );
    }
    return bytes;
  }
}
