import type {
  AppendSegmentRequest,
  Checkpoint,
  CreateCheckpointRequest,
  Segment,
} from '@cleocode/contracts/cloud';
import { describe, expect, it } from 'vitest';
import {
  generateEd25519,
  type KeyPair,
  randomKey,
  seal,
  sha256Hex,
  signEd25519,
} from '../crypto.js';
import { Http, MAX_RETRY_AFTER_MS, retryDelay } from '../http.js';
import {
  cappedDownloader,
  type Downloader,
  initialPullCursor,
  Journal,
  type PullCursor,
  type SegmentMeta,
} from '../journal.js';
import { registerProject } from '../projects.js';

const streamId = 'project:0192f1c2-7d3e-7abc-8def-0123456789ab';
const replicaA = '0192f1c2-7d3e-7abc-8def-0000000000a1';
const replicaB = '0192f1c2-7d3e-7abc-8def-0000000000b1';
const deviceA = '0192f1c2-7d3e-4abc-8def-0000000000a0';
const deviceB = '0192f1c2-7d3e-4abc-8def-0000000000b0';
const hlc = (n: number, r: string) => `${String(1790545492500 + n).padStart(13, '0')}-000000-${r}`;
const meta = (
  n: number,
  r: string,
  deltas = { tasks_tasks: { created: 1, deleted: 0 } },
): SegmentMeta => ({
  opCount: 1,
  hlcMin: hlc(n, r),
  hlcMax: hlc(n, r),
  deltas,
  schemaVersion: 1,
});

type Route = (path: string, init?: RequestInit) => unknown;

/** An Http whose fetch answers from `route` (a thrown error becomes a 404 envelope). */
function fakeHttp(route: Route) {
  const calls: string[] = [];
  const http = new Http({
    baseUrl: 'https://nexus.test',
    token: 't',
    maxAttempts: 1,
    fetch: async (input, init) => {
      const path = input.replace('https://nexus.test', '');
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      try {
        const data = route(path, init);
        return new Response(JSON.stringify({ success: true, data, meta: { requestId: 'r' } }));
      } catch (err) {
        return new Response(
          JSON.stringify({
            success: false,
            error: { code: 'E_NOT_FOUND', message: String(err), requestId: 'r' },
          }),
          { status: 404 },
        );
      }
    },
  });
  return { http, calls };
}

/**
 * A fake Nexus: writers push through a real Journal into it, readers pull from it. Tests then tamper
 * with `segments`, `blobs`, `checkpoints` or `page` the way a malicious server would.
 */
