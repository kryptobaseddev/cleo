/**
 * spawn.validator — SDK tool that spawns a Validator subagent.
 *
 * Auth model — orchestrator-tier-1+: only an agent with
 * `caller.role === 'orchestrator'` AND `caller.tier >= 1` may invoke. This
 * mirrors the existing spawn-tool tier model — workers / leads / tier-0
 * orchestrators cannot directly spawn Validators.
 *
 * Delegates to the existing {@link orchestrateSpawn} pipeline with the
 * Validator's task id (one task per Validator-review cycle). The spawn
 * machinery provisions a worktree, builds the prompt preamble, and emits
 * the same `WorktreeSpawnResult`-shaped envelope used by every other
 * `cleo orchestrate spawn` call.
 *
 * Tier-protocol invariant: the resulting subagent runs with
 * `CLEO_AGENT_ROLE=worker` at the harness level (Validator is a CANT-defined
 * persona, NOT a separate harness role), but the spawned task's protocolType
 * is set to `'validator'` so the prompt-builder applies the Validator stage
 * guidance. See ADR-079-r* §validator-semantics.
 *
 * @arch SDK Tool (Category B) — harness-agnostic, contracts-typed
 * @task T10511
 * @epic T10383 (E-VALIDATOR-ROLE)
 * @saga T10377 (SG-IVTR-AC-BINDING)
 */

import type { AgentRole } from '@cleocode/contracts';
import type { EngineResult } from '../../engine-result.js';
import { orchestrateSpawn } from '../../orchestrate/spawn-ops.js';
import type { JsonSchema, RegisteredSdkTool } from '../../task-tools/sdk-tool.js';
import { defineSdkTool } from '../../task-tools/sdk-tool.js';

/**
 * Input envelope for the {@link spawnValidator} SDK tool.
 *
 * @task T10511
 */
export interface SpawnValidatorInput {
  /** Absolute project root. */
  projectRoot: string;
  /** Caller identity — must be orchestrator at tier ≥ 1. */
  caller: {
    /** Canonical agent role — must be `'orchestrator'`. */
    role: AgentRole;
    /** Tier — must be ≥ 1. tier 0 orchestrators cannot spawn Validators. */
    tier: 0 | 1 | 2;
  };
  /** Task ID the Validator will review. */
  taskId: string;
  /**
   * Optional spawn-scope override. Defaults are inherited from the
   * existing spawn pipeline.
   */
  spawnScope?: string;
  /** Pass-through to {@link orchestrateSpawn} — defaults to false. */
  noWorktree?: boolean;
}

/**
 * Output envelope for the {@link spawnValidator} SDK tool.
 *
 * Discriminated by `ok`. On success, returns the underlying EngineResult
 * (carrying the spawn prompt + worktree env-vars + cwd). On failure,
 * returns a structured error code + message.
 *
 * @task T10511
 */
export type SpawnValidatorOutput =
  | {
      ok: true;
      /** Raw EngineResult from `orchestrateSpawn`. */
      result: EngineResult;
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
    caller: {
      type: 'object',
      properties: {
        role: {
          type: 'string',
          description: "Agent role — must be 'orchestrator'.",
        },
        tier: { type: 'number', description: 'Orchestrator tier — must be ≥ 1.' },
      },
      required: ['role', 'tier'],
    },
    taskId: { type: 'string', description: 'Task the Validator will review.' },
    spawnScope: { type: 'string' },
    noWorktree: { type: 'boolean' },
  },
  required: ['projectRoot', 'caller', 'taskId'],
};

const OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    result: { type: 'object', description: 'EngineResult from orchestrateSpawn (success only).' },
    code: { type: 'string' },
    message: { type: 'string' },
  },
  required: ['ok'],
};

/**
 * Internal handler — auth + delegation to orchestrateSpawn.
 *
 * @task T10511
 */
async function spawnValidatorFn(input: SpawnValidatorInput): Promise<SpawnValidatorOutput> {
  // 1. Role gate.
  if (input.caller.role !== 'orchestrator') {
    return {
      ok: false,
      code: 'E_VALIDATOR_SPAWN_AUTH_ROLE',
      message: `spawn.validator requires caller.role='orchestrator' (got '${input.caller.role}')`,
    };
  }

  // 2. Tier gate — orchestrator-tier-1+.
  if (input.caller.tier < 1) {
    return {
      ok: false,
      code: 'E_VALIDATOR_SPAWN_AUTH_TIER',
      message: `spawn.validator requires caller.tier>=1 (got ${input.caller.tier})`,
    };
  }

  // 3. Validate task id presence.
  if (!input.taskId || input.taskId.trim().length === 0) {
    return {
      ok: false,
      code: 'E_INVALID_INPUT',
      message: 'taskId is required and must be non-empty',
    };
  }

  // 4. Delegate to the existing spawn pipeline with protocolType='validator'.
  // The downstream prompt-builder picks up the validator-stage guidance.
  const result = await orchestrateSpawn(
    input.taskId,
    'validator',
    input.projectRoot,
    input.caller.tier,
    input.noWorktree ?? false,
    input.spawnScope,
  );

  return { ok: true, result };
}

/**
 * Registered SDK tool: spawn.validator.
 *
 * @example
 * ```typescript
 * const out = await spawnValidator.invoke({
 *   projectRoot: '/mnt/projects/cleocode',
 *   caller: { role: 'orchestrator', tier: 1 },
 *   taskId: 'T1234',
 * });
 * if (out.ok) console.log('validator spawned:', out.result);
 * ```
 *
 * @task T10511
 */
export const spawnValidator: RegisteredSdkTool<
  SpawnValidatorInput,
  Promise<SpawnValidatorOutput>
> = defineSdkTool({
  identity: {
    name: 'spawn-validator',
    description:
      'Orchestrator-tier-1+ SDK tool — spawns a Validator subagent via orchestrateSpawn.',
    version: '1.0.0',
  },
  inputSchema: INPUT_SCHEMA,
  outputSchema: OUTPUT_SCHEMA,
  fn: spawnValidatorFn,
});
