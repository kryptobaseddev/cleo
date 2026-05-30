/**
 * validator.ac-pull — SDK tool that fetches a task's AC list plus current
 * binding status, so a Validator can see at a glance which ACs already have
 * coverage and which still need review.
 *
 * Returns the full AC roster with a derived `bindingStatus` field:
 *   - `'satisfied'`   — at least one `evidence_ac_bindings` row exists for the AC
 *   - `'unsatisfied'` — no bindings exist for the AC
 *
 * Read-only — no auth gate. Any role may invoke (the data is non-sensitive
 * coverage metadata).
 *
 * @arch SDK Tool (Category B) — harness-agnostic, contracts-typed
 * @task T10511
 * @epic T10383 (E-VALIDATOR-ROLE)
 * @saga T10377 (SG-IVTR-AC-BINDING)
 */

import { getTaskAccessor } from '../store/data-accessor.js';
import type { JsonSchema, RegisteredSdkTool } from '../task-tools/sdk-tool.js';
import { defineSdkTool } from '../task-tools/sdk-tool.js';

/**
 * Input envelope for the {@link validatorAcPull} SDK tool.
 *
 * @task T10511
 */
export interface ValidatorAcPullInput {
  /** Absolute project root. */
  projectRoot: string;
  /** Task ID to query — matches `tasks.id`. */
  taskId: string;
}

/**
 * Per-AC row in the {@link ValidatorAcPullOutput.acs} array.
 *
 * @task T10511
 */
export interface ValidatorAcRowView {
  /** Stable UUID — matches `task_acceptance_criteria.id`. */
  id: string;
  /** Display alias — `AC<ordinal>`. */
  alias: string;
  /** 1-based ordinal. */
  ordinal: number;
  /** AC statement text. */
  text: string;
  /** Derived: at least one binding exists OR not. */
  bindingStatus: 'satisfied' | 'unsatisfied';
}

/**
 * Output envelope for the {@link validatorAcPull} SDK tool.
 *
 * Discriminated by `ok`. On success, returns the task id and ordered AC
 * roster with binding status. On failure (e.g. unknown task id), returns
 * a structured error code + message.
 *
 * @task T10511
 */
export type ValidatorAcPullOutput =
  | {
      ok: true;
      taskId: string;
      acs: ValidatorAcRowView[];
    }
  | {
      ok: false;
      code: string;
      message: string;
    };

const INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    projectRoot: { type: 'string', description: 'Absolute project root.' },
    taskId: { type: 'string', description: 'Task ID to query.' },
  },
  required: ['projectRoot', 'taskId'],
};

const OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    taskId: { type: 'string' },
    acs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          alias: { type: 'string', description: 'Display alias AC<ordinal>.' },
          ordinal: { type: 'number' },
          text: { type: 'string' },
          bindingStatus: {
            type: 'string',
            description: "'satisfied' | 'unsatisfied' — derived from binding rows.",
          },
        },
        required: ['id', 'alias', 'ordinal', 'text', 'bindingStatus'],
      },
    },
    code: { type: 'string' },
    message: { type: 'string' },
  },
  required: ['ok'],
};

/**
 * Internal handler — task-AC read + binding aggregation.
 *
 * @task T10511
 */
async function validatorAcPullFn(input: ValidatorAcPullInput): Promise<ValidatorAcPullOutput> {
  if (!input.taskId || input.taskId.trim().length === 0) {
    return {
      ok: false,
      code: 'E_INVALID_INPUT',
      message: 'taskId is required and must be non-empty',
    };
  }

  const accessor = await getTaskAccessor(input.projectRoot);
  const acs = await accessor.getAcRows(input.taskId);

  if (acs.length === 0) {
    // Caller can disambiguate "task exists but no ACs" vs "unknown task" via
    // taskExists if needed; we treat both as a valid empty result.
    return { ok: true, taskId: input.taskId, acs: [] };
  }

  const bindings = await accessor.getAcBindings(acs.map((ac) => ac.id));
  const satisfiedIds = new Set(bindings.map((b) => b.acId));

  const acsView: ValidatorAcRowView[] = acs.map((ac) => ({
    id: ac.id,
    alias: `AC${ac.ordinal}`,
    ordinal: ac.ordinal,
    text: ac.text,
    bindingStatus: satisfiedIds.has(ac.id) ? 'satisfied' : 'unsatisfied',
  }));

  return { ok: true, taskId: input.taskId, acs: acsView };
}

/**
 * Registered SDK tool: validator.ac-pull.
 *
 * @example
 * ```typescript
 * const out = await validatorAcPull.invoke({
 *   projectRoot: '/mnt/projects/cleocode',
 *   taskId: 'T1234',
 * });
 * if (out.ok) {
 *   for (const ac of out.acs) console.log(`${ac.alias}: ${ac.bindingStatus}`);
 * }
 * ```
 *
 * @task T10511
 */
export const validatorAcPull: RegisteredSdkTool<
  ValidatorAcPullInput,
  Promise<ValidatorAcPullOutput>
> = defineSdkTool({
  identity: {
    name: 'validator-ac-pull',
    description: 'Read-only SDK tool — fetches a task’s AC list with current binding status.',
    version: '1.0.0',
  },
  inputSchema: INPUT_SCHEMA,
  outputSchema: OUTPUT_SCHEMA,
  fn: validatorAcPullFn,
});