function nexus() {
  const key = randomKey();
  const devices = { [deviceA]: generateEd25519(), [deviceB]: generateEd25519() } as Record<
    string,
    KeyPair
  >;
  const trusted = new Map(Object.entries(devices).map(([id, kp]) => [id, kp.publicKey]));
  const s = {
    key,
    devices,
    trusted,
    segments: [] as Segment[],
    blobs: new Map<string, Buffer>(),
    checkpoints: [] as Checkpoint[],
    /** When set, returned verbatim for the next pull. */
    page: undefined as unknown,
    /** Override the announced blob download. */
    blobAnnounce: undefined as
      | undefined
      | ((sha: string, size: number) => { sha256: string; sizeBytes: number }),
  };
  const route: Route = (path, init) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method === 'POST' && path === '/v1/blobs/presign')
      return {
        alreadyPresent: false,
        uploadUrl: `https://blob.test/${body.sha256}`,
        uploadHeaders: {},
        expiresAt: null,
      };
    const complete = /^\/v1\/blobs\/([0-9a-f]{64})\/complete$/.exec(path);
    if (method === 'POST' && complete) return { sha256: complete[1], verified: true };
    if (method === 'POST' && path.endsWith('/segments')) {
      const b = body as AppendSegmentRequest;
      const seq = s.segments.length + 1;
      s.segments.push({
        seq,
        replicaId: b.replicaId,
        deviceId: b.deviceId,
        replicaSeq: b.replicaSeq,
        segmentHash: b.segmentHash,
        schemaVersion: b.schemaVersion,
        opCount: b.opCount,
        hlcMin: b.hlcMin,
        hlcMax: b.hlcMax,
        deltas: b.deltas,
        signature: b.signature,
        ciphertext: b.ciphertext ?? null,
        blobSha256: b.blobSha256 ?? null,
        receivedAt: new Date().toISOString(),
      });
      return { streamId, seq, duplicate: false };
    }
    const pull = /\/segments\?after=(\d+)&limit=(\d+)$/.exec(path);
    if (pull) {
      if (s.page !== undefined) {
        const p = s.page;
        s.page = undefined;
        return p;
      }
      const after = Number(pull[1]);
      const rows = s.segments.filter((x) => x.seq > after).slice(0, Number(pull[2]));
      return {
        streamId,
        segments: rows,
        head: s.segments.length,
        nextAfter: rows.at(-1)?.seq ?? after,
      };
    }
    const blob = /\/segments\/(\d+)\/blob$/.exec(path);
    if (blob) {
      const seg = s.segments.find((x) => x.seq === Number(blob[1]));
      const sha = seg?.blobSha256 ?? '';
      const bytes = s.blobs.get(sha);
      if (!bytes) throw new Error('no blob');
      const a = s.blobAnnounce?.(sha, bytes.length) ?? { sha256: sha, sizeBytes: bytes.length };
      return { url: `https://blob.test/${sha}`, ...a, expiresInSeconds: 300 };
    }
    if (method === 'POST' && path.endsWith('/checkpoints')) {
      const b = body as CreateCheckpointRequest;
      const cp = { ...b, streamId, createdAt: new Date().toISOString() };
      s.checkpoints.unshift(cp);
      return { checkpoint: cp };
    }
    if (path.endsWith('/checkpoints')) return { checkpoints: s.checkpoints };
    const dl = /\/checkpoints\/([0-9a-f-]+)\/download$/.exec(path);
    if (dl) {
      const cp = s.checkpoints.find((c) => c.checkpointId === dl[1]);
      if (!cp) throw new Error('no checkpoint');
      return {
        url: `https://blob.test/${cp.blobSha256}`,
        sha256: cp.blobSha256,
        sizeBytes: cp.sizeBytes,
        expiresInSeconds: 300,
      };
    }
    throw new Error(`unrouted ${method} ${path}`);
  };
  const { http, calls } = fakeHttp(route);
  const uploader = async (url: string, _h: Record<string, string>, bytes: Buffer) => {
    s.blobs.set(url.replace('https://blob.test/', ''), bytes);
  };
  const downloader: Downloader = async (url, maxBytes) => {
    const b = s.blobs.get(url.replace('https://blob.test/', ''));
    if (!b) throw new Error('missing');
    return b.length > maxBytes ? b.subarray(0, maxBytes + 1) : b;
  };
  const journal = (deviceId: string, replicaId: string) =>
    new Journal({
      http,
      streamId,
      replicaId,
      deviceId,
      signing: devices[deviceId] as KeyPair,
      key,
      uploader,
      downloader,
    });
  return {
    ...s,
    state: s,
    http,
    calls,
    journal,
    writerA: journal(deviceA, replicaA),
    reader: journal(deviceB, replicaB),
  };
}

const ops = (n: number) => Buffer.from(`ops-${n}`);

async function withSegments(n = 3) {
  const x = nexus();
  for (let i = 0; i < n; i++) await x.writerA.push(i, ops(i), meta(i, replicaA));
  return x;
}

const reason = (r: string) => ({ details: { reason: r } });

