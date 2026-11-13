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
import { basename, dirname, isAbsolute, join, relative, resolve, win32 } from 'node:path';
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
 * The host facts Claude Code 2.1.322's unsafe-path rule reads. Its macOS
 * build also refuses automounted `/network/...` paths and, when `/home` is an
 * automount, another user's `/home/<user>`.
 */
export interface ClaudePathHost {
  /** Claude's macOS automount rules apply (the darwin build). */
  readonly darwin: boolean;
  /** `/home` is an automount: `/etc/auto_master` maps it, or it is its own mount. */
  readonly homeAutomount: boolean;
  /** The user's home directory (`os.homedir()`). */
  readonly home: string;
}

let homeAutomountMemo: boolean | undefined;

/** True for a missing-path error (`ENOENT`). */
function isEnoent(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT';
}

/** Claude's `/home` automount probe; any unexpected failure counts as automounted. */
function homeIsAutomount(): boolean {
  try {
    let mapped = false;
    try {
      mapped = readFileSync('/etc/auto_master', 'utf8')
        .split('\n')
        .some((line) => {
          const fields = line.replace(/#.*$/, '').trim().split(/\s+/);
          return fields.length >= 2 && fields[0]?.toLowerCase() === '/home';
        });
    } catch (err) {
      if (!isEnoent(err)) throw err;
    }
    if (mapped) return true;
    try {
      return statSync('/home').dev !== statSync('/Users').dev;
    } catch (err) {
      if (isEnoent(err)) return true;
      throw err;
    }
  } catch {
    return true;
  }
}

/** This machine's {@link ClaudePathHost}; the `/home` probe runs once per process, as in Claude. */
function claudePathHost(): ClaudePathHost {
  const darwin = process.platform === 'darwin';
  if (darwin) homeAutomountMemo ??= homeIsAutomount();
  return { darwin, homeAutomount: homeAutomountMemo ?? false, home: homedir() };
}

const lowerAscii = (text: string): string => text.replace(/[A-Z]/g, (c) => c.toLowerCase());
const foldCase = (text: string): string => text.toUpperCase().toLowerCase();
const foldVisible = (text: string): string => foldCase(text.replace(/[‌-‏‪-‮⁪-⁯﻿]/g, ''));

/**
 * Claude's lexical walk of an absolute path (`.` skipped, `..` pops), calling
 * `visit` after each pushed component; returns the parts left at the end, or
 * `null` for a relative path.
 */
function walkParts(path: string, visit?: (parts: readonly string[]) => void): string[] | null {
  if (!path.startsWith('/')) return null;
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
    visit?.(parts);
  }
  return parts;
}

/** `/net/<host>` or `/Network/Servers/<host>` (Claude's `v`). */
function isNetMount(parts: readonly string[]): boolean {
  const [first = '', second = ''] = parts;
  return (
    (parts.length === 2 && foldVisible(first) === 'net') ||
    (parts.length === 3 && foldVisible(first) === 'network' && foldVisible(second) === 'servers')
  );
}

/** The network host a path is mounted from, lowercased, or `null` (Claude's `nK`). */
function netHost(path: string): string | null {
  let host: string | null = null;
  walkParts(path, (parts) => {
    if (host === null && isNetMount(parts)) host = lowerAscii(parts.at(-1) ?? '');
  });
  return host;
}

/** First component equals `name` under `test` (Claude's `k$` and `sb` walks). */
function firstPartIs(path: string, test: (part: string) => boolean): boolean {
  let first: string | undefined;
  walkParts(path, (parts) => {
    if (parts.length === 1 && first === undefined && test(parts[0] ?? '')) first = parts[0];
  });
  return first !== undefined;
}

const underNetwork = (path: string): boolean =>
  firstPartIs(path, (part) => part.toLowerCase() === 'network');
const underVolfs = (path: string): boolean =>
  /\/\.(?:vol|file|nofollow|resolve)(?:\/|$)/i.test(path) &&
  firstPartIs(path, (part) => /^\.(?:vol|file|nofollow|resolve)$/i.test(part));
const isNetRoot = (path: string): boolean => {
  const parts = walkParts(path);
  return parts?.length === 1 && parts[0]?.toLowerCase() === 'net';
};

/** macOS `/System/Volumes/Data/<firmlinked>` spelled as its firmlink (Claude's `u0`). */
function dataVolumeAlias(path: string): string {
  const parts = path.split('/');
  const [root, system = '', volumes = '', data = ''] = parts;
  if (
    parts.length < 5 ||
    root !== '' ||
    foldCase(system) !== 'system' ||
    foldCase(volumes) !== 'volumes' ||
    foldCase(data) !== 'data'
  )
    return path;
  const rest = parts.slice(4);
  for (const link of FIRMLINKS) {
    const linkParts = link.split('/');
    if (
      rest.length >= linkParts.length &&
      linkParts.every((part, i) => foldCase(rest[i] ?? '') === foldCase(part))
    )
      return `/${rest.join('/')}`;
  }
  return path;
}

