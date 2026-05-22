/**
 * TaskTools barrel — pure-functional SDK tools for task graph operations.
 *
 * All tools are Category B SDK Tools (harness-agnostic, pure-functional, no I/O).
 * Input/output types are defined in `@cleocode/contracts` — never inline.
 *
 * Exposed tools:
 *   buildTaskTree        — flat array → hierarchical TaskTreeNode tree
 *   computeCriticalPath  — DAG longest-path via topological DP
 *   scoreTask            — priority score with per-factor breakdown
 *   renderTaskTreeText   — ASCII dep tree renderer
 *   renderTaskTreeMermaid — Mermaid graph TD renderer
 *   defineSdkTool        — schema-annotated tool registration factory
 *
 * @arch SDK Tools (Category B) — T10068 / Epic T9835 / Saga T9831
 * @task T10068
 */

export { buildTaskTree } from './build-task-tree.js';
export { computeCriticalPath } from './compute-critical-path.js';
export { describeSchema, describeSchemaRegistered } from './describe-schema.js';
export { renderTaskTreeMermaid, renderTaskTreeText } from './render-task-tree.js';
export { scoreTask } from './score-task-priority.js';
export type { JsonSchema, RegisteredSdkTool, SdkToolSpec } from './sdk-tool.js';
export { defineSdkTool } from './sdk-tool.js';
