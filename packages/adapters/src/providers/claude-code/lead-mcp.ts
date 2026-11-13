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

import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  type Stats,
  statSync,
} from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { LeadMcpReport } from '@cleocode/contracts';
import {
  LEAD_MAILBOX_MCP_SERVER,
  LEAD_RUNNER_MCP_SERVER,
  LEAD_RUNNER_TOOL,
} from '@cleocode/contracts/operations/orchestrate.js';
import { claudeCodeTrustConfigSchema } from '@cleocode/contracts/provider-paths.js';
import { OrcaExecutionError } from '../../orca-execution.js';

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

/**
 * Claude Code 2.1.322's unsafe absolute paths on POSIX: UNC spellings, NUL,
 * and network or macOS volfs roots (`/net`, `/network`, `/.vol`, `/.file`,
 * `/.nofollow`, `/.resolve`).
 */
function unsafeGitPath(path: string): boolean {
  if (path.includes('\0') || /^[\\/]{2}/.test(path)) return true;
  const first = resolve(path).split('/')[1]?.toLowerCase() ?? '';
  return /^(?:net|network|\.vol|\.file|\.nofollow|\.resolve)$/.test(first);
}

/**
 * True when Claude would walk `path` safely: every component is absent, a file,
 * a directory or a symlink whose UTF-8 target is itself safe (followed at most
 * 40 times). A FIFO, socket or device, an unreadable component, or an unsafe
 * path anywhere along the way refuses.
 */
function walksSafely(path: string, hops = 40): boolean {
  if (hops <= 0 || unsafeGitPath(path)) return false;
  const parts = path.split('/');
  let at = '/';
  for (const [index, part] of parts.entries()) {
    if (part === '' || part === '.') continue;
    at = part === '..' ? dirname(at) : join(at, part);
    if (part === '..') continue;
    if (unsafeGitPath(at)) return false;
    let stat: Stats;
    try {
      stat = lstatSync(at);
    } catch (err) {
      if (err instanceof Error && 'code' in err && ['ENOENT', 'ENOTDIR'].includes(String(err.code)))
        continue;
      return false;
    }
    if (stat.isSymbolicLink()) {
      const raw = readlinkSync(at, { encoding: 'buffer' });
      const target = raw.toString('utf8');
      if (target.includes('\0') || !Buffer.from(target, 'utf8').equals(raw)) return false;
      const base = target.startsWith('/') ? target : `${dirname(at)}/${target}`;
      return walksSafely([base, ...parts.slice(index + 1)].join('/'), hops - 1);
    }
    if (!stat.isFile() && !stat.isDirectory()) return false;
  }
  return true;
}

/** True when `text`, relative to `base`, is a path Claude reads git metadata through. */
function safeGitPathText(text: string, base: string): boolean {
  const joined = text.startsWith('/') ? text : `${base}/${text}`;
  return !text.includes('\\') && walksSafely(joined) && walksSafely(resolve(base, text));
}

/** A regular git metadata file reached safely and not itself a symlink, trimmed, or `null`. */
function readGitMetaFile(gitDir: string, name: string): string | null {
  const file = join(gitDir, name);
  if (!walksSafely(file) || !lstatSync(file, { throwIfNoEntry: false })?.isFile()) return null;
  return readFileSync(file, 'utf8').trim();
}

/**
 * Claude's canonical root for a linked worktree (its `findCanonicalGitRoot`):
 * a worktrees entry of the common directory with a matching backlink. Like
 * Claude, the gitdir and commondir paths are resolved lexically, never
 * realpath-followed, so a commondir or gitdir spelled through a symlink must
 * still name the entry's own parent; only the backlink is compared by real
 * path. Unsafe paths and symlinked metadata files refuse.
 */
