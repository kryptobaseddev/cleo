/**
 * Lead records (T14363): one running no-hands lead per epic.
 *
 * `cleo orchestrate lead` writes `<cleoDir>/leads/<epicId>.json` once the
 * lead is admitted. The record names the process that keeps the lead alive:
 * the CLI process itself for an interactive lead (it waits in the owner's
 * terminal), or the detached lead's own pid. Liveness is that pid, probed
 * with signal 0, so "one lead per epic" holds for as long as the lead runs,
 * not for a claim lease that only mutations renew.
 *
 * A lead killed before its `SessionEnd` hook ran (SIGKILL, OOM) leaves its
 * record behind. {@link reapDeadLeads}, run by the next `cleo orchestrate
 * lead` and by `cleo orchestrate status`, releases such a lead's mailbox,
 * ends its CLEO session (freeing the epic claim), removes its temp directory
 * (which may hold the mbx env) and deletes the record.
 *
 * The file is local runtime state (a pid means nothing on another device).
 *
 * @task T14363
 * @epic T14351
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import type { LeadMode } from '@cleocode/contracts';
import { resolveCleoDir } from '../paths.js';
import { endSession } from '../store/session-store.js';
import { type AgentMbxClient, createAgentMbxClient } from './agentmbx.js';

/** One running lead. */
export interface LeadRecord {
  /** Epic the lead runs. */
  readonly epicId: string;
  /** Pid that keeps the lead alive (the CLI for interactive, the lead for detached). */
  readonly pid: number;
  /** How the lead runs. */
  readonly mode: LeadMode;
  /** The lead's own CLEO session (holds the epic claim). */
  readonly cleoSessionId: string;
  /** The lead's provider session (`claude --session-id`), the mailbox holder. */
  readonly providerSessionId: string;
  /** Provider CLI of the lead (`claude`). */
  readonly providerCli: string;
  /** Mailbox claimed for the lead, or `null`. */
  readonly mailbox: string | null;
  /** A detached lead's private temp directory, or `null`. */
  readonly tempDir: string | null;
  /** ISO start time. */
  readonly startedAt: string;
}

/** Task ids are plain words; anything else never reaches a file name. */
const EPIC_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Directory holding the lead records of a project. */
function leadsDir(projectRoot: string): string {
  return join(resolveCleoDir(projectRoot), 'leads');
}

/** Path of one epic's lead record. */
function recordPath(projectRoot: string, epicId: string): string {
  if (!EPIC_ID.test(epicId)) throw new Error(`invalid epic id for a lead record: ${epicId}`);
  return join(leadsDir(projectRoot), `${epicId}.json`);
}

/** Parse a record, or `null` when the file is not one. */
function parseRecord(text: string): LeadRecord | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null) return null;
    const get = (key: string): unknown => Reflect.get(value, key);
    const str = (key: string): string | null => {
      const v = get(key);
      return typeof v === 'string' ? v : null;
    };
    const pid = get('pid');
    const epicId = str('epicId');
    const cleoSessionId = str('cleoSessionId');
    const providerSessionId = str('providerSessionId');
    if (typeof pid !== 'number' || !epicId || !cleoSessionId || !providerSessionId) return null;
    return {
      epicId,
      pid,
      mode: get('mode') === 'detached' ? 'detached' : 'interactive',
      cleoSessionId,
      providerSessionId,
      providerCli: str('providerCli') ?? 'claude',
      mailbox: str('mailbox'),
      tempDir: str('tempDir'),
      startedAt: str('startedAt') ?? '',
    };
  } catch {
    return null;
  }
}

/**
 * Write (or replace) an epic's lead record.
 *
 * @param projectRoot - Project root.
 * @param record - The record.
 * @task T14363
 */
export function writeLeadRecord(projectRoot: string, record: LeadRecord): void {
  const file = recordPath(projectRoot, record.epicId);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
}

/**
 * Read an epic's lead record.
 *
 * @param projectRoot - Project root.
 * @param epicId - Epic id.
 * @returns The record, or `null` when none (or unreadable).
 * @task T14363
 */
