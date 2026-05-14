/**
 * Version bump - config-driven version bumping across project files.
 *
 * Reads release.versionBump from .cleo/config.json and updates all
 * configured files with the new version. Supports strategies:
 *   plain - Overwrite entire file (e.g., VERSION)
 *   json  - Update a JSON field (e.g., package.json .version)
 *   toml  - Update a TOML key (e.g., Cargo.toml)
 *   sed   - Custom regex substitution
 *
 * @task T4454
 * @epic T4454
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  type BumpResult,
  type BumpType,
  type BumpVersionFromConfigResult,
  type EcosystemHint,
  ExitCode,
  type ProjectContext,
  type ProjectType,
  type ResolveVersionBumpTargetsResult,
  type VersionBumpStrategy,
  type VersionBumpTarget,
  type VersionBumpTargetSource,
} from '@cleocode/contracts';
import { loadProjectContext } from '../agents/variable-substitution.js';
import { CleoError } from '../errors.js';
import { getCleoDir, getProjectRoot } from '../paths.js';

// Re-export contract types so existing consumers that import from this module
// (e.g. `import { VersionBumpTarget } from '@cleocode/core/internal'`) keep
// working. New code SHOULD import directly from `@cleocode/contracts`.
export type {
  BumpResult,
  BumpType,
  BumpVersionFromConfigResult,
  EcosystemHint,
  ProjectContext,
  ProjectType,
  ResolveVersionBumpTargetsResult,
  VersionBumpStrategy,
  VersionBumpTarget,
  VersionBumpTargetSource,
};

/** Synchronous config value reader for version bump targets. */
function readConfigValueSync(path: string, defaultValue: unknown, cwd?: string): unknown {
  try {
    const configPath = join(getCleoDir(cwd), 'config.json');
    if (!existsSync(configPath)) return defaultValue;
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    const keys = path.split('.');
    let value: unknown = config;
    for (const key of keys) {
      if (value == null || typeof value !== 'object') return defaultValue;
      value = (value as Record<string, unknown>)[key];
    }
    return value ?? defaultValue;
  } catch {
    return defaultValue;
  }
}

/** Three-part version regex (X.Y.Z) - matches both semver and CalVer base format. */
const THREE_PART_VERSION_REGEX = /^\d+\.\d+\.\d+$/;

/** CalVer regex (YYYY.M.patch or YYYY.MM.patch, with optional pre-release suffix). */
const CALVER_REGEX = /^\d{4}\.\d{1,2}\.\d+$/;

/** Version with optional pre-release suffix (e.g., 2026.2.0-rc.1). */
const VERSION_WITH_PRERELEASE = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/;

/** Validate version format (semver X.Y.Z or CalVer YYYY.M.patch, with optional pre-release). */
export function validateVersionFormat(version: string): boolean {
  return VERSION_WITH_PRERELEASE.test(version);
}

/** Check if a version string is CalVer format. */
export function isCalVer(version: string): boolean {
  const base = version.replace(/-.*$/, '');
  return CALVER_REGEX.test(base) && parseInt(base.split('.')[0]!, 10) >= 2000;
}

/** Calculate new version from current + bump type. */
export function calculateNewVersion(current: string, bump: BumpType | string): string {
  // If bump is already a version, validate and return
  if (VERSION_WITH_PRERELEASE.test(bump)) return bump;

  // Strip pre-release suffix for base version parsing
  const base = current.replace(/-.*$/, '');

  if (!THREE_PART_VERSION_REGEX.test(base) && !CALVER_REGEX.test(base)) {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `Invalid current version: '${current}' (expected X.Y.Z or YYYY.M.patch)`,
    );
  }

  const parts = base.split('.').map(Number) as [number, number, number];

  if (isCalVer(current)) {
    // CalVer: YYYY.MM.patch
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;

    switch (bump) {
      case 'patch':
        // Same year+month: increment patch. Different: reset to 0.
        if (parts[0] === year && parts[1] === month) {
          parts[2]++;
        } else {
          return `${year}.${month}.0`;
        }
        break;
      case 'minor':
      case 'major':
        // CalVer doesn't have minor/major — just roll to current date
        return `${year}.${month}.0`;
      default:
        throw new CleoError(
          ExitCode.VALIDATION_ERROR,
          `Invalid bump type: '${bump}'. Expected: patch, minor, major, or a version string`,
        );
    }
  } else {
    // Semver: X.Y.Z
    switch (bump) {
      case 'patch':
        parts[2]++;
        break;
      case 'minor':
        parts[1]++;
        parts[2] = 0;
        break;
      case 'major':
        parts[0]++;
        parts[1] = 0;
        parts[2] = 0;
        break;
      default:
        throw new CleoError(
          ExitCode.VALIDATION_ERROR,
          `Invalid bump type: '${bump}'. Expected: patch, minor, major, or X.Y.Z`,
        );
    }
  }

  return parts.join('.');
}

