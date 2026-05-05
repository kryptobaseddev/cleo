/**
 * Session-drift watchdog (file-scope drift).
 *
 * Detects when files modified in the working tree fall *outside* the
 * scope declared by the active task's `Task.files[]` declaration.
 *
 * This is the file-modification analogue of `session-drift.ts`'s
 * task-completion drift signal. The two cooperate but address different
 * symptoms of the same underlying problem (silent sidetrack work):
 *   - `session-drift.ts` measures drift across the *task graph*.
 *   - `drift-watchdog.ts` measures drift across the *file tree*.
 *
 * Project-agnostic: relies on `git status --porcelain`, which exists in
 * every git project regardless of language, framework, or build system.
 *
 * @task T1594
 * @epic T1586
 */

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import type { Session, Task } from '@cleocode/contracts';
import { getCleoHome } from '@cleocode/paths';
import { getAccessor } from '../store/data-accessor.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Result of one drift-watchdog evaluation.
 *
 * @public
 */
export interface DriftReport {
  /** Active session ID, or null if no session is active. */
  sessionId: string | null;
  /** Active task ID (`taskWork.taskId`), or null if no task is in focus. */
  activeTaskId: string | null;
  /** Files declared on the active task's `files[]` (normalized to repo-relative). */
  declaredFiles: string[];
  /** Files git reports as modified (porcelain --short). */
  modifiedFiles: string[];
  /** Modified files NOT covered by the declared scope. */
  outsideScope: string[];
  /** Modified files covered by the declared scope. */
  insideScope: string[];
  /**
   * Suggested `cleo pivot` command if drift exceeds the threshold (50%).
   * Omitted when no pivot recommendation applies.
   */
  suggestedPivot?: string;
}

/**
 * Options controlling drift detection.
 *
 * @public
 */
export interface DetectSessionDriftOptions {
  /** Absolute path to the project root (the git repo). */
  projectRoot: string;
  /**
   * Audit-log scope.
   * - `"global"` (default): writes to `~/.local/share/cleo/audit/session-drift.jsonl`
   * - `"local"`: writes to `<projectRoot>/.cleo/audit/session-drift.jsonl`
   */
  auditScope?: 'global' | 'local';
  /**
   * Drift ratio (`outsideScope.length / modifiedFiles.length`) above which a
   * pivot recommendation is emitted. Default: `0.5`.
   */
  pivotThreshold?: number;
  /**
   * Test seam — override the modified-files reader. Defaults to
   * `git status --porcelain` against `projectRoot`.
   * @internal
   */
  listChangedFiles?: (projectRoot: string) => Promise<string[]>;
  /**
   * Test seam — override the audit append path. When set, the watchdog
   * writes the JSONL line to this absolute file instead of the resolved
   * default. Used by tests to avoid polluting the real audit log.
   * @internal
   */
  auditPathOverride?: string;
}

/**
 * Persisted shape of a single drift-watchdog audit line. One JSON object per
 * line in `session-drift.jsonl`. Append-only, never read by CLEO at runtime.
 *
 * @public
 */
export interface DriftAuditEntry {
  timestamp: string;
  sessionId: string | null;
  activeTaskId: string | null;
  declaredFiles: string[];
  modifiedFiles: string[];
  outsideScope: string[];
  ratio: number;
  pivotSuggested: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default ratio above which we emit a pivot suggestion. */
export const DEFAULT_PIVOT_THRESHOLD = 0.5;

/** Default env-var name controlling watchdog cadence (seconds). */
export const DRIFT_WATCHDOG_INTERVAL_ENV = 'CLEO_DRIFT_WATCHDOG_INTERVAL_SEC';

/** Default cadence in seconds (used by future periodic firing — not this task). */
export const DRIFT_WATCHDOG_INTERVAL_DEFAULT_SEC = 300;

/** Relative path used when writing to the local-scope audit log. */
export const LOCAL_AUDIT_RELPATH = '.cleo/audit/session-drift.jsonl';

/** Relative path under `~/.local/share/cleo` for the global-scope audit log. */
export const GLOBAL_AUDIT_RELPATH = 'audit/session-drift.jsonl';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Default `git status --porcelain` reader. Project-agnostic: works in every
 * git repository regardless of toolchain. Returns repo-relative paths.
 */
async function defaultListChangedFiles(projectRoot: string): Promise<string[]> {
  return new Promise<string[]>((resolve) => {
    let out = '';
    const child = spawn('git', ['status', '--porcelain'], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf-8');
    });
    child.on('error', () => resolve([]));
    child.on('close', () => {
      const files = out
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          // Porcelain: "XY path" — strip 2-char status prefix; renames keep target.
          const stripped = line.length > 3 ? line.slice(3).trim() : line;
          const arrow = stripped.indexOf(' -> ');
          return arrow >= 0 ? stripped.slice(arrow + 4) : stripped;
        });
      resolve(files);
    });
  });
}

/**
 * Normalize a path to a repo-relative POSIX-style form so that comparisons
 * between `git status` output (always `/`) and `Task.files[]` declarations
 * (which may use any separator or include the project root prefix) match.
 */
function normalizeForCompare(path: string, projectRoot: string): string {
  let p = path;
  if (isAbsolute(p)) {
    p = relative(projectRoot, p);
  }
  p = normalize(p);
  if (sep !== '/') {
    p = p.split(sep).join('/');
  }
  // Strip leading "./" if present.
  if (p.startsWith('./')) p = p.slice(2);
  return p;
}

/**
 * Resolve the active-task ID for the given session, falling back to the
 * accessor's `focus_state.currentTask` (matching `getContextDrift`'s
 * behaviour) when the session has no task currently bound.
 */