const FIRMLINKS = [
  'usr/local',
  'usr/libexec/cups',
  'usr/share/snmp',
  'AppleInternal',
  'Applications',
  'Library',
  'Users',
  'Volumes',
  'cores',
  'home',
  'media',
  'mnt',
  'opt',
  'pkg',
  'private',
  'sw',
] as const;

/** Automount prefixes a path reaches, up to six components deep (Claude's `Q`). */
function automountPrefixes(
  path: string,
  host: ClaudePathHost,
): { complete: string[]; partial: string[] } {
  const complete: string[] = [];
  const partial: string[] = [];
  walkParts(path, (parts) => {
    if (parts.length > 6) return;
    const spelled = `/${parts.join('/')}`;
    const at = (host.darwin ? dataVolumeAlias(spelled) : spelled).split('/').filter(Boolean);
    const [first = '', second = '', third = ''] = at;
    if (first.toLowerCase() === 'network') {
      if (at.length === 1) partial.push('/network/');
      else if (at.length === 2) partial.push(`/network/${lowerAscii(second)}/`);
      else if (at.length === 3)
        complete.push(`/network/${lowerAscii(second)}/${lowerAscii(third)}`);
    } else if (host.homeAutomount && first.toLowerCase() === 'home' && at.length === 2) {
      complete.push(`/home/${second}`);
    }
  });
  return { complete, partial };
}

/** True when `path` reaches a macOS automount (Claude's `Y1`). */
function reachesAutomount(path: string, host: ClaudePathHost): boolean {
  if (!host.darwin) return false;
  if (underNetwork(path) || underVolfs(path)) return true;
  if (!path.startsWith('/')) return false;
  const { complete, partial } = automountPrefixes(path, host);
  if (partial.length > 0 || complete.some((prefix) => prefix.startsWith('/network/'))) return true;
  const homes = complete.filter((prefix) => prefix.startsWith('/home/'));
  if (homes.length === 0) return false;
  const own = /^\/home\/([^/]+)/.exec(dataVolumeAlias(host.home));
  const ownHome = own ? `/home/${own[1]}` : null;
  return homes.some((prefix) => prefix !== ownHome);
}

/** True when `path` reaches an automount other than `base`'s own (Claude's `NNo`). */
function leavesAutomount(path: string, base: string, host: ClaudePathHost): boolean {
  if (!reachesAutomount(path, host)) return false;
  const own = automountPrefixes(base, host).complete[0] ?? null;
  const { complete, partial } = automountPrefixes(path, host);
  if ((complete.length === 0 && partial.length === 0) || own === null) return true;
  return (
    complete.some((prefix) => prefix !== own) || partial.some((prefix) => !own.startsWith(prefix))
  );
}

const DOS_DEVICE = /^[\\/]\?\?[\\/]/;
const isDosDevice = (path: string): boolean =>
  DOS_DEVICE.test(path) || (path.includes('??') && DOS_DEVICE.test(win32.normalize(path)));
const isUncLike = (path: string): boolean => /^[\\/]{2}/.test(path) || isDosDevice(path);

/** The UNC server of a path, lowercased, or `null` (Claude's `KP`). */
function uncServer(path: string): string | null {
  if (/^[\\/]{2}[?.][\\/](?!unc[\\/])/i.test(path)) return null;
  const server = /^[\\/]{2}(?:[?.][\\/]unc[\\/])?([^\\/]+)/i.exec(path)?.[1];
  return server === undefined ? null : lowerAscii(server);
}

/** A UNC spelling on another server, a device path or a dotted UNC segment (Claude's `RQ`). */
function uncEscape(path: string, base: string): boolean {
  if (!isUncLike(path)) return false;
  if (/^[\\/]{2}[?.][\\/]/.test(path) || isDosDevice(path)) return true;
  if (/(^|[\\/])\.{1,2}[. ]*([\\/]|$)/.test(path)) return true;
  const server = uncServer(path);
  return server === null || server !== uncServer(base);
}

/**
 * Claude Code 2.1.322's unsafe-path predicate (`ua` in its bundle): `text`,
 * as written and resolved against `base`, must not name another UNC server,
 * a device path, another `/net` host, `/net` itself, `/network`, a macOS volfs
 * root or another automount. Claude applies it to the gitdir, commondir and
 * backlink text and to every symlink target its walks follow.
 *
 * @param text - The path as written (a gitdir line or a raw symlink target).
 * @param base - The directory `text` is relative to.
 * @param host - The host facts the macOS rules read.
 * @returns True when Claude would refuse the path.
 * @internal
 */
export function claudeUnsafePath(
  text: string,
  base: string,
  host: ClaudePathHost = claudePathHost(),
): boolean {
  const resolved = resolve(base, text);
  if (uncEscape(text, base) || uncEscape(resolved, base)) return true;
  const baseHost = netHost(base);
  for (const path of [text, resolved]) {
    const pathHost = netHost(path);
    if (pathHost !== null && pathHost !== baseHost) return true;
    if (underNetwork(path) || isNetRoot(path) || underVolfs(path)) return true;
    if (leavesAutomount(path, base, host)) return true;
  }
  return false;
}

