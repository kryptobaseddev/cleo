/**
 * Test helper: act as the owner for `CLEO_OWNER_OVERRIDE` (T13790) — a
 * session marked by `cleo session start --owner`, bound through
 * `CLEO_SESSION_ID`, on a (simulated) terminal. Tests of what an override does use this; who may override is
 * tested in `owner-override-authority.test.ts`.
 *
 * @task T13790
 */

import { randomUUID } from 'node:crypto';
import { createSession, setSessionOwnerAuthToken } from '../../store/session-store.js';
import { OWNER_SESSION_MARK } from '../owner-override-auth.js';

/**
 * Create an owner-marked session in `root`, bind it and simulate a TTY.
 *
 * @param root - Project root with an initialised store.
 * @returns A function that restores the env and TTY state.
 */
export async function actAsOwner(root: string): Promise<() => void> {
  const id = `ses_owner_${randomUUID().slice(0, 8)}`;
  await createSession(
    {
      id,
      name: id,
      status: 'active',
      scope: { type: 'global' },
      taskWork: { taskId: null, setAt: null },
      startedAt: new Date().toISOString(),
    },
    root,
  );
  const saved = {
    sid: process.env['CLEO_SESSION_ID'],
    stdin: process.stdin.isTTY,
    stderr: process.stderr.isTTY,
  };
  process.env['CLEO_SESSION_ID'] = id;
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
  // The core write path refuses the owner mark without a terminal (T13790).
  await setSessionOwnerAuthToken(id, OWNER_SESSION_MARK, root);
  return () => {
    if (saved.sid === undefined) delete process.env['CLEO_SESSION_ID'];
    else process.env['CLEO_SESSION_ID'] = saved.sid;
    Object.defineProperty(process.stdin, 'isTTY', { value: saved.stdin, configurable: true });
    Object.defineProperty(process.stderr, 'isTTY', { value: saved.stderr, configurable: true });
  };
}