describe('pull: verification of every segment before it is returned', () => {
  it('returns verified plaintext and metadata, and a cursor that carries across pages', async () => {
    const x = await withSegments(3);
    const p1 = await x.reader.pull(initialPullCursor(), x.trusted, 2);
    expect(p1.segments.map((s) => s.plaintext.toString())).toEqual(['ops-0', 'ops-1']);
    expect(p1.cursor).toEqual({
      after: 2,
      sinceGenesis: true,
      replicas: { [replicaA]: { deviceId: deviceA, replicaSeq: 1 } },
    });
    const p2 = await x.reader.pull(p1.cursor, x.trusted, 2);
    expect(p2.segments.map((s) => s.seq)).toEqual([3]);
    expect(p2.segments[0]?.meta).toEqual(meta(2, replicaA));
    expect(p2.head).toBe(3);
  });

  it('refuses a segment signed by a device outside the trusted set', async () => {
    const x = await withSegments(1);
    const trusted = new Map([[deviceB, x.trusted.get(deviceB) as Buffer]]);
    await expect(x.reader.pull(initialPullCursor(), trusted)).rejects.toMatchObject({
      code: 'E_FORBIDDEN',
      ...reason('unknown-signer'),
    });
  });

  it('refuses a segment whose signature does not verify', async () => {
    const x = await withSegments(1);
    const seg = x.segments[0] as Segment;
    // The server re-signs the segment with a key of its own.
    seg.signature = signEd25519(generateEd25519(), Buffer.from('anything')).toString('base64');
    await expect(x.reader.pull(initialPullCursor(), x.trusted)).rejects.toMatchObject(
      reason('bad-signature'),
    );
  });

  it.each([
    [
      'deltas',
      (s: Segment) => Object.assign(s, { deltas: { tasks_tasks: { created: 0, deleted: 1 } } }),
    ],
    ['opCount', (s: Segment) => Object.assign(s, { opCount: 7 })],
    ['hlcMax', (s: Segment) => Object.assign(s, { hlcMax: hlc(999, replicaA) })],
    ['schemaVersion', (s: Segment) => Object.assign(s, { schemaVersion: 2 })],
  ])('refuses forged metadata: %s (HIGH 2)', async (_f, forge) => {
    const x = await withSegments(1);
    forge(x.segments[0] as Segment);
    await expect(x.reader.pull(initialPullCursor(), x.trusted)).rejects.toMatchObject(
      reason('bad-signature'),
    );
  });

  it('refuses inline ciphertext that does not match the signed segmentHash', async () => {
    const x = await withSegments(1);
    // A different ciphertext that still decrypts: sealed by a key holder for the same position and metadata.
    const other = x.writerA.sealSegment(0, Buffer.from('injected ops'), meta(0, replicaA));
    (x.segments[0] as Segment).ciphertext = other.toString('base64');
    await expect(x.reader.pull(initialPullCursor(), x.trusted)).rejects.toMatchObject({
      code: 'E_BLOB_INTEGRITY',
      ...reason('hash-mismatch'),
    });
  });

  it('binds the ciphertext to its metadata through the AAD', async () => {
    const x = await withSegments(1);
    // A key holder seals under other metadata and signs it correctly: the AAD no longer matches.
    const seg = x.segments[0] as Segment;
    const wrong = seal(
      x.key,
      Buffer.from('x'),
      'segment',
      `segment/v2\n${streamId}\n${replicaA}\n0\n${'0'.repeat(64)}`,
    );
    seg.ciphertext = wrong.toString('base64');
    seg.segmentHash = sha256Hex(wrong);
    const { segmentSigningMessage, segmentMetaCanonical } = await import('../signing.js');
    seg.signature = signEd25519(
      x.devices[deviceA] as KeyPair,
      segmentSigningMessage({
        streamId,
        replicaId: replicaA,
        deviceId: deviceA,
        replicaSeq: 0,
        segmentHash: seg.segmentHash,
        metaHash: sha256Hex(Buffer.from(segmentMetaCanonical(seg))),
      }),
    ).toString('base64');
    await expect(x.reader.pull(initialPullCursor(), x.trusted)).rejects.toMatchObject(
      reason('decrypt'),
    );
  });

  it('refuses a malformed page (schema-validated before anything is used)', async () => {
    const x = await withSegments(1);
    x.state.page = {
      streamId,
      segments: [{ ...x.segments[0], seq: '1/../../v1/account/keys' }],
      head: 1,
      nextAfter: 1,
    };
    await expect(x.reader.pull(initialPullCursor(), x.trusted)).rejects.toMatchObject({
      code: 'E_PROTOCOL',
    });
  });
});

