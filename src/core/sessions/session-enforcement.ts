/**
 * Session enforcement - require active sessions for write operations.
 *
 * Part of the Epic-Bound Session architecture. Enforces that write operations
 * (add, update, complete) require an active session when multi-session mode
 * is enabled.
 *
 * @task T4454
 * @epic T4454
 */

import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  try {
    // Check if multi-session is enabled
    const multiEnabled = readConfigValueSync('multiSession.enabled', false, cwd);
    if (!multiEnabled) return 'none';

    // Get enforcement mode from config
    const mode = readConfigValueSync('session.enforcement', 'strict', cwd) as string;
    if (mode === 'strict' || mode === 'warn' || mode === 'none') return mode;
    return 'strict'; // Default
  } catch {
    return 'none';
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
  const session = await sessionStatus(cwd);
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
 */
export async function requireActiveSession(
  operation: string,
  cwd?: string,
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
        fix: "Start a session with 'cleo session start --scope epic:T### --auto-focus --name \"Work\"'",
        alternatives: [
          { action: 'Start session', command: 'cleo session start --scope epic:T001 --auto-focus --name "Work"' },
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
 * Validate that a task is within the current session's scope.
 * Only enforced when multi-session mode is enabled and a session is active.
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
