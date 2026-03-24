/**
 * Advanced orchestration helpers for multi-provider operations.
 *
 * These helpers compose CAAMP's lower-level APIs into production patterns:
 * tier-based targeting, conflict-aware installs, and rollback-capable batches.
 */

import { existsSync, lstatSync } from "node:fs";
import {
  cp,
  mkdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type {
  ConfigFormat,
  McpServerConfig,
  Provider,
  ProviderPriority,
} from "../../types.js";
import { injectAll } from "../instructions/injector.js";
import { groupByInstructFile } from "../instructions/templates.js";
import { type InstallResult, installMcpServer } from "../mcp/installer.js";
import { listMcpServers, resolveConfigPath } from "../mcp/reader.js";
import { getTransform } from "../mcp/transforms.js";
import { CANONICAL_SKILLS_DIR } from "../paths/agents.js";
import { getInstalledProviders } from "../registry/detection.js";
import { installSkill, removeSkill } from "../skills/installer.js";

type Scope = "project" | "global";

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
  minimumPriority: ProviderPriority = "low",
): Provider[] {
  const maxRank = PRIORITY_ORDER[minimumPriority];

  return [...providers]
    .filter((provider) => PRIORITY_ORDER[provider.priority] <= maxRank)
    .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
}

/**
 * Single MCP operation entry used by batch orchestration.
 *
 * @remarks
 * Represents one MCP server installation that will be applied across
 * all targeted providers during a batch operation.
 *
 * @public
 */
export interface McpBatchOperation {
  /** The name of the MCP server to install. */
  serverName: string;
  /** The MCP server configuration to write. */
  config: McpServerConfig;
  /** The scope for installation, defaults to `"project"`. */
  scope?: Scope;
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
  /** MCP server operations to apply in the batch. */
  mcp?: McpBatchOperation[];
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
  /** Number of MCP server installations that were applied. */
  mcpApplied: number;
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
  state: "missing" | "symlink" | "directory" | "file";
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
  const skillDir = isGlobal
    ? provider.pathSkills
    : join(projectDir, provider.pathProjectSkills);
  return join(skillDir, skillName);
}

async function snapshotConfigs(paths: string[]): Promise<Map<string, string | null>> {
  const snapshots = new Map<string, string | null>();

  for (const path of paths) {
    if (!path || snapshots.has(path)) continue;
    if (!existsSync(path)) {
      snapshots.set(path, null);
      continue;
    }
    snapshots.set(path, await readFile(path, "utf-8"));
  }

  return snapshots;
}

