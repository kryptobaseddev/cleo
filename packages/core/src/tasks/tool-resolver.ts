/**
 * Project-agnostic tool resolver for evidence-based verification (ADR-051).
 *
 * `cleo verify --evidence "tool:<name>"` historically hardcoded a pnpm/biome/tsc
 * table inside `evidence.ts`, violating the package-boundary contract that
 * `@cleocode/core` MUST be agnostic to any specific project type. This module
 * replaces the hardcoded `TOOL_COMMANDS` table with a resolver that:
 *
 *   1. Maps a logical (canonical) tool name to a runnable command.
 *   2. Sources the command from `.cleo/project-context.json` when the user
 *      has captured a project-specific override (`testing.command`,
 *      `build.command`, …).
 *   3. For JavaScript projects, runs the project's own `package.json` script
 *      of the canonical name through its package manager (T12633), so the
 *      project's definition — and its `pre`/`post` hooks — is what gets run.
 *   4. Falls back to per-`primaryType` defaults (node, python, rust, go, …)
 *      when neither of the above specifies the tool.
 *   5. Honours legacy aliases (`pnpm-test`, `tsc`, `biome`, …) for backwards
 *      compatibility with already-stored evidence atoms.
 *
 * The resolved command always includes its `source` so audit and cache layers
 * can disambiguate "user-supplied" from "language-default" invocations.
 *
 * @task T1534
 * @adr ADR-051 §3
 * @adr ADR-061
 */

import { existsSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { loadProjectContext } from '../agents/variable-substitution.js';
import type { ProjectType } from '../store/project-detect.js';
import { splitCommandLine } from './command-line.js';
import { isReferencesOnlyTsconfig } from './tool-vacuity.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Canonical (project-agnostic) tool names accepted by `cleo verify
 * --evidence "tool:<name>"`.
 *
 * Each canonical name maps to a project-specific command via
 * {@link resolveToolCommand}. Adding a new canonical tool requires:
 *
 *   1. Adding the name here.
 *   2. Adding a default for each {@link ProjectType} in `LANGUAGE_DEFAULTS`.
 *   3. Updating {@link checkGateEvidenceMinimum} if the new tool can satisfy
 *      a verification gate.
 */
export const CANONICAL_TOOLS = [
  'test',
  'build',
  'lint',
  'typecheck',
  'audit',
  'security-scan',
  /**
   * Runs a full nexus impact analysis on all symbols in the task's files list.
   * Used as evidence for the `nexusImpact` gate (T1073 / EP3-T8).
   *
   * Resolves to `cleo nexus impact-full <symbol>` on the project, which
   * calls `reasonImpactOfChange()` and returns the ImpactFullReport.
   *
   * @task T1073
   */
  'nexus-impact-full',
] as const;

/**
 * Type of a canonical (project-agnostic) tool name.
 *
 * @task T1534
 */
export type CanonicalTool = (typeof CANONICAL_TOOLS)[number];

/**
 * Where a resolved command originated. Surfaced in cache keys and audit
 * trails so reviewers can distinguish project-supplied commands from CLEO
 * defaults.
 */
export type ResolutionSource =
  | 'project-context' // `.cleo/project-context.json` testing.command / build.command
  | 'package-script' // `package.json` script of the canonical name (T12633)
  | 'language-default' // Per-`primaryType` fallback table
  | 'legacy-alias'; // Pre-T1534 hardcoded alias preserved for evidence compatibility

/**
 * A resolved tool command ready for spawning. `cmd` and `args` are
 * shell-escaping-free — callers MUST pass them to `child_process.spawn`
 * (NOT a shell) to avoid injection.
 *
 * @task T1534
 */
export interface ResolvedToolCommand {
  /** Canonical tool name (post-alias resolution). */
  canonical: CanonicalTool;
  /** Human-friendly tool name for stdout / audit (often equal to `canonical`). */
  displayName: string;
  /** Executable to spawn. */
  cmd: string;
  /** Arguments. */
  args: string[];
  /** Origin of this command — used by cache keys. */
  source: ResolutionSource;
  /** When `source === 'language-default'`, the `primaryType` that was matched. */
  primaryType?: ProjectType;
}

/**
 * Result envelope returned by {@link resolveToolCommand}.
 *
 * @task T1534
 */
export type ResolveToolResult =
  | { ok: true; command: ResolvedToolCommand }
  | {
      ok: false;
      reason: string;
      /**
       * `E_TOOL_COMMAND_INVALID`: the declared project-context command uses
       * shell syntax (or an open quote) it cannot run without a shell (T12718).
       */
      codeName:
        | 'E_TOOL_UNKNOWN'
        | 'E_TOOL_UNAVAILABLE'
        | 'E_TOOL_NOT_APPLICABLE'
        | 'E_TOOL_COMMAND_INVALID';
      /** With `E_TOOL_COMMAND_INVALID`: the declared command, verbatim. */
      rawCommand?: string;
    };

// ---------------------------------------------------------------------------
// Aliases — preserved for backward compatibility with evidence written
// before T1534. Existing audit trails reference `tool:pnpm-test`,
// `tool:biome`, etc. — those names continue to resolve.
// ---------------------------------------------------------------------------

/**
 * Mapping of legacy hardcoded tool names → canonical name.
 *
 * @task T1534
 */
const LEGACY_TOOL_ALIASES: Record<string, CanonicalTool> = {
  // Test runners
  'pnpm-test': 'test',
  'npm-test': 'test',
  'yarn-test': 'test',
  'bun-test': 'test',
  vitest: 'test',
  jest: 'test',
  pytest: 'test',
  'cargo-test': 'test',
  'go-test': 'test',
  // Builders
  'pnpm-build': 'build',
  'npm-build': 'build',
  'yarn-build': 'build',
  'bun-build': 'build',
  'cargo-build': 'build',
  'go-build': 'build',
  // Linters
  biome: 'lint',
  eslint: 'lint',
  prettier: 'lint',
  ruff: 'lint',
  clippy: 'lint',
  // Type checkers
  tsc: 'typecheck',
  mypy: 'typecheck',
  pyright: 'typecheck',
  // Audit / security
  audit: 'audit',
  'pnpm-audit': 'audit',
  'npm-audit': 'audit',
  'cargo-audit': 'audit',
};

/**
 * Mapping from canonical tool name to the JSON-path segments in
 * `.cleo/project-context.json` that carry the user-supplied command override.
 *
 * `null` entries have no project-context override and always fall through
 * to the per-language defaults (e.g. `nexus-impact-full` is always `cleo
 * nexus impact-full`).
 *
 * @task T12027
 */
const PROJECT_CONTEXT_KEY_MAP: Record<CanonicalTool, string[] | null> = {
  test: ['testing', 'command'],
  build: ['build', 'command'],
  lint: ['lint', 'command'],
  typecheck: ['typecheck', 'command'],
  audit: ['audit', 'command'],
  'security-scan': ['security-scan', 'command'],
  'nexus-impact-full': null,
};

/**
 * `tool:<name>` payloads that are valid evidence but not resolvable through
 * {@link resolveToolCommand}: `test-affected` plans its command from the branch
 * diff (`planAffectedTestRun`) and runs under the canonical `test` class.
 *
 * @task T12964
 */
const PLANNED_TOOLS = ['test-affected'] as const;

/**
 * Set of all valid `tool:<name>` payloads — canonical names, legacy aliases,
 * and the diff-planned `test-affected`. Returned by {@link listValidToolNames}
 * for help / validation surfaces.
 *
 * @task T1534
 * @task T12964
 */
export function listValidToolNames(): string[] {
  return [
    ...new Set([...CANONICAL_TOOLS, ...Object.keys(LEGACY_TOOL_ALIASES), ...PLANNED_TOOLS]),
  ].sort();
}

// ---------------------------------------------------------------------------
// Per-language defaults — keyed on `primaryType` from project-context.json
// ---------------------------------------------------------------------------

interface CommandShape {
  cmd: string;
  args: string[];
}

/**
 * Per-`primaryType` defaults. These are project-agnostic at the package level
 * because the table is keyed on the *detected* type — a Rust project resolves
 * `test` to `cargo test`, a Python project to `pytest`, etc.
 *
 * Defaults intentionally avoid pnpm/yarn/bun forks for Node — they read the
 * project's package manager from `project-context.json` when available, then
 * fall back to `npm` (the lowest common denominator).
 *
 * @internal
 */
const LANGUAGE_DEFAULTS: Record<ProjectType, Partial<Record<CanonicalTool, CommandShape>>> = {
  node: {
    // Note: when project-context.json carries `testing.command` / `build.command`,
    // the resolver prefers those over these fallbacks. These exist so a fresh
    // project (no project-context.json yet) still gets a working default.
    test: { cmd: 'npm', args: ['test'] },
    build: { cmd: 'npm', args: ['run', 'build'] },
    lint: { cmd: 'npx', args: ['biome', 'check', '.'] },
    typecheck: { cmd: 'npx', args: ['tsc', '--noEmit'] },
    audit: { cmd: 'npm', args: ['audit'] },
    'security-scan': { cmd: 'npm', args: ['audit'] },
    // nexus-impact-full is project-type-agnostic; cleo is always available.
    'nexus-impact-full': { cmd: 'cleo', args: ['nexus', 'impact-full'] },
  },
  python: {
    test: { cmd: 'pytest', args: [] },
    build: { cmd: 'python', args: ['-m', 'build'] },
    lint: { cmd: 'ruff', args: ['check', '.'] },
    typecheck: { cmd: 'mypy', args: ['.'] },
    audit: { cmd: 'pip-audit', args: [] },
    'security-scan': { cmd: 'pip-audit', args: [] },
    'nexus-impact-full': { cmd: 'cleo', args: ['nexus', 'impact-full'] },
  },
  rust: {
    test: { cmd: 'cargo', args: ['test'] },
    build: { cmd: 'cargo', args: ['build'] },
    lint: { cmd: 'cargo', args: ['clippy', '--', '-D', 'warnings'] },
    typecheck: { cmd: 'cargo', args: ['check'] },
    audit: { cmd: 'cargo', args: ['audit'] },
    'security-scan': { cmd: 'cargo', args: ['audit'] },
    'nexus-impact-full': { cmd: 'cleo', args: ['nexus', 'impact-full'] },
  },
  go: {
    test: { cmd: 'go', args: ['test', './...'] },
    build: { cmd: 'go', args: ['build', './...'] },
    lint: { cmd: 'go', args: ['vet', './...'] },
    typecheck: { cmd: 'go', args: ['build', '-o', '/dev/null', './...'] },
    'nexus-impact-full': { cmd: 'cleo', args: ['nexus', 'impact-full'] },
  },
  ruby: {
    test: { cmd: 'bundle', args: ['exec', 'rspec'] },
    build: { cmd: 'bundle', args: ['install'] },
    lint: { cmd: 'bundle', args: ['exec', 'rubocop'] },
    'nexus-impact-full': { cmd: 'cleo', args: ['nexus', 'impact-full'] },
  },
  java: {
    test: { cmd: 'mvn', args: ['test'] },
    build: { cmd: 'mvn', args: ['package'] },
    'nexus-impact-full': { cmd: 'cleo', args: ['nexus', 'impact-full'] },
  },
  dotnet: {
    test: { cmd: 'dotnet', args: ['test'] },
    build: { cmd: 'dotnet', args: ['build'] },
    'nexus-impact-full': { cmd: 'cleo', args: ['nexus', 'impact-full'] },
  },
  bash: {
    test: { cmd: 'bats', args: ['tests'] },
    'nexus-impact-full': { cmd: 'cleo', args: ['nexus', 'impact-full'] },
  },
  elixir: {
    test: { cmd: 'mix', args: ['test'] },
    build: { cmd: 'mix', args: ['compile'] },
    'nexus-impact-full': { cmd: 'cleo', args: ['nexus', 'impact-full'] },
  },
  php: {
    test: { cmd: 'composer', args: ['test'] },
    build: { cmd: 'composer', args: ['install'] },
    'nexus-impact-full': { cmd: 'cleo', args: ['nexus', 'impact-full'] },
  },
  deno: {
    test: { cmd: 'deno', args: ['test'] },
    build: { cmd: 'deno', args: ['compile'] },
    lint: { cmd: 'deno', args: ['lint'] },
    typecheck: { cmd: 'deno', args: ['check'] },
    'nexus-impact-full': { cmd: 'cleo', args: ['nexus', 'impact-full'] },
  },
  bun: {
    test: { cmd: 'bun', args: ['test'] },
    build: { cmd: 'bun', args: ['run', 'build'] },
    'nexus-impact-full': { cmd: 'cleo', args: ['nexus', 'impact-full'] },
  },
  unknown: {
    'nexus-impact-full': { cmd: 'cleo', args: ['nexus', 'impact-full'] },
  },
};

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Parse a project-context command string (e.g. `"pnpm run test"`) into a
 * `(cmd, args[])` pair suitable for `child_process.spawn`.
 *
 * Splits with POSIX `sh` quoting (T12718). The command runs without a shell,
 * so shell syntax is refused: split on whitespace, `pnpm build && pnpm test`
 * ran `pnpm build` with `&& pnpm test` as ignored arguments and could record
 * a false `tool:test` pass.
 *
 * @throws When `raw` uses shell syntax or has an unterminated quote.
 * @internal
 */
function parseCommandString(raw: string, label: string): CommandShape | null {
  const parts = splitCommandLine(raw, label);
  const cmd = parts[0];
  if (!cmd) return null;
  return { cmd, args: parts.slice(1) };
}

/**
 * Markers that prove a project actually uses a given toolchain (T12083).
 *
 * Consulted ONLY for language-default resolutions. An explicit command in
 * `project-context.json` is always applicable — the operator said so.
 *
 * A marker is a config file, a `package.json` script of the canonical name, or
 * a declared dependency. Any one is enough.
 */
const APPLICABILITY_MARKERS: Partial<
  Record<ProjectType, Partial<Record<CanonicalTool, { files: string[]; deps: string[] }>>>
> = {
  node: {
    typecheck: { files: ['tsconfig.json', 'jsconfig.json'], deps: ['typescript'] },
    lint: {
      files: [
        'biome.json',
        'biome.jsonc',
        '.eslintrc',
        '.eslintrc.js',
        '.eslintrc.cjs',
        '.eslintrc.json',
        'eslint.config.js',
        'eslint.config.mjs',
        '.oxlintrc.json',
      ],
      deps: ['@biomejs/biome', 'eslint', 'oxlint'],
    },
  },
};

/**
 * Does this project actually have the toolchain a language default assumes?
 *
 * The node default for `typecheck` is `npx tsc --noEmit`. In a plain
 * JavaScript project that is not a "working default" — `npx` reports
 * *"This is not the tsc command you are looking for"* and exits 1, so the
 * `qaPassed` gate can never be satisfied and **no task can ever be completed**.
 * A correct worker that implements, tests, and commits is then rejected for
 * lacking a typechecker in a project that has nothing to typecheck.
 *
 * That is the drop-into-any-project blocker: gate rigour has to scale to the
 * project's actual toolchain, not to the one CLEO was built in.
 *
 * @param canonical - canonical tool name.
 * @param projectRoot - absolute project root.
 * @param primaryType - detected project type.
 * @returns `true` when the toolchain is present, or when no marker is defined
 *   for this (type, tool) pair — unknown means "assume applicable", which
 *   preserves every existing gate.
 *
 * @task T12083
 */
function isToolApplicable(
  canonical: CanonicalTool,
  projectRoot: string,
  primaryType: ProjectType,
): boolean {
  const marker = APPLICABILITY_MARKERS[primaryType]?.[canonical];
  if (!marker) return true;

  if (marker.files.some((f) => existsSync(join(projectRoot, f)))) return true;

  try {
    const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf-8')) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    if (pkg.scripts?.[canonical]) return true;
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (marker.deps.some((d) => d in deps)) return true;
  } catch {
    // No package.json / unreadable — fall through to "not applicable".
  }

  return false;
}

/**
 * Canonical tools a project's own `package.json` script may define (T12633).
 *
 * The script name is the canonical name itself: `tool:typecheck` runs the
 * `typecheck` script. Audit/security/nexus tools are not project scripts by
 * convention and keep their language defaults.
 */
const PACKAGE_SCRIPT_TOOLS: ReadonlySet<CanonicalTool> = new Set([
  'test',
  'build',
  'lint',
  'typecheck',
]);

/** Project types whose `package.json` scripts are the project's own commands. */
const PACKAGE_SCRIPT_TYPES: ReadonlySet<ProjectType> = new Set(['node', 'bun']);

/** Package managers CLEO knows how to invoke a script through. */
type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/**
 * Detect the package manager a JavaScript project uses: the `packageManager`
 * field first (Corepack's declaration), then the lockfile, then `bun` for a
 * bun project, else `npm`.
 *
 * @internal
 */
function detectPackageManager(
  projectRoot: string,
  declared: string | undefined,
  primaryType: ProjectType,
): PackageManager {
  const detected = ((): PackageManager => {
    const name = declared?.split('@')[0];
    if (name === 'pnpm' || name === 'yarn' || name === 'bun' || name === 'npm') return name;
    const has = (f: string): boolean => existsSync(join(projectRoot, f));
    if (has('pnpm-lock.yaml')) return 'pnpm';
    if (has('yarn.lock')) return 'yarn';
    if (has('bun.lock') || has('bun.lockb')) return 'bun';
    if (has('package-lock.json')) return 'npm';
    return primaryType === 'bun' ? 'bun' : 'npm';
  })();
  // A declared manager that is not installed would fail with ENOENT and read
  // as a missing tool. `npm run` executes the same script, hooks included.
  return detected === 'npm' || isOnPath(detected) ? detected : 'npm';
}

/**
 * Is `bin` an executable on `PATH`? A plain directory scan — no subprocess.
 *
 * @internal
 */
function isOnPath(bin: string): boolean {
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    if (exts.some((ext) => existsSync(join(dir, `${bin}${ext}`)))) return true;
  }
  return false;
}

/**
 * Resolve a canonical tool to the project's own `package.json` script of that
 * name, run through its package manager (T12633).
 *
 * Running the script — rather than CLEO's guess at the underlying binary —
 * means the project's definition is what gets checked. In this repository the
 * guess was `npx tsc --noEmit` against a references-only root tsconfig, which
 * checks nothing, while the `typecheck` script is `tsc -b` behind a
 * `pretypecheck` step. Going through the package manager runs those hooks.
 *
 * @internal
 */
function resolvePackageScript(
  canonical: CanonicalTool,
  projectRoot: string,
  primaryType: ProjectType,
): CommandShape | null {
  if (!PACKAGE_SCRIPT_TOOLS.has(canonical) || !PACKAGE_SCRIPT_TYPES.has(primaryType)) return null;
  let pkg: { scripts?: Record<string, unknown>; packageManager?: unknown };
  try {
    pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf-8')) as typeof pkg;
  } catch {
    return null;
  }
  const script = pkg.scripts?.[canonical];
  if (typeof script !== 'string' || script.trim() === '') return null;
  const declared = typeof pkg.packageManager === 'string' ? pkg.packageManager : undefined;
  return {
    cmd: detectPackageManager(projectRoot, declared, primaryType),
    args: ['run', canonical],
  };
}

/**
 * Adapt the node `typecheck` default to the project's tsconfig (T12633).
 *
 * A references-only root config (`"files": []` plus `references`) selects no
 * files outside build mode, so `tsc --noEmit` there is a no-op that exits 0.
 * Build mode checks every referenced project.
 *
 * Plain `tsc -b`, which EMITS, and never `tsc -b --noEmit`: with a chain of
 * composite projects (b references a) the latter fails TS6310 "Referenced
 * project may not disable emit" on correct code (reproduced on TypeScript
 * 5.9.3 and 6.0.2) — a red that no source change can clear. The emitted
 * `dist/` and `.tsbuildinfo` files do not move the evidence cache key unless
 * they are tracked: the dirty-tree fingerprint is `git diff HEAD`, which
 * ignores untracked files.
 *
 * @internal
 */
function adaptTypecheckDefault(def: CommandShape, tsconfigRoot: string): CommandShape {
  if (!isReferencesOnlyTsconfig(join(tsconfigRoot, 'tsconfig.json'))) return def;
  return { cmd: def.cmd, args: ['tsc', '-b'] };
}

interface ResolveOptions {
  /**
   * Override for `primaryType` lookup — set in tests where no real
   * `project-context.json` is present.
   */
  primaryTypeOverride?: ProjectType;
  /**
   * The tree the resolved command will RUN in, when it differs from the
   * store root that holds `.cleo/project-context.json` (a worktree). The
   * project's `package.json` scripts and `tsconfig.json` are read from here,
   * because they describe the code under test. Defaults to `projectRoot`.
   *
   * @task T12633
   */
  executionRoot?: string;
}

/**
 * Resolve a `tool:<name>` evidence atom to a runnable command.
 *
 * Resolution order:
 *
 *   1. Map alias → canonical (e.g. `pnpm-test` → `test`).
 *   2. Check `.cleo/project-context.json` via {@link PROJECT_CONTEXT_KEY_MAP}:
 *      - `test` → `testing.command`
 *      - `build` → `build.command`
 *      - `lint` → `lint.command`
 *      - `typecheck` → `typecheck.command`
 *      - `audit` → `audit.command`
 *      - `security-scan` → `security-scan.command`
 *   3. Read `primaryType` from `project-context.json` (or detect from cwd).
 *   4. For node/bun projects, a `package.json` script of the canonical name
 *      (`test`, `build`, `lint`, `typecheck`) runs as `<pm> run <name>`
 *      (T12633).
 *   5. Look up the canonical name in `LANGUAGE_DEFAULTS[primaryType]`. The
 *      node `typecheck` default switches to build mode (`tsc -b`) for a
 *      references-only root tsconfig (T12633).
 *   6. Verify the resolved binary exists on `PATH` (best-effort, non-fatal —
 *      missing binaries are reported but do not block resolution; the
 *      validator will surface the spawn error if the binary is truly absent).
 *
 * @param toolName - The user-supplied tool name (canonical or alias).
 * @param projectRoot - Absolute path to project root.
 * @param opts - Options for testing.
 * @returns Resolved command or a structured error.
 *
 * @example
 * ```ts
 * const r = resolveToolCommand('pnpm-test', '/repo');
 * if (r.ok) {
 *   // r.command.canonical === 'test'
 *   // r.command.cmd === 'pnpm', r.command.args === ['run', 'test']
 *   // r.command.source === 'project-context'
 * }
 * ```
 *
 * @task T1534
 */
export function resolveToolCommand(
  toolName: string,
  projectRoot: string,
  opts: ResolveOptions = {},
): ResolveToolResult {
  // Step 1 — alias → canonical
  const canonical: CanonicalTool | null = (CANONICAL_TOOLS as readonly string[]).includes(toolName)
    ? (toolName as CanonicalTool)
    : (LEGACY_TOOL_ALIASES[toolName] ?? null);

  if (!canonical) {
    return {
      ok: false,
      reason:
        `Unknown tool: "${toolName}". Valid canonical tools: ` +
        `${CANONICAL_TOOLS.join(', ')}. ` +
        `Legacy aliases: ${Object.keys(LEGACY_TOOL_ALIASES).slice(0, 8).join(', ')}, …`,
      codeName: 'E_TOOL_UNKNOWN',
    };
  }

  const isAlias = canonical !== toolName;

  // Step 2 — project-context overrides
  const ctx = loadProjectContext(projectRoot).context;

  const pcKey = PROJECT_CONTEXT_KEY_MAP[canonical];
  if (pcKey) {
    const cmd = readNestedString(ctx, pcKey);
    let parsed: CommandShape | null = null;
    if (cmd) {
      try {
        parsed = parseCommandString(cmd, pcKey.join('.'));
      } catch (error) {
        // T12718: a declared command that cannot run as written is a config
        // error — never a silent fallback and never a truncated argv.
        return {
          ok: false,
          reason: `${error instanceof Error ? error.message : String(error)} (.cleo/project-context.json)`,
          codeName: 'E_TOOL_COMMAND_INVALID',
          rawCommand: cmd,
        };
      }
    }
    if (parsed) {
      return {
        ok: true,
        command: {
          canonical,
          displayName: toolName,
          cmd: parsed.cmd,
          args: parsed.args,
          source: isAlias ? 'legacy-alias' : 'project-context',
        },
      };
    }
  }

  // Step 3 — primaryType lookup
  const primaryType: ProjectType =
    opts.primaryTypeOverride ??
    (readNestedString(ctx, ['primaryType']) as ProjectType | undefined) ??
    detectPrimaryTypeFromCwd(projectRoot);

  // Step 4 — the project's own package.json script (T12633)
  const codeRoot = opts.executionRoot ?? projectRoot;
  const script = resolvePackageScript(canonical, codeRoot, primaryType);
  if (script) {
    return {
      ok: true,
      command: {
        canonical,
        displayName: toolName,
        cmd: script.cmd,
        args: script.args,
        source: isAlias ? 'legacy-alias' : 'package-script',
        primaryType,
      },
    };
  }

  // Step 5 — language default
  const defaults = LANGUAGE_DEFAULTS[primaryType] ?? {};
  const baseDef = defaults[canonical];
  const def =
    baseDef && primaryType === 'node' && canonical === 'typecheck'
      ? adaptTypecheckDefault(baseDef, codeRoot)
      : baseDef;

  if (!def) {
    return {
      ok: false,
      reason:
        `Tool "${toolName}" has no resolved command for primaryType="${primaryType}". ` +
        `Add an explicit command to .cleo/project-context.json (testing.command / build.command / lint.command / typecheck.command / audit.command / security-scan.command) ` +
        `or extend LANGUAGE_DEFAULTS in @cleocode/core/tasks/tool-resolver.ts.`,
      codeName: 'E_TOOL_UNAVAILABLE',
    };
  }

  // T12083: a language default is a guess about the project. Only run it when
  // the project shows evidence of that toolchain — otherwise the gate demands
  // a tool the project has no reason to own.
  if (!isToolApplicable(canonical, projectRoot, primaryType)) {
    return {
      ok: false,
      reason:
        `Tool "${toolName}" is not applicable to this project: no ${canonical} toolchain ` +
        `was detected (no config file, no "${canonical}" script in package.json, and no ` +
        `matching dependency). The default for primaryType="${primaryType}" would have run ` +
        `\`${def.cmd} ${def.args.join(' ')}\`, which cannot succeed here. Add ` +
        `${canonical}.command to .cleo/project-context.json to declare one explicitly.`,
      codeName: 'E_TOOL_NOT_APPLICABLE',
    };
  }

  return {
    ok: true,
    command: {
      canonical,
      displayName: toolName,
      cmd: def.cmd,
      args: [...def.args],
      source: 'language-default',
      primaryType,
    },
  };
}

