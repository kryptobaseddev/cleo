/**
 * CLI session command group — manage work sessions.
 *
 * Exposes all session operations as native citty subcommands:
 *
 *   cleo session start            — start a new session
 *   cleo session end / stop       — end the current session
 *   cleo session handoff          — show handoff data from most recent ended session
 *   cleo session status           — show current session status
 *   cleo session resume           — resume an existing session
 *   cleo session find             — find sessions (lightweight discovery)
 *   cleo session list             — list sessions
 *   cleo session gc               — garbage collect old sessions
 *   cleo session show             — show full details for a session
 *   cleo session context-drift    — detect context drift in the current session
 *   cleo session suspend          — suspend an active session
 *   cleo session record-assumption— record an assumption made during the session
 *   cleo session record-decision  — record a decision made during the session
 *   cleo session decision-log     — show decisions recorded in a session
 *
 * @task T4463
 * @epic T4454
 */

import { ExitCode } from '@cleocode/contracts';
import { defineCommand, showUsage } from 'citty';
import { dispatchFromCli, dispatchRaw, handleRawError } from '../../dispatch/adapters/cli.js';
import { cliOutput } from '../renderers/index.js';

/** cleo session start — start a new session */
const startCommand = defineCommand({
  meta: { name: 'start', description: 'Start a new session' },
  args: {
    scope: {
      type: 'string',
      description: 'Session scope (epic:T### or global)',
      required: true,
    },
    name: {
      type: 'string',
      description: 'Session name',
      required: true,
    },
    'auto-start': {
      type: 'boolean',
      description: 'Auto-start on first available task',
    },
    'auto-focus': {
      type: 'boolean',
      description: 'Auto-focus on first available task (alias for --auto-start)',
    },
    focus: {
      type: 'string',
      description: 'Set initial task to work on',
    },
    agent: {
      type: 'string',
      description: 'Agent identifier',
    },
    grade: {
      type: 'boolean',
      description: 'Enable full query+mutation audit logging for behavioral grading',
    },
    'owner-auth': {
      type: 'boolean',
      description:
        'Prompt for a password and store a session HMAC token for owner-override authentication (T1118 L4a)',
    },
  },
  async run({ args }) {
    // T1118 L4a — if --owner-auth is set, prompt for a password and derive the HMAC token.
    let ownerAuthToken: string | undefined;
    if (args['owner-auth']) {
      ownerAuthToken = await promptOwnerAuthPassword(args.name ?? 'session');
      if (!ownerAuthToken) {
        process.stderr.write('[cleo] --owner-auth: password prompt cancelled.\n');
        process.exit(ExitCode.GENERAL);
      }
    }

    await dispatchFromCli(
      'mutate',
      'session',
      'start',
      {
        scope: args.scope,
        name: args.name,
        autoStart: (args['auto-start'] || args['auto-focus']) as boolean | undefined,
        focus: args.focus as string | undefined,
        grade: args.grade as boolean | undefined,
        ownerAuthToken,
      },
      { command: 'session', operation: 'session.start' },
    );
  },
});

/**
 * Prompt the owner for a password via TTY readline and derive the HMAC token.
 *
 * @param sessionName - Session name used for display purposes.
 * @returns The derived HMAC token, or null if the user cancelled.
 *
 * @task T1118
 * @task T1123
 */
