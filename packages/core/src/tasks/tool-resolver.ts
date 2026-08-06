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
 *   3. Falls back to per-`primaryType` defaults (node, python, rust, go, …)
 *      when project-context.json is missing or does not specify the tool.
 *   4. Honours legacy aliases (`pnpm-test`, `tsc`, `biome`, …) for backwards
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
import { join } from 'node:path';

import { loadProjectContext } from '../agents/variable-substitution.js';
import type { ProjectType } from '../store/project-detect.js';

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
      codeName: 'E_TOOL_UNKNOWN' | 'E_TOOL_UNAVAILABLE' | 'E_TOOL_NOT_APPLICABLE';
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
 * Set of all valid `tool:<name>` payloads — canonical names plus legacy
 * aliases. Returned by {@link listValidToolNames} for help / validation
 * surfaces.
 *
 * @task T1534
 */
export function listValidToolNames(): string[] {
  return [...new Set([...CANONICAL_TOOLS, ...Object.keys(LEGACY_TOOL_ALIASES)])].sort();
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
 * Splits on whitespace. Quoted segments are NOT honoured — project commands
 * are expected to be simple. Callers needing rich shell forms must use the
 * fallback (per-language defaults) and edit `project-context.json` to a
 * single-token command.
 *
 * @internal
 */
function parseCommandString(raw: string): CommandShape | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/\s+/);
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

interface ResolveOptions {
  /**
   * Override for `primaryType` lookup — set in tests where no real
   * `project-context.json` is present.
   */
  primaryTypeOverride?: ProjectType;
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
 *   4. Look up the canonical name in `LANGUAGE_DEFAULTS[primaryType]`.
 *   5. Verify the resolved binary exists on `PATH` (best-effort, non-fatal —
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
    const parsed = cmd ? parseCommandString(cmd) : null;
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

  // Step 4 — language default
  const defaults = LANGUAGE_DEFAULTS[primaryType] ?? {};
  const def = defaults[canonical];

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
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
