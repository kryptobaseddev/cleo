/**
 * CAAMP v0.3.0 API surface verification
 * This file verifies all CAAMP exports are accessible from the MCP server.
 * Run: npx tsx src/engine/caamp-verify.ts
 */
import {
  // Provider Registry
  getAllProviders,
  getProvider,
  resolveAlias,
  getProvidersByPriority,
  getProvidersByStatus,
  getProvidersByInstructFile,
  getInstructionFiles,
  getProviderCount,
  getRegistryVersion,
  // Detection
  detectProvider,
  detectAllProviders,
  getInstalledProviders,
  detectProjectProviders,
  // Source Parsing
  parseSource,
  isMarketplaceScoped,
  // Skills
  installSkill,
  removeSkill,
  listCanonicalSkills,
  parseSkillFile,
  discoverSkill,
  discoverSkills,
  validateSkill,
  // Skills Audit
  scanFile,
  scanDirectory,
  // MCP Installation
  installMcpServer,
  installMcpServerToAll,
  buildServerConfig,
  // MCP Reader
  resolveConfigPath,
  listMcpServers,
  listAllMcpServers,
  removeMcpServer,
  // MCP Lock
  readLockFile,
  recordMcpInstall,
  removeMcpFromLock,
  getTrackedMcpServers,
  // Skills Lock
  recordSkillInstall,
  removeSkillFromLock,
  getTrackedSkills,
  checkSkillUpdate,
  // Instructions
  inject,
  checkInjection,
  removeInjection,
  checkAllInjections,
  injectAll,
  generateInjectionContent,
  // Config Format I/O
  readConfig,
  writeConfig,
  removeConfig,
  // Marketplace
  MarketplaceClient,
  // Types
  type Provider,
  type McpServerConfig,
  type ConfigFormat,
  type TransportType,
  type SkillMetadata,
  type SkillEntry,
  type AuditResult,
  type DetectionResult,
  type InstallResult,
  type ValidationResult,
  type InjectionStatus,
} from '@cleocode/caamp';

// Quick verification
const providers = getAllProviders();
console.log(`CAAMP v${getRegistryVersion()} loaded: ${getProviderCount()} providers`);
console.log(`Provider IDs: ${providers.slice(0, 5).map((p: Provider) => p.id).join(', ')}...`);
console.log(`Instruction files: ${getInstructionFiles().join(', ')}`);
console.log('CAAMP API surface verification: PASS');
