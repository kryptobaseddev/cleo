/**
 * Detect the legacy `cleo-mcp-reaper` host artifacts (gh#1187).
 *
 * ## What this looks for, and why it is dangerous
 *
 * During a 2026-07-01 OOM investigation a helper script and systemd user timer
 * were applied by hand to reap leaked MCP server processes. They were never
 * package-owned and appear nowhere in CLEO's git history, so no upgrade path
 * has ever removed them — they simply keep running on every host that got them.
 *
 * The helper selects victims by `/proc/PID/comm === 'MainThread'` plus an age
 * threshold. That is a **generic Node launcher comm**, not an MCP signature.
 * The npm-distributed Codex CLI has a legitimate resident launcher with exactly
 * that comm, and it deliberately forwards SIGTERM to its native child — so the
 * reaper terminates a live Codex session cleanly, with no crash and no
 * coredump, which is why it was first misdiagnosed as a Codex bug. Journal
 * correlation on 2026-08-11 paired eight Codex exits with reaper kills to the
 * second.
 *
 * No process-title hardening upstream can make `pgrep -x MainThread` safe: the
 * discriminator is wrong in principle, because comm identifies a runtime, not
 * an owner.
 *
 * CLEO's own {@link ../gc/janitor.ts | janitor} already does this correctly —
 * scope/pgid as the primary discriminator, signature plus age only for
 * unregistered processes whose stdio peers are all dead, and scope reaping
 * restricted to `cleo-*` units inside `cleo.slice`. The canonical replacement
 * exists; the problem is purely that the unsafe predecessor is still installed.
 *
 * Detection only, unless `--fix`. The helper and its journal are evidence of a
 * real incident, so the repair **disables and masks** the units rather than
 * deleting anything.
 *
 * @module
 * @task T12131
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Systemd user units the legacy fix installed. */
const LEGACY_UNITS = ['cleo-mcp-reaper.timer', 'cleo-mcp-reaper.service'] as const;

/** Helper scripts the legacy fix installed, relative to `$HOME`. */
const LEGACY_SCRIPTS = ['.local/bin/cleo-mcp-reaper.sh', '.local/bin/cleo-mcp-reaper'] as const;

/**
 * Whether a unit in this state can still fire.
 *
 * `masked` cannot start at all; `disabled` cannot be triggered by its own
 * timer. Anything else that exists is still capable of killing a live session.
 *
 * @param fileState - systemd `UnitFileState`.
 * @returns `true` when the unit remains dangerous.
 */
export function isUnitDangerous(fileState: string): boolean {
  return fileState !== 'absent' && fileState !== 'masked' && fileState !== 'disabled';
}

/** State of one legacy systemd unit. */
export interface LegacyUnitState {
  /** Unit name, e.g. `cleo-mcp-reaper.timer`. */
  readonly unit: string;
  /** `UnitFileState` — `enabled`, `disabled`, `masked`, or `absent`. */
  readonly fileState: string;
  /** `ActiveState` — `active`, `inactive`, or `absent`. */
  readonly activeState: string;
  /** `true` when this unit can still fire. */
  readonly dangerous: boolean;
}

/** Outcome of a {@link scanLegacyReaper} run. */
export interface LegacyReaperReport {
  /** Legacy systemd units found on this host. */
  readonly units: readonly LegacyUnitState[];
  /** Absolute paths of legacy helper scripts still on disk. */
  readonly scripts: readonly string[];
  /** `true` when at least one unit can still fire and kill a live session. */
  readonly armed: boolean;
  /** `true` when `--fix` ran and the units were disabled + masked. */
  readonly remediated: boolean;
  /** Operator-facing next step. */
  readonly recommendation: string;
}

/** Read one systemd user-unit property, or `absent`. */
function unitProperty(unit: string, property: string): string {
  const r = spawnSync('systemctl', ['--user', 'show', unit, '-p', property, '--value'], {
    encoding: 'utf-8',
    timeout: 5_000,
  });
  const value = (r.stdout ?? '').trim();
  return value.length > 0 ? value : 'absent';
}

