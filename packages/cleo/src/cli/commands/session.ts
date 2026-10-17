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
import { cliError, cliOutput, humanWarn } from '../renderers/index.js';

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
      description: 'Set initial task to work on (alias for --start-task)',
    },
    'start-task': {
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
        'Prompt for a password and store an owner-auth verifier, used by `cleo config owner-enroll` and the override cap setting (T1118, T13787)',
    },
    owner: {
      type: 'boolean',
      description:
        'Mark this session as the owner (T13790): only it may use CLEO_OWNER_OVERRIDE. No password; refused without an interactive terminal or with CLEO_AGENT_ROLE set',
    },
  },
  async run({ args }) {
    // T13790: the password-free owner mark, interactive only; never from env.
    let ownerMark = false;
    if (args.owner) {
      const { ownerMarkRefusal } = await import('@cleocode/core/internal');
      const refusal = ownerMarkRefusal();
      if (refusal) {
        cliError(
          refusal,
          ExitCode.GENERAL_ERROR,
          { name: 'E_OVERRIDE_NOT_OWNER' },
          { operation: 'session.start' },
        );
        process.exit(ExitCode.GENERAL_ERROR);
      }
      ownerMark = true;
    }
    // T1118 L4a — if --owner-auth is set, prompt for a password and derive the HMAC token.
    let ownerAuthToken: string | null | undefined;
    if (args['owner-auth']) {
      ownerAuthToken = await promptOwnerAuthPassword(args.name ?? 'session');
      if (!ownerAuthToken) {
        cliError(
          '--owner-auth: password prompt cancelled.',
          ExitCode.GENERAL_ERROR,
          { name: 'E_PROMPT_CANCELLED' },
          { operation: 'session.start' },
        );
        process.exit(ExitCode.GENERAL_ERROR);
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
        // CLI-level alias normalization: --focus and --start-task both map to startTask (ADR-057 D2)
        startTask: (args['start-task'] ?? args.focus) as string | undefined,
        grade: args.grade as boolean | undefined,
        ownerAuthToken: await ownerSessionToken(ownerMark, ownerAuthToken ?? null),
        // T9975: per-agent handle for multi-agent isolation
        agentHandle: args.agent as string | undefined,
      },
      { command: 'session', operation: 'session.start' },
    );
  },
});

/**
 * The stored owner credential: the owner mark (`--owner`), the `--owner-auth`
 * verifier, or both as `<mark>|<verifier>` (T13790).
 */
async function ownerSessionToken(
  mark: boolean,
  verifier: string | null,
): Promise<string | undefined> {
  if (!mark) return verifier ?? undefined;
  const { OWNER_SESSION_MARK } = await import('@cleocode/core/internal');
  return verifier ? `${OWNER_SESSION_MARK}|${verifier}` : OWNER_SESSION_MARK;
}

/**
 * Prompt the owner for a password via TTY readline and derive the stored
 * owner-auth verifier (scrypt, T13787).
 *
 * @param sessionName - Session name used for display purposes.
 * @returns The verifier, or null if the user cancelled.
 *
 * @task T1118
 * @task T1123
 * @task T13787
 */