export function readLeadRecord(projectRoot: string, epicId: string): LeadRecord | null {
  const file = recordPath(projectRoot, epicId);
  return existsSync(file) ? parseRecord(readFileSync(file, 'utf-8')) : null;
}

/**
 * Delete an epic's lead record.
 *
 * @param projectRoot - Project root.
 * @param epicId - Epic id.
 * @task T14363
 */
export function removeLeadRecord(projectRoot: string, epicId: string): void {
  rmSync(recordPath(projectRoot, epicId), { force: true });
}

/**
 * Every lead record of a project.
 *
 * @param projectRoot - Project root.
 * @returns The records.
 * @task T14363
 */
export function listLeadRecords(projectRoot: string): LeadRecord[] {
  const dir = leadsDir(projectRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => parseRecord(readFileSync(join(dir, name), 'utf-8')))
    .filter((r): r is LeadRecord => r !== null);
}

/**
 * Whether a pid is alive (signal 0). `EPERM` means it exists under another user.
 *
 * @param pid - Process id.
 * @returns True when the process exists.
 * @task T14363
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err instanceof Error && 'code' in err && err.code === 'EPERM';
  }
}

/**
 * True for a directory the claude-code adapter made for a spawn: directly
 * under the OS temp dir and named `cleo-claude-spawn-*`. Nothing else is ever
 * removed by the reaper.
 */
function isSpawnTempDir(dir: string): boolean {
  const rel = relative(resolve(tmpdir()), resolve(dir));
  return rel === basename(dir) && basename(dir).startsWith('cleo-claude-spawn-');
}

/** What {@link reapDeadLeads} did for one dead lead. */
export interface ReapedLead {
  readonly epicId: string;
  readonly pid: number;
  readonly mailboxReleased: boolean;
  readonly sessionEnded: boolean;
  readonly tempDirRemoved: boolean;
}

/** Collaborators of {@link reapDeadLeads}, injected in tests. */
export interface ReapDeps {
  /** AgentMBX adapter. @defaultValue {@link createAgentMbxClient} */
  readonly mbxClient?: AgentMbxClient;
  /** Liveness probe. @defaultValue {@link isPidAlive} */
  readonly isAlive?: (pid: number) => boolean;
  /** Only this epic's record. */
  readonly epicId?: string;
}

/**
 * Release what a dead lead left behind: its mailbox, its CLEO session (and
 * so its epic claim), its temp directory and its record. A live lead is
 * never touched.
 *
 * @param projectRoot - Project root.
 * @param deps - See {@link ReapDeps}.
 * @returns One entry per reaped lead.
 * @task T14363
 */
export async function reapDeadLeads(
  projectRoot: string,
  deps: ReapDeps = {},
): Promise<ReapedLead[]> {
  const isAlive = deps.isAlive ?? isPidAlive;
  const records =
    deps.epicId !== undefined
      ? [readLeadRecord(projectRoot, deps.epicId)].filter((r): r is LeadRecord => r !== null)
      : listLeadRecords(projectRoot);
  const reaped: ReapedLead[] = [];
  for (const record of records) {
    if (isAlive(record.pid)) continue;
    const client = deps.mbxClient ?? createAgentMbxClient();
    const release = record.mailbox
      ? await client.release({ cli: record.providerCli, session: record.providerSessionId })
      : null;
    const ended = await endSession(record.cleoSessionId, 'lead died; reaped', projectRoot)
      .then(() => true)
      .catch(() => false);
    let tempDirRemoved = false;
    if (record.tempDir && isSpawnTempDir(record.tempDir)) {
      rmSync(record.tempDir, { recursive: true, force: true });
      tempDirRemoved = true;
    }
    removeLeadRecord(projectRoot, record.epicId);
    reaped.push({
      epicId: record.epicId,
      pid: record.pid,
      mailboxReleased: release?.ok === true,
      sessionEnded: ended,
      tempDirRemoved,
    });
  }
  return reaped;
}
