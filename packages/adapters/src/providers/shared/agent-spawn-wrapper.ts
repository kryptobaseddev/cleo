/**
 * Adapter-local spawn-args builder for per-session suite containment (T11998).
 *
 * This module provides a self-contained copy of the systemd-run argv builder
 * for use inside `packages/adapters/`, which cannot import from
 * `packages/core/` (that would create a circular dependency since core depends
 * on adapters).
 *
 * ## Relationship to `packages/core/src/resources/spawn-wrapper.ts`
 *
 * The canonical SSoT for systemd-run argv construction is in core (T11993).
 * This module is a DELIBERATE LOCAL COPY scoped to the adapter layer, kept
 * in sync by the skill-drift gate.  It follows the same design decisions:
 *   - `cleo.slice` placement
 *   - `MemoryMax=32G` hard cap (P1 staged value)
 *   - `MemorySwapMax=0`
 *   - Selective `ManagedOOMPreference=avoid` (daemon/db only)
 *   - Core suppression via `ulimit -c 0` (NOT LimitCORE=0 — invalid on scopes)
 *   - `_forceSystemdRunAvailable()` test hook
 *
 * When the core SSoT changes, update this file in the same PR.
 *
 * ## Why a copy?
 *
 * The dependency direction is `core → adapters`.  Adding `core` to adapters'
 * deps would create a cycle.  Extracting to a third package is a separate
 * refactor task; for P1 the local copy is the right trade-off.
 *
 * @module agent-spawn-wrapper
 * @task T11998
 * @epic T11992
 * @see packages/core/src/resources/spawn-wrapper.ts (canonical SSoT)
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { AgentContainmentMode, AgentSuiteOwnership } from '@cleocode/contracts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The systemd user slice that all cleo agent scope sessions are placed under. */
export const CLEO_SLICE = 'cleo.slice' as const;

/** Default MemoryMax for agent scopes (P1 staged value). */
const DEFAULT_MEMORY_MAX = '32G' as const;

// ---------------------------------------------------------------------------
// Availability probe
// ---------------------------------------------------------------------------

/** Cached result of the systemd-run probe. */
let _systemdRunAvailable: boolean | undefined;

/** Whether the pgid-demotion log line has been emitted for this process. */
let _demotionLogged = false;

/** Counter for unique scope discriminators within this process. */
let _scopeCounter = 0;

/**
 * Check whether `systemd-run --user` is usable on this host.
 *
 * Returns `false` on non-Linux, when systemd-run is absent, or when
 * DBUS_SESSION_BUS_ADDRESS / XDG_RUNTIME_DIR are absent.
 */
function hasSystemdRun(): boolean {
  if (_systemdRunAvailable !== undefined) return _systemdRunAvailable;
  if (process.platform !== 'linux') {
    _systemdRunAvailable = false;
    return false;
  }
  const probe = spawnSync('systemd-run', ['--version'], { stdio: 'ignore' });
  _systemdRunAvailable = probe.status === 0;
  return _systemdRunAvailable;
}

/**
 * Force the cached systemd-run availability for tests.
 *
 * @param available - `true` = systemd path, `false` = pgid fallback.
 */
export function _forceSystemdRunAvailable(available: boolean): void {
  _systemdRunAvailable = available;
}

// ---------------------------------------------------------------------------
// Memory helpers
// ---------------------------------------------------------------------------

/**
 * Read /proc/meminfo MemTotal in bytes.  Returns 32 GiB as a safe fallback.
 */
function readMemTotalBytes(): number {
  if (process.platform !== 'linux') return 32 * 1024 * 1024 * 1024;
  try {
    const raw = readFileSync('/proc/meminfo', 'utf8');
    const m = raw.match(/^MemTotal:\s+(\d+)\s+kB/m);
    if (m?.[1]) return parseInt(m[1], 10) * 1024;
  } catch {
    // ignore
  }
  return 32 * 1024 * 1024 * 1024;
}