describe('pull: segment blobs', () => {
  async function blobStream() {
    const x = nexus();
    const big = Buffer.alloc(1_100_000, 3);
    await x.writerA.push(0, big, meta(0, replicaA));
    return { x, big, seg: x.segments[0] as Segment };
  }

  it('downloads another member’s blob through the stream endpoint and decrypts it', async () => {
    const { x, big, seg } = await blobStream();
    expect(seg.ciphertext).toBeNull();
    const p = await x.reader.pull(initialPullCursor(), x.trusted);
    expect(p.segments[0]?.plaintext.equals(big)).toBe(true);
    expect(x.calls).toContain(`GET /v1/streams/${encodeURIComponent(streamId)}/segments/1/blob`);
  });

  it('refuses blob bytes that do not match the sha256, even at the right size', async () => {
    const { x, seg } = await blobStream();
    const bytes = x.blobs.get(seg.blobSha256 as string) as Buffer;
    const swapped = Buffer.from(bytes);
    swapped[100] = (swapped[100] ?? 0) ^ 1;
    x.blobs.set(seg.blobSha256 as string, swapped);
    await expect(x.reader.pull(initialPullCursor(), x.trusted)).rejects.toMatchObject(
      reason('blob-hash'),
    );
  });

  it('refuses a blob whose size is not the announced size', async () => {
    const { x } = await blobStream();
    x.state.blobAnnounce = (sha, size) => ({ sha256: sha, sizeBytes: size + 1 });
    await expect(x.reader.pull(initialPullCursor(), x.trusted)).rejects.toMatchObject(
      reason('blob-size'),
    );
  });

  it('refuses a download that names a different sha256, before downloading', async () => {
    const { x } = await blobStream();
    x.state.blobAnnounce = (_sha, size) => ({ sha256: 'f'.repeat(64), sizeBytes: size });
    await expect(x.reader.pull(initialPullCursor(), x.trusted)).rejects.toMatchObject(
      reason('blob-hash'),
    );
  });

  it('refuses a blob larger than the client limit, before downloading', async () => {
    const { x } = await blobStream();
    const small = new Journal({
      http: x.http,
      streamId,
      replicaId: replicaB,
      deviceId: deviceB,
      signing: x.devices[deviceB] as KeyPair,
      key: x.key,
      maxSegmentBlobBytes: 1000,
      downloader: async () => {
        throw new Error('must not download');
      },
    });
    await expect(small.pull(initialPullCursor(), x.trusted)).rejects.toMatchObject(
      reason('too-large'),
    );
  });
});

describe('pull: replay, reordering and replica binding (MEDIUM 3)', () => {
  it('refuses a replayed segment (same replica position served again under a new seq)', async () => {
    const x = await withSegments(2);
    const first = x.segments[0] as Segment;
    x.state.page = { streamId, segments: [first, { ...first, seq: 2 }], head: 2, nextAfter: 2 };
    await expect(x.reader.pull(initialPullCursor(), x.trusted)).rejects.toMatchObject(
      reason('replica-replay'),
    );
  });

  it('refuses a replay across pages, using the persisted cursor', async () => {
    const x = await withSegments(2);
    const p1 = await x.reader.pull(initialPullCursor(), x.trusted);
    x.state.page = {
      streamId,
      segments: [{ ...(x.segments[1] as Segment), seq: 3 }],
      head: 3,
      nextAfter: 3,
    };
    await expect(x.reader.pull(p1.cursor, x.trusted)).rejects.toMatchObject(
      reason('replica-replay'),
    );
  });

  it('refuses reordered segments and segments at or before the cursor', async () => {
    const x = await withSegments(2);
    const [a, b] = x.segments as [Segment, Segment];
    // b is the valid next segment of the replica, but the server numbers it at or before a.
    x.state.page = { streamId, segments: [a, { ...b, seq: 1 }], head: 2, nextAfter: 1 };
    await expect(x.reader.pull(initialPullCursor(), x.trusted)).rejects.toMatchObject(
      reason('seq-order'),
    );
    const cursor: PullCursor = {
      after: 1,
      sinceGenesis: true,
      replicas: { [replicaA]: { deviceId: deviceA, replicaSeq: 0 } },
    };
    x.state.page = { streamId, segments: [a], head: 2, nextAfter: 1 };
    await expect(x.reader.pull(cursor, x.trusted)).rejects.toMatchObject(reason('seq-order'));
  });

  it('refuses a gap in a replica’s sequence (a withheld segment)', async () => {
    const x = await withSegments(3);
    const [a, , c] = x.segments as [Segment, Segment, Segment];
    x.state.page = { streamId, segments: [a, c], head: 3, nextAfter: 3 };
    await expect(x.reader.pull(initialPullCursor(), x.trusted)).rejects.toMatchObject(
      reason('replica-gap'),
    );
    // From genesis, a replica's first segment must be replicaSeq 0.
    x.state.page = { streamId, segments: [c], head: 3, nextAfter: 3 };
    await expect(x.reader.pull(initialPullCursor(), x.trusted)).rejects.toMatchObject(
      reason('replica-gap'),
    );
  });

  it('refuses a replica claimed by a second device', async () => {
    const x = await withSegments(1);
    // Device B (trusted) signs a segment that claims A's replica.
    const intruder = x.journal(deviceB, replicaA);
    await intruder.push(1, ops(9), meta(9, replicaA));
    await expect(x.reader.pull(initialPullCursor(), x.trusted)).rejects.toMatchObject(
      reason('replica-device'),
    );
  });

  it('refuses an inconsistent page: another stream, wrong nextAfter, head behind', async () => {
    const x = await withSegments(1);
    const seg = x.segments[0] as Segment;
    for (const page of [
      {
        streamId: 'project:0192f1c2-7d3e-7abc-8def-ffffffffffff',
        segments: [seg],
        head: 1,
        nextAfter: 1,
      },
      { streamId, segments: [seg], head: 1, nextAfter: 5 },
      { streamId, segments: [seg], head: 0, nextAfter: 1 },
    ]) {
      x.state.page = page;
      await expect(x.reader.pull(initialPullCursor(), x.trusted)).rejects.toMatchObject(
        reason('page'),
      );
    }
  });
});

