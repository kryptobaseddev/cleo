/**
 * SDK Tool contract types.
 *
 * @arch Contracts barrel for Category B SDK Tools in packages/core/src/tools/
 * @task T10068
 * @task T10070
 * @epic T9835
 */

// === Agent-facing tool families (T1741 / T11456) ===
export type {
  ApplyPatchInput,
  ApplyPatchResult,
  GitCommitInput,
  GitCommitResult,
  GitDiffInput,
  GitDiffResult,
  GitLogEntry,
  GitLogInput,
  GitLogResult,
  GitStatusEntry,
  GitStatusInput,
  GitStatusResult,
  GitToolBase,
  ReadFilePagedInput,
  ReadFilePagedResult,
  RunShellInput,
  RunShellResult,
  SearchFilesInput,
  SearchFilesMatch,
  SearchFilesResult,
  ShellRunMode,
} from './agent-tools.js';
export type { FetchBrainEntriesInput, FetchBrainEntriesOutput } from './brain-fetch.js';
export type { ObserveBrainInput, ObserveBrainOutput } from './brain-observe.js';
// === BrainTools (T10070 / T9835c) ===
export type { SearchBrainInput, SearchBrainOutput } from './brain-search.js';
export type { TimelineBrainInput, TimelineBrainOutput } from './brain-timeline.js';
export type {
  BuildRetrievalBundleInput,
  BuildRetrievalBundleOutput,
} from './build-retrieval-bundle.js';

// === TaskTools (T10068 / T9835b) ===
export type {
  BuildTaskTreeInput,
  BuildTaskTreeOptions,
  BuildTaskTreeResult,
} from './build-task-tree.js';
export type {
  CriticalPathEdge,
  CriticalPathNode,
  CriticalPathResult,
} from './compute-critical-path.js';
export type {
  SchemaColumn,
  SchemaDescriptor,
  SchemaIndex,
  SchemaTableDescriptor,
} from './describe-schema.js';
export type { RenderTaskTreeInput } from './render-task-tree.js';
export type {
  ScoreFactor,
  ScoreTaskContext,
  ScoreTaskInput,
  ScoreTaskResult,
} from './score-task-priority.js';
// === Web + browser agent tools (T1742 / T11456) ===
export type {
  AccessibilityNode,
  BrowserActionResult,
  BrowserClickInput,
  BrowserNavigateInput,
  BrowserPageState,
  BrowserPressInput,
  BrowserScrollDirection,
  BrowserScrollInput,
  BrowserScrollResult,
  BrowserSnapshotResult,
  BrowserTypeInput,
  BrowserVisionInput,
  BrowserVisionResult,
  WebExtractInput,
  WebExtractResult,
  WebSearchBackendId,
  WebSearchHit,
  WebSearchInput,
  WebSearchResult,
} from './web-tools.js';
