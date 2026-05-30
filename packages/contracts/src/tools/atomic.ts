/**
 * Atomic-tool primitive contracts — the canonical I/O shapes for the CORE SDK
 * tool layer (E3 · T11403 · SG-PACKAGE-ARCH).
 *
 * A **tool primitive** is the smallest stateless unit of side-effecting work an
 * agent can perform — read a file, write a file, run a shell command, search,
 * fetch a URL, edit a notebook cell. Each primitive is a PURE function of its
 * typed input (no session/loop/global coupling); composing primitives into
 * multi-step capabilities is the job of the SKILLS layer (`packages/skills`),
 * not the tool layer. The implementations live in `packages/core/src/tools/*`
 * (T11405-T11407) behind a single deny-first guardrail chokepoint; this module
 * is their shared contract so `core`, `mcp-adapter`, `caamp`, and `cleo-os`
 * agree on one shape and never redefine it.
 *
 * This is a NEW submodule (`@cleocode/contracts/tools/atomic`) kept separate
 * from the squatted `contracts/src/tools/index.ts` (query/derivation helpers —
 * see the E3 inventory note `e3-tools-inventory`). Types-only — no runtime
 * logic (Gate 10 `contracts-purity`).
 *
 * @epic T11390
 * @task T11403
 * @saga T11387
 */

// ---------------------------------------------------------------------------
// Taxonomy
// ---------------------------------------------------------------------------

/**
 * The atomic tool classes. Each class groups primitives that share a side-effect
 * surface and therefore a guardrail policy (fs → path allowlist, shell → command
 * denylist, net → egress policy, …).
 */
export const TOOL_CLASSES = ['fs', 'shell', 'search', 'net', 'notebook'] as const;

/** One of the canonical {@link TOOL_CLASSES}. */
export type ToolClass = (typeof TOOL_CLASSES)[number];

/**
 * Descriptor for a single registered tool primitive. The registry of these is
 * the SoT for "what atomic tools exist", consumed by the guardrail chokepoint
 * and (optionally) by the MCP adapter's tool catalog (T11411).
 */
export interface ToolPrimitiveDescriptor {
  /** Stable primitive name (e.g. `readFileText`, `executeShell`). */
  readonly name: string;
  /** The side-effect class this primitive belongs to. */
  readonly class: ToolClass;
  /** One-line statement of the single responsibility this primitive owns. */
  readonly responsibility: string;
  /**
   * Whether the primitive is a pure function of its input with no
   * session/loop/global state coupling. Atomic primitives MUST be `true`;
   * the flag exists so the guardrail + lints can reject stateful drift.
   */
  readonly stateless: boolean;
}

// ---------------------------------------------------------------------------
// fs primitives
// ---------------------------------------------------------------------------

/** Input for reading a file's text content. */
export interface ReadFileInput {
  /** Absolute path to read. */
  readonly path: string;
  /** Text encoding. Defaults to `utf8` in the implementation. */
  readonly encoding?: 'utf8' | 'utf-8' | 'ascii' | 'latin1';
}

/** Result of a text read. */
export interface ReadFileResult {
  /** Absolute path that was read. */
  readonly path: string;
  /** File contents as text. */
  readonly content: string;
}

/** Input for an atomic (tmp-then-rename) file write. */
export interface WriteFileInput {
  /** Absolute path to write. */
  readonly path: string;
  /** Content to write. */
  readonly content: string;
  /** Create parent directories if missing. Defaults to `true`. */
  readonly createDirs?: boolean;
}

/** Result of a file write. */
export interface WriteFileResult {
  /** Absolute path that was written. */
  readonly path: string;
  /** Number of bytes written. */
  readonly bytesWritten: number;
}

/** Input for an existence check. */
export interface PathExistsInput {
  /** Absolute path to test. */
  readonly path: string;
}

/** Result of an existence check. */
export interface PathExistsResult {
  /** Whether the path exists. */
  readonly exists: boolean;
  /** What kind of entry it is, when it exists. */
  readonly kind?: 'file' | 'directory' | 'other';
}

// ---------------------------------------------------------------------------
// shell primitives
// ---------------------------------------------------------------------------

/** Input for a shell-command execution. */
export interface ExecuteShellInput {
  /** Executable to run (NOT a shell string — args are passed separately). */
  readonly command: string;
  /** Arguments passed to {@link ExecuteShellInput.command}. */
  readonly args?: readonly string[];
  /** Working directory. Defaults to `process.cwd()` in the implementation. */
  readonly cwd?: string;
  /** Extra environment variables merged over the inherited environment. */
  readonly env?: Readonly<Record<string, string>>;
  /** Hard timeout in milliseconds; the process is killed when exceeded. */
  readonly timeoutMs?: number;
}

