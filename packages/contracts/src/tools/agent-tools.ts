/**
 * Agent-facing tool family I/O contracts (T1741 · epic T11456 · SG-TOOLS).
 *
 * The shared, types-only I/O shapes for the six CORE agent-tool families wired
 * into the {@link ./atomic.js | atomic} primitive layer and surfaced through the
 * `AgentToolRegistry` (`packages/core/src/tools/agent-registry.ts`):
 *
 *   - **terminal** — `run_shell` with PTY + non-PTY modes ({@link RunShellInput}).
 *   - **file/read** — `read_file` with pagination ({@link ReadFilePagedInput}).
 *   - **file/patch** — `apply_patch` with fuzzy hunk matching ({@link ApplyPatchInput}).
 *   - **search** — `search_files` over ripgrep ({@link SearchFilesInput}).
 *   - **git** — status / diff / log / commit ({@link GitStatusInput} …).
 *
 * These compose OVER the atomic `fs`/`shell`/`search` primitives — they never
 * introduce a new side-effect surface. The implementations
 * (`packages/core/src/tools/builtin/*`) perform ALL work through the injected
 * `GuardedToolSurface` (deny-first chokepoint), so the same guardrail policy
 * applies. Types-only — no runtime logic (Gate 10 `contracts-purity`).
 *
 * @epic T11456
 * @task T1741
 * @see ./atomic.js — the raw primitive I/O shapes these compose over
 */

// ---------------------------------------------------------------------------
// terminal — run_shell (PTY + non-PTY)
// ---------------------------------------------------------------------------

/**
 * Execution mode for {@link RunShellInput}.
 *
 * - `pty` — allocate a pseudo-terminal (line-discipline, colour, interactive
 *   programs). Requires the OPTIONAL `node-pty` native dep; when it cannot be
 *   loaded the implementation transparently falls back to `spawn`.
 * - `spawn` — plain `child_process.spawn` (no TTY). Always available.
 * - `auto` — prefer `pty` when `node-pty` is loadable, else `spawn`.
 */
export type ShellRunMode = 'pty' | 'spawn' | 'auto';

/** Input for the `run_shell` terminal tool. */
export interface RunShellInput {
  /** Executable to run (argv form — NOT a shell string; no shell interpolation). */
  readonly command: string;
  /** Arguments for {@link RunShellInput.command}. */
  readonly args?: readonly string[];
  /** Working directory. */
  readonly cwd?: string;
  /** Extra environment variables (scrubbed at the guard chokepoint). */
  readonly env?: Readonly<Record<string, string>>;
  /** Hard timeout in milliseconds; the process is killed when exceeded. */
  readonly timeoutMs?: number;
  /** Execution mode. Defaults to `auto`. */
  readonly mode?: ShellRunMode;
  /** PTY column count (PTY mode only). Defaults to 80. */
  readonly cols?: number;
  /** PTY row count (PTY mode only). Defaults to 24. */
  readonly rows?: number;
}

/** Result of the `run_shell` terminal tool. */
export interface RunShellResult {
  /**
   * Combined output. In `spawn` mode this is stdout; in `pty` mode stdout and
   * stderr are interleaved on the single PTY stream (as a real terminal does).
   */
  readonly stdout: string;
  /** Captured standard error. Empty in PTY mode (merged into {@link RunShellResult.stdout}). */
  readonly stderr: string;
  /** Process exit code (0 = success). `null` when killed by signal/timeout. */
  readonly code: number | null;
  /** The mode that actually ran (`pty` downgrades to `spawn` when unavailable). */
  readonly mode: 'pty' | 'spawn';
  /** Whether a PTY was requested but unavailable, so `spawn` was used instead. */
  readonly ptyFellBack: boolean;
}

// ---------------------------------------------------------------------------
// file — read_file (pagination)
// ---------------------------------------------------------------------------

/** Input for the paginated `read_file` tool. */
export interface ReadFilePagedInput {
  /** Absolute path to read. */
  readonly path: string;
  /** 0-based line offset to start from. Defaults to 0. */
  readonly offset?: number;
  /** Maximum number of lines to return. Omit for "to end of file". */
  readonly limit?: number;
}

/** Result of a paginated read. */
export interface ReadFilePagedResult {
  /** Absolute path that was read. */
  readonly path: string;
  /** The selected slice of lines (joined with `\n`). */
  readonly content: string;
  /** 0-based line offset the slice began at. */
  readonly offset: number;
  /** Number of lines returned. */
  readonly lineCount: number;
  /** Total number of lines in the file. */
  readonly totalLines: number;
  /** Whether more lines exist after the returned slice. */
  readonly hasMore: boolean;
}

// ---------------------------------------------------------------------------
// file — apply_patch (fuzzy)
// ---------------------------------------------------------------------------

