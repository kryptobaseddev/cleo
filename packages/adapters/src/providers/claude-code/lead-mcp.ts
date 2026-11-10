/**
 * MCP isolation for a no-hands lead on Claude Code (T14423).
 *
 * The tool strip (T14357) removes Bash, Edit and Write, but any user MCP
 * server with shell or file tools would hand them back. A lead therefore
 * starts with `--strict-mcp-config` and a config naming exactly two servers:
 * the lead command runner (`cleo orchestrate lead-runner`) and, when the user
 * configured it, the AgentMBX server, so the lead can still read worker mail.
 *
 * The mbx entry is taken from the user's Claude Code config, with the same
 * precedence Claude Code applies: local (`~/.claude.json` `projects[<dir>]`),
 * then project (`<dir>/.mcp.json`), then user (`~/.claude.json`).
 *
 * @task T14423
 * @epic T14351
 */

import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { LeadMcpReport } from '@cleocode/contracts';
import {
  LEAD_MAILBOX_MCP_SERVER,
  LEAD_RUNNER_MCP_SERVER,
  LEAD_RUNNER_TOOL,
} from '@cleocode/contracts/operations/orchestrate.js';

/** One Claude Code MCP server entry, kept verbatim. */
export type McpServerEntry = Readonly<Record<string, unknown>>;

/** A lead's MCP setup: the `--mcp-config` value and the report of what loads. */
export interface LeadMcpSetup {
  /** Value for `--mcp-config`: a file path or an inline JSON string. */
  readonly config: string;
  /** What the lead loads. */
  readonly report: LeadMcpReport;
}

/** The runner's stdio server entry. */
const RUNNER_ENTRY: McpServerEntry = {
  type: 'stdio',
  command: 'cleo',
  args: ['orchestrate', 'lead-runner'],
};

/** `mcpServers` of a parsed config object, or an empty map. */
function serversOf(config: unknown): Readonly<Record<string, unknown>> {
  if (typeof config !== 'object' || config === null || !('mcpServers' in config)) return {};
  const servers = config.mcpServers;
  return typeof servers === 'object' && servers !== null ? { ...servers } : {};
}

/** The mbx entry of one `mcpServers` map: named `mbx`, else `agentmbx mcp`. */
function mbxEntryIn(servers: Readonly<Record<string, unknown>>): McpServerEntry | null {
  const named = servers[LEAD_MAILBOX_MCP_SERVER];
  if (typeof named === 'object' && named !== null) return { ...named };
  for (const entry of Object.values(servers)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const command = 'command' in entry ? entry.command : undefined;
    const args = 'args' in entry ? entry.args : undefined;
    if (
      typeof command === 'string' &&
      basename(command) === 'agentmbx' &&
      Array.isArray(args) &&
      args[0] === 'mcp'
    ) {
      return { ...entry };
    }
  }
  return null;
}

/** Parse a JSON file, or `null` when it is missing or unreadable. */
function readJson(file: string): unknown {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * The user's configured AgentMBX MCP server for a project, resolved as Claude
 * Code resolves MCP scopes: local, then project `.mcp.json`, then user.
 *
 * @param projectDir - Directory the lead runs in.
 * @param claudeJsonPath - Claude Code user config. @defaultValue `~/.claude.json`
 * @returns The entry verbatim (command, args, env), or `null` when none is configured.
 * @task T14423
 */
export function resolveMbxMcpServer(
  projectDir: string,
  claudeJsonPath: string = join(homedir(), '.claude.json'),
): McpServerEntry | null {
  const user = readJson(claudeJsonPath);
  const dir = resolve(projectDir);
  const projects =
    typeof user === 'object' && user !== null && 'projects' in user ? user.projects : undefined;
  const local =
    typeof projects === 'object' && projects !== null
      ? Object.entries(projects).find(([path]) => path === dir)?.[1]
      : undefined;
  return (
    mbxEntryIn(serversOf(local)) ??
    mbxEntryIn(serversOf(readJson(join(dir, '.mcp.json')))) ??
    mbxEntryIn(serversOf(user))
  );
}

/**
 * The lead's MCP config: the runner and, when given, the mbx server. Nothing else.
 *
 * @param mbx - The resolved mbx entry, or `null`.
 * @returns The `{ mcpServers }` object passed to `claude --mcp-config`.
 * @task T14423
 */
export function buildLeadMcpConfig(mbx: McpServerEntry | null): {
  mcpServers: Record<string, McpServerEntry>;
} {
  return {
    mcpServers: {
      [LEAD_RUNNER_MCP_SERVER]: RUNNER_ENTRY,
      ...(mbx ? { [LEAD_MAILBOX_MCP_SERVER]: mbx } : {}),
    },
  };
}

/**
 * Tools the lead may call without a prompt: the runner's one tool and, when
 * mbx is loaded, every mbx tool (`mcp__mbx`). It pre-approves; it strips nothing.
 *
 * @param report - What the lead loads.
 * @returns The `--allowedTools` list.
 * @task T14423
 */
export function leadAllowedTools(report: LeadMcpReport): string[] {
  return report.servers.map((server) =>
    server === LEAD_RUNNER_MCP_SERVER ? LEAD_RUNNER_TOOL : `mcp__${server}`,
  );
}

/**
 * Runner-only setup passed inline, used when no config file was written.
 *
 * @returns A {@link LeadMcpSetup} with the runner alone.
 * @task T14423
 */
export function runnerOnlyLeadMcp(): LeadMcpSetup {
  return {
    config: JSON.stringify(buildLeadMcpConfig(null)),
    report: { servers: [LEAD_RUNNER_MCP_SERVER], mailbox: 'not-configured' },
  };
}

/**
 * Write the lead's MCP config file (mode 0600: the mbx entry may carry env
 * secrets) into a spawn's private temp directory.
 *
 * @param dir - The spawn's private temp directory.
 * @param projectDir - Directory the lead runs in.
 * @param claudeJsonPath - Claude Code user config. @defaultValue `~/.claude.json`
 * @returns The file path and what the lead loads.
 * @task T14423
 */
export async function prepareLeadMcp(
  dir: string,
  projectDir: string,
  claudeJsonPath?: string,
): Promise<LeadMcpSetup> {
  const mbx = resolveMbxMcpServer(projectDir, claudeJsonPath);
  const file = join(dir, 'lead-mcp.json');
  await writeFile(file, JSON.stringify(buildLeadMcpConfig(mbx)), { mode: 0o600 });
  return {
    config: file,
    report: {
      servers: mbx ? [LEAD_RUNNER_MCP_SERVER, LEAD_MAILBOX_MCP_SERVER] : [LEAD_RUNNER_MCP_SERVER],
      mailbox: mbx ? 'loaded' : 'not-configured',
    },
  };
}
