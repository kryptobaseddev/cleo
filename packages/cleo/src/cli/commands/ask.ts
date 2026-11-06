/**
 * `cleo ask` — park a task on an owner question and continue (T14302).
 *
 * - `cleo ask <taskId> --request '<json>'`: store the question
 *   (`{question, options[{label,description}], recommended}`, the
 *   `hitl.request` shape) as a proposed D-record and block the task with the
 *   `owner-decision` label; `cleo next` then skips it.
 * - `cleo ask answer <decisionId> --option <label>`: store the owner's answer
 *   and return the task to pending. From an agent that relayed the answer, add
 *   `--via ask-tool`, or `--via mbx-owner --source <message id>` (D11232).
 *
 * `answer` is a positional verb, not a citty sub-command: a task id must also
 * work in that position. Thin glue over `@cleocode/core/tasks/owner-ask.js`.
 *
 * @task T14302
 */

import { getProjectRoot } from '@cleocode/core/paths.js';
import {
  answerOwner,
  askOwner,
  type OwnerAnswerVia,
  type OwnerQuestionRequest,
} from '@cleocode/core/tasks/owner-ask.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliError, cliOutput } from '../renderers/index.js';

/** Refuse invalid input with E_VALIDATION (exit 6). */
function invalid(message: string): void {
  cliError(message, 6, { name: 'E_VALIDATION' });
  process.exitCode = 6;
}

/** The relay channels `--via` accepts. */
const VIAS: readonly OwnerAnswerVia[] = ['ask-tool', 'mbx-owner'];

/** Whether `raw` names a relay channel. */
function isVia(raw: string): raw is OwnerAnswerVia {
  return (VIAS as readonly string[]).includes(raw);
}

/** The `--request` JSON as a question, or null when it is not an object. */
function parseRequest(raw: string): OwnerQuestionRequest | null {
  try {
    const parsed: OwnerQuestionRequest = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.options)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/** `cleo ask` root command. */
export const askCommand = defineCommand({
  meta: {
    name: 'ask',
    description:
      'Park a task on an owner question and continue with other work (ask <taskId> --request), ' +
      'or record the owner answer and resume it (ask answer <decisionId> --option)',
  },
  args: {
    target: {
      type: 'positional',
      description: 'Task id to park, or `answer`',
      required: true,
    },
    decision: {
      type: 'positional',
      description: 'With `answer`: the question D-record id',
      required: false,
    },
    request: {
      type: 'string',
      description:
        'The question as JSON: {"question","options":[{"label","description"}],"recommended"} (2-4 options)',
    },
    option: { type: 'string', description: 'With `answer`: the chosen option label' },
    note: { type: 'string', description: 'With `answer`: an owner note kept with the answer' },
    via: {
      type: 'string',
      description:
        'With `answer` from an agent: ask-tool (relayed from your ask tool) or mbx-owner (a signed mbx OWNER message)',
    },
    source: { type: 'string', description: 'With `--via mbx-owner`: the mbx message id' },
  },
  async run({ args }) {
    const target = String(args.target);
    if (target !== 'answer') {
      const request = parseRequest(String(args.request ?? ''));
      if (request === null) return invalid('cleo ask <taskId> needs --request <json question>');
      cliOutput(await askOwner(getProjectRoot(), target, request), {
        command: 'ask',
        operation: 'ask.request',
      });
      return;
    }
    if (typeof args.decision !== 'string' || typeof args.option !== 'string') {
      return invalid('cleo ask answer needs <decisionId> and --option <label>');
    }
    const via = args.via === undefined ? undefined : String(args.via);
    if (via !== undefined && !isVia(via)) return invalid(`--via is ${VIAS.join(' or ')}`);
    const answered = await answerOwner(getProjectRoot(), {
      decisionId: args.decision,
      option: args.option,
      ...(typeof args.note === 'string' ? { note: args.note } : {}),
      ...(via !== undefined ? { via } : {}),
      ...(typeof args.source === 'string' ? { source: args.source } : {}),
    });
    cliOutput(answered, { command: 'ask', operation: 'ask.answer' });
  },
});
