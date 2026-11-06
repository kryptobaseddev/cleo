/**
 * `cleo ask` / `cleo ask answer` — park a task on an owner question, continue
 * with other work, and resume when the owner answers (T14302).
 *
 * - {@link askOwner} stores the question as a proposed D-record (the
 *   `hitl.request` shape: question, 2-4 options with what each does, the
 *   recommended one), then blocks the task with the `owner-decision` label.
 *   `cleo next` only picks `pending` tasks, so the asker takes the next task
 *   instead of stopping.
 * - {@link answerOwner} stores the owner's choice as an accepted D-record that
 *   supersedes the question (`decidedBy: owner`) and returns the task to
 *   `pending`. The label is the only authority for the park: a task whose label
 *   was removed by hand is refused rather than silently unblocked.
 *
 * Who may answer (D11232): an owner-marked session answers directly. An agent
 * that put the question to the owner through its ask tool relays the answer
 * with `via: 'ask-tool'`; an agent acting on a signed mbx OWNER message relays
 * it with `via: 'mbx-owner'` and the message id. Both are audited with the
 * relaying session and agent. A relay from the session that asked is refused
 * only when that session has no ask tool: it cannot have asked the owner.
 *
 * @task T14302
 */

import { getProviderAskTool } from '@cleocode/caamp';
import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import { CleoError } from '../errors.js';
import { storeDecision } from '../memory/decisions.js';
import { getBrainAccessor } from '../store/memory-accessor.js';
import type { BrainDecisionRow } from '../store/schema/memory-schema.js';
import { updateTask } from './update.js';

/** Label that parks a task on an open owner question. */
export const OWNER_DECISION_LABEL = 'owner-decision';

/** `contextPhase` of a stored owner question. */
export const OWNER_QUESTION_PHASE = 'owner-question';

/** `contextPhase` of a stored owner answer. */
export const OWNER_ANSWER_PHASE = 'owner-answer';

/** Separator between an option's label and its description in `alternatives`. */
const OPTION_SEPARATOR = ' — ';

/** One selectable option of an owner question. */
export interface OwnerQuestionOption {
  /** Short label the owner selects. */
  readonly label: string;
  /** What happens if chosen, and its trade-off. */
  readonly description: string;
}

/** The `hitl.request` shape: a question, 2-4 options and the recommended one. */
export interface OwnerQuestionRequest {
  /** The question, as the owner will read it. */
  readonly question: string;
  /** 2-4 options, recommended first. */
  readonly options: readonly OwnerQuestionOption[];
  /** Label of the recommended option. */
  readonly recommended: string;
}

/** How an answer reached CLEO when the answering session is not the owner's. */
export type OwnerAnswerVia = 'ask-tool' | 'mbx-owner';

/** Input to {@link answerOwner}. */
export interface OwnerAnswerInput {
  /** The question's D-record id. */
  readonly decisionId: string;
  /** Label of the chosen option. */
  readonly option: string;
  /** Optional owner note kept with the answer. */
  readonly note?: string;
  /** Relay channel; omitted when the answering session is owner-marked. */
  readonly via?: OwnerAnswerVia;
  /** Signed mbx message id; required with `via: 'mbx-owner'`. */
  readonly source?: string;
}

/** An open owner question, as `cleo briefing` lists it. */
export interface OpenOwnerQuestion {
  /** The question's D-record id. */
  readonly decisionId: string;
  /** The parked task. */
  readonly taskId: string | null;
  /** The question text. */
  readonly question: string;
  /** Option labels, as asked. */
  readonly options: string[];
  /** When it was asked. */
  readonly askedAt: string;
}

/** An answered owner question, as `cleo briefing` lists it. */
export interface AnsweredOwnerQuestion {
  /** The answer's D-record id. */
  readonly decisionId: string;
  /** The task the answer resumed. */
  readonly taskId: string | null;
  /** The answer, as stored. */
  readonly answer: string;
  /** When it was answered. */
  readonly answeredAt: string;
}

/** Result of {@link askOwner}. */
export interface AskOwnerResult {
  /** The question's D-record id. */
  readonly decisionId: string;
  /** The parked task. */
  readonly taskId: string;
  /** What the asker does next. */
  readonly next: string;
}

/** Result of {@link answerOwner}. */
export interface AnswerOwnerResult {
  /** The answer's D-record id. */
  readonly decisionId: string;
  /** The question it answers. */
  readonly questionId: string;
  /** The resumed task, now `pending`. */
  readonly taskId: string;
  /** The chosen option's label. */
  readonly option: string;
  /** Who the answer is attributed to and how it arrived. */
  readonly answeredBy: {
    readonly via: OwnerAnswerVia | 'owner-session';
    readonly session: string | null;
  };
}

