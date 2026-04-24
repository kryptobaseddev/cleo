/**
 * .cantbook YAML parser → PlaybookDefinition.
 *
 * Grammar (see contracts/playbook.ts):
 *   version: "1.0"
 *   name: <string>
 *   description?: <string>
 *   inputs?: [{name, required?, default?, description?}]
 *   nodes: [<agentic | deterministic | approval node>]
 *   edges: [{from, to, contract?:{requires?[], ensures?[]}}]
 *   error_handlers?: [{on, action, message?}]
 *
 * Validation:
 *   - version MUST be "1.0"
 *   - name MUST be non-empty
 *   - node ids MUST be unique
 *   - every edge.from + edge.to MUST reference a known node id
 *   - nodes form a DAG when combined with edges (no cycles)
 *   - agentic nodes MUST have skill OR agent (at least one)
 *   - agentic nodes MAY have context_files (thin-agent boundary, T1261 E4)
 *   - deterministic nodes MUST have command + args
 *   - approval nodes MUST have prompt
 *   - depends[] entries MUST be valid node ids
 *   - iteration_cap (max_iterations) MUST be 0..10 (hard limit)
 *
 * @task T889 / T904 / W4-7
 * @task T1261 PSYCHE E4 — context_files thin-agent boundary
 */

import { createHash } from 'node:crypto';
import type {
  PlaybookAgenticNode,
  PlaybookApprovalNode,
  PlaybookDefinition,
  PlaybookDeterministicNode,
  PlaybookEdge,
  PlaybookEnsures,
  PlaybookErrorHandler,
  PlaybookInput,
  PlaybookNode,
  PlaybookNodeOnFailure,
  PlaybookNodeType,
  PlaybookPolicy,
  PlaybookRequires,
} from '@cleocode/contracts';
import { load as yamlLoad } from 'js-yaml';

/** Supported playbook grammar version. Bump with migration plan only. */
const PLAYBOOK_VERSION = '1.0';

/** Hard ceiling on per-node retries to prevent runaway agents. */
const MAX_ITERATION_CAP = 10;

/** Allowed string literals for {@link PlaybookErrorHandler.on}. */
const ERROR_HANDLER_TRIGGERS = new Set<PlaybookErrorHandler['on']>([
  'agentic_timeout',
  'iteration_cap_exceeded',
  'contract_violation',
]);

/** Allowed string literals for {@link PlaybookErrorHandler.action}. */
const ERROR_HANDLER_ACTIONS = new Set<PlaybookErrorHandler['action']>([
  'inject_hint',
  'hitl_escalate',
  'abort',
]);

/** Allowed string literals for {@link PlaybookAgenticNode.role}. */
const AGENTIC_ROLES = new Set<NonNullable<PlaybookAgenticNode['role']>>([
  'orchestrator',
  'lead',
  'worker',
]);

/** Allowed string literals for {@link PlaybookApprovalNode.policy}. */
const APPROVAL_POLICIES = new Set<PlaybookPolicy>(['conservative', 'permissive', 'custom']);

/**
 * Error thrown on any structural or semantic parse failure. Carries a
 * `code`/`exitCode` pair so callers can bubble up consistent LAFS envelopes.
 */
export class PlaybookParseError extends Error {
  /** Stable envelope error code for LAFS. */
  readonly code = 'E_PLAYBOOK_PARSE';
  /** Process exit code used by CLI wrappers when a parse fails. */
  readonly exitCode = 70;
  /**
   * @param message - Human-readable reason the playbook is invalid.
   * @param field - Offending field path (e.g. `"nodes[0].id"`).
   * @param value - Offending value for diagnostics (never re-thrown).
   */
  constructor(
    message: string,
    public readonly field?: string,
    public readonly value?: unknown,
  ) {
    super(message);
    this.name = 'PlaybookParseError';
  }
}

/** Result of a successful {@link parsePlaybook} call. */
export interface ParsePlaybookResult {
  /** Validated, normalized definition ready for runtime execution. */
  definition: PlaybookDefinition;
  /** SHA-256 hex of the input source (for tamper detection). */
  sourceHash: string;
}

/**
 * Parse raw .cantbook YAML text into a validated {@link PlaybookDefinition}.
 *
 * @param source - Raw .cantbook YAML text.
 * @returns The validated definition plus a deterministic SHA-256 source hash.
 * @throws {PlaybookParseError} On any structural or semantic violation.
 */
