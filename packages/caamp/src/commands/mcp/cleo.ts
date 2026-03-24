/**
 * CLEO MCP channel commands and compatibility wrappers.
 */

import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import pc from "picocolors";
import {
  ErrorCategories,
  ErrorCodes,
  emitJsonError,
  outputSuccess,
  resolveFormat,
} from "../../core/lafs.js";
import { isHuman } from "../../core/logger.js";
import {
  buildCleoProfile,
  type CleoChannel,
  checkCommandReachability,
  extractVersionTag,
  normalizeCleoChannel,
  parseEnvAssignments,
  resolveChannelFromServerName,
  resolveCleoServerName,
} from "../../core/mcp/cleo.js";
import { installMcpServerToAll } from "../../core/mcp/installer.js";
import { getTrackedMcpServers, recordMcpInstall, removeMcpFromLock } from "../../core/mcp/lock.js";
import { listMcpServers, removeMcpServer } from "../../core/mcp/reader.js";
import { reconcileCleoLock } from "../../core/mcp/reconcile.js";
import { getInstalledProviders } from "../../core/registry/detection.js";
import { getProvider } from "../../core/registry/providers.js";
import type { Provider } from "../../types.js";

interface CleoInstallOptions {
  channel?: string;
  provider: string[];
  all?: boolean;
  global?: boolean;
  version?: string;
  command?: string;
  arg: string[];
  env: string[];
  cleoDir?: string;
  dryRun?: boolean;
  yes?: boolean;
  interactive?: boolean;
  json?: boolean;
  human?: boolean;
}

interface CleoUninstallOptions {
  channel?: string;
  provider: string[];
  all?: boolean;
  global?: boolean;
  dryRun?: boolean;
  json?: boolean;
  human?: boolean;
}

interface CleoShowOptions {
  provider: string[];
  all?: boolean;
  global?: boolean;
  project?: boolean;
  channel?: string;
  json?: boolean;
  human?: boolean;
}

interface CleoRepairOptions {
  provider: string[];
  all?: boolean;
  global?: boolean;
  project?: boolean;
  prune?: boolean;
  dryRun?: boolean;
  json?: boolean;
  human?: boolean;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function collectTargetProviders(providerIds: string[], all?: boolean): Provider[] {
  if (all) {
    return getInstalledProviders();
  }

  if (providerIds.length > 0) {
    return providerIds
      .map((id) => getProvider(id))
      .filter((provider): provider is Provider => provider !== undefined);
  }

  return getInstalledProviders();
}

async function validateProfile(
  provider: Provider,
  scope: "project" | "global",
  serverName: string,
): Promise<{ valid: boolean; reason?: string }> {
  const entries = await listMcpServers(provider, scope);
  const entry = entries.find((candidate) => candidate.name === serverName);
  if (!entry) {
    return { valid: false, reason: "server missing after write" };
  }

  const command = typeof entry.config.command === "string" ? entry.config.command : undefined;
  if (!command) {
    return { valid: true };
  }

  const reachability = checkCommandReachability(command);
  if (!reachability.reachable) {
    return {
      valid: false,
      reason: `command not reachable (${reachability.method}: ${reachability.detail})`,
    };
  }

  return { valid: true };
}

async function detectServerConflicts(
  providers: Provider[],
  scope: "project" | "global",
  targetServerName: string,
): Promise<Array<{ providerId: string; message: string }>> {
  const warnings: Array<{ providerId: string; message: string }> = [];

  for (const provider of providers) {
    const entries = await listMcpServers(provider, scope);
    const existing = entries.find((entry) => entry.name === targetServerName);
    if (!existing) continue;

    const command = typeof existing.config.command === "string" ? existing.config.command : "";
    const args = Array.isArray(existing.config.args)
      ? existing.config.args.filter((value): value is string => typeof value === "string")
      : [];
    const flat = `${command} ${args.join(" ")}`.toLowerCase();

    if (!flat.includes("cleo")) {
      warnings.push({
        providerId: provider.id,
        message: `Server name '${targetServerName}' already exists with a non-CLEO command in ${provider.id}.`,
      });
    }
  }

  return warnings;
}

function formatInstallResultHuman(
  mode: "install" | "update",
  channel: CleoChannel,
  serverName: string,
  scope: "project" | "global",
  results: Awaited<ReturnType<typeof installMcpServerToAll>>,
  validations: Array<{ providerId: string; valid: boolean; reason?: string }>,
): void {
  console.log(pc.bold(`${mode === "install" ? "Install" : "Update"} CLEO channel: ${channel}`));
  console.log(pc.dim(`Server: ${serverName}  Scope: ${scope}`));
  console.log();

  for (const result of results) {
    const validation = validations.find((entry) => entry.providerId === result.provider.id);
    if (result.success) {
      const validationLabel = validation?.valid
        ? pc.green("validated")
        : pc.yellow(`validation warning: ${validation?.reason ?? "unknown"}`);
      console.log(`  ${pc.green("+")} ${result.provider.toolName.padEnd(22)} ${pc.dim(result.configPath)} ${validationLabel}`);
    } else {
      console.log(`  ${pc.red("x")} ${result.provider.toolName.padEnd(22)} ${pc.red(result.error ?? "failed")}`);
      console.log(pc.dim("    Recovery: verify config path permissions and retry with --dry-run."));
    }
  }
  console.log();
}

async function runInteractiveInstall(
  opts: CleoInstallOptions,
): Promise<CleoInstallOptions> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const discovered = getInstalledProviders();
    if (discovered.length === 0) {
      throw new Error("No installed providers were detected for interactive setup.");
    }

