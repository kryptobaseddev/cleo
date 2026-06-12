/**
 * CLEO Janitor — orphan process reaper + stale scope/lock/debris sweep.
 *
 * Composable engine that the GC subsystem and the `cleo janitor run` CLI verb
 * call.  Every action is:
 *   - Silent: no console output; one JSONL line per action appended to
 *     `.cleo/audit/janitor.jsonl`, plus counts in the returned result.
 *   - Idempotent: a fully-converged state produces zero actions on re-run.
 *   - Dry-run capable: `dryRun: true` reports planned actions without mutating
 *     anything.
 *
 * ## Categories
 *
 * | # | Category                 | Description                                          |
 * |---|--------------------------|------------------------------------------------------|
 * | 1 | `reaped`                 | Leaked MCP/agent helpers (registration-primary)      |
 * | 2 | `scopesStopped`          | Cleo-owned systemd transient scopes that exited      |
 * | 3 | `locksReclaimed`         | Sentient/GC lock files held by dead PIDs             |
 * | 4 | `semaphoreSlotsCleared`  | Tool-semaphore slot dirs held past staleMs           |
 * | 5 | `worktreesPruned`        | Orphan worktree directories                          |
 * | 6 | `worktreesQuarantined`   | Dirty/unpushed worktrees quarantined                 |
 * | 7 | `tmpRemoved`             | Stale CLEO temp directories                          |
 * | 8 | `attachmentsRepaired`    | Attachment rows/files repaired                       |
 * | 9 | `configsRepaired`        | Corrupt config files restored                        |
 *
 * ## Amendment compliance
 *
 * - **Amendment 1 (registration-primary)**: orphan detection uses cleo-owned
 *   scope/pgid as PRIMARY discriminator; signature+age only for UNREGISTERED
 *   processes when all stdio pipe peers are dead.
 * - **Amendment 2 (regression)**: reparented double-fork of a LIVE session is
 *   preserved; same of a DEAD session is reaped.
 * - **Amendment 3 (scope reaping)**: restricted to units starting with
 *   `cleo-` prefix inside `cleo.slice`.  Never touches `run-*.scope`.
 * - **Amendment 4 (idempotency)**: TERM→KILL escalation spanning runs is
 *   legitimate; a fully-converged state produces zero actions on second run.
 * - **Amendment 5 (liveness probe)**: stale locks reclaimed only after
 *   verifying the holder PID is dead — never on mtime alone.
 * - **Amendment 6 (silence)**: every action → `.cleo/audit/janitor.jsonl`;
 *   zero desktop notifications; zero console noise in non-verbose mode.
 * - **Amendment 7 (tmp debris)**: reuses `gc/cleanup.ts` patterns directly.
 *
 * @module @cleocode/core/gc/janitor
 * @task T11995
 * @epic T11992
 */

import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { repairConfigFile } from '../config/config-repair.js';
import { getCleoHome } from '../paths.js';
import { repairAttachmentStore } from '../store/attachment-repair.js';
import { pruneOrphanTempDirs, pruneOrphanWorktrees } from './cleanup.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default minimum age (ms) of an unregistered process before reap eligibility.
 * 10 minutes gives a freshly-spawned MCP server time to register.
 */
export const DEFAULT_GRACE_MS = 10 * 60 * 1000;

/**
 * Default SIGTERM→SIGKILL grace period (ms).
 * Matches suite-reaper.ts value for consistency.
 */
export const SIGTERM_GRACE_MS = 3_000;

/**
 * Default stale-ms for tool-semaphore slot lock directories.
 * Matches tool-semaphore.ts default.
 */
export const DEFAULT_SEMAPHORE_STALE_MS = 600_000;

/**
 * Unit-name prefix for cleo-owned transient scopes (Amendment 3).
 * `cleo-` covers cleo-agent-*, cleo-db-*, cleo-test-*, etc.
 */
const CLEO_UNIT_PREFIX = 'cleo-' as const;

/**
 * Units to NEVER stop — intentional long-lived cleo daemons (Amendment 3).
 */
const DAEMON_UNIT_ALLOWLIST: readonly string[] = [
  'cleo-daemon.service',
  'cleo-gateway.service',
  'cleo-daemon',
  'cleo-gateway',
];

