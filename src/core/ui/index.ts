/**
 * UI module - flags, changelog, command registry, aliases, injection, MCP config.
 *
 * @task T4454
 * @epic T4454
 */

// CLI flags
export {
  parseCommonFlags,
  defaultFlags,
  resolveFormat,
  isJsonOutput,
} from './flags.js';
export type { ParsedFlags } from './flags.js';

// Changelog generation
export {
  discoverReleaseTasks,
  groupTasksIntoSections,
  generateChangelogMarkdown,
  formatChangelogJson,
  writeChangelogFile,
  appendToChangelog,
  generateChangelog,
} from './changelog.js';
export type { ChangelogSection } from './changelog.js';

// Command registry
export {
  parseCommandHeader,
  scanAllCommands,
  validateHeader,
  getCommandScriptMap,
  getCommandsByCategory,
  getCommandsByRelevance,
} from './command-registry.js';
export type { CommandMeta } from './command-registry.js';

// Alias management
export {
  getCurrentShell,
  getRcFilePath,
  detectAvailableShells,
  generateBashAliases,
  generatePowershellAliases,
  hasAliasBlock,
  getInstalledVersion,
  injectAliases,
  removeAliases,
  checkAliasesStatus,
  ALIASES_VERSION,
} from './aliases.js';
export type { ShellType } from './aliases.js';

// Injection engine
export {
  isValidTarget,
  hasInjectionBlock,
  getTemplatePath,
  getInjectionContent,
  injectionUpdate,
  injectionCheck,
  updateAllTargets,
  INJECTION_TARGETS,
} from './injection.js';
export type { InjectionTarget, InjectionResult } from './injection.js';

// MCP configuration
export {
  detectAllTools,
  generateMCPEntry,
  writeMCPConfig,
  getDetectionSummary,
  MCP_TOOL_KEYS,
} from './mcp-config.js';
export type { MCPToolKey, MCPToolInfo } from './mcp-config.js';

// Injection registry
export {
  INJECTION_TARGETS as INJECTION_REGISTRY_TARGETS,
  INJECTION_MARKER_START,
  INJECTION_MARKER_END,
  INJECTION_VERSION_PATTERN,
  INJECTION_TEMPLATE_MAIN,
  INJECTION_TEMPLATE_DIR,
  INJECTION_VALIDATION_KEYS,
  isInjectionTarget,
  getValidationKey,
  extractMarkerVersion,
} from './injection-registry.js';
export type { InjectionTarget as InjectionRegistryTarget } from './injection-registry.js';

// Version check
export {
  checkProjectNeedsUpdate,
  showVersionWarnings,
} from './version-check.js';
export type { VersionCheckResult } from './version-check.js';