    console.log(pc.bold("CLEO MCP Setup"));
    console.log(pc.dim("Step 1/6 - Select provider(s)"));
    for (const [index, provider] of discovered.entries()) {
      console.log(`  ${index + 1}. ${provider.id} (${provider.toolName})`);
    }
    const providerAnswer = await rl.question(pc.dim("Choose providers (e.g. 1,2 or all): "));
    const selectedProviders = providerAnswer.trim().toLowerCase() === "all"
      ? discovered.map((provider) => provider.id)
      : providerAnswer
        .split(",")
        .map((part) => Number(part.trim()))
        .filter((value) => Number.isFinite(value) && value > 0 && value <= discovered.length)
        .map((index) => discovered[index - 1]?.id)
        .filter((id): id is string => Boolean(id));

    if (selectedProviders.length === 0) {
      throw new Error("No providers selected.");
    }

    console.log();
    console.log(pc.dim("Step 2/6 - Select channel"));
    const channelAnswer = await rl.question(pc.dim("Channel [stable/beta/dev] (stable): "));
    const selectedChannel = normalizeCleoChannel(channelAnswer || "stable");

    let command = opts.command;
    let args = [...opts.arg];
    let env = [...opts.env];
    let cleoDir = opts.cleoDir;
    if (selectedChannel === "dev") {
      command = await rl.question(pc.dim("Dev command (required): "));
      const argsAnswer = await rl.question(pc.dim("Dev args (space-separated, optional): "));
      args = argsAnswer.trim() === "" ? [] : argsAnswer.trim().split(/\s+/);
      const dirAnswer = await rl.question(pc.dim("CLEO_DIR (~/.cleo-dev default): "));
      cleoDir = dirAnswer.trim() === "" ? "~/.cleo-dev" : dirAnswer.trim();
      if (cleoDir.trim() !== "") {
        env = [
          ...env.filter((entry) => !entry.startsWith("CLEO_DIR=")),
          `CLEO_DIR=${cleoDir}`,
        ];
      }
    }

    const profile = buildCleoProfile({
      channel: selectedChannel,
      version: opts.version,
      command,
      args,
      env: parseEnvAssignments(env),
      cleoDir,
    });

    console.log();
    console.log(pc.dim("Step 3/6 - Preview profile diff"));
    console.log(`  Server: ${pc.bold(profile.serverName)}`);
    console.log(`  Channel: ${selectedChannel}`);
    console.log(`  Config: ${JSON.stringify(profile.config)}`);

    console.log();
    console.log(pc.dim("Step 4/6 - Confirm apply"));
    const confirm = await rl.question(pc.dim("Apply this configuration? [y/N] "));
    if (!["y", "yes"].includes(confirm.trim().toLowerCase())) {
      throw new Error("Cancelled by user.");
    }

    return {
      ...opts,
      provider: selectedProviders,
      channel: selectedChannel,
      command,
      arg: args,
      env,
      cleoDir,
      yes: true,
    };
  } finally {
    rl.close();
  }
}

/**
 * Executes a CLEO MCP channel install or update operation across targeted providers.
 *
 * @remarks
 * Builds a CLEO profile from the resolved options, writes configuration to all targeted providers,
 * validates the result, and records the install in the lock file. Supports interactive mode and
 * dry-run previews.
 *
 * @param mode - Whether to install a new profile or update an existing one
 * @param opts - CLEO install options including channel, providers, and env configuration
 * @param operation - The LAFS operation identifier for envelope metadata
 * @returns Resolves when the install/update operation completes
 *
 * @example
 * ```bash
 * caamp cleo install --channel stable --all
 * caamp mcp cleo update --channel dev --command ./my-cleo
 * ```
 *
 * @public
 */
