/**
 * Docs Provenance Graph contract — cross-entity nodes + edges.
 *
 * Typed shape for the cross-entity provenance graph returned by C7
 * (`cleo docs provenance` / `cleo docs graph`). A {@link DocProvenanceResponse}
 * is the wire format consumed by the human renderer registered for the
 * `(command='docs', kind='provenance')` slot — the same renderer family that
 * consumes {@link TreeResponse} envelopes from E11.
 *
 * Nodes carry a `kind` discriminator (`doc` | `task` | `decision` | `session` |
 * `memory`) so the renderer can pick the correct icon, colour, and detail
 * layout per entity. Edges carry a `relation` discriminator that names the
 * semantic link between two nodes (`attached-to`, `supersedes`,
 * `superseded-by`, `related-task`, `linked-decision`, `derived-from`).
 *
 * This contract is intentionally read-only — every field is `readonly`, every
 * array is `ReadonlyArray<…>` — so consumers cannot mutate the graph after
 * receiving it from `cleo docs provenance`. Mutations flow through writer
 * verbs (`cleo docs add`, `cleo docs supersede`, …) and emit a fresh graph on
 * the next read.
 *
 * @see TreeResponse — E11 T10138 — the sibling envelope shape this contract
 *   composes with (a docs provenance UI may render the doc-subset as a tree).
 * @see DocKindRegistry — packages/contracts/src/docs-taxonomy.ts — supplies
 *   the `kind` string carried on each {@link ProvenanceDocNode}.
 * @see ADR-077 §3 — Human Render Contract (envelope kind discriminator).
 * @see ADR-078 — Docs Provenance Graph (cross-entity edge taxonomy).
 *
 * @epic T10157 — Docs Provenance Graph (E12)
 * @task T10166
 */

import { z } from 'zod';

// ─── Node discriminator + edge relation enums ─────────────────────────────────

/**
 * Discriminator for the entity kind a {@link ProvenanceNode} represents.
 *
 * - `doc`       — a canonical document (ADR, spec, research note, …)
 * - `task`      — a CLEO task / epic / saga / subtask
 * - `decision`  — a BRAIN decision record
 * - `session`   — an agent session journal
 * - `memory`    — a BRAIN memory observation
 *
 * The string set is closed — extending it requires a new ADR and an additive
 * migration so that older consumers fail-closed on unknown variants rather
 * than silently dropping the node.
 *
 * @task T10166
 */
export type ProvenanceNodeKind = 'doc' | 'task' | 'decision' | 'session' | 'memory';

/**
 * Frozen const array backing {@link ProvenanceNodeKind} — used by the Zod
 * enum schema and by exhaustiveness checks in switch statements.
 *
 * @task T10166
 */
export const PROVENANCE_NODE_KINDS = [
  'doc',
  'task',
  'decision',
  'session',
  'memory',
] as const satisfies ReadonlyArray<ProvenanceNodeKind>;

/**
 * Semantic relationship between two provenance nodes.
 *
 * - `attached-to`     — child is attached to parent (doc attached to task, …)
 * - `supersedes`      — child supersedes parent (newer doc replaces older)
 * - `superseded-by`   — child is superseded by parent (reverse of `supersedes`)
 * - `related-task`    — child task is related (non-parent) to parent
 * - `linked-decision` — node references a BRAIN decision
 * - `derived-from`    — node was derived from a prior artifact
 *
 * @task T10166
 */
export type ProvenanceEdgeRelation =
  | 'attached-to'
  | 'supersedes'
  | 'superseded-by'
  | 'related-task'
  | 'linked-decision'
  | 'derived-from';

/**
 * Frozen const array backing {@link ProvenanceEdgeRelation} — used by the
 * Zod enum schema and by exhaustiveness checks.
 *
 * @task T10166
 */
export const PROVENANCE_EDGE_RELATIONS = [
  'attached-to',
  'supersedes',
  'superseded-by',
  'related-task',
  'linked-decision',
  'derived-from',
] as const satisfies ReadonlyArray<ProvenanceEdgeRelation>;

