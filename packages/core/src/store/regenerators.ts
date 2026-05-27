/**
 * Dry-run JSON file generators for the three CLEO runtime state files.
 *
 * Returns the content that `cleo init` WOULD write on the target machine,
 * capturing machine-local state (projectRoot, hostname, timestamps) without
 * touching the filesystem.
 *
 * Used by T354's A/B regenerate-and-compare engine (ADR-038 §10): the "A"
 * side of the comparison is always what a fresh init would produce locally.
 *
 * @task T352
 * @epic T311
 * @why ADR-038 §10 — A/B regenerate-and-compare needs the "A" side: what the
 *      JSON files would look like if freshly initialized on the target machine.
 *      Captures machine-local state (projectRoot, hostname, timestamps).
 * @what Pure dry-run versions of the cleo init JSON file generators.
 *
 * DRIFT WARNING: These generators mirror the logic inside:
 *   - packages/core/src/scaffold.ts :: createDefaultConfig()           (config.json)
 *   - packages/core/src/scaffold.ts :: ensureProjectInfo()              (project-info.json)
 *   - packages/core/src/store/project-detect.ts :: detectProjectType() (project-context.json)
 *
 * If any of those functions change the shape or defaults of their generated
 * files, this module MUST be updated to match. There is no runtime link — the
 * similarity is maintained manually.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { generateProjectHash } from '../nexus/hash.js';
import { createDefaultConfig, getCleoVersion } from '../scaffold.js';
import { getSchemaVersion } from '../schema-management.js';
import { detectProjectType, type ProjectContext } from './project-detect.js';

/**
 * Mirror of SQLITE_SCHEMA_VERSION from ./sqlite.ts.
 *
 * We do not import sqlite.ts here to avoid its module-level side effects
 * (node:sqlite bootstrap via createRequire). If the canonical value in
 * sqlite.ts changes, update this constant to match.
 *
 * Canonical source: packages/core/src/store/sqlite.ts :: SQLITE_SCHEMA_VERSION
 */
const SQLITE_SCHEMA_VERSION_MIRROR = '2.0.0';

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * The result of a dry-run file generator.
 *
 * @typeParam T - The shape of the generated file content. Defaults to
 *   `Record<string, unknown>` when the exact shape is not statically known.
 *
 * @task T352
 * @epic T311
 */