export function parsePlaybook(source: string): ParsePlaybookResult {
  // 1. YAML parse
  let raw: unknown;
  try {
    raw = yamlLoad(source);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new PlaybookParseError(`YAML syntax error: ${msg}`);
  }
  if (!isRecord(raw)) {
    throw new PlaybookParseError('.cantbook must be a YAML map at top level');
  }

  // 2. Validate version
  if (raw.version !== PLAYBOOK_VERSION) {
    throw new PlaybookParseError(
      `Unsupported version: ${formatValue(raw.version)}. Only "${PLAYBOOK_VERSION}" is supported.`,
      'version',
      raw.version,
    );
  }
  const version = raw.version;

  // 3. Validate name
  if (typeof raw.name !== 'string' || raw.name.length === 0) {
    throw new PlaybookParseError('name must be a non-empty string', 'name', raw.name);
  }
  const name = raw.name;

  // 4. Parse nodes
  if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) {
    throw new PlaybookParseError('nodes must be a non-empty array', 'nodes', raw.nodes);
  }
  const nodes: PlaybookNode[] = raw.nodes.map((n, i) => parseNode(n, i));

  // 5. Check node id uniqueness
  const ids = new Set<string>();
  for (const n of nodes) {
    if (ids.has(n.id)) {
      throw new PlaybookParseError(`duplicate node id: ${n.id}`, 'nodes', n.id);
    }
    ids.add(n.id);
  }

  // 6. Parse edges
  const edgesRaw = raw.edges === undefined ? [] : raw.edges;
  if (!Array.isArray(edgesRaw)) {
    throw new PlaybookParseError('edges must be an array', 'edges', edgesRaw);
  }
  const edges: PlaybookEdge[] = edgesRaw.map((e, i) => parseEdge(e, i, ids));

  // 7. Validate depends[] references (must exist as known node ids)
  for (const n of nodes) {
    if (!n.depends) continue;
    for (const dep of n.depends) {
      if (!ids.has(dep)) {
        throw new PlaybookParseError(`node ${n.id} depends on unknown node ${dep}`, 'depends', dep);
      }
    }
  }

  // 8. Iteration cap enforcement (0..MAX_ITERATION_CAP inclusive)
  for (const n of nodes) {
    const cap = n.on_failure?.max_iterations;
    if (cap !== undefined && (cap < 0 || cap > MAX_ITERATION_CAP)) {
      throw new PlaybookParseError(
        `node ${n.id} max_iterations must be 0..${MAX_ITERATION_CAP} (got ${cap})`,
        'max_iterations',
        cap,
      );
    }
  }

  // 9. DAG check (edges + depends both contribute to the graph)
  if (hasCycle(nodes, edges)) {
    throw new PlaybookParseError('playbook contains a cycle in node graph');
  }

  // 10. Build definition
  const definition: PlaybookDefinition = {
    version,
    name,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    inputs: parseInputs(raw.inputs),
    nodes,
    edges,
    error_handlers: parseErrorHandlers(raw.error_handlers),
  };

  const sourceHash = createHash('sha256').update(source).digest('hex');
  return { definition, sourceHash };
}

/**
 * Parse a single node entry. Dispatches on `type` to the appropriate
 * specialization validator.
 *
 * @param raw - Raw YAML node object.
 * @param index - Zero-based index for error messages.
 */
function parseNode(raw: unknown, index: number): PlaybookNode {
  if (!isRecord(raw)) {
    throw new PlaybookParseError(`nodes[${index}] must be an object`, `nodes[${index}]`, raw);
  }
  if (typeof raw.id !== 'string' || raw.id.length === 0) {
    throw new PlaybookParseError(
      `nodes[${index}].id must be a non-empty string`,
      `nodes[${index}].id`,
      raw.id,
    );
  }
  const id = raw.id;

  if (typeof raw.type !== 'string') {
    throw new PlaybookParseError(
      `nodes[${index}].type must be a string`,
      `nodes[${index}].type`,
      raw.type,
    );
  }
  const type = raw.type as PlaybookNodeType;

  const description = typeof raw.description === 'string' ? raw.description : undefined;
  const depends = parseStringArray(raw.depends, `nodes[${index}].depends`);
  const requires = parseRequires(raw.requires, `nodes[${index}].requires`);
  const ensures = parseEnsures(raw.ensures, `nodes[${index}].ensures`);
  const on_failure = parseOnFailure(raw.on_failure, `nodes[${index}].on_failure`);

  const base = {
    id,
    description,
    depends,
    requires,
    ensures,
    on_failure,
  };

  switch (type) {
    case 'agentic':
      return parseAgenticNode(raw, base, index);
    case 'deterministic':
      return parseDeterministicNode(raw, base, index);
    case 'approval':
      return parseApprovalNode(raw, base, index);
    default:
      throw new PlaybookParseError(
        `nodes[${index}].type must be one of agentic | deterministic | approval (got ${formatValue(
          raw.type,
        )})`,
        `nodes[${index}].type`,
        raw.type,
      );
  }
}

