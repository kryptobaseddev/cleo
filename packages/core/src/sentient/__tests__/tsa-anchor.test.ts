/**
 * Tests for packages/core/src/sentient/tsa-anchor.ts
 *
 * Covers:
 *   - buildTimestampRequest: correct DER structure for a 32-byte hash
 *   - buildTimestampRequest: rejects non-32-byte input
 *   - anchorChainDaily: no-op if last anchor < 24 h ago
 *   - anchorChainDaily: no-op if chain is empty
 *   - anchorChainDaily: writes tsa_anchor event with correct shape (mocked TSA)
 *   - anchorChainDaily: returns null on TSA network failure (does not throw)
 *   - readTsaUrl: falls back to default when config absent
 *   - readTsaUrl: reads tsaEndpoint from sentient.json
 *
 * Network calls are avoided via the `tsaClientOverride` parameter of
 * `anchorChainDaily` — dependency injection rather than module-level spying.
 *
 * @task T1026
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { identityFromSeed } from 'llmtxt/identity';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendSentientEvent, type BaselinePayload, querySentientEvents } from '../events.js';
import { anchorChainDaily, buildTimestampRequest, readTsaUrl } from '../tsa-anchor.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASELINE_PAYLOAD: BaselinePayload = {
  commitSha: 'abc123def456abc123def456abc123def456abc1',
  baselineHash: 'deadbeef'.repeat(8),
  metricsJson: JSON.stringify({ testsPassed: 1 }),
  worktreeNotCreatedYet: true,
};

// Minimal fake TimeStampResp DER (not a real RFC 3161 response — just bytes).
const FAKE_TSA_RESPONSE = Buffer.from([0x30, 0x03, 0x02, 0x01, 0x00]);

/** A mock TSA client that resolves with the fake response immediately. */
const mockTsaClient = async (_url: string, _body: Buffer): Promise<Buffer> => {
  return FAKE_TSA_RESPONSE;
};

/** A mock TSA client that records the URL and body it was called with. */
function makeSpy(): {
  client: (url: string, body: Buffer) => Promise<Buffer>;
  calls: Array<{ url: string; body: Buffer }>;
} {
  const calls: Array<{ url: string; body: Buffer }> = [];
  return {
    client: async (url: string, body: Buffer): Promise<Buffer> => {
      calls.push({ url, body });
      return FAKE_TSA_RESPONSE;
    },
    calls,
  };
}

/** A mock TSA client that always rejects with an error. */
function makeFailClient(message: string): (url: string, body: Buffer) => Promise<Buffer> {
  return async (_url: string, _body: Buffer): Promise<Buffer> => {
    throw new Error(message);
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let identity: Awaited<ReturnType<typeof identityFromSeed>>;

const originalAdapter = process.env['CLEO_KMS_ADAPTER'];
const originalSeed = process.env['CLEO_SIGNING_SEED'];

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'cleo-tsa-anchor-test-'));
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seed[i] = i + 42;
  identity = await identityFromSeed(seed);

  // Wire env KMS adapter so tsa-anchor can load a signing identity.
  process.env['CLEO_KMS_ADAPTER'] = 'env';
  process.env['CLEO_SIGNING_SEED'] = Buffer.from(seed).toString('hex');
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  if (originalAdapter === undefined) {
    delete process.env['CLEO_KMS_ADAPTER'];
  } else {
    process.env['CLEO_KMS_ADAPTER'] = originalAdapter;
  }
  if (originalSeed === undefined) {
    delete process.env['CLEO_SIGNING_SEED'];
  } else {
    process.env['CLEO_SIGNING_SEED'] = originalSeed;
  }
});

// ---------------------------------------------------------------------------
// buildTimestampRequest
// ---------------------------------------------------------------------------

