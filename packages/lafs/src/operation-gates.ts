/**
 * Static gate table for CLEO CLI operations.
 *
 * @remarks
 * Gates are preconditions that an operation enforces at runtime — typically
 * encoded as `new CleoError(...)` throws inside core task-engine handlers.
 * Until a dynamic gate-registry lands (future work), this file provides a
 * curated static table for the 3 most-called operations so that
 * `describeOperation()` can surface them to agents without a trial-and-error
 * call.
 *
 * **Limitation**: only `tasks.add`, `tasks.complete`, and `tasks.show` are
 * seeded here.  Every other operation returns `gates: []`.  When gate-registry
 * work lands, replace this table with a registry walk and remove this note.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// GateDef — one declared precondition gate
// ---------------------------------------------------------------------------

/**
 * A single precondition gate declared on an operation.
 *
 * @remarks
 * `triggers` is a human-readable list of conditions that will cause this gate
 * to fire and return the given `errorCode`.
 */
export interface GateDef {
  /** Short machine-readable gate name (kebab-case). */
  name: string;
  /** CLEO error code emitted when the gate fires. */
  errorCode: string;
  /** One-line description of what this gate checks. */
  description: string;
  /** Human-readable list of conditions that trigger this gate. */
  triggers: string[];
}

// ---------------------------------------------------------------------------
// ExtendedParamDef — rich param descriptor for operations missing params in registry
// ---------------------------------------------------------------------------

/**
 * An extended parameter descriptor used to supplement registry operations that
 * do not yet carry a full `params` array.
 *
 * @remarks
 * This mirrors the `ParamDef` shape from the CLEO dispatch layer but lives
 * in `@cleocode/lafs` to avoid a hard import cycle.
 */
export interface ExtendedParamDef {
  /** Canonical camelCase parameter name. */
  name: string;
  /** Runtime value type. */
  type: 'string' | 'number' | 'boolean' | 'array';
  /** Whether this parameter is required. */
  required: boolean;
  /** Human-readable description. */
  description: string;
  /** Allowed values when the parameter is constrained to an enum. */
  enum?: readonly string[];
  /** CLI-specific metadata. */
  cli?: {
    positional?: boolean;
    short?: string;
    flag?: string;
    variadic?: boolean;
  };
}

/**
 * Mapping from `"<domain>.<operation>"` to extended parameter descriptors.
 *
 * @remarks
 * Used by `describeOperation()` to supplement registry operations whose
 * `params` array is absent or incomplete.  Only the 3 most-used operations
 * are seeded here.
 */
export const STATIC_PARAMS_TABLE: Record<string, ExtendedParamDef[]> = {
  'tasks.add': [
    {
      name: 'title',
      type: 'string',
      required: true,
      description: 'Task title (3–500 characters)',
      cli: { positional: true },
    },
    {
      name: 'parent',
      type: 'string',
      required: false,
      description: 'Parent task ID (makes this task a subtask)',
      cli: { flag: 'parent' },
    },
    {
      name: 'priority',
      type: 'string',
      required: false,
      description: 'Task priority',
      enum: ['low', 'medium', 'high', 'critical'] as const,
      cli: { short: '-p', flag: 'priority' },
    },
    {
      name: 'type',
      type: 'string',
      required: false,
      description: 'Task type',
      enum: ['epic', 'task', 'subtask', 'bug'] as const,
      cli: { short: '-t', flag: 'type' },
    },
    {
      name: 'size',
      type: 'string',
      required: false,
      description: 'Scope size estimate',
      enum: ['small', 'medium', 'large'] as const,
      cli: { flag: 'size' },
    },
    {
      name: 'description',
      type: 'string',
      required: false,
      description: 'Detailed task description (must differ meaningfully from title)',
      cli: { short: '-d', flag: 'description' },
    },
    {
      name: 'acceptance',
      type: 'array',
      required: false,
      description: 'Pipe-separated acceptance criteria (e.g. "AC1|AC2|AC3")',
      cli: { flag: 'acceptance' },
    },
    {
      name: 'labels',
      type: 'array',
      required: false,
      description: 'Comma-separated labels',
      cli: { short: '-l', flag: 'labels' },
    },
    {
      name: 'depends',
      type: 'array',
      required: false,
      description: 'Comma-separated dependency task IDs',
      cli: { short: '-D', flag: 'depends' },
    },
    {
      name: 'phase',
      type: 'string',
      required: false,
      description: 'Phase slug to assign the task to',
      cli: { short: '-P', flag: 'phase' },
    },
    {
      name: 'notes',
      type: 'string',
      required: false,
      description: 'Initial note entry for the task',
      cli: { flag: 'notes' },
    },
  ],

  'tasks.complete': [
    {
      name: 'taskId',
      type: 'string',
      required: true,
      description: 'ID of the task to complete',
      cli: { positional: true },
    },
    {
      name: 'force',
      type: 'boolean',
      required: false,
      description: 'Force completion even when children are not done or dependencies unresolved',
      cli: { flag: 'force' },
    },
    {
      name: 'verificationNote',
      type: 'string',
      required: false,
      description: 'Evidence that acceptance criteria were met',
      cli: { flag: 'verification-note' },
    },
  ],

  'tasks.show': [
    {
      name: 'taskId',
      type: 'string',
      required: true,
      description: 'ID of the task to retrieve',
      cli: { positional: true },
    },
  ],
};