/** Shared shape assembled before node-type specialization. */
type BaseNodeFields = {
  id: string;
  description?: string;
  depends?: string[];
  requires?: PlaybookRequires;
  ensures?: PlaybookEnsures;
  on_failure?: PlaybookNodeOnFailure;
};

function parseAgenticNode(
  raw: Record<string, unknown>,
  base: BaseNodeFields,
  index: number,
): PlaybookAgenticNode {
  const skill = typeof raw.skill === 'string' ? raw.skill : undefined;
  const agent = typeof raw.agent === 'string' ? raw.agent : undefined;
  if (!skill && !agent) {
    throw new PlaybookParseError(
      `nodes[${index}] (agentic) must define at least one of 'skill' or 'agent'`,
      `nodes[${index}]`,
      raw,
    );
  }

  let role: PlaybookAgenticNode['role'];
  if (raw.role !== undefined) {
    if (
      typeof raw.role !== 'string' ||
      !AGENTIC_ROLES.has(raw.role as PlaybookAgenticNode['role'] as never)
    ) {
      throw new PlaybookParseError(
        `nodes[${index}].role must be one of orchestrator | lead | worker (got ${formatValue(
          raw.role,
        )})`,
        `nodes[${index}].role`,
        raw.role,
      );
    }
    role = raw.role as PlaybookAgenticNode['role'];
  }

  let inputs: Record<string, string> | undefined;
  if (raw.inputs !== undefined) {
    if (!isRecord(raw.inputs)) {
      throw new PlaybookParseError(
        `nodes[${index}].inputs must be an object`,
        `nodes[${index}].inputs`,
        raw.inputs,
      );
    }
    const acc: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.inputs)) {
      if (typeof v !== 'string') {
        throw new PlaybookParseError(
          `nodes[${index}].inputs.${k} must be a string`,
          `nodes[${index}].inputs.${k}`,
          v,
        );
      }
      acc[k] = v;
    }
    inputs = acc;
  }

  const context_files = parseStringArray(raw.context_files, `nodes[${index}].context_files`);

  return {
    ...base,
    type: 'agentic',
    skill,
    agent,
    role,
    inputs,
    ...(context_files !== undefined ? { context_files } : {}),
  };
}

function parseDeterministicNode(
  raw: Record<string, unknown>,
  base: BaseNodeFields,
  index: number,
): PlaybookDeterministicNode {
  if (typeof raw.command !== 'string' || raw.command.length === 0) {
    throw new PlaybookParseError(
      `nodes[${index}] (deterministic) must have a non-empty 'command'`,
      `nodes[${index}].command`,
      raw.command,
    );
  }
  const args = parseStringArray(raw.args, `nodes[${index}].args`) ?? [];

  const cwd = typeof raw.cwd === 'string' ? raw.cwd : undefined;

  let env: Record<string, string> | undefined;
  if (raw.env !== undefined) {
    if (!isRecord(raw.env)) {
      throw new PlaybookParseError(
        `nodes[${index}].env must be an object`,
        `nodes[${index}].env`,
        raw.env,
      );
    }
    const acc: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.env)) {
      if (typeof v !== 'string') {
        throw new PlaybookParseError(
          `nodes[${index}].env.${k} must be a string`,
          `nodes[${index}].env.${k}`,
          v,
        );
      }
      acc[k] = v;
    }
    env = acc;
  }

  let timeout_ms: number | undefined;
  if (raw.timeout_ms !== undefined) {
    if (
      typeof raw.timeout_ms !== 'number' ||
      !Number.isFinite(raw.timeout_ms) ||
      raw.timeout_ms < 0
    ) {
      throw new PlaybookParseError(
        `nodes[${index}].timeout_ms must be a non-negative number`,
        `nodes[${index}].timeout_ms`,
        raw.timeout_ms,
      );
    }
    timeout_ms = raw.timeout_ms;
  }

  return {
    ...base,
    type: 'deterministic',
    command: raw.command,
    args,
    cwd,
    env,
    timeout_ms,
  };
}