describe('buildTimestampRequest', () => {
  it('produces a DER buffer for a 32-byte hash', () => {
    const hash = Buffer.alloc(32, 0xab);
    const der = buildTimestampRequest(hash);

    expect(Buffer.isBuffer(der)).toBe(true);
    expect(der.length).toBeGreaterThan(0);

    // Outer SEQUENCE tag = 0x30
    expect(der[0]).toBe(0x30);

    // Should contain the SHA-256 OID bytes somewhere in the DER.
    const hexDer = der.toString('hex');
    // SHA-256 OID encoded: 60 86 48 01 65 03 04 02 01
    expect(hexDer).toContain('6086480165030402');

    // Should contain the 32 message hash bytes.
    const hashHex = hash.toString('hex');
    expect(hexDer).toContain(hashHex);

    // certReq BOOLEAN TRUE: 01 01 ff
    expect(hexDer).toContain('0101ff');

    // version INTEGER 1: 02 01 01
    expect(hexDer).toContain('020101');
  });

  it('throws if messageHash is not exactly 32 bytes', () => {
    expect(() => buildTimestampRequest(Buffer.alloc(16))).toThrow(/must be exactly 32 bytes/);
    expect(() => buildTimestampRequest(Buffer.alloc(64))).toThrow(/must be exactly 32 bytes/);
  });

  it('produces consistent output for the same input', () => {
    const hash = Buffer.alloc(32, 0x55);
    const der1 = buildTimestampRequest(hash);
    const der2 = buildTimestampRequest(hash);
    expect(der1.toString('hex')).toBe(der2.toString('hex'));
  });
});

// ---------------------------------------------------------------------------
// readTsaUrl
// ---------------------------------------------------------------------------

