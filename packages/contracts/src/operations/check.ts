/**
 * OUTPUT contracts for the `check` domain — the gate-verification surface.
 *
 * `check.gate.set` is the operation behind `cleo verify --gate`, which
 * CLEO-INJECTION.md instructs every spawned agent to run before every
 * `cleo complete`. It had NO explicit contract: `deriveOutputContract` fell
 * through to `genericObjectContract`, which is honest but empty —
 * `fieldPointers: []` and a `shapeNote` that only says to run `--describe`.
 *
 * Three consequences, all measured on 2026-09-14 (gh#1420, gh#1423):
 *
 *   1. `cleo verify --describe --gate <g>` returned `params: []` and
 *      `fieldPointers: []` — an empty contract for the write op.
 *   2. The `E_FIELD_NOT_FOUND` `fix` field listed no valid pointers, while
 *      CLEO-INJECTION.md promises it "lists every valid pointer for that op".
 *   3. With nothing to check the documentation against, CLEO-INJECTION.md
 *      drifted into teaching `--field /data/task/verification` — the nested
 *      READ shape — for a verb that returns the FLAT mutate shape. That
 *      pointer cannot resolve, and it is the one every agent is handed.
 *
 * The pointers below are grounded in `GateVerifyResult`
 * (`packages/core/src/validation/engine-ops.ts`), which is flat: `taskId`,
 * `title`, `verification`, `verificationStatus`, `passed`, `round`,
 * `requiredGates`, `missingGates`.
 *
 * @packageDocumentation
 * @module @cleocode/contracts/operations/check
 *
 * @task T12192 (gh#1420, gh#1423)
 */

import type { JsonSchema } from './input-contract.js';
import type { OperationOutputContract } from './output-contract.js';

/** Shape of the `verification` object carried by every gate result. */
const VERIFICATION_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    passed: { type: 'boolean', description: 'True when every required gate is set.' },
    round: { type: 'number', description: 'IVTR round counter.' },
    gates: {
      type: 'object',
      additionalProperties: { type: 'boolean' },
      description: 'Gate name → whether it is recorded as passed.',
    },
    evidence: {
      type: 'object',
      additionalProperties: true,
      description: 'Gate name → the evidence atom kinds validated for it.',
    },
  },
};

/**
 * The shared `data` shape for both `check.gate.set` and `check.gate.status`.
 *
 * Deliberately one schema: the read and the write return the same record, and
 * splitting them would re-create exactly the read-vs-write pointer confusion
 * that produced gh#1420.
 */
const GATE_RESULT_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['taskId', 'verification', 'verificationStatus', 'passed'],
  additionalProperties: true,
  properties: {
    taskId: { type: 'string', description: 'The task the gates belong to.' },
    title: { type: 'string', description: 'Task title, for operator display.' },
    status: { type: 'string', description: 'Task lifecycle status.' },
    type: { type: 'string', description: 'Task type (epic | task | subtask).' },
    verification: VERIFICATION_SCHEMA,
    verificationStatus: {
      type: 'string',
      enum: ['passed', 'pending'],
      description: 'Whether every required gate is now recorded.',
    },
    passed: { type: 'boolean', description: 'Mirror of verification.passed.' },
    round: { type: 'number', description: 'IVTR round counter.' },
    requiredGates: {
      type: 'array',
      items: { type: 'string' },
      description: 'Gates this project requires before complete.',
    },
    missingGates: {
      type: 'array',
      items: { type: 'string' },
      description: 'Required gates not yet recorded — empty means ready to complete.',
    },
  },
};

/**
 * Pointers valid on BOTH gate operations.
 *
 * `/data/verification` is the one CLEO-INJECTION.md means when it says the
 * verify response is self-confirming. It is NOT `/data/task/verification`:
 * this record is flat, and the nested spelling is the read-envelope shape
 * used by `cleo show`.
 */
const GATE_FIELD_POINTERS: readonly string[] = [
  '/data/taskId',
  '/data/verification',
  '/data/verification/passed',
  '/data/verification/gates',
  '/data/verificationStatus',
  '/data/passed',
  '/data/missingGates',
  '/data/requiredGates',
];

/** OUTPUT contract for `check.gate.set` — the WRITE behind `cleo verify --gate`. */
export const checkGateSetOutputContract: OperationOutputContract = {
  operation: 'check.gate.set',
  shapeNote:
    'FLAT record, not the nested read shape. The verification object is at ' +
    '/data/verification — NEVER /data/task/verification, which is how `cleo show` ' +
    'nests a task and does not exist here. The response is self-confirming: it ' +
    'returns the full verification after the write, so there is no need to re-read.',
  dataSchema: { ...GATE_RESULT_SCHEMA },
  fieldPointers: [...GATE_FIELD_POINTERS],
};

/** OUTPUT contract for `check.gate.status` — the READ behind bare `cleo verify`. */
export const checkGateStatusOutputContract: OperationOutputContract = {
  operation: 'check.gate.status',
  shapeNote:
    'FLAT record identical in shape to check.gate.set. Read-only: reports which ' +
    'gates are recorded and which are still missing. /data/missingGates being ' +
    'empty is the precondition for `cleo complete`.',
  dataSchema: { ...GATE_RESULT_SCHEMA },
  fieldPointers: [...GATE_FIELD_POINTERS],
};