/**
 * Lifecycle status of a doc node — mirrors the canonical status union written
 * by `cleo docs publish` / `cleo docs supersede`.
 *
 * - `active`     — current canonical version
 * - `superseded` — replaced by a newer doc (still readable for history)
 * - `archived`   — moved out of the active corpus (no successor)
 * - `draft`      — in-progress, not yet published
 *
 * @task T10166
 */
export type DocLifecycleStatus = 'active' | 'superseded' | 'archived' | 'draft';

/**
 * Frozen const array backing {@link DocLifecycleStatus}.
 *
 * @task T10166
 */
export const DOC_LIFECYCLE_STATUSES = [
  'active',
  'superseded',
  'archived',
  'draft',
] as const satisfies ReadonlyArray<DocLifecycleStatus>;

// ─── Node variants ────────────────────────────────────────────────────────────

/**
 * Fields shared by every {@link ProvenanceNode} variant.
 *
 * `id` is the entity-scoped identifier (e.g. doc slug, task ID `T1234`,
 * decision ID, session ID, memory ID). `id` is unique within a single
 * {@link DocProvenanceResponse} but NOT globally across kinds — two nodes
 * with the same `id` but different `kind` are distinct entities.
 *
 * `metadata` is an opaque, caller-defined key/value bag. Renderers MUST
 * NOT assume any specific keys are present.
 */