function parseApprovalNode(
  raw: Record<string, unknown>,
  base: BaseNodeFields,
  index: number,
): PlaybookApprovalNode {
  if (typeof raw.prompt !== 'string' || raw.prompt.length === 0) {
    throw new PlaybookParseError(
      `nodes[${index}] (approval) must have a non-empty 'prompt'`,
      `nodes[${index}].prompt`,
      raw.prompt,
    );
  }

  let policy: PlaybookPolicy | undefined;
  if (raw.policy !== undefined) {
    if (typeof raw.policy !== 'string' || !APPROVAL_POLICIES.has(raw.policy as PlaybookPolicy)) {
      throw new PlaybookParseError(
        `nodes[${index}].policy must be one of conservative | permissive | custom (got ${formatValue(
          raw.policy,
        )})`,
        `nodes[${index}].policy`,
        raw.policy,
      );
    }
    policy = raw.policy as PlaybookPolicy;
  }

  return {
    ...base,
    type: 'approval',
    prompt: raw.prompt,
    policy,
  };
}

/**
 * Parse a single edge entry. Edges reference existing node ids by the time
 * this is called (the `ids` set is fully populated before edge parsing).
 */
function parseEdge(raw: unknown, index: number, ids: ReadonlySet<string>): PlaybookEdge {
  if (!isRecord(raw)) {
    throw new PlaybookParseError(`edges[${index}] must be an object`, `edges[${index}]`, raw);
  }
  if (typeof raw.from !== 'string' || raw.from.length === 0) {
    throw new PlaybookParseError(
      `edges[${index}].from must be a non-empty string`,
      `edges[${index}].from`,
      raw.from,
    );
  }
  if (typeof raw.to !== 'string' || raw.to.length === 0) {
    throw new PlaybookParseError(
      `edges[${index}].to must be a non-empty string`,
      `edges[${index}].to`,
      raw.to,
    );
  }
  if (!ids.has(raw.from)) {
    throw new PlaybookParseError(
      `edges[${index}].from references unknown node ${raw.from}`,
      `edges[${index}].from`,
      raw.from,
    );
  }
  if (!ids.has(raw.to)) {
    throw new PlaybookParseError(
      `edges[${index}].to references unknown node ${raw.to}`,
      `edges[${index}].to`,
      raw.to,
    );
  }

  let contract: PlaybookEdge['contract'];
  if (raw.contract !== undefined) {
    if (!isRecord(raw.contract)) {
      throw new PlaybookParseError(
        `edges[${index}].contract must be an object`,
        `edges[${index}].contract`,
        raw.contract,
      );
    }
    const requires = parseStringArray(raw.contract.requires, `edges[${index}].contract.requires`);
    const ensures = parseStringArray(raw.contract.ensures, `edges[${index}].contract.ensures`);
    contract = { requires, ensures };
  }

  return { from: raw.from, to: raw.to, contract };
}

function parseInputs(raw: unknown): PlaybookInput[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new PlaybookParseError('inputs must be an array', 'inputs', raw);
  }
  return raw.map((r, i) => {
    if (!isRecord(r)) {
      throw new PlaybookParseError(`inputs[${i}] must be an object`, `inputs[${i}]`, r);
    }
    if (typeof r.name !== 'string' || r.name.length === 0) {
      throw new PlaybookParseError(
        `inputs[${i}].name must be a non-empty string`,
        `inputs[${i}].name`,
        r.name,
      );
    }
    let required: boolean | undefined;
    if (r.required !== undefined) {
      if (typeof r.required !== 'boolean') {
        throw new PlaybookParseError(
          `inputs[${i}].required must be boolean`,
          `inputs[${i}].required`,
          r.required,
        );
      }
      required = r.required;
    }
    const description = typeof r.description === 'string' ? r.description : undefined;
    const input: PlaybookInput = { name: r.name };
    if (required !== undefined) input.required = required;
    if (Object.hasOwn(r, 'default')) input.default = r.default;
    if (description !== undefined) input.description = description;
    return input;
  });
}

function parseErrorHandlers(raw: unknown): PlaybookErrorHandler[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new PlaybookParseError('error_handlers must be an array', 'error_handlers', raw);
  }
  return raw.map((r, i) => {
    if (!isRecord(r)) {
      throw new PlaybookParseError(
        `error_handlers[${i}] must be an object`,
        `error_handlers[${i}]`,
        r,
      );
    }
    if (
      typeof r.on !== 'string' ||
      !ERROR_HANDLER_TRIGGERS.has(r.on as PlaybookErrorHandler['on'])
    ) {
      throw new PlaybookParseError(
        `error_handlers[${i}].on must be one of agentic_timeout | iteration_cap_exceeded | contract_violation (got ${formatValue(
          r.on,
        )})`,
        `error_handlers[${i}].on`,
        r.on,
      );
    }
    if (
      typeof r.action !== 'string' ||
      !ERROR_HANDLER_ACTIONS.has(r.action as PlaybookErrorHandler['action'])
    ) {
      throw new PlaybookParseError(
        `error_handlers[${i}].action must be one of inject_hint | hitl_escalate | abort (got ${formatValue(
          r.action,
        )})`,
        `error_handlers[${i}].action`,
        r.action,
      );
    }
    const message = typeof r.message === 'string' ? r.message : undefined;
    return {
      on: r.on as PlaybookErrorHandler['on'],
      action: r.action as PlaybookErrorHandler['action'],
      message,
    };
  });
}

