/**
 * Process groups of the tools this process started (T12963).
 *
 * The tool cache starts every tool detached, in its own process group, so a
 * deadline can signal the whole tree. The flip side: when cleo itself dies,
 * nothing reaches that group. A SIGKILLed `cleo verify tool:test` can leave
 * its test runner running with PPID 1, so a slot is not free just because its
 * holder pid is gone. Every slot this process holds therefore records the
 * groups started while it is held, and a slot is reaped only once both its
 * holder pid and those groups are gone.
 *
 * @task T12963
 */

const _active = new Set<number>();
const _listeners = new Set<(pgid: number, running: boolean) => void>();

/**
 * Whether `id` may ever be probed as a pid or process group: an integer above
 * 1. Never 0 (our own group), 1 (init) or a negative number (`kill(-1)`
 * reaches every process we own).
 *
 * @param id - Candidate pid or pgid.
 * @returns `true` when it is safe to probe.
 *
 * @task T12963
 */
export function isProbeableId(id: unknown): id is number {
  return typeof id === 'number' && Number.isInteger(id) && id > 1;
}

/**
 * Register a tool's process group as running. Every slot this process holds
 * is told, so its holder record lists the group. A no-op on Windows (no POSIX
 * process groups) and for an id that is not probeable.
 *
 * @param pgid - The group id: the pid of a child spawned with `detached: true`.
 * @returns Marks the group as no longer running (idempotent). Every slot this
 *   process holds is told, so its record drops the group: a finished group id
 *   that the system later reuses never keeps a dead holder's charge (T14066).
 *
 * @task T12963
 * @task T14066
 */
export function trackToolGroup(pgid: number | undefined): () => void {
  if (process.platform === 'win32' || !isProbeableId(pgid) || _active.has(pgid)) {
    return () => {};
  }
  _active.add(pgid);
  for (const listener of _listeners) listener(pgid, true);
  return () => {
    if (!_active.delete(pgid)) return;
    for (const listener of _listeners) listener(pgid, false);
  };
}

/**
 * Process groups this process started that have not finished yet.
 *
 * @returns Group ids, oldest first.
 *
 * @task T12963
 */
export function activeToolGroups(): number[] {
  return [..._active];
}

/**
 * Follow the tool groups running while a slot is held: seeded with the groups
 * already running, then `onChange` is called with the full list each time one
 * starts or finishes.
 *
 * @param onChange - Called with every group still running, after each change.
 * @returns The groups running now (kept up to date) and `stop`.
 *
 * @task T12963
 * @task T14066
 */
export function followToolGroups(onChange: (groups: readonly number[]) => void): {
  groups: readonly number[];
  stop: () => void;
} {
  const groups = activeToolGroups();
  const listener = (pgid: number, running: boolean): void => {
    const at = groups.indexOf(pgid);
    if (running === at >= 0) return;
    if (running) groups.push(pgid);
    else groups.splice(at, 1);
    onChange(groups);
  };
  _listeners.add(listener);
  return {
    groups,
    stop: () => {
      _listeners.delete(listener);
    },
  };
}

/**
 * Whether a process group still has a member, by `kill(-pgid, 0)` (signal 0
 * sends nothing).
 *
 * @param pgid - Group id.
 * @returns `gone` (ESRCH), `alive` (exists, EPERM included), or `unknown`
 *   when the id is not probeable or the probe failed some other way.
 *
 * @task T12963
 */
export function probeProcessGroup(pgid: number): 'gone' | 'alive' | 'unknown' {
  if (!isProbeableId(pgid)) return 'unknown';
  try {
    process.kill(-pgid, 0);
    return 'alive';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'gone';
    return code === 'EPERM' ? 'alive' : 'unknown';
  }
}

/**
 * Forget every tracked group and listener. Tests only.
 * @internal
 */
export function _resetToolGroupsForTest(): void {
  _active.clear();
  _listeners.clear();
}
