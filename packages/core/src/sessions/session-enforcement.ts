/**
 * Session enforcement - require active sessions for write operations.
 *
 * Part of the Epic-Bound Session architecture. Enforces that write operations
 * (add, update, complete) require an active session.
 *
 * @task T4454
 * @epic T4454
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import { CleoError } from '../errors.js';
import { pushWarning } from '../output.js';
import { getCleoDir } from '../paths.js';
import { sessionStatus } from './index.js';

/** Synchronous config value reader. */
function readConfigValueSync(path: string, defaultValue: unknown, cwd?: string): unknown {
  try {
    const configPath = join(getCleoDir(cwd), 'config.json');
    if (!existsSync(configPath)) return defaultValue;
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    const keys = path.split('.');
    let value: unknown = config;
    for (const key of keys) {
      if (value == null || typeof value !== 'object') return defaultValue;
      value = (value as Record<string, unknown>)[key];
    }
    return value ?? defaultValue;
  } catch {
    return defaultValue;
  }
}

/** Enforcement modes. */
export type EnforcementMode = 'strict' | 'warn' | 'none';

/** Get the current enforcement mode. */
export function getEnforcementMode(cwd?: string): EnforcementMode {
  // CLEO_TEST_MODE disables enforcement in vitest — tests validate enforcement
  // logic directly via unit tests, not via side effects during data setup.
  if (process.env.VITEST) return 'none';

  try {
    const requiredForMutate = readConfigValueSync(
      'enforcement.session.requiredForMutate',
      true,
      cwd,
    );
    if (requiredForMutate === false) return 'none';

    // Legacy mode fallback from config
    const mode = readConfigValueSync('session.enforcement', 'strict', cwd) as string;
    if (mode === 'strict' || mode === 'warn' || mode === 'none') return mode;
    return 'strict'; // Default
  } catch {
    return 'strict';
  }
}

/** Check if session enforcement is enabled. */
export function isSessionEnforcementEnabled(cwd?: string): boolean {
  return getEnforcementMode(cwd) !== 'none';
}

/** Session info for enforcement checks. */
export interface ActiveSessionInfo {
  id: string;
  name: string;
  scope: { type: string; epicId?: string };
}

/** Get active session info. Returns null if no active session. */
export async function getActiveSessionInfo(cwd?: string): Promise<ActiveSessionInfo | null> {
  const session = await sessionStatus(cwd ?? '', {});
  if (!session) return null;

  return {
    id: session.id,
    name: session.name,
    scope: session.scope,
  };
}

/** Enforcement result. */
export interface EnforcementResult {
  allowed: boolean;
  mode: EnforcementMode;
  session: ActiveSessionInfo | null;
  warning?: string;
}

/**
 * Require an active session for write operations.
 * In strict mode, throws if no session is active.
 * In warn mode, returns a warning but allows the operation.
 * In none mode, always allows.
 *
 * @param operation - Dot-delimited operation identifier (e.g. `"tasks.complete"`).
 * @param cwd - Project root override for config + session resolution.
 * @param remedyNote - Optional operation-specific remediation sentence appended
 *   to the thrown error's `fix` text (gh#1194 / T12106). Used by
 *   `tasks.complete` to make clear that gates already recorded via
 *   `cleo verify` are preserved and do NOT need re-verification — the recovery
 *   is "start a session, re-run complete", not "fix the evidence".
 */
