/**
 * Agent-facing tool FAMILIES — terminal, file, search, git (T1741 · epic T11456).
 *
 * The six richer tool families layered over the atomic primitives and registered
 * into the {@link ./agent-registry.js | AgentToolRegistry}, on top of the thin
 * built-ins in {@link ./builtin-agent-tools.js}:
 *
 *   - **AC1** `run_shell` — terminal execution with PTY + non-PTY (spawn) modes
 *     (PTY via the OPTIONAL, lazily-loaded `node-pty`; transparent spawn fallback).
 *   - **AC2** `read_file_paged` — file read with `offset`/`limit` pagination.
 *   - **AC3** `write_file_atomic` — atomic (tmp-then-rename) write.
 *   - **AC4** `apply_patch` — fuzzy (whitespace-tolerant) text replacement.
 *   - **AC5** `search_files` — ripgrep-backed search with graceful degradation
 *     to `grep` when `rg` is absent.
 *   - **AC6** `git_status` / `git_diff` / `git_log` / `git_commit` — workspace-
 *     confined git operations.
 *
 * Every family performs ALL side effects through the injected
 * {@link GuardedToolSurface} (deny-first chokepoint) — there is NO raw `fs` /
 * `child_process` use here. The pure helpers (patch matching, search-output
 * parsing, git parsing) are exported for direct unit testing with mocked
 * backends (AC8). Import-time side-effect-free.
 *
 * @epic T11456
 * @task T1741
 * @see ./guard.js — the deny-first chokepoint every executable routes through
 */

import type {
  ApplyPatchResult,
  GitLogEntry,
  GitStatusEntry,
  ReadFilePagedResult,
  SearchFilesMatch,
} from '@cleocode/contracts/tools/agent-tools';
import type { GuardedToolSurface } from '@cleocode/contracts/tools/skill-executor';
import { z } from 'zod';
import type { AgentToolRegistry, AvailabilityCheck } from './agent-registry.js';
import { ALWAYS_AVAILABLE } from './agent-registry.js';

/** Available only when the named binary is known on PATH (AC5/AC6 example). */
function binaryAvailable(name: string): AvailabilityCheck {
  return (ctx) => ctx.availableBinaries === undefined || ctx.availableBinaries.includes(name);
}

// ===========================================================================
// AC2 — paginated read (pure slice helper + tool)
// ===========================================================================

/**
 * Slice a file's text into a paginated window. Pure helper — no I/O — so it is
 * unit-testable in isolation (AC8).
 *
 * @param content - The full file text.
 * @param offset - 0-based starting line (clamped to `[0, totalLines]`).
 * @param limit - Max lines to return; `undefined` → to end of file.
 * @returns The paginated {@link ReadFilePagedResult} body for `path`.
 */
export function paginateLines(
  content: string,
  path: string,
  offset = 0,
  limit?: number,
): ReadFilePagedResult {
  const lines = content === '' ? [] : content.split('\n');
  const totalLines = lines.length;
  const start = Math.max(0, Math.min(offset, totalLines));
  const end = limit === undefined ? totalLines : Math.min(start + Math.max(0, limit), totalLines);
  const slice = lines.slice(start, end);
  return {
    path,
    content: slice.join('\n'),
    offset: start,
    lineCount: slice.length,
    totalLines,
    hasMore: end < totalLines,
  };
}

// ===========================================================================
// AC4 — fuzzy patch (pure matcher + applier)
// ===========================================================================

/** Outcome of {@link applyFuzzyPatch} — the new content + how it matched. */
export interface FuzzyPatchOutcome {
  /** The patched content (unchanged when `matchKind === 'none'`). */
  readonly content: string;
  /** How `oldText` was located. */
  readonly matchKind: ApplyPatchResult['matchKind'];
  /** 0-based line where the replacement began (when applied). */
  readonly startLine?: number;
}

