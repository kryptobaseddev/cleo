/**
 * AgentMBX adapter (T14379): the one core path to the `agentmbx` CLI.
 *
 * Every call shells out with an argv array (never a shell string) and never
 * spawns `agentmbx mcp` or touches mbx processes. Nothing throws: an absent
 * CLI or a failed call returns `{ ok: false, warning }`, so callers fail
 * closed and surface the warning. The process runner is injected, so tests
 * drive a fake CLI.
 *
 * Callers: `cleo init` and `cleo upgrade` record the lead mailbox
 * ({@link ensureLeadMailbox} — `init` refuses on an initialized project, so
 * `upgrade` is the non-destructive verb for it),
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
import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import { loadConfig, setConfigValue } from '../config.js';
import { CleoError } from '../errors.js';
import { getLogger } from '../logger.js';

/** AgentMBX 0.5.58 `envelope.NAME_RE`: 2–40 lowercase letters, digits or hyphens. */
export const MBX_NAME = /^[a-z0-9][a-z0-9-]{1,39}$/;

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
   * Delivery key; a retry with the same key is delivered once. Pass one for
   * retry safety; without it no key is sent, so repeats are delivered.
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
  /** Registered role, when reported by AgentMBX. */
  role?: string | null;
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
  /** Send one message; resolves with the message id, when printed. */
  send(input: MbxSendInput): Promise<MbxOutcome<{ id: string | null }>>;
  /** Unread messages for a mailbox. */
  inbox(as: string, session?: MbxSession): Promise<MbxOutcome<MbxInboxMessage[]>>;
  /** Claim a mailbox for a provider session. */
  claim(name: string, session: Required<MbxSession>): Promise<MbxOutcome<MbxIdentityStatus>>;
  /** The identity a provider session holds. */
  status(session: MbxSession): Promise<MbxOutcome<MbxIdentityStatus>>;
  /** Live holder of a registered mailbox in this project, or null. */
  holder(name: string, projectRoot: string): Promise<MbxOutcome<Required<MbxSession> | null>>;
  /** Release the mailbox a provider session holds (a lead's exit or reap, T14363). */
  release(session: Required<MbxSession>): Promise<MbxOutcome<MbxIdentityStatus>>;
}

/**
 * Real runner: `execFile('agentmbx', args)` with a 15 s timeout. The default
 * client uses it unless `CLEO_AGENTMBX_DISABLE=1` (set by `vitest.setup.ts`,
 * so no test reaches a real install).
 */
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
    role: str(identity, 'role') || null,
    unread: typeof unread === 'number' ? unread : 0,
  };
}

/** Runner used when `CLEO_AGENTMBX_DISABLE=1`: behaves as if agentmbx is absent. */
const disabledRunner: MbxRunner = async () => ({
  missing: true,
  exitCode: null,
  stdout: '',
  stderr: '',
});

/**
 * Create the adapter.
 *
 * @param runner - Process runner. Default {@link runAgentMbx}, or an absent
 *   CLI when `CLEO_AGENTMBX_DISABLE=1`.
 * @returns An {@link AgentMbxClient} that never throws.
 * @example
 * ```ts
 * const mbx = createAgentMbxClient();
 * const sent = await mbx.send({ as: 'w1', to: 'proj-lead', subject: 'done', body: 'T1 done' });
 * if (!sent.ok) log.warn(sent.warning);
 * ```
 */
export function createAgentMbxClient(runner?: MbxRunner): AgentMbxClient {
  const call = async (args: string[]): Promise<MbxOutcome<string>> => {
    const run =
      runner ?? (process.env['CLEO_AGENTMBX_DISABLE'] === '1' ? disabledRunner : runAgentMbx);
    const r = await run(args);
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
        ...(input.idempotencyKey ? ['--idempotency-key', input.idempotencyKey] : []),
        '--json',
      ]);
      if (!r.ok) return r;
      const rec = asRecord(parseJson(r.value));
      const id = str(rec, 'id') || str(asRecord(rec?.['data']), 'id') || null;
      return { ok: true, value: { id } };
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
      // A positional: a name like `--all` would be parsed as a flag.
      if (!MBX_NAME.test(name))
        return { ok: false, warning: `invalid AgentMBX mailbox name: ${name}` };
      const r = await call(['identity', 'claim', name, ...sessionArgs(session), '--json']);
      return r.ok ? { ok: true, value: parseIdentity(r.value) } : r;
    },
    async release(session) {
      const r = await call(['identity', 'release', ...sessionArgs(session), '--json']);
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
    async holder(name, projectRoot) {
      if (!MBX_NAME.test(name))
        return { ok: false, warning: `invalid AgentMBX mailbox name: ${name}` };
      const r = await call(['identity', 'list', '--project', projectRoot, '--json']);
      if (!r.ok) return r;
      const rows = asRecord(parseJson(r.value))?.['identities'];
      const row = (Array.isArray(rows) ? rows : [])
        .map(asRecord)
        .find(
          (row) =>
            str(row, 'name') === name &&
            row?.['state'] === 'held' &&
            row?.['registered'] === true &&
            row?.['retired'] === false,
        );
      const holder = asRecord(row?.['holder']);
      const cli = str(holder, 'cli');
      const session = str(holder, 'session_id');
      return { ok: true, value: cli && session ? { cli, session } : null };
    },
  };
}