async function promptOwnerAuthPassword(sessionName: string): Promise<string | null> {
  // T1118 L4c — must be a TTY.
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    process.stderr.write(
      '[cleo] --owner-auth requires an interactive TTY. ' +
        'stdin.isTTY or stderr.isTTY is false.\n',
    );
    return null;
  }

  const { createInterface } = await import('node:readline');
  const { deriveOwnerAuthToken } = await import('@cleocode/core/internal');

  // Use a temporary session ID placeholder — the real session ID comes from
  // the dispatch response. We derive a token here keyed to a stable nonce
  // that gets stored alongside the session. We use the session name as the
  // "sessionId" for the HMAC derivation at this stage; the domain handler
  // will replace it with the real session ID.
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });

  process.stderr.write(`[cleo] Enter owner-auth password for session "${sessionName}": `);

  const password = await new Promise<string>((resolve) => {
    // Disable echo if we can.
    if (
      (process.stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void }).setRawMode
    ) {
      (process.stdin as NodeJS.ReadStream & { setRawMode: (mode: boolean) => void }).setRawMode(
        true,
      );
    }
    let pw = '';
    process.stdin.on('data', function onData(char: Buffer) {
      const ch = char.toString('utf8');
      if (ch === '\n' || ch === '\r') {
        process.stdin.removeListener('data', onData);
        process.stdin.pause();
        if (
          (process.stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void }).setRawMode
        ) {
          (process.stdin as NodeJS.ReadStream & { setRawMode: (mode: boolean) => void }).setRawMode(
            false,
          );
        }
        process.stderr.write('\n');
        resolve(pw);
      } else if (ch === '\u0003') {
        // Ctrl+C
        process.stderr.write('\n[cleo] Cancelled.\n');
        resolve('');
      } else if (ch === '\u007f' || ch === '\b') {
        pw = pw.slice(0, -1);
      } else {
        pw += ch;
      }
    });
    process.stdin.resume();
  });

  rl.close();

  if (!password) return null;

  // Derive the HMAC token using sessionName as a temporary key.
  // The dispatch handler will re-derive with the real session ID.
  const token = deriveOwnerAuthToken(sessionName, password);
  return token;
}

/** cleo session end — end the current session */
const endCommand = defineCommand({
  meta: { name: 'end', description: 'End the current session' },
  args: {
    session: {
      type: 'string',
      description: 'Specific session ID to stop',
    },
    note: {
      type: 'string',
      description: 'Stop note',
    },
    'next-action': {
      type: 'string',
      description: 'Suggested next action',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'session',
      'end',
      {
        note: args.note as string | undefined,
        nextAction: args['next-action'] as string | undefined,
      },
      { command: 'session', operation: 'session.end' },
    );
  },
});

/** cleo session handoff — show handoff data from the most recent ended session */
const handoffCommand = defineCommand({
  meta: { name: 'handoff', description: 'Show handoff data from the most recent ended session' },
  args: {
    scope: {
      type: 'string',
      description: 'Filter by scope (epic:T### or global)',
    },
  },
  async run({ args }) {
    const scope = args.scope as string | undefined;

    const response = await dispatchRaw('query', 'session', 'handoff.show', {
      scope,
    });

    if (!response.success) {
      handleRawError(response, { command: 'session handoff', operation: 'session.handoff.show' });
    }

    const data = response.data as { sessionId: string; handoff: Record<string, unknown> } | null;

    if (!data?.handoff) {
      cliOutput(
        { handoff: null },
        {
          command: 'session handoff',
          message: 'No handoff data available',
          operation: 'session.handoff.show',
        },
      );
      process.exit(ExitCode.NO_DATA);
      return;
    }

    const { sessionId, handoff } = data;

    // Format the handoff data for display
    const formattedHandoff = {
      sessionId,
      lastTask: handoff.lastTask ?? 'None',
      tasksCompleted: handoff.tasksCompleted ?? [],
      tasksCreated: handoff.tasksCreated ?? [],
      decisionsRecorded: handoff.decisionsRecorded ?? 0,
      nextSuggested: handoff.nextSuggested ?? [],
      openBlockers: handoff.openBlockers ?? [],
      openBugs: handoff.openBugs ?? [],
      ...(handoff.note ? { note: handoff.note } : {}),
      ...(handoff.nextAction ? { nextAction: handoff.nextAction } : {}),
    };

    cliOutput(
      { handoff: formattedHandoff },
      { command: 'session handoff', operation: 'session.handoff.show' },
    );
  },
});