function resolveActiveTaskId(session: Session | null, focusTask: string | null): string | null {
  if (session?.taskWork?.taskId) return session.taskWork.taskId;
  return focusTask;
}

/**
 * Return the audit-log path for the requested scope.
 * - `local` → `<projectRoot>/.cleo/audit/session-drift.jsonl`
 * - `global` → `<cleoHome>/audit/session-drift.jsonl`
 *
 * Resolves the global path through the `@cleocode/paths` SSoT so the
 * watchdog stays consistent with the rest of the CLEO ecosystem
 * (XDG on Linux, Library/Application Support on macOS, %LOCALAPPDATA%
 * on Windows — and `CLEO_HOME` overrides on every platform).
 */
export function resolveDriftAuditPath(projectRoot: string, scope: 'global' | 'local'): string {
  if (scope === 'local') {
    return join(projectRoot, LOCAL_AUDIT_RELPATH);
  }
  return join(getCleoHome(), GLOBAL_AUDIT_RELPATH);
}

/**
 * Append a single audit line to the watchdog's drift log. Append-only,
 * best-effort — write failures are swallowed so the watchdog never
 * blocks normal CLI flow.
 */
function appendDriftAudit(filePath: string, entry: DriftAuditEntry): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf-8');
  } catch {
    /* audit writes are best-effort */
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect file-scope session drift for the active session.
 *
 * Compares files modified in the git working tree against the active
 * task's declared `files[]` scope. Files modified but not declared
 * surface as `outsideScope`; if their fraction exceeds the pivot
 * threshold, a `cleo pivot` suggestion is attached and the event is
 * recorded to the audit log.
 *
 * Returns an empty (no-drift) report when there is no active session
 * or no active task — sessions and unfocused work cannot drift.
 *
 * @example
 * ```ts
 * const report = await detectSessionDrift({ projectRoot: process.cwd() });
 * if (report.outsideScope.length > 0) {
 *   console.warn(`Drift: ${report.outsideScope.length} files outside scope`);
 *   if (report.suggestedPivot) console.warn(report.suggestedPivot);
 * }
 * ```
 *
 * @public
 * @task T1594
 */
export async function detectSessionDrift(opts: DetectSessionDriftOptions): Promise<DriftReport> {
  const {
    projectRoot,
    auditScope = 'global',
    pivotThreshold = DEFAULT_PIVOT_THRESHOLD,
    listChangedFiles = defaultListChangedFiles,
    auditPathOverride,
  } = opts;

  const accessor = await getAccessor(projectRoot);
  const session = await accessor.getActiveSession();
  const focus = await accessor.getMetaValue<{ currentTask?: string | null }>('focus_state');
  const activeTaskId = resolveActiveTaskId(session, focus?.currentTask ?? null);

  // Always read the modified-files set so a no-task report still reflects
  // ground truth (callers display these even when there is no focus).
  const modifiedRaw = await listChangedFiles(projectRoot);
  const modifiedFiles = modifiedRaw.map((p) => normalizeForCompare(p, projectRoot));

  // No active task → no scope to diff against → no drift by definition.
  if (!activeTaskId) {
    return {
      sessionId: session?.id ?? null,
      activeTaskId: null,
      declaredFiles: [],
      modifiedFiles,
      outsideScope: [],
      insideScope: [],
    };
  }

  const tasks: Task[] = await accessor.loadTasks([activeTaskId]);
  const activeTask = tasks[0];
  const declaredRaw = activeTask?.files ?? [];
  const declaredFiles = declaredRaw.map((p) => normalizeForCompare(p, projectRoot));
  const declaredSet = new Set(declaredFiles);

  const insideScope: string[] = [];
  const outsideScope: string[] = [];
  for (const f of modifiedFiles) {
    if (declaredSet.has(f)) {
      insideScope.push(f);
    } else {
      outsideScope.push(f);
    }
  }

  const total = modifiedFiles.length;
  const ratio = total > 0 ? outsideScope.length / total : 0;
  const pivotSuggested = total > 0 && ratio > pivotThreshold;

  let suggestedPivot: string | undefined;
  if (pivotSuggested) {
    suggestedPivot =
      `cleo pivot ${activeTaskId} <newTask> ` +
      `--reason "${outsideScope.length} of ${total} modified files outside scope"`;
  }

  // Append to audit log only when drift is observed (outsideScope > 0). The
  // log is the system-of-record for "this session went sideways" events;
  // clean sessions don't pollute it.
  if (outsideScope.length > 0) {
    const auditPath = auditPathOverride ?? resolveDriftAuditPath(projectRoot, auditScope);
    const entry: DriftAuditEntry = {
      timestamp: new Date().toISOString(),
      sessionId: session?.id ?? null,
      activeTaskId,
      declaredFiles,
      modifiedFiles,
      outsideScope,
      ratio,
      pivotSuggested,
    };
    appendDriftAudit(auditPath, entry);
  }

  return {
    sessionId: session?.id ?? null,
    activeTaskId,
    declaredFiles,
    modifiedFiles,
    outsideScope,
    insideScope,
    ...(suggestedPivot ? { suggestedPivot } : {}),
  };
}

/**
 * Read the configured watchdog cadence (seconds) from
 * `CLEO_DRIFT_WATCHDOG_INTERVAL_SEC`, falling back to the default.
 *
 * Periodic firing is a future task — for now the value is plumbed so
 * callers (e.g. a daemon, a hook) can read it without re-implementing
 * the env-var contract.
 *
 * @public
 * @task T1594
 */
export function getDriftWatchdogIntervalSec(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[DRIFT_WATCHDOG_INTERVAL_ENV];
  if (!raw) return DRIFT_WATCHDOG_INTERVAL_DEFAULT_SEC;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DRIFT_WATCHDOG_INTERVAL_DEFAULT_SEC;
  }
  return parsed;
}
