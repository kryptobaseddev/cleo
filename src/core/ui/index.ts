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

// Injection & MCP config: DELETED (T4674, T4675, T4677)
// All injection, provider detection, and MCP config management is now
// delegated to @cleocode/caamp via src/mcp/engine/caamp-adapter.ts.
// See Wave 8 epic T4663 for migration context.
//
// Legacy exports removed:
//   injection.ts    -> CAAMP inject()/checkInjection()
//   mcp-config.ts   -> CAAMP detectAllProviders()/installMcpServer()
//   injection-registry.ts -> CAAMP getInstructionFiles()

// Injection legacy utilities (kept for validation/migration support)
export {
  getValidationKey,
  extractMarkerVersion,
  INJECTION_VALIDATION_KEYS,
} from './injection-legacy.js';

// Version check
export {
  checkProjectNeedsUpdate,
  showVersionWarnings,
} from './version-check.js';
export type { VersionCheckResult } from './version-check.js';