/** Raw config entry shape from .cleo/config.json (uses path/jsonPath/sedPattern). */
interface RawVersionBumpEntry {
  path?: string;
  file?: string;
  strategy: VersionBumpStrategy;
  jsonPath?: string;
  field?: string;
  key?: string;
  tomlKey?: string;
  section?: string;
  tomlSection?: string;
  sedPattern?: string;
  pattern?: string;
  optional?: boolean;
  description?: string;
}

/** Get version bump configuration, mapping config field names to VersionBumpTarget. */
export function getVersionBumpConfig(cwd?: string): VersionBumpTarget[] {
  try {
    const raw = readConfigValueSync('release.versionBump.files', [], cwd) as RawVersionBumpEntry[];
    return raw
      .map((entry) => ({
        file: entry.path ?? entry.file ?? '',
        strategy: entry.strategy,
        field: entry.jsonPath?.replace(/^\./, '') ?? entry.field,
        // Schema canonicalises on `tomlKey` / `tomlSection`; legacy in-code
        // entries used bare `key` / `section`. Accept both.
        key: entry.tomlKey ?? entry.key,
        section: entry.tomlSection ?? entry.section,
        pattern: entry.sedPattern ?? entry.pattern,
      }))
      .filter((t) => t.file !== '');
  } catch {
    return [];
  }
}

/** Check if version bump is configured. */
export function isVersionBumpConfigured(cwd?: string): boolean {
  return getVersionBumpConfig(cwd).length > 0;
}

/**
 * Resolve the project root for filesystem operations, falling back to `cwd`
 * (or `process.cwd()`) when {@link getProjectRoot} rejects the path. Discovery
 * and bumping run against arbitrary monorepos — they MUST work outside a
 * CLEO-initialised project (tests, fresh clones, downstream tooling).
 */
function resolveProjectRootLoose(cwd?: string): string {
  try {
    return getProjectRoot(cwd);
  } catch {
    return cwd ?? process.cwd();
  }
}

/**
 * Read ecosystem hints from `.cleo/project-context.json` via the canonical
 * {@link loadProjectContext} loader. Returns the narrow subset of
 * {@link ProjectContext} that this module cares about, or `{}` when no
 * context is available (which lets callers fall back to filesystem probing).
 *
 * Reuses the existing loader rather than re-implementing JSON parsing so
 * we stay aligned with the rest of the codebase (variable substitution,
 * agent spawn, codebase-map analyzers) and inherit any future hardening.
 */
function readEcosystemHint(projectRoot: string): EcosystemHint {
  const loaded = loadProjectContext(projectRoot);
  if (!loaded.loaded || !loaded.context) return {};
  const ctx = loaded.context as Partial<ProjectContext>;
  return {
    primaryType: ctx.primaryType,
    projectTypes: Array.isArray(ctx.projectTypes) ? ctx.projectTypes : undefined,
    monorepo: typeof ctx.monorepo === 'boolean' ? ctx.monorepo : undefined,
  };
}

/**
 * Discover Node/JS package.json files in a pnpm/yarn/npm workspace.
 *
 * Detection signals (any one is sufficient):
 *   - `pnpm-workspace.yaml` at the project root
 *   - A `workspaces` field in the root `package.json`
 *   - A `packages/` directory containing one or more package.json files
 *
 * Returns `[]` when no workspace is detected.
 */