/** Normalise a block for fuzzy comparison: trim each line, drop blank edges. */
function normaliseBlock(block: string): string[] {
  return block
    .split('\n')
    .map((l) => l.trim())
    .filter((_l, i, arr) => {
      // keep interior; trim leading/trailing all-blank lines
      if (arr[i] !== '') return true;
      const beforeAllBlank = arr.slice(0, i).every((x) => x === '');
      const afterAllBlank = arr.slice(i + 1).every((x) => x === '');
      return !(beforeAllBlank || afterAllBlank);
    });
}

/**
 * Apply a text replacement, falling back to whitespace-tolerant fuzzy matching
 * when an exact substring match is not found. Pure function of its inputs — no
 * I/O — so it is unit-testable with no filesystem (AC8).
 *
 * Strategy:
 *  1. **Exact** — a verbatim `indexOf(oldText)` substring replacement (first hit).
 *  2. **Fuzzy** (when enabled) — compare `oldText` line-trimmed against every
 *     same-length window of the file's line-trimmed lines; the first window that
 *     matches is replaced (preserving the file's other lines).
 *  3. **None** — no match; content returned unchanged.
 *
 * @param content - The current file content.
 * @param oldText - The block to locate.
 * @param newText - The replacement.
 * @param fuzzy - Permit fuzzy matching (default `true`).
 * @returns The {@link FuzzyPatchOutcome}.
 */
export function applyFuzzyPatch(
  content: string,
  oldText: string,
  newText: string,
  fuzzy = true,
): FuzzyPatchOutcome {
  // 1) exact substring
  const idx = content.indexOf(oldText);
  if (idx !== -1) {
    const startLine = content.slice(0, idx).split('\n').length - 1;
    const patched = `${content.slice(0, idx)}${newText}${content.slice(idx + oldText.length)}`;
    return { content: patched, matchKind: 'exact', startLine };
  }
  if (!fuzzy) {
    return { content, matchKind: 'none' };
  }
  // 2) fuzzy line-window match (whitespace-insensitive)
  const fileLines = content.split('\n');
  const needle = normaliseBlock(oldText);
  if (needle.length === 0) {
    return { content, matchKind: 'none' };
  }
  for (let i = 0; i + needle.length <= fileLines.length; i++) {
    const window = fileLines.slice(i, i + needle.length).map((l) => l.trim());
    if (window.every((line, j) => line === needle[j])) {
      const replacementLines = newText.split('\n');
      const patchedLines = [
        ...fileLines.slice(0, i),
        ...replacementLines,
        ...fileLines.slice(i + needle.length),
      ];
      return { content: patchedLines.join('\n'), matchKind: 'fuzzy', startLine: i };
    }
  }
  return { content, matchKind: 'none' };
}

// ===========================================================================
// AC5 — ripgrep search-output parsing
// ===========================================================================

/**
 * Parse ripgrep `--vimgrep`/`-n` style output (`path:line:col:text` or
 * `path:line:text`) into structured matches. Pure helper (AC8).
 *
 * @param stdout - ripgrep stdout.
 * @param maxResults - Cap on returned matches.
 * @returns The parsed matches and whether the cap truncated them.
 */
export function parseRipgrepOutput(
  stdout: string,
  maxResults: number,
): { matches: SearchFilesMatch[]; truncated: boolean } {
  const matches: SearchFilesMatch[] = [];
  const lines = stdout.split('\n').filter((l) => l.length > 0);
  for (const raw of lines) {
    // path may contain ':' (rare); split on the FIRST two/three colons carefully.
    // rg -n emits `path:line:text`; rg --vimgrep emits `path:line:col:text`.
    const m = /^(.*?):(\d+):(?:(\d+):)?(.*)$/.exec(raw);
    if (m === null) continue;
    const path = m[1];
    const line = Number.parseInt(m[2], 10);
    const text = m[4] ?? '';
    if (Number.isNaN(line)) continue;
    matches.push({ path, line, text });
    if (matches.length >= maxResults) {
      return { matches, truncated: true };
    }
  }
  return { matches, truncated: false };
}

// ===========================================================================
// AC6 — git output parsing
// ===========================================================================

/**
 * Parse `git status --porcelain=v1` output into structured entries. Pure (AC8).
 *
 * @param stdout - porcelain-v1 stdout.
 * @returns The parsed status entries.
 */
