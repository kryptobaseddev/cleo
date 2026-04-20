/**
 * Tests for packages/core/src/sentient/kms.ts
 *
 * Covers:
 *   - env adapter: reads CLEO_SIGNING_SEED, derives identity, signs/verifies
 *   - env adapter: rejects absent, short, or non-hex seed values
 *   - file adapter: reads 0600 keyfile, derives identity
 *   - file adapter: rejects missing file, wrong mode, wrong size
 *   - resolveAdapterKind: defaults to "file", honours CLEO_KMS_ADAPTER env
 *   - vault adapter stub: throws descriptive error
 *   - aws adapter stub: throws descriptive error
 *
 * @task T1021
 */

import crypto from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadAwsIdentity,
  loadEnvIdentity,
  loadFileIdentity,
  loadSigningIdentity,
  loadVaultIdentity,
  resolveAdapterKind,
} from '../kms.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a random 32-byte Ed25519 seed as a 64-char lowercase hex string. */
function randomSeedHex(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** Make a temp directory scoped to this test file. */
async function makeTmpDir(): Promise<string> {
  const base = await import('node:fs/promises').then((m) =>
    m.mkdtemp(join(tmpdir(), 'cleo-kms-test-')),
  );
  return base;
}

// ---------------------------------------------------------------------------
// resolveAdapterKind
// ---------------------------------------------------------------------------

describe('resolveAdapterKind', () => {
  const original = process.env['CLEO_KMS_ADAPTER'];

  afterEach(() => {
    if (original === undefined) {
      delete process.env['CLEO_KMS_ADAPTER'];
    } else {
      process.env['CLEO_KMS_ADAPTER'] = original;
    }
  });

  it('defaults to "file" when CLEO_KMS_ADAPTER is absent', () => {
    delete process.env['CLEO_KMS_ADAPTER'];
    expect(resolveAdapterKind()).toBe('file');
  });

  it('defaults to "file" when CLEO_KMS_ADAPTER is empty', () => {
    process.env['CLEO_KMS_ADAPTER'] = '';
    expect(resolveAdapterKind()).toBe('file');
  });

  it('returns "env" for CLEO_KMS_ADAPTER=env', () => {
    process.env['CLEO_KMS_ADAPTER'] = 'env';
    expect(resolveAdapterKind()).toBe('env');
  });

  it('returns "vault" for CLEO_KMS_ADAPTER=vault', () => {
    process.env['CLEO_KMS_ADAPTER'] = 'vault';
    expect(resolveAdapterKind()).toBe('vault');
  });

  it('returns "aws" for CLEO_KMS_ADAPTER=aws', () => {
    process.env['CLEO_KMS_ADAPTER'] = 'aws';
    expect(resolveAdapterKind()).toBe('aws');
  });

  it('is case-insensitive', () => {
    process.env['CLEO_KMS_ADAPTER'] = 'ENV';
    expect(resolveAdapterKind()).toBe('env');
  });

  it('throws for unknown adapter value', () => {
    process.env['CLEO_KMS_ADAPTER'] = 'unknown-backend';
    expect(() => resolveAdapterKind()).toThrow(/Invalid CLEO_KMS_ADAPTER/);
  });
});

// ---------------------------------------------------------------------------
// env adapter
// ---------------------------------------------------------------------------

describe('loadEnvIdentity', () => {
  const originalSeed = process.env['CLEO_SIGNING_SEED'];

  afterEach(() => {
    if (originalSeed === undefined) {
      delete process.env['CLEO_SIGNING_SEED'];
    } else {
      process.env['CLEO_SIGNING_SEED'] = originalSeed;
    }
  });

  it('loads identity from CLEO_SIGNING_SEED and returns AgentIdentity', async () => {
    process.env['CLEO_SIGNING_SEED'] = randomSeedHex();
    const identity = await loadEnvIdentity();
    expect(identity).toBeDefined();
    expect(typeof identity.pubkeyHex).toBe('string');
    expect(identity.pubkeyHex).toHaveLength(64);
  });

  it('produces deterministic public key for same seed', async () => {
    const seed = randomSeedHex();
    process.env['CLEO_SIGNING_SEED'] = seed;
    const id1 = await loadEnvIdentity();
    const id2 = await loadEnvIdentity();
    expect(id1.pubkeyHex).toBe(id2.pubkeyHex);
  });

  it('signs and the same identity can verify', async () => {
    process.env['CLEO_SIGNING_SEED'] = randomSeedHex();
    const identity = await loadEnvIdentity();
    const message = Buffer.from('test payload for sentient event');
    const signature = await identity.sign(message);
    const valid = await identity.verify(message, signature);
    expect(valid).toBe(true);
  });

  it('throws when CLEO_SIGNING_SEED is absent', async () => {
    delete process.env['CLEO_SIGNING_SEED'];
    await expect(loadEnvIdentity()).rejects.toThrow(/CLEO_KMS_ADAPTER=env/);
  });

  it('throws when CLEO_SIGNING_SEED is empty', async () => {
    process.env['CLEO_SIGNING_SEED'] = '';
    await expect(loadEnvIdentity()).rejects.toThrow(/CLEO_KMS_ADAPTER=env/);
  });

  it('throws when CLEO_SIGNING_SEED is too short', async () => {
    process.env['CLEO_SIGNING_SEED'] = 'deadbeef';
    await expect(loadEnvIdentity()).rejects.toThrow(/exactly 64 hex characters/);
  });

  it('throws when CLEO_SIGNING_SEED is too long', async () => {
    process.env['CLEO_SIGNING_SEED'] = 'a'.repeat(66);
    await expect(loadEnvIdentity()).rejects.toThrow(/exactly 64 hex characters/);
  });

  it('throws when CLEO_SIGNING_SEED contains non-hex characters', async () => {
    // 64 chars but contains 'z'
    process.env['CLEO_SIGNING_SEED'] = 'z'.repeat(64);
    await expect(loadEnvIdentity()).rejects.toThrow(/exactly 64 hex characters/);
  });
});

// ---------------------------------------------------------------------------
// file adapter
// ---------------------------------------------------------------------------

describe('loadFileIdentity', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
    // Pre-create the .cleo/keys/ directory.
    await mkdir(join(tmpDir, '.cleo', 'keys'), { recursive: true });
  });

  afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('loads identity from a valid 0600 keyfile', async () => {
    const keyPath = join(tmpDir, '.cleo', 'keys', 'sentient.ed25519');
    const seed = crypto.randomBytes(32);
    await writeFile(keyPath, seed, { mode: 0o600 });

    const identity = await loadFileIdentity(tmpDir);
    expect(identity).toBeDefined();
    expect(identity.pubkeyHex).toHaveLength(64);
  });

  it('produces deterministic public key for same seed', async () => {
    const keyPath = join(tmpDir, '.cleo', 'keys', 'sentient.ed25519');
    const seed = crypto.randomBytes(32);
    await writeFile(keyPath, seed, { mode: 0o600 });

    const id1 = await loadFileIdentity(tmpDir);
    const id2 = await loadFileIdentity(tmpDir);
    expect(id1.pubkeyHex).toBe(id2.pubkeyHex);
  });

  it('signs payload and verifies with same identity', async () => {
    const keyPath = join(tmpDir, '.cleo', 'keys', 'sentient.ed25519');
    const seed = crypto.randomBytes(32);
    await writeFile(keyPath, seed, { mode: 0o600 });

    const identity = await loadFileIdentity(tmpDir);
    const message = Buffer.from('baseline event payload');
    const sig = await identity.sign(message);
    expect(await identity.verify(message, sig)).toBe(true);
  });

  it('throws when keyfile does not exist', async () => {
    await expect(loadFileIdentity(tmpDir)).rejects.toThrow(/keyfile not found/);
  });

  it('refuses to load when file mode is 0644', async () => {
    const keyPath = join(tmpDir, '.cleo', 'keys', 'sentient.ed25519');
    const seed = crypto.randomBytes(32);
    await writeFile(keyPath, seed);
    await chmod(keyPath, 0o644);

    await expect(loadFileIdentity(tmpDir)).rejects.toThrow(/must have mode 0600/);
  });

  it('refuses to load when file mode is 0644 (owner-only read)', async () => {
    const keyPath = join(tmpDir, '.cleo', 'keys', 'sentient.ed25519');
    const seed = crypto.randomBytes(32);
    await writeFile(keyPath, seed);
    await chmod(keyPath, 0o400);

    await expect(loadFileIdentity(tmpDir)).rejects.toThrow(/must have mode 0600/);
  });

  it('throws when keyfile has wrong size (not 32 bytes)', async () => {
    const keyPath = join(tmpDir, '.cleo', 'keys', 'sentient.ed25519');
    await writeFile(keyPath, Buffer.alloc(16), { mode: 0o600 });

    await expect(loadFileIdentity(tmpDir)).rejects.toThrow(/exactly 32 bytes/);
  });
});

