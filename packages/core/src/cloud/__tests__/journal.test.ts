import type { Segment } from '@cleocode/contracts/cloud';
import { describe, expect, it } from 'vitest';
import { generateEd25519, randomKey, sha256Hex, signEd25519 } from '../crypto.js';
import { Http } from '../http.js';
import { Journal } from '../journal.js';
import { registerProject } from '../projects.js';
import { segmentSigningMessage } from '../signing.js';

const streamId = 'project:0192f1c2-7d3e-7abc-8def-0123456789ab';
const replicaId = '0192f1c2-7d3e-7abc-8def-0123456789ac';
const deviceId = '0192f1c2-7d3e-4abc-8def-0123456789ad';
const hlc = `1790545492500-000001-${replicaId}`;

type Route = (path: string, init?: RequestInit) => unknown;

/** An Http whose fetch answers from `route` and records every call. */
function fakeHttp(route: Route) {
  const calls: { path: string; init?: RequestInit }[] = [];
  const http = new Http({
    baseUrl: 'https://nexus.test',
    token: 't',
    maxAttempts: 1,
    fetch: async (input, init) => {
      const path = input.replace('https://nexus.test', '');
      calls.push({ path, init });
      const data = route(path, init);
      return new Response(JSON.stringify({ success: true, data, meta: { requestId: 'r' } }));
    },
  });
  return { http, calls };
}

/** A blob segment as another member's device would have pushed it, signed by that device. */
function blobSegment() {
  const key = randomKey();
  const signing = generateEd25519();
  const writer = new Journal({
    http: fakeHttp(() => null).http,
    streamId,
    replicaId,
    deviceId,
    signing,
    key,
  });
  const plaintext = Buffer.from('tasks_tasks T123 status=done');
  const ciphertext = writer.sealSegment(7, plaintext);
  const segmentHash = sha256Hex(ciphertext);
  const signature = signEd25519(
    signing,
    segmentSigningMessage({ streamId, replicaId, replicaSeq: 7, segmentHash }),
  ).toString('base64');
  const segment: Segment = {
    seq: 3,
    replicaId,
    deviceId,
    replicaSeq: 7,
    segmentHash,
    schemaVersion: 1,
    opCount: 1,
    hlcMin: hlc,
    hlcMax: hlc,
    deltas: {},
    signature,
    ciphertext: null,
    blobSha256: segmentHash,
    receivedAt: '2026-09-28T00:00:00.000Z',
  };
  return { key, signing, plaintext, ciphertext, segment };
}

function reader(b: ReturnType<typeof blobSegment>, blob: Buffer, sha256 = b.segment.segmentHash) {
  const { http, calls } = fakeHttp((path) => {
    if (path.includes('/segments?'))
      return { streamId, segments: [b.segment], head: 3, nextAfter: 3 };
    if (path.endsWith('/segments/3/blob'))
      return {
        url: 'https://r2.test/presigned',
        sha256,
        sizeBytes: blob.length,
        expiresInSeconds: 300,
      };
    throw new Error(`unexpected ${path}`);
  });
  const downloads: string[] = [];
  const journal = new Journal({
    http,
    streamId,
    replicaId,
    deviceId,
    signing: generateEd25519(),
    key: b.key,
    downloader: async (url) => {
      downloads.push(url);
      return blob;
    },
  });
  return { journal, calls, downloads, trusted: new Map([[deviceId, b.signing.publicKey]]) };
}

describe('segment blob download', () => {
  it('fetches another member’s blob through the stream endpoint and decrypts it', async () => {
    const b = blobSegment();
    const r = reader(b, b.ciphertext);
    const page = await r.journal.pull(0, r.trusted);
    expect(page.segments[0]?.plaintext.equals(b.plaintext)).toBe(true);
    expect(r.calls.map((c) => c.path)).toContain(
      `/v1/streams/${encodeURIComponent(streamId)}/segments/3/blob`,
    );
    expect(r.calls.some((c) => c.path.startsWith('/v1/blobs/'))).toBe(false);
    expect(r.downloads).toEqual(['https://r2.test/presigned']);
  });

  it('refuses bytes that do not match the segment sha256', async () => {
    const b = blobSegment();
    const tampered = Buffer.from(b.ciphertext);
    tampered[tampered.length - 1] ^= 1;
    const r = reader(b, tampered);
    await expect(r.journal.pull(0, r.trusted)).rejects.toMatchObject({ code: 'E_BLOB_INTEGRITY' });
  });

  it('refuses a download that names a different sha256, before downloading', async () => {
    const b = blobSegment();
    const r = reader(b, b.ciphertext, 'f'.repeat(64));
    await expect(r.journal.pull(0, r.trusted)).rejects.toMatchObject({ code: 'E_BLOB_INTEGRITY' });
    expect(r.downloads).toEqual([]);
  });

  it('refuses an inline segment', async () => {
    const b = blobSegment();
    const r = reader(b, b.ciphertext);
    await expect(r.journal.downloadSegmentBlob({ seq: 3, blobSha256: null })).rejects.toMatchObject(
      {
        code: 'E_VALIDATION',
      },
    );
  });
});

describe('registerProject', () => {
  it('sends organizationId when the caller names an organization', async () => {
    const organizationId = '0192f1c2-7d3e-7abc-8def-0123456789ae';
    const project = {
      projectId: '0192f1c2-7d3e-7abc-8def-0123456789ab',
      label: null,
      encryptedName: null,
      remoteUrl: null,
      organizationId,
      createdByUserId: '0192f1c2-7d3e-7abc-8def-0123456789af',
      createdAt: '2026-09-28T00:00:00.000Z',
    };
    const { http, calls } = fakeHttp(() => ({ project, streamId }));
    const res = await registerProject(http, { projectId: project.projectId, organizationId });
    expect(calls[0]?.path).toBe('/v1/projects');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      projectId: project.projectId,
      organizationId,
    });
    expect(res.project.organizationId).toBe(organizationId);
  });
});