interface ProvenanceNodeBase {
  /** Stable, entity-scoped identifier. */
  readonly id: string;
  /** Display title — short enough to render on a single line. */
  readonly title: string;
  /** Opaque key/value bag the renderer may surface verbatim. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Provenance node representing a canonical document (ADR, spec, research, …).
 *
 * `kind` is the user-facing document classification from
 * {@link DocKindMetadata.kind} (e.g. `adr`, `spec`, `research`).
 * `slug` is the canonical slug that addresses the doc through the docs SSoT.
 *
 * @task T10166
 *
 * @example
 * ```ts
 * const node: ProvenanceDocNode = {
 *   kind: 'doc',
 *   id: 'adr-078-docs-provenance-graph',
 *   slug: 'adr-078-docs-provenance-graph',
 *   docKind: 'adr',
 *   title: 'ADR 078 — Docs Provenance Graph',
 *   lifecycleStatus: 'active',
 *   publishedAt: '2026-05-22T18:00:00.000Z',
 * };
 * ```
 */
export interface ProvenanceDocNode extends ProvenanceNodeBase {
  readonly kind: 'doc';
  /** Canonical doc slug. */
  readonly slug: string;
  /** User-facing document classification (DocKind from docs-taxonomy). */
  readonly docKind: string;
  /** Lifecycle state of this doc. */
  readonly lifecycleStatus: DocLifecycleStatus;
  /** ISO-8601 timestamp this doc was first published. */
  readonly publishedAt: string;
  /** ISO-8601 timestamp this doc was superseded — set iff `lifecycleStatus === 'superseded'`. */
  readonly supersededAt?: string;
  /** Optional short summary surfaced by the renderer. */
  readonly summary?: string;
}

/**
 * Provenance node representing a CLEO task (saga / epic / task / subtask).
 *
 * `taskType` mirrors the canonical 4-tier hierarchy from ADR-073 so the
 * renderer can pick the correct icon (Σ / E / T / □) per tier.
 *
 * @task T10166
 *
 * @example
 * ```ts
 * const node: ProvenanceTaskNode = {
 *   kind: 'task',
 *   id: 'T10166',
 *   title: 'C9: Provenance graph contract',
 *   taskType: 'task',
 *   status: 'in_progress',
 * };
 * ```
 */
export interface ProvenanceTaskNode extends ProvenanceNodeBase {
  readonly kind: 'task';
  /** CLEO 4-tier task type. */
  readonly taskType: 'saga' | 'epic' | 'task' | 'subtask';
  /** Lifecycle status of the task. */
  readonly status: 'pending' | 'in_progress' | 'done' | 'blocked' | 'cancelled' | 'archived';
}

/**
 * Provenance node representing a BRAIN decision record.
 *
 * @task T10166
 *
 * @example
 * ```ts
 * const node: ProvenanceDecisionNode = {
 *   kind: 'decision',
 *   id: 'D-arch-001',
 *   title: 'Adopt evidence-based gate ritual',
 *   outcome: 'accepted',
 *   decidedAt: '2026-04-12T14:30:00.000Z',
 * };
 * ```
 */
export interface ProvenanceDecisionNode extends ProvenanceNodeBase {
  readonly kind: 'decision';
  /** Decision lifecycle outcome. */
  readonly outcome: 'proposed' | 'accepted' | 'rejected' | 'superseded';
  /** ISO-8601 timestamp the decision was last transitioned. */
  readonly decidedAt: string;
}

/**
 * Provenance node representing an agent session journal.
 *
 * @task T10166
 *
 * @example
 * ```ts
 * const node: ProvenanceSessionNode = {
 *   kind: 'session',
 *   id: 'ses_2026-05-22_abc123',
 *   title: 'Session 2026-05-22 — T10166 implementation',
 *   startedAt: '2026-05-22T18:00:00.000Z',
 * };
 * ```
 */
export interface ProvenanceSessionNode extends ProvenanceNodeBase {
  readonly kind: 'session';
  /** ISO-8601 timestamp the session started. */
  readonly startedAt: string;
  /** ISO-8601 timestamp the session ended — undefined while still active. */
  readonly endedAt?: string;
}

/**
 * Provenance node representing a BRAIN memory observation.
 *
 * @task T10166
 *
 * @example
 * ```ts
 * const node: ProvenanceMemoryNode = {
 *   kind: 'memory',
 *   id: 'O-2026-05-22-001',
 *   title: 'Observed: spawn worker contention under parallel sessions',
 *   memoryType: 'observation',
 *   recordedAt: '2026-05-22T19:15:00.000Z',
 * };
 * ```
 */
export interface ProvenanceMemoryNode extends ProvenanceNodeBase {
  readonly kind: 'memory';
  /** BRAIN memory classification. */
  readonly memoryType: 'observation' | 'pattern' | 'decision' | 'diary';
  /** ISO-8601 timestamp the memory was recorded. */
  readonly recordedAt: string;
}

/**
 * Discriminated union of every provenance node variant.
 *
 * Switch on `node.kind` for exhaustive narrowing — the `default` branch will
 * be statically reachable iff the discriminator set is extended without
 * updating consumers, which is the desired fail-loud behaviour.
 *
 * @task T10166
 */
export type ProvenanceNode =
  | ProvenanceDocNode
  | ProvenanceTaskNode
  | ProvenanceDecisionNode
  | ProvenanceSessionNode
  | ProvenanceMemoryNode;

// ─── Edges ────────────────────────────────────────────────────────────────────

/**
 * One semantic edge in the provenance graph.
 *
 * `from` and `to` are the `id` fields of two {@link ProvenanceNode} entries.
 * Because `id` is only unique within a `kind`, edges also reference the
 * source and target node kinds so the renderer can resolve them
 * unambiguously.
 *
 * @task T10166
 *
 * @example
 * ```ts
 * const edge: ProvenanceEdge = {
 *   relation: 'attached-to',
 *   from: 'adr-078-docs-provenance-graph',
 *   fromKind: 'doc',
 *   to: 'T10157',
 *   toKind: 'task',
 *   addedAt: '2026-05-22T18:00:00.000Z',
 * };
 * ```
 */
export interface ProvenanceEdge {
  /** Semantic relation between {@link from} and {@link to}. */
  readonly relation: ProvenanceEdgeRelation;
  /** Source node `id`. */
  readonly from: string;
  /** Source node `kind` — required to disambiguate `id` across kinds. */
  readonly fromKind: ProvenanceNodeKind;
  /** Target node `id`. */
  readonly to: string;
  /** Target node `kind` — required to disambiguate `id` across kinds. */
  readonly toKind: ProvenanceNodeKind;
  /** ISO-8601 timestamp this edge was first recorded. */
  readonly addedAt: string;
  /** Optional one-line caption surfaced by the renderer. */
  readonly summary?: string;
}

// ─── Top-level envelope ───────────────────────────────────────────────────────

/**
 * Top-level wire envelope returned by `cleo docs provenance`.
 *
 * Carries a flat list of nodes + edges so the renderer (or a downstream
 * consumer that wants to project the graph as a tree) can materialise the
 * desired layout without an additional round trip.
 *
 * @task T10166
 *
 * @example
 * ```ts
 * const response: DocProvenanceResponse = {
 *   nodes: [
 *     {
 *       kind: 'doc',
 *       id: 'adr-078-docs-provenance-graph',
 *       slug: 'adr-078-docs-provenance-graph',
 *       docKind: 'adr',
 *       title: 'ADR 078',
 *       lifecycleStatus: 'active',
 *       publishedAt: '2026-05-22T18:00:00.000Z',
 *     },
 *     { kind: 'task', id: 'T10157', title: 'Epic E12', taskType: 'epic', status: 'in_progress' },
 *   ],
 *   edges: [
 *     {
 *       relation: 'attached-to',
 *       from: 'adr-078-docs-provenance-graph',
 *       fromKind: 'doc',
 *       to: 'T10157',
 *       toKind: 'task',
 *       addedAt: '2026-05-22T18:00:00.000Z',
 *     },
 *   ],
 *   totalNodes: 2,
 *   totalEdges: 1,
 * };
 * ```
 */
export interface DocProvenanceResponse {
  /** Flat list of nodes. Order is renderer-defined — typically pre-order traversal of the doc subset. */
  readonly nodes: ReadonlyArray<ProvenanceNode>;
  /** Flat list of edges between the nodes. */
  readonly edges: ReadonlyArray<ProvenanceEdge>;
  /** Total node count — MUST equal `nodes.length`. */
  readonly totalNodes: number;
  /** Total edge count — MUST equal `edges.length`. */
  readonly totalEdges: number;
}

// ─── Type guards ──────────────────────────────────────────────────────────────

/**
 * Type guard — narrows a {@link ProvenanceNode} to {@link ProvenanceDocNode}.
 *
 * @task T10166
 *
 * @example
 * ```ts
 * for (const node of response.nodes) {
 *   if (isProvenanceDocNode(node)) {
 *     console.log(`doc: ${node.slug} (${node.lifecycleStatus})`);
 *   }
 * }
 * ```
 */
export function isProvenanceDocNode(node: ProvenanceNode): node is ProvenanceDocNode {
  return node.kind === 'doc';
}

/**
 * Type guard — narrows a {@link ProvenanceNode} to {@link ProvenanceTaskNode}.
 *
 * @task T10166
 */
export function isProvenanceTaskNode(node: ProvenanceNode): node is ProvenanceTaskNode {
  return node.kind === 'task';
}

/**
 * Type guard — narrows a {@link ProvenanceNode} to {@link ProvenanceDecisionNode}.
 *
 * @task T10166
 */
export function isProvenanceDecisionNode(node: ProvenanceNode): node is ProvenanceDecisionNode {
  return node.kind === 'decision';
}

/**
 * Type guard — narrows a {@link ProvenanceNode} to {@link ProvenanceSessionNode}.
 *
 * @task T10166
 */
export function isProvenanceSessionNode(node: ProvenanceNode): node is ProvenanceSessionNode {
  return node.kind === 'session';
}

/**
 * Type guard — narrows a {@link ProvenanceNode} to {@link ProvenanceMemoryNode}.
 *
 * @task T10166
 */
export function isProvenanceMemoryNode(node: ProvenanceNode): node is ProvenanceMemoryNode {
  return node.kind === 'memory';
}

/**
 * Runtime envelope guard for {@link DocProvenanceResponse}.
 *
 * Verifies the envelope shape without inspecting individual node payloads —
 * use the Zod schema for deep validation.
 *
 * @task T10166
 */
export function isDocProvenanceResponse(value: unknown): value is DocProvenanceResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    Array.isArray(v.nodes) &&
    Array.isArray(v.edges) &&
    typeof v.totalNodes === 'number' &&
    typeof v.totalEdges === 'number'
  );
}

