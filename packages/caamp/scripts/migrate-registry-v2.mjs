#!/usr/bin/env node
/**
 * migrate-registry-v2.mjs
 *
 * Wave 1 of the CAAMP v3 migration: converts `providers/registry.json` from
 * the v1 schema (top-level MCP integration fields) to the v2 schema where:
 *
 *   1. Each provider's MCP fields (`configKey`, `configFormat`,
 *      `configPathGlobal`, `configPathProject`, `supportedTransports`,
 *      `supportsHeaders`) are moved into `capabilities.mcp`.
 *   2. The Pi entry is replaced with the canonical primary-harness shape
 *      containing `capabilities.harness` and Pi's native hook catalog.
 *   3. The top-level `version` is bumped to `"2.0.0"`.
 *
 * The script is idempotent: running it a second time on an already-migrated
 * file is a no-op (and logs so).
 *
 * Usage: `node packages/caamp/scripts/migrate-registry-v2.mjs`
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const registryPath = join(__dirname, '..', 'providers', 'registry.json');

const MCP_FIELDS = /** @type {const} */ ([
  'configKey',
  'configFormat',
  'configPathGlobal',
  'configPathProject',
  'supportedTransports',
  'supportsHeaders',
]);

const TARGET_VERSION = '2.0.0';

/**
 * Build the canonical Pi entry for a registry. The `spawnTargets` list is
 * computed dynamically as every other provider id in the registry, sorted
 * alphabetically, so the entry stays in sync as providers are added or
 * removed.
 *
 * @param {string[]} otherProviderIds
 * @returns {Record<string, unknown>}
 */
function buildPiEntry(otherProviderIds) {
  const sortedTargets = [...otherProviderIds].sort();
  return {
    id: 'pi',
    toolName: 'Pi Coding Agent',
    vendor: 'Mario Zechner',
    agentFlag: 'pi',
    aliases: ['pi-coding-agent', 'pi-mono'],
    pathGlobal: '$HOME/.pi/agent',
    pathProject: '.pi',
    instructFile: 'AGENTS.md',
    pathSkills: '$HOME/.pi/agent/skills',
    pathProjectSkills: '.pi/skills',
    detection: {
      methods: ['binary', 'directory'],
      binary: 'pi',
      directories: ['$HOME/.pi/agent'],
    },
    priority: 'primary',
    status: 'active',
    agentSkillsCompatible: true,
    capabilities: {
      harness: {
        kind: 'orchestrator',
        spawnTargets: sortedTargets,
        supportsConductorLoop: true,
        supportsStageGuidance: true,
        supportsCantBridge: true,
        extensionsPath: '$HOME/.pi/agent/extensions',
        globalExtensionsHub: '$CLEO_HOME/pi-extensions',
      },
      skills: {
        precedence: 'agents-canonical',
        agentsGlobalPath: '$HOME/.pi/agent/skills',
        agentsProjectPath: '.pi/skills',
      },
      hooks: {
        supported: [
          'session_start',
          'session_shutdown',
          'session_switch',
          'session_fork',
          'before_agent_start',
          'agent_start',
          'agent_end',
          'turn_start',
          'turn_end',
          'message_start',
          'message_update',
          'message_end',
          'context',
          'before_provider_request',
          'tool_call',
          'tool_result',
          'tool_execution_start',
          'tool_execution_end',
          'input',
          'user_bash',
          'model_select',
          'resources_discover',
        ],
        hookConfigPath: '$HOME/.pi/agent/extensions',
        hookConfigPathProject: '.pi/extensions',
        hookFormat: 'typescript-directory',
        nativeEventCatalog: 'pi',
        canInjectSystemPrompt: true,
        canBlockTools: true,
      },
      spawn: {
        supportsSubagents: true,
        supportsProgrammaticSpawn: true,
        supportsInterAgentComms: true,
        supportsParallelSpawn: true,
        spawnMechanism: 'native-child-process',
        spawnCommand: ['pi', '--mode', 'json', '-p', '--no-session'],
      },
    },
  };
}

/**
 * Extract the six MCP integration fields from a provider entry and move them
 * into `capabilities.mcp`. Returns the number of fields moved (0 when the
 * provider is already migrated).
 *
 * @param {Record<string, unknown>} provider
 * @returns {number}
 */
function migrateProviderMcpFields(provider) {
  const topLevelMcp = /** @type {Record<string, unknown>} */ ({});
  let moved = 0;
  for (const field of MCP_FIELDS) {
    if (field in provider) {
      topLevelMcp[field] = provider[field];
      delete provider[field];
      moved += 1;
    }
  }
  if (moved === 0) {
    return 0;
  }
  const capabilities = /** @type {Record<string, unknown>} */ (
    typeof provider.capabilities === 'object' && provider.capabilities !== null
      ? provider.capabilities
      : (provider.capabilities = {})
  );
  capabilities.mcp = {
    configKey: topLevelMcp.configKey,
    configFormat: topLevelMcp.configFormat,
    configPathGlobal: topLevelMcp.configPathGlobal,
    configPathProject: topLevelMcp.configPathProject,
    supportedTransports: topLevelMcp.supportedTransports,
    supportsHeaders: topLevelMcp.supportsHeaders,
  };
  return moved;
}

async function main() {
  const raw = await readFile(registryPath, 'utf-8');
  const registry = /** @type {Record<string, unknown>} */ (JSON.parse(raw));
  const providers = /** @type {Record<string, Record<string, unknown>>} */ (
    registry.providers && typeof registry.providers === 'object' ? registry.providers : {}
  );

  const providerIds = Object.keys(providers);
  const otherProviderIds = providerIds.filter((id) => id !== 'pi');

  let movedProviders = 0;
  let movedFields = 0;
  for (const id of otherProviderIds) {
    const entry = providers[id];
    const fieldsMoved = migrateProviderMcpFields(entry);
    if (fieldsMoved > 0) {
      movedProviders += 1;
      movedFields += fieldsMoved;
    }
  }

  // Always reset Pi to the canonical shape so re-running the script produces
  // a deterministic output and guarantees Pi matches the v2 specification.
  const previousPi = JSON.stringify(providers.pi ?? null);
  providers.pi = buildPiEntry(otherProviderIds);
  const piChanged = previousPi !== JSON.stringify(providers.pi);

  const previousVersion = registry.version;
  const versionChanged = previousVersion !== TARGET_VERSION;
  if (versionChanged) {
    registry.version = TARGET_VERSION;
  }

  const anyChange = movedProviders > 0 || piChanged || versionChanged;
  if (!anyChange) {
    console.log('[migrate-registry-v2] no changes needed (already v2.0.0)');
    return;
  }

  const serialized = `${JSON.stringify(registry, null, 2)}\n`;
  await writeFile(registryPath, serialized, 'utf-8');

  console.log(
    `[migrate-registry-v2] migrated ${movedProviders} providers (${movedFields} MCP fields moved); ` +
      `pi entry ${piChanged ? 'rewritten' : 'unchanged'}; ` +
      `version ${versionChanged ? `${String(previousVersion)} → ${TARGET_VERSION}` : `= ${TARGET_VERSION}`}`,
  );
}

main().catch((err) => {
  console.error('[migrate-registry-v2] failed:', err);
  process.exitCode = 1;
});
