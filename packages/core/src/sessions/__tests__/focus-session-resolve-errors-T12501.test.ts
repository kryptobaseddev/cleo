/**
 * `resolveFocusSessionId` reports a store FAULT as a fault, not as "unbound"
 * (T12501 review). Only "no session can exist here" — no store at the path, or
 * a store without the session / binding tables — resolves to `null`.
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

  it("treats an ENOENT under the project's own .cleo store as unbound", async () => {
    resolveBoundSessionId.mockRejectedValue(
      Object.assign(new Error("ENOENT: no such file or directory, mkdir '/p/.cleo'"), {
        code: 'ENOENT',
        path: '/p/.cleo',
      }),
    );
    await expect(resolveFocusSessionId('/p')).resolves.toBeNull();
    resolveBoundSessionId.mockRejectedValue(
      Object.assign(new Error('ENOENT: open /p/.cleo/cleo.db'), {
        code: 'ENOENT',
        path: '/p/.cleo/cleo.db',
      }),
    );
    await expect(resolveFocusSessionId('/p')).resolves.toBeNull();
  });

  it('rethrows any other ENOENT (outside <cwd>/.cleo, or with no path)', async () => {
    resolveBoundSessionId.mockRejectedValue(
      Object.assign(new Error('ENOENT: open /home/u/.local/share/cleo/cleo.db'), {
        code: 'ENOENT',
        path: '/home/u/.local/share/cleo/cleo.db',
      }),
    );
    await expect(resolveFocusSessionId('/p')).rejects.toThrow('/home/u/.local/share/cleo');
    // A sibling whose name merely starts with ".cleo" is not the store.
    resolveBoundSessionId.mockRejectedValue(
      Object.assign(new Error('ENOENT: /p/.cleo-backup'), {
        code: 'ENOENT',
        path: '/p/.cleo-backup',
      }),
    );
    await expect(resolveFocusSessionId('/p')).rejects.toThrow('.cleo-backup');
    resolveBoundSessionId.mockRejectedValue(
      Object.assign(new Error('ENOENT: spawn ps'), { code: 'ENOENT' }),
    );
    await expect(resolveFocusSessionId('/p')).rejects.toThrow('spawn ps');
  });

  it('returns the bound session id', async () => {
    resolveBoundSessionId.mockResolvedValue('ses_20260930000000_e5e5e5');
    await expect(resolveFocusSessionId('/p')).resolves.toBe('ses_20260930000000_e5e5e5');
  });
});
