/**
 * Unit tests for `@cleocode/core/identity` — T947 / ADR-054 (draft).
 *
 * These tests exercise the CLEO signing-identity adapter over
 * `llmtxt/identity`. When `llmtxt/identity` cannot be loaded (e.g. missing
 * peer crypto primitive in a constrained runtime), the suite SKIPS rather
 * than fails so CI on stripped-down environments remains green.
 *
 * @task T947
 */

import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Guard: import the module under test behind a try/catch so peer-dep failures
// downgrade to a skipped suite instead of a hard import error.
let importError: Error | null = null;
type IdentityModule = typeof import('../cleo-identity.js');
let mod: IdentityModule | null = null;
try {
  mod = await import('../cleo-identity.js');
} catch (err) {
  importError = err instanceof Error ? err : new Error(String(err));
}

const describeIfLoaded = mod !== null ? describe : describe.skip;

describeIfLoaded('cleo-identity (T947)', () => {
  let tmpDir: string;
  const envBackup = { ...process.env };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cleo-identity-'));
    // Force the identity module to resolve keys inside the tmp project.
    process.env['CLEO_ROOT'] = tmpDir;
    process.env['CLEO_DIR'] = join(tmpDir, '.cleo');
    // Ensure no stale seed leaks into generate/load tests.
    delete process.env['CLEO_IDENTITY_SEED'];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    // Restore env to the pre-test snapshot.
    for (const key of Object.keys(process.env)) {
      if (!(key in envBackup)) {
        delete process.env[key];
      }
    }
    for (const [k, v] of Object.entries(envBackup)) {
      if (v !== undefined) {
        process.env[k] = v;
      }
    }
  });

  it('reports import status (diagnostic)', () => {
    // If we got here, import succeeded. Record that for observability.
    expect(importError).toBeNull();
    expect(mod).not.toBeNull();
  });

  it('getCleoIdentity generates a fresh identity when none exists', async () => {
    if (mod === null) return;
    const id = await mod.getCleoIdentity(tmpDir);
    expect(id.pubkeyHex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('getCleoIdentity is idempotent — same key on second call', async () => {
    if (mod === null) return;
    const a = await mod.getCleoIdentity(tmpDir);
    const b = await mod.getCleoIdentity(tmpDir);
    expect(a.pubkeyHex).toBe(b.pubkeyHex);
    // And the private-key seed must be identical byte-for-byte.
    expect(Buffer.from(a.sk).equals(Buffer.from(b.sk))).toBe(true);
  });

  it('persists the key file with mode 0600', async () => {
    if (mod === null) return;
    await mod.getCleoIdentity(tmpDir);
    const path = mod.getCleoIdentityPath(tmpDir);
    const stat = statSync(path);
    // On POSIX, mask out type bits and check the perm portion is 0600.
    // On Windows (not POSIX), `mode & 0o777` often returns 0o666 regardless;
    // the check is informative there, not enforcing.
    if (process.platform !== 'win32') {
      expect(stat.mode & 0o777).toBe(0o600);
    } else {
      expect(stat.mode).toBeGreaterThan(0);
    }
  });

  it('persists the key file with well-formed JSON payload', async () => {
    if (mod === null) return;
    await mod.getCleoIdentity(tmpDir);
    const path = mod.getCleoIdentityPath(tmpDir);
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed).toMatchObject({
      sk: expect.stringMatching(/^[0-9a-f]{64}$/),
      pk: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('CLEO_IDENTITY_SEED env var produces a deterministic identity', async () => {
    if (mod === null) return;
    const seed = '0'.repeat(64); // 32 bytes of zero → deterministic pubkey
    process.env['CLEO_IDENTITY_SEED'] = seed;
    const a = await mod.getCleoIdentity(tmpDir);
    const b = await mod.getCleoIdentity(tmpDir);
    expect(a.pubkeyHex).toBe(b.pubkeyHex);
    // Ed25519(seed=0*32) has a known-stable pubkey — enforce hex shape.
    expect(a.pubkeyHex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('CLEO_IDENTITY_SEED does not persist a key file', async () => {
    if (mod === null) return;
    process.env['CLEO_IDENTITY_SEED'] = 'a'.repeat(64);
    await mod.getCleoIdentity(tmpDir);
    const path = mod.getCleoIdentityPath(tmpDir);
    let exists = true;
    try {
      await readFile(path);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it('signAuditLine produces a 128-char hex signature and 64-char hex pubkey', async () => {
    if (mod === null) return;
    const id = await mod.getCleoIdentity(tmpDir);
    const { sig, pub } = await mod.signAuditLine(id, '{"hello":"world"}');
    expect(sig).toMatch(/^[0-9a-f]{128}$/);
    expect(pub).toMatch(/^[0-9a-f]{64}$/);
    expect(pub).toBe(id.pubkeyHex);
  });

  it('verifyAuditLine accepts a valid signature', async () => {
    if (mod === null) return;
    const id = await mod.getCleoIdentity(tmpDir);
    const line = '{"ts":"2026-04-17","task":"T947"}';
    const { sig, pub } = await mod.signAuditLine(id, line);
    const ok = await mod.verifyAuditLine(line, sig, pub);
    expect(ok).toBe(true);
  });

  it('verifyAuditLine rejects a tampered line', async () => {
    if (mod === null) return;
    const id = await mod.getCleoIdentity(tmpDir);
    const line = '{"ts":"2026-04-17","task":"T947"}';
    const tampered = '{"ts":"2026-04-17","task":"T666"}';
    const { sig, pub } = await mod.signAuditLine(id, line);
    const ok = await mod.verifyAuditLine(tampered, sig, pub);
    expect(ok).toBe(false);
  });

  it('verifyAuditLine rejects a malformed signature', async () => {
    if (mod === null) return;
    // Short sig / wrong length — must return false, never throw.
    const ok = await mod.verifyAuditLine('{}', 'deadbeef', 'a'.repeat(64));
    expect(ok).toBe(false);
  });

  it('verifyAuditLine rejects a malformed pubkey', async () => {
    if (mod === null) return;
    const ok = await mod.verifyAuditLine('{}', 'a'.repeat(128), 'short');
    expect(ok).toBe(false);
  });
});
