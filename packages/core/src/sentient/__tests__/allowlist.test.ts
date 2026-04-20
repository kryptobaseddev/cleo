/**
 * Tests for packages/core/src/sentient/allowlist.ts
 *
 * Covers:
 *   - Empty config → empty array
 *   - Add pubkey → list shows it
 *   - Remove pubkey → list does not show it
 *   - isOwnerSigner: known key → true
 *   - isOwnerSigner: unknown key → false
 *   - isOwnerSigner: same-prefix-different-key → false
 *   - Cache: 2 reads within 60s → 1 file read (cache hit)
 *   - noCache: bypasses the in-process cache
 *   - removeOwnerPubkey: throws when key not found
 *   - addOwnerPubkey: deduplicates identical keys
 *   - validatePubkeyBase64: rejects non-32-byte input
 *   - Strict mode (CLEO_STRICT_ALLOWLIST=1): empty allowlist → false
 *   - Strict mode: non-matching key → false
 *
 * @task T1027
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addOwnerPubkey,
  getOwnerPubkeys,
  isOwnerSigner,
  type OwnerAllowlistConfig,
  removeOwnerPubkey,
} from '../allowlist.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a deterministic 32-byte pubkey from a seed byte. */
function fakePubkey(seed: number): Uint8Array {
  const buf = new Uint8Array(32);
  buf.fill(seed);
  return buf;
}

/** Base64-encode a Uint8Array. */
function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'allowlist-test-'));
  await mkdir(join(tmpDir, '.cleo'), { recursive: true });
  // Always start with a fresh cache by invalidating it through noCache reads.
  await getOwnerPubkeys(tmpDir, { noCache: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  // Restore env after each test.
  delete process.env['CLEO_STRICT_ALLOWLIST'];
});

// ---------------------------------------------------------------------------
// getOwnerPubkeys
// ---------------------------------------------------------------------------

describe('getOwnerPubkeys', () => {
  it('returns empty array when config is absent', async () => {
    const keys = await getOwnerPubkeys(tmpDir, { noCache: true });
    expect(keys).toEqual([]);
  });

  it('returns empty array when ownerPubkeys is not in config', async () => {
    await writeFile(join(tmpDir, '.cleo/config.json'), JSON.stringify({ someOtherField: true }));
    const keys = await getOwnerPubkeys(tmpDir, { noCache: true });
    expect(keys).toEqual([]);
  });

  it('returns empty array when ownerPubkeys is empty array', async () => {
    const config: OwnerAllowlistConfig = { ownerPubkeys: [] };
    await writeFile(join(tmpDir, '.cleo/config.json'), JSON.stringify(config));
    const keys = await getOwnerPubkeys(tmpDir, { noCache: true });
    expect(keys).toEqual([]);
  });

  it('returns decoded pubkeys from ownerPubkeys array', async () => {
    const key1 = fakePubkey(0x01);
    const key2 = fakePubkey(0x02);
    const config: OwnerAllowlistConfig = { ownerPubkeys: [toBase64(key1), toBase64(key2)] };
    await writeFile(join(tmpDir, '.cleo/config.json'), JSON.stringify(config));

    const keys = await getOwnerPubkeys(tmpDir, { noCache: true });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toEqual(key1);
    expect(keys[1]).toEqual(key2);
  });

  it('cache: second read returns same result without mutating from stale disk', async () => {
    const key1 = fakePubkey(0xaa);
    const config: OwnerAllowlistConfig = { ownerPubkeys: [toBase64(key1)] };
    await writeFile(join(tmpDir, '.cleo/config.json'), JSON.stringify(config));

    // Prime the cache with a forced read.
    const first = await getOwnerPubkeys(tmpDir, { noCache: true });
    expect(first).toHaveLength(1);

    // Overwrite the file on disk — cache should shield us from the new value.
    const key2 = fakePubkey(0xbb);
    const config2: OwnerAllowlistConfig = { ownerPubkeys: [toBase64(key2)] };
    await writeFile(join(tmpDir, '.cleo/config.json'), JSON.stringify(config2));

    // Without noCache, we should still see the OLD (cached) value.
    const cached = await getOwnerPubkeys(tmpDir);
    expect(cached).toHaveLength(1);
    expect(cached[0]).toEqual(key1);

    // With noCache, we see the NEW value from disk.
    const fresh = await getOwnerPubkeys(tmpDir, { noCache: true });
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toEqual(key2);
  });

  it('noCache: bypasses cache and reads from disk', async () => {
    // Prime cache with empty config.
    await getOwnerPubkeys(tmpDir, { noCache: true });

    // Write a key to disk after caching.
    const key1 = fakePubkey(0x07);
    const config: OwnerAllowlistConfig = { ownerPubkeys: [toBase64(key1)] };
    await writeFile(join(tmpDir, '.cleo/config.json'), JSON.stringify(config));

    // noCache should see the updated file.
    const keys = await getOwnerPubkeys(tmpDir, { noCache: true });
    expect(keys).toHaveLength(1);
    expect(keys[0]).toEqual(key1);
  });
});

// ---------------------------------------------------------------------------
// addOwnerPubkey
// ---------------------------------------------------------------------------