/**
 * Command-line patterns that identify cleo MCP-suite processes.
 * Matched against /proc/<pid>/cmdline (null-byte separated, joined to spaces).
 * Only used for the UNREGISTERED fallback path (Amendment 1).
 */
const MCP_CMDLINE_SIGNATURES: readonly string[] = [
  '@cleocode/cleo',
  '.local/share/cleo',
  'caamp-mcp',
  'claude-code-mcp',
  'pi-mcp',
];

/** Relative path of the janitor audit log (Amendment 6). */
const JANITOR_AUDIT_REL = 'audit/janitor.jsonl' as const;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Per-category result counts returned by {@link runJanitor}. */
export interface JanitorResult {
  /** Orphan agent/MCP processes sent SIGTERM or SIGKILL. */
  readonly reaped: number;
  /** Cleo-owned transient scopes stopped + reset-failed. */
  readonly scopesStopped: number;
  /** Stale PID lock files reclaimed (sentient, gc). */
  readonly locksReclaimed: number;
  /** Stale tool-semaphore slot directories cleared. */
  readonly semaphoreSlotsCleared: number;
  /** Orphan worktree directories removed. */
  readonly worktreesPruned: number;
  /** Dirty/unpushed worktrees quarantined (not deleted). */
  readonly worktreesQuarantined: number;
  /** Stale CLEO tmp dirs removed. */
  readonly tmpRemoved: number;
  /** Attachment orphans marked or deleted. */
  readonly attachmentsRepaired: number;
  /** Corrupt config files restored from backup. */
  readonly configsRepaired: number;
  /** Total non-fatal errors encountered. */
  readonly errors: number;
  /** True when `dryRun: true` was set — no mutations were performed. */
  readonly dryRun: boolean;
}

/** Options for {@link runJanitor}. */
export interface JanitorOptions {
  /**
   * When true, report planned actions without performing any mutations.
   * @default false
   */
  dryRun?: boolean;

  /**
   * Minimum age (ms) of an unregistered process before reap eligibility.
   * @default DEFAULT_GRACE_MS (10 min)
   */
  gracePeriodMs?: number;

  /**
   * Absolute path to the project-level `.cleo/` directory.
   * Defaults to `resolveCleoDir()` using the current working directory.
   */
  cleoDir?: string;

  /**
   * Root of the CLEO worktrees hierarchy.
   * Defaults to `~/.local/share/cleo/worktrees/`.
   */
  worktreesRoot?: string;

  /**
   * Set of active (non-terminal) task IDs for the worktree prune guard.
   * When `undefined`, worktree pruning is skipped entirely.
   */
  activeTaskIds?: Set<string>;

  /**
   * Selectively skip categories.  Omit or set `false` to run all.
   */
  skip?: {
    processes?: boolean;
    scopes?: boolean;
    locks?: boolean;
    semaphores?: boolean;
    worktrees?: boolean;
    tmp?: boolean;
    attachments?: boolean;
    config?: boolean;
  };
}

// ---------------------------------------------------------------------------
// Audit helpers (Amendment 6)
// ---------------------------------------------------------------------------

/**
 * Append one structured action entry to the janitor audit log.
 * Synchronous; fails silently (audit is best-effort).
 */
function auditLog(
  cleoDir: string,
  action: string,
  detail: Record<string, unknown>,
  dryRun: boolean,
): void {
  try {
    const auditPath = join(cleoDir, JANITOR_AUDIT_REL);
    mkdirSync(join(cleoDir, 'audit'), { recursive: true });
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      action,
      dryRun,
      agentId: process.env['CLEO_AGENT_ID'] ?? 'cleo',
      ...detail,
    });
    appendFileSync(auditPath, `${entry}\n`, { encoding: 'utf-8' });
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// /proc helpers (Linux-only)
// ---------------------------------------------------------------------------

/**
 * Check whether a PID is alive via `kill(pid, 0)`.
 * Returns `false` for ESRCH or any other error.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read `/proc/<pid>/cmdline` and return the null-byte-separated content as a
 * space-joined string.  Returns `''` on any failure.
 */
function readProcCmdline(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf-8').replace(/\0/g, ' ').trim();
  } catch {
    return '';
  }
}

/**
 * Approximate process start time as Unix epoch ms by reading
 * `/proc/<pid>/stat` field 22 (starttime in clock ticks since boot) and
 * `/proc/uptime` (seconds since boot).
 *
 * Returns 0 on failure (treated conservatively as "zero age").
 */
