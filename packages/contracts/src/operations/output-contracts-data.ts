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
 * `./tasks.js` (e.g. {@link TasksShowResult}, {@link MinimalMutateEnvelope}) so
 * the schema can never drift from the typed shape without a compile-time touch
 * to this file.
 *
 * @packageDocumentation
 * @module @cleocode/contracts/operations/output-contracts-data
 *
 * @epic T11679
 * @task T11692 — DHQ-057: per-operation output schema SSoT
 */

import {
  accountAddOutputContract,
  accountListOutputContract,
  accountRemoveOutputContract,
  modelQueryOutputContract,
  modelShowOutputContract,
  profileCreateOutputContract,
  profileListOutputContract,
  profilePinOutputContract,
  profileUseOutputContract,
  providerConnectOutputContract,
  providerListOutputContract,
  providerShowOutputContract,
} from './entities.js';
import type {
  OperationOutputContract,
  OperationOutputContractRegistry,
} from './output-contract.js';
import {
  serviceConnectOutputContract,
  serviceListOutputContract,
  serviceRevokeOutputContract,
  serviceStatusOutputContract,
} from './service.js';

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
    '`view` may be null. `acRows` and `relations` are conditional.',
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
// tasks.find — { results: MinimalTask[], total, query, searchType }
// ---------------------------------------------------------------------------

/**
 * OUTPUT contract for `tasks.find`.
 *
 * Grounded in the actual return shape from `findTasks()` (find.ts:503-505)
 * and the MVI projection plan (mvi-projection.ts:330 `path: 'results'`):
 * `{ results: MinimalTask[], total: number, query: string, searchType: string }`.
 *
 * The `data` payload is a **wrapper object** (NOT a bare array). Results live
 * under `/data/results`; the total count is at `/data/total`.
 */