/** Process env shape read for the caller's session and harness. */
type Env = Readonly<Record<string, string | undefined>>;

/** Prefix of the asking-session line in a question's rationale. */
const ASKED_BY = 'Asked by session ';

/**
 * Validate a `hitl.request`-shaped question.
 *
 * @param request - The question to validate.
 * @throws CleoError(VALIDATION_ERROR) naming the first problem.
 */
function validateRequest(request: OwnerQuestionRequest): void {
  const problem = (() => {
    const strings = [request.question, request.recommended].concat(
      request.options.flatMap((o) => [o?.label, o?.description]),
    );
    if (strings.some((v) => typeof v !== 'string')) return 'every field must be a string';
    if (request.question.trim() === '') return 'the question is empty';
    if (request.options.length < 2 || request.options.length > 4)
      return `it has ${request.options.length} options; give 2-4`;
    const labels = request.options.map((o) => o.label.trim());
    if (labels.some((l) => l === '' || l.includes(OPTION_SEPARATOR)))
      return `every option needs a label without "${OPTION_SEPARATOR}"`;
    if (new Set(labels.map((l) => l.toLowerCase())).size !== labels.length)
      return 'option labels repeat';
    if (request.options.some((o) => o.description.trim() === ''))
      return 'every option needs a description of what happens and its trade-off';
    if (!labels.includes(request.recommended.trim()))
      return `recommended "${request.recommended}" is not one of the option labels`;
    return null;
  })();
  if (problem !== null) {
    // @sync-invariant none:input-shape a malformed owner question is refused before anything is written
    throw new CleoError(ExitCode.VALIDATION_ERROR, `Owner question refused: ${problem}`, {
      fix: 'Pass {"question","options":[{"label","description"}],"recommended"} with 2-4 options.',
    });
  }
}

/**
 * The ask tool of the harness this process runs in, or null (headless).
 *
 * Reads the provider rows of `TERMINAL_KEY_SOURCES`, the single table of
 * per-session harness env keys, and asks CAAMP for that provider's tool.
 *
 * @param env - Process env.
 * @returns The native ask tool's name, or null.
 */
export async function callerAskTool(env: Env = process.env): Promise<string | null> {
  const { TERMINAL_KEY_SOURCES } = await import('../sessions/terminal-identity.js');
  for (const row of TERMINAL_KEY_SOURCES) {
    if (row.kind !== 'provider' || !env[row.envVar]) continue;
    const tool = getProviderAskTool(row.origin);
    if (tool.status === 'native' && tool.toolName) return tool.toolName;
  }
  return null;
}

/**
 * Park a task on an owner question (`cleo ask`).
 *
 * @param projectRoot - Project root.
 * @param taskId - The task that cannot continue without the owner.
 * @param request - The question, its options and the recommended one.
 * @param env - Process env (session binding, agent id).
 * @returns The question's D-record id and what to do next.
 */
export async function askOwner(
  projectRoot: string,
  taskId: string,
  request: OwnerQuestionRequest,
  env: Env = process.env,
): Promise<AskOwnerResult> {
  validateRequest(request);
  const { getTaskAccessor } = await import('../store/data-accessor.js');
  const task = await (await getTaskAccessor(projectRoot)).loadSingleTask(taskId);
  if (task === null || task.status === 'done' || task.status === 'cancelled') {
    // @sync-invariant none:input-shape a missing or finished task is refused before the question is stored
    throw new CleoError(
      ExitCode.NOT_FOUND,
      `Task ${taskId} ${task === null ? 'not found' : `is ${task.status}`}; only open work can wait on the owner`,
    );
  }
  const { resolveBoundSessionId } = await import('../store/session-store.js');
  const session = await resolveBoundSessionId(projectRoot, env);
  const agent = env['CLEO_AGENT_ID'] ?? null;
  const askedAt = new Date().toISOString();
  const question = request.question.trim();
  const stored = await storeDecision(projectRoot, {
    type: 'process',
    // The timestamp keeps a re-asked question a new row, not an update of the old one.
    decision: `Owner question on ${taskId} (${askedAt}): ${question}`,
    rationale: [
      `Recommended: ${request.recommended.trim()}.`,
      `${ASKED_BY}${session ?? 'none'}${agent ? ` (agent ${agent})` : ''}.`,
    ].join(' '),
    confidence: 'medium',
    outcome: 'pending',
    alternatives: request.options.map(
      (o) => `${o.label.trim()}${OPTION_SEPARATOR}${o.description.trim()}`,
    ),
    contextTaskId: taskId,
    contextPhase: OWNER_QUESTION_PHASE,
    confirmationState: 'proposed',
    decidedBy: 'agent',
  });
  await updateTask(
    {
      taskId,
      status: 'blocked',
      addLabels: [OWNER_DECISION_LABEL],
      blockedBy: `owner decision ${stored.id}`,
    },
    projectRoot,
  );
  return {
    decisionId: stored.id,
    taskId,
    next: `${taskId} is parked until the owner answers ${stored.id}; run \`cleo next\` and continue with other work.`,
  };
}

