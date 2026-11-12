/**
 * Lead records (T14363): one running no-hands lead per epic.
 *
 * `cleo orchestrate lead` writes `<cleoDir>/leads/<epicId>.json` once the
 * lead is admitted. The record names every process that keeps the lead
 * alive, each with its start time: the `cleo` CLI (it waits in the owner's
 * terminal for an interactive lead) and the `claude` lead process itself. The
 * lead is alive while ANY of them lives with the start time recorded for it,
 * so "one lead per epic" holds for as long as the lead runs (not for a claim
 * lease that only mutations renew), and a reused pid, whose start time
 * differs, never blocks the epic.
 *
 * A lead killed before its `SessionEnd` hook ran (SIGKILL, OOM), or one whose
 * Orca terminal was closed after its session ended (T14513), leaves its record
 * behind. {@link reapDeadLeads}, run by the next `cleo orchestrate lead` (which
 * reports what it reaped under `data.lead.reaped`) and by `cleo orchestrate
 * status`, releases such a lead's mailbox, ends its CLEO session unless it has
 * already ended (freeing the epic claim), removes its temp directory (which
 * may hold the mbx env) and deletes the record.
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
import {
  type OrcaLeadTerminal,
  orcaLeadTerminalSchema,
} from '@cleocode/contracts/orca-execution.js';
import { type ProcessLiveness, probeProcess } from '@cleocode/worktree';
import { endSession, getSession } from '../store/session-store.js';
import { type AgentMbxClient, createAgentMbxClient } from './agentmbx.js';
import { leadRecordsDir } from './lead-records-dir.js';

/** One process of a lead, identified by pid AND start time (pids are reused). */
export interface LeadProcess {
  /** `cli` (the `cleo orchestrate lead` process) or `lead` (the provider process). */
  readonly role: 'cli' | 'lead';
  readonly pid: number;
  /** `ps -o lstart` at record time; `null` when it could not be read. */
  readonly startedAt: string | null;
}

/** One running lead. */
export interface LeadRecord {
  /** Epic the lead runs. */
  readonly epicId: string;
  /** Processes that keep the lead alive: the CLI and the lead, with start times. */
  readonly processes: readonly LeadProcess[];
  /** Verified Orca owner terminal, recorded with its supervisor before release. */
  readonly terminal?: OrcaLeadTerminal;
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

/** Path of one epic's lead record. */
function recordPath(projectRoot: string, epicId: string): string {
  // @sync-invariant none:local-only a lead record is a local file; a malformed id never reaches a path
  if (!EPIC_ID.test(epicId)) throw new Error(`invalid epic id for a lead record: ${epicId}`);
  return join(leadRecordsDir(projectRoot), `${epicId}.json`);
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
    const rawProcesses = get('processes');
    const epicId = str('epicId');
    const cleoSessionId = str('cleoSessionId');
    const providerSessionId = str('providerSessionId');
    if (!Array.isArray(rawProcesses) || !epicId || !cleoSessionId || !providerSessionId) {
      return null;
    }
    const processes: LeadProcess[] = [];
    const terminal = orcaLeadTerminalSchema.safeParse(get('terminal'));
    for (const p of rawProcesses) {
      if (typeof p !== 'object' || p === null) continue;
      const pid: unknown = Reflect.get(p, 'pid');
      const startedAt: unknown = Reflect.get(p, 'startedAt');
      if (typeof pid !== 'number') continue;
      processes.push({
        role: Reflect.get(p, 'role') === 'lead' ? 'lead' : 'cli',
        pid,
        startedAt: typeof startedAt === 'string' ? startedAt : null,
      });
    }
    return {
      epicId,
      processes,
      ...(terminal.success ? { terminal: terminal.data } : {}),
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
  const dir = leadRecordsDir(projectRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => parseRecord(readFileSync(join(dir, name), 'utf-8')))
    .filter((r): r is LeadRecord => r !== null);
}

/**
 * Whether a lead is alive: ANY of its processes runs with the start time
 * recorded for it. A process whose start time was not recorded counts on its
 * pid alone; a live pid with a different start time is a reused pid.
 *
 * @param record - The lead record.
 * @param probe - Process probe. @defaultValue `probeProcess` (`@cleocode/worktree`)
 * @returns True while the lead runs.
 * @task T14363
 */
export function isLeadAlive(
  record: LeadRecord,
  probe: (pid: number) => ProcessLiveness = probeProcess,
): boolean {
  return record.processes.some((p) => {
    const live = probe(p.pid);
    return live.alive && (p.startedAt === null || live.startedAt === p.startedAt);
  });
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
  /** Pids the record named, all of them gone (or reused). */
  readonly pids: readonly number[];
  /** The lead's CLEO session. */
  readonly cleoSessionId: string;
  readonly mailboxReleased: boolean;
  /** The reaper ended the lead's session (it was still open). */
  readonly sessionEnded: boolean;
  /** The session had already ended (the lead's `SessionEnd` hook ran); left as it was (T14513). */
  readonly sessionAlreadyEnded: boolean;
  readonly tempDirRemoved: boolean;
}

/** Collaborators of {@link reapDeadLeads}, injected in tests. */
export interface ReapDeps {
  /** AgentMBX adapter. @defaultValue {@link createAgentMbxClient} */
  readonly mbxClient?: AgentMbxClient;
  /** Process probe. @defaultValue `probeProcess` (`@cleocode/worktree`) */
  readonly probe?: (pid: number) => ProcessLiveness;
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
  const records =
    deps.epicId !== undefined
      ? [readLeadRecord(projectRoot, deps.epicId)].filter((r): r is LeadRecord => r !== null)
      : listLeadRecords(projectRoot);
  const reaped: ReapedLead[] = [];
  for (const record of records) {
    if (isLeadAlive(record, deps.probe)) continue;
    const client = deps.mbxClient ?? createAgentMbxClient();
    const release = record.mailbox
      ? await client.release({ cli: record.providerCli, session: record.providerSessionId })
      : null;
    // T14513: a session that already ended keeps its own end time and notes.
    const session = await getSession(record.cleoSessionId, projectRoot).catch(() => null);
    const sessionAlreadyEnded = session?.status === 'ended';
    const ended =
      !sessionAlreadyEnded &&
      (await endSession(record.cleoSessionId, 'lead died; reaped', projectRoot)
        .then(() => true)
        .catch(() => false));
    let tempDirRemoved = false;
    if (record.tempDir && isSpawnTempDir(record.tempDir)) {
      rmSync(record.tempDir, { recursive: true, force: true });
      tempDirRemoved = true;
    }
    removeLeadRecord(projectRoot, record.epicId);
    reaped.push({
      epicId: record.epicId,
      pids: record.processes.map((p) => p.pid),
      cleoSessionId: record.cleoSessionId,
      mailboxReleased: release?.ok === true,
      sessionEnded: ended,
      sessionAlreadyEnded,
      tempDirRemoved,
    });
  }
  return reaped;
}
