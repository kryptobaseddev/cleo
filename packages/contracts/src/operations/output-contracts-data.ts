/**
 * OUTPUT_CONTRACTS data — the proof-set of per-operation OUTPUT contracts.
 *
 * SSoT for the OUTPUT (result) shape of CLEO's highest-traffic operations
 * (DHQ-057 · T11692). Each entry is an {@link OperationOutputContract}: a
 * JSON Schema draft-07 document for the LAFS envelope's `data` payload plus
 * the curated list of valid `--field` JSON pointers.
 *
 * Populated INCREMENTALLY — high-traffic operations first. This is the OUTPUT
 * mirror of `INPUT_CONTRACTS` (which lives in core). The data lives here in
 * `contracts` (a leaf package, zero runtime deps) so every consumer — CLI
 * `--describe`, the SDK `describeOperation`, REST clients — resolves against
 * one source of truth.
 *
 * Each `dataSchema` is grounded in the concrete result interface declared in
 * `./tasks.js` (e.g. {@link TasksShowResult}, {@link TaskMutationEnvelope}) so
 * the schema can never drift from the typed shape without a compile-time touch
 * to this file.
 *
 * @packageDocumentation
 * @module @cleocode/contracts/operations/output-contracts-data
 *
 * @epic T11679
 * @task T11692 — DHQ-057: per-operation output schema SSoT
 */

import type {
  OperationOutputContract,
  OperationOutputContractRegistry,
} from './output-contract.js';

// ---------------------------------------------------------------------------
// tasks.show — the operation that bit us (DHQ-057 reproduction)
// ---------------------------------------------------------------------------

/**
 * OUTPUT contract for `tasks.show`.
 *
 * Grounded in {@link TasksShowResult}: `{ task, view, attachments, acRows?,
 * relations? }`. The task body is nested under `task` — so the canonical
 * pointer for the title is `/data/task/title`, NOT `/data/title`. This is the
 * exact shape whose absence produced `cleo show --field /data/title` →
 * `E_FIELD_NOT_FOUND`.
 */
const tasksShowOutputContract: OperationOutputContract = {
  operation: 'tasks.show',
  shapeNote:
    'The task record is nested under `task` — use /data/task/<field>, not /data/<field>. ' +
    '`view` is the computed projection; `acRows` and `relations` are conditional.',
  dataSchema: {
    type: 'object',
    required: ['task', 'view', 'attachments'],
    additionalProperties: true,
    properties: {
      task: {
        type: 'object',
        description: 'Full task record (id, title, status, priority, type, parentId, ...).',
        required: ['id', 'title', 'status'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          status: { type: 'string' },
          priority: { type: 'string' },
          type: { type: 'string' },
          parentId: { type: ['string', 'null'] },
        },
      },
      view: {
        type: ['object', 'null'],
        description:
          'Canonical task view projection produced by computeTaskView. Null when unavailable.',
      },
      attachments: {
        type: 'array',
        description: 'Docs attachments linked to this task. Always an array (empty when none).',
      },
      acRows: {
        type: 'array',
        description: 'Acceptance-criterion rows (id, alias AC<n>, ordinal, text). Optional.',
      },
      relations: {
        type: 'object',
        description: 'Expanded relation/doc lists. Present only with --relations.',
      },
    },
  },
  fieldPointers: [
    '/data/task/id',
    '/data/task/title',
    '/data/task/status',
    '/data/task/priority',
    '/data/task/type',
    '/data/task/parentId',
    '/data/view/id',
    '/data/view/title',
  ],
};

// ---------------------------------------------------------------------------
// tasks.list — array-of-tasks plus counts
// ---------------------------------------------------------------------------

/**
 * OUTPUT contract for `tasks.list`.
 *
 * Grounded in {@link TasksListResult}: `{ tasks: TaskOp[], total, filtered }`.
 */
const tasksListOutputContract: OperationOutputContract = {
  operation: 'tasks.list',
  shapeNote: 'Rows are under /data/tasks (an array); counts are /data/total and /data/filtered.',
  dataSchema: {
    type: 'object',
    required: ['tasks', 'total', 'filtered'],
    additionalProperties: true,
    properties: {
      tasks: {
        type: 'array',
        description: 'Task rows matching the filters.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            status: { type: 'string' },
          },
        },
      },
      total: { type: 'number', description: 'Total tasks before filtering.' },
      filtered: { type: 'number', description: 'Number of tasks after filters applied.' },
    },
  },
  fieldPointers: [
    '/data/tasks/0/id',
    '/data/tasks/0/title',
    '/data/tasks/0/status',
    '/data/total',
    '/data/filtered',
  ],
};

// ---------------------------------------------------------------------------
// tasks.find — flat array of minimal task rows
// ---------------------------------------------------------------------------

/**
 * OUTPUT contract for `tasks.find`.
 *
 * Grounded in {@link TasksFindResult} = `MinimalTask[]` — the `data` payload is
 * the array itself (no wrapper object), so pointers index into `/data/<n>`.
 */
const tasksFindOutputContract: OperationOutputContract = {
  operation: 'tasks.find',
  shapeNote: 'data IS the array of matches (no wrapper object) — index with /data/0, /data/1, ...',
  dataSchema: {
    type: 'array',
    description: 'Array of minimal task matches.',
    items: {
      type: 'object',
      required: ['id', 'title'],
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        status: { type: 'string' },
      },
    },
  },
  fieldPointers: ['/data/0/id', '/data/0/title', '/data/0/status'],
};

