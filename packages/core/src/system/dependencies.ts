/**
 * Central dependency registry for CLEO runtime dependency verification.
 *
 * This is the SSoT for all external dependency checks. Every CLEO subsystem
 * that needs to gate a feature on tool availability MUST use functions from
 * this module rather than implementing ad-hoc `which` / `commandExists` calls.
 *
 * Relationship to other modules:
 *   - `platform.ts` — provides `commandExists()` and `PLATFORM` utilities.
 *   - `health.ts` — calls `checkAllDependencies()` inside `coreDoctorReport()`.
 *   - `code/parser.ts` — `isTreeSitterAvailable()` is delegated here for the
 *     `tree-sitter` dependency check.
 *
 * @task T507
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  DependencyCategory,
  DependencyCheckResult,
  DependencyReport,
  DependencySpec,
} from '@cleocode/contracts';
import { PLATFORM } from '../platform.js';

/** ESM-safe require function for loading native addons. */
const _require = createRequire(import.meta.url);
/** Directory of this compiled file (packages/core/dist/system/). */
const _dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Run a command and return its stdout trimmed, or `null` on failure.
 *
 * @param cmd - Executable name or path.
 * @param args - Arguments to pass.
 * @param timeoutMs - Max execution time in milliseconds (default: 3000).
 */