export async function executeCleoInstall(
  mode: "install" | "update",
  opts: CleoInstallOptions,
  operation: string,
): Promise<void> {
  const mvi: import("../../core/lafs.js").MVILevel = "standard";

  let format: "json" | "human";
  try {
    format = resolveFormat({
      jsonFlag: opts.json ?? false,
      humanFlag: (opts.human ?? false) || isHuman(),
      projectDefault: "json",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitJsonError(operation, mvi, ErrorCodes.FORMAT_CONFLICT, message, ErrorCategories.VALIDATION);
    process.exit(1);
  }

  const interactive = (opts.interactive ?? false) && format === "human";
  const resolvedOpts = interactive ? await runInteractiveInstall(opts) : opts;

  const channel = normalizeCleoChannel(resolvedOpts.channel);
  const providers = collectTargetProviders(resolvedOpts.provider, resolvedOpts.all);
  if (providers.length === 0) {
    const message = "No target providers found.";
    if (format === "json") {
      emitJsonError(operation, mvi, ErrorCodes.PROVIDER_NOT_FOUND, message, ErrorCategories.NOT_FOUND);
    } else {
      console.error(pc.red(message));
    }
    process.exit(1);
  }

  const envMap = parseEnvAssignments(resolvedOpts.env);
  const profile = buildCleoProfile({
    channel,
    version: resolvedOpts.version,
    command: resolvedOpts.command,
    args: resolvedOpts.arg,
    env: envMap,
    cleoDir: resolvedOpts.cleoDir,
  });

  const scope = resolvedOpts.global ? "global" as const : "project" as const;

  if (resolvedOpts.dryRun) {
    if (format === "human") {
      console.log(pc.bold(`Dry run: ${mode} CLEO (${channel})`));
      console.log(pc.dim(`Server: ${profile.serverName}  Scope: ${scope}`));
      console.log(pc.dim(`Providers: ${providers.map((provider) => provider.id).join(", ")}`));
      console.log(pc.dim(`Command: ${profile.config.command ?? "(none)"} ${(profile.config.args ?? []).join(" ")}`));
      if (profile.config.env && Object.keys(profile.config.env).length > 0) {
        console.log(pc.dim(`Env: ${JSON.stringify(profile.config.env)}`));
      }
    } else {
      outputSuccess(operation, mvi, {
        action: mode,
        channel,
        serverName: profile.serverName,
        providers: providers.map((provider) => provider.id),
        scope,
        command: profile.config.command,
        args: profile.config.args ?? [],
        env: profile.config.env ?? {},
        packageSpec: profile.packageSpec,
        dryRun: true,
      });
    }
    return;
  }

  const conflictWarnings = await detectServerConflicts(providers, scope, profile.serverName);
  if (format === "human" && conflictWarnings.length > 0) {
    console.log(pc.yellow("Warning: potential server name conflicts detected."));
    for (const warning of conflictWarnings) {
      console.log(pc.yellow(`  - ${warning.message}`));
    }
    console.log(pc.dim("Recovery: run with --dry-run, inspect provider config, then retry with explicit channel/profile."));
    console.log();
  }

  const results = await installMcpServerToAll(providers, profile.serverName, profile.config, scope);
  const succeeded = results.filter((result) => result.success);

  const validations: Array<{ providerId: string; valid: boolean; reason?: string }> = [];
  for (const result of succeeded) {
    const validation = await validateProfile(result.provider, scope, profile.serverName);
    validations.push({ providerId: result.provider.id, valid: validation.valid, reason: validation.reason });
  }

  if (succeeded.length > 0) {
    await recordMcpInstall(
      profile.serverName,
      profile.packageSpec ?? resolvedOpts.command ?? "cleo-dev",
      channel === "dev" ? "command" : "package",
      succeeded.map((result) => result.provider.id),
      resolvedOpts.global ?? false,
      resolvedOpts.version ?? extractVersionTag(profile.packageSpec),
    );
  }

  if (format === "human") {
    formatInstallResultHuman(mode, channel, profile.serverName, scope, results, validations);
  }

  const validationFailures = validations.filter((entry) => !entry.valid);
  if (interactive && validationFailures.length > 0 && format === "human") {
    console.log(pc.dim("Step 5/6 - Validation"));
    console.log(pc.yellow(`Validation found ${validationFailures.length} issue(s).`));

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log(pc.dim("Step 6/6 - Rollback"));
      const answer = await rl.question(pc.dim("Rollback failed validations? [y/N] "));
      if (["y", "yes"].includes(answer.trim().toLowerCase())) {
        for (const failure of validationFailures) {
          const provider = providers.find((candidate) => candidate.id === failure.providerId);
          if (!provider) continue;
          await removeMcpServer(provider, profile.serverName, scope);
        }
        console.log(pc.yellow("Rollback completed for failed provider validations."));
      }
    } finally {
      rl.close();
    }
  }

  if (format === "json") {
    outputSuccess(operation, mvi, {
      action: mode,
      channel,
      serverName: profile.serverName,
      scope,
      command: profile.config.command,
      args: profile.config.args ?? [],
      env: profile.config.env ?? {},
      packageSpec: profile.packageSpec,
      providers: results.map((result) => ({
        id: result.provider.id,
        success: result.success,
        configPath: result.configPath,
        error: result.error,
        validation: validations.find((entry) => entry.providerId === result.provider.id) ?? null,
      })),
      conflicts: conflictWarnings,
      validationStatus: validationFailures.length === 0 ? "ok" : "warning",
    });
  }
}

/**
 * Executes a CLEO MCP channel uninstall operation across targeted providers.
 *
 * @remarks
 * Removes the CLEO server entry matching the resolved channel from all targeted provider
 * configurations and cleans up the corresponding lock file entry.
 *
 * @param opts - CLEO uninstall options including channel, providers, and scope
 * @param operation - The LAFS operation identifier for envelope metadata
 * @returns Resolves when the uninstall operation completes
 *
 * @example
 * ```bash
 * caamp cleo uninstall --channel beta --all
 * ```
 *
 * @public
 */
export async function executeCleoUninstall(
  opts: CleoUninstallOptions,
  operation: string,
): Promise<void> {
  const mvi: import("../../core/lafs.js").MVILevel = "standard";

  let format: "json" | "human";
  try {
    format = resolveFormat({
      jsonFlag: opts.json ?? false,
      humanFlag: (opts.human ?? false) || isHuman(),
      projectDefault: "json",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitJsonError(operation, mvi, ErrorCodes.FORMAT_CONFLICT, message, ErrorCategories.VALIDATION);
    process.exit(1);
  }

  const channel = normalizeCleoChannel(opts.channel);
  const serverName = resolveCleoServerName(channel);
  const providers = collectTargetProviders(opts.provider, opts.all);

  if (providers.length === 0) {
    const message = "No target providers found.";
    if (format === "json") {
      emitJsonError(operation, mvi, ErrorCodes.PROVIDER_NOT_FOUND, message, ErrorCategories.NOT_FOUND);
    } else {
      console.error(pc.red(message));
    }
    process.exit(1);
  }

  const scope = opts.global ? "global" as const : "project" as const;
  if (opts.dryRun) {
    if (format === "human") {
      console.log(pc.bold("Dry run: uninstall CLEO profile"));
      console.log(pc.dim(`Server: ${serverName}  Channel: ${channel}  Scope: ${scope}`));
      console.log(pc.dim(`Providers: ${providers.map((provider) => provider.id).join(", ")}`));
    } else {
      outputSuccess(operation, mvi, {
        action: "uninstall",
        channel,
        serverName,
        providers: providers.map((provider) => provider.id),
        scope,
        dryRun: true,
      });
    }
    return;
  }

  const removed: string[] = [];
  for (const provider of providers) {
    const success = await removeMcpServer(provider, serverName, scope);
    if (success) removed.push(provider.id);
  }

  if (removed.length > 0) {
    await removeMcpFromLock(serverName);
  }

  if (format === "human") {
    const prefix = removed.length > 0 ? pc.green("Removed") : pc.yellow("No matching profile found for");
    console.log(`${prefix} ${pc.bold(serverName)} (${channel}) on ${removed.length}/${providers.length} providers.`);
  }

  if (format === "json") {
    outputSuccess(operation, mvi, {
      action: "uninstall",
      channel,
      serverName,
      scope,
      removed,
      providerCount: providers.length,
      dryRun: false,
    });
  }
}

/**
 * Health status of a CLEO MCP entry: healthy, degraded (untracked), or broken (command unreachable).
 *
 * @remarks
 * Used by the show and repair commands to classify the state of each CLEO profile entry.
 *
 * @public
 */
export type CleoHealthStatus = "healthy" | "degraded" | "broken";

/**
 * Health assessment result for a single CLEO MCP entry.
 *
 * @remarks
 * Combines command reachability, config presence, and lock tracking status into an overall health classification.
 *
 * @public
 */
export interface CleoEntryHealth {
  /** Whether the entry's command binary is reachable on the system PATH. */
  commandReachable: boolean;
  /** Detail string describing the reachability check result. */
  commandDetail: string;
  /** Whether the config file containing this entry exists. */
  configPresent: boolean;
  /** Whether this entry is tracked in the CAAMP lock file. */
  lockTracked: boolean;
  /** Overall health status derived from the individual checks. */
  status: CleoHealthStatus;
}

/**
 * Checks the health of a CLEO MCP entry by verifying command reachability and lock tracking.
 *
 * @remarks
 * Returns "healthy" when the command is reachable and the entry is tracked, "degraded" when
 * untracked, and "broken" when the command is not reachable on the system PATH.
 *
 * @param command - The command binary string to check for reachability, or undefined if no command
 * @param lockTracked - Whether this entry is tracked in the CAAMP lock file
 * @returns A health assessment object with status and detail information
 *
 * @example
 * ```typescript
 * const health = checkCleoEntryHealth("npx", true);
 * // health.status === "healthy"
 * ```
 *
 * @public
 */
export function checkCleoEntryHealth(
  command: string | undefined,
  lockTracked: boolean,
): CleoEntryHealth {
  if (!command) {
    return {
      commandReachable: true,
      commandDetail: "(no command)",
      configPresent: true,
      lockTracked,
      status: lockTracked ? "healthy" : "degraded",
    };
  }

  const reachability = checkCommandReachability(command);
  if (!reachability.reachable) {
    return {
      commandReachable: false,
      commandDetail: reachability.detail,
      configPresent: true,
      lockTracked,
      status: "broken",
    };
  }

  return {
    commandReachable: true,
    commandDetail: reachability.detail,
    configPresent: true,
    lockTracked,
    status: lockTracked ? "healthy" : "degraded",
  };
}

/**
 * Executes the CLEO show operation to display installed channel profiles across providers.
 *
 * @remarks
 * Scans provider configurations for CLEO entries, enriches them with lock file metadata and
 * health checks, and outputs a tabular or JSON view of all discovered profiles.
 *
 * @param opts - Show options including provider filter, scope, and channel filter
 * @param operation - The LAFS operation identifier for envelope metadata
 * @returns Resolves when the show output is complete
 *
 * @example
 * ```bash
 * caamp cleo show --channel stable --human
 * ```
 *
 * @public
 */
export async function executeCleoShow(
  opts: CleoShowOptions,
  operation: string,
): Promise<void> {
  const mvi: import("../../core/lafs.js").MVILevel = "standard";

  let format: "json" | "human";
  try {
    format = resolveFormat({
      jsonFlag: opts.json ?? false,
      humanFlag: (opts.human ?? false) || isHuman(),
      projectDefault: "json",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitJsonError(operation, mvi, ErrorCodes.FORMAT_CONFLICT, message, ErrorCategories.VALIDATION);
    process.exit(1);
  }

  const providers = collectTargetProviders(opts.provider, opts.all);
  if (providers.length === 0) {
    const message = "No target providers found.";
    if (format === "json") {
      emitJsonError(operation, mvi, ErrorCodes.PROVIDER_NOT_FOUND, message, ErrorCategories.NOT_FOUND);
    } else {
      console.error(pc.red(message));
    }
    process.exit(1);
  }

  const channelFilter = opts.channel ? normalizeCleoChannel(opts.channel) : null;

  // Determine which scopes to scan
  const scopes: Array<"project" | "global"> = [];
  if (opts.global && !opts.project) {
    scopes.push("global");
  } else if (opts.project && !opts.global) {
    scopes.push("project");
  } else {
    scopes.push("project", "global");
  }

  // Load lock file data
  const lockEntries = await getTrackedMcpServers();

  interface EnrichedProfile {
    provider: string;
    providerName: string;
    serverName: string;
    channel: CleoChannel;
    scope: "project" | "global";
    command?: string;
    args: string[];
    env: Record<string, string>;
    version: string | null;
    source: string | null;
    sourceType: string | null;
    installedAt: string | null;
    updatedAt: string | null;
    health: CleoEntryHealth;
  }

  const entries: EnrichedProfile[] = [];
  const warnings: import("../../core/lafs.js").LAFSWarning[] = [];

  for (const scope of scopes) {
    for (const provider of providers) {
      const providerEntries = await listMcpServers(provider, scope);
      for (const entry of providerEntries) {
        const channel = resolveChannelFromServerName(entry.name);
        if (!channel) continue;
        if (channelFilter && channel !== channelFilter) continue;

        const command = typeof entry.config.command === "string" ? entry.config.command : undefined;
        const args = Array.isArray(entry.config.args)
          ? entry.config.args.filter((value): value is string => typeof value === "string")
          : [];
        const env = typeof entry.config.env === "object" && entry.config.env !== null
          ? entry.config.env as Record<string, string>
          : {};

        const lockEntry = lockEntries[entry.name];
        const lockTracked = lockEntry !== undefined;
        const health = checkCleoEntryHealth(command, lockTracked);

        entries.push({
          provider: provider.id,
          providerName: provider.toolName,
          serverName: entry.name,
          channel,
          scope,
          command,
          args,
          env,
          version: lockEntry?.version ?? null,
          source: lockEntry?.source ?? null,
          sourceType: lockEntry?.sourceType ?? null,
          installedAt: lockEntry?.installedAt ?? null,
          updatedAt: lockEntry?.updatedAt ?? null,
          health,
        });

        if (health.status === "broken") {
          warnings.push({
            code: "W_COMMAND_UNREACHABLE",
            message: `${entry.name} command not reachable on ${provider.toolName} (${health.commandDetail})`,
          });
        } else if (health.status === "degraded") {
          warnings.push({
            code: "W_NOT_TRACKED",
            message: `${entry.name} on ${provider.toolName} is not tracked in lock file`,
          });
        }
      }
    }
  }

  const issueCount = entries.filter((e) => e.health.status !== "healthy").length;

  if (format === "human") {
    if (entries.length === 0) {
      console.log(pc.dim("No CLEO channel profiles found."));
    } else {
      console.log(pc.bold("CLEO Channel Profiles"));
      console.log();

      // Column headers
      const header = [
        "Channel".padEnd(10),
        "Version".padEnd(10),
        "Provider".padEnd(22),
        "Scope".padEnd(9),
        "Command".padEnd(33),
        "Status".padEnd(10),
        "Installed".padEnd(12),
      ].join("");
      console.log(`  ${pc.dim(header)}`);
      console.log(`  ${pc.dim("-".repeat(106))}`);

      for (const entry of entries) {
        const commandStr = entry.command
          ? `${entry.command} ${entry.args.join(" ")}`.slice(0, 31).padEnd(33)
          : pc.dim("-").padEnd(33);
        const versionStr = (entry.version ?? "-").padEnd(10);
        const installedStr = entry.installedAt
          ? entry.installedAt.slice(0, 10).padEnd(12)
          : "-".padEnd(12);

        let statusStr: string;
        if (entry.health.status === "healthy") {
          statusStr = pc.green("healthy".padEnd(10));
        } else if (entry.health.status === "degraded") {
          statusStr = pc.yellow("degraded".padEnd(10));
        } else {
          statusStr = pc.red("broken".padEnd(10));
        }

        console.log(
          `  ${entry.channel.padEnd(10)}${versionStr}${entry.providerName.padEnd(22)}${entry.scope.padEnd(9)}${commandStr}${statusStr}${installedStr}`,
        );
      }

      console.log();
      const summary = `  ${entries.length} profile${entries.length !== 1 ? "s" : ""}`;
      if (issueCount > 0) {
        console.log(`${summary}  |  ${pc.yellow(`${issueCount} issue${issueCount !== 1 ? "s" : ""}`)}`);
        console.log();
        console.log("  Issues:");
        for (const w of warnings) {
          console.log(`    ${pc.yellow("!")} ${w.message}`);
        }
      } else {
        console.log(summary);
      }
    }
  }

  if (format === "json") {
    outputSuccess(
      operation,
      mvi,
      {
        providers: providers.map((provider) => provider.id),
        scopes,
        channel: channelFilter,
        profiles: entries,
        count: entries.length,
      },
      undefined,
      undefined,
      warnings.length > 0 ? warnings : undefined,
    );
  }
}

/**
 * Executes the CLEO repair operation to reconcile lock file entries with actual configurations.
 *
 * @remarks
 * Backfills untracked CLEO entries found in provider configs into the lock file and optionally
 * prunes orphaned lock entries that no longer exist in any config. Supports dry-run mode.
 *
 * @param opts - Repair options including provider filter, scope, prune flag, and dry-run
 * @param operation - The LAFS operation identifier for envelope metadata
 * @returns Resolves when the repair operation completes
 *
 * @example
 * ```bash
 * caamp cleo repair --prune --dry-run
 * ```
 *
 * @public
 */
export async function executeCleoRepair(
  opts: CleoRepairOptions,
  operation: string,
): Promise<void> {
  const mvi: import("../../core/lafs.js").MVILevel = "standard";

  let format: "json" | "human";
  try {
    format = resolveFormat({
      jsonFlag: opts.json ?? false,
      humanFlag: (opts.human ?? false) || isHuman(),
      projectDefault: "json",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitJsonError(operation, mvi, ErrorCodes.FORMAT_CONFLICT, message, ErrorCategories.VALIDATION);
    process.exit(1);
  }

  const providerIds = opts.provider.length > 0 ? opts.provider : undefined;

  const result = await reconcileCleoLock({
    providerIds,
    all: opts.all,
    global: opts.global,
    project: opts.project,
    prune: opts.prune,
    dryRun: opts.dryRun,
  });

  if (format === "human") {
    const prefix = opts.dryRun ? "CLEO Lock Repair (dry run)" : "CLEO Lock Repair";
    console.log(pc.bold(prefix));
    console.log();

    if (result.backfilled.length > 0) {
      for (const entry of result.backfilled) {
        const agents = entry.agents.join(", ");
        const versionStr = entry.version ? `(${entry.version})` : "";
        console.log(
          `  ${pc.green("+")} ${entry.serverName.padEnd(12)}${entry.channel.padEnd(10)}${agents.padEnd(22)}${entry.scope.padEnd(10)}${entry.source}  ${pc.dim(versionStr)}`,
        );
      }
    }

    if (result.pruned.length > 0) {
      for (const name of result.pruned) {
        console.log(`  ${pc.red("-")} ${name} (removed from lock)`);
      }
    }

    if (result.backfilled.length === 0 && result.pruned.length === 0) {
      console.log(pc.dim("  No changes needed. All CLEO entries are tracked."));
    }

    console.log();
    console.log(
      `  ${result.backfilled.length} backfilled  |  ${result.pruned.length} pruned  |  ${result.alreadyTracked} already tracked`,
    );

    if (result.errors.length > 0) {
      console.log();
      for (const err of result.errors) {
        console.log(`  ${pc.red("!")} ${err.message}`);
      }
    }
  }

  if (format === "json") {
    outputSuccess(operation, mvi, {
      backfilled: result.backfilled,
      pruned: result.pruned,
      alreadyTracked: result.alreadyTracked,
      dryRun: opts.dryRun ?? false,
      errors: result.errors,
    });
  }
}

function buildInstallOptions(command: Command): Command {
  return command
    .requiredOption("--channel <channel>", "CLEO channel: stable|beta|dev")
    .option("--provider <id>", "Target provider (repeatable)", collect, [])
    .option("--all", "Apply to all detected providers")
    .option("-g, --global", "Use global scope")
    .option("--version <tag>", "Tag/version for stable or beta")
    .option("--command <command>", "Dev channel command")
    .option("--arg <arg>", "Dev command arg (repeatable)", collect, [])
    .option("--env <kv>", "Environment assignment KEY=value (repeatable)", collect, [])
    .option("--cleo-dir <path>", "CLEO_DIR override for dev channel")
    .option("--dry-run", "Preview without writing")
    .option("-y, --yes", "Skip confirmation")
    .option("--interactive", "Guided interactive setup")
    .option("--json", "Output as JSON (default)")
    .option("--human", "Output in human-readable format");
}

/**
 * Registers the `mcp cleo` subcommand group with install, update, uninstall, show, and repair.
 *
 * @remarks
 * Provides the nested `mcp cleo` command tree for managing CLEO channel profiles within
 * the MCP command group.
 *
 * @param parent - The parent `mcp` Command to attach the cleo subcommand group to
 *
 * @example
 * ```bash
 * caamp mcp cleo install --channel stable --all
 * caamp mcp cleo show --human
 * ```
 *
 * @public
 */
export function registerMcpCleoCommands(parent: Command): void {
  const cleo = parent
    .command("cleo")
    .description("Manage CLEO MCP channel profiles");

  buildInstallOptions(
    cleo
      .command("install")
      .description("Install CLEO MCP profile by channel"),
  ).action(async (opts: CleoInstallOptions) => {
    await executeCleoInstall("install", opts, "mcp.cleo.install");
  });

  buildInstallOptions(
    cleo
      .command("update")
      .description("Update CLEO MCP profile by channel"),
  ).action(async (opts: CleoInstallOptions) => {
    await executeCleoInstall("update", opts, "mcp.cleo.update");
  });

  cleo
    .command("uninstall")
    .description("Uninstall CLEO MCP profile for a channel")
    .requiredOption("--channel <channel>", "CLEO channel: stable|beta|dev")
    .option("--provider <id>", "Target provider (repeatable)", collect, [])
    .option("--all", "Apply to all detected providers")
    .option("-g, --global", "Use global scope")
    .option("--dry-run", "Preview without writing")
    .option("--json", "Output as JSON (default)")
    .option("--human", "Output in human-readable format")
    .action(async (opts: CleoUninstallOptions) => {
      await executeCleoUninstall(opts, "mcp.cleo.uninstall");
    });

  cleo
    .command("show")
    .description("Show installed CLEO MCP channel profiles")
    .option("--provider <id>", "Target provider (repeatable)", collect, [])
    .option("--all", "Inspect all detected providers")
    .option("-g, --global", "Global scope only")
    .option("-p, --project", "Project scope only")
    .option("--channel <channel>", "Filter channel: stable|beta|dev")
    .option("--json", "Output as JSON (default)")
    .option("--human", "Output in human-readable format")
    .action(async (opts: CleoShowOptions) => {
      await executeCleoShow(opts, "mcp.cleo.show");
    });

  cleo
    .command("repair")
    .description("Repair lock file by backfilling untracked CLEO entries")
    .option("--provider <id>", "Target provider (repeatable)", collect, [])
    .option("--all", "Scan all detected providers")
    .option("-g, --global", "Global scope only")
    .option("-p, --project", "Project scope only")
    .option("--prune", "Remove orphaned lock entries not in any config")
    .option("--dry-run", "Preview without writing")
    .option("--json", "Output as JSON (default)")
    .option("--human", "Output in human-readable format")
    .action(async (opts: CleoRepairOptions) => {
      await executeCleoRepair(opts, "mcp.cleo.repair");
    });
}

/**
 * Registers backward-compatible update, uninstall, and show commands directly on the `mcp` parent.
 *
 * @remarks
 * Provides `mcp update cleo`, `mcp uninstall cleo`, and `mcp show cleo` as aliases for the
 * nested `mcp cleo` subcommands. Only the "cleo" managed profile name is supported.
 *
 * @param parent - The parent `mcp` Command to attach the compatibility commands to
 *
 * @example
 * ```bash
 * caamp mcp update cleo --channel stable
 * caamp mcp uninstall cleo --channel dev
 * ```
 *
 * @public
 */
export function registerMcpCleoCompatibilityCommands(parent: Command): void {
  parent
    .command("update")
    .description("Update channel-managed MCP profile")
    .argument("<name>", "Managed MCP profile name (cleo)")
    .requiredOption("--channel <channel>", "CLEO channel: stable|beta|dev")
    .option("--provider <id>", "Target provider (repeatable)", collect, [])
    .option("--all", "Apply to all detected providers")
    .option("-g, --global", "Use global scope")
    .option("--version <tag>", "Tag/version for stable or beta")
    .option("--command <command>", "Dev channel command")
    .option("--arg <arg>", "Dev command arg (repeatable)", collect, [])
    .option("--env <kv>", "Environment assignment KEY=value (repeatable)", collect, [])
    .option("--cleo-dir <path>", "CLEO_DIR override for dev channel")
    .option("--dry-run", "Preview without writing")
    .option("--json", "Output as JSON (default)")
    .option("--human", "Output in human-readable format")
    .action(async (name: string, opts: CleoInstallOptions) => {
      if (name !== "cleo") {
        emitJsonError("mcp.update", "standard", ErrorCodes.INVALID_INPUT, "Only managed profile 'cleo' is supported by mcp update.", ErrorCategories.VALIDATION, { name });
        process.exit(1);
      }
      await executeCleoInstall("update", opts, "mcp.update");
    });

  parent
    .command("uninstall")
    .description("Uninstall channel-managed MCP profile")
    .argument("<name>", "Managed MCP profile name (cleo)")
    .requiredOption("--channel <channel>", "CLEO channel: stable|beta|dev")
    .option("--provider <id>", "Target provider (repeatable)", collect, [])
    .option("--all", "Apply to all detected providers")
    .option("-g, --global", "Use global scope")
    .option("--dry-run", "Preview without writing")
    .option("--json", "Output as JSON (default)")
    .option("--human", "Output in human-readable format")
    .action(async (name: string, opts: CleoUninstallOptions) => {
      if (name !== "cleo") {
        emitJsonError("mcp.uninstall", "standard", ErrorCodes.INVALID_INPUT, "Only managed profile 'cleo' is supported by mcp uninstall.", ErrorCategories.VALIDATION, { name });
        process.exit(1);
      }
      await executeCleoUninstall(opts, "mcp.uninstall");
    });

  parent
    .command("show")
    .description("Show channel-managed MCP profile")
    .argument("<name>", "Managed MCP profile name (cleo)")
    .option("--provider <id>", "Target provider (repeatable)", collect, [])
    .option("--all", "Inspect all detected providers")
    .option("-g, --global", "Global scope only")
    .option("-p, --project", "Project scope only")
    .option("--channel <channel>", "Filter channel: stable|beta|dev")
    .option("--json", "Output as JSON (default)")
    .option("--human", "Output in human-readable format")
    .action(async (name: string, opts: CleoShowOptions) => {
      if (name !== "cleo") {
        emitJsonError("mcp.show", "standard", ErrorCodes.INVALID_INPUT, "Only managed profile 'cleo' is supported by mcp show.", ErrorCategories.VALIDATION, { name });
        process.exit(1);
      }
      await executeCleoShow(opts, "mcp.show");
    });
}

/**
 * Maps generic MCP install CLI options to CLEO-specific install options for compatibility routing.
 *
 * @remarks
 * Merges the `--agent` and `--provider` flags into a single provider list and provides defaults
 * for array fields. Used when `mcp install cleo --channel ...` is detected.
 *
 * @param opts - The raw CLI options from the mcp install command
 * @returns A normalized CleoInstallOptions object ready for executeCleoInstall
 *
 * @example
 * ```typescript
 * const cleoOpts = mapCompatibilityInstallOptions(rawOpts);
 * await executeCleoInstall("install", cleoOpts, "mcp.install");
 * ```
 *
 * @public
 */
export function mapCompatibilityInstallOptions(
  opts: {
    channel?: string;
    provider?: string[];
    agent?: string[];
    all?: boolean;
    global?: boolean;
    version?: string;
    command?: string;
    arg?: string[];
    env?: string[];
    cleoDir?: string;
    dryRun?: boolean;
    yes?: boolean;
    interactive?: boolean;
    json?: boolean;
    human?: boolean;
  },
): CleoInstallOptions {
  return {
    channel: opts.channel,
    provider: [...(opts.provider ?? []), ...(opts.agent ?? [])],
    all: opts.all,
    global: opts.global,
    version: opts.version,
    command: opts.command,
    arg: opts.arg ?? [],
    env: opts.env ?? [],
    cleoDir: opts.cleoDir,
    dryRun: opts.dryRun,
    yes: opts.yes,
    interactive: opts.interactive,
    json: opts.json,
    human: opts.human,
  };
}

/**
 * Determines whether an MCP install command should be routed to the CLEO compatibility handler.
 *
 * @remarks
 * Returns true when the source argument is "cleo" (case-insensitive) and a non-empty channel flag is provided.
 *
 * @param source - The source argument from the mcp install command
 * @param channel - The optional channel flag value
 * @returns True if the install should be handled by the CLEO compatibility path
 *
 * @example
 * ```typescript
 * shouldUseCleoCompatibilityInstall("cleo", "stable"); // true
 * shouldUseCleoCompatibilityInstall("https://example.com", "stable"); // false
 * ```
 *
 * @public
 */
export function shouldUseCleoCompatibilityInstall(source: string, channel?: string): boolean {
  if (source.trim().toLowerCase() !== "cleo") return false;
  return typeof channel === "string" && channel.trim() !== "";
}

/**
 * Registers the top-level `cleo` command group with install, update, uninstall, show, and repair.
 *
 * @remarks
 * Provides `caamp cleo ...` as a top-level alternative to `caamp mcp cleo ...` for convenience.
 * Both command paths delegate to the same underlying execution functions.
 *
 * @param program - The root Commander program to attach the cleo command group to
 *
 * @example
 * ```bash
 * caamp cleo install --channel stable --all
 * caamp cleo show --human
 * caamp cleo repair --prune
 * ```
 *
 * @public
 */
export function registerCleoCommands(program: Command): void {
  const cleo = program
    .command("cleo")
    .description("Manage CLEO channel profiles");

  buildInstallOptions(
    cleo
      .command("install")
      .description("Install CLEO profile by channel"),
  ).action(async (opts: CleoInstallOptions) => {
    await executeCleoInstall("install", opts, "cleo.install");
  });

  buildInstallOptions(
    cleo
      .command("update")
      .description("Update CLEO profile by channel"),
  ).action(async (opts: CleoInstallOptions) => {
    await executeCleoInstall("update", opts, "cleo.update");
  });

  cleo
    .command("uninstall")
    .description("Uninstall CLEO profile for a channel")
    .requiredOption("--channel <channel>", "CLEO channel: stable|beta|dev")
    .option("--provider <id>", "Target provider (repeatable)", collect, [])
    .option("--all", "Apply to all detected providers")
    .option("-g, --global", "Use global scope")
    .option("--dry-run", "Preview without writing")
    .option("--json", "Output as JSON (default)")
    .option("--human", "Output in human-readable format")
    .action(async (opts: CleoUninstallOptions) => {
      await executeCleoUninstall(opts, "cleo.uninstall");
    });

  cleo
    .command("show")
    .description("Show installed CLEO channel profiles")
    .option("--provider <id>", "Target provider (repeatable)", collect, [])
    .option("--all", "Inspect all detected providers")
    .option("-g, --global", "Global scope only")
    .option("-p, --project", "Project scope only")
    .option("--channel <channel>", "Filter channel: stable|beta|dev")
    .option("--json", "Output as JSON (default)")
    .option("--human", "Output in human-readable format")
    .action(async (opts: CleoShowOptions) => {
      await executeCleoShow(opts, "cleo.show");
    });

  cleo
    .command("repair")
    .description("Repair lock file by backfilling untracked CLEO entries")
    .option("--provider <id>", "Target provider (repeatable)", collect, [])
    .option("--all", "Scan all detected providers")
    .option("-g, --global", "Global scope only")
    .option("-p, --project", "Project scope only")
    .option("--prune", "Remove orphaned lock entries not in any config")
    .option("--dry-run", "Preview without writing")
    .option("--json", "Output as JSON (default)")
    .option("--human", "Output in human-readable format")
    .action(async (opts: CleoRepairOptions) => {
      await executeCleoRepair(opts, "cleo.repair");
    });
}

export { resolveCleoServerName };
