/**
 * Brain unified-graph runtime types — re-exported from `@cleocode/contracts`.
 *
 * The canonical definitions live in
 * `packages/contracts/src/brain-graph.ts`. This file re-exports them so
 * existing imports of `'../types.js'` within `@cleocode/brain` continue to
 * resolve without change, and external consumers that `import from
 * '@cleocode/brain'` also receive the same canonical shapes.
 *
 * @remarks
 * T989 unified the three duplicate copies of BrainNode/BrainEdge/BrainGraph:
 * - `packages/brain/src/types.ts` (this file — was the runtime definition)
 * - `packages/contracts/src/operations/brain.ts` (wire-format, now renamed)
 * - `packages/studio/src/routes/api/memory/graph/+server.ts` (raw-DB types, renamed)
 *
 * @task T989 — Unify BrainNode / BrainEdge types (single canonical shape)
 * @task T973 — LB* → Brain* rename
 * @task T969 — `@cleocode/brain` package extraction
 * @see packages/contracts/src/brain-graph.ts (canonical source)
 */

export type {
  BrainConnectionStatus,
  BrainEdge,
  BrainGraph,
  BrainNode,
  BrainNodeKind,
  BrainProjectContext,
  BrainQueryOptions,
  BrainStreamEvent,
  BrainSubstrate,
} from '@cleocode/contracts';
