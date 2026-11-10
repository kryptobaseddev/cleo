/**
 * MCP isolation for a no-hands lead on Claude Code (T14423).
 *
 * The tool strip (T14357) removes Bash, Edit and Write, but any user MCP
 * server with shell or file tools would hand them back. A lead therefore
 * starts with `--strict-mcp-config` and a config naming at most two servers:
 * the lead command runner (`cleo orchestrate lead-runner`) and the user's
 * AgentMBX server, so the lead can still read worker mail.
 *
 * The mbx entry comes ONLY from the user-level `mcpServers` of
 * `~/.claude.json`, never from the repository (`.mcp.json`) or its project
 * entry: `--mcp-config` skips Claude Code's project-server approval and
 * `--allowedTools mcp__mbx` pre-approves every tool on the server, so a
 * repository could otherwise plant any command as `mbx`. The entry must also
 * run the `agentmbx` binary from an absolute path outside the project, with
 * arguments starting `mcp`; anything else is refused with a warning.
 *
 * @task T14423
 * @epic T14351
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
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

/** Outcome of {@link resolveMbxMcpServer}. */
export type MbxResolution =
  | { readonly kind: 'found'; readonly entry: McpServerEntry }
  | { readonly kind: 'not-configured' }
  | { readonly kind: 'refused'; readonly reason: string };

/**
 * CLEO identity variables the runner passes to every command, so a verb run
 * through it (`review verdict`, `merge train`) acts as the lead.
 */
const RUNNER_IDENTITY_ENV = ['CLEO_SESSION_ID', 'CLEO_AGENT_ID', 'CLEO_AGENT_ROLE'] as const;