// ---------------------------------------------------------------------------
// Static gate table (operation key = "<domain>.<operation>")
// ---------------------------------------------------------------------------

/**
 * Mapping from `"<domain>.<operation>"` to its declared gates.
 *
 * @remarks
 * Only the 3 most-used operations are seeded.  All other operations should
 * return an empty array.  See module-level note on the static-table limitation.
 */
export const STATIC_GATE_TABLE: Record<string, GateDef[]> = {
  'tasks.add': [
    {
      name: 'anti-hallucination',
      errorCode: 'E_VALIDATION_FAILED',
      description: 'Title and description must be meaningfully different',
      triggers: [
        'title and description are identical strings',
        'description is a substring of the title',
        'title is a substring of the description',
      ],
    },
    {
      name: 'acceptance-criteria-format',
      errorCode: 'E_VALIDATION_FAILED',
      description: 'Acceptance criteria must be pipe-separated checklist items',
      triggers: [
        'acceptance criteria contains fewer than 1 non-empty item after splitting on pipe (|)',
        'individual acceptance item exceeds 500 characters',
      ],
    },
    {
      name: 'parent-exists',
      errorCode: 'E_NOT_FOUND',
      description: 'Parent task must exist if --parent is specified',
      triggers: ['--parent <id> is specified but no task with that ID exists in the database'],
    },
    {
      name: 'title-length',
      errorCode: 'E_VALIDATION_FAILED',
      description: 'Title must be between 3 and 500 characters',
      triggers: ['title is shorter than 3 characters', 'title is longer than 500 characters'],
    },
  ],

  'tasks.complete': [
    {
      name: 'task-exists',
      errorCode: 'E_NOT_FOUND',
      description: 'Task must exist before it can be completed',
      triggers: ['no task with the given taskId exists in the database'],
    },
    {
      name: 'children-completion',
      errorCode: 'E_INCOMPLETE_CHILDREN',
      description: 'All direct children must be done/cancelled before parent can be completed',
      triggers: [
        'task has at least one child with status pending, active, or blocked',
        '--force flag is absent',
      ],
    },
    {
      name: 'dependency-check',
      errorCode: 'E_BLOCKED',
      description: 'All blocking dependencies must be resolved before completion',
      triggers: ['task has at least one unresolved blocking dependency', '--force flag is absent'],
    },
    {
      name: 'verification-required',
      errorCode: 'E_VERIFICATION_REQUIRED',
      description: 'Task completion requires verification evidence when acceptance criteria exist',
      triggers: [
        'task has acceptance criteria defined',
        'no --verification-note or --verify flag was supplied',
      ],
    },
  ],

  'tasks.show': [
    {
      name: 'task-exists',
      errorCode: 'E_NOT_FOUND',
      description: 'Task must exist to be shown',
      triggers: ['no task with the given taskId exists in the database'],
    },
  ],
};