/** Result of a shell-command execution. */
export interface ExecuteShellResult {
  /** Captured standard output. */
  readonly stdout: string;
  /** Captured standard error. */
  readonly stderr: string;
  /** Process exit code (0 = success). `null` when killed by signal/timeout. */
  readonly code: number | null;
}

/** Input for a `git` invocation (a constrained {@link ExecuteShellInput}). */
export interface RunGitInput {
  /** Git arguments (e.g. `['status', '--porcelain']`). */
  readonly args: readonly string[];
  /** Repository working directory. */
  readonly cwd?: string;
  /** Hard timeout in milliseconds. */
  readonly timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// search / net / notebook primitives
// ---------------------------------------------------------------------------

/** Input for a content/path search primitive. */
export interface SearchInput {
  /** Pattern to search for (literal or regex per {@link SearchInput.isRegex}). */
  readonly pattern: string;
  /** Root directory to search under. */
  readonly root: string;
  /** Treat {@link SearchInput.pattern} as a regular expression. */
  readonly isRegex?: boolean;
  /** Cap on returned matches. */
  readonly maxResults?: number;
}

/** A single search match. */
export interface SearchMatch {
  /** Absolute path of the matching file. */
  readonly path: string;
  /** 1-based line number of the match. */
  readonly line: number;
  /** The matching line's text. */
  readonly text: string;
}

/** Result of a search. */
export interface SearchResult {
  /** Matches in deterministic (path, line) order. */
  readonly matches: readonly SearchMatch[];
  /** Whether {@link SearchInput.maxResults} truncated the results. */
  readonly truncated: boolean;
}

/** Input for an outbound HTTP fetch primitive. */
export interface FetchInput {
  /** Absolute URL to fetch. */
  readonly url: string;
  /** HTTP method. Defaults to `GET`. */
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  /** Request headers. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Request body (already serialized). */
  readonly body?: string;
  /** Hard timeout in milliseconds. */
  readonly timeoutMs?: number;
}

/** Result of an HTTP fetch. */
export interface FetchResult {
  /** HTTP status code. */
  readonly status: number;
  /** Response headers. */
  readonly headers: Readonly<Record<string, string>>;
  /** Response body as text. */
  readonly body: string;
}

/** Input for a notebook-cell edit primitive. */
export interface NotebookEditInput {
  /** Absolute path to the `.ipynb` file. */
  readonly path: string;
  /** 0-based index of the cell to edit. */
  readonly cellIndex: number;
  /** New source for the cell. */
  readonly source: string;
}

/** Result of a notebook-cell edit. */
export interface NotebookEditResult {
  /** Absolute path that was edited. */
  readonly path: string;
  /** The cell index that changed. */
  readonly cellIndex: number;
}

// ---------------------------------------------------------------------------
// Canonical primitive registry (the SoT for "what atomic tools exist")
// ---------------------------------------------------------------------------

/**
 * The canonical atomic-tool primitives. Implementations in
 * `packages/core/src/tools/*` register against these names; the MCP adapter
 * (T11411) may derive its catalog from this list rather than hand-listing.
 */
export const ATOMIC_TOOL_PRIMITIVES: readonly ToolPrimitiveDescriptor[] = [
  { name: 'readFileText', class: 'fs', responsibility: 'Read a file as text', stateless: true },
  { name: 'readJson', class: 'fs', responsibility: 'Read + parse a JSON file', stateless: true },
  {
    name: 'writeFileAtomic',
    class: 'fs',
    responsibility: 'Atomically write a file (tmp-then-rename)',
    stateless: true,
  },
  {
    name: 'pathExists',
    class: 'fs',
    responsibility: 'Test path existence + kind',
    stateless: true,
  },
  {
    name: 'executeShell',
    class: 'shell',
    responsibility: 'Run a command with explicit cwd/env/timeout',
    stateless: true,
  },
  { name: 'runGit', class: 'shell', responsibility: 'Run a git subcommand', stateless: true },
  {
    name: 'search',
    class: 'search',
    responsibility: 'Search content/paths under a root',
    stateless: true,
  },
  {
    name: 'fetch',
    class: 'net',
    responsibility: 'Perform an outbound HTTP request',
    stateless: true,
  },
  {
    name: 'notebookEdit',
    class: 'notebook',
    responsibility: 'Replace a notebook cell source',
    stateless: true,
  },
] as const;
