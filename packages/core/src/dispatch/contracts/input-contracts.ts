/**
 * Starter registry of {@link OperationInputContract} entries.
 *
 * Seeds the `OperationInputContractRegistry` introduced by T9914 with a
 * minimal real-world example so the agent-introspection surface
 * (`cleo schema <op> --input` / `--examples`, T9918) has something to
 * return today. Additional contracts are added incrementally per
 * E7 retrofit task (T9917+).
 *
 * The single seed entry is `tasks.add-batch` — the canonical bulk-create
 * operation that benefits most from agents discovering its shape before
 * piping a payload via `cleo add-batch --params -`.
 *
 * @packageDocumentation
 * @module @cleocode/core/dispatch/contracts/input-contracts
 *
 * @epic T9855
 * @task T9918
 */

import type { OperationInputContract, OperationInputContractRegistry } from '@cleocode/contracts';

// ---------------------------------------------------------------------------
// Wire-format task spec (mirrors AddBatchTaskSpec — kept in sync manually
// rather than imported so contracts stay decoupled from internal Core types).
// ---------------------------------------------------------------------------

/**
 * Wire-format task spec accepted by `tasks.add-batch`. Local mirror of
 * `AddBatchTaskSpec` from `packages/core/src/tasks/add-batch.ts` so the
 * contract describes the public wire shape without importing internal
 * Core types into the schema-registry module.
 */
interface AddBatchTaskSpecWire {
  title: string;
  description?: string;
  parent?: string;
  depends?: string[];
  priority?: string;
  labels?: string[];
  type?: string;
  acceptance?: string[];
  phase?: string;
  size?: string;
  notes?: string;
  files?: string[];
  kind?: string;
  scope?: string;
  severity?: string;
  forceDuplicate?: boolean;
}

/**
 * Input shape for the `tasks.add-batch` operation.
 *
 * Matches the runtime params accepted by `tasksAddBatchOp` — an array of
 * wire-format task specs, an optional shared default parent, and an
 * optional dry-run flag.
 */
