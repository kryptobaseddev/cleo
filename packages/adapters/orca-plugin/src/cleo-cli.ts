/**
 * Bounded, argv-only `cleo` reads for the Orca plugin worker (T14462).
 *
 * The only way this plugin learns anything about CLEO: one `cleo` subprocess
 * per read, started without a shell, with a deadline, an output cap and the
 * caller's abort signal, whose stdout must be exactly one LAFS envelope. It
 * never opens `.cleo/*.db` and never runs a mutating verb: the argv builders
 * below are the whole command surface.
 */

import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import type { CleoFailure, CleoFailureCode, TaskStatusFilter } from './protocol.ts';

/** Longest a single `cleo` read may run before it is killed. */
export const CLEO_TIMEOUT_MS = 20_000;

/** Most stdout a single `cleo` read may produce before it is killed. */
export const CLEO_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Rows one list read asks for; a longer result is reported as truncated. */
export const TASK_PAGE_SIZE = 50;

/** Longest failure message handed to the panel. */
const MAX_MESSAGE_LENGTH = 500;

/** Statuses `cleo list --status` is asked for; `all` sends no filter. */
const STATUS_FILTERS: readonly TaskStatusFilter[] = ['active', 'pending', 'blocked', 'done', 'all'];

/**
 * A CLEO task id: `T`, a digit, then letters or digits. The leading `T` also
 * guarantees an id can never be read as a flag.
 */
const TASK_ID = /^T[0-9][0-9A-Za-z]{0,15}$/;

/**
 * The one `CLEO_*` variable a read keeps: where this machine holds CLEO's
 * global data. It never selects a project or an identity.
 */
const KEPT_CLEO_ENV = 'CLEO_HOME';

/** The `data` of a successful envelope, or why there is none. */
export type CleoRunResult = { ok: true; data: Record<string, unknown> } | CleoFailure;

/** How one read is bounded. `bin`, `timeoutMs` and `maxOutputBytes` exist for tests. */
export type CleoRunOptions = {
  /** Directory the read runs in: the chosen workspace's local path. */
  cwd: string;
  signal?: AbortSignal;
  bin?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
};

/** Runs one read. The worker takes it as a parameter so fixtures can stand in. */
export type CleoRunner = (
  argv: readonly string[],
  options: CleoRunOptions,
) => Promise<CleoRunResult>;

/**
 * Builds a failure the panel can show as is.
 *
 * @param code - Machine-readable reason.
 * @param message - Human-readable reason, clipped to a bounded length.
 */
export function failure(code: CleoFailureCode, message: string): CleoFailure {
  return { ok: false, code, message: message.slice(0, MAX_MESSAGE_LENGTH) };
}

/**
 * Narrows an unknown JSON value to a plain object.
 *
 * @param value - Any parsed JSON value.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a string is a CLEO task id safe to place in argv.
 *
 * @param value - Candidate id from the panel.
 */
export function isTaskId(value: unknown): value is string {
  return typeof value === 'string' && TASK_ID.test(value);
}

/**
 * Argv of the list read: a workspace's epics, or one task's direct children.
 *
 * @param request - Parent id (children) or status filter (epics), and the page offset.
 * @returns The argv, or `null` when a field is not one this plugin sends.
 */
export function listArgv(request: {
  parentId?: unknown;
  status?: unknown;
  offset?: unknown;
}): string[] | null {
  const offset = request.offset ?? 0;
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0 || offset > 100_000) {
    return null;
  }
  const page = ['--limit', String(TASK_PAGE_SIZE), '--offset', String(offset)];
  if (request.parentId !== undefined) {
    return isTaskId(request.parentId) ? ['list', '--parent', request.parentId, ...page] : null;
  }
  const status = request.status ?? 'active';
  if (!STATUS_FILTERS.some((known) => known === status)) return null;
  const filter = status === 'all' ? [] : ['--status', String(status)];
  return ['list', '--type', 'epic', ...filter, ...page];
}

/**
 * Argv of the detail read: one task with acceptance, evidence and claim.
 *
 * @param taskId - Candidate id from the panel.
 * @returns The argv, or `null` when the id is not a task id.
 */
export function showArgv(taskId: unknown): string[] | null {
  return isTaskId(taskId) ? ['show', taskId, '--full'] : null;
}

