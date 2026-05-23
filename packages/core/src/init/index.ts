/**
 * Init module — project initialization engine operations.
 *
 * Public surface for `packages/core/src/init/`:
 *   - EngineResult-wrapped operations for the CLI dispatch layer
 *
 * @module init
 * @task T1581 — ENG-MIG-14
 * @epic T1566
 */

export {
  ensureInitialized,
  getVersion,
  initProject,
  isAutoInitEnabled,
} from './engine-ops.js';

// T9531 — workflow scaffolder (`cleo init --workflows`).
export type {
  ResolvedToolPlaceholders,
  ScaffoldReleaseConfig,
  ScaffoldWorkflowOutcome,
  ScaffoldWorkflowsOptions,
  ScaffoldWorkflowsResult,
  WorkflowName,
} from './scaffold-workflows.js';
export {
  DEFAULT_WORKFLOW_TEMPLATES,
  getGitHookTemplatesDir,
  getWorkflowTemplatesDir,
  listAvailableWorkflowTemplates,
  scaffoldWorkflows,
} from './scaffold-workflows.js';
// T9536 — workflow upgrade (`cleo upgrade workflows`).
export type {
  UpgradeWorkflowOutcome,
  UpgradeWorkflowStatus,
  UpgradeWorkflowsOptions,
  UpgradeWorkflowsResult,
  WorkflowOverrides,
} from './upgrade-workflows.js';
export { parseOverridesYamlBody, upgradeWorkflows } from './upgrade-workflows.js';
