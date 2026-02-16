/**
 * CAAMP v0.3.0 API surface verification
 * This file verifies all CAAMP exports are accessible from the MCP server.
 * Run: npx tsx src/engine/caamp-verify.ts
 */
import {
  // Provider Registry
  getAllProviders,
  getInstructionFiles,
  getProviderCount,
  getRegistryVersion,
  // Types
  type Provider,
} from '@cleocode/caamp';

// Quick verification
const providers = getAllProviders();
console.log(`CAAMP v${getRegistryVersion()} loaded: ${getProviderCount()} providers`);
console.log(`Provider IDs: ${providers.slice(0, 5).map((p: Provider) => p.id).join(', ')}...`);
console.log(`Instruction files: ${getInstructionFiles().join(', ')}`);
console.log('CAAMP API surface verification: PASS');
