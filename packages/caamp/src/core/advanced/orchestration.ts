/**
 * Advanced orchestration helpers for multi-provider operations.
 *
 * These helpers compose CAAMP's lower-level APIs into production patterns:
 * tier-based targeting, rollback-capable skill batches, and instruction updates.
 */

import { existsSync, lstatSync } from 'node:fs';
import { cp, mkdir, readlink, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { ConfigFormat, Provider, ProviderPriority } from '../../types.js';
import { injectAll } from '../instructions/injector.js';
import { groupByInstructFile } from '../instructions/templates.js';
import { CANONICAL_SKILLS_DIR } from '../paths/agents.js';
import { getInstalledProviders } from '../registry/detection.js';
import { installSkill, removeSkill } from '../skills/installer.js';

type Scope = 'project' | 'global';

const PRIORITY_ORDER: Record<ProviderPriority, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

/**
 * Filters providers by minimum priority and returns them in deterministic tier order.
 *
 * @remarks
 * Providers are filtered to include only those at or above the specified priority
 * level, then sorted from highest to lowest priority. For example,
 * `minimumPriority = "medium"` returns providers with `high` and `medium` priority.
 *
 * @param providers - The full list of providers to filter
 * @param minimumPriority - The minimum priority threshold, defaults to `"low"` (include all)
 * @returns A filtered and sorted array of providers meeting the priority threshold
 *
 * @example
 * ```typescript
 * const highPriority = selectProvidersByMinimumPriority(allProviders, "high");
 * // returns only providers with priority "high"
 * ```
 *
 * @public
 */
export function selectProvidersByMinimumPriority(
  providers: Provider[],
  minimumPriority: ProviderPriority = 'low',
): Provider[] {
  const maxRank = PRIORITY_ORDER[minimumPriority];

  return [...providers]
    .filter((provider) => PRIORITY_ORDER[provider.priority] <= maxRank)
    .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
}

/**
 * Single skill operation entry used by batch orchestration.
 *
 * @remarks
 * Represents one skill installation that will be applied across
 * all targeted providers during a batch operation.
 *
 * @public
 */
export interface SkillBatchOperation {
  /** The filesystem path to the skill source files. */
  sourcePath: string;
  /** The unique name for the skill being installed. */
  skillName: string;
  /** Whether to install globally or project-scoped, defaults to true. */
  isGlobal?: boolean;
}

/**
 * Options for rollback-capable batch installation.
 *
 * @remarks
 * All fields are optional. When providers are not specified, installed
 * providers are auto-detected. When minimumPriority is not specified,
 * all priority levels are included.
 *
 * @public
 */
export interface BatchInstallOptions {
  /** Explicit list of providers to target, auto-detected if omitted. */
  providers?: Provider[];
  /** Minimum provider priority threshold for filtering. */
  minimumPriority?: ProviderPriority;
  /** Skill operations to apply in the batch. */
  skills?: SkillBatchOperation[];
  /** Project root directory, defaults to `process.cwd()`. */
  projectDir?: string;
}

/**
 * Result of rollback-capable batch installation.
 *
 * @remarks
 * When `success` is false, `rollbackPerformed` indicates whether rollback
 * was attempted. Any errors during rollback are captured in `rollbackErrors`.
 *
 * @public
 */
export interface BatchInstallResult {
  /** Whether all operations completed successfully. */
  success: boolean;
  /** IDs of providers that were targeted. */
  providerIds: string[];
  /** Number of skill installations that were applied. */
  skillsApplied: number;
  /** Whether rollback was performed due to a failure. */
  rollbackPerformed: boolean;
  /** Error messages from any failures during rollback. */
  rollbackErrors: string[];
  /** Error message from the operation that triggered rollback. */
  error?: string;
}

interface SkillPathSnapshot {
  linkPath: string;
  state: 'missing' | 'symlink' | 'directory' | 'file';
  symlinkTarget?: string;
  backupPath?: string;
}

interface SkillSnapshot {
  skillName: string;
  isGlobal: boolean;
  canonicalPath: string;
  canonicalBackupPath?: string;
  canonicalExisted: boolean;
  pathSnapshots: SkillPathSnapshot[];
}

interface AppliedSkillInstall {
  skillName: string;
  isGlobal: boolean;
  linkedProviders: Provider[];
}

function resolveSkillLinkPath(
  provider: Provider,
  skillName: string,
  isGlobal: boolean,
  projectDir: string,
): string {
  const skillDir = isGlobal ? provider.pathSkills : join(projectDir, provider.pathProjectSkills);
  return join(skillDir, skillName);
}

async function snapshotSkillState(
  providerTargets: Provider[],
  operation: SkillBatchOperation,
  projectDir: string,
  backupRoot: string,
): Promise<SkillSnapshot> {
  const skillName = operation.skillName;
  const isGlobal = operation.isGlobal ?? true;
  const canonicalPath = join(CANONICAL_SKILLS_DIR, skillName);
  const canonicalExisted = existsSync(canonicalPath);
  const canonicalBackupPath = join(backupRoot, 'canonical', skillName);

  if (canonicalExisted) {
    await mkdir(dirname(canonicalBackupPath), { recursive: true });
    await cp(canonicalPath, canonicalBackupPath, { recursive: true });
  }

  const pathSnapshots: SkillPathSnapshot[] = [];
  for (const provider of providerTargets) {
    const linkPath = resolveSkillLinkPath(provider, skillName, isGlobal, projectDir);

    if (!existsSync(linkPath)) {
      pathSnapshots.push({ linkPath, state: 'missing' });
      continue;
    }

    const stat = lstatSync(linkPath);

    if (stat.isSymbolicLink()) {
      pathSnapshots.push({
        linkPath,
        state: 'symlink',
        symlinkTarget: await readlink(linkPath),
      });
      continue;
    }

    const backupPath = join(backupRoot, 'links', provider.id, `${skillName}-${basename(linkPath)}`);
    await mkdir(dirname(backupPath), { recursive: true });

    if (stat.isDirectory()) {
      await cp(linkPath, backupPath, { recursive: true });
      pathSnapshots.push({ linkPath, state: 'directory', backupPath });
      continue;
    }

    await cp(linkPath, backupPath);
    pathSnapshots.push({ linkPath, state: 'file', backupPath });
  }

  return {
    skillName,
    isGlobal,
    canonicalPath,
    canonicalBackupPath: canonicalExisted ? canonicalBackupPath : undefined,
    canonicalExisted,
    pathSnapshots,
  };
}

async function restoreSkillSnapshot(snapshot: SkillSnapshot): Promise<void> {
  if (existsSync(snapshot.canonicalPath)) {
    await rm(snapshot.canonicalPath, { recursive: true, force: true });
  }

  if (
    snapshot.canonicalExisted &&
    snapshot.canonicalBackupPath &&
    existsSync(snapshot.canonicalBackupPath)
  ) {
    await mkdir(dirname(snapshot.canonicalPath), { recursive: true });
    await cp(snapshot.canonicalBackupPath, snapshot.canonicalPath, { recursive: true });
  }

  for (const pathSnapshot of snapshot.pathSnapshots) {
    await rm(pathSnapshot.linkPath, { recursive: true, force: true });

    if (pathSnapshot.state === 'missing') continue;

    await mkdir(dirname(pathSnapshot.linkPath), { recursive: true });

    if (pathSnapshot.state === 'symlink' && pathSnapshot.symlinkTarget) {
      const linkType = process.platform === 'win32' ? 'junction' : 'dir';
      await symlink(pathSnapshot.symlinkTarget, pathSnapshot.linkPath, linkType);
      continue;
    }

    if (
      (pathSnapshot.state === 'directory' || pathSnapshot.state === 'file') &&
      pathSnapshot.backupPath
    ) {
      if (pathSnapshot.state === 'directory') {
        await cp(pathSnapshot.backupPath, pathSnapshot.linkPath, { recursive: true });
      } else {
        await cp(pathSnapshot.backupPath, pathSnapshot.linkPath);
      }
    }
  }
}

/**
 * Installs multiple skills across filtered providers with rollback.
 *
 * @remarks
 * Snapshots all affected skill directories before applying operations.
 * If any operation fails, all changes are rolled back by reverting
 * skill symlinks and canonical directories to their pre-operation state.
 *
 * @param options - The batch installation options including providers, operations, and scope
 * @returns A result object indicating success, applied counts, and any rollback information
 *
 * @example
 * ```typescript
 * const result = await installBatchWithRollback({
 *   minimumPriority: "high",
 *   skills: [{ sourcePath: "/path/to/skill", skillName: "my-skill" }],
 * });
 * if (!result.success) {
 *   console.error("Failed:", result.error);
 * }
 * ```
 *
 * @public
 */
export async function installBatchWithRollback(
  options: BatchInstallOptions,
): Promise<BatchInstallResult> {
  const projectDir = options.projectDir ?? process.cwd();
  const minimumPriority = options.minimumPriority ?? 'low';
  const skillOps = options.skills ?? [];
  const baseProviders = options.providers ?? getInstalledProviders();
  const providers = selectProvidersByMinimumPriority(baseProviders, minimumPriority);

  const backupRoot = join(
    tmpdir(),
    `caamp-skill-backup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );

  const skillSnapshots = await Promise.all(
    skillOps.map((operation) => snapshotSkillState(providers, operation, projectDir, backupRoot)),
  );

  const appliedSkills: AppliedSkillInstall[] = [];
  const rollbackErrors: string[] = [];
  let skillsApplied = 0;
  let rollbackPerformed = false;

  try {
    for (const operation of skillOps) {
      const isGlobal = operation.isGlobal ?? true;
      const result = await installSkill(
        operation.sourcePath,
        operation.skillName,
        providers,
        isGlobal,
        projectDir,
      );

      const linkedProviders = providers.filter((provider) =>
        result.linkedAgents.includes(provider.id),
      );
      appliedSkills.push({
        skillName: operation.skillName,
        isGlobal,
        linkedProviders,
      });

      if (result.errors.length > 0) {
        throw new Error(result.errors.join('; '));
      }

      skillsApplied += 1;
    }

    await rm(backupRoot, { recursive: true, force: true });

    return {
      success: true,
      providerIds: providers.map((provider) => provider.id),
      skillsApplied,
      rollbackPerformed: false,
      rollbackErrors: [],
    };
  } catch (error) {
    rollbackPerformed = true;

    for (const applied of [...appliedSkills].reverse()) {
      try {
        await removeSkill(applied.skillName, applied.linkedProviders, applied.isGlobal, projectDir);
      } catch (err) {
        rollbackErrors.push(err instanceof Error ? err.message : String(err));
      }
    }

    for (const snapshot of skillSnapshots) {
      try {
        await restoreSkillSnapshot(snapshot);
      } catch (err) {
        rollbackErrors.push(err instanceof Error ? err.message : String(err));
      }
    }

    await rm(backupRoot, { recursive: true, force: true });

    return {
      success: false,
      providerIds: providers.map((provider) => provider.id),
      skillsApplied,
      rollbackPerformed,
      rollbackErrors,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Result of a single-operation instruction update across providers.
 *
 * @remarks
 * Summarizes the instruction files that were created, updated, or left
 * intact during an instruction injection operation.
 *
 * @public
 */
export interface InstructionUpdateSummary {
  /** The scope at which instructions were updated. */
  scope: Scope;
  /** The total number of instruction files that were modified. */
  updatedFiles: number;
  /** Detailed action log per instruction file. */
  actions: Array<{
    file: string;
    action: 'created' | 'added' | 'consolidated' | 'updated' | 'intact';
    providers: string[];
    configFormats: ConfigFormat[];
  }>;
}

/**
 * Updates instruction files across providers as a single operation.
 *
 * @remarks
 * Works the same regardless of provider config format (JSON/YAML/TOML/JSONC)
 * because instruction files are handled through CAAMP markers. Groups
 * providers by their instruction file targets and injects content using
 * marker-based sections.
 *
 * @param providers - The providers whose instruction files to update
 * @param content - The instruction content to inject
 * @param scope - The scope for instruction updates, defaults to `"project"`
 * @param projectDir - The project root directory, defaults to `process.cwd()`
 * @returns A summary of updated files and actions taken per file
 *
 * @example
 * ```typescript
 * const summary = await updateInstructionsSingleOperation(
 *   providers,
 *   "## CAAMP Config\nUse these MCP servers...",
 *   "project",
 * );
 * console.log(`Updated ${summary.updatedFiles} files`);
 * ```
 *
 * @public
 */
export async function updateInstructionsSingleOperation(
  providers: Provider[],
  content: string,
  scope: Scope = 'project',
  projectDir = process.cwd(),
): Promise<InstructionUpdateSummary> {
  const actions = await injectAll(providers, projectDir, scope, content);
  const groupedByFile = groupByInstructFile(providers);

  const summary: InstructionUpdateSummary = {
    scope,
    updatedFiles: actions.size,
    actions: [],
  };

  for (const [filePath, action] of actions.entries()) {
    const providersForFile = providers.filter((provider) => {
      const expectedPath =
        scope === 'global'
          ? join(provider.pathGlobal, provider.instructFile)
          : join(projectDir, provider.instructFile);
      return expectedPath === filePath;
    });

    const fallback = groupedByFile.get(basename(filePath)) ?? [];
    const selected = providersForFile.length > 0 ? providersForFile : fallback;

    summary.actions.push({
      file: filePath,
      action,
      providers: selected.map((provider) => provider.id),
      configFormats: Array.from(new Set(selected.map((provider) => provider.configFormat))),
    });
  }

  return summary;
}
