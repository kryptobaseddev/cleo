/**
 * Agent installation functions.
 * Ports lib/skills/agents-install.sh.
 *
 * Installs agent configurations to the appropriate locations.
 *
 * @epic T4454
 * @task T4518
 */

import { existsSync, mkdirSync, symlinkSync, unlinkSync, readlinkSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { getAgentsDir } from './config.js';

// ============================================================================
// Agent Installation
// ============================================================================

/** Installation target directory. */
function getAgentInstallDir(): string {
  return join(homedir(), '.claude', 'agents');
}

/**
 * Install a single agent via symlink.
 * @task T4518
 */
export function installAgent(
  agentDir: string,
): { installed: boolean; path: string; error?: string } {
  const targetDir = getAgentInstallDir();
  const agentName = basename(agentDir);
  const targetPath = join(targetDir, agentName);

  // Ensure target directory exists
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  // Check source exists
  if (!existsSync(agentDir)) {
    return { installed: false, path: targetPath, error: `Source not found: ${agentDir}` };
  }

  // Handle existing entry
  if (existsSync(targetPath)) {
    try {
      const existing = readlinkSync(targetPath);
      if (existing === agentDir) {
        return { installed: true, path: targetPath }; // Already correct
      }
      // Different target, remove and re-link
      unlinkSync(targetPath);
    } catch {
      // Not a symlink, skip
      return { installed: false, path: targetPath, error: `Target exists and is not a symlink: ${targetPath}` };
    }
  }

  try {
    symlinkSync(agentDir, targetPath, 'dir');
    return { installed: true, path: targetPath };
  } catch (err) {
    return { installed: false, path: targetPath, error: `Symlink failed: ${err}` };
  }
}

/**
 * Install all agents from the project agents/ directory.
 * @task T4518
 */
export function installAllAgents(cwd?: string): Array<{ name: string; installed: boolean; error?: string }> {
  const agentsDir = getAgentsDir(cwd);
  const results: Array<{ name: string; installed: boolean; error?: string }> = [];

  if (!existsSync(agentsDir)) {
    return results;
  }

  const entries = readdirSync(agentsDir);

  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const agentDir = join(agentsDir, entry);

    const agentMdPath = join(agentDir, 'AGENT.md');
    if (!existsSync(agentMdPath)) continue;

    const result = installAgent(agentDir);
    results.push({
      name: entry,
      installed: result.installed,
      error: result.error,
    });
  }

  return results;
}

/**
 * Uninstall a single agent by removing its symlink.
 * @task T4518
 */
export function uninstallAgent(agentName: string): boolean {
  const targetDir = getAgentInstallDir();
  const targetPath = join(targetDir, agentName);

  if (!existsSync(targetPath)) {
    return false;
  }

  try {
    unlinkSync(targetPath);
    return true;
  } catch {
    return false;
  }
}