function linkedWorktreeTrustRoot(dir: string): string | null {
  const link = readFileSync(join(dir, '.git'), 'utf8').trim();
  if (!link.startsWith('gitdir:')) return null;
  const gitText = link.slice(7).trim();
  if (!safeGitPathText(gitText, dir)) return null;
  const gitDir = resolve(dir, gitText);
  const common = readGitMetaFile(gitDir, 'commondir');
  if (common === null || !safeGitPathText(common, gitDir)) return null;
  const commonDir = resolve(gitDir, common);
  if (dirname(gitDir) !== join(commonDir, 'worktrees')) return null;
  const back = readGitMetaFile(gitDir, 'gitdir');
  if (back === null || !safeGitPathText(back, gitDir) || unsafeGitPath(resolve(dir, back)))
    return null;
  if ([dir, gitDir, commonDir].some((path) => path.includes('\\'))) return null;
  if (realpathSync(resolve(gitDir, back)) !== join(realpathSync(dir), '.git')) return null;
  if (basename(commonDir) !== '.git' && existsSync(join(commonDir, '.git'))) return null;
  return (basename(commonDir) === '.git' ? dirname(commonDir) : commonDir).normalize('NFC');
}

/** Claude Code's truthy env parse: `1`, `true`, `yes` or `on`, any case, trimmed. */
function envTruthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());
}

/**
 * The user config file Claude Code 2.1.322 reads (its `getGlobalClaudeFile`):
 * `<configDir>/.config.json` when it is a non-empty file Claude sees under that
 * exact name, or an empty writable file with no usable legacy file beside it;
 * otherwise the legacy `.claude<suffix>.json`, whose suffix is `-custom-oauth`
 * under `CLAUDE_CODE_CUSTOM_OAUTH_URL`.
 */
function claudeUserConfigPath(projectDir: string, home: string, env: NodeJS.ProcessEnv): string {
  // Claude reads an empty CLAUDE_CONFIG_DIR as set for `.config.json` (relative
  // to its cwd, the project) but as unset for the legacy file (`??` vs `||`).
  const dirVar = env.CLAUDE_CONFIG_DIR;
  const configDir = dirVar !== undefined ? resolve(projectDir, dirVar) : join(home, '.claude');
  const migrated = join(configDir.normalize('NFC'), '.config.json');
  const suffix = env.CLAUDE_CODE_CUSTOM_OAUTH_URL ? '-custom-oauth' : '';
  const legacy = join(dirVar ? resolve(projectDir, dirVar) : home, `.claude${suffix}.json`);
  const enoent = (err: unknown): boolean =>
    err instanceof Error && 'code' in err && err.code === 'ENOENT';
  try {
    const stat = statSync(migrated);
    // 0o222: any write bit. An empty read-only file is never Claude's config.
    if (!stat.isFile() || (stat.size === 0 && (stat.mode & 0o222) === 0)) return legacy;
    let legacyStat: Stats | undefined;
    try {
      legacyStat = statSync(legacy);
    } catch (err) {
      if (enoent(err) || stat.size === 0) return migrated;
    }
    if (stat.size === 0) return legacy;
    if (legacyStat && (!legacyStat.isFile() || legacyStat.size === 0)) return migrated;
    try {
      // A case-insensitive volume matching `.CONFIG.json` is not the migrated file.
      if (!readdirSync(dirname(migrated)).includes(basename(migrated))) return legacy;
    } catch (err) {
      if (enoent(err)) return legacy;
    }
    return migrated;
  } catch {
    return legacy;
  }
}

/** Every variable {@link requireLeadProjectTrust} reads from the lead environment. */
export const LEAD_TRUST_ENV_KEYS = [
  'HOME',
  'USERPROFILE',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_CUSTOM_OAUTH_URL',
  'CLAUDE_CODE_SANDBOXED',
  'CLAUDE_CODE_IGNORE_PERSISTED_TRUST',
] as const;

/** The environment an Orca lead terminal receives, as {@link orcaLeadEnv} pins it. */
export interface OrcaLeadEnv {
  /** Exported in the terminal, and the environment its trust is judged from. */
  readonly env: Readonly<Record<string, string>>;
  /** Trust variables absent from `env`, unset in the terminal. */
  readonly unset: readonly string[];
}

