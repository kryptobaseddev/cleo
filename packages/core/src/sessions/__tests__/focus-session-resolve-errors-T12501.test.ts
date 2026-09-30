/**
 * `resolveFocusSessionId` reports a store FAULT as a fault, not as "unbound"
 * (T12501 review). Only a store without the session / binding tables resolves
 * to `null` here; an ABSENT store is `null` before anything is opened (see
 * focus-session-no-store-T12501.test.ts).
 *
 * @task T12501
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const resolveBoundSessionId = vi.fn<(cwd?: string) => Promise<string | null>>();
vi.mock('../../store/session-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/session-store.js')>();
  return { ...actual, resolveBoundSessionId };
});

import { resolveFocusSessionId } from '../focus-state-store.js';

afterEach(() => {
  resolveBoundSessionId.mockReset();
});

describe('resolveFocusSessionId error handling (T12501)', () => {
  it('rethrows a real store fault', async () => {
    resolveBoundSessionId.mockRejectedValue(new Error('disk I/O error'));
    await expect(resolveFocusSessionId('/p')).rejects.toThrow('disk I/O error');
  });

  it('treats a missing session table (wrapped by drizzle) as unbound', async () => {
    resolveBoundSessionId.mockRejectedValue(
      new Error('Failed query', { cause: new Error('no such table: tasks_sessions') }),
    );
    await expect(resolveFocusSessionId('/p')).resolves.toBeNull();
  });

  it('rethrows ENOENT / EACCES: an absent store never reaches the open, so they are real faults', async () => {
    for (const [code, path] of [
      ['ENOENT', '/p/.cleo/cleo.db'],
      ['ENOENT', '/home/u/.local/share/cleo/cleo.db'],
      ['EACCES', '/p/.cleo'],
    ] as const) {
      resolveBoundSessionId.mockRejectedValue(
        Object.assign(new Error(`${code}: ${path}`), { code, path }),
      );
      await expect(resolveFocusSessionId('/p')).rejects.toThrow(path);
    }
  });

  it('returns the bound session id', async () => {
    resolveBoundSessionId.mockResolvedValue('ses_20260930000000_e5e5e5');
    await expect(resolveFocusSessionId('/p')).resolves.toBe('ses_20260930000000_e5e5e5');
  });
});