describe('checkpoints: signed, AAD-bound, never rolled back (MEDIUM 4)', () => {
  const H = 'e'.repeat(64);
  const manifest = (rows: number) => ({
    schemaVersion: 1,
    tables: { tasks_tasks: { rows, hash: H } },
  });

  async function twoCheckpoints() {
    const x = await withSegments(2);
    const old = await x.writerA.pushCheckpoint({
      bundle: Buffer.from('old'),
      manifest: manifest(1),
      coversSeq: 1,
      parentCheckpointId: null,
    });
    const next = await x.writerA.pushCheckpoint({
      bundle: Buffer.from('new'),
      manifest: manifest(2),
      coversSeq: 2,
      parentCheckpointId: old.checkpointId,
    });
    return { x, old, next };
  }

  it('restores a checkpoint signed by a trusted device', async () => {
    const { x, next } = await twoCheckpoints();
    const r = await x.reader.restoreCheckpoint(next.checkpointId, x.trusted, { minCoversSeq: 2 });
    expect(r.bundle.toString()).toBe('new');
  });

  it('refuses a checkpoint older than one already seen', async () => {
    const { x, old } = await twoCheckpoints();
    await expect(
      x.reader.restoreCheckpoint(old.checkpointId, x.trusted, { minCoversSeq: 2 }),
    ).rejects.toMatchObject(reason('checkpoint-rollback'));
  });

  it('refuses an edited record: an old checkpoint dressed up with a newer coversSeq', async () => {
    const { x, old } = await twoCheckpoints();
    const rec = x.checkpoints.find((c) => c.checkpointId === old.checkpointId) as Checkpoint;
    rec.coversSeq = 2;
    await expect(
      x.reader.restoreCheckpoint(old.checkpointId, x.trusted, { minCoversSeq: 2 }),
    ).rejects.toMatchObject(reason('bad-signature'));
  });

  it('refuses an unknown signer and a record from another stream', async () => {
    const { x, next } = await twoCheckpoints();
    await expect(x.reader.restoreCheckpoint(next.checkpointId, new Map())).rejects.toMatchObject(
      reason('unknown-signer'),
    );
    const rec = x.checkpoints.find((c) => c.checkpointId === next.checkpointId) as Checkpoint;
    rec.streamId = 'project:0192f1c2-7d3e-7abc-8def-ffffffffffff';
    await expect(x.reader.restoreCheckpoint(next.checkpointId, x.trusted)).rejects.toMatchObject(
      reason('checkpoint-stream'),
    );
  });

  it('refuses an older bundle served under a newer checkpoint (hash and AAD bind it)', async () => {
    const { x, old, next } = await twoCheckpoints();
    x.blobs.set(next.blobSha256, x.blobs.get(old.blobSha256) as Buffer);
    await expect(x.reader.restoreCheckpoint(next.checkpointId, x.trusted)).rejects.toMatchObject({
      code: 'E_BLOB_INTEGRITY',
    });
  });
});