/** cleo session status — show current session status */
const statusCommand = defineCommand({
  meta: { name: 'status', description: 'Show current session status' },
  async run() {
    const response = await dispatchRaw('query', 'session', 'status');
    if (!response.success) {
      handleRawError(response, { command: 'session', operation: 'session.status' });
    }
    const data = response.data as Record<string, unknown> | null;
    if (!data || data['session'] === null || (data['session'] === undefined && !data['id'])) {
      cliOutput(
        { session: null },
        { command: 'session', message: 'No active session', operation: 'session.status' },
      );
      process.exit(ExitCode.NO_DATA);
      return;
    }
    cliOutput({ session: data }, { command: 'session', operation: 'session.status' });
  },
});

/** cleo session resume — resume an existing session */
const resumeCommand = defineCommand({
  meta: { name: 'resume', description: 'Resume an existing session' },
  args: {
    sessionId: {
      type: 'positional',
      description: 'Session ID to resume',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'session',
      'resume',
      {
        sessionId: args.sessionId,
      },
      { command: 'session', operation: 'session.resume' },
    );
  },
});

/** cleo session find — find sessions (lightweight discovery, minimal fields, low context cost) */
const findCommand = defineCommand({
  meta: {
    name: 'find',
    description: 'Find sessions (lightweight discovery — minimal fields, low context cost)',
  },
  args: {
    status: {
      type: 'string',
      description: 'Filter by status (active|ended|orphaned)',
    },
    scope: {
      type: 'string',
      description: 'Filter by scope (e.g. "epic:T001" or "global")',
    },
    query: {
      type: 'string',
      description: 'Fuzzy match on session name or ID',
    },
    limit: {
      type: 'string',
      description: 'Max results',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'session',
      'find',
      {
        status: args.status as string | undefined,
        scope: args.scope as string | undefined,
        query: args.query as string | undefined,
        limit: args.limit ? Number.parseInt(args.limit, 10) : undefined,
      },
      { command: 'session', operation: 'session.find' },
    );
  },
});

/** cleo session list — list sessions */
const listCommand = defineCommand({
  meta: { name: 'list', description: 'List sessions' },
  args: {
    status: {
      type: 'string',
      description: 'Filter by status (active|ended|orphaned)',
    },
    limit: {
      type: 'string',
      description: 'Max results',
    },
    offset: {
      type: 'string',
      description: 'Skip first n results',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'session',
      'list',
      {
        status: args.status as string | undefined,
        limit: args.limit ? Number.parseInt(args.limit, 10) : undefined,
        offset: args.offset ? Number.parseInt(args.offset, 10) : undefined,
      },
      { command: 'session', operation: 'session.list' },
    );
  },
});

/** cleo session gc — garbage collect old sessions */
const gcCommand = defineCommand({
  meta: { name: 'gc', description: 'Garbage collect old sessions' },
  args: {
    'max-age': {
      type: 'string',
      description: 'Max age in days for active sessions',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'session',
      'gc',
      {
        maxAgeDays: args['max-age'] ? Number.parseInt(args['max-age'], 10) : undefined,
      },
      { command: 'session', operation: 'session.gc' },
    );
  },
});

/** cleo session show — show full details for a session */
const showCommand = defineCommand({
  meta: {
    name: 'show',
    description: 'Show full details for a session (absorbs debrief.show via --include debrief)',
  },
  args: {
    sessionId: {
      type: 'positional',
      description: 'Session ID to show',
      required: true,
    },
    include: {
      type: 'string',
      description: 'Include extra data (debrief)',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'session',
      'show',
      {
        sessionId: args.sessionId,
        include: args.include as string | undefined,
      },
      { command: 'session', operation: 'session.show' },
    );
  },
});

/** cleo session context-drift — detect context drift in the current or specified session */
const contextDriftCommand = defineCommand({
  meta: {
    name: 'context-drift',
    description: 'Detect context drift in the current or specified session',
  },
  args: {
    'session-id': {
      type: 'string',
      description: 'Session ID to check (defaults to active session)',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'session',
      'context.drift',
      {
        sessionId: args['session-id'] as string | undefined,
      },
      { command: 'session', operation: 'session.context.drift' },
    );
  },
});