/** Input for the `apply_patch` tool (fuzzy, whitespace-tolerant replacement). */
export interface ApplyPatchInput {
  /** Absolute path of the file to patch. */
  readonly path: string;
  /** Exact-or-fuzzy block of original text to locate. */
  readonly oldText: string;
  /** Replacement text. */
  readonly newText: string;
  /**
   * Permit fuzzy (leading/trailing whitespace-insensitive) matching when an
   * exact match is not found. Defaults to `true`.
   */
  readonly fuzzy?: boolean;
}

/** Result of an `apply_patch`. */
export interface ApplyPatchResult {
  /** Absolute path that was patched. */
  readonly path: string;
  /** Whether the replacement was applied. */
  readonly applied: boolean;
  /** How the match was located: exact, fuzzy (whitespace-normalised), or none. */
  readonly matchKind: 'exact' | 'fuzzy' | 'none';
  /** 0-based line where the replacement began (when applied). */
  readonly startLine?: number;
}

// ---------------------------------------------------------------------------
// search — search_files (ripgrep)
// ---------------------------------------------------------------------------

/** Input for the ripgrep-backed `search_files` tool. */
export interface SearchFilesInput {
  /** Pattern to search for (regex by default — see {@link SearchFilesInput.fixedStrings}). */
  readonly pattern: string;
  /** Root directory to search under. */
  readonly root: string;
  /** Treat {@link SearchFilesInput.pattern} as a literal string, not a regex. */
  readonly fixedStrings?: boolean;
  /** Case-insensitive matching. */
  readonly ignoreCase?: boolean;
  /** Restrict to files matching this ripgrep glob (e.g. `*.ts`). */
  readonly glob?: string;
  /** Cap on returned matches. Defaults to 1000. */
  readonly maxResults?: number;
}

/** A single `search_files` match. */
export interface SearchFilesMatch {
  /** Absolute (or root-relative) path of the matching file. */
  readonly path: string;
  /** 1-based line number of the match. */
  readonly line: number;
  /** The matching line's text (trailing newline stripped). */
  readonly text: string;
}

/** Result of `search_files`. */
export interface SearchFilesResult {
  /** Matches in ripgrep order. */
  readonly matches: readonly SearchFilesMatch[];
  /** Whether {@link SearchFilesInput.maxResults} truncated the results. */
  readonly truncated: boolean;
  /**
   * `true` when ripgrep (`rg`) was unavailable and the search degraded to a
   * built-in scan, so callers can surface reduced fidelity.
   */
  readonly degraded: boolean;
}

// ---------------------------------------------------------------------------
// git — status / diff / log / commit
// ---------------------------------------------------------------------------

/** Common options for the git tools. */
export interface GitToolBase {
  /** Repository working directory. Defaults to `process.cwd()`. */
  readonly cwd?: string;
  /** Hard timeout in milliseconds. */
  readonly timeoutMs?: number;
}

/** Input for `git_status`. */
export interface GitStatusInput extends GitToolBase {}

/** One porcelain-v1 status entry. */
export interface GitStatusEntry {
  /** Two-char XY porcelain status code (e.g. ` M`, `A `, `??`). */
  readonly status: string;
  /** Path the status applies to. */
  readonly path: string;
}

/** Result of `git_status`. */
export interface GitStatusResult {
  /** The current branch name (`HEAD` when detached/unknown). */
  readonly branch: string;
  /** Parsed porcelain entries. */
  readonly entries: readonly GitStatusEntry[];
  /** Whether the working tree has any uncommitted changes. */
  readonly clean: boolean;
}

/** Input for `git_diff`. */
export interface GitDiffInput extends GitToolBase {
  /** Show staged (`--cached`) changes instead of the working tree. */
  readonly staged?: boolean;
  /** Restrict the diff to these paths. */
  readonly paths?: readonly string[];
}

/** Result of `git_diff`. */
export interface GitDiffResult {
  /** The unified diff text (empty when there are no changes). */
  readonly diff: string;
}

/** Input for `git_log`. */
export interface GitLogInput extends GitToolBase {
  /** Maximum number of commits to return. Defaults to 20. */
  readonly maxCount?: number;
}

/** One commit in a `git_log` result. */
export interface GitLogEntry {
  /** Full commit SHA. */
  readonly sha: string;
  /** Author name. */
  readonly author: string;
  /** ISO-8601 author date. */
  readonly date: string;
  /** Commit subject (first line). */
  readonly subject: string;
}

/** Result of `git_log`. */
export interface GitLogResult {
  /** Commits newest-first. */
  readonly commits: readonly GitLogEntry[];
}

/** Input for `git_commit`. */
export interface GitCommitInput extends GitToolBase {
  /** Commit message. */
  readonly message: string;
  /** Stage all tracked modifications first (`-a`). Defaults to `false`. */
  readonly all?: boolean;
  /** Explicit paths to stage before committing. */
  readonly paths?: readonly string[];
}

/** Result of `git_commit`. */
export interface GitCommitResult {
  /** Whether the commit was created. */
  readonly committed: boolean;
  /** The new commit SHA (when created). */
  readonly sha?: string;
  /** Git's stdout/stderr summary (e.g. "nothing to commit"). */
  readonly summary: string;
}
