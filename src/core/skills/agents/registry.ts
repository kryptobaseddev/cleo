/**
 * Agent registry management.
 * Ports lib/skills/agent-registry.sh.
 *
 * Maintains a registry of available agents and their configurations.
 * Persisted to ~/.cleo/agent-registry.json.
 *
 * @epic T4454
 * @task T4518
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { AgentConfig, AgentRegistry, AgentRegistryEntry } from '../types.js';
import { parseAgentConfig, getAgentsDir } from './config.js';
import { getCleoHome } from '../../paths.js';

// ============================================================================
// Registry Paths
// ============================================================================

/**
 * Get the agent registry file path.
 * @task T4518
 */
export function getRegistryPath(): string {
  return join(getCleoHome(), 'agent-registry.json');
}

// ============================================================================
// Registry CRUD
// ============================================================================

/**
 * Read the agent registry, creating if needed.
 * @task T4518
 */
export function readRegistry(): AgentRegistry {
  const registryPath = getRegistryPath();

  if (existsSync(registryPath)) {
    try {
      const content = readFileSync(registryPath, 'utf-8');
      return JSON.parse(content) as AgentRegistry;
    } catch {
      // Corrupt registry, return empty
    }
  }

  return {
    _meta: {
      version: '1.0.0',
      lastUpdated: new Date().toISOString(),
    },
    agents: [],
  };
}

/**
 * Save the agent registry.
 * @task T4518
 */
export function saveRegistry(registry: AgentRegistry): void {
  const registryPath = getRegistryPath();
  const dir = dirname(registryPath);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  registry._meta.lastUpdated = new Date().toISOString();
  writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf-8');
}

/**
 * Register an agent in the registry.
 * @task T4518
 */
export function registerAgent(
  name: string,
  path: string,
  config: AgentConfig,
): AgentRegistryEntry {
  const registry = readRegistry();

  // Remove existing entry if present
  registry.agents = registry.agents.filter(a => a.name !== name);

  const entry: AgentRegistryEntry = {
    name,
    path,
    config,
    installedAt: new Date().toISOString(),
  };

  registry.agents.push(entry);
  saveRegistry(registry);

  return entry;
}

/**
 * Unregister an agent from the registry.
 * @task T4518
 */
export function unregisterAgent(name: string): boolean {
  const registry = readRegistry();
  const initialCount = registry.agents.length;

  registry.agents = registry.agents.filter(a => a.name !== name);

  if (registry.agents.length < initialCount) {
    saveRegistry(registry);
    return true;
  }

  return false;
}

/**
 * Get an agent from the registry by name.
 * @task T4518
 */
export function getAgent(name: string): AgentRegistryEntry | null {
  const registry = readRegistry();
  return registry.agents.find(a => a.name === name) ?? null;
}

/**
 * List all registered agents.
 * @task T4518
 */
export function listAgents(): AgentRegistryEntry[] {
  return readRegistry().agents;
}

/**
 * Scan the agents/ directory and register all found agents.
 * @task T4518
 */
export function syncRegistry(cwd?: string): {
  added: string[];
  removed: string[];
  unchanged: string[];
} {
  const agentsDir = getAgentsDir(cwd);
  const registry = readRegistry();
  const result = { added: [] as string[], removed: [] as string[], unchanged: [] as string[] };

  if (!existsSync(agentsDir)) {
    return result;
  }

  // Discover agents on disk
  const diskAgents = new Map<string, AgentConfig>();
  const entries = readdirSync(agentsDir);

  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const agentDir = join(agentsDir, entry);
    try {
      const config = parseAgentConfig(agentDir);
      if (config) {
        diskAgents.set(entry, config);
      }
    } catch {
      // Skip invalid agents
    }
  }

  // Track existing names
  const existingNames = new Set(registry.agents.map(a => a.name));

  // Add new agents
  for (const [name, config] of diskAgents) {
    if (existingNames.has(name)) {
      result.unchanged.push(name);
    } else {
      registerAgent(name, join(agentsDir, name), config);
      result.added.push(name);
    }
  }

  // Remove agents no longer on disk
  const diskNames = new Set(diskAgents.keys());
  for (const existing of existingNames) {
    if (!diskNames.has(existing)) {
      unregisterAgent(existing);
      result.removed.push(existing);
    }
  }

  return result;
}