describe('addOwnerPubkey', () => {
  it('adds a pubkey to an empty config', async () => {
    const key = fakePubkey(0x10);
    const b64 = toBase64(key);

    await addOwnerPubkey(tmpDir, b64);

    const keys = await getOwnerPubkeys(tmpDir, { noCache: true });
    expect(keys).toHaveLength(1);
    expect(keys[0]).toEqual(key);
  });

  it('appends a second pubkey', async () => {
    const key1 = fakePubkey(0x11);
    const key2 = fakePubkey(0x12);

    await addOwnerPubkey(tmpDir, toBase64(key1));
    await addOwnerPubkey(tmpDir, toBase64(key2));

    const keys = await getOwnerPubkeys(tmpDir, { noCache: true });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toEqual(key1);
    expect(keys[1]).toEqual(key2);
  });

  it('deduplicates identical pubkeys', async () => {
    const key = fakePubkey(0x20);
    const b64 = toBase64(key);

    await addOwnerPubkey(tmpDir, b64);
    await addOwnerPubkey(tmpDir, b64); // duplicate

    const keys = await getOwnerPubkeys(tmpDir, { noCache: true });
    expect(keys).toHaveLength(1);
  });

  it('rejects a base64 string that does not decode to 32 bytes', async () => {
    const shortKey = Buffer.from([0x01, 0x02]).toString('base64'); // 2 bytes, not 32
    await expect(addOwnerPubkey(tmpDir, shortKey)).rejects.toThrow(/expected 32 bytes/);
  });

  it('writes config atomically (config.json present after add)', async () => {
    const key = fakePubkey(0x30);
    await addOwnerPubkey(tmpDir, toBase64(key));

    const raw = await readFile(join(tmpDir, '.cleo/config.json'), 'utf-8');
    const parsed = JSON.parse(raw) as OwnerAllowlistConfig;
    expect(Array.isArray(parsed.ownerPubkeys)).toBe(true);
    expect(parsed.ownerPubkeys).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// removeOwnerPubkey
// ---------------------------------------------------------------------------

describe('removeOwnerPubkey', () => {
  it('removes a pubkey and the list is then empty', async () => {
    const key = fakePubkey(0x40);
    const b64 = toBase64(key);

    await addOwnerPubkey(tmpDir, b64);
    await removeOwnerPubkey(tmpDir, b64);

    const keys = await getOwnerPubkeys(tmpDir, { noCache: true });
    expect(keys).toHaveLength(0);
  });

  it('removes only the targeted key, leaves others', async () => {
    const key1 = fakePubkey(0x41);
    const key2 = fakePubkey(0x42);

    await addOwnerPubkey(tmpDir, toBase64(key1));
    await addOwnerPubkey(tmpDir, toBase64(key2));

    await removeOwnerPubkey(tmpDir, toBase64(key1));

    const keys = await getOwnerPubkeys(tmpDir, { noCache: true });
    expect(keys).toHaveLength(1);
    expect(keys[0]).toEqual(key2);
  });

  it('throws E_ALLOWLIST_KEY_NOT_FOUND when key is not present', async () => {
    const key = fakePubkey(0x50);
    await expect(removeOwnerPubkey(tmpDir, toBase64(key))).rejects.toThrow(
      /E_ALLOWLIST_KEY_NOT_FOUND/,
    );
  });

  it('throws when key not present even after prior adds', async () => {
    const key1 = fakePubkey(0x51);
    const key2 = fakePubkey(0x52); // never added

    await addOwnerPubkey(tmpDir, toBase64(key1));

    await expect(removeOwnerPubkey(tmpDir, toBase64(key2))).rejects.toThrow(
      /E_ALLOWLIST_KEY_NOT_FOUND/,
    );
  });
});

// ---------------------------------------------------------------------------
// isOwnerSigner
// ---------------------------------------------------------------------------

describe('isOwnerSigner', () => {
  it('returns true for a known key', async () => {
    const key = fakePubkey(0x60);
    await addOwnerPubkey(tmpDir, toBase64(key));

    const result = await isOwnerSigner(tmpDir, key);
    expect(result).toBe(true);
  });

  it('returns false for an unknown key when allowlist is populated', async () => {
    const key1 = fakePubkey(0x61);
    const key2 = fakePubkey(0x62); // not added

    await addOwnerPubkey(tmpDir, toBase64(key1));

    const result = await isOwnerSigner(tmpDir, key2);
    expect(result).toBe(false);
  });

  it('returns false for a same-prefix-different-key entry', async () => {
    // key1 = 0x63 repeated 32 times
    const key1 = fakePubkey(0x63);
    // key2 differs only in the last byte
    const key2 = new Uint8Array(key1);
    key2[31] = 0xff;

    await addOwnerPubkey(tmpDir, toBase64(key1));

    const result = await isOwnerSigner(tmpDir, key2);
    expect(result).toBe(false);
  });

  it('returns true (bootstrapping) and warns when allowlist is empty and strict=off', async () => {
    delete process.env['CLEO_STRICT_ALLOWLIST'];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const key = fakePubkey(0x70);
    const result = await isOwnerSigner(tmpDir, key);

    expect(result).toBe(true);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('ownerPubkeys is empty'));
    stderrSpy.mockRestore();
  });

  it('returns false when allowlist is empty and CLEO_STRICT_ALLOWLIST=1', async () => {
    process.env['CLEO_STRICT_ALLOWLIST'] = '1';

    const key = fakePubkey(0x71);
    const result = await isOwnerSigner(tmpDir, key);
    expect(result).toBe(false);
  });

  it('returns false for non-matching key with CLEO_STRICT_ALLOWLIST=1', async () => {
    process.env['CLEO_STRICT_ALLOWLIST'] = '1';

    const key1 = fakePubkey(0x72);
    const key2 = fakePubkey(0x73);

    await addOwnerPubkey(tmpDir, toBase64(key1));

    const result = await isOwnerSigner(tmpDir, key2);
    expect(result).toBe(false);
  });
});