describe('readTsaUrl', () => {
  it('falls back to default when sentient.json is absent', async () => {
    const url = await readTsaUrl(tmpDir);
    expect(url).toBe('http://timestamp.digicert.com');
  });

  it('reads tsaEndpoint from .cleo/sentient.json', async () => {
    const cleoDir = join(tmpDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    await writeFile(
      join(cleoDir, 'sentient.json'),
      JSON.stringify({ tsaEndpoint: 'https://tsa.example.com/ts' }),
      'utf-8',
    );

    const url = await readTsaUrl(tmpDir);
    expect(url).toBe('https://tsa.example.com/ts');
  });

  it('falls back to default when tsaEndpoint is an empty string', async () => {
    const cleoDir = join(tmpDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    await writeFile(join(cleoDir, 'sentient.json'), JSON.stringify({ tsaEndpoint: '' }), 'utf-8');

    const url = await readTsaUrl(tmpDir);
    expect(url).toBe('http://timestamp.digicert.com');
  });
});

// ---------------------------------------------------------------------------
// anchorChainDaily — no-op cases
// ---------------------------------------------------------------------------

describe('anchorChainDaily — no-op', () => {
  it('returns null when the event log is empty (nothing to anchor)', async () => {
    const result = await anchorChainDaily(tmpDir, mockTsaClient);
    expect(result).toBeNull();
  });

  it('returns null if a tsa_anchor event was written < 24 h ago', async () => {
    // First, append a real chain event so the log is non-empty.
    await appendSentientEvent(tmpDir, identity, {
      kind: 'baseline',
      experimentId: '',
      taskId: '',
      payload: BASELINE_PAYLOAD,
    });

    // First anchor — should succeed.
    const first = await anchorChainDaily(tmpDir, mockTsaClient);
    expect(first).not.toBeNull();
    expect(first?.kind).toBe('tsa_anchor');

    // Second call — should be a no-op (< 24 h).
    const second = await anchorChainDaily(tmpDir, mockTsaClient);
    expect(second).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// anchorChainDaily — success path (mocked TSA)
// ---------------------------------------------------------------------------

describe('anchorChainDaily — success (mocked TSA)', () => {
  it('writes a tsa_anchor event with correct shape', async () => {
    // Append a baseline event so the chain is non-empty.
    const baselineEv = await appendSentientEvent(tmpDir, identity, {
      kind: 'baseline',
      experimentId: '',
      taskId: '',
      payload: BASELINE_PAYLOAD,
    });

    const anchor = await anchorChainDaily(tmpDir, mockTsaClient);
    expect(anchor).not.toBeNull();
    if (!anchor) return;

    // Check event shape.
    expect(anchor.kind).toBe('tsa_anchor');
    expect(anchor.receiptId).toHaveLength(21);
    expect(anchor.sig).toHaveLength(128);
    expect(anchor.pub).toHaveLength(64);

    // Check payload.
    expect(anchor.payload.chainHeadReceiptId).toBe(baselineEv.receiptId);
    expect(anchor.payload.chainHeadHash).toHaveLength(64); // hex sha256
    expect(anchor.payload.tsaUrl).toBe('http://timestamp.digicert.com');
    expect(anchor.payload.tsaToken).toBe(FAKE_TSA_RESPONSE.toString('base64'));
    expect(anchor.payload.anchoredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Check event is queryable.
    const found = await querySentientEvents(tmpDir, { kind: 'tsa_anchor' });
    expect(found).toHaveLength(1);
    expect(found[0].receiptId).toBe(anchor.receiptId);
  });

  it('uses custom TSA URL from sentient.json', async () => {
    const cleoDir = join(tmpDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    await writeFile(
      join(cleoDir, 'sentient.json'),
      JSON.stringify({ tsaEndpoint: 'https://custom.tsa.example.com/ts' }),
      'utf-8',
    );

    await appendSentientEvent(tmpDir, identity, {
      kind: 'baseline',
      experimentId: '',
      taskId: '',
      payload: BASELINE_PAYLOAD,
    });

    const spy = makeSpy();
    const anchor = await anchorChainDaily(tmpDir, spy.client);
    expect(anchor).not.toBeNull();
    expect(anchor?.payload.tsaUrl).toBe('https://custom.tsa.example.com/ts');

    // Verify the spy client was called with the custom URL.
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].url).toBe('https://custom.tsa.example.com/ts');
  });

  it('passes a valid DER-encoded TimeStampReq to the TSA client', async () => {
    await appendSentientEvent(tmpDir, identity, {
      kind: 'baseline',
      experimentId: '',
      taskId: '',
      payload: BASELINE_PAYLOAD,
    });

    const spy = makeSpy();
    await anchorChainDaily(tmpDir, spy.client);

    expect(spy.calls).toHaveLength(1);
    const body = spy.calls[0].body;

    // Outer byte must be SEQUENCE tag 0x30.
    expect(body[0]).toBe(0x30);

    // Body must contain the SHA-256 OID.
    expect(body.toString('hex')).toContain('6086480165030402');
  });
});

// ---------------------------------------------------------------------------
// anchorChainDaily — failure path
// ---------------------------------------------------------------------------

describe('anchorChainDaily — TSA failure', () => {
  it('returns null and does not throw on network error', async () => {
    await appendSentientEvent(tmpDir, identity, {
      kind: 'baseline',
      experimentId: '',
      taskId: '',
      payload: BASELINE_PAYLOAD,
    });

    const failClient = makeFailClient('ECONNREFUSED: connection refused');

    // Should NOT throw — non-fatal failure.
    const result = await anchorChainDaily(tmpDir, failClient);
    expect(result).toBeNull();

    // No tsa_anchor event should have been written.
    const anchors = await querySentientEvents(tmpDir, { kind: 'tsa_anchor' });
    expect(anchors).toHaveLength(0);
  });

  it('returns null on HTTP non-2xx response', async () => {
    await appendSentientEvent(tmpDir, identity, {
      kind: 'baseline',
      experimentId: '',
      taskId: '',
      payload: BASELINE_PAYLOAD,
    });

    const failClient = makeFailClient('TSA returned HTTP 503');
    const result = await anchorChainDaily(tmpDir, failClient);
    expect(result).toBeNull();
  });
});
