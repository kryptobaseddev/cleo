/**
 * AgentMBX adapter (T14379): the one core path to the `agentmbx` CLI.
 *
 * Every call shells out with an argv array (never a shell string) and never
 * spawns `agentmbx mcp` or touches mbx processes. Nothing throws: an absent
 * CLI or a failed call returns `{ ok: false, warning }`, so callers fail
 * closed and surface the warning. The process runner is injected, so tests
 * drive a fake CLI.
 *
 * Callers: `cleo init` records the lead mailbox ({@link ensureLeadMailbox}),
 * spawn/fanout read it ({@link resolveLeadMailbox}), and the progress
 * watchdog (T14362) and worker prompts (T13966) can send through
 * {@link AgentMbxClient.send}.
 *
 * @task T14379
 * @epic T14351
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { LeadMailbox } from '@cleocode/contracts';
import { loadConfig, setConfigValue } from '../config.js';

/** An AgentMBX mailbox name: letters, digits and `. _ - @ :` (T13943). */
export const MBX_NAME = /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,127}$/;

/** Result of one `agentmbx` invocation. */
export interface MbxRunResult {
  /** True when the `agentmbx` binary could not be found. */
  missing: boolean;
  /** Process exit code; `null` when it never ran or was killed. */
  exitCode: number | null;
  /** Captured stdout. */
  stdout: string;
  /** Captured stderr. */
  stderr: string;
}

/** Runs `agentmbx` with the given argv. Injected in tests. */
export type MbxRunner = (args: readonly string[]) => Promise<MbxRunResult>;

/** Outcome of an adapter call: a value, or a warning when it failed closed. */
export type MbxOutcome<T> = { ok: true; value: T } | { ok: false; warning: string };

/** Message kinds `agentmbx send --kind` accepts. */
export type MbxKind = 'message' | 'request' | 'reply' | 'status' | 'decision' | 'alert' | 'task';

/** One message to send. */
export interface MbxSendInput {
  /** Sending mailbox (`--as`). */
  as: string;
  /** Recipient(s) (`--to`), comma-separated. */
  to: string;
  /** Subject line. */
  subject: string;
  /** Message body (`-m`). */
  body: string;
  /** Message kind. Default `message`. */
  kind?: MbxKind;
  /** Thread parent (`--reply-to`). */
  replyTo?: string;
  /**
   * Delivery key; a retry with the same key is delivered once. Defaults to a
   * hash of sender, recipients, subject and body, so a plain retry dedupes.
   */
  idempotencyKey?: string;
}

/** One inbox entry. */
export interface MbxInboxMessage {
  /** Message id. */
  id: string;
  /** Sender mailbox. */
  from: string;
  /** Subject line. */
  subject: string;
}

/** The caller's current mailbox identity (`agentmbx status`). */
export interface MbxIdentityStatus {
  /** Held mailbox name; `null` when unbound. */
  name: string | null;
  /** Identity state, e.g. `bound` or `unbound`. */
  state: string;
  /** Unread message count. */
  unread: number;
}

/** A provider session selector (`--cli <provider> --session <id>`). */
export interface MbxSession {
  /** Provider CLI, e.g. `claude`. */
  cli: string;
  /** Provider session id; omitted when the CLI resolves it itself. */
  session?: string;
}

/** The adapter surface. */
export interface AgentMbxClient {
  /** True when the `agentmbx` CLI runs. */
  available(): Promise<boolean>;
  /** Send one message; resolves with the message id (when printed) and the key used. */
  send(input: MbxSendInput): Promise<MbxOutcome<{ id: string | null; idempotencyKey: string }>>;
  /** Unread messages for a mailbox. */
  inbox(as: string, session?: MbxSession): Promise<MbxOutcome<MbxInboxMessage[]>>;
  /** Claim a mailbox for a provider session. */
  claim(name: string, session: Required<MbxSession>): Promise<MbxOutcome<MbxIdentityStatus>>;
  /** The identity a provider session holds. */
  status(session: MbxSession): Promise<MbxOutcome<MbxIdentityStatus>>;
}