/**
 * Pin the trust-relevant environment of an Orca lead terminal. The terminal
 * inherits Orca's environment, not CLEO's, so the spawn's own variables and
 * CLEO's HOME are exported and every other trust variable is unset: the
 * preflight and the lead's Claude then read the same values, and a variable
 * only CLEO or Orca holds cannot change either.
 *
 * @param spawnEnv - The spawn's own variables (`options.env`).
 * @param base - CLEO's environment, read for HOME only.
 * @returns The variables to export, also passed to the preflight, and those to unset.
 */
export function orcaLeadEnv(
  spawnEnv: Readonly<Record<string, string>>,
  base: NodeJS.ProcessEnv = process.env,
): OrcaLeadEnv {
  const env = { HOME: base.HOME || homedir(), ...spawnEnv };
  return { env, unset: LEAD_TRUST_ENV_KEYS.filter((key) => !(key in env)) };
}

/**
 * Require the owner's saved Claude Code folder trust before a lead can launch.
 * Returns the user config path so MCP selection uses the same account state.
 * Missing, malformed or unreadable state refuses; no trust record is written.
 *
 * @remarks
 * Claude Code 2.1.322 stores `projects[path].hasTrustDialogAccepted` in its
 * user config, including the canonical main checkout for linked worktrees.
 * Trust can descend within a repository, never from outside it.
 * A truthy `CLAUDE_CODE_SANDBOXED` makes Claude trust every folder, so it
 * admits too; `CLAUDE_CODE_IGNORE_PERSISTED_TRUST` still refuses.
 * See https://code.claude.com/docs/en/security#additional-safeguards.
 *
 * @param projectDir - The lead's working directory.
 * @param env - Exactly the environment the lead's Claude process receives.
 * @returns The verified Claude Code user config path.
 * @throws OrcaExecutionError when persisted trust cannot be verified.
 */
export function requireLeadProjectTrust(
  projectDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const home = resolve(projectDir, env.HOME || env.USERPROFILE || homedir());
  const configPath = claudeUserConfigPath(projectDir, home, env);
  let fixPrefix = '';
  try {
    const config = claudeCodeTrustConfigSchema.safeParse(readJson(configPath));
    let dir = realpathSync(projectDir);
    if (env.CLAUDE_CODE_IGNORE_PERSISTED_TRUST) {
      fixPrefix = 'Unset CLAUDE_CODE_IGNORE_PERSISTED_TRUST in the lead environment. ';
    } else if (envTruthy(env.CLAUDE_CODE_SANDBOXED)) {
      // Claude trusts every folder in a sandboxed session and shows no dialog.
      return configPath;
    } else if (dir === realpathSync(home)) {
      fixPrefix = 'Choose a project subdirectory: Claude Code never persists home-folder trust. ';
    } else if (config.success) {
      const trusted = (folder: string): boolean => {
        const key = (
          process.platform === 'win32' ? folder.replaceAll('\\', '/') : folder
        ).normalize('NFC');
        return config.data.projects?.[key]?.hasTrustDialogAccepted === true;
      };
      for (;;) {
        if (trusted(dir)) return configPath;
        const gitEntry = lstatSync(join(dir, '.git'), { throwIfNoEntry: false });
        if (gitEntry || dirname(dir) === dir) {
          const mainRoot = gitEntry?.isFile() ? linkedWorktreeTrustRoot(dir) : null;
          if (mainRoot && mainRoot !== realpathSync(home) && trusted(mainRoot)) return configPath;
          break;
        }
        dir = dirname(dir);
      }
    }
  } catch {
    // A failed path/config probe is not evidence that the owner trusted this folder.
  }
  throw new OrcaExecutionError(
    'E_LEAD_PROJECT_UNTRUSTED',
    `Cannot verify saved Claude Code folder trust for ${projectDir} in ${configPath}; the lead was not launched.`,
    `${fixPrefix}Open a terminal in ${JSON.stringify(projectDir)} with the same HOME and CLAUDE_CONFIG_DIR, run claude, accept the folder-trust dialog only if you trust this project, then /exit and retry cleo orchestrate lead. Restore readable valid user config first if needed.`,
  );
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