async function restoreConfigSnapshots(snapshots: Map<string, string | null>): Promise<void> {
  for (const [path, content] of snapshots) {
    if (content === null) {
      await rm(path, { force: true });
      continue;
    }

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf-8");
  }
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
  const canonicalBackupPath = join(backupRoot, "canonical", skillName);

  if (canonicalExisted) {
    await mkdir(dirname(canonicalBackupPath), { recursive: true });
    await cp(canonicalPath, canonicalBackupPath, { recursive: true });
  }

  const pathSnapshots: SkillPathSnapshot[] = [];
  for (const provider of providerTargets) {
    const linkPath = resolveSkillLinkPath(provider, skillName, isGlobal, projectDir);

    if (!existsSync(linkPath)) {
      pathSnapshots.push({ linkPath, state: "missing" });
      continue;
    }

    const stat = lstatSync(linkPath);

    if (stat.isSymbolicLink()) {
      pathSnapshots.push({
        linkPath,
        state: "symlink",
        symlinkTarget: await readlink(linkPath),
      });
      continue;
    }

    const backupPath = join(backupRoot, "links", provider.id, `${skillName}-${basename(linkPath)}`);
    await mkdir(dirname(backupPath), { recursive: true });

    if (stat.isDirectory()) {
      await cp(linkPath, backupPath, { recursive: true });
      pathSnapshots.push({ linkPath, state: "directory", backupPath });
      continue;
    }

    await cp(linkPath, backupPath);
    pathSnapshots.push({ linkPath, state: "file", backupPath });
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

  if (snapshot.canonicalExisted && snapshot.canonicalBackupPath && existsSync(snapshot.canonicalBackupPath)) {
    await mkdir(dirname(snapshot.canonicalPath), { recursive: true });
    await cp(snapshot.canonicalBackupPath, snapshot.canonicalPath, { recursive: true });
  }

  for (const pathSnapshot of snapshot.pathSnapshots) {
    await rm(pathSnapshot.linkPath, { recursive: true, force: true });

    if (pathSnapshot.state === "missing") continue;

    await mkdir(dirname(pathSnapshot.linkPath), { recursive: true });

    if (pathSnapshot.state === "symlink" && pathSnapshot.symlinkTarget) {
      const linkType = process.platform === "win32" ? "junction" : "dir";
      await symlink(pathSnapshot.symlinkTarget, pathSnapshot.linkPath, linkType);
      continue;
    }

    if ((pathSnapshot.state === "directory" || pathSnapshot.state === "file") && pathSnapshot.backupPath) {
      if (pathSnapshot.state === "directory") {
        await cp(pathSnapshot.backupPath, pathSnapshot.linkPath, { recursive: true });
      } else {
        await cp(pathSnapshot.backupPath, pathSnapshot.linkPath);
      }
    }
  }
}

/**
 * Installs multiple MCP servers and skills across filtered providers with rollback.
 *
 * @remarks
 * Snapshots all affected config files and skill directories before applying
 * operations. If any operation fails, all changes are rolled back by restoring
 * config file snapshots and reverting skill symlinks and canonical directories
 * to their pre-operation state.
 *
 * @param options - The batch installation options including providers, operations, and scope
 * @returns A result object indicating success, applied counts, and any rollback information
 *
 * @example
 * ```typescript
 * const result = await installBatchWithRollback({
 *   minimumPriority: "high",
 *   mcp: [{ serverName: "my-server", config: { command: "npx", args: ["my-server"] } }],
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
  const minimumPriority = options.minimumPriority ?? "low";
  const mcpOps = options.mcp ?? [];
  const skillOps = options.skills ?? [];
  const baseProviders = options.providers ?? getInstalledProviders();
  const providers = selectProvidersByMinimumPriority(baseProviders, minimumPriority);

  const configPaths = providers.flatMap((provider) => {
    const paths: string[] = [];
    for (const operation of mcpOps) {
      const path = resolveConfigPath(provider, operation.scope ?? "project", projectDir);
      if (path) paths.push(path);
    }
    return paths;
  });

  const configSnapshots = await snapshotConfigs(configPaths);
  const backupRoot = join(
    tmpdir(),
    `caamp-skill-backup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );

  const skillSnapshots = await Promise.all(
    skillOps.map((operation) => snapshotSkillState(providers, operation, projectDir, backupRoot)),
  );

  const appliedSkills: AppliedSkillInstall[] = [];
  const rollbackErrors: string[] = [];
  let mcpApplied = 0;
  let skillsApplied = 0;
  let rollbackPerformed = false;

  try {
    for (const operation of mcpOps) {
      const scope = operation.scope ?? "project";
      for (const provider of providers) {
        const result = await installMcpServer(
          provider,
          operation.serverName,
          operation.config,
          scope,
          projectDir,
        );

        if (!result.success) {
          throw new Error(result.error ?? `Failed MCP install for ${provider.id}`);
        }
        mcpApplied += 1;
      }
    }

    for (const operation of skillOps) {
      const isGlobal = operation.isGlobal ?? true;
      const result = await installSkill(
        operation.sourcePath,
        operation.skillName,
        providers,
        isGlobal,
        projectDir,
      );

      const linkedProviders = providers.filter((provider) => result.linkedAgents.includes(provider.id));
      appliedSkills.push({
        skillName: operation.skillName,
        isGlobal,
        linkedProviders,
      });

      if (result.errors.length > 0) {
        throw new Error(result.errors.join("; "));
      }

      skillsApplied += 1;
    }

    await rm(backupRoot, { recursive: true, force: true });

    return {
      success: true,
      providerIds: providers.map((provider) => provider.id),
      mcpApplied,
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

    try {
      await restoreConfigSnapshots(configSnapshots);
    } catch (err) {
      rollbackErrors.push(err instanceof Error ? err.message : String(err));
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
      mcpApplied,
      skillsApplied,
      rollbackPerformed,
      rollbackErrors,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Conflict policy when applying MCP install plans.
 *
 * @remarks
 * Controls behavior when an existing MCP server configuration conflicts
 * with the desired configuration: `"fail"` aborts the entire operation,
 * `"skip"` leaves conflicting entries unchanged, and `"overwrite"` replaces them.
 *
 * @public
 */
export type ConflictPolicy = "fail" | "skip" | "overwrite";

/**
 * Conflict code identifying the type of MCP configuration conflict.
 *
 * @remarks
 * Used in {@link McpConflict} to categorize detected conflicts during
 * preflight checks before applying MCP installations.
 *
 * @public
 */
export type McpConflictCode =
  | "unsupported-transport"
  | "unsupported-headers"
  | "existing-mismatch";

/**
 * Describes a conflict detected during MCP installation preflight.
 *
 * @remarks
 * Contains the provider, server, scope, and nature of the conflict
 * so that callers can decide how to proceed based on their conflict policy.
 *
 * @public
 */
export interface McpConflict {
  /** The provider where the conflict was detected. */
  providerId: string;
  /** The MCP server name involved in the conflict. */
  serverName: string;
  /** The scope (global or project) of the conflicting config. */
  scope: Scope;
  /** The type of conflict detected. */
  code: McpConflictCode;
  /** Human-readable description of the conflict. */
  message: string;
}

/**
 * Result from applying an MCP install plan with a conflict policy.
 *
 * @remarks
 * Contains all detected conflicts, successfully applied installations,
 * and any operations that were skipped due to the conflict policy.
 *
 * @public
 */
export interface McpPlanApplyResult {
  /** All conflicts detected during preflight, regardless of policy. */
  conflicts: McpConflict[];
  /** Successfully applied MCP server installations. */
  applied: InstallResult[];
  /** Operations skipped due to the conflict policy. */
  skipped: Array<{
    providerId: string;
    serverName: string;
    scope: Scope;
    reason: McpConflictCode;
  }>;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }

  return JSON.stringify(value);
}