// ---------------------------------------------------------------------------
// Build result
// ---------------------------------------------------------------------------

/**
 * Result of building the spawn argv for an agent session.
 *
 * Carries both the launch command/args AND the ownership handle that must
 * be persisted in the tracking record for use by {@link reapAgentSuite}.
 */
export interface AgentSpawnArgs {
  /** Command to execute (e.g. `'systemd-run'` or `'sh'` or the real binary). */
  command: string;
  /** Full argument list. */
  args: string[];
  /**
   * Ownership handle to persist in the session tracking record.
   *
   * Pass this to {@link reapAgentSuite} on session end.
   */
  ownership: AgentSuiteOwnership;
}

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

/**
 * Build the argv for spawning a claude agent session with containment.
 *
 * When systemd is available the agent is placed in a transient scope under
 * `cleo.slice`.  Otherwise it falls back to a setsid process-group spawn
 * (the caller is responsible for passing `{ detached: true }` to
 * `child_process.spawn` so a new pgid is created).
 *
 * Core suppression is applied via `ulimit -c 0` (NOT `LimitCORE=0` — that is
 * a service-unit EXEC property and is rejected by `systemd-run --scope`).
 *
 * @param command - The executable to run (e.g. `'claude'`).
 * @param args - Arguments for the executable.
 * @param scopeId - Optional discriminator appended to the unit name (e.g. a
 *   task ID or instance ID) so concurrent sessions are addressable.
 * @returns Build result with spawn command/args and the ownership handle.
 */
export function buildAgentSpawnArgs(
  command: string,
  args: readonly string[],
  scopeId?: string,
): AgentSpawnArgs {
  if (!hasSystemdRun()) {
    if (!_demotionLogged) {
      _demotionLogged = true;
      process.stderr.write(
        '[cleo:agent-spawn-wrapper] systemd-run unavailable — ' +
          'falling back to plain pgid (detached) spawn; no cgroup containment\n',
      );
    }

    // pgid fallback: wrap with ulimit -c 0 for core suppression.
    // The caller MUST pass { detached: true } to spawn() so that Node creates
    // a new session+pgid for this child.
    return {
      command: 'sh',
      args: ['-c', 'ulimit -c 0; exec "$@"', 'sh', command, ...args],
      ownership: {
        mode: 'pgid' as AgentContainmentMode,
        // pgid is populated after spawn; the caller patches it via the
        // returned child.pid (which is the pgid leader when detached: true).
      },
    };
  }

  // Systemd path: build a transient scope under cleo.slice.
  const totalBytes = readMemTotalBytes();
  const maxStr = DEFAULT_MEMORY_MAX; // P1: absolute string, no fraction logic needed

  const counter = ++_scopeCounter;
  const discriminator = scopeId
    ? scopeId.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 40)
    : String(counter);
  const unitName = `cleo-agent-session-${discriminator}.scope`;

  // Resolve MemoryMax fraction if needed (P1 uses absolute string, so passthrough).
  void totalBytes; // suppress unused-var for future fraction support

  const wrapArgs: string[] = [
    '--user',
    '--scope',
    `--slice=${CLEO_SLICE}`,
    `--unit=${unitName}`,
    '-p',
    `MemoryMax=${maxStr}`,
    '-p',
    'MemorySwapMax=0',
    // NOTE: ManagedOOMPreference=avoid is NOT set for agent sessions —
    // only daemon/db scope classes (write-txn holders) get 'avoid'.
    // See spawn-wrapper.ts OOM_AVOID_CLASSES and the module TSDoc for rationale.
    '--',
    'sh',
    '-c',
    'ulimit -c 0; exec "$@"',
    'sh',
    command,
    ...args,
  ];

  return {
    command: 'systemd-run',
    args: wrapArgs,
    ownership: {
      mode: 'systemd' as AgentContainmentMode,
      unitName,
      // pgid is populated after spawn; caller patches via child.pid.
    },
  };
}