const tasksFindOutputContract: OperationOutputContract = {
  operation: 'tasks.find',
  shapeNote:
    'Results are wrapped: /data/results (array of matches), /data/total (count). ' +
    'Use /data/results/0/id — NOT /data/0/id.',
  dataSchema: {
    type: 'object',
    required: ['results', 'total'],
    additionalProperties: true,
    properties: {
      results: {
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
      total: { type: 'number', description: 'Total matching tasks.' },
      query: { type: 'string', description: 'The query string that was searched.' },
      searchType: { type: 'string', description: 'Kind of search performed (fts, semantic, ...).' },
    },
  },
  fieldPointers: [
    '/data/results/0/id',
    '/data/results/0/title',
    '/data/results/0/status',
    '/data/total',
  ],
};

// ---------------------------------------------------------------------------
// Mutation envelope shape (T9931 / T10608) — shared by add / add-batch /
// update / complete / delete.
//
// DEFAULT (minimal) shape — what `--field` resolves against — is
// `MinimalMutateEnvelope` from `mutate-projection.ts`:
//   { count, created: string[], updated: string[], deleted: string[], ids: string[], ... }
//
// `created`, `updated`, and `deleted` contain BARE TASK ID STRINGS, not
// objects. `/data/created/0` resolves to a string like "T11692" directly.
// The object-array shape (`TaskMutationEnvelope`) is the `--full` shape only.
// ---------------------------------------------------------------------------

/**
 * The shared JSON Schema for the minimal mutate projection envelope
 * (`MinimalMutateEnvelope` — T9931 / mutate-projection.ts). `created`,
 * `updated`, and `deleted` are always present arrays of **bare task ID strings**
 * (not objects). The gateway populates only the relevant bucket. Pointers:
 * - `/data/created/0` → first created task ID string (e.g. "T11692")
 * - `/data/updated/0` → first updated task ID string
 * - `/data/deleted/0` → first deleted task ID string
 *
 * This is the DEFAULT shape (applies unless caller passes `--full`).
 */
const TASK_MUTATION_DATA_SCHEMA = {
  type: 'object',
  required: ['count', 'created', 'updated', 'deleted'],
  additionalProperties: true,
  properties: {
    count: { type: 'number', description: 'Number of records the mutation affected.' },
    created: {
      type: 'array',
      description:
        'Task IDs created by the mutation (bare strings, e.g. "T11692"). ' +
        'Empty for update/delete-only mutations.',
      items: { type: 'string' },
    },
    updated: {
      type: 'array',
      description:
        'Task IDs updated by the mutation (bare strings). ' +
        'Empty for create/delete-only mutations.',
      items: { type: 'string' },
    },
    deleted: {
      type: 'array',
      description:
        'Task IDs deleted by the mutation (bare strings). ' +
        'Empty for create/update-only mutations.',
      items: { type: 'string' },
    },
    ids: {
      type: 'array',
      description: 'Deprecated alias for the non-empty bucket. Prefer created/updated/deleted.',
      items: { type: 'string' },
    },
    dryRun: { type: 'boolean', description: 'True when this was a preview-only mutation.' },
    status: { type: 'string', description: 'Post-mutation task status (add/update/complete).' },
  },
} as const;

/**
 * OUTPUT contract for `tasks.add`.
 *
 * Grounded in `MinimalMutateEnvelope` (mutate-projection.ts) — the created
 * task ID lands as a bare string in `created[0]`.
 * Use `/data/created/0` (a string like "T11692"), NOT `/data/created/0/id`.
 */
const tasksAddOutputContract: OperationOutputContract = {
  operation: 'tasks.add',
  shapeNote:
    'The created task ID (bare string) is at /data/created/0 — NOT /data/created/0/id. ' +
    'Example: /data/created/0 → "T11692".',
  dataSchema: { ...TASK_MUTATION_DATA_SCHEMA },
  fieldPointers: ['/data/created/0', '/data/count'],
};

/**
 * OUTPUT contract for `tasks.add-batch`.
 *
 * Grounded in `MinimalMutateEnvelope` (mutate-projection.ts). For dry-run,
 * `wouldCreate` and `insertedCount` are projected to the **root** of the
 * envelope data (NOT under `dryRunSummary`) — confirmed in
 * mutate-projection.ts lines 224/232.
 */
const tasksAddBatchOutputContract: OperationOutputContract = {
  operation: 'tasks.add-batch',
  shapeNote:
    'Atomic batch insert. Each created task ID (bare string) is in /data/created (array). ' +
    'Dry-run projections are at root: /data/wouldCreate and /data/insertedCount (=0). ' +
    'NOT under /data/dryRunSummary.',
  dataSchema: {
    type: 'object',
    required: ['count', 'created', 'updated', 'deleted'],
    additionalProperties: true,
    properties: {
      ...TASK_MUTATION_DATA_SCHEMA.properties,
      wouldCreate: {
        type: 'number',
        description: 'Dry-run: predicted write count. Present only when dryRun=true.',
      },
      insertedCount: {
        type: 'number',
        description: 'Dry-run: always 0 (no DB write). Present only when dryRun=true.',
      },
      wouldAffect: {
        type: 'number',
        description: 'Dry-run: generic affected count. Present only when dryRun=true.',
      },
    },
  },
  fieldPointers: ['/data/created/0', '/data/count', '/data/wouldCreate', '/data/insertedCount'],
};

/**
 * OUTPUT contract for `tasks.update` (and the `complete` alias, which is an
 * update to `status: done`).
 *
 * Grounded in `MinimalMutateEnvelope` (mutate-projection.ts) — the changed
 * task ID lands as a bare string in `updated[0]`.
 * Use `/data/updated/0` (a string like "T11692"), NOT `/data/updated/0/id`.
 */
const tasksUpdateOutputContract: OperationOutputContract = {
  operation: 'tasks.update',
  shapeNote:
    'The updated task ID (bare string) is at /data/updated/0 — NOT /data/updated/0/id. ' +
    'Use /data/status for the post-mutation status.',
  dataSchema: { ...TASK_MUTATION_DATA_SCHEMA },
  fieldPointers: ['/data/updated/0', '/data/status', '/data/count'],
};

/**
 * OUTPUT contract for `tasks.complete`.
 *
 * Identical envelope to `tasks.update` — completion is a status mutation that
 * lands the task ID in `updated[0]` as a bare string.
 */
const tasksCompleteOutputContract: OperationOutputContract = {
  operation: 'tasks.complete',
  shapeNote:
    'Completion is a status mutation — the task ID (bare string) is at /data/updated/0 ' +
    '(status=done). Use /data/status for the post-mutation status.',
  dataSchema: { ...TASK_MUTATION_DATA_SCHEMA },
  fieldPointers: ['/data/updated/0', '/data/status', '/data/count'],
};

// ---------------------------------------------------------------------------
// tasks.reorder-rank / tasks.bulk-move / tasks.assignee — bulk Kanban mutate
// ops (T11786 · epic T11556). These ops have NO MUTATE_PROJECTION_PLANS entry,
// so their raw core result is returned under `envelope.data` unchanged.
// ---------------------------------------------------------------------------

/**
 * OUTPUT contract for `tasks.reorder-rank`.
 *
 * Grounded in `TasksReorderRankResult`: `{ ranked, skipped, count }`. `ranked`
 * is the new top-to-bottom order; `skipped` lists request IDs that did not
 * resolve to a task.
 */
const tasksReorderRankOutputContract: OperationOutputContract = {
  operation: 'tasks.reorder-rank',
  shapeNote:
    'Re-ranked IDs (new order) at /data/ranked; unresolved request IDs at /data/skipped; count at /data/count.',
  dataSchema: {
    type: 'object',
    required: ['ranked', 'skipped', 'count'],
    additionalProperties: true,
    properties: {
      ranked: {
        type: 'array',
        description: 'Task IDs whose position was written, in the new top-to-bottom order.',
        items: { type: 'string' },
      },
      skipped: {
        type: 'array',
        description: 'Request IDs that did not resolve to a task (no-op for these).',
        items: { type: 'string' },
      },
      count: { type: 'number', description: 'Number of tasks re-ranked.' },
    },
  },
  fieldPointers: ['/data/ranked/0', '/data/skipped/0', '/data/count'],
};

/**
 * OUTPUT contract for `tasks.bulk-move`.
 *
 * Grounded in `TasksBulkMoveResult`: `{ moved, status?, pipelineStage?, count }`.
 */
const tasksBulkMoveOutputContract: OperationOutputContract = {
  operation: 'tasks.bulk-move',
  shapeNote:
    'Moved task IDs at /data/moved (all-or-nothing); applied status/stage at /data/status and /data/pipelineStage; count at /data/count.',
  dataSchema: {
    type: 'object',
    required: ['moved', 'count'],
    additionalProperties: true,
    properties: {
      moved: {
        type: 'array',
        description: 'Task IDs successfully moved (atomic — empty only when count is 0).',
        items: { type: 'string' },
      },
      status: { type: 'string', description: 'The status applied, when supplied.' },
      pipelineStage: { type: 'string', description: 'The pipeline stage applied, when supplied.' },
      count: { type: 'number', description: 'Number of tasks moved.' },
    },
  },
  fieldPointers: ['/data/moved/0', '/data/status', '/data/pipelineStage', '/data/count'],
};

/**
 * OUTPUT contract for `tasks.assignee`.
 *
 * Grounded in `TasksAssigneeResult`: `{ taskId, assignee, assigned }`. `assignee`
 * is null when cleared; `assigned` is the boolean verb result.
 */
const tasksAssigneeOutputContract: OperationOutputContract = {
  operation: 'tasks.assignee',
  shapeNote:
    'The new assignee is at /data/assignee (null when cleared); /data/assigned is true on set, false on clear.',
  dataSchema: {
    type: 'object',
    required: ['taskId', 'assignee', 'assigned'],
    additionalProperties: true,
    properties: {
      taskId: { type: 'string', description: 'The task ID whose assignee changed.' },
      assignee: {
        type: ['string', 'null'],
        description: 'The new assignee value (null when cleared).',
      },
      assigned: { type: 'boolean', description: 'True when an assignee was set; false on clear.' },
    },
  },
  fieldPointers: ['/data/taskId', '/data/assignee', '/data/assigned'],
};

// ---------------------------------------------------------------------------
// admin.config.* — config-as-domain (T11917 · M5/AC3 · ConfigManifest cascade)
// ---------------------------------------------------------------------------

/**
 * OUTPUT contract for `admin.config.get`.
 *
 * Grounded in `AdminConfigGetResult`: `{ key, scope, value, found }`. The
 * resolved value lives at `/data/value`; `found` disambiguates a present `null`
 * value from an absent key.
 */
const adminConfigGetOutputContract: OperationOutputContract = {
  operation: 'admin.config.get',
  shapeNote:
    'The resolved value is at /data/value (may be null). /data/found is false when the key is absent.',
  dataSchema: {
    type: 'object',
    required: ['key', 'scope', 'value', 'found'],
    additionalProperties: true,
    properties: {
      key: { type: 'string', description: 'The dot-notation key that was resolved.' },
      scope: {
        type: 'string',
        description: 'Cascade slice the value was resolved against.',
        enum: ['global', 'project', 'merged'],
      },
      value: { description: 'Resolved value, or null when the key is absent.' },
      found: { type: 'boolean', description: 'True IFF the key resolved to a defined value.' },
    },
  },
  fieldPointers: ['/data/key', '/data/scope', '/data/value', '/data/found'],
};

/**
 * OUTPUT contract for `admin.config.list`.
 *
 * Grounded in `AdminConfigListResult`: `{ scope, config, keys }`. The full
 * resolved config object is at `/data/config`; flattened keys are at
 * `/data/keys`.
 */
const adminConfigListOutputContract: OperationOutputContract = {
  operation: 'admin.config.list',
  shapeNote:
    'The full resolved config is at /data/config (an object); flattened dot-notation keys are at /data/keys (an array).',
  dataSchema: {
    type: 'object',
    required: ['scope', 'config', 'keys'],
    additionalProperties: true,
    properties: {
      scope: {
        type: 'string',
        description: 'Cascade slice the config was resolved against.',
        enum: ['global', 'project', 'merged'],
      },
      config: {
        type: 'object',
        description: 'Full resolved config object for the slice.',
        additionalProperties: true,
      },
      keys: {
        type: 'array',
        description: 'Flattened dot-notation keys present in the resolved config.',
        items: { type: 'string' },
      },
    },
  },
  fieldPointers: ['/data/scope', '/data/keys/0', '/data/keys'],
};

/**
 * OUTPUT contract for `admin.config.validate`.
 *
 * Grounded in `AdminConfigValidateResult`: `{ scope, ok, issues }`. `ok` is the
 * pass/fail verdict; `issues` carries human-readable rejection reasons.
 */
const adminConfigValidateOutputContract: OperationOutputContract = {
  operation: 'admin.config.validate',
  shapeNote:
    'The pass/fail verdict is at /data/ok; rejection reasons are at /data/issues (empty when ok=true).',
  dataSchema: {
    type: 'object',
    required: ['scope', 'ok', 'issues'],
    additionalProperties: true,
    properties: {
      scope: {
        type: 'string',
        description: 'Scope that was validated.',
        enum: ['global', 'project'],
      },
      ok: { type: 'boolean', description: 'True IFF every gate passed.' },
      issues: {
        type: 'array',
        description: 'Human-readable schema issues. Empty when ok=true.',
        items: { type: 'string' },
      },
    },
  },
  fieldPointers: ['/data/scope', '/data/ok', '/data/issues/0', '/data/issues'],
};

/**
 * OUTPUT contract for `admin.config.unset`.
 *
 * Grounded in `AdminConfigUnsetResult`: `{ key, scope, removed }`. `removed` is
 * `true` IFF the key existed and was deleted (idempotent: `false` when absent).
 */
const adminConfigUnsetOutputContract: OperationOutputContract = {
  operation: 'admin.config.unset',
  shapeNote:
    '/data/removed is true IFF a value was deleted; false when the key was already absent (idempotent).',
  dataSchema: {
    type: 'object',
    required: ['key', 'scope', 'removed'],
    additionalProperties: true,
    properties: {
      key: { type: 'string', description: 'The dot-notation key that was targeted.' },
      scope: {
        type: 'string',
        description: 'Scope the key was removed from.',
        enum: ['project', 'global'],
      },
      removed: { type: 'boolean', description: 'True IFF a value was actually deleted.' },
    },
  },
  fieldPointers: ['/data/key', '/data/scope', '/data/removed'],
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
  // T11786 (epic T11556) — bulk Kanban mutate ops.
  'tasks.reorder-rank': tasksReorderRankOutputContract,
  'tasks.bulk-move': tasksBulkMoveOutputContract,
  'tasks.assignee': tasksAssigneeOutputContract,
  'admin.config.get': adminConfigGetOutputContract,
  'admin.config.list': adminConfigListOutputContract,
  'admin.config.validate': adminConfigValidateOutputContract,
  'admin.config.unset': adminConfigUnsetOutputContract,
  // service-vault CLI verbs (T11941 · epic T11765 · M2-W4)
  'service.connect': serviceConnectOutputContract,
  'service.list': serviceListOutputContract,
  'service.revoke': serviceRevokeOutputContract,
  'service.status': serviceStatusOutputContract,
  // 5-entity provider-experience ops (T11700 · epic T11666)
  'account.add': accountAddOutputContract,
  'account.list': accountListOutputContract,
  'account.remove': accountRemoveOutputContract,
  'provider.list': providerListOutputContract,
  'provider.show': providerShowOutputContract,
  'provider.connect': providerConnectOutputContract,
  'model.query': modelQueryOutputContract,
  'model.show': modelShowOutputContract,
  'profile.create': profileCreateOutputContract,
  'profile.list': profileListOutputContract,
  'profile.pin': profilePinOutputContract,
  'profile.use': profileUseOutputContract,
};