function parseRequires(raw: unknown, field: string): PlaybookRequires | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    throw new PlaybookParseError(`${field} must be an object`, field, raw);
  }
  const from = typeof raw.from === 'string' ? raw.from : undefined;
  const fields = parseStringArray(raw.fields, `${field}.fields`);
  const schema = typeof raw.schema === 'string' ? raw.schema : undefined;
  return { from, fields, schema };
}

function parseEnsures(raw: unknown, field: string): PlaybookEnsures | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    throw new PlaybookParseError(`${field} must be an object`, field, raw);
  }
  const outputFiles = parseStringArray(raw.outputFiles, `${field}.outputFiles`);
  let exitCode: number | undefined;
  if (raw.exitCode !== undefined) {
    if (typeof raw.exitCode !== 'number' || !Number.isInteger(raw.exitCode)) {
      throw new PlaybookParseError(
        `${field}.exitCode must be an integer`,
        `${field}.exitCode`,
        raw.exitCode,
      );
    }
    exitCode = raw.exitCode;
  }
  const schema = typeof raw.schema === 'string' ? raw.schema : undefined;
  return { outputFiles, exitCode, schema };
}

function parseOnFailure(raw: unknown, field: string): PlaybookNodeOnFailure | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    throw new PlaybookParseError(`${field} must be an object`, field, raw);
  }
  const inject_into = typeof raw.inject_into === 'string' ? raw.inject_into : undefined;
  let max_iterations: number | undefined;
  if (raw.max_iterations !== undefined) {
    if (typeof raw.max_iterations !== 'number' || !Number.isInteger(raw.max_iterations)) {
      throw new PlaybookParseError(
        `${field}.max_iterations must be an integer`,
        `${field}.max_iterations`,
        raw.max_iterations,
      );
    }
    max_iterations = raw.max_iterations;
  }
  let escalate: boolean | undefined;
  if (raw.escalate !== undefined) {
    if (typeof raw.escalate !== 'boolean') {
      throw new PlaybookParseError(
        `${field}.escalate must be boolean`,
        `${field}.escalate`,
        raw.escalate,
      );
    }
    escalate = raw.escalate;
  }
  return { inject_into, max_iterations, escalate };
}

function parseStringArray(raw: unknown, field: string): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new PlaybookParseError(`${field} must be an array of strings`, field, raw);
  }
  return raw.map((v, i) => {
    if (typeof v !== 'string') {
      throw new PlaybookParseError(`${field}[${i}] must be a string`, `${field}[${i}]`, v);
    }
    return v;
  });
}

/**
 * Detect cycles across the combined edge-set (explicit `edges[]` plus
 * `depends[]` back-references). Uses 3-color DFS.
 *
 * @returns `true` if any cycle exists.
 */
function hasCycle(nodes: readonly PlaybookNode[], edges: readonly PlaybookEdge[]): boolean {
  const adj = new Map<string, Set<string>>();
  for (const n of nodes) adj.set(n.id, new Set());
  for (const e of edges) adj.get(e.from)?.add(e.to);
  // depends[] is a reverse dependency: dep → node. Add as incoming edge for DAG purposes.
  for (const n of nodes) {
    if (!n.depends) continue;
    for (const dep of n.depends) adj.get(dep)?.add(n.id);
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const n of nodes) color.set(n.id, WHITE);

  function visit(id: string): boolean {
    color.set(id, GRAY);
    for (const next of adj.get(id) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) return true;
      if (c === WHITE && visit(next)) return true;
    }
    color.set(id, BLACK);
    return false;
  }

  for (const n of nodes) {
    if (color.get(n.id) === WHITE && visit(n.id)) return true;
  }
  return false;
}

/**
 * Type guard for YAML maps. `yaml.load` returns `unknown`, so we narrow here
 * rather than using broad casts.
 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Format arbitrary input for error messages without leaking huge structures. */
function formatValue(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return typeof v;
}