function tryExec(cmd: string, args: string[], timeoutMs = 3000): string | null {
  try {
    return execFileSync(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

/**
 * Resolve the absolute path of a command on PATH, or `null` if absent.
 *
 * Uses `which` on POSIX and `where` on Windows, matching `commandExists()`
 * in `platform.ts`.
 */
function which(cmd: string): string | null {
  const tool = PLATFORM === 'windows' ? 'where' : 'which';
  return tryExec(tool, [cmd]);
}

/**
 * Parse a semver-style major version from an arbitrary version string.
 * Returns the numeric major version, or `null` if unparseable.
 *
 * @param raw - Raw version string (e.g. "git version 2.43.0", "v24.1.0").
 */
function parseMajorVersion(raw: string): number | null {
  // Match first sequence of digits (possibly preceded by "v")
  const match = /\bv?(\d+)/.exec(raw);
  if (!match) return null;
  const major = Number(match[1]);
  return Number.isNaN(major) ? null : major;
}

// ============================================================================
// Dependency registry — static specifications
// ============================================================================

/** All known CLEO dependencies, ordered: required first, then optional/feature. */
const DEPENDENCY_SPECS: DependencySpec[] = [
  // ── Required ────────────────────────────────────────────────────────────
  {
    name: 'node',
    category: 'required',
    description: 'Node.js runtime — the execution environment for all CLEO operations.',
    versionConstraint: '>=24.0.0',
    documentationUrl: 'https://nodejs.org/en/download/',
    installCommand: 'curl -fsSL https://fnm.vercel.app/install | bash && fnm install 24',
  },
  {
    name: 'git',
    category: 'required',
    description:
      'Git version control — required for cleo checkpoint, cleo init, and hook management.',
    documentationUrl: 'https://git-scm.com/downloads',
    installCommand: 'apt install git  # or: brew install git',
  },

  // ── Optional (feature-gating) ────────────────────────────────────────────
  {
    name: 'tree-sitter',
    category: 'optional',
    description:
      'Tree-sitter native Node module — enables cleo code outline, cleo code search, and AST analysis. Bundled as a regular dependency; re-run pnpm install if missing.',
    documentationUrl: 'https://tree-sitter.github.io/tree-sitter/',
    installCommand: 'pnpm install',
  },
  {
    name: 'gh',
    category: 'optional',
    description: 'GitHub CLI — enables cleo issue, cleo release, and GitHub-integrated workflows.',
    documentationUrl: 'https://cli.github.com/',
    installCommand: 'brew install gh  # or: apt install gh',
  },
  {
    name: 'unzip',
    category: 'optional',
    description:
      'unzip — required for cleo agent archive import (extracting .cleo-export bundles).',
    documentationUrl: 'https://infozip.sourceforge.net/',
    installCommand: 'apt install unzip  # or: brew install unzip',
    platforms: ['linux', 'darwin'],
  },
  {
    name: 'zip',
    category: 'optional',
    description: 'zip — required for cleo agent archive export (creating .cleo-export bundles).',
    documentationUrl: 'https://infozip.sourceforge.net/',
    installCommand: 'apt install zip  # or: brew install zip',
    platforms: ['linux', 'darwin'],
  },

  // ── Feature (native addons — internally managed) ─────────────────────────
  {
    name: 'cant-napi',
    category: 'feature',
    description:
      'Native CANT parser (Rust/napi-rs) — accelerates CANT DSL parsing. Falls back to TS implementation when absent.',
    documentationUrl: 'https://github.com/kryptobaseddev/cleocode',
    installCommand: 'cargo build --release -p cant-napi',
  },
  {
    name: 'lafs-napi',
    category: 'feature',
    description:
      'Native LAFS validator (Rust/napi-rs) — accelerates envelope validation. Falls back to AJV when absent.',
    documentationUrl: 'https://github.com/kryptobaseddev/cleocode',
    installCommand: 'cargo build --release -p lafs-napi',
  },
];

// ============================================================================
// Individual dependency check functions
// ============================================================================

/**
 * Check Node.js availability and version constraint (>=24.0.0).
 *
 * Node is always present when CLEO runs — this check validates the VERSION
 * meets the minimum requirement, not merely that Node exists.
 */
function checkNode(): DependencyCheckResult {
  const raw = process.version; // e.g. "v24.1.0"
  const version = raw.replace(/^v/, '');
  const major = parseMajorVersion(raw) ?? 0;
  const healthy = major >= 24;

  return {
    name: 'node',
    category: 'required',
    installed: true,
    version,
    location: process.execPath,
    healthy,
    ...(healthy
      ? {}
      : {
          error: `Node.js ${version} does not meet the minimum requirement of >=24.0.0`,
          suggestedFix:
            'Upgrade Node.js: curl -fsSL https://fnm.vercel.app/install | bash && fnm install 24',
        }),
  };
}

/**
 * Check git availability.
 *
 * Runs `git --version` to detect the installed version string.
 */
function checkGit(): DependencyCheckResult {
  const location = which('git');

  if (!location) {
    return {
      name: 'git',
      category: 'required',
      installed: false,
      healthy: false,
      error: 'git not found on PATH',
      suggestedFix: 'Install git: https://git-scm.com/downloads',
    };
  }

  const raw = tryExec('git', ['--version']) ?? '';
  // "git version 2.43.0" -> "2.43.0"
  const version = raw.replace(/^git version\s*/i, '').split(/\s/)[0] ?? raw;

  return {
    name: 'git',
    category: 'required',
    installed: true,
    version: version || undefined,
    location: location.split('\n')[0] ?? location, // `where` may return multiple lines on Windows
    healthy: true,
  };
}

/**
 * Check tree-sitter native Node module availability.
 *
 * Delegates to `isTreeSitterAvailable()` from `packages/core/src/code/parser.ts`
 * which probes whether the `tree-sitter` native module loads successfully.
 * No CLI binary on PATH is required — the module ships as a bundled dependency.
 */
async function checkTreeSitter(): Promise<DependencyCheckResult> {
  // Lazy import to avoid circular dependency and to keep this module lightweight
  const { isTreeSitterAvailable } = await import('../code/parser.js');
  const available = isTreeSitterAvailable();

  // Read the installed package version from its package.json if available
  let version: string | undefined;
  if (available) {
    try {
      const pkgJson = _require('tree-sitter/package.json') as { version?: string };
      version = pkgJson.version;
    } catch {
      version = undefined;
    }
  }

  return {
    name: 'tree-sitter',
    category: 'optional',
    installed: available,
    version,
    location: available ? 'node_modules/tree-sitter (native binding)' : undefined,
    // Optional: missing is healthy (feature simply disabled)
    healthy: true,
    ...(available
      ? {}
      : {
          error:
            'tree-sitter native module not loaded — cleo code outline/search/unfold features are disabled',
          suggestedFix: 'pnpm install',
        }),
  };
}

/**
 * Check GitHub CLI (`gh`) availability.
 */
function checkGh(): DependencyCheckResult {
  const location = which('gh');

  if (!location) {
    return {
      name: 'gh',
      category: 'optional',
      installed: false,
      healthy: true, // optional — absence is acceptable
      error: 'gh not found — cleo issue and cleo release features are disabled',
      suggestedFix: 'Install GitHub CLI: https://cli.github.com/',
    };
  }

  const versionRaw = tryExec('gh', ['--version']) ?? '';
  // "gh version 2.40.1 (2024-01-15)" -> "2.40.1"
  const versionMatch = /\bgh version\s+(\S+)/.exec(versionRaw);
  const version = versionMatch?.[1] ?? undefined;

  return {
    name: 'gh',
    category: 'optional',
    installed: true,
    version,
    location: location.split('\n')[0] ?? location,
    healthy: true,
  };
}

/**
 * Check availability of a simple CLI tool (unzip, zip, etc.).
 *
 * @param name - Tool name as it appears on PATH.
 * @param category - Dependency category for the spec.
 * @param errorMsg - Human-readable description of what is disabled when absent.
 * @param fixHint - Install hint to show the user.
 */
function checkSimpleTool(
  name: string,
  category: DependencyCategory,
  errorMsg: string,
  fixHint: string,
): DependencyCheckResult {
  const location = which(name);

  if (!location) {
    return {
      name,
      category,
      installed: false,
      healthy: true, // optional — absence is acceptable
      error: errorMsg,
      suggestedFix: fixHint,
    };
  }

  return {
    name,
    category,
    installed: true,
    location: location.split('\n')[0] ?? location,
    healthy: true,
  };
}

/**
 * Check cant-napi native addon availability.
 *
 * Probes the native binary directly using the same path resolution that
 * `packages/cant/src/native-loader.ts` uses, without importing the cant
 * package (which would create a circular dep: core → cant → core).
 *
 * The resolution order mirrors the cant native-loader:
 *   1. `packages/cant/napi/cant.linux-x64-gnu.node` (installed binary)
 *   2. `crates/cant-napi/index.cjs` (dev build output)
 */
function checkCantNapi(): DependencyCheckResult {
  let available = false;

  try {
    // From packages/core/dist/system/ the relative path to the cant binary:
    // ../../../cant/napi/cant.linux-x64-gnu.node
    const binary = _require.resolve('../../../cant/napi/cant.linux-x64-gnu.node', {
      paths: [_dirname],
    });
    _require(binary);
    available = true;
  } catch {
    try {
      const fallback = _require.resolve('../../../../crates/cant-napi/index.cjs', {
        paths: [_dirname],
      });
      _require(fallback);
      available = true;
    } catch {
      available = false;
    }
  }

  return {
    name: 'cant-napi',
    category: 'feature',
    installed: available,
    healthy: true, // feature: TypeScript fallback is always present
    ...(available
      ? {}
      : {
          error: 'cant-napi native addon not loaded — using TypeScript CANT parser (slower)',
          suggestedFix: 'cargo build --release -p cant-napi',
        }),
  };
}

/**
 * Check lafs-napi native addon availability.
 *
 * Attempts to load the native module via `createRequire` using the same
 * resolution strategy as `packages/lafs/src/native-loader.ts`, without
 * importing the lafs package as a module (the `./native-loader` subpath is
 * not exported in the lafs `package.json` exports map).
 *
 * The resolution order mirrors the lafs native-loader:
 *   1. `@cleocode/lafs-native` npm package
 *   2. `crates/lafs-napi/index.cjs` (dev build output)
 */
function checkLafsNapi(): DependencyCheckResult {
  let available = false;

  try {
    _require.resolve('@cleocode/lafs-native', { paths: [_dirname] });
    _require('@cleocode/lafs-native');
    available = true;
  } catch {
    try {
      const fallback = _require.resolve('../../../../crates/lafs-napi/index.cjs', {
        paths: [_dirname],
      });
      _require(fallback);
      available = true;
    } catch {
      available = false;
    }
  }

  return {
    name: 'lafs-napi',
    category: 'feature',
    installed: available,
    healthy: true, // feature: AJV fallback is always present
    ...(available
      ? {}
      : {
          error: 'lafs-napi native addon not loaded — using AJV validator (slower)',
          suggestedFix: 'cargo build --release -p lafs-napi',
        }),
  };
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Return all registered dependency specifications.
 *
 * Useful for generating documentation, help text, or install guides without
 * running any system checks.
 *
 * @returns Immutable array of {@link DependencySpec} objects.
 */
export function getDependencySpecs(): DependencySpec[] {
  return DEPENDENCY_SPECS;
}

/**
 * Check a single dependency by name and return its runtime result.
 *
 * @param name - Canonical dependency identifier (must match a registered spec).
 * @returns The check result, or an error result if the name is unknown.
 */
export async function checkDependency(name: string): Promise<DependencyCheckResult> {
  switch (name) {
    case 'node':
      return Promise.resolve(checkNode());
    case 'git':
      return Promise.resolve(checkGit());
    case 'tree-sitter':
      return checkTreeSitter();
    case 'gh':
      return Promise.resolve(checkGh());
    case 'unzip':
      return Promise.resolve(
        checkSimpleTool(
          'unzip',
          'optional',
          'unzip not found — cleo agent archive import is disabled',
          'apt install unzip  # or: brew install unzip',
        ),
      );
    case 'zip':
      return Promise.resolve(
        checkSimpleTool(
          'zip',
          'optional',
          'zip not found — cleo agent archive export is disabled',
          'apt install zip  # or: brew install zip',
        ),
      );
    case 'cant-napi':
      return Promise.resolve(checkCantNapi());
    case 'lafs-napi':
      return Promise.resolve(checkLafsNapi());
    default:
      return Promise.resolve({
        name,
        category: 'optional',
        installed: false,
        healthy: false,
        error: `Unknown dependency: "${name}" — not registered in the CLEO dependency registry`,
      });
  }
}

/**
 * Check all registered CLEO dependencies and return a consolidated report.
 *
 * Skips platform-specific dependencies that do not apply to the current OS.
 * For example, `unzip` and `zip` are only checked on Linux and macOS.
 *
 * @returns A {@link DependencyReport} with results for every applicable dependency.
 */
export async function checkAllDependencies(): Promise<DependencyReport> {
  const timestamp = new Date().toISOString();
  const platform = process.platform;
  const nodeVersion = process.version.replace(/^v/, '');

  const applicableSpecs = DEPENDENCY_SPECS.filter((spec) => {
    if (!spec.platforms) return true;
    return spec.platforms.includes(platform as 'linux' | 'darwin' | 'win32');
  });

  const results = await Promise.all(applicableSpecs.map((spec) => checkDependency(spec.name)));

  const requiredResults = results.filter((r) => r.category === 'required');
  const allRequiredMet = requiredResults.every((r) => r.healthy);

  const warnings: string[] = [];
  for (const result of results) {
    if (!result.installed && result.error) {
      warnings.push(result.error);
    }
  }

  return {
    timestamp,
    platform,
    nodeVersion,
    results,
    allRequiredMet,
    warnings,
  };
}

// Re-export types for convenience of callers within core/
export type { DependencyCategory, DependencyCheckResult, DependencyReport, DependencySpec };
