import {
  getAgentsConfigPath,
  getAgentsHome,
  getAgentsMcpDir,
  getAgentsMcpServersPath,
  getCanonicalSkillsDir,
  getLockFilePath,
} from './standard.js';

/**
 * Global `.agents/` home directory (`~/.agents/` or `$AGENTS_HOME`).
 * @public
 */
export const AGENTS_HOME = getAgentsHome();

/**
 * CAAMP lock file path (`~/.agents/.caamp-lock.json`).
 * @public
 */
export const LOCK_FILE_PATH = getLockFilePath();

/**
 * Canonical skills directory (`~/.agents/skills/`).
 * @public
 */
export const CANONICAL_SKILLS_DIR = getCanonicalSkillsDir();

/**
 * Global MCP directory (`~/.agents/mcp/`).
 * @public
 */
export const AGENTS_MCP_DIR = getAgentsMcpDir();

/**
 * Global MCP servers.json path (`~/.agents/mcp/servers.json`).
 * @public
 */
export const AGENTS_MCP_SERVERS_PATH = getAgentsMcpServersPath();

/**
 * Global agents config.toml path (`~/.agents/config.toml`).
 * @public
 */
export const AGENTS_CONFIG_PATH = getAgentsConfigPath();
