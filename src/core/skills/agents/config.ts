/**
 * Agent configuration management.
 * Ports lib/skills/agent-config.sh.
 *
 * Reads agent definitions from AGENT.md files (YAML frontmatter)
 * and provides configuration accessors.
 *
 * @epic T4454
 * @task T4518
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { AgentConfig } from '../types.js';
import { parseFrontmatter } from '../discovery.js';
import { getProjectRoot } from '../../paths.js';

// ============================================================================
// Agent Config Resolution
// ============================================================================

/**
 * Get the agents directory path.
 * @task T4518
 */
export function getAgentsDir(cwd?: string): string {
  return join(getProjectRoot(cwd), 'agents');
}

/**
 * Parse an AGENT.md file into an AgentConfig.
 * AGENT.md uses the same YAML frontmatter format as SKILL.md.
 * @task T4518
 */
export function parseAgentConfig(agentDir: string): AgentConfig | null {
  const agentMdPath = join(agentDir, 'AGENT.md');

  if (!existsSync(agentMdPath)) {
    return null;
  }

  const content = readFileSync(agentMdPath, 'utf-8');
  const fm = parseFrontmatter(content);

  return {
    name: fm.name || basename(agentDir),
    description: fm.description || '',
    model: fm.model,
    allowedTools: fm.allowedTools,
    customInstructions: extractBody(content),
  };
}

/**
 * Load agent configuration by name.
 * Searches in the agents/ directory.
 * @task T4518
 */
export function loadAgentConfig(agentName: string, cwd?: string): AgentConfig | null {
  const agentsDir = getAgentsDir(cwd);
  const agentDir = join(agentsDir, agentName);

  return parseAgentConfig(agentDir);
}

/**
 * Get the cleo-subagent configuration (universal executor).
 * @task T4518
 */
export function getSubagentConfig(cwd?: string): AgentConfig | null {
  return loadAgentConfig('cleo-subagent', cwd);
}

/**
 * Check if an agent definition exists.
 * @task T4518
 */
export function agentExists(agentName: string, cwd?: string): boolean {
  const agentsDir = getAgentsDir(cwd);
  const agentMdPath = join(agentsDir, agentName, 'AGENT.md');
  return existsSync(agentMdPath);
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Extract the body content after frontmatter.
 */
function extractBody(content: string): string {
  const lines = content.split('\n');
  let inFrontmatter = false;
  let bodyStart = 0;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      if (!inFrontmatter) {
        inFrontmatter = true;
      } else {
        bodyStart = i + 1;
        break;
      }
    }
  }

  return lines.slice(bodyStart).join('\n').trim();
}