export function parseGitStatus(stdout: string): GitStatusEntry[] {
  const entries: GitStatusEntry[] = [];
  for (const raw of stdout.split('\n')) {
    if (raw.length < 4) continue;
    const status = raw.slice(0, 2);
    const path = raw.slice(3);
    entries.push({ status, path });
  }
  return entries;
}

/** The record separator used in the {@link GIT_LOG_FORMAT} pretty format. */
const GIT_LOG_FIELD_SEP = '';

/**
 * The `--pretty=format:` argument for {@link parseGitLog} — SHA, author name,
 * ISO date, subject, unit-separated.
 */
export const GIT_LOG_FORMAT = `%H${GIT_LOG_FIELD_SEP}%an${GIT_LOG_FIELD_SEP}%aI${GIT_LOG_FIELD_SEP}%s`;

/**
 * Parse `git log --pretty=format:<GIT_LOG_FORMAT>` output. Pure (AC8).
 *
 * @param stdout - The git-log stdout.
 * @returns The parsed commit entries, newest-first.
 */
export function parseGitLog(stdout: string): GitLogEntry[] {
  const commits: GitLogEntry[] = [];
  for (const raw of stdout.split('\n')) {
    if (raw.length === 0) continue;
    const [sha, author, date, subject] = raw.split(GIT_LOG_FIELD_SEP);
    if (sha === undefined) continue;
    commits.push({
      sha,
      author: author ?? '',
      date: date ?? '',
      subject: subject ?? '',
    });
  }
  return commits;
}

/**
 * Run a guarded ripgrep search, degrading to `grep -rn` when `rg` is absent.
 * All execution flows through {@link GuardedToolSurface.executeShell}.
 *
 * @param tools - The guarded surface.
 * @param args - Search parameters (already normalised).
 * @returns Matches, truncation flag, and whether the search degraded.
 */
async function guardedSearch(
  tools: GuardedToolSurface,
  args: {
    pattern: string;
    root: string;
    fixedStrings: boolean;
    ignoreCase: boolean;
    glob?: string;
    maxResults: number;
    timeoutMs?: number;
  },
): Promise<{ matches: SearchFilesMatch[]; truncated: boolean; degraded: boolean }> {
  const rgArgs = ['--no-heading', '--line-number', '--color=never'];
  if (args.fixedStrings) rgArgs.push('--fixed-strings');
  if (args.ignoreCase) rgArgs.push('--ignore-case');
  if (args.glob !== undefined) rgArgs.push('--glob', args.glob);
  rgArgs.push('--max-count', String(args.maxResults), '--', args.pattern, args.root);
  try {
    const res = await tools.executeShell({
      command: 'rg',
      args: rgArgs,
      timeoutMs: args.timeoutMs,
    });
    // rg exit 0 = matches, 1 = no matches (both fine), 2 = error.
    if (res.code === 2) {
      return { matches: [], truncated: false, degraded: false };
    }
    const { matches, truncated } = parseRipgrepOutput(res.stdout, args.maxResults);
    return { matches, truncated, degraded: false };
  } catch {
    // rg not on PATH (spawn ENOENT) — degrade to grep.
    return grepFallback(tools, args);
  }
}

/** Degraded `grep -rn` fallback when ripgrep is unavailable. */
async function grepFallback(
  tools: GuardedToolSurface,
  args: {
    pattern: string;
    root: string;
    fixedStrings: boolean;
    ignoreCase: boolean;
    maxResults: number;
    timeoutMs?: number;
  },
): Promise<{ matches: SearchFilesMatch[]; truncated: boolean; degraded: boolean }> {
  const grepArgs = ['-rn'];
  if (args.fixedStrings) grepArgs.push('-F');
  if (args.ignoreCase) grepArgs.push('-i');
  grepArgs.push('--', args.pattern, args.root);
  try {
    const res = await tools.executeShell({
      command: 'grep',
      args: grepArgs,
      timeoutMs: args.timeoutMs,
    });
    const { matches, truncated } = parseRipgrepOutput(res.stdout, args.maxResults);
    return { matches, truncated, degraded: true };
  } catch {
    // Neither rg nor grep available — report empty, degraded.
    return { matches: [], truncated: false, degraded: true };
  }
}