// ---------------------------------------------------------------------------
// vault adapter stub
// ---------------------------------------------------------------------------

describe('loadVaultIdentity (stub)', () => {
  const originalVaultAddr = process.env['VAULT_ADDR'];
  const originalVaultToken = process.env['VAULT_TOKEN'];

  afterEach(() => {
    if (originalVaultAddr === undefined) {
      delete process.env['VAULT_ADDR'];
    } else {
      process.env['VAULT_ADDR'] = originalVaultAddr;
    }
    if (originalVaultToken === undefined) {
      delete process.env['VAULT_TOKEN'];
    } else {
      process.env['VAULT_TOKEN'] = originalVaultToken;
    }
  });

  it('throws with missing VAULT_ADDR / VAULT_TOKEN', async () => {
    delete process.env['VAULT_ADDR'];
    delete process.env['VAULT_TOKEN'];
    await expect(loadVaultIdentity()).rejects.toThrow(/VAULT_ADDR/);
  });

  it('throws stub error even when env vars are present', async () => {
    process.env['VAULT_ADDR'] = 'https://vault.example.com';
    process.env['VAULT_TOKEN'] = 'test-token';
    await expect(loadVaultIdentity()).rejects.toThrow(/not yet fully implemented/);
  });
});

// ---------------------------------------------------------------------------
// aws adapter stub
// ---------------------------------------------------------------------------