export interface RegeneratedFile<T = Record<string, unknown>> {
  /** The filename that `cleo init` would write. */
  filename: 'config.json' | 'project-info.json' | 'project-context.json';
  /** The parsed content that would be written to disk. */
  content: T;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Detect whether the given `projectRoot` is the CLEO contributor project.
 * Mirrors the private `isCleoContributorProject()` helper in scaffold.ts.
 *
 * Returns `true` only if all three fingerprints match:
 *   1. `src/dispatch/` directory exists
 *   2. `src/core/` directory exists
 *   3. `package.json` identifies as `@cleocode/cleo`
 */
function isContributorProject(projectRoot: string): boolean {
  const at = (p: string) => existsSync(join(projectRoot, p));
  if (!at('src/dispatch') || !at('src/core')) return false;
  try {
    const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf-8')) as {
      name?: string;
    };
    return pkg.name === '@cleocode/cleo';
  } catch {
    return false;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns the `config.json` content that `cleo init` would write for
 * `projectRoot` on the current machine.
 *
 * PURE — no disk writes. Reads package.json only to detect the contributor
 * project fingerprint (same as `ensureConfig` in scaffold.ts).
 *
 * Mirrors: `packages/core/src/scaffold.ts :: ensureConfig()` and
 *          `packages/core/src/scaffold.ts :: createDefaultConfig()`.
 *
 * DRIFT: if `createDefaultConfig()` adds new keys, regenerateConfigJson must
 * be updated to reflect the same structure. The coupling is intentional but
 * manual — see the TSDoc on this file.
 *
 * @param projectRoot - Absolute or relative path to the project root.
 * @returns A `RegeneratedFile` whose `content` matches a freshly written
 *   `config.json`.
 */
export function regenerateConfigJson(projectRoot: string): RegeneratedFile {
  const resolvedRoot = resolve(projectRoot);

  // createDefaultConfig() is the single source of truth for the config shape.
  const content = createDefaultConfig() as Record<string, unknown>;

  // Conditionally append the contributor block — mirrors ensureConfig() logic.
  if (isContributorProject(resolvedRoot)) {
    content['contributor'] = {
      isContributorProject: true,
      devCli: 'cleo-dev',
      verifiedAt: new Date().toISOString(),
    };
  }

  return { filename: 'config.json', content };
}

/**
 * Returns the `project-info.json` content that `cleo init` would write for
 * `projectRoot` on the current machine.
 *
 * Captures machine-local fields:
 *   - `projectHash` — SHA-256 of the resolved absolute path (first 12 chars)
 *   - `projectId`   — fresh UUID (volatile; each call produces a new value)
 *   - `lastUpdated` — current ISO timestamp (volatile)
 *   - `cleoVersion` — read from `@cleocode/core/package.json` at runtime
 *   - `schemas.*`   — schema version strings from bundled JSON schema files
 *
 * PURE — no disk writes.
 *
 * Mirrors: `packages/core/src/scaffold.ts :: ensureProjectInfo()`.
 *
 * DRIFT: if `ensureProjectInfo` adds, removes, or renames fields in the
 * written JSON, update this function to match.
 *
 * @param projectRoot - Absolute or relative path to the project root.
 * @returns A `RegeneratedFile` whose `content` matches a freshly written
 *   `project-info.json`.
 */
export function regenerateProjectInfoJson(projectRoot: string): RegeneratedFile {
  const resolvedRoot = resolve(projectRoot);
  const projectHash = generateProjectHash(resolvedRoot);
  const cleoVersion = getCleoVersion();
  const now = new Date().toISOString();

  // Read schema versions using the synchronous helper — falls back to safe
  // defaults when schema files are not available (e.g. fresh clone, test env).
  const configSchemaVersion = getSchemaVersion('config.schema.json') ?? cleoVersion;
  const projectContextSchemaVersion = getSchemaVersion('project-context.schema.json') ?? '1.0.0';

  const content: Record<string, unknown> = {
    $schema: './schemas/project-info.schema.json',
    schemaVersion: '1.0.0',
    projectId: randomUUID(),
    projectHash,
    cleoVersion,
    lastUpdated: now,
    schemas: {
      config: configSchemaVersion,
      sqlite: SQLITE_SCHEMA_VERSION_MIRROR,
      projectContext: projectContextSchemaVersion,
    },
    injection: {
      'CLAUDE.md': null,
      'AGENTS.md': null,
      'GEMINI.md': null,
    },
    health: {
      status: 'unknown',
      lastCheck: null,
      issues: [],
    },
    features: {
      multiSession: false,
      verification: false,
      contextAlerts: false,
    },
  };

  return { filename: 'project-info.json', content };
}

/**
 * Returns the `project-context.json` content that `cleo init` would write for
 * `projectRoot` on the current machine.
 *
 * Runs full project-type detection by inspecting the project directory:
 * testing framework, build command, primary language, monorepo topology,
 * file-naming conventions, and LLM hints. DOES NOT spawn child processes.
 *
 * PURE — no disk writes.
 *
 * Mirrors: `packages/core/src/scaffold.ts :: ensureProjectContext()` and
 *          `packages/core/src/store/project-detect.ts :: detectProjectType()`.
 *
 * DRIFT: if `detectProjectType()` changes its output shape, the downstream
 * A/B compare engine (T354) will still work because it compares fields by
 * name — but regenerateProjectContextJson may produce unexpected keys or
 * miss new ones until updated.
 *
 * @param projectRoot - Absolute or relative path to the project root.
 * @returns A `RegeneratedFile` whose `content` matches a freshly written
 *   `project-context.json`.
 */
export function regenerateProjectContextJson(projectRoot: string): RegeneratedFile<ProjectContext> {
  const resolvedRoot = resolve(projectRoot);
  const content = detectProjectType(resolvedRoot);
  return { filename: 'project-context.json', content };
}

/**
 * Convenience wrapper that returns all three regenerated files in one call.
 *
 * Each generator runs independently; volatile fields in `project-info.json`
 * (`projectId`, `lastUpdated`) will differ from a separate call to
 * `regenerateProjectInfoJson`.
 *
 * @param projectRoot - Absolute or relative path to the project root.
 * @returns Object containing all three `RegeneratedFile` results.
 *
 * @task T352
 * @epic T311
 */
export function regenerateAllJson(projectRoot: string): {
  config: RegeneratedFile;
  projectInfo: RegeneratedFile;
  projectContext: RegeneratedFile<ProjectContext>;
} {
  return {
    config: regenerateConfigJson(projectRoot),
    projectInfo: regenerateProjectInfoJson(projectRoot),
    projectContext: regenerateProjectContextJson(projectRoot),
  };
}