/**
 * Best-effort detection of `primaryType` from the project root for callers
 * that did not provide one via `project-context.json`. Mirrors a subset of
 * `detectProjectType()` without taking a heavyweight dependency on the full
 * detector — only the marker files needed to disambiguate are checked.
 *
 * @internal
 */
function detectPrimaryTypeFromCwd(projectRoot: string): ProjectType {
  const has = (f: string): boolean => existsSync(join(projectRoot, f));
  if (has('package.json')) return 'node';
  if (has('Cargo.toml')) return 'rust';
  if (has('pyproject.toml') || has('setup.py') || has('requirements.txt')) return 'python';
  if (has('go.mod')) return 'go';
  if (has('Gemfile')) return 'ruby';
  if (has('pom.xml') || has('build.gradle') || has('build.gradle.kts')) return 'java';
  if (has('deno.json') || has('deno.jsonc')) return 'deno';
  if (has('mix.exs')) return 'elixir';
  if (has('composer.json')) return 'php';
  return 'unknown';
}

/**
 * Type-safe lookup into a parsed JSON object (`Record<string, unknown>`)
 * by a dot-path. Returns `null` when any segment is missing or non-object,
 * or the leaf is not a string.
 *
 * @internal
 */
function readNestedString(ctx: Record<string, unknown> | null, path: string[]): string | null {
  if (!ctx) return null;
  let cursor: unknown = ctx;
  for (const segment of path) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return null;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return typeof cursor === 'string' && cursor.length > 0 ? cursor : null;
}

/**
 * Load project-context.json *without* relying on `loadProjectContext`'s
 * imports (escape-hatch for tests that need to inspect raw context).
 *
 * @internal
 */
export function readRawProjectContext(projectRoot: string): Record<string, unknown> | null {
  const path = join(projectRoot, '.cleo', 'project-context.json');
  if (!existsSync(path)) return null;
  try {
    return parseRawProjectContext(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Parse the text of a project-context.json — from disk, or from a git
 * revision (`git show <rev>:…`, T13135) — into its raw object.
 *
 * @param raw - The file's text.
 * @returns The object, or `null` when it is not a JSON object.
 */
export function parseRawProjectContext(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