/**
 * A registerable project or epic mailbox, capped at AgentMBX's 40 characters.
 * The hash covers untruncated inputs so normalization and truncation retain
 * distinct project/epic identities.
 *
 * @param projectName - Project display name.
 * @param projectId - Portable project id.
 * @param epicId - Optional epic id for an independent coordinator mailbox.
 * @returns A valid {@link MBX_NAME} ending in a 12-digit hash and `-lead`.
 */
export function leadMailboxName(projectName: string, projectId: string, epicId?: string): string {
  const slug = projectName
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const epic = epicId
    ? `-${epicId
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .slice(0, 12)}`
    : '';
  const hash = createHash('sha256')
    .update(JSON.stringify([projectName, projectId, epicId ?? null]))
    .digest('hex')
    .slice(0, 12);
  const suffix = `${epic}-${hash}-lead`;
  return `${(slug || 'project').slice(0, 40 - suffix.length)}${suffix}`;
}

/** Provider CLI the lead claims from; `CLEO_HOOK_PROVIDER`, else `claude`. */
function detectProviderCli(env: NodeJS.ProcessEnv): string {
  // shortcut: one env hint, else `claude`; upgrade when spawn records the lead's provider.
  return env['CLEO_HOOK_PROVIDER'] || 'claude';
}

/** Result of {@link ensureLeadMailbox}. */
export type EnsureLeadMailboxResult =
  | { action: 'recorded' | 'kept'; leadMailbox: LeadMailbox }
  | { action: 'skipped'; warning: string }
  | { action: 'disabled' };

/**
 * Record the project's lead mailbox in project config (`cleo init` and
 * `cleo upgrade`, T14448). It runs
 * only with `orchestrate.leadWorker.v1` on (otherwise no probe, `disabled`).
 * With `agentmbx` absent it writes nothing and returns a warning; an existing
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
  const orchestrate = (await loadConfig(projectRoot)).orchestrate;
  if (orchestrate?.leadWorker?.v1 !== true) return { action: 'disabled' };
  const existing = orchestrate.leadMailbox;
  if (existing && MBX_NAME.test(existing.name)) return { action: 'kept', leadMailbox: existing };
  if (!(await client.available())) {
    return {
      action: 'skipped',
      warning:
        'AgentMBX: agentmbx is not installed, so no lead mailbox was recorded. Install it and run `cleo upgrade` to give spawned workers a default lead mailbox.',
    };
  }
  const leadMailbox: LeadMailbox = {
    name: leadMailboxName(project.projectName, project.projectId),
    projectId: project.projectId,
    cli: detectProviderCli(env),
  };
  await setConfigValue('orchestrate.leadMailbox', leadMailbox, projectRoot);
  return { action: 'recorded', leadMailbox };
}

/**
 * Resolve a worker report destination only while AgentMBX confirms a live
 * holder. The guarded lead runner supplies its epic mailbox through the
 * environment; manual callers can name a held mailbox with `--lead-mbx`.
 *
 * @param projectRoot - Project root.
 * @param explicit - Mailbox given on the command line.
 * @param client - AgentMBX adapter.
 * @returns A valid mailbox name, or `undefined`.
 */
export async function resolveLeadMailbox(
  projectRoot: string,
  explicit?: string,
  client: AgentMbxClient = createAgentMbxClient(),
): Promise<string | undefined> {
  if (explicit && !MBX_NAME.test(explicit)) {
    // @sync-invariant none:input-shape explicit report destinations must be registerable mailbox names
    throw new CleoError(ExitCode.VALIDATION_ERROR, 'Invalid AgentMBX mailbox name', {
      codeName: 'E_LEAD_MAILBOX_INVALID',
      fix: 'Use a 2–40 character lowercase mailbox name containing only letters, digits and hyphens, starting with a letter or digit.',
    });
  }
  const orchestrate = (await loadConfig(projectRoot)).orchestrate;
  const name =
    explicit ??
    (orchestrate?.leadWorker?.v1 === true
      ? (process.env['CLEO_LEAD_MAILBOX'] ?? orchestrate.leadMailbox?.name)
      : undefined);
  if (!name || !MBX_NAME.test(name)) return undefined;
  const holder = await client.holder(name, projectRoot);
  const status = holder.ok && holder.value ? await client.status(holder.value) : null;
  if (status?.ok && status.value.name === name && status.value.state === 'bound') return name;
  if (explicit) {
    // @sync-invariant none:local-only a report destination needs a live AgentMBX holder
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `AgentMBX does not confirm a live holder of ${name}`,
      {
        codeName: 'E_LEAD_MAILBOX_UNHELD',
        fix: `In the lead session use mbx_identity {"action":"claim","name":"${name}"}; if absent, use mbx_identity {"action":"register","name":"${name}","role":"lead"}. Check agentmbx identity list --project ${JSON.stringify(projectRoot)} --json before retrying.`,
      },
    );
  }
  getLogger('agentmbx').warn(
    { mailbox: name },
    'Lead mailbox has no verified holder; omitted from worker prompts. In the lead session, claim or register this name with mbx_identity before dispatch.',
  );
  return undefined;
}
