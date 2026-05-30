/**
 * validator.attest — SDK tool wrapping the Validator's "attest" verdict path.
 *
 * Accepts a fully-formed {@link ValidatorAttestation} envelope (verdict='attest',
 * one finding per AC, all with status='pass') and writes one
 * `evidence_ac_bindings` row per AC with `binding_type='coverage'`. The write
 * is wrapped in a transaction so partial-bindings cannot leak when the AC
 * existence check fails mid-pass.
 *
 * Auth model — terminal: only an agent with `caller.role === 'validator'` may
 * invoke this tool. Returns `E_VALIDATOR_AUTH_ROLE` otherwise.
 *
 * Per council §3.1 ADR-D rejection: NO new tool registry — uses the existing
 * `defineSdkTool` factory. Tier scoping is enforced in the tool's `fn`.
 *
 * @arch SDK Tool (Category B) — harness-agnostic, contracts-typed
 * @task T10511
 * @epic T10383 (E-VALIDATOR-ROLE)
 * @saga T10377 (SG-IVTR-AC-BINDING)
 */

import { randomUUID } from 'node:crypto';
import {
  type AgentRole,
  type ValidatorAttestation,
  validatorAttestationSchema,
} from '@cleocode/contracts';
import { getTaskAccessor } from '../../store/data-accessor.js';
import type { JsonSchema, RegisteredSdkTool } from '../../task-tools/sdk-tool.js';
import { defineSdkTool } from '../../task-tools/sdk-tool.js';

/**
 * Input envelope for the {@link validatorAttest} SDK tool.
 *
 * @task T10511
 */
export interface ValidatorAttestInput {
  /** Absolute path to the project root. */
  projectRoot: string;
  /** Caller identity — used for role-based auth. */
  caller: {
    /** Canonical agent role; only `'validator'` may invoke. */
    role: AgentRole;
  };
  /** Fully-formed attestation envelope to persist. */
  attestation: ValidatorAttestation;
}

/**
 * Output envelope for the {@link validatorAttest} SDK tool.
 *
 * Discriminated by `ok`. On success, contains the count of coverage bindings
 * written. On failure, contains a structured error code + message.
 *
 * @task T10511
 */
export type ValidatorAttestOutput =
  | {
      ok: true;
      /** Count of `evidence_ac_bindings` rows persisted (one per AC). */
      bindingsWritten: number;
      /** UUIDs assigned to each binding row. */
      bindingIds: string[];
      /** ISO-8601 timestamp the attestation was processed. */
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
    attestation: {
      type: 'object',
      description: 'ValidatorAttestation envelope per validatorAttestationSchema.',
    },
  },
  required: ['projectRoot', 'caller', 'attestation'],
};

const OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: 'Discriminant — true on success.' },
    bindingsWritten: { type: 'number', description: 'Coverage bindings persisted.' },
    bindingIds: { type: 'array', items: { type: 'string' } },
    processedAt: { type: 'string', description: 'ISO-8601 timestamp.' },
    code: { type: 'string', description: 'Error code (failure only).' },
    message: { type: 'string', description: 'Error message (failure only).' },
  },
  required: ['ok'],
};

/**
 * Build a stable composite evidence-atom id for a Validator attestation.
 *
 * The atom id format is `validator:<validatorId>:<taskId>` so multiple
 * Validators attesting the same task produce distinct binding rows, but
 * the same Validator re-attesting collapses idempotently against the
 * UNIQUE (evidence_atom_id, ac_id, binding_type) index.
 *
 * @task T10511
 */
function buildValidatorAtomId(validatorId: string, taskId: string): string {
  return `validator:${validatorId}:${taskId}`;
}

/**
 * Internal handler — auth, schema-validate, AC-existence check, transactional write.
 *
 * @task T10511
 */
async function validatorAttestFn(input: ValidatorAttestInput): Promise<ValidatorAttestOutput> {
  // 1. Auth: terminal role check.
  if (input.caller.role !== 'validator') {
    return {
      ok: false,
      code: 'E_VALIDATOR_AUTH_ROLE',
      message: `validator.attest requires caller.role='validator' (got '${input.caller.role}')`,
    };
  }

  // 2. Runtime schema validation (defensive — the contract guards via Zod).
  const parsed = validatorAttestationSchema.safeParse(input.attestation);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'E_VALIDATOR_ATTESTATION_INVALID',
      message: `attestation failed schema validation: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    };
  }

  const attestation = parsed.data;
  const accessor = await getTaskAccessor(input.projectRoot);
  const atomId = buildValidatorAtomId(attestation.validatorId, attestation.taskId);

  // 3. AC existence check — every finding.acId MUST resolve to a real
  // task_acceptance_criteria row owned by attestation.taskId.
  const acs = await accessor.getAcRows(attestation.taskId);
  const acIdSet = new Set(acs.map((ac) => ac.id));
  const findingAcIds = attestation.findings.map((f) => f.acId);
  const missing = findingAcIds.filter((id) => !acIdSet.has(id));
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'E_VALIDATOR_AC_NOT_FOUND',
      message: `attestation references unknown AC ids on task ${attestation.taskId}: ${missing.join(', ')}`,
    };
  }

  // 4. Transactional write — coverage binding per AC.
  const bindingIds: string[] = [];
  await accessor.transaction(async (tx) => {
    const rows = findingAcIds.map((acId) => {
      const id = randomUUID();
      bindingIds.push(id);
      return {
        id,
        evidenceAtomId: atomId,
        acId,
        bindingType: 'coverage' as const,
      };
    });
    await tx.insertAcBindings(rows);
  });

  return {
    ok: true,
    bindingsWritten: bindingIds.length,
    bindingIds,
    processedAt: new Date().toISOString(),
  };
}

/**
 * Registered SDK tool: validator.attest.
 *
 * @example
 * ```typescript
 * const out = await validatorAttest.invoke({
 *   projectRoot: '/mnt/projects/cleocode',
 *   caller: { role: 'validator' },
 *   attestation: {
 *     verdict: 'attest',
 *     taskId: 'T1234',
 *     validatorId: 'validator-prime',
 *     findings: [{ acId: 'uuid-1', status: 'pass', reasoning: 'ok', checkedAt: '...' }],
 *     attestedAt: '2026-05-24T00:00:00Z',
 *     schemaVersion: '1',
 *   },
 * });
 * if (out.ok) console.log(`wrote ${out.bindingsWritten} coverage bindings`);
 * ```
 *
 * @task T10511
 */
export const validatorAttest: RegisteredSdkTool<
  ValidatorAttestInput,
  Promise<ValidatorAttestOutput>
> = defineSdkTool({
  identity: {
    name: 'validator-attest',
    description:
      'Validator-only SDK tool — writes coverage bindings for an attested ValidatorVerdict.',
    version: '1.0.0',
  },
  inputSchema: INPUT_SCHEMA,
  outputSchema: OUTPUT_SCHEMA,
  fn: validatorAttestFn,
});