/**
 * Scan the host for legacy `cleo-mcp-reaper` artifacts.
 *
 * @param opts - `fix: true` disables and masks any unit that can still fire.
 * @returns what was found, whether it is armed, and what to do next.
 *
 * @example
 * ```ts
 * const report = scanLegacyReaper();
 * if (report.armed) console.error('a live Codex session can be killed at any time');
 * ```
 *
 * @task T12131
 */
export function scanLegacyReaper(opts: { fix?: boolean } = {}): LegacyReaperReport {
  if (process.platform !== 'linux') {
    return {
      units: [],
      scripts: [],
      armed: false,
      remediated: false,
      recommendation: 'Not applicable — the legacy artifact is a systemd user timer (Linux only).',
    };
  }

  const home = homedir();
  const scripts = LEGACY_SCRIPTS.map((p) => join(home, p)).filter((p) => existsSync(p));

  const units: LegacyUnitState[] = LEGACY_UNITS.map((unit) => {
    const fileState = unitProperty(unit, 'UnitFileState');
    const activeState = unitProperty(unit, 'ActiveState');
    // Masked cannot start; disabled cannot be triggered by its own timer.
    // Anything else that exists is still capable of firing.
    const dangerous = fileState !== 'absent' && fileState !== 'masked' && fileState !== 'disabled';
    return { unit, fileState, activeState, dangerous };
  }).filter((u) => u.fileState !== 'absent');
  // Presence is decided by UnitFileState ALONE. `systemctl show` reports
  // `ActiveState=inactive` for a unit that does not exist at all, while
  // `UnitFileState` comes back empty — so keying presence off ActiveState makes
  // every clean host report two "present but inert" units and cry wolf.
  // Verified against systemd 258: a nonexistent unit yields
  // `UnitFileState=` and `ActiveState=inactive`.

  const armed = units.some((u) => u.dangerous);

  let remediated = false;
  if (opts.fix && armed) {
    for (const u of units.filter((x) => x.dangerous)) {
      spawnSync('systemctl', ['--user', 'disable', '--now', u.unit], { timeout: 15_000 });
      spawnSync('systemctl', ['--user', 'mask', u.unit], { timeout: 15_000 });
    }
    remediated = true;
  }

  return {
    units,
    scripts,
    armed,
    remediated,
    recommendation: buildRecommendation({ armed, remediated, units, scripts }),
  };
}

/**
 * Compose the operator-facing next step for a scan result.
 *
 * Exported so the decision logic — which distinguishes "armed", "inert" and
 * "clean" — is testable without a systemd host. That distinction is the whole
 * value of the check: failing on inert leftovers would train operators to
 * ignore it, and passing on an armed timer would leave live sessions killable.
 *
 * @param r - the classified scan result.
 * @returns the operator-facing next step.
 */
export function buildRecommendation(r: {
  armed: boolean;
  remediated: boolean;
  units: readonly LegacyUnitState[];
  scripts: readonly string[];
}): string {
  if (r.units.length === 0 && r.scripts.length === 0) {
    return 'Clean — no legacy cleo-mcp-reaper artifacts on this host.';
  }
  if (r.remediated) {
    return (
      'Disabled and masked. Use `cleo janitor run` instead — it discriminates by CLEO-owned ' +
      'scope/pgid, not by process comm. The helper script was left in place as evidence; ' +
      'remove it by hand once you no longer need it.'
    );
  }
  if (r.armed) {
    return (
      'ARMED — this timer can terminate any Node process whose comm is `MainThread`, including ' +
      'a live Codex CLI session. Run `cleo doctor legacy-reaper --fix`, or ' +
      '`systemctl --user disable --now cleo-mcp-reaper.timer`. Use `cleo janitor run` instead.'
    );
  }
  return (
    'Inert — the units are present but disabled or masked, so they cannot fire. No action ' +
    'required. `cleo janitor run` is the supported replacement.'
  );
}