// ─── Zod schemas ──────────────────────────────────────────────────────────────

/**
 * Zod enum schema for {@link ProvenanceNodeKind}.
 *
 * @task T10166
 */
export const provenanceNodeKindSchema = z.enum(PROVENANCE_NODE_KINDS);

/**
 * Zod enum schema for {@link ProvenanceEdgeRelation}.
 *
 * @task T10166
 */
export const provenanceEdgeRelationSchema = z.enum(PROVENANCE_EDGE_RELATIONS);

/**
 * Zod enum schema for {@link DocLifecycleStatus}.
 *
 * @task T10166
 */
export const docLifecycleStatusSchema = z.enum(DOC_LIFECYCLE_STATUSES);

const provenanceNodeBaseFields = {
  id: z.string().min(1),
  title: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
};

/**
 * Zod schema for {@link ProvenanceDocNode}.
 *
 * @task T10166
 */
export const provenanceDocNodeSchema = z.object({
  ...provenanceNodeBaseFields,
  kind: z.literal('doc'),
  slug: z.string().min(1),
  docKind: z.string().min(1),
  lifecycleStatus: docLifecycleStatusSchema,
  publishedAt: z.string().min(1),
  supersededAt: z.string().min(1).optional(),
  summary: z.string().optional(),
});

/**
 * Zod schema for {@link ProvenanceTaskNode}.
 *
 * @task T10166
 */