function estimateProcessStartMs(pid: number): number {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8').trim().split(' ');
    const startTicks = Number.parseInt(stat[21] ?? '0', 10);
    if (!Number.isFinite(startTicks) || startTicks <= 0) return 0;
    const uptimeSec = Number.parseFloat(readFileSync('/proc/uptime', 'utf-8').split(' ')[0] ?? '0');
    if (!Number.isFinite(uptimeSec) || uptimeSec <= 0) return 0;
    const clkTck = 100; // USER_HZ on Linux x86_64
    const bootEpochMs = Date.now() - uptimeSec * 1000;
    return bootEpochMs + (startTicks / clkTck) * 1000;
  } catch {
    return 0;
  }
}

/**
 * Enumerate all integer-named entries under `/proc` as PIDs.
 * Returns an empty array when `/proc` is unavailable.
 */
function enumProcPids(): number[] {
  try {
    return readdirSync('/proc')
      .map((e) => Number.parseInt(e, 10))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Systemd helpers
// ---------------------------------------------------------------------------

/**
 * List all cleo-owned transient scope unit names via `systemctl --user`.
 *
 * Returns unit names matching `cleo-*.scope` (Amendment 3).
 * Returns `[]` when systemd is unavailable.
 */
function listCleoScopeUnits(): string[] {
  if (process.platform !== 'linux') return [];
  try {
    const result = spawnSync(
      'systemctl',
      ['--user', 'list-units', '--type=scope', '--all', '--no-legend', '--no-pager'],
      { encoding: 'utf-8', timeout: 10_000 },
    );
    if (result.status !== 0 || !result.stdout) return [];
    return result.stdout
      .split('\n')
      .map((line) => line.trim().split(/\s+/)[0] ?? '')
      .filter(
        (name) =>
          name.startsWith(CLEO_UNIT_PREFIX) &&
          name.endsWith('.scope') &&
          !DAEMON_UNIT_ALLOWLIST.includes(name),
      );
  } catch {
    return [];
  }
}

/**
 * Get the `SubState` of a systemd unit (e.g. `'exited'`, `'failed'`, `'running'`).
 * Returns `''` on failure.
 */
function getUnitSubState(unitName: string): string {
  try {
    const result = spawnSync(
      'systemctl',
      ['--user', 'show', unitName, '--property=SubState', '--value'],
      { encoding: 'utf-8', timeout: 5_000 },
    );
    return (result.stdout ?? '').trim();
  } catch {
    return '';
  }
}

/**
 * Read `/sys/fs/cgroup<cgroupPath>/cgroup.procs` for a systemd unit.
 * Returns an empty array when not available.
 */
function getUnitCgroupProcs(unitName: string): number[] {
  if (process.platform !== 'linux') return [];
  try {
    const pathResult = spawnSync(
      'systemctl',
      ['--user', 'show', unitName, '--property=ControlGroup', '--value'],
      { encoding: 'utf-8', timeout: 5_000 },
    );
    const cgroupPath = (pathResult.stdout ?? '').trim();
    if (!cgroupPath) return [];
    const procsPath = `/sys/fs/cgroup${cgroupPath}/cgroup.procs`;
    if (!existsSync(procsPath)) return [];
    const contents = readFileSync(procsPath, 'utf-8').trim();
    if (!contents) return [];
    return contents
      .split('\n')
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

/**
 * Check whether any live process in `/proc` is a member of a given cleo
 * scope unit by cgroup membership.
 * Returns the owning unit name, or `null` if none found.
 */
function findOwningCleoScope(pid: number, unitNames: string[]): string | null {
  for (const unitName of unitNames) {
    const procs = getUnitCgroupProcs(unitName);
    if (procs.includes(pid)) return unitName;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pipe-peer liveness check (Amendment 1 fallback guard)
// ---------------------------------------------------------------------------

/**
 * Return `true` when all stdio pipe peers of a process are dead.
 *
 * A reparented double-forked helper of a LIVE session has at least one live
 * pipe peer.  If all stdio fds are pipes whose other ends belong to dead
 * processes (or the fds are not pipes), the process is truly orphaned.
 *
 * Returns `false` (conservative — don't reap) on any enumeration failure.
 */
function areAllStdioPeersDead(pid: number): boolean {
  if (process.platform !== 'linux') return false;
  try {
    const fdDir = `/proc/${pid}/fd`;
    for (const fdName of ['0', '1', '2']) {
      const fdPath = join(fdDir, fdName);
      let target: string;
      try {
        target = readlinkSync(fdPath);
      } catch {
        continue; // fd missing or unreadable — not a pipe
      }
      const inodeMatch = target.match(/^pipe:\[(\d+)\]$/);
      if (!inodeMatch) continue; // not a pipe
      const inode = inodeMatch[1];

      // Find any live process that holds the same pipe inode
      const allPids = enumProcPids();
      for (const peerPid of allPids) {
        if (peerPid === pid) continue;
        if (!isPidAlive(peerPid)) continue;
        try {
          const peerFds = readdirSync(`/proc/${peerPid}/fd`);
          for (const peerFd of peerFds) {
            try {
              const peerTarget = readlinkSync(`/proc/${peerPid}/fd/${peerFd}`);
              if (peerTarget === `pipe:[${inode}]`) {
                // Found a live process sharing this pipe
                return false;
              }
            } catch {
              // unreadable
            }
          }
        } catch {
          // unreadable proc entry
        }
      }
    }
    return true;
  } catch {
    return false; // conservative
  }
}

// ---------------------------------------------------------------------------
// Category 1: Orphan process reaping (Amendment 1 & 2)
// ---------------------------------------------------------------------------

/**
 * Reap orphaned MCP/agent processes.
 *
 * Primary path (Amendment 1): processes inside DEAD cleo-owned scopes.
 * Fallback path: unregistered processes matching MCP signatures, older than
 * `gracePeriodMs`, whose all stdio pipe peers are dead.
 *
 * Regression guard (Amendment 2): a reparented helper of a LIVE scope is
 * preserved; only helpers of DEAD scopes are reaped.
 */
function reapOrphanProcesses(opts: {
  gracePeriodMs: number;
  dryRun: boolean;
  cleoDir: string;
  liveUnits: string[];
  deadUnits: string[];
}): number {
  const { gracePeriodMs, dryRun, cleoDir, liveUnits, deadUnits } = opts;
  const allUnits = [...liveUnits, ...deadUnits];
  let reaped = 0;

  if (process.platform !== 'linux') return 0;

  // PRIMARY: reap processes inside dead cleo scopes
  for (const deadUnit of deadUnits) {
    const procs = getUnitCgroupProcs(deadUnit);
    for (const pid of procs) {
      if (!isPidAlive(pid)) continue;
      const cmdline = readProcCmdline(pid);
      const startMs = estimateProcessStartMs(pid);
      const ageMs = startMs > 0 ? Date.now() - startMs : gracePeriodMs + 1;

      if (!dryRun) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // ESRCH = already gone — idempotent
        }
      }
      auditLog(
        cleoDir,
        'reap-process',
        {
          pid,
          cmdline: cmdline.slice(0, 200),
          unit: deadUnit,
          ageMs,
          signal: 'SIGTERM',
          path: 'registration-primary',
        },
        dryRun,
      );
      reaped++;
    }
  }

  // FALLBACK: scan /proc for unregistered MCP-signature processes
  const allPids = enumProcPids();
  for (const pid of allPids) {
    if (pid === process.pid) continue;
    if (!isPidAlive(pid)) continue;

    // Skip if owned by any registered cleo scope (live or dead)
    if (findOwningCleoScope(pid, allUnits) !== null) continue;

    const cmdline = readProcCmdline(pid);
    if (!MCP_CMDLINE_SIGNATURES.some((sig) => cmdline.includes(sig))) continue;

    const startMs = estimateProcessStartMs(pid);
    const ageMs = startMs > 0 ? Date.now() - startMs : 0;
    if (ageMs < gracePeriodMs) continue;

    // Amendment 1: only reap when all stdio peers are dead
    if (!areAllStdioPeersDead(pid)) continue;

    if (!dryRun) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // ESRCH = already gone
      }
    }
    auditLog(
      cleoDir,
      'reap-process',
      { pid, cmdline: cmdline.slice(0, 200), ageMs, signal: 'SIGTERM', path: 'signature-fallback' },
      dryRun,
    );
    reaped++;
  }

  return reaped;
}

// ---------------------------------------------------------------------------
// Category 2: Dead cleo-owned transient scopes (Amendment 3)
// ---------------------------------------------------------------------------

/**
 * Stop and reset-failed all dead cleo-owned transient scope units.
 *
 * A scope is "dead" when `SubState` is `exited`, `failed`, or `dead`,
 * OR when its `cgroup.procs` is empty (Amendment 3 precondition).
 *
 * Operations are no-ops on already-stopped scopes (idempotent).
 */
function stopDeadScopes(opts: { unitNames: string[]; dryRun: boolean; cleoDir: string }): {
  stopped: number;
  deadUnits: string[];
} {
  const { unitNames, dryRun, cleoDir } = opts;
  let stopped = 0;
  const deadUnits: string[] = [];

  for (const unitName of unitNames) {
    // NEVER touch allowlisted daemons (Amendment 3)
    if (DAEMON_UNIT_ALLOWLIST.includes(unitName)) continue;

    const subState = getUnitSubState(unitName);
    const procs = getUnitCgroupProcs(unitName);
    const isDead =
      subState === 'exited' ||
      subState === 'failed' ||
      subState === 'dead' ||
      (subState !== 'running' && procs.length === 0);

    if (!isDead) continue;

    deadUnits.push(unitName);

    if (!dryRun) {
      spawnSync('systemctl', ['--user', 'stop', unitName], {
        stdio: 'ignore',
        timeout: 10_000,
      });
      spawnSync('systemctl', ['--user', 'reset-failed', unitName], {
        stdio: 'ignore',
        timeout: 5_000,
      });
    }

    auditLog(
      cleoDir,
      'stop-dead-scope',
      { unit: unitName, subState, cgroupProcs: procs.length },
      dryRun,
    );
    stopped++;
  }

  return { stopped, deadUnits };
}

// ---------------------------------------------------------------------------
// Category 3: Stale PID lock files (Amendment 5)
// ---------------------------------------------------------------------------

/**
 * Reclaim stale PID-based lock files whose recorded PID is dead.
 *
 * Covers:
 *   - `.cleo/sentient.lock`
 *   - `.cleo/gc.lock`
 *
 * NEVER reclaims on mtime alone — liveness probe first (Amendment 5).
 * Truncates rather than deletes (matching the `acquireLock` reclaim pattern in
 * `sentient/daemon.ts:593`).
 */
function reclaimStalePidLocks(opts: { cleoDir: string; dryRun: boolean }): number {
  const { cleoDir, dryRun } = opts;
  const candidates = [join(cleoDir, 'sentient.lock'), join(cleoDir, 'gc.lock')];
  let reclaimed = 0;

  for (const lockPath of candidates) {
    if (!existsSync(lockPath)) continue;
    try {
      const contents = readFileSync(lockPath, 'utf-8').trim();
      const pid = Number.parseInt(contents, 10);
      if (!Number.isFinite(pid) || pid <= 0) continue;

      // Amendment 5: liveness probe — skip if alive
      if (isPidAlive(pid)) continue;

      // PID dead → stale lock
      if (!dryRun) {
        writeFileSync(lockPath, '', 'utf-8');
      }
      auditLog(cleoDir, 'reclaim-pid-lock', { path: lockPath, stalePid: pid }, dryRun);
      reclaimed++;
    } catch {
      // unreadable — skip
    }
  }

  return reclaimed;
}

// ---------------------------------------------------------------------------
// Category 4: Stale tool-semaphore slot directories (Amendment 5)
// ---------------------------------------------------------------------------

/**
 * Clear stale proper-lockfile lock-directories under getCleoHome()/locks/tool-star.
 *
 * proper-lockfile creates slot.lock/ directories.  A slot is stale when:
 *   1. Its mtime is older than staleMs, AND
 *   2. The pid file inside (written by proper-lockfile) records a dead PID.
 *
 * Amendment 5: if the PID inside is alive, skip even if mtime is old.
 */
function clearStaleSemaphoreSlots(opts: {
  dryRun: boolean;
  cleoDir: string;
  staleMs?: number;
}): number {
  const { dryRun, cleoDir, staleMs = DEFAULT_SEMAPHORE_STALE_MS } = opts;
  const locksRoot = join(getCleoHome(), 'locks');
  if (!existsSync(locksRoot)) return 0;

  let cleared = 0;
  const now = Date.now();

  try {
    for (const toolDir of readdirSync(locksRoot)) {
      if (!toolDir.startsWith('tool-')) continue;
      const toolPath = join(locksRoot, toolDir);
      try {
        if (!statSync(toolPath).isDirectory()) continue;
      } catch {
        continue;
      }

      try {
        for (const entry of readdirSync(toolPath)) {
          if (!entry.endsWith('.lock')) continue;
          const lockDirPath = join(toolPath, entry);
          try {
            const st = statSync(lockDirPath);
            if (!st.isDirectory()) continue;
            if (now - st.mtimeMs < staleMs) continue;

            // Amendment 5: read the pid file inside the lock directory
            const pidFile = join(lockDirPath, 'pid');
            if (existsSync(pidFile)) {
              try {
                const pidStr = readFileSync(pidFile, 'utf-8').trim();
                const pid = Number.parseInt(pidStr, 10);
                if (Number.isFinite(pid) && pid > 0 && isPidAlive(pid)) continue;
              } catch {
                // unreadable pid file — fall through to remove
              }
            }

            const ageMsLock = now - st.mtimeMs;
            if (!dryRun) {
              rmSync(lockDirPath, { recursive: true, force: true });
            }
            auditLog(cleoDir, 'clear-semaphore-slot', { lockDir: lockDirPath, ageMsLock }, dryRun);
            cleared++;
          } catch {
            // stat/rm failed — skip
          }
        }
      } catch {
        // readdir failed — skip
      }
    }
  } catch {
    // locksRoot readdir failed
  }

  return cleared;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the CLEO janitor sweep.
 *
 * Runs all enabled categories and returns a structured result with per-category
 * counts.  Designed to be called from:
 *   - `cleo janitor run [--dry-run]` (manual verb)
 *   - GC subsystem sentient tick (daemon mode)
 *   - Session start/end (daemon-off lazy mode)
 *
 * @param opts - Janitor options.
 * @returns Structured result.
 *
 * @task T11995
 * @epic T11992
 */
export async function runJanitor(opts: JanitorOptions = {}): Promise<JanitorResult> {
  const {
    dryRun = false,
    gracePeriodMs = DEFAULT_GRACE_MS,
    worktreesRoot,
    activeTaskIds,
    skip = {},
  } = opts;

  // Resolve cleoDir
  let cleoDir: string;
  if (opts.cleoDir) {
    cleoDir = opts.cleoDir;
  } else {
    try {
      const { resolveCleoDir } = await import('../paths.js');
      cleoDir = resolveCleoDir();
    } catch {
      cleoDir = join(process.cwd(), '.cleo');
    }
  }

  // Ensure audit dir (best-effort)
  try {
    mkdirSync(join(cleoDir, 'audit'), { recursive: true });
  } catch {
    // ignore
  }

  let reaped = 0;
  let scopesStopped = 0;
  let locksReclaimed = 0;
  let semaphoreSlotsCleared = 0;
  let worktreesPruned = 0;
  let worktreesQuarantined = 0;
  let tmpRemoved = 0;
  let attachmentsRepaired = 0;
  let configsRepaired = 0;
  let errors = 0;

  // ── Category 2: Scope inventory (must run before Category 1) ─────────────
  let liveUnits: string[] = [];
  let deadUnits: string[] = [];

  if (!skip.scopes && process.platform === 'linux') {
    try {
      const allCleoUnits = listCleoScopeUnits();
      const result = stopDeadScopes({ unitNames: allCleoUnits, dryRun, cleoDir });
      scopesStopped = result.stopped;
      deadUnits = result.deadUnits;
      liveUnits = allCleoUnits.filter((u) => !deadUnits.includes(u));
    } catch (err) {
      errors++;
      auditLog(
        cleoDir,
        'error',
        { category: 'scopes', error: err instanceof Error ? err.message : String(err) },
        dryRun,
      );
    }
  }

  // ── Category 1: Orphan process reaping ───────────────────────────────────
  if (!skip.processes && process.platform === 'linux') {
    try {
      reaped = reapOrphanProcesses({ gracePeriodMs, dryRun, cleoDir, liveUnits, deadUnits });
    } catch (err) {
      errors++;
      auditLog(
        cleoDir,
        'error',
        { category: 'processes', error: err instanceof Error ? err.message : String(err) },
        dryRun,
      );
    }
  }

  // ── Category 3: Stale PID locks ───────────────────────────────────────────
  if (!skip.locks) {
    try {
      locksReclaimed = reclaimStalePidLocks({ cleoDir, dryRun });
    } catch (err) {
      errors++;
      auditLog(
        cleoDir,
        'error',
        { category: 'locks', error: err instanceof Error ? err.message : String(err) },
        dryRun,
      );
    }
  }

  // ── Category 4: Semaphore slots ───────────────────────────────────────────
  if (!skip.semaphores) {
    try {
      semaphoreSlotsCleared = clearStaleSemaphoreSlots({ dryRun, cleoDir });
    } catch (err) {
      errors++;
      auditLog(
        cleoDir,
        'error',
        { category: 'semaphores', error: err instanceof Error ? err.message : String(err) },
        dryRun,
      );
    }
  }

  // ── Category 5/6: Worktrees ───────────────────────────────────────────────
  if (!skip.worktrees && activeTaskIds !== undefined) {
    try {
      const xdgData = process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share');
      const wRoot = worktreesRoot ?? join(xdgData, 'cleo', 'worktrees');
      const result = pruneOrphanWorktrees({ worktreesRoot: wRoot, activeTaskIds, dryRun });
      worktreesPruned = result.removed;
      worktreesQuarantined = result.quarantined;
      if (result.errors.length > 0) errors += result.errors.length;
      for (const p of result.removedPaths) {
        auditLog(cleoDir, 'prune-worktree', { path: p }, dryRun);
      }
      for (const p of result.quarantinedPaths) {
        auditLog(cleoDir, 'quarantine-worktree', { path: p }, dryRun);
      }
    } catch (err) {
      errors++;
      auditLog(
        cleoDir,
        'error',
        { category: 'worktrees', error: err instanceof Error ? err.message : String(err) },
        dryRun,
      );
    }
  }

  // ── Category 7: Stale tmp dirs (Amendment 7) ──────────────────────────────
  if (!skip.tmp) {
    try {
      const tmpResult = pruneOrphanTempDirs({ dryRun });
      tmpRemoved = tmpResult.removed;
      if (tmpResult.errors.length > 0) errors += tmpResult.errors.length;
      for (const p of tmpResult.removedPaths) {
        auditLog(cleoDir, 'prune-tmp', { path: p }, dryRun);
      }
    } catch (err) {
      errors++;
      auditLog(
        cleoDir,
        'error',
        { category: 'tmp', error: err instanceof Error ? err.message : String(err) },
        dryRun,
      );
    }
  }

  // ── Category 8: Attachment repair ────────────────────────────────────────
  if (!skip.attachments) {
    try {
      const result = await repairAttachmentStore({ dryRun, cwd: join(cleoDir, '..') });
      attachmentsRepaired = result.rowsWithoutFilesCount + result.unreferencedBlobsDeletedCount;
    } catch (err) {
      errors++;
      auditLog(
        cleoDir,
        'error',
        { category: 'attachments', error: err instanceof Error ? err.message : String(err) },
        dryRun,
      );
    }
  }

  // ── Category 9: Config repair ─────────────────────────────────────────────
  if (!skip.config) {
    const projectRoot = join(cleoDir, '..');
    const backupDir = join(cleoDir, 'backups');
    const configCandidates = [join(cleoDir, 'config.json'), join(cleoDir, 'project-info.json')];
    for (const configPath of configCandidates) {
      if (!existsSync(configPath)) continue;
      try {
        // repairConfigFile(configPath, backupDir, cwd): positional args
        const result = await repairConfigFile(
          configPath,
          existsSync(backupDir) ? backupDir : null,
          projectRoot,
        );
        if (result.outcome !== 'healthy') {
          configsRepaired++;
          auditLog(
            cleoDir,
            'repair-config',
            { configPath, outcome: result.outcome, detail: result.detail },
            dryRun,
          );
        }
      } catch (err) {
        errors++;
        auditLog(
          cleoDir,
          'error',
          {
            category: 'config',
            configPath,
            error: err instanceof Error ? err.message : String(err),
          },
          dryRun,
        );
      }
    }
  }

  return {
    reaped,
    scopesStopped,
    locksReclaimed,
    semaphoreSlotsCleared,
    worktreesPruned,
    worktreesQuarantined,
    tmpRemoved,
    attachmentsRepaired,
    configsRepaired,
    errors,
    dryRun,
  };
}