/** A walked component that leaves its anchor's mount (Claude's `E$`). */
function componentEscapes(path: string, anchor: string, host: ClaudePathHost): boolean {
  if (underVolfs(path)) return true;
  const pathHost = netHost(path);
  if (pathHost !== null && pathHost !== netHost(anchor)) return true;
  return leavesAutomount(path, anchor, host);
}

type PathKind = 'absent' | 'file' | 'dir' | 'symlink' | 'special' | 'other';

/** `lstat` kind of a path (Claude's `Pt`). */
function pathKind(path: string): PathKind {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return 'symlink';
    return stat.isFile() ? 'file' : stat.isDirectory() ? 'dir' : 'special';
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? err.code : undefined;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'other';
  }
}

/** A symlink's target text when it is valid UTF-8 without NUL, else `null`. */
function linkText(path: string): string | null {
  try {
    const raw = readlinkSync(path, { encoding: 'buffer' });
    const text = raw.toString('utf8');
    return text.includes('\0') || !Buffer.from(text, 'utf8').equals(raw) ? null : text;
  } catch {
    return null;
  }
}

/**
 * Claude's component walk (`Ge`): every component stays on `anchor`'s mount,
 * is absent, a file, a directory or a symlink whose raw target passes
 * {@link claudeUnsafePath}; links are followed at most 40 times.
 */
function walksSafely(path: string, anchor: string, host: ClaudePathHost, hops = 40): boolean {
  if (hops <= 0) return false;
  const rooted = path.startsWith('/');
  const parts = path.slice(rooted ? 1 : 0).split(/\/+/);
  let at = rooted ? '/' : '';
  for (const [index, part] of parts.entries()) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      at = dirname(at);
      continue;
    }
    at = join(at, part);
    if (componentEscapes(at, anchor, host) || underNetwork(at)) return false;
    const kind = pathKind(at);
    if (kind === 'other' || kind === 'special') return false;
    if (kind === 'symlink') {
      const target = linkText(at);
      if (target === null || claudeUnsafePath(target, dirname(at), host)) return false;
      const base = target.startsWith('/') ? target : `${dirname(at)}/${target}`;
      const rest = parts.slice(index + 1).join('/');
      const next = rest ? (base.endsWith('/') ? base + rest : `${base}/${rest}`) : base;
      return walksSafely(next, anchor, host, hops - 1);
    }
  }
  return true;
}

/** Claude's `ye`: `text` relative to `base` walks safely, as written and resolved. */
function textWalksSafely(text: string, base: string, host: ClaudePathHost, anchor = base): boolean {
  const written = text.startsWith('/') ? text : `${base}/${text}`;
  const resolved = resolve(base, text);
  return (
    walksSafely(written, anchor, host) &&
    (resolved === written || walksSafely(resolved, anchor, host))
  );
}

/** A git metadata file Claude reads (`K6` passed: safe walk, not a symlink), trimmed. */
function readGitMetaFile(gitDir: string, name: string, host: ClaudePathHost): string | null {
  const file = join(gitDir, name);
  if (!walksSafely(file, gitDir, host) || ['symlink', 'special', 'other'].includes(pathKind(file)))
    return null;
  return readFileSync(file, 'utf8').trim();
}

/**
 * Claude's canonical root for a linked worktree (`findCanonicalGitRoot`, `cr`
 * in Claude Code 2.1.322): a worktrees entry of the common directory with a
 * matching backlink. Paths resolve lexically, never realpath-followed; only
 * the backlink is compared by real path. Every gitdir, commondir and backlink
 * text and every symlink target on the way passes Claude's unsafe-path rule.
 * Anything at the common directory's `.git` refuses (Claude refuses a usable
 * one; any other entry is refused too, failing closed).
 */
function linkedWorktreeTrustRoot(dir: string): string | null {
  const host = claudePathHost();
  const link = readFileSync(join(dir, '.git'), 'utf8').trim();
  if (!link.startsWith('gitdir:')) return null;
  const gitText = link.slice(7).trim();
  if (claudeUnsafePath(gitText, dir, host) || !textWalksSafely(gitText, dir, host)) return null;
  const gitDir = resolve(dir, gitText);
  const common = readGitMetaFile(gitDir, 'commondir', host);
  if (
    common === null ||
    claudeUnsafePath(common, gitDir, host) ||
    !textWalksSafely(common, gitDir, host)
  )
    return null;
  const commonDir = resolve(gitDir, common);
  if (dirname(gitDir) !== join(commonDir, 'worktrees')) return null;
  const back = readGitMetaFile(gitDir, 'gitdir', host);
  if (
    back === null ||
    claudeUnsafePath(back, dir, host) ||
    !textWalksSafely(back, gitDir, host, dir)
  )
    return null;
  if ([dir, gitDir, back, commonDir].some((path) => path.includes('\\'))) return null;
  if (realpathSync(resolve(gitDir, back)) !== join(realpathSync(dir), '.git')) return null;
  if (basename(commonDir) !== '.git' && pathKind(join(commonDir, '.git')) !== 'absent') return null;
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