export async function requireActiveSession(
  operation: string,
  cwd?: string,
  remedyNote?: string,
): Promise<EnforcementResult> {
  const mode = getEnforcementMode(cwd);

  if (mode === 'none') {
    return { allowed: true, mode, session: null };
  }

  const session = await getActiveSessionInfo(cwd);

  if (session) {
    return { allowed: true, mode, session };
  }

  // No active session
  if (mode === 'strict') {
    throw new CleoError(
      ExitCode.SESSION_REQUIRED,
      `Operation '${operation}' requires an active session`,
      {
        fix:
          `Start a session with 'cleo session start --scope epic:T### --auto-start --name "Work"'` +
          (remedyNote ? ` ${remedyNote}` : ''),
        alternatives: [
          {
            action: 'Start session',
            command: 'cleo session start --scope epic:T001 --auto-start --name "Work"',
          },
          { action: 'List sessions', command: 'cleo session list' },
        ],
      },
    );
  }

  // Warn mode
  return {
    allowed: true,
    mode,
    session: null,
    warning: `No active session for operation '${operation}'. Consider starting one.`,
  };
}

/**
 * Emit a loud NON-fatal warning when a session-free write operation (e.g.
 * `cleo verify`) records state without an active session while strict session
 * enforcement is in effect (gh#1194 / T12106).
 *
 * Session-free writes are intentional: T9505 keeps `cleo verify` usable
 * without a session so crash-recovery re-attestation works before a new
 * session is started — the write is NEVER blocked here. But `cleo complete`
 * DOES require an active session, so an agent that ended its session
 * mid-turn would otherwise discover the asymmetry only at complete time
 * (E_CLEO_SESSION_REQUIRED) after every gate already read green. Pushing the
 * warning into the envelope `meta.warnings[]` diagnostics channel keeps the
 * stdout JSON contract pure while surfacing the mismatch at verify time.
 *
 * Only fires under `strict` enforcement — in `warn`/`none` modes complete
 * will not reject the missing session, so the warning would be misleading.
 *
 * @param operation - Dot-delimited operation identifier (e.g. `"check.gate.set"`).
 * @param cwd - Project root override for config + session resolution.
 * @returns `true` when the warning was emitted (strict mode + no active session).
 *
 * @task T12106
 * @gh 1194
 */
export async function warnIfNoActiveSession(operation: string, cwd?: string): Promise<boolean> {
  if (getEnforcementMode(cwd) !== 'strict') return false;

  const session = await getActiveSessionInfo(cwd);
  if (session) return false;

  pushWarning({
    code: 'W_NO_ACTIVE_SESSION',
    message:
      `No active session: '${operation}' was recorded anyway (session-free by design, T9505), ` +
      `but 'cleo complete' requires an active session and will fail with E_CLEO_SESSION_REQUIRED. ` +
      `Start one with 'cleo session start --scope epic:T### --auto-start --name "Work"' before completing — ` +
      `gates recorded now are preserved and do NOT need re-verification.`,
  });
  return true;
}

/**
 * Validate that a task is within the current session's scope.
 * Only enforced when a session is active.
 */
export async function validateTaskInScope(
  taskId: string,
  taskEpicId?: string,
  cwd?: string,
): Promise<{ inScope: boolean; warning?: string }> {
  const mode = getEnforcementMode(cwd);
  if (mode === 'none') return { inScope: true };

  const session = await getActiveSessionInfo(cwd);
  if (!session) return { inScope: true }; // No session = no scope enforcement

  // Global scope allows everything
  if (session.scope.type === 'global') return { inScope: true };

  // Epic scope: task must be within the session's epic
  if (session.scope.type === 'epic' && session.scope.epicId) {
    const epicId = session.scope.epicId;

    // Task is the epic itself or is a child
    if (taskId === epicId || taskEpicId === epicId) {
      return { inScope: true };
    }

    if (mode === 'strict') {
      throw new CleoError(
        ExitCode.TASK_NOT_IN_SCOPE,
        `Task ${taskId} is not in scope of session ${session.id} (epic: ${epicId})`,
        {
          fix: `Focus on tasks within epic ${epicId} or start a new session`,
          alternatives: [
            { action: 'View session', command: `cleo session status` },
            { action: 'End session', command: `cleo session end` },
          ],
        },
      );
    }

    return {
      inScope: false,
      warning: `Task ${taskId} is outside session scope (epic: ${epicId})`,
    };
  }

  return { inScope: true };
}