async function promptOwnerAuthPassword(sessionName: string): Promise<string | null> {
  const { readOwnerPassword } = await import('../lib/owner-password.js');
  const password = await readOwnerPassword(`session "${sessionName}"`, 'session.start');
  if (!password) return null;
  // T13787: a slow scrypt verifier, not the bare HMAC token (offline brute force).
  const { createOwnerAuthVerifier } = await import('@cleocode/core/internal');
  return createOwnerAuthVerifier(password);
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
    'emit-markdown': {
      type: 'string',
      description:
        'Optional path to write a derived markdown VIEW of the handoff (one-way; never read back by CLEO). Source of truth remains tasks.db + brain.db. Use `cleo briefing` to resume context. (T1593)',
    },
  },
  async run({ args }) {
    const emitMarkdownPath = args['emit-markdown'] as string | undefined;

    if (emitMarkdownPath) {
      // Capture the dispatch result so we can render the persisted handoff
      // to disk after the session is ended. Markdown is a derived view —
      // never re-ingested by CLEO. (T1593)
      const response = await dispatchRaw('mutate', 'session', 'end', {
        note: args.note as string | undefined,
        nextAction: args['next-action'] as string | undefined,
        // T12500: an unbound terminal names its target explicitly.
        ...(args.session ? { sessionId: args.session as string } : {}),
      });

      if (!response.success) {
        handleRawError(response, { command: 'session end', operation: 'session.end' });
      }

      try {
        const handoffResp = await dispatchRaw('query', 'session', 'handoff.show', {});
        const handoffData = handoffResp.success
          ? (handoffResp.data as
              | { sessionId: string; handoff: Record<string, unknown> }
              | null
              | undefined)
          : null;
        if (handoffData?.handoff) {
          const { emitHandoffMarkdown } = await import('@cleocode/core/internal');
          await emitHandoffMarkdown(
            emitMarkdownPath,
            handoffData.handoff as unknown as Parameters<typeof emitHandoffMarkdown>[1],
            { sessionId: handoffData.sessionId },
          );
        }
      } catch (err) {
        // Non-fatal: markdown emission is opt-in. Surface a warning to stderr.
        humanWarn(`[cleo] session end --emit-markdown failed: ${(err as Error).message}`);
      }

      cliOutput(response.data ?? {}, { command: 'session', operation: 'session.end' });
      return;
    }

    await dispatchFromCli(
      'mutate',
      'session',
      'end',
      {
        note: args.note as string | undefined,
        nextAction: args['next-action'] as string | undefined,
        // T12500: an unbound terminal names its target explicitly.
        ...(args.session ? { sessionId: args.session as string } : {}),
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
      // GH #1277 — mirrors computeHandoff: `null` is a recorded answer, an
      // absent key is not. Kept in step with packages/core/src/sessions/handoff.ts.
      note: handoff.note ?? null,
      noteChars: handoff.noteChars ?? (typeof handoff.note === 'string' ? handoff.note.length : 0),
      nextAction: handoff.nextAction ?? null,
      nextActionChars:
        handoff.nextActionChars ??
        (typeof handoff.nextAction === 'string' ? handoff.nextAction.length : 0),
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
    /**
     * T9975: surface all per-agent columns (agent, scope, lastActivity).
     * When set, the result includes agentHandle, scopeKind, scopeId, and
     * lastActivity for each session — useful for multi-agent dashboards.
     */
    all: {
      type: 'boolean',
      description:
        'Show all columns including per-agent fields (agent, scope, lastActivity) — T9975',
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
        all: args.all as boolean | undefined,
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

/**
 * cleo session drift — detect file-scope drift for the active session (T1594).
 *
 * Project-agnostic: compares `git status --porcelain` against the active
 * task's declared `files[]`. Distinct from `session context-drift`, which
 * measures task-completion drift across the task graph.
 */
const driftCommand = defineCommand({
  meta: {
    name: 'drift',
    description: 'Detect file-scope drift for the active session (project-agnostic)',
  },
  args: {
    'audit-scope': { type: 'string', description: 'Audit log scope (global|local)' },
  },
  async run({ args }) {
    const { detectSessionDrift, getProjectRoot } = await import('@cleocode/core');
    const projectRoot = await getProjectRoot();
    const scope = (args['audit-scope'] === 'local' ? 'local' : 'global') as 'global' | 'local';
    const report = await detectSessionDrift({ projectRoot, auditScope: scope });
    cliOutput(report, { command: 'session drift', operation: 'session.drift' });
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
 * cleo session adopt — rebind env to a specific session (T9975).
 *
 * In multi-agent setups, an agent may need to work within the context of
 * another agent's session (e.g. handoff between worktree agents).  This
 * command prints the shell export command required to set `CLEO_SESSION_ID`,
 * which the caller can eval to bind subsequent `cleo briefing` and focus
 * operations to the target session.
 *
 * Usage:
 *   eval $(cleo session adopt <id>)
 *
 * After eval, `CLEO_SESSION_ID` is set in the calling shell and all cleo
 * commands that honour env-precedence (briefing, focus, etc.) will use the
 * adopted session.
 *
 * @task T9975
 */
const adoptCommand = defineCommand({
  meta: {
    name: 'adopt',
    description: 'Rebind env to a specific session — prints export command to eval (T9975)',
  },
  args: {
    sessionId: {
      type: 'positional',
      description: 'Session ID to adopt',
      required: true,
    },
  },
  async run({ args }) {
    const response = await dispatchRaw('mutate', 'session', 'adopt', {
      sessionId: args.sessionId,
    });

    if (!response.success) {
      handleRawError(response, { command: 'session adopt', operation: 'session.adopt' });
      return;
    }

    const data = response.data as { sessionId: string; exportCommand: string } | null;
    if (data?.exportCommand) {
      // Output ONLY the export command so the caller can eval it:
      //   eval $(cleo session adopt <id>)
      process.stdout.write(`${data.exportCommand}\n`);
    } else {
      cliOutput(data ?? {}, { command: 'session adopt', operation: 'session.adopt' });
    }
  },
});

/**
 * cleo session lint — agent-accountability harness (T9797).
 *
 * Scans a Claude Code-style session transcript (`*.jsonl`) for `Write` /
 * `Edit` / `MultiEdit` tool calls whose `file_path` lands under a
 * `rawMdPaths` entry whose owning DocKind has `rawMdAllowed: false` in
 * `.cleo/canon.yml`. Returns a LAFS envelope whose `data` is a
 * `SessionLintResult` enumerating every violation.
 *
 * Use this AFTER the fact (the PR-time CI gate is `cleo check canon
 * docs`) to audit which agents bypassed SSoT on historical transcripts.
 *
 * @task T9797 (E-DOCS-REAL-WORLD-VALIDATION)
 * @see ADR-076 — Canonical Docs SSoT
 */
const lintCommand = defineCommand({
  meta: {
    name: 'lint',
    description:
      'Flag raw-md writes to canonical doc paths in a session transcript (T9797 · agent-accountability)',
  },
  args: {
    transcript: {
      type: 'string',
      description: 'Absolute path to the *.jsonl transcript to scan',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'session',
      'lint',
      { transcript: args.transcript as string },
      { command: 'session', operation: 'session.lint' },
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
    drift: driftCommand,
    suspend: suspendCommand,
    'record-assumption': recordAssumptionCommand,
    'record-decision': recordDecisionCommand,
    'decision-log': decisionLogCommand,
    lint: lintCommand,
    // T9975 — per-agent session isolation
    adopt: adoptCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