// ---------------------------------------------------------------------------
// Mutation envelope shape (T9931 / T10608) — shared by add / add-batch /
// update / complete / delete. Each builds on TaskMutationEnvelope:
//   { created[], updated[], deleted[], affectedCount, mutationWarnings[], ... }
// ---------------------------------------------------------------------------

/**
 * The shared JSON Schema for the standardized task mutation envelope
 * (`TaskMutationEnvelope` — T10608 / T9931). `created`, `updated`, and
 * `deleted` are always present arrays; the gateway populates only the relevant
 * bucket. This is the reference pattern the OUTPUT-schema work models itself on.
 */
const TASK_MUTATION_DATA_SCHEMA = {
  type: 'object',
  required: ['created', 'updated', 'deleted', 'affectedCount'],
  additionalProperties: true,
  properties: {
    created: {
      type: 'array',
      description: 'Created task records (empty for update/delete-only mutations).',
      items: { type: 'object', properties: { id: { type: 'string' } } },
    },
    updated: {
      type: 'array',
      description: 'Updated task records (empty for create/delete-only mutations).',
      items: { type: 'object', properties: { id: { type: 'string' } } },
    },
    deleted: {
      type: 'array',
      description: 'Deleted task records (empty for create/update-only mutations).',
      items: { type: 'object', properties: { id: { type: 'string' } } },
    },
    affectedCount: { type: 'number', description: 'Total live rows affected by the mutation.' },
    mutationWarnings: {
      type: 'array',
      description: 'Structured partial-success/preflight warnings.',
    },
    dryRun: { type: 'boolean', description: 'True when this was a preview-only mutation.' },
    dryRunSummary: {
      type: 'object',
      description: 'Dry-run projection (wouldCreate/wouldUpdate/...). Present only for dry-run.',
    },
  },
} as const;

/**
 * OUTPUT contract for `tasks.add`.
 *
 * Grounded in {@link TasksAddResult} extends `TaskMutationEnvelope<TaskRecord[]>`
 * — the created task lands in `created[0]`.
 */
const tasksAddOutputContract: OperationOutputContract = {
  operation: 'tasks.add',
  shapeNote: 'The created task id is at /data/created/0/id.',
  dataSchema: { ...TASK_MUTATION_DATA_SCHEMA },
  fieldPointers: ['/data/created/0/id', '/data/created/0/title', '/data/affectedCount'],
};

/**
 * OUTPUT contract for `tasks.add-batch`.
 *
 * Grounded in {@link TasksAddBatchResult} extends `TaskMutationEnvelope<number>`
 * with an extra `tasks: TasksAddResult[]`. `created` carries the count; per-task
 * rows are also surfaced. For dry-run, `dryRunSummary.wouldCreate` is the
 * projected count and `insertedCount` stays 0 (see CLEO-INJECTION.md).
 */
const tasksAddBatchOutputContract: OperationOutputContract = {
  operation: 'tasks.add-batch',
  shapeNote:
    'Atomic batch insert. Use /data/created/0/id for the first created task; ' +
    'dry-run projections live under /data/dryRunSummary (wouldCreate, insertedCount=0).',
  dataSchema: {
    type: 'object',
    required: ['created', 'updated', 'deleted', 'affectedCount'],
    additionalProperties: true,
    properties: {
      ...TASK_MUTATION_DATA_SCHEMA.properties,
      tasks: {
        type: 'array',
        description: 'Per-task add results in batch order.',
      },
    },
  },
  fieldPointers: [
    '/data/created/0/id',
    '/data/affectedCount',
    '/data/dryRunSummary/wouldCreate',
    '/data/dryRunSummary/insertedCount',
  ],
};

/**
 * OUTPUT contract for `tasks.update` (and the `complete` alias, which is an
 * update to `status: done`).
 *
 * Grounded in {@link TasksUpdateQueryResult} extends
 * `TaskMutationEnvelope<[], TaskRecord[], []>` — the changed task lands in
 * `updated[0]`.
 */
const tasksUpdateOutputContract: OperationOutputContract = {
  operation: 'tasks.update',
  shapeNote:
    'The updated task is at /data/updated/0 — use /data/updated/0/id, /data/updated/0/status.',
  dataSchema: { ...TASK_MUTATION_DATA_SCHEMA },
  fieldPointers: ['/data/updated/0/id', '/data/updated/0/status', '/data/affectedCount'],
};

/**
 * OUTPUT contract for `tasks.complete`.
 *
 * Identical envelope to `tasks.update` — completion is a status mutation that
 * lands the task in `updated[0]`.
 */
const tasksCompleteOutputContract: OperationOutputContract = {
  operation: 'tasks.complete',
  shapeNote: 'Completion is a status mutation — the task is at /data/updated/0 (status=done).',
  dataSchema: { ...TASK_MUTATION_DATA_SCHEMA },
  fieldPointers: ['/data/updated/0/id', '/data/updated/0/status', '/data/affectedCount'],
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * SSoT registry of per-operation OUTPUT contracts, keyed by the canonical
 * `<domain>.<verb>` operation id. Extend this map as operations are migrated
 * to the schema-first OUTPUT surface (high-traffic first).
 *
 * @task T11692
 */
export const OUTPUT_CONTRACTS: OperationOutputContractRegistry = {
  'tasks.show': tasksShowOutputContract,
  'tasks.list': tasksListOutputContract,
  'tasks.find': tasksFindOutputContract,
  'tasks.add': tasksAddOutputContract,
  'tasks.add-batch': tasksAddBatchOutputContract,
  'tasks.update': tasksUpdateOutputContract,
  'tasks.complete': tasksCompleteOutputContract,
};