/** The runner's stdio server entry, carrying the lead's CLEO identity. */
function runnerEntry(
  identityEnv: Readonly<Record<string, string>>,
  cleoBin: string,
): McpServerEntry {
  const env: Record<string, string> = {};
  for (const key of RUNNER_IDENTITY_ENV) {
    const value = identityEnv[key];
    if (value) env[key] = value;
  }
  return {
    type: 'stdio',
    command: cleoBin,
    args: ['orchestrate', 'lead-runner'],
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
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

/** `realpath`, or the resolved path when it cannot be resolved. */
function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** True when `path` is `dir` or inside it, after resolving symlinks. */
function isInside(path: string, dir: string): boolean {
  const rel = relative(realOrResolved(dir), path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Why an mbx entry is unsafe to hand a lead, or `null` when it is safe: it
 * must run the `agentmbx` binary from an absolute path outside the project,
 * with arguments starting `mcp`, over stdio.
 */
function mbxEntryProblem(
  entry: Readonly<Record<string, unknown>>,
  projectDir: string,
): string | null {
  const command = entry['command'];
  const args = entry['args'];
  const type = entry['type'];
  if (type !== undefined && type !== 'stdio') return `transport '${String(type)}' is not stdio`;
  if (typeof command !== 'string' || !isAbsolute(command)) {
    return 'its command is not an absolute path';
  }
  if (!existsSync(command)) return `its command '${command}' does not exist`;
  // Symlinks resolved: a link outside the project pointing inside it, or named
  // agentmbx but pointing at a shell, is refused.
  const real = realpathSync(command);
  if (basename(command) !== 'agentmbx' || basename(real) !== 'agentmbx') {
    return `its command '${command}' is not the agentmbx binary`;
  }
  if (isInside(real, projectDir)) return `its command '${command}' lives inside the project`;
  if (!Array.isArray(args) || args[0] !== 'mcp') return "its arguments do not start with 'mcp'";
  return null;
}

/**
 * The user's AgentMBX MCP server, from the user-level `mcpServers` of
 * `~/.claude.json` only (named `mbx`). Project and local scopes are never
 * read: a repository must not be able to plant the lead's mailbox server.
 *
 * @param projectDir - Directory the lead runs in (an mbx binary inside it is refused).
 * @param claudeJsonPath - Claude Code user config. @defaultValue `~/.claude.json`
 * @returns The entry verbatim, `not-configured`, or `refused` with the reason.
 * @task T14423
 */
export function resolveMbxMcpServer(
  projectDir: string,
  claudeJsonPath: string = join(homedir(), '.claude.json'),
): MbxResolution {
  const user = readJson(claudeJsonPath);
  const servers =
    typeof user === 'object' && user !== null && 'mcpServers' in user ? user.mcpServers : undefined;
  const entry =
    typeof servers === 'object' && servers !== null && LEAD_MAILBOX_MCP_SERVER in servers
      ? Object.entries(servers).find(([name]) => name === LEAD_MAILBOX_MCP_SERVER)?.[1]
      : undefined;
  if (entry === undefined) return { kind: 'not-configured' };
  if (typeof entry !== 'object' || entry === null) {
    return { kind: 'refused', reason: 'the user-level mbx entry is not an object' };
  }
  const problem = mbxEntryProblem({ ...entry }, projectDir);
  return problem === null
    ? { kind: 'found', entry: { ...entry } }
    : { kind: 'refused', reason: `the user-level mbx entry was refused: ${problem}` };
}

/**
 * The lead's MCP config: the runner and, when given, the mbx server. Nothing else.
 *
 * @param mbx - The validated mbx entry, or `null`.
 * @param identityEnv - The lead's CLEO identity variables, passed to the runner.
 * @param cleoBin - The `cleo` binary (absolute when resolved at spawn time).
 * @returns The `{ mcpServers }` object passed to `claude --mcp-config`.
 * @task T14423
 */
export function buildLeadMcpConfig(
  mbx: McpServerEntry | null,
  identityEnv: Readonly<Record<string, string>> = {},
  cleoBin = 'cleo',
): { mcpServers: Record<string, McpServerEntry> } {
  return {
    mcpServers: {
      [LEAD_RUNNER_MCP_SERVER]: runnerEntry(identityEnv, cleoBin),
      ...(mbx ? { [LEAD_MAILBOX_MCP_SERVER]: mbx } : {}),
    },
  };
}

/**
 * Tools the lead may call: the runner's one tool and, when mbx is loaded,
 * every mbx tool (`mcp__mbx`).
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

/** File name of the lead's MCP config inside the spawn's private temp directory. */
export const LEAD_MCP_FILE = 'lead-mcp.json';

/**
 * Write the lead's MCP config file (mode 0600: the mbx entry may carry env
 * secrets) into a spawn's private temp directory. The lead's `SessionStart`
 * hook deletes it once Claude Code has loaded it (see `leadSessionSettings`).
 *
 * @param dir - The spawn's private temp directory.
 * @param projectDir - Directory the lead runs in.
 * @param opts - The lead's CLEO identity env, the Claude Code user config path
 *   (default `~/.claude.json`) and the absolute `cleo` binary (default `cleo`).
 * @returns The file path and what the lead loads.
 * @task T14423
 */
export async function prepareLeadMcp(
  dir: string,
  projectDir: string,
  opts: {
    readonly identityEnv?: Readonly<Record<string, string>>;
    readonly claudeJsonPath?: string;
    readonly cleoBin?: string;
  } = {},
): Promise<LeadMcpSetup> {
  const mbx = resolveMbxMcpServer(projectDir, opts.claudeJsonPath);
  const entry = mbx.kind === 'found' ? mbx.entry : null;
  const file = join(dir, LEAD_MCP_FILE);
  const config = buildLeadMcpConfig(entry, opts.identityEnv ?? {}, opts.cleoBin ?? 'cleo');
  await writeFile(file, JSON.stringify(config), { mode: 0o600 });
  return {
    config: file,
    report: {
      servers: entry ? [LEAD_RUNNER_MCP_SERVER, LEAD_MAILBOX_MCP_SERVER] : [LEAD_RUNNER_MCP_SERVER],
      mailbox: mbx.kind === 'found' ? 'loaded' : mbx.kind,
      ...(mbx.kind === 'refused' ? { warning: mbx.reason } : {}),
    },
  };
}