describe('DoS bounds and transport (MEDIUM 5, LOW)', () => {
  const streamOf = (chunks: number, size: number) => {
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent >= chunks) return c.close();
        sent++;
        c.enqueue(new Uint8Array(size));
      },
    });
    return { body, sent: () => sent };
  };

  it('stops reading a download past the expected size', async () => {
    const s = streamOf(1000, 1024);
    const down = cappedDownloader(async () => new Response(s.body));
    await expect(down('https://blob.test/x', 4096)).rejects.toMatchObject({
      code: 'E_PAYLOAD_TOO_LARGE',
    });
    expect(s.sent()).toBeLessThan(10);
  });

  it('refuses an oversized Content-Length before reading, and non-https URLs', async () => {
    const s = streamOf(1, 10);
    const down = cappedDownloader(
      async () => new Response(s.body, { headers: { 'content-length': '999999' } }),
    );
    await expect(down('https://blob.test/x', 10)).rejects.toMatchObject({
      code: 'E_PAYLOAD_TOO_LARGE',
    });
    await expect(down('http://blob.example/x', 10)).rejects.toMatchObject({ code: 'E_PROTOCOL' });
    const ok = cappedDownloader(async () => new Response(new Uint8Array([1, 2, 3])));
    expect((await ok('https://blob.test/x', 3)).length).toBe(3);
  });

  it('requires https for the API, except loopback, and never follows redirects', async () => {
    expect(() => new Http({ baseUrl: 'http://nexus.example', token: 't' })).toThrow(/https/);
    expect(() => new Http({ baseUrl: 'http://localhost:8787', token: 't' })).not.toThrow();
    let redirect: RequestRedirect | undefined;
    const http = new Http({
      baseUrl: 'https://nexus.test',
      token: 't',
      fetch: async (_i, init) => {
        redirect = init?.redirect;
        return new Response(JSON.stringify({ success: true, data: {}, meta: { requestId: 'r' } }));
      },
    });
    await http.request('GET', '/v1/x', { safeParse: (d: unknown) => ({ success: true, data: d }) });
    expect(redirect).toBe('error');
  });

  it('clamps Retry-After', async () => {
    expect(retryDelay('86400', 1)).toBe(MAX_RETRY_AFTER_MS);
    expect(retryDelay('2', 1)).toBe(2000);
    expect(retryDelay('Wed, 21 Oct 2099 07:28:00 GMT', 1)).toBeLessThan(10_000);
    const waits: number[] = [];
    const http = new Http({
      baseUrl: 'https://nexus.test',
      token: 't',
      maxAttempts: 2,
      sleep: async (ms) => {
        waits.push(ms);
      },
      fetch: async () =>
        new Response(
          JSON.stringify({
            success: false,
            error: { code: 'E_RATE_LIMITED', message: 'slow', requestId: 'r' },
          }),
          {
            status: 429,
            headers: { 'retry-after': '999999999' },
          },
        ),
    });
    await expect(
      http.request('GET', '/v1/x', { safeParse: () => ({ success: true }) }),
    ).rejects.toMatchObject({
      code: 'E_RATE_LIMITED',
    });
    expect(waits).toEqual([MAX_RETRY_AFTER_MS]);
  });
});

describe('registerProject', () => {
  it('sends organizationId when the caller names an organization, and parses the result', async () => {
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
    let sent: unknown;
    const { http, calls } = fakeHttp((_path, init) => {
      sent = JSON.parse(String(init?.body));
      return { project, streamId };
    });
    const res = await registerProject(http, { projectId: project.projectId, organizationId });
    expect(calls[0]).toBe('POST /v1/projects');
    expect(sent).toEqual({ projectId: project.projectId, organizationId });
    expect(res.project.organizationId).toBe(organizationId);
  });
});