/** Default runner: `execFile('agentmbx', args)` with a 15 s timeout. */
export const runAgentMbx: MbxRunner = (args) =>
  new Promise((resolve) => {
    execFile(
      'agentmbx',
      [...args],
      { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? err.code : 0;
        resolve({
          missing: code === 'ENOENT',
          exitCode: typeof code === 'number' ? code : err ? null : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });

/** A record parsed from JSON, or `null`. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Parse stdout as JSON; `undefined` when it is not JSON. */
function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

/** A string field, or `''`. */
function str(rec: Record<string, unknown> | null, key: string): string {
  const v = rec?.[key];
  return typeof v === 'string' ? v : '';
}

/** Identity status from `status`/`claim` JSON (`{identity:{name,state}, unread}` or flat). */
function parseIdentity(stdout: string): MbxIdentityStatus {
  const root = asRecord(parseJson(stdout));
  const identity = asRecord(root?.['identity']) ?? root;
  const unread = root?.['unread'];
  return {
    name: str(identity, 'name') || null,
    state: str(identity, 'state') || 'unknown',
    unread: typeof unread === 'number' ? unread : 0,
  };
}

/** The default idempotency key: a hash of who, to whom and what. */
export function defaultIdempotencyKey(input: MbxSendInput): string {
  const digest = createHash('sha256')
    .update([input.as, input.to, input.subject, input.body].join('\0'))
    .digest('hex');
  return `cleo:${digest.slice(0, 32)}`;
}

/**
 * Create the adapter.
 *
 * @param runner - Process runner. Default {@link runAgentMbx}.
 * @returns An {@link AgentMbxClient} that never throws.
 * @example
 * ```ts
 * const mbx = createAgentMbxClient();
 * const sent = await mbx.send({ as: 'w1', to: 'proj-lead', subject: 'done', body: 'T1 done' });
 * if (!sent.ok) log.warn(sent.warning);
 * ```
 */
export function createAgentMbxClient(runner: MbxRunner = runAgentMbx): AgentMbxClient {
  const call = async (args: string[]): Promise<MbxOutcome<string>> => {
    const r = await runner(args);
    if (r.missing) return { ok: false, warning: 'agentmbx is not installed (not on PATH)' };
    if (r.exitCode !== 0) {
      const detail = (r.stderr.trim() || r.stdout.trim()).split('\n')[0] ?? '';
      return {
        ok: false,
        warning: `agentmbx ${args[0]} failed (exit ${r.exitCode ?? 'killed'})${detail ? `: ${detail}` : ''}`,
      };
    }
    return { ok: true, value: r.stdout };
  };
  const sessionArgs = (s?: MbxSession): string[] =>
    s ? ['--cli', s.cli, ...(s.session ? ['--session', s.session] : [])] : [];

  return {
    async available() {
      return (await call(['--version'])).ok;
    },
    async send(input) {
      const idempotencyKey = input.idempotencyKey ?? defaultIdempotencyKey(input);
      const r = await call([
        'send',
        '--as',
        input.as,
        '--to',
        input.to,
        '--kind',
        input.kind ?? 'message',
        '--subject',
        input.subject,
        '-m',
        input.body,
        ...(input.replyTo ? ['--reply-to', input.replyTo] : []),
        '--idempotency-key',
        idempotencyKey,
        '--json',
      ]);
      if (!r.ok) return r;
      const rec = asRecord(parseJson(r.value));
      const id = str(rec, 'id') || str(asRecord(rec?.['data']), 'id') || null;
      return { ok: true, value: { id, idempotencyKey } };
    },
    async inbox(as, session) {
      const r = await call(['inbox', '--as', as, '--json', ...sessionArgs(session)]);
      if (!r.ok) return r;
      const parsed = parseJson(r.value);
      const rows = Array.isArray(parsed) ? parsed : asRecord(parsed)?.['messages'];
      const value = (Array.isArray(rows) ? rows : [])
        .map((row) => asRecord(row))
        .filter((row) => str(row, 'id') !== '')
        .map((row) => ({
          id: str(row, 'id'),
          from: str(row, 'from'),
          subject: str(row, 'subject'),
        }));
      return { ok: true, value };
    },
    async claim(name, session) {
      const r = await call(['identity', 'claim', name, ...sessionArgs(session), '--json']);
      return r.ok ? { ok: true, value: parseIdentity(r.value) } : r;
    },
    async status(session) {
      const r = await call([
        'status',
        ...sessionArgs(session),
        '--json',
        '--schema',
        'mbx.status/v1',
      ]);
      return r.ok ? { ok: true, value: parseIdentity(r.value) } : r;
    },
  };
}

/**
 * The `<project>-lead` mailbox name for a project display name.
 *
 * @param projectName - Project display name.
 * @returns A valid {@link MBX_NAME}, e.g. `cleocode-lead`.
 */
export function leadMailboxName(projectName: string): string {
  const slug = projectName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+|-+$/g, '')
    .slice(0, 100);
  return `${slug || 'project'}-lead`;
}

/** Provider CLI the lead claims from; `CLEO_HOOK_PROVIDER`, else `claude`. */
function detectProviderCli(env: NodeJS.ProcessEnv): string {
  // shortcut: one env hint, else `claude`; upgrade when spawn records the lead's provider.
  return env['CLEO_HOOK_PROVIDER'] || 'claude';
}

/** Result of {@link ensureLeadMailbox}. */
export type EnsureLeadMailboxResult =
  | { action: 'recorded' | 'kept'; leadMailbox: LeadMailbox }
  | { action: 'skipped'; warning: string };

/**
 * Record the project's lead mailbox in project config (`cleo init`). With
 * `agentmbx` absent it writes nothing and returns a warning; an existing
 * record is kept.
 *
 * @param projectRoot - Project root.
 * @param project - Display name and portable id of the project.
 * @param client - Adapter. Default {@link createAgentMbxClient}.
 * @param env - Environment for provider detection. Default `process.env`.
 * @returns What happened.
 */
export async function ensureLeadMailbox(
  projectRoot: string,
  project: { projectName: string; projectId: string },
  client: AgentMbxClient = createAgentMbxClient(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<EnsureLeadMailboxResult> {
  const existing = (await loadConfig(projectRoot)).orchestrate?.leadMailbox;
  if (existing && MBX_NAME.test(existing.name)) return { action: 'kept', leadMailbox: existing };
  if (!(await client.available())) {
    return {
      action: 'skipped',
      warning:
        'AgentMBX: agentmbx is not installed, so no lead mailbox was recorded. Install it and re-run `cleo init` to give spawned workers a default lead mailbox.',
    };
  }
  const leadMailbox: LeadMailbox = {
    name: leadMailboxName(project.projectName),
    projectId: project.projectId,
    cli: detectProviderCli(env),
  };
  await setConfigValue('orchestrate.leadMailbox', leadMailbox, projectRoot);
  return { action: 'recorded', leadMailbox };
}

/**
 * The lead mailbox a spawn names: the explicit `--lead-mbx`, else the
 * project's recorded `orchestrate.leadMailbox.name`, else none.
 *
 * @param projectRoot - Project root.
 * @param explicit - Mailbox given on the command line.
 * @returns A valid mailbox name, or `undefined`.
 */
export async function resolveLeadMailbox(
  projectRoot: string,
  explicit?: string,
): Promise<string | undefined> {
  if (explicit) return explicit;
  const name = (await loadConfig(projectRoot)).orchestrate?.leadMailbox?.name ?? '';
  // The name is printed into the prompt, so a hand-edited value must still be a plain name.
  return MBX_NAME.test(name) ? name : undefined;
}