/**
 * Performs preflight conflict detection for MCP install plans across providers.
 *
 * @remarks
 * Checks each provider-operation pair for transport support, header support,
 * and existing configuration mismatches. Returns all detected conflicts without
 * modifying any files. Callers can then decide whether to proceed based on
 * their conflict policy.
 *
 * @param providers - The providers to check for conflicts
 * @param operations - The MCP operations to validate against existing configs
 * @param projectDir - The project root directory, defaults to `process.cwd()`
 * @returns An array of detected conflicts, empty if no conflicts found
 *
 * @example
 * ```typescript
 * const conflicts = await detectMcpConfigConflicts(providers, operations);
 * if (conflicts.length > 0) {
 *   console.warn("Conflicts detected:", conflicts);
 * }
 * ```
 *
 * @public
 */
export async function detectMcpConfigConflicts(
  providers: Provider[],
  operations: McpBatchOperation[],
  projectDir = process.cwd(),
): Promise<McpConflict[]> {
  const conflicts: McpConflict[] = [];

  for (const provider of providers) {
    for (const operation of operations) {
      const scope = operation.scope ?? "project";

      if (operation.config.type && !provider.supportedTransports.includes(operation.config.type)) {
        conflicts.push({
          providerId: provider.id,
          serverName: operation.serverName,
          scope,
          code: "unsupported-transport",
          message: `${provider.id} does not support transport ${operation.config.type}`,
        });
      }

      if (operation.config.headers && !provider.supportsHeaders) {
        conflicts.push({
          providerId: provider.id,
          serverName: operation.serverName,
          scope,
          code: "unsupported-headers",
          message: `${provider.id} does not support header configuration`,
        });
      }

      const existingEntries = await listMcpServers(provider, scope, projectDir);
      const current = existingEntries.find((entry) => entry.name === operation.serverName);
      if (!current) continue;

      const transform = getTransform(provider.id);
      const desired = transform
        ? transform(operation.serverName, operation.config)
        : operation.config;

      if (stableStringify(current.config) !== stableStringify(desired)) {
        conflicts.push({
          providerId: provider.id,
          serverName: operation.serverName,
          scope,
          code: "existing-mismatch",
          message: `${provider.id} has existing config mismatch for ${operation.serverName}`,
        });
      }
    }
  }

  return conflicts;
}