/**
 * Record the owner's answer and resume the parked task (`cleo ask answer`).
 *
 * @param projectRoot - Project root.
 * @param input - The question id, the chosen option and how the answer arrived.
 * @param env - Process env (session binding, agent id, harness).
 * @returns The answer's D-record id and the resumed task.
 */
export async function answerOwner(
  projectRoot: string,
  input: OwnerAnswerInput,
  env: Env = process.env,
): Promise<AnswerOwnerResult> {
  const brain = await getBrainAccessor(projectRoot);
  const asked = await brain.getDecision(input.decisionId);
  if (asked === null || asked.contextPhase !== OWNER_QUESTION_PHASE) {
    // @sync-invariant none:input-shape an id that is not an owner question is refused before anything is written
    throw new CleoError(ExitCode.NOT_FOUND, `${input.decisionId} is not an owner question`, {
      fix: 'Run `cleo briefing`; its openQuestions list the ids to answer.',
    });
  }
  if (asked.confirmationState !== 'proposed') {
    // @sync-invariant none:input-shape an already answered question is refused before anything is written
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `${input.decisionId} is already ${asked.confirmationState}${asked.supersededBy ? ` by ${asked.supersededBy}` : ''}`,
    );
  }
  const options = parseOptions(asked);
  const chosen = options.find((o) => o.label.toLowerCase() === input.option.trim().toLowerCase());
  if (chosen === undefined) {
    // @sync-invariant none:input-shape an option the question did not offer is refused before anything is written
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `"${input.option}" is not an option of ${input.decisionId}`,
      {
        fix: `Choose one of: ${options.map((o) => o.label).join(', ')}.`,
      },
    );
  }
  const taskId = asked.contextTaskId;
  if (!taskId) {
    // @sync-invariant none:input-shape a question whose task is gone is refused before anything is written
    throw new CleoError(ExitCode.NOT_FOUND, `${input.decisionId} names no task to resume`);
  }

  const { resolveBoundSessionId, getSessionOwnerAuth } = await import('../store/session-store.js');
  const session = await resolveBoundSessionId(projectRoot, env);
  const agent = env['CLEO_AGENT_ID'] ?? null;
  await assertMayAnswer(projectRoot, input, asked, session, env, getSessionOwnerAuth);

  const { getTaskAccessor } = await import('../store/data-accessor.js');
  const task = await (await getTaskAccessor(projectRoot)).loadSingleTask(taskId);
  if (task === null) {
    // @sync-invariant none:input-shape a question whose task is gone is refused before anything is written
    throw new CleoError(ExitCode.NOT_FOUND, `Task ${taskId} of ${input.decisionId} not found`);
  }
  if (!(task.labels ?? []).some((l) => l.toLowerCase() === OWNER_DECISION_LABEL)) {
    // @sync-invariant none:input-shape a park whose label was removed by hand is refused before anything is written
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `${taskId} no longer carries the ${OWNER_DECISION_LABEL} label, so it is not parked on ${input.decisionId}`,
      {
        fix: `Check \`cleo show ${taskId}\`; ask again with \`cleo ask ${taskId}\` if the question is still open.`,
      },
    );
  }

  const via = input.via ?? 'owner-session';
  const relay = [
    `Answered via ${via}`,
    input.source ? ` (source ${input.source})` : '',
    `, recorded by session ${session ?? 'none'}${agent ? ` (agent ${agent})` : ''}.`,
  ].join('');
  const stored = await storeDecision(projectRoot, {
    type: asked.type,
    decision: `Owner answer to ${asked.id} on ${taskId}: ${chosen.label}`,
    rationale: [`${chosen.label}: ${chosen.description}.`, input.note?.trim(), relay]
      .filter((part) => part)
      .join(' '),
    confidence: 'high',
    outcome: 'success',
    contextTaskId: taskId,
    contextPhase: OWNER_ANSWER_PHASE,
    supersedes: asked.id,
    confirmationState: 'accepted',
    decidedBy: 'owner',
  });
  await updateTask(
    {
      taskId,
      status: 'pending',
      removeLabels: [OWNER_DECISION_LABEL],
      clearBlockedBy: true,
    },
    projectRoot,
  );
  return {
    decisionId: stored.id,
    questionId: asked.id,
    taskId,
    option: chosen.label,
    answeredBy: { via, session },
  };
}

/**
 * Refuse an answer the caller may not record (D11232).
 *
 * @param projectRoot - Project root.
 * @param input - The answer being recorded.
 * @param asked - The question's D-record.
 * @param session - The answering session, or null when unbound.
 * @param env - Process env (harness detection).
 * @param getOwnerAuth - Reads a session's owner mark.
 */
