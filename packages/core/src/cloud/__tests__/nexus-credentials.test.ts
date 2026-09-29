/**
 * FileNexusTokenStore seed race (T12712 review item 6): a symlink planted
 * after the symlink check but before the store file is created must not be
 * followed. `lstatSync` is made blind for the test so the planted link slips
 * past the check, exactly as it would inside the TOCTOU window.
 *
 * @task T12712
 */

import { existsSync, mkdtempSync, symlinkSync } from 'node:fs';
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