/**
 * Applies an MCP install plan with a conflict policy controlling behavior on conflicts.
 *
 * @remarks
 * First runs {@link detectMcpConfigConflicts} to find all conflicts, then applies
 * the specified policy: `"fail"` returns immediately with no changes, `"skip"`
 * leaves conflicting entries unchanged and applies the rest, and `"overwrite"`
 * applies all operations regardless of conflicts.
 *
 * @param providers - The providers to install MCP servers for
 * @param operations - The MCP server operations to apply
 * @param policy - The conflict resolution policy, defaults to `"fail"`
 * @param projectDir - The project root directory, defaults to `process.cwd()`
 * @returns A result containing conflicts, applied installations, and skipped operations
 *
 * @example
 * ```typescript
 * const result = await applyMcpInstallWithPolicy(providers, operations, "skip");
 * console.log(`Applied: ${result.applied.length}, Skipped: ${result.skipped.length}`);
 * ```
 *
 * @public
 */
export async function applyMcpInstallWithPolicy(
  providers: Provider[],
  operations: McpBatchOperation[],
  policy: ConflictPolicy = "fail",
  projectDir = process.cwd(),
): Promise<McpPlanApplyResult> {
  const conflicts = await detectMcpConfigConflicts(providers, operations, projectDir);
  const conflictKey = (providerId: string, serverName: string, scope: Scope) => `${providerId}::${serverName}::${scope}`;
  const conflictMap = new Map<string, McpConflict>();
  for (const conflict of conflicts) {
    conflictMap.set(conflictKey(conflict.providerId, conflict.serverName, conflict.scope), conflict);
  }

  if (policy === "fail" && conflicts.length > 0) {
    return { conflicts, applied: [], skipped: [] };
  }

  const applied: InstallResult[] = [];
  const skipped: McpPlanApplyResult["skipped"] = [];

  for (const provider of providers) {
    for (const operation of operations) {
      const scope = operation.scope ?? "project";
      const key = conflictKey(provider.id, operation.serverName, scope);
      const conflict = conflictMap.get(key);

      if (policy === "skip" && conflict) {
        skipped.push({
          providerId: provider.id,
          serverName: operation.serverName,
          scope,
          reason: conflict.code,
        });
        continue;
      }

      const result = await installMcpServer(
        provider,
        operation.serverName,
        operation.config,
        scope,
        projectDir,
      );
      applied.push(result);
    }
  }

  return { conflicts, applied, skipped };
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
    action: "created" | "added" | "consolidated" | "updated" | "intact";
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
  scope: Scope = "project",
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
      const expectedPath = scope === "global"
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

/**
 * Request payload for dual-scope provider configuration.
 *
 * @remarks
 * Allows configuring both global and project-level MCP servers and
 * instructions in a single call. Instruction content can be a single
 * string applied to both scopes or scope-specific strings.
 *
 * @public
 */
export interface DualScopeConfigureOptions {
  /** MCP servers to install at global scope. */
  globalMcp?: Array<{ serverName: string; config: McpServerConfig }>;
  /** MCP servers to install at project scope. */
  projectMcp?: Array<{ serverName: string; config: McpServerConfig }>;
  /** Instruction content for injection, either shared or per-scope. */
  instructionContent?: string | { global?: string; project?: string };
  /** Project root directory, defaults to `process.cwd()`. */
  projectDir?: string;
}

/**
 * Result of dual-scope provider configuration.
 *
 * @remarks
 * Contains the resolved config paths, MCP installation results for both
 * scopes, and instruction injection results for each scope that was configured.
 *
 * @public
 */
export interface DualScopeConfigureResult {
  /** The ID of the configured provider. */
  providerId: string;
  /** Resolved configuration file paths for both scopes. */
  configPaths: {
    global: string | null;
    project: string | null;
  };
  /** MCP installation results for each scope. */
  mcp: {
    global: InstallResult[];
    project: InstallResult[];
  };
  /** Instruction injection results for each scope, if applicable. */
  instructions: {
    global?: Map<string, "created" | "added" | "consolidated" | "updated" | "intact">;
    project?: Map<string, "created" | "added" | "consolidated" | "updated" | "intact">;
  };
}

/**
 * Configures both global and project-level settings for one provider in one call.
 *
 * @remarks
 * Applies MCP server installations and instruction injections at both global
 * and project scope in a single coordinated operation. This avoids the need
 * to make separate calls for each scope.
 *
 * @param provider - The provider to configure
 * @param options - The dual-scope configuration options
 * @returns A result containing config paths, MCP results, and instruction results for both scopes
 *
 * @example
 * ```typescript
 * const result = await configureProviderGlobalAndProject(provider, {
 *   globalMcp: [{ serverName: "my-server", config: { command: "npx", args: ["my-server"] } }],
 *   instructionContent: "## Agent Setup\nUse these tools...",
 * });
 * console.log(result.configPaths);
 * ```
 *
 * @public
 */
export async function configureProviderGlobalAndProject(
  provider: Provider,
  options: DualScopeConfigureOptions,
): Promise<DualScopeConfigureResult> {
  const projectDir = options.projectDir ?? process.cwd();
  const globalOps = options.globalMcp ?? [];
  const projectOps = options.projectMcp ?? [];

  const globalResults: InstallResult[] = [];
  for (const operation of globalOps) {
    globalResults.push(await installMcpServer(
      provider,
      operation.serverName,
      operation.config,
      "global",
      projectDir,
    ));
  }

  const projectResults: InstallResult[] = [];
  for (const operation of projectOps) {
    projectResults.push(await installMcpServer(
      provider,
      operation.serverName,
      operation.config,
      "project",
      projectDir,
    ));
  }

  const instructionResults: DualScopeConfigureResult["instructions"] = {};
  const instructionContent = options.instructionContent;
  if (typeof instructionContent === "string") {
    instructionResults.global = await injectAll([provider], projectDir, "global", instructionContent);
    instructionResults.project = await injectAll([provider], projectDir, "project", instructionContent);
  } else if (instructionContent) {
    if (instructionContent.global) {
      instructionResults.global = await injectAll([provider], projectDir, "global", instructionContent.global);
    }
    if (instructionContent.project) {
      instructionResults.project = await injectAll([provider], projectDir, "project", instructionContent.project);
    }
  }

  return {
    providerId: provider.id,
    configPaths: {
      global: resolveConfigPath(provider, "global", projectDir),
      project: resolveConfigPath(provider, "project", projectDir),
    },
    mcp: {
      global: globalResults,
      project: projectResults,
    },
    instructions: instructionResults,
  };
}