export const provenanceTaskNodeSchema = z.object({
  ...provenanceNodeBaseFields,
  kind: z.literal('task'),
  taskType: z.enum(['saga', 'epic', 'task', 'subtask']),
  status: z.enum(['pending', 'in_progress', 'done', 'blocked', 'cancelled', 'archived']),
});

/**
 * Zod schema for {@link ProvenanceDecisionNode}.
 *
 * @task T10166
 */
export const provenanceDecisionNodeSchema = z.object({
  ...provenanceNodeBaseFields,
  kind: z.literal('decision'),
  outcome: z.enum(['proposed', 'accepted', 'rejected', 'superseded']),
  decidedAt: z.string().min(1),
});

/**
 * Zod schema for {@link ProvenanceSessionNode}.
 *
 * @task T10166
 */
export const provenanceSessionNodeSchema = z.object({
  ...provenanceNodeBaseFields,
  kind: z.literal('session'),
  startedAt: z.string().min(1),
  endedAt: z.string().min(1).optional(),
});

/**
 * Zod schema for {@link ProvenanceMemoryNode}.
 *
 * @task T10166
 */
export const provenanceMemoryNodeSchema = z.object({
  ...provenanceNodeBaseFields,
  kind: z.literal('memory'),
  memoryType: z.enum(['observation', 'pattern', 'decision', 'diary']),
  recordedAt: z.string().min(1),
});

/**
 * Discriminated-union schema for {@link ProvenanceNode}.
 *
 * @task T10166
 */
export const provenanceNodeSchema = z.discriminatedUnion('kind', [
  provenanceDocNodeSchema,
  provenanceTaskNodeSchema,
  provenanceDecisionNodeSchema,
  provenanceSessionNodeSchema,
  provenanceMemoryNodeSchema,
]);

/**
 * Zod schema for {@link ProvenanceEdge}.
 *
 * @task T10166
 */
export const provenanceEdgeSchema = z.object({
  relation: provenanceEdgeRelationSchema,
  from: z.string().min(1),
  fromKind: provenanceNodeKindSchema,
  to: z.string().min(1),
  toKind: provenanceNodeKindSchema,
  addedAt: z.string().min(1),
  summary: z.string().optional(),
});

/**
 * Zod schema for {@link DocProvenanceResponse}.
 *
 * @task T10166
 */
export const docProvenanceResponseSchema = z.object({
  nodes: z.array(provenanceNodeSchema).readonly(),
  edges: z.array(provenanceEdgeSchema).readonly(),
  totalNodes: z.number().int().nonnegative(),
  totalEdges: z.number().int().nonnegative(),
});