function discoverNodeWorkspaceTargets(projectRoot: string): VersionBumpTarget[] {
  const rootPkgPath = join(projectRoot, 'package.json');
  if (!existsSync(rootPkgPath)) return [];

  const hasPnpmWorkspace = existsSync(join(projectRoot, 'pnpm-workspace.yaml'));
  let hasYarnNpmWorkspaces = false;
  try {
    const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf-8')) as { workspaces?: unknown };
    hasYarnNpmWorkspaces = rootPkg.workspaces != null;
  } catch {
    // Malformed root package.json — fall through
  }

  const packagesDir = join(projectRoot, 'packages');
  const hasPackagesDir = existsSync(packagesDir);

  if (!hasPnpmWorkspace && !hasYarnNpmWorkspaces && !hasPackagesDir) {
    return [];
  }

  const targets: VersionBumpTarget[] = [
    { file: 'package.json', strategy: 'json', field: 'version' },
  ];

  if (hasPackagesDir) {
    let entries: string[] = [];
    try {
      entries = readdirSync(packagesDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return targets;
    }
    for (const name of entries.sort()) {
      const pkgPath = join(packagesDir, name, 'package.json');
      if (!existsSync(pkgPath)) continue;
      targets.push({
        file: relative(projectRoot, pkgPath),
        strategy: 'json',
        field: 'version',
      });
    }
  }

  return targets;
}

/**
 * Test whether a Cargo.toml member crate inherits its version from the
 * workspace (`version.workspace = true`) rather than declaring its own.
 * Member crates that inherit are NOT bumpable directly — the source of truth
 * lives in the root `[workspace.package]` table.
 */
function cargoCrateInheritsVersion(cargoTomlPath: string): boolean {
  try {
    const content = readFileSync(cargoTomlPath, 'utf-8');
    return /^\s*version\.workspace\s*=\s*true\s*$/m.test(content);
  } catch {
    return false;
  }
}

/**
 * Test whether a Cargo.toml has a `[workspace.package] version = "X.Y.Z"`
 * line — the inheritance source for `version.workspace = true` member crates.
 *
 * Looks at the slice of the file from `[workspace.package]` up to either the
 * next `[…]` section header or end-of-file, and checks for a `version = "…"`
 * line inside it. (JavaScript regex has no `\Z` anchor, so end-of-input is
 * matched via a negative lookahead `(?![\s\S])`.)
 */
function cargoHasWorkspacePackageVersion(content: string): boolean {
  const sectionMatch = content.match(
    /^\s*\[workspace\.package\]\s*$([\s\S]*?)(?=^\s*\[|(?![\s\S]))/m,
  );
  if (!sectionMatch?.[1]) return false;
  return /^\s*version\s*=\s*"/m.test(sectionMatch[1]);
}

/**
 * Discover Rust Cargo.toml files in a `[workspace]` setup.
 *
 * Three patterns are handled:
 *
 *   1. **Workspace inheritance** (modern convention): root carries
 *      `[workspace.package] version = "X.Y.Z"` and members use
 *      `version.workspace = true`. Only the root is bumped — every member
 *      inherits automatically.
 *
 *   2. **Per-crate versions** (legacy): each member declares its own
 *      `version = "X.Y.Z"`. Every member is bumped individually.
 *
 *   3. **Root crate**: root Cargo.toml is itself a `[package]` (not just a
 *      `[workspace]`). The root's `[package] version` is bumped.
 *
 * Returns `[]` when there is no Cargo.toml or no `[workspace]` table. Crates
 * that inherit from the workspace are intentionally NOT listed as targets to
 * avoid the silent-no-op case where the bumper would match nothing and report
 * false success.
 */
function discoverRustWorkspaceTargets(projectRoot: string): VersionBumpTarget[] {
  const rootCargoPath = join(projectRoot, 'Cargo.toml');
  if (!existsSync(rootCargoPath)) return [];

  let cargoContent: string;
  try {
    cargoContent = readFileSync(rootCargoPath, 'utf-8');
  } catch {
    return [];
  }

  const hasWorkspaceTable = /^\s*\[workspace\]\s*$/m.test(cargoContent);
  if (!hasWorkspaceTable) return [];

  const targets: VersionBumpTarget[] = [];

  // Pattern 1: workspace-inheritance source (modern Cargo convention)
  if (cargoHasWorkspacePackageVersion(cargoContent)) {
    targets.push({
      file: 'Cargo.toml',
      strategy: 'toml',
      key: 'version',
      section: 'workspace.package',
    });
  }

  // Pattern 3: root is also a [package]
  const hasRootPackage = /^\s*\[package\]\s*$/m.test(cargoContent);
  const hasRootPackageVersion =
    hasRootPackage && /^\s*\[package\]\s*$([\s\S]*?)version\s*=\s*"/m.test(cargoContent);
  if (hasRootPackageVersion) {
    targets.push({
      file: 'Cargo.toml',
      strategy: 'toml',
      key: 'version',
      section: 'package',
    });
  }

  // Pattern 2: members with their own version (skip those that inherit)
  const membersMatch = cargoContent.match(/\[workspace\][\s\S]*?members\s*=\s*\[([\s\S]*?)\]/);
  if (membersMatch?.[1]) {
    const memberPaths = Array.from(membersMatch[1].matchAll(/"([^"]+)"/g)).map((m) => m[1]);
    for (const member of memberPaths.sort()) {
      if (!member || member.includes('*')) continue; // skip globs — needs deeper resolution
      const cargoPath = join(projectRoot, member, 'Cargo.toml');
      if (!existsSync(cargoPath)) continue;
      if (cargoCrateInheritsVersion(cargoPath)) continue; // inherits from workspace — root already covers it
      targets.push({
        file: relative(projectRoot, cargoPath),
        strategy: 'toml',
        key: 'version',
        section: 'package',
      });
    }
  }

  return targets;
}

/**
 * Auto-discover version-bump targets for the project's ecosystem(s).
 *
 * Reads `.cleo/project-context.json` via the canonical
 * {@link loadProjectContext} loader and uses the recorded
 * {@link ProjectContext.projectTypes} / {@link ProjectContext.primaryType}
 * to decide which discoverers to run. When the context is missing, falls
 * back to probing filesystem markers (`package.json`, `Cargo.toml`)
 * directly — same signals the canonical
 * {@link import('../store/project-detect.js').detectProjectType} uses.
 *
 * For a multi-language monorepo (e.g. `projectTypes: ["node", "rust"]`),
 * targets from each ecosystem are merged so a single release commit keeps
 * every workspace package in sync.
 *
 * Returns `[]` when no ecosystem is recognised — callers should treat that
 * as "no auto-bump possible" and either fall back to an explicit config or
 * skip bumping entirely.
 */
export function discoverWorkspacePackageJsonFiles(cwd?: string): VersionBumpTarget[] {
  const projectRoot = resolveProjectRootLoose(cwd);
  const hint = readEcosystemHint(projectRoot);

  // If the canonical detector recorded an explicit ecosystem set, honour it.
  // Without a project-context entry we probe the filesystem markers directly.
  const declaredTypes = new Set<ProjectType>([
    ...(hint.projectTypes ?? []),
    ...(hint.primaryType ? [hint.primaryType] : []),
  ]);

  // Node-family detection mirrors store/project-detect.ts (`node`, `bun`, `deno`
  // all yield JS package.json files). Keeping the family list here ensures we
  // stay in sync with the canonical detector without re-importing its internals.
  const NODE_FAMILY: ProjectType[] = ['node', 'bun', 'deno'];

  const probeNode = declaredTypes.size === 0 || NODE_FAMILY.some((t) => declaredTypes.has(t));
  const probeRust = declaredTypes.size === 0 || declaredTypes.has('rust');

  const out: VersionBumpTarget[] = [];
  if (probeNode) out.push(...discoverNodeWorkspaceTargets(projectRoot));
  if (probeRust) out.push(...discoverRustWorkspaceTargets(projectRoot));

  // De-duplicate by file path (preserves first occurrence).
  const seen = new Set<string>();
  return out.filter((t) => {
    if (seen.has(t.file)) return false;
    seen.add(t.file);
    return true;
  });
}

/**
 * Resolve version-bump targets with workspace auto-discovery fallback.
 *
 * Order of preference:
 *   1. Explicit `release.versionBump.files` from `.cleo/config.json` (most precise)
 *   2. Auto-discovered workspace targets when `release.versionBump.autoDiscover`
 *      is not explicitly disabled (default: enabled)
 *   3. Empty — caller decides whether to skip or error
 *
 * The `source` field on the returned envelope lets callers log *how* targets
 * were resolved, which matters when diagnosing why a release commit did or
 * did not include version files.
 */
export function resolveVersionBumpTargets(cwd?: string): ResolveVersionBumpTargetsResult {
  const configured = getVersionBumpConfig(cwd);
  if (configured.length > 0) {
    return { targets: configured, source: 'config' };
  }

  const autoDiscover = readConfigValueSync('release.versionBump.autoDiscover', true, cwd);
  if (autoDiscover === false) {
    return { targets: [], source: 'none' };
  }

  const discovered = discoverWorkspacePackageJsonFiles(cwd);
  if (discovered.length > 0) {
    return { targets: discovered, source: 'workspace' };
  }

  return { targets: [], source: 'none' };
}

/** Apply version bump to a single target file. */
function bumpFile(target: VersionBumpTarget, newVersion: string, projectRoot: string): BumpResult {
  const filePath = join(projectRoot, target.file);

  if (!existsSync(filePath)) {
    return {
      file: target.file,
      strategy: target.strategy,
      success: false,
      error: `File not found: ${target.file}`,
    };
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    let previousVersion: string | undefined;
    let newContent: string;

    switch (target.strategy) {
      case 'plain': {
        previousVersion = content.trim();
        newContent = newVersion + '\n';
        break;
      }

      case 'json': {
        const field = target.field ?? 'version';
        const json = JSON.parse(content);
        previousVersion = getNestedField(json, field) as string;
        setNestedField(json, field, newVersion);
        newContent = JSON.stringify(json, null, 2) + '\n';
        break;
      }

      case 'toml': {
        const key = target.key ?? 'version';
        // If a `section` is named (e.g. "workspace.package" or "package"),
        // bump the matching key WITHIN that section only — important for
        // Cargo.toml files where `[workspace.package] version` is distinct
        // from `[package] version` (and from `[dependencies] foo.version`).
        if (target.section) {
          const sectionPattern = target.section.replace(/\./g, '\\.');
          const sectionRegex = new RegExp(
            `(^\\s*\\[${sectionPattern}\\]\\s*$[\\s\\S]*?)^(${key}\\s*=\\s*")([^"]+)(")`,
            'm',
          );
          const match = content.match(sectionRegex);
          if (!match) {
            return {
              file: target.file,
              strategy: target.strategy,
              success: false,
              error: `No \`${key} = "…"\` line found inside [${target.section}] section`,
            };
          }
          previousVersion = match[3];
          newContent = content.replace(sectionRegex, `$1$2${newVersion}$4`);
          break;
        }
        // No section — match the first top-level `key = "…"` line.
        const versionRegex = new RegExp(`^(${key}\\s*=\\s*")([^"]+)(")`, 'm');
        const match = content.match(versionRegex);
        if (!match) {
          return {
            file: target.file,
            strategy: target.strategy,
            success: false,
            error: `No \`${key} = "…"\` line found in file (note: \`${key}.workspace = true\` is not bumpable — see Cargo workspace inheritance)`,
          };
        }
        previousVersion = match[2];
        newContent = content.replace(versionRegex, `$1${newVersion}$3`);
        break;
      }

      case 'sed': {
        const pattern = target.pattern ?? '';
        if (!pattern.includes('{{VERSION}}')) {
          return {
            file: target.file,
            strategy: target.strategy,
            success: false,
            error: 'sed strategy requires {{VERSION}} placeholder in pattern',
          };
        }
        const regex = new RegExp(pattern.replace('{{VERSION}}', '([\\d.]+)'));
        const match = content.match(regex);
        previousVersion = match?.[1];
        newContent = content.replace(regex, pattern.replace('{{VERSION}}', newVersion));
        break;
      }

      default:
        return {
          file: target.file,
          strategy: target.strategy,
          success: false,
          error: `Unknown strategy: ${target.strategy}`,
        };
    }

    writeFileSync(filePath, newContent, 'utf-8');
    return {
      file: target.file,
      strategy: target.strategy,
      success: true,
      previousVersion,
      newVersion,
    };
  } catch (err) {
    return {
      file: target.file,
      strategy: target.strategy,
      success: false,
      error: String(err),
    };
  }
}

/** Options passed to {@link bumpVersionFromConfig}. */
export interface BumpVersionFromConfigOptions {
  dryRun?: boolean;
}

/** Bump version in all configured files. */
export function bumpVersionFromConfig(
  newVersion: string,
  options: BumpVersionFromConfigOptions = {},
  cwd?: string,
): BumpVersionFromConfigResult {
  if (!validateVersionFormat(newVersion)) {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `Invalid version: '${newVersion}' (expected X.Y.Z or YYYY.M.patch)`,
    );
  }

  const { targets } = resolveVersionBumpTargets(cwd);
  if (targets.length === 0) {
    throw new CleoError(
      ExitCode.GENERAL_ERROR,
      'No version bump targets configured and no bumpable workspace detected. ' +
        'Either add release.versionBump.files to .cleo/config.json, ' +
        'or run inside a pnpm/yarn/npm workspace with package.json files, ' +
        'or a Cargo [workspace.package] / per-crate [package] version setup.',
    );
  }

  const projectRoot = resolveProjectRootLoose(cwd);
  const results: BumpResult[] = [];

  if (options.dryRun) {
    for (const target of targets) {
      results.push({
        file: target.file,
        strategy: target.strategy,
        success: true,
        newVersion,
      });
    }
    return { results, allSuccess: true };
  }

  for (const target of targets) {
    results.push(bumpFile(target, newVersion, projectRoot));
  }

  const allSuccess = results.every((r) => r.success);
  return { results, allSuccess };
}

// Nested field helpers
function getNestedField(obj: Record<string, unknown>, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((acc, key) => (acc as Record<string, unknown>)?.[key], obj);
}

function setNestedField(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof current[parts[i]!] !== 'object') current[parts[i]!] = {};
    current = current[parts[i]!] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
}