describe('loadAwsIdentity (stub)', () => {
  const originalKeyId = process.env['CLEO_KMS_AWS_KEY_ID'];

  afterEach(() => {
    if (originalKeyId === undefined) {
      delete process.env['CLEO_KMS_AWS_KEY_ID'];
    } else {
      process.env['CLEO_KMS_AWS_KEY_ID'] = originalKeyId;
    }
  });

  it('throws with missing CLEO_KMS_AWS_KEY_ID', async () => {
    delete process.env['CLEO_KMS_AWS_KEY_ID'];
    await expect(loadAwsIdentity()).rejects.toThrow(/CLEO_KMS_AWS_KEY_ID/);
  });

  it('throws stub error even when key id is present', async () => {
    process.env['CLEO_KMS_AWS_KEY_ID'] = 'arn:aws:kms:us-east-1:123456789:key/test';
    await expect(loadAwsIdentity()).rejects.toThrow(/not yet fully implemented/);
  });
});

// ---------------------------------------------------------------------------
// loadSigningIdentity — top-level dispatch
// ---------------------------------------------------------------------------

describe('loadSigningIdentity', () => {
  const originalAdapter = process.env['CLEO_KMS_ADAPTER'];
  const originalSeed = process.env['CLEO_SIGNING_SEED'];

  afterEach(() => {
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

  it('routes to env adapter when CLEO_KMS_ADAPTER=env', async () => {
    process.env['CLEO_KMS_ADAPTER'] = 'env';
    process.env['CLEO_SIGNING_SEED'] = randomSeedHex();
    const identity = await loadSigningIdentity('/fake/root');
    expect(identity.pubkeyHex).toHaveLength(64);
  });

  it('routes to file adapter when CLEO_KMS_ADAPTER=file', async () => {
    const { mkdtemp, mkdir: mkdirFs } = await import('node:fs/promises');
    const tmpDir = await mkdtemp(join(tmpdir(), 'cleo-kms-dispatch-'));
    await mkdirFs(join(tmpDir, '.cleo', 'keys'), { recursive: true });
    const keyPath = join(tmpDir, '.cleo', 'keys', 'sentient.ed25519');
    await writeFile(keyPath, crypto.randomBytes(32), { mode: 0o600 });

    process.env['CLEO_KMS_ADAPTER'] = 'file';
    const identity = await loadSigningIdentity(tmpDir);
    expect(identity.pubkeyHex).toHaveLength(64);

    const { rm } = await import('node:fs/promises');
    await rm(tmpDir, { recursive: true, force: true });
  });
});
