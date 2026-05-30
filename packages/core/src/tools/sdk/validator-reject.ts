/**
 * validator.reject — SDK tool wrapping the Validator's "reject" verdict path.
 *
 * Accepts a fully-formed {@link ValidatorRejection} envelope (verdict='reject',
 * at least one finding with status='fail' or 'inconclusive'), validates it
 * against the Zod schema, and emits a structured rejection envelope.
 *
 * IMPORTANT: validator.reject does NOT write `evidence_ac_bindings` rows —
 * rejection is the ABSENCE of binding. The downstream AC-coverage gate
 * (T10509) sees no coverage rows for the rejected ACs and refuses
 * `cleo complete` accordingly.
 *
 * Auth model — terminal: only an agent with `caller.role === 'validator'` may
 * invoke this tool. Returns `E_VALIDATOR_AUTH_ROLE` otherwise.
 *
 * @arch SDK Tool (Category B) — harness-agnostic, contracts-typed
 * @task T10511
 * @epic T10383 (E-VALIDATOR-ROLE)
 * @saga T10377 (SG-IVTR-AC-BINDING)
 */

import {
  type AgentRole,
  type ValidatorRejection,
  validatorRejectionSchema,
} from '@cleocode/contracts';
import type { JsonSchema, RegisteredSdkTool } from '../../task-tools/sdk-tool.js';
import { defineSdkTool } from '../../task-tools/sdk-tool.js';

/**
 * Input envelope for the {@link validatorReject} SDK tool.
 *
 * @task T10511
 */
export interface ValidatorRejectInput {
  /** Absolute project root (kept for symmetry with attest; unused for reads). */
  projectRoot: string;
  /** Caller identity — used for role-based auth. */
  caller: {
    /** Canonical agent role; only `'validator'` may invoke. */
    role: AgentRole;
  };
  /** Fully-formed rejection envelope. */
  rejection: ValidatorRejection;
}

/**
 * Output envelope for the {@link validatorReject} SDK tool.
 *
 * Discriminated by `ok`. On success, echoes the rejection envelope so
 * downstream callers can persist or surface it. On failure, contains a
 * structured error code + message. NO bindings are ever written.
 *
 * @task T10511
 */
export type ValidatorRejectOutput =
  | {
      ok: true;
      /** Echo of the validated rejection envelope. */
      rejection: ValidatorRejection;
      /** Count of failing or inconclusive findings — for summary UIs. */
      failingFindingCount: number;
      /** AC ids that did not pass — useful for downstream remediation routing. */
      failingAcIds: string[];
      /** ISO-8601 timestamp the rejection was processed. */
      processedAt: string;
    }
  | {
      ok: false;
      /** Structured error code (E_VALIDATOR_*). */
      code: string;
      /** Human-readable failure description. */
      message: string;
    };

const INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    projectRoot: { type: 'string', description: 'Absolute project root.' },
    caller: {
      type: 'object',
      properties: {
        role: { type: 'string', description: "Agent role — only 'validator' authorized." },
      },
      required: ['role'],
    },
    rejection: {
      type: 'object',
      description: 'ValidatorRejection envelope per validatorRejectionSchema.',
    },
  },
  required: ['projectRoot', 'caller', 'rejection'],
};

const OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    rejection: { type: 'object', description: 'Echo of validated rejection (success only).' },
    failingFindingCount: { type: 'number' },
    failingAcIds: { type: 'array', items: { type: 'string' } },
    processedAt: { type: 'string' },
    code: { type: 'string', description: 'Error code (failure only).' },
    message: { type: 'string', description: 'Error message (failure only).' },
  },
  required: ['ok'],
};

/**
 * Internal handler — auth + schema validation. NO database writes.
 *
 * @task T10511
 */
async function validatorRejectFn(input: ValidatorRejectInput): Promise<ValidatorRejectOutput> {
  // 1. Auth.
  if (input.caller.role !== 'validator') {
    return {
      ok: false,
      code: 'E_VALIDATOR_AUTH_ROLE',
      message: `validator.reject requires caller.role='validator' (got '${input.caller.role}')`,
    };
  }

  // 2. Schema validation.
  const parsed = validatorRejectionSchema.safeParse(input.rejection);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'E_VALIDATOR_REJECTION_INVALID',
      message: `rejection failed schema validation: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    };
  }

  const rejection = parsed.data;
  const failing = rejection.findings.filter((f) => f.status !== 'pass');

  // 3. Build structured echo envelope. NO bindings written.
  return {
    ok: true,
    rejection,
    failingFindingCount: failing.length,
    failingAcIds: failing.map((f) => f.acId),
    processedAt: new Date().toISOString(),
  };
}

/**
 * Registered SDK tool: validator.reject.
 *
 * @example
 * ```typescript
 * const out = await validatorReject.invoke({
 *   projectRoot: '/mnt/projects/cleocode',
 *   caller: { role: 'validator' },
 *   rejection: {
 *     verdict: 'reject',
 *     taskId: 'T1234',
 *     validatorId: 'validator-prime',
 *     findings: [
 *       { acId: 'uuid-1', status: 'fail', reasoning: 'no test', checkedAt: '...' },
 *     ],
 *     summary: 'AC1 unsatisfied — test missing.',
 *     rejectedAt: '2026-05-24T00:00:00Z',
 *     schemaVersion: '1',
 *   },
 * });
 * if (out.ok) console.log(`rejected ${out.failingFindingCount} ACs`);
 * ```
 *
 * @task T10511
 */
export const validatorReject: RegisteredSdkTool<
  ValidatorRejectInput,
  Promise<ValidatorRejectOutput>
> = defineSdkTool({
  identity: {
    name: 'validator-reject',
    description:
      'Validator-only SDK tool — emits structured rejection envelope. Writes no bindings.',
    version: '1.0.0',
  },
  inputSchema: INPUT_SCHEMA,
  outputSchema: OUTPUT_SCHEMA,
  fn: validatorRejectFn,
});
