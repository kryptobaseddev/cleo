/**
 * UI module - flags, changelog, command registry, aliases, injection.
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
// CLI flag parsing: DELETED — owned by @cleocode/lafs (resolveOutputFormat)
// plus per-harness adapters (cleo CLI middleware, caamp/src/core/lafs.ts).
// CORE is the SDK; programmatic consumers pass FlagResolution directly and
// don't parse argv. The dead duplicate at core/src/ui/flags.ts had no
// production callers — only its own test file imported it — and silently
// violated LAFS's E_FORMAT_CONFLICT invariant via last-flag-wins parsing.

// Injection config: DELETED (T4674, T4675, T4677)
// All injection and provider detection is now
// delegated to @cleocode/caamp via src/core/caamp/adapter.ts.
// See Wave 8 epic T4663 for migration context.
//
// Legacy exports removed:
//   injection.ts    -> CAAMP inject()/checkInjection()
//   (removed)       -> CAAMP detectAllProviders()
//   injection-registry.ts -> CAAMP getInstructionFiles()