async function assertMayAnswer(
  projectRoot: string,
  input: OwnerAnswerInput,
  asked: BrainDecisionRow,
  session: string | null,
  env: Env,
  getOwnerAuth: (id: string, cwd?: string) => Promise<{ token: string | null } | null>,
): Promise<void> {
  if (input.via === undefined) {
    const { isOwnerSessionMark } = await import('../security/owner-override-auth.js');
    const auth = session === null ? null : await getOwnerAuth(session, projectRoot);
    if (isOwnerSessionMark(auth?.token)) return;
    // @sync-invariant none:local-only the owner mark is session-local; nothing is written without it
    throw new CleoError(
      ExitCode.AUTONOMOUS_BOUNDARY,
      'Only an owner-marked session answers without --via',
      {
        fix: `Relay the owner's choice from your ask tool: cleo ask answer ${asked.id} --option "<label>" --via ask-tool`,
      },
    );
  }
  if (session === null) {
    // @sync-invariant none:local-only a relay is attributed to its session; nothing is written unbound
    throw new CleoError(ExitCode.SESSION_UNBOUND, 'A relayed owner answer needs a bound session', {
      fix: 'Bind one with `cleo session start --scope global --name "<what you are doing>"`.',
    });
  }
  if (input.via === 'mbx-owner') {
    if (!input.source?.trim()) {
      // @sync-invariant none:input-shape an mbx relay without its message id is refused before anything is written
      throw new CleoError(ExitCode.VALIDATION_ERROR, '--via mbx-owner needs --source <message id>');
    }
    return;
  }
  const askedBy = asked.rationale.match(new RegExp(`${ASKED_BY}(\\S+?)[ .]`))?.[1];
  if (askedBy === session && (await callerAskTool(env)) === null) {
    // @sync-invariant none:local-only the asking session's ask tool is local; nothing is written without one
    throw new CleoError(
      ExitCode.AUTONOMOUS_BOUNDARY,
      `This session asked ${asked.id} and has no ask tool, so it cannot have put it to the owner`,
      {
        fix: 'Leave the task parked; the owner answers from an owner-marked session, Studio, or a signed mbx message.',
      },
    );
  }
}

/**
 * The options of a stored question, from its `alternatives`.
 *
 * @param row - The question's D-record.
 * @returns Each option's label and description.
 */
function parseOptions(row: BrainDecisionRow): OwnerQuestionOption[] {
  const raw: unknown = JSON.parse(row.alternativesJson ?? '[]');
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is string => typeof item === 'string')
    .map((item) => {
      const at = item.indexOf(OPTION_SEPARATOR);
      return at < 0
        ? { label: item, description: '' }
        : { label: item.slice(0, at), description: item.slice(at + OPTION_SEPARATOR.length) };
    });
}

/**
 * Owner questions still open, newest first.
 *
 * @param projectRoot - Project root.
 * @returns Each open question with its task and option labels.
 */
export async function listOpenOwnerQuestions(projectRoot: string): Promise<OpenOwnerQuestion[]> {
  const rows = await (await getBrainAccessor(projectRoot)).findDecisions({});
  return rows
    .filter((r) => r.contextPhase === OWNER_QUESTION_PHASE && r.confirmationState === 'proposed')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((r) => ({
      decisionId: r.id,
      taskId: r.contextTaskId ?? null,
      question: r.decision.replace(/^Owner question on \S+ \([^)]*\): /, ''),
      options: parseOptions(r).map((o) => o.label),
      askedAt: r.createdAt,
    }));
}

/**
 * Owner answers recorded after `since`, newest first.
 *
 * @param projectRoot - Project root.
 * @param since - ISO time (the last session's end); null lists none.
 * @returns Each answer with the task it resumed.
 */
export async function listOwnerAnswersSince(
  projectRoot: string,
  since: string | null,
): Promise<AnsweredOwnerQuestion[]> {
  if (since === null) return [];
  const sinceMs = Date.parse(since);
  const rows = await (await getBrainAccessor(projectRoot)).findDecisions({});
  return rows
    .filter((r) => r.contextPhase === OWNER_ANSWER_PHASE && toMs(r.createdAt) > sinceMs)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((r) => ({
      decisionId: r.id,
      taskId: r.contextTaskId ?? null,
      answer: r.decision,
      answeredAt: r.createdAt,
    }));
}

/** Milliseconds of a stored `YYYY-MM-DD HH:MM:SS` (UTC) or ISO timestamp. */
function toMs(stamp: string): number {
  return Date.parse(stamp.includes('T') ? stamp : `${stamp.replace(' ', 'T')}Z`);
}