/** cleo session suspend — suspend an active session (pause without ending) */
const suspendCommand = defineCommand({
  meta: { name: 'suspend', description: 'Suspend an active session (pause without ending)' },
  args: {
    sessionId: {
      type: 'positional',
      description: 'Session ID to suspend',
      required: true,
    },
    reason: {
      type: 'string',
      description: 'Reason for suspension',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'session',
      'suspend',
      {
        sessionId: args.sessionId,
        reason: args.reason as string | undefined,
      },
      { command: 'session', operation: 'session.suspend' },
    );
  },
});

/** cleo session record-assumption — record an assumption made during the current session */
const recordAssumptionCommand = defineCommand({
  meta: {
    name: 'record-assumption',
    description: 'Record an assumption made during the current session',
  },
  args: {
    assumption: {
      type: 'string',
      description: 'Assumption text',
      required: true,
    },
    confidence: {
      type: 'string',
      description: 'Confidence level (high|medium|low)',
      required: true,
    },
    'session-id': {
      type: 'string',
      description: 'Session ID (defaults to active session)',
    },
    'task-id': {
      type: 'string',
      description: 'Task ID the assumption relates to',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'session',
      'record.assumption',
      {
        sessionId: args['session-id'] as string | undefined,
        taskId: args['task-id'] as string | undefined,
        assumption: args.assumption,
        confidence: args.confidence,
      },
      { command: 'session', operation: 'session.record.assumption' },
    );
  },
});

/** cleo session record-decision — record a decision made during the current session */
const recordDecisionCommand = defineCommand({
  meta: {
    name: 'record-decision',
    description: 'Record a decision made during the current session',
  },
  args: {
    'session-id': {
      type: 'string',
      description: 'Session ID (defaults to active session)',
    },
    'task-id': {
      type: 'string',
      description: 'Task ID the decision relates to',
      required: true,
    },
    decision: {
      type: 'string',
      description: 'Decision text',
      required: true,
    },
    rationale: {
      type: 'string',
      description: 'Rationale for the decision',
      required: true,
    },
    alternatives: {
      type: 'string',
      description: 'Alternatives considered',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'session',
      'record.decision',
      {
        sessionId: args['session-id'] as string | undefined,
        taskId: args['task-id'],
        decision: args.decision,
        rationale: args.rationale,
        alternatives: args.alternatives as string | undefined,
      },
      { command: 'session', operation: 'session.record.decision' },
    );
  },
});

/** cleo session decision-log — show decisions recorded in a session */
const decisionLogCommand = defineCommand({
  meta: { name: 'decision-log', description: 'Show decisions recorded in a session' },
  args: {
    'session-id': {
      type: 'string',
      description: 'Session ID to filter by',
    },
    'task-id': {
      type: 'string',
      description: 'Task ID to filter by',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'session',
      'decision.log',
      {
        sessionId: args['session-id'] as string | undefined,
        taskId: args['task-id'] as string | undefined,
      },
      { command: 'session', operation: 'session.decision.log' },
    );
  },
});

/**
 * Root session command group — registers all session management subcommands.
 *
 * `stop` is an alias for `end` — both keys point to the same CommandDef.
 * Default run() checks if no subcommand was given and falls through to status display.
 * Dispatches to `session.*` registry operations.
 */
export const sessionCommand = defineCommand({
  meta: { name: 'session', description: 'Manage work sessions' },
  subCommands: {
    start: startCommand,
    end: endCommand,
    stop: endCommand,
    handoff: handoffCommand,
    status: statusCommand,
    resume: resumeCommand,
    find: findCommand,
    list: listCommand,
    gc: gcCommand,
    show: showCommand,
    'context-drift': contextDriftCommand,
    suspend: suspendCommand,
    'record-assumption': recordAssumptionCommand,
    'record-decision': recordDecisionCommand,
    'decision-log': decisionLogCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
