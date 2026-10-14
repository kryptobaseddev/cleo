/**
 * FileNexusTokenStore seed race (T12712 review item 6): a symlink planted
 * after the symlink check but before the store file is created must not be
 * followed. `lstatSync` is made blind for the test so the planted link slips
 * past the check, exactly as it would inside the TOCTOU window.
 *
 * @task T12712
 */

import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const blind = vi.hoisted(() => ({ on: false }));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    lstatSync: ((...args: Parameters<typeof real.lstatSync>) => {
      if (blind.on) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return real.lstatSync(...args);
    }) as typeof real.lstatSync,
  };
});

import { FileNexusTokenStore } from '../nexus-credentials.js';

describe('FileNexusTokenStore seed (TOCTOU)', () => {
  it('does not create the file through a symlink planted after the symlink check', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-cred-toctou-'));
    const victim = join(dir, 'victim-target.json');
    const location = join(dir, 'nexus-credentials.json');
    symlinkSync(victim, location); // dangling link to an attacker-chosen path
    const store = new FileNexusTokenStore(location);

    blind.on = true;
    try {
      await store
        .put('https://api.nexus.test', {
          token: 'tok_SECRET_toctou_0123456789abcdef',
          tokenType: 'Bearer',
          expiresAt: null,
          user: null,
          organization: null,
        })
        .catch(() => undefined);
    } finally {
      blind.on = false;
    }
    // Following the link would have created the attacker's target file.
    expect(existsSync(victim)).toBe(false);
  });
});

describe('FileNexusTokenStore refuses a file it cannot read safely (T12880)', () => {
  const API = 'https://api.nexus.test';
  const session = {
    token: 'tok_SECRET_t12880_0123456789abcdef',
    tokenType: 'Bearer',
    expiresAt: null,
    user: null,
    organization: null,
  };
  const fresh = (content: string) => {
    const location = join(
      mkdtempSync(join(tmpdir(), 'nexus-cred-t12880-')),
      'nexus-credentials.json',
    );
    writeFileSync(location, content, { mode: 0o600 });
    return { location, store: new FileNexusTokenStore(location) };
  };

  it.each([
    ['not JSON', '{"version": 1, "sessions": '],
    ['a wrong shape', '{"version": 1, "sessions": []}'],
  ])('%s is refused on read and write, and left byte-identical', async (_label, content) => {
    const { location, store } = fresh(content);
    await expect(store.get(API)).rejects.toThrow(/malformed.*left as is/);
    await expect(store.put(API, session)).rejects.toThrow(/malformed.*left as is/);
    expect(readFileSync(location, 'utf-8')).toBe(content);
  });

  it('a whitespace-only file reads as empty but a write refuses it by name, not with a raw SyntaxError (T13677)', async () => {
    const { location, store } = fresh('   \n');
    expect(await store.get(API)).toBeNull();
    await expect(store.put(API, session)).rejects.toThrow(/nexus-credentials\.json is malformed/);
    expect(readFileSync(location, 'utf-8')).toBe('   \n');
  });

  it('logout over a malformed file reports it and signs nothing out, leaving it as is (T13677)', async () => {
    const content = '{"version": 1, "sessions": []}';
    const { location, store } = fresh(content);
    const { logoutFromNexus } = await import('../nexus-auth.js');
    const out = await logoutFromNexus({ apiUrl: API, store });
    expect(out).toMatchObject({ removedLocally: false, revocation: 'skipped' });
    expect(out.warnings.join(' ')).toMatch(/malformed.*left as is/);
    expect(readFileSync(location, 'utf-8')).toBe(content);
  });

  it('a newer format is refused with an upgrade hint, and left byte-identical', async () => {
    const content = '{"version": 2, "sessions": {}, "keychain": "os"}\n';
    const { location, store } = fresh(content);
    await expect(store.list()).rejects.toThrow(/format 2, newer than the format 1.*upgrade CLEO/);
    await expect(store.delete(API)).rejects.toThrow(/format 2/);
    expect(readFileSync(location, 'utf-8')).toBe(content);
  });

  it('fields this CLEO does not know survive a rewrite', async () => {
    const { location, store } = fresh(
      JSON.stringify({
        version: 1,
        note: 'from a newer CLEO',
        sessions: {
          'https://other.nexus.test': {
            token: 'tok_other_0123456789abcdef',
            tokenType: 'Bearer',
            expiresAt: null,
            user: null,
            organization: null,
            createdAt: '2026-10-01T00:00:00.000Z',
            device: 'kept',
          },
        },
      }),
    );
    await store.put(API, session);
    const after = JSON.parse(readFileSync(location, 'utf-8')) as {
      note?: string;
      sessions: Record<string, { device?: string }>;
    };
    expect(after.note).toBe('from a newer CLEO');
    expect(after.sessions['https://other.nexus.test']?.device).toBe('kept');
    expect(Object.keys(after.sessions).sort()).toEqual([API, 'https://other.nexus.test']);
  });
});