interface TasksAddBatchInput {
  tasks: AddBatchTaskSpecWire[];
  defaultParent?: string;
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// tasks.add-batch contract
// ---------------------------------------------------------------------------

/**
 * Schema-first contract for `tasks.add-batch`.
 *
 * Mirrors the operation registry entry in
 * `packages/contracts/src/dispatch/operations-registry.ts` and the
 * runtime shape in `packages/core/src/tasks/add-batch.ts`. Examples
 * showcase the two most common patterns: a minimal 2-task batch under a
 * shared epic and an epic-decomposition batch using per-task `parent`.
 */
const tasksAddBatchContract: OperationInputContract<TasksAddBatchInput> = {
  operation: 'tasks.add-batch',
  schema: {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    required: ['tasks'],
    additionalProperties: false,
    properties: {
      tasks: {
        type: 'array',
        minItems: 1,
        description: 'Array of task specs to insert atomically. At least one task is required.',
        items: {
          type: 'object',
          required: ['title'],
          additionalProperties: false,
          properties: {
            title: {
              type: 'string',
              minLength: 1,
              maxLength: 200,
              description: 'Human-readable task title (required).',
            },
            description: {
              type: 'string',
              description: 'Optional long-form task description.',
            },
            parent: {
              type: 'string',
              description: 'Parent task ID (ADR-057 D2 wire field — maps to parentId internally).',
            },
            depends: {
              type: 'array',
              items: { type: 'string' },
              description: 'List of task IDs this task depends on.',
            },
            priority: {
              type: 'string',
              enum: ['low', 'medium', 'high', 'critical'],
              description: 'Task priority.',
            },
            labels: {
              type: 'array',
              items: { type: 'string' },
              description: 'Free-form classification labels.',
            },
            type: {
              type: 'string',
              enum: ['epic', 'task', 'subtask', 'saga'],
              description: 'Task tier (ADR-073 — saga elevates Epic via label).',
            },
            acceptance: {
              type: 'array',
              items: { type: 'string', minLength: 1 },
              description: 'Acceptance criteria. REQUIRED for all tasks per ADR-066.',
            },
            phase: {
              type: 'string',
              description: 'Free-form phase grouping.',
            },
            size: {
              type: 'string',
              enum: ['small', 'medium', 'large'],
              description: 'Sizing bucket (no time estimates).',
            },
            notes: {
              type: 'string',
              description: 'Initial note entry for the task.',
            },
            files: {
              type: 'array',
              items: { type: 'string' },
              description: 'List of files this task is scoped to.',
            },
            kind: {
              type: 'string',
              enum: ['work', 'research', 'experiment', 'bug', 'spike', 'release'],
              description: 'Task kind (orthogonal to type).',
            },
            scope: {
              type: 'string',
              description: 'Scope-of-change descriptor.',
            },
            severity: {
              type: 'string',
              enum: ['P0', 'P1', 'P2', 'P3'],
              description: 'Severity (orthogonal to priority; triggers Ed25519 attestation).',
            },
            forceDuplicate: {
              type: 'boolean',
              description: 'Bypass duplicate-detection guards.',
            },
          },
        },
      },
      defaultParent: {
        type: 'string',
        description: 'Optional default parent task ID applied when a task spec omits parent.',
      },
      dryRun: {
        type: 'boolean',
        description: 'Validate and predict IDs without writing to the database.',
      },
    },
  },
  examples: [
    {
      name: 'minimal-two-task-batch',
      description:
        'Smallest realistic batch — two tasks sharing a default parent epic, each with required acceptance.',
      value: {
        tasks: [
          {
            title: 'Spec the new dispatcher contract',
            acceptance: ['Contract spec landed', 'Reviewed by team-lead'],
          },
          {
            title: 'Implement the dispatcher contract',
            acceptance: ['All tests pass', 'Wired to existing callers'],
          },
        ],
        defaultParent: 'T1234',
      },
    },
    {
      name: 'epic-decomposition-with-explicit-parents',
      description:
        'Per-task parent assignment — useful when decomposing one epic into children of different sibling epics.',
      value: {
        tasks: [
          {
            title: 'Add --input flag to cleo schema',
            parent: 'T9918',
            acceptance: ['Flag accepted', 'JSON schema returned'],
            priority: 'medium',
            size: 'small',
          },
          {
            title: 'Add --examples flag to cleo schema',
            parent: 'T9918',
            acceptance: ['Flag accepted', 'Examples array returned'],
            priority: 'medium',
            size: 'small',
          },
        ],
      },
    },
    {
      name: 'dry-run-preview',
      description: 'Validate-only run — predicts IDs without writing to the database.',
      value: {
        tasks: [
          {
            title: 'Preview-only task',
            acceptance: ['Dry run succeeds'],
          },
        ],
        dryRun: true,
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Canonical registry of every {@link OperationInputContract} known to the
 * CLEO runtime. Consumers MUST treat this map as the SSoT for
 * agent-introspection surfaces (`cleo schema <op> --input` /
 * `--examples`) and for the schema-first `mutate(operation, input)` DX.
 *
 * Currently seeded with a single contract (`tasks.add-batch`) so
 * T9918 has something concrete to return. Additional operations land
 * incrementally via T9917+ retrofit tasks.
 */
export const INPUT_CONTRACTS: OperationInputContractRegistry = {
  'tasks.add-batch': tasksAddBatchContract as OperationInputContract<unknown>,
};

/**
 * Look up the {@link OperationInputContract} for a given operation key.
 *
 * @param operation - Fully-qualified operation key (e.g. `'tasks.add-batch'`).
 * @returns The matching contract, or `null` when no contract is registered.
 */
export function getInputContract(operation: string): OperationInputContract<unknown> | null {
  return INPUT_CONTRACTS[operation] ?? null;
}
