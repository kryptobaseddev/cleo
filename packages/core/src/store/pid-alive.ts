/**
 * No-throw pid-liveness probe, a leaf module (no imports) so low-level store
 * modules can share it without import cycles (T13258).
 *
 * @module store/pid-alive
 */

/**
 * Whether a process exists on this machine (`process.kill(pid, 0)`: signal 0
 * sends nothing), mirrors gc/daemon.ts.
 *
 * @param pid - Process id on this machine.
 * @returns `true` when the process exists (EPERM counts: it exists, not ours).
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH => no such process (dead). EPERM => process exists, not ours (alive).
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
