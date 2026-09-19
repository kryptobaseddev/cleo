/**
 * Tests for packages/core/src/sentient/baseline.ts
 *
 * Covers:
 *   - captureBaseline: captures a valid baseline for HEAD SHA
 *   - captureBaseline: returned event has correct shape (receiptId, sig, pub, metrics)
 *   - captureBaseline: signature validates with the signer's public key
 *   - captureBaseline: anti-gaming — commit from future / too recent → E_BASELINE_MUST_PREDATE_EXPERIMENT
 *   - captureBaseline: non-existent SHA → E_COMMIT_NOT_FOUND
 *
 * Uses a fresh local Git repository per test for real commit validation.
 * Signed events remain inside that fixture. The env KMS adapter provides
 * signing without a host keyfile or external service.
 *
 * @task T1021
 */

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { identityFromSeed } from 'llmtxt/identity';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureBaseline } from '../baseline.js';
import { querySentientEvents } from '../events.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get the HEAD commit SHA of a git repo. */
async function getHeadSha(repoRoot: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot });
  return stdout.trim();
}

/** Create a real fixture commit with an explicitly controlled timestamp. */
async function createFixtureCommit(timestamp: string): Promise<string> {
  await writeFile(join(tmpDir, 'fixture.txt'), 'baseline fixture');
  await execFileAsync('git', ['add', 'fixture.txt'], { cwd: tmpDir });
  await execFileAsync('git', ['commit', '-m', 'test: baseline fixture'], {
    cwd: tmpDir,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: timestamp,
      GIT_COMMITTER_DATE: timestamp,
    },
  });
  return getHeadSha(tmpDir);
}

const TEST_SEED_HEX = crypto.randomBytes(32).toString('hex');

let tmpDir: string;
const originalAdapter = process.env['CLEO_KMS_ADAPTER'];
const originalSeed = process.env['CLEO_SIGNING_SEED'];

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'cleo-baseline-test-'));
  await mkdir(join(tmpDir, '.cleo'));
  await execFileAsync('git', ['init', '--quiet'], { cwd: tmpDir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpDir });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
  await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: tmpDir });
  // Wire the env KMS adapter so baseline.ts can load a signing identity.
  process.env['CLEO_KMS_ADAPTER'] = 'env';
  process.env['CLEO_SIGNING_SEED'] = TEST_SEED_HEX;
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  // Restore env.
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
// Successful baseline capture
// ---------------------------------------------------------------------------

describe('captureBaseline — success path', () => {
  it('captures a baseline for an old commit SHA and returns expected shape', async () => {
    const localSha = await createFixtureCommit('2000-01-01T00:00:00Z');
    const baseline = await captureBaseline(tmpDir, localSha);

    expect(baseline.kind).toBe('baseline');
    expect(baseline.commitSha).toBe(localSha);
    expect(typeof baseline.capturedAt).toBe('string');
    expect(baseline.receiptId).toHaveLength(21);
    expect(baseline.publicKey).toHaveLength(64);
    expect(baseline.signature).toHaveLength(128);
    expect(typeof baseline.metrics).toBe('object');
  }, 60_000);

  it('writes a baseline event to the sentient events log', async () => {
    const commitSha = await createFixtureCommit('2000-01-01T00:00:00Z');
    const baseline = await captureBaseline(tmpDir, commitSha);

    // The event must be queryable by kind.
    const events = await querySentientEvents(tmpDir, {
      kind: 'baseline',
      after: new Date(Date.now() - 60_000).toISOString(),
    });

    const found = events.find((e) => e.receiptId === baseline.receiptId);
    expect(found).toBeDefined();
    expect(found?.kind).toBe('baseline');
  }, 30_000);

  it('baseline event signature validates against the signer public key', async () => {
    const commitSha = await createFixtureCommit('2000-01-01T00:00:00Z');
    const baseline = await captureBaseline(tmpDir, commitSha);

    const { verifySignature } = await import('llmtxt/identity');

    // Re-derive the identity from the seed to verify externally.
    const seed = Buffer.from(TEST_SEED_HEX, 'hex');
    const identity = await identityFromSeed(new Uint8Array(seed));
    expect(identity.pubkeyHex).toBe(baseline.publicKey);

    // Query the event to get the full signed object.
    const events = await querySentientEvents(tmpDir, {
      kind: 'baseline',
      after: new Date(Date.now() - 60_000).toISOString(),
    });
    const event = events.find((e) => e.receiptId === baseline.receiptId);
    expect(event).toBeDefined();
    if (!event) return;

    // Reconstruct signable payload (all fields except sig).
    const { sig, ...unsigned } = event;
    const sortedUnsigned = JSON.parse(JSON.stringify(unsigned)) as Record<string, unknown>;
    const sortKeysDeep = (v: unknown): unknown => {
      if (v === null || typeof v !== 'object') return v;
      if (Array.isArray(v)) return v.map(sortKeysDeep);
      const o = v as Record<string, unknown>;
      const s: Record<string, unknown> = {};
      for (const k of Object.keys(o).sort()) s[k] = sortKeysDeep(o[k]);
      return s;
    };
    const canonicalBytes = Buffer.from(JSON.stringify(sortKeysDeep(sortedUnsigned)), 'utf-8');

    const valid = await verifySignature(canonicalBytes, sig, baseline.publicKey);
    expect(valid).toBe(true);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Anti-gaming guard
// ---------------------------------------------------------------------------

describe('captureBaseline — anti-gaming guard', () => {
  it('rejects a commit that is too recent (< 5s old)', async () => {
    const headSha = await createFixtureCommit(new Date().toISOString());

    // This commit was just created — it is less than 5s old.
    await expect(captureBaseline(tmpDir, headSha)).rejects.toThrow(
      /E_BASELINE_MUST_PREDATE_EXPERIMENT/,
    );
  });

  it('rejects a non-existent commit SHA', async () => {
    const fakeSha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    await expect(captureBaseline(tmpDir, fakeSha)).rejects.toThrow(/E_COMMIT_NOT_FOUND/);
  });

  it('rejects a malformed SHA (not hex)', async () => {
    await expect(captureBaseline(tmpDir, 'not-a-sha!!')).rejects.toThrow(
      /Invalid commit SHA format/,
    );
  });
});
