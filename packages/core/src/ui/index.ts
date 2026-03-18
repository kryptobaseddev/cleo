/**
 * UI module - flags, changelog, command registry, aliases, injection, MCP config.
 *
 * @task T4454
 * @epic T4454
 */

export type { ShellType } from './aliases.js';
// Alias management
export {
  ALIASES_VERSION,
  checkAliasesStatus,
  detectAvailableShells,
  generateBashAliases,
  generatePowershellAliases,
  getCurrentShell,
  getInstalledVersion,
  getRcFilePath,
  hasAliasBlock,
  injectAliases,
  removeAliases,
} from './aliases.js';
export type { ChangelogSection } from './changelog.js';
// Changelog generation
export {
  appendToChangelog,
  discoverReleaseTasks,
  formatChangelogJson,
  generateChangelog,
  generateChangelogMarkdown,
  groupTasksIntoSections,
  writeChangelogFile,
} from './changelog.js';
export type { CommandMeta } from './command-registry.js';
// Command registry
export {
  getCommandScriptMap,
  getCommandsByCategory,
  getCommandsByRelevance,
  parseCommandHeader,
  scanAllCommands,
  validateHeader,
} from './command-registry.js';
export type { ParsedFlags } from './flags.js';
// CLI flags
export {
  defaultFlags,
  isJsonOutput,
  parseCommonFlags,
  resolveFormat,
} from './flags.js';

// Injection & MCP config: DELETED (T4674, T4675, T4677)
// All injection, provider detection, and MCP config management is now
// delegated to @cleocode/caamp via src/core/caamp/adapter.ts.
// See Wave 8 epic T4663 for migration context.
//
// Legacy exports removed:
//   injection.ts    -> CAAMP inject()/checkInjection()
//   mcp-config.ts   -> CAAMP detectAllProviders()/installMcpServer()
//   injection-registry.ts -> CAAMP getInstructionFiles()

// Injection legacy utilities (kept for validation output support)
export {
  getValidationKey,
  INJECTION_VALIDATION_KEYS,
} from './injection-legacy.js';