/**
 * Register the agent-facing tool FAMILIES (terminal, file, search, git) into
 * `registry`. Pure registration — no I/O, no scan; side effects happen later
 * through the injected {@link GuardedToolSurface}.
 *
 * @param registry - The registry to populate.
 */
export function registerAgentToolFamilies(registry: AgentToolRegistry): void {
  // --- AC1: terminal — run_shell (PTY + non-PTY) ---------------------------
  registry.register({
    name: 'run_shell',
    class: 'shell',
    description:
      'Run a command under a PTY (or non-PTY spawn fallback) with cwd/env/timeout. ' +
      'argv form — never a shell string.',
    toolset: 'terminal',
    stateless: true,
    available: ALWAYS_AVAILABLE,
    parameters: z.object({
      command: z.string().describe('Executable to run (NOT a shell string).'),
      args: z.array(z.string()).optional().describe('Arguments for the command.'),
      cwd: z.string().optional().describe('Working directory.'),
      timeoutMs: z.number().int().positive().optional().describe('Hard timeout in ms.'),
      mode: z
        .enum(['pty', 'spawn', 'auto'])
        .optional()
        .describe("Execution mode: 'pty', 'spawn', or 'auto' (default)."),
      cols: z.number().int().positive().optional().describe('PTY column count (PTY mode).'),
      rows: z.number().int().positive().optional().describe('PTY row count (PTY mode).'),
    }),
    execute: async (rawArgs, tools) => {
      const command = String(rawArgs.command);
      const argv = Array.isArray(rawArgs.args) ? rawArgs.args.map(String) : undefined;
      const cwd = rawArgs.cwd === undefined ? undefined : String(rawArgs.cwd);
      const timeoutMs = typeof rawArgs.timeoutMs === 'number' ? rawArgs.timeoutMs : undefined;
      const mode =
        rawArgs.mode === 'pty' || rawArgs.mode === 'spawn' || rawArgs.mode === 'auto'
          ? rawArgs.mode
          : undefined;
      const cols = typeof rawArgs.cols === 'number' ? rawArgs.cols : undefined;
      const rows = typeof rawArgs.rows === 'number' ? rawArgs.rows : undefined;
      return tools.executePty({ command, args: argv, cwd, timeoutMs, mode, cols, rows });
    },
  });

  // --- AC2: file — read_file_paged ----------------------------------------
  registry.register({
    name: 'read_file_paged',
    class: 'fs',
    description: 'Read a file with line pagination (offset/limit).',
    toolset: 'file',
    stateless: true,
    available: ALWAYS_AVAILABLE,
    parameters: z.object({
      path: z.string().describe('Absolute path to read.'),
      offset: z.number().int().min(0).optional().describe('0-based start line.'),
      limit: z.number().int().positive().optional().describe('Max lines to return.'),
    }),
    execute: async (rawArgs, tools) => {
      const path = String(rawArgs.path);
      const offset = typeof rawArgs.offset === 'number' ? rawArgs.offset : 0;
      const limit = typeof rawArgs.limit === 'number' ? rawArgs.limit : undefined;
      const { content } = await tools.readFileText({ path });
      return paginateLines(content, path, offset, limit);
    },
  });

  // --- AC3: file — write_file_atomic --------------------------------------
  registry.register({
    name: 'write_file_atomic',
    class: 'fs',
    description: 'Atomically write a file (tmp-then-rename), creating parent dirs.',
    toolset: 'file',
    stateless: true,
    available: ALWAYS_AVAILABLE,
    parameters: z.object({
      path: z.string().describe('Absolute path to write.'),
      content: z.string().describe('File content to write.'),
    }),
    execute: async (rawArgs, tools) => {
      const path = String(rawArgs.path);
      const content = String(rawArgs.content);
      return tools.writeFileAtomic({ path, content });
    },
  });

  // --- AC4: file — apply_patch (fuzzy) ------------------------------------
  registry.register({
    name: 'apply_patch',
    class: 'fs',
    description: 'Replace a block of text in a file (exact, then fuzzy whitespace-tolerant match).',
    toolset: 'file',
    stateless: true,
    available: ALWAYS_AVAILABLE,
    parameters: z.object({
      path: z.string().describe('Absolute path of the file to patch.'),
      oldText: z.string().describe('Block of original text to locate.'),
      newText: z.string().describe('Replacement text.'),
      fuzzy: z.boolean().optional().describe('Permit fuzzy matching (default true).'),
    }),
    execute: async (rawArgs, tools): Promise<ApplyPatchResult> => {
      const path = String(rawArgs.path);
      const oldText = String(rawArgs.oldText);
      const newText = String(rawArgs.newText);
      const fuzzy = rawArgs.fuzzy === undefined ? true : Boolean(rawArgs.fuzzy);
      const { content } = await tools.readFileText({ path });
      const outcome = applyFuzzyPatch(content, oldText, newText, fuzzy);
      if (outcome.matchKind === 'none') {
        return { path, applied: false, matchKind: 'none' };
      }
      await tools.writeFileAtomic({ path, content: outcome.content });
      return {
        path,
        applied: true,
        matchKind: outcome.matchKind,
        startLine: outcome.startLine,
      };
    },
  });

  // --- AC5: search — search_files (ripgrep, grep fallback) ----------------
  registry.register({
    name: 'search_files',
    class: 'search',
    description: 'Search file contents under a root via ripgrep (grep fallback when rg is absent).',
    toolset: 'file',
    stateless: true,
    available: ALWAYS_AVAILABLE,
    parameters: z.object({
      pattern: z.string().describe('Pattern to search for (regex unless fixedStrings).'),
      root: z.string().describe('Root directory to search under.'),
      fixedStrings: z.boolean().optional().describe('Treat pattern as a literal string.'),
      ignoreCase: z.boolean().optional().describe('Case-insensitive matching.'),
      glob: z.string().optional().describe('Restrict to files matching this glob.'),
      maxResults: z.number().int().positive().optional().describe('Cap on matches (default 1000).'),
      timeoutMs: z.number().int().positive().optional().describe('Hard timeout in ms.'),
    }),
    execute: async (rawArgs, tools) => {
      const maxResults = typeof rawArgs.maxResults === 'number' ? rawArgs.maxResults : 1000;
      return guardedSearch(tools, {
        pattern: String(rawArgs.pattern),
        root: String(rawArgs.root),
        fixedStrings: Boolean(rawArgs.fixedStrings),
        ignoreCase: Boolean(rawArgs.ignoreCase),
        glob: rawArgs.glob === undefined ? undefined : String(rawArgs.glob),
        maxResults,
        timeoutMs: typeof rawArgs.timeoutMs === 'number' ? rawArgs.timeoutMs : undefined,
      });
    },
  });

  // --- AC6: git — status / diff / log / commit ----------------------------
  const gitAvailable = binaryAvailable('git');

  registry.register({
    name: 'git_status',
    class: 'shell',
    description: 'Show the working-tree status (branch + porcelain entries).',
    toolset: 'terminal',
    stateless: true,
    available: gitAvailable,
    parameters: z.object({
      cwd: z.string().optional().describe('Repository working directory.'),
      timeoutMs: z.number().int().positive().optional().describe('Hard timeout in ms.'),
    }),
    execute: async (rawArgs, tools) => {
      const cwd = rawArgs.cwd === undefined ? undefined : String(rawArgs.cwd);
      const timeoutMs = typeof rawArgs.timeoutMs === 'number' ? rawArgs.timeoutMs : undefined;
      const branchRes = await tools.runGit({
        args: ['rev-parse', '--abbrev-ref', 'HEAD'],
        cwd,
        timeoutMs,
      });
      const statusRes = await tools.runGit({
        args: ['status', '--porcelain=v1'],
        cwd,
        timeoutMs,
      });
      const entries = parseGitStatus(statusRes.stdout);
      return {
        branch: branchRes.stdout.trim() || 'HEAD',
        entries,
        clean: entries.length === 0,
      };
    },
  });

  registry.register({
    name: 'git_diff',
    class: 'shell',
    description: 'Show the unified diff of working-tree or staged changes.',
    toolset: 'terminal',
    stateless: true,
    available: gitAvailable,
    parameters: z.object({
      staged: z.boolean().optional().describe('Show staged (--cached) changes.'),
      paths: z.array(z.string()).optional().describe('Restrict to these paths.'),
      cwd: z.string().optional().describe('Repository working directory.'),
      timeoutMs: z.number().int().positive().optional().describe('Hard timeout in ms.'),
    }),
    execute: async (rawArgs, tools) => {
      const cwd = rawArgs.cwd === undefined ? undefined : String(rawArgs.cwd);
      const timeoutMs = typeof rawArgs.timeoutMs === 'number' ? rawArgs.timeoutMs : undefined;
      const gitArgs = ['diff'];
      if (rawArgs.staged === true) gitArgs.push('--cached');
      if (Array.isArray(rawArgs.paths) && rawArgs.paths.length > 0) {
        gitArgs.push('--', ...rawArgs.paths.map(String));
      }
      const res = await tools.runGit({ args: gitArgs, cwd, timeoutMs });
      return { diff: res.stdout };
    },
  });

  registry.register({
    name: 'git_log',
    class: 'shell',
    description: 'List recent commits (sha, author, date, subject).',
    toolset: 'terminal',
    stateless: true,
    available: gitAvailable,
    parameters: z.object({
      maxCount: z.number().int().positive().optional().describe('Max commits (default 20).'),
      cwd: z.string().optional().describe('Repository working directory.'),
      timeoutMs: z.number().int().positive().optional().describe('Hard timeout in ms.'),
    }),
    execute: async (rawArgs, tools) => {
      const cwd = rawArgs.cwd === undefined ? undefined : String(rawArgs.cwd);
      const timeoutMs = typeof rawArgs.timeoutMs === 'number' ? rawArgs.timeoutMs : undefined;
      const maxCount = typeof rawArgs.maxCount === 'number' ? rawArgs.maxCount : 20;
      const res = await tools.runGit({
        args: ['log', `--max-count=${maxCount}`, `--pretty=format:${GIT_LOG_FORMAT}`],
        cwd,
        timeoutMs,
      });
      return { commits: parseGitLog(res.stdout) };
    },
  });

  registry.register({
    name: 'git_commit',
    class: 'shell',
    description: 'Create a commit (optionally staging tracked changes or explicit paths).',
    toolset: 'terminal',
    stateless: true,
    available: gitAvailable,
    parameters: z.object({
      message: z.string().describe('Commit message.'),
      all: z.boolean().optional().describe('Stage all tracked modifications first (-a).'),
      paths: z.array(z.string()).optional().describe('Explicit paths to stage before committing.'),
      cwd: z.string().optional().describe('Repository working directory.'),
      timeoutMs: z.number().int().positive().optional().describe('Hard timeout in ms.'),
    }),
    execute: async (rawArgs, tools) => {
      const cwd = rawArgs.cwd === undefined ? undefined : String(rawArgs.cwd);
      const timeoutMs = typeof rawArgs.timeoutMs === 'number' ? rawArgs.timeoutMs : undefined;
      const message = String(rawArgs.message);
      if (Array.isArray(rawArgs.paths) && rawArgs.paths.length > 0) {
        await tools.runGit({ args: ['add', '--', ...rawArgs.paths.map(String)], cwd, timeoutMs });
      }
      const commitArgs = ['commit', '-m', message];
      if (rawArgs.all === true) commitArgs.splice(1, 0, '-a');
      const res = await tools.runGit({ args: commitArgs, cwd, timeoutMs });
      const committed = res.code === 0;
      let sha: string | undefined;
      if (committed) {
        const head = await tools.runGit({ args: ['rev-parse', 'HEAD'], cwd, timeoutMs });
        sha = head.stdout.trim() || undefined;
      }
      const summary = `${res.stdout}${res.stderr}`.trim();
      return { committed, sha, summary };
    },
  });
}