/**
 * Reads stdout as one LAFS envelope.
 *
 * The exit code is deliberately not consulted: `cleo list` exits 100 with a
 * successful envelope when nothing matches, so the envelope is the authority.
 *
 * @param stdout - Everything the read printed to stdout.
 * @returns The envelope's `data`, CLEO's own error, or `malformed-envelope`.
 */
export function parseEnvelope(stdout: string): CleoRunResult {
  const text = stdout.trim();
  if (text === '') return failure('malformed-envelope', 'CLEO printed no envelope.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return failure('malformed-envelope', 'CLEO printed output that is not one JSON envelope.');
  }
  if (!isRecord(parsed) || typeof parsed['success'] !== 'boolean') {
    return failure('malformed-envelope', 'CLEO printed JSON without a success flag.');
  }
  if (parsed['success']) {
    const data = parsed['data'];
    if (!isRecord(data)) return failure('malformed-envelope', 'CLEO succeeded without data.');
    return { ok: true, data };
  }
  const error = parsed['error'];
  if (!isRecord(error) || typeof error['message'] !== 'string') {
    return failure('malformed-envelope', 'CLEO failed without an error message.');
  }
  const codeName = typeof error['codeName'] === 'string' ? error['codeName'] : 'E_UNKNOWN';
  if (codeName === 'E_CLEO_NOT_FOUND') return failure('not-a-project', error['message']);
  return failure('cli-error', `${codeName}: ${error['message']}`);
}

/**
 * The environment of one read: the worker's own, minus every `CLEO_*` setting
 * of whatever started Orca.
 *
 * `CLEO_ROOT`, `CLEO_PROJECT_ROOT` and `CLEO_DIR` override the working
 * directory as the project a `cleo` command reads, so an inherited one would
 * show another project under the chosen workspace's name. `CLEO_SESSION_ID`,
 * `CLEO_AGENT_ID` and `CLEO_AGENT_ROLE` would make the view act as an agent.
 * Dropping the whole prefix also covers settings added later.
 *
 * @param source - The environment to start from; the worker's by default.
 */
export function readEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (name.startsWith('CLEO_') && name !== KEPT_CLEO_ENV) continue;
    env[name] = value;
  }
  env['NO_COLOR'] = '1';
  return env;
}

/**
 * Maps a subprocess error to a failure, or `null` when the process merely
 * exited non-zero and its stdout still has to be read as an envelope.
 */
function classifyExecError(error: Error & { code?: unknown; killed?: boolean }, bin: string) {
  if (error.name === 'AbortError' || error.code === 'ABORT_ERR') {
    return failure('cancelled', 'The CLEO read was cancelled.');
  }
  if (error.code === 'ENOENT') {
    return failure('cleo-missing', `The CLEO CLI ("${bin}") was not found on this machine's PATH.`);
  }
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return failure('output-too-large', 'CLEO printed more than this view accepts in one read.');
  }
  if (error.killed === true) {
    return failure('timeout', 'CLEO did not answer in time and the read was stopped.');
  }
  if (typeof error.code === 'number') return null;
  return failure('cli-error', `CLEO could not be started: ${error.message}`);
}

/**
 * Runs one bounded `cleo` read in a local directory and parses its envelope.
 * Never rejects: every outcome is a value.
 *
 * @param argv - Arguments from {@link listArgv} or {@link showArgv}; no shell ever sees them.
 * @param options - Working directory, abort signal and bounds.
 */
export async function runCleo(
  argv: readonly string[],
  options: CleoRunOptions,
): Promise<CleoRunResult> {
  const bin = options.bin ?? 'cleo';
  // A missing working directory also surfaces as ENOENT; tell the two apart first.
  const directory = await stat(options.cwd).catch(() => null);
  if (!directory?.isDirectory()) {
    return failure('workspace-unavailable', 'The workspace folder is not on this machine.');
  }
  return new Promise((resolve) => {
    try {
      execFile(
        bin,
        [...argv],
        {
          cwd: options.cwd,
          signal: options.signal,
          timeout: options.timeoutMs ?? CLEO_TIMEOUT_MS,
          maxBuffer: options.maxOutputBytes ?? CLEO_MAX_OUTPUT_BYTES,
          env: readEnvironment(),
          windowsHide: true,
        },
        (error, stdout) => {
          const failed = error ? classifyExecError(error, bin) : null;
          resolve(failed ?? parseEnvelope(stdout));
        },
      );
    } catch (error) {
      resolve(failure('cli-error', `CLEO could not be started: ${String(error)}`));
    }
  });
}
