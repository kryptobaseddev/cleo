/**
 * CLEO MCP channel profile helpers.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { McpServerConfig } from "../../types.js";

/**
 * CLEO release channel identifier.
 *
 * @remarks
 * Determines which version stream is used: `"stable"` for production releases,
 * `"beta"` for pre-release versions, and `"dev"` for local development builds.
 *
 * @public
 */
export type CleoChannel = "stable" | "beta" | "dev";

/**
 * Mapping of CLEO channels to their MCP server names.
 *
 * @remarks
 * Each channel has a distinct server name to allow multiple channels to
 * coexist in the same MCP configuration without conflicting.
 *
 * @public
 */
export const CLEO_SERVER_NAMES: Record<CleoChannel, string> = {
  stable: "cleo",
  beta: "cleo-beta",
  dev: "cleo-dev",
};

/**
 * The npm package name for the CLEO MCP server.
 *
 * @remarks
 * Used as the base package specifier when constructing npx commands
 * for stable and beta channel installations.
 *
 * @public
 */
export const CLEO_MCP_NPM_PACKAGE = "@cleocode/cleo";

/**
 * Default directory path for CLEO dev channel data.
 *
 * @remarks
 * Expanded from `~` at runtime. Used as the `CLEO_DIR` environment
 * variable when no explicit directory is provided for dev channel profiles.
 *
 * @public
 */
export const CLEO_DEV_DIR_DEFAULT = "~/.cleo-dev";

/**
 * Options for building a CLEO MCP server profile configuration.
 *
 * @remarks
 * For stable and beta channels, the `version` field controls the npm package
 * version. For the dev channel, `command` is required to specify the local
 * binary path or command.
 *
 * @public
 */
export interface CleoProfileBuildOptions {
  /** The CLEO release channel to target. */
  channel: CleoChannel;
  /** Optional npm version tag or semver range for stable/beta channels. */
  version?: string;
  /** Custom command binary for dev channel, required when channel is `"dev"`. */
  command?: string;
  /** Additional arguments to pass to the command. */
  args?: string[];
  /** Environment variables to set in the MCP server config. */
  env?: Record<string, string>;
  /** Custom CLEO directory path for dev channel, overrides default. */
  cleoDir?: string;
}

/**
 * Result of building a CLEO MCP server profile configuration.
 *
 * @remarks
 * Contains the resolved channel, server name, and MCP configuration.
 * For stable/beta channels, `packageSpec` contains the npm package
 * specifier used in the npx command.
 *
 * @public
 */
export interface CleoProfileBuildResult {
  /** The resolved CLEO release channel. */
  channel: CleoChannel;
  /** The MCP server name for this channel. */
  serverName: string;
  /** The MCP server configuration ready for installation. */
  config: McpServerConfig;
  /** The npm package specifier, present for stable/beta channels. */
  packageSpec?: string;
}

/**
 * Result of checking whether a command is reachable on the system.
 *
 * @remarks
 * The `method` field indicates whether the command was checked as a filesystem
 * path or via system PATH lookup (using `which`/`where`).
 *
 * @public
 */
export interface CommandReachability {
  /** Whether the command was found and is reachable. */
  reachable: boolean;
  /** The method used to check reachability. */
  method: "path" | "lookup";
  /** The resolved path or command name that was checked. */
  detail: string;
}

/**
 * Normalizes a string value to a valid CLEO channel identifier.
 *
 * @remarks
 * Trims and lowercases the input, then validates it against the known
 * channel names. Returns `"stable"` for empty or undefined input.
 * Throws if the value is not a recognized channel.
 *
 * @param value - The raw channel string to normalize
 * @returns The normalized CLEO channel
 * @throws Error if the value is not `"stable"`, `"beta"`, or `"dev"`
 *
 * @example
 * ```typescript
 * const channel = normalizeCleoChannel("Beta");
 * // returns "beta"
 * ```
 *
 * @public
 */
export function normalizeCleoChannel(value?: string): CleoChannel {
  if (!value || value.trim() === "") return "stable";
  const normalized = value.trim().toLowerCase();
  if (normalized === "stable" || normalized === "beta" || normalized === "dev") {
    return normalized;
  }
  throw new Error(`Invalid channel \"${value}\". Expected stable, beta, or dev.`);
}

/**
 * Resolves the MCP server name for a given CLEO channel.
 *
 * @remarks
 * Maps channel identifiers to their corresponding server names
 * using the {@link CLEO_SERVER_NAMES} registry.
 *
 * @param channel - The CLEO channel to resolve
 * @returns The MCP server name for the channel
 *
 * @example
 * ```typescript
 * const name = resolveCleoServerName("stable");
 * // returns "cleo"
 * ```
 *
 * @public
 */
export function resolveCleoServerName(channel: CleoChannel): string {
  return CLEO_SERVER_NAMES[channel];
}

/**
 * Resolves a CLEO channel from an MCP server name.
 *
 * @remarks
 * Performs a reverse lookup from server name to channel. Returns null
 * if the server name does not match any known CLEO channel.
 *
 * @param serverName - The MCP server name to look up
 * @returns The matching CLEO channel, or null if not a CLEO server
 *
 * @example
 * ```typescript
 * const channel = resolveChannelFromServerName("cleo-beta");
 * // returns "beta"
 * ```
 *
 * @public
 */
export function resolveChannelFromServerName(serverName: string): CleoChannel | null {
  if (serverName === CLEO_SERVER_NAMES.stable) return "stable";
  if (serverName === CLEO_SERVER_NAMES.beta) return "beta";
  if (serverName === CLEO_SERVER_NAMES.dev) return "dev";
  return null;
}

function splitCommand(command: string, explicitArgs: string[] = []): { command: string; args: string[] } {
  if (explicitArgs.length > 0) {
    return { command, args: explicitArgs };
  }
  const parts = command.trim().split(/\s+/);
  const binary = parts[0] ?? "";
  if (!binary) {
    throw new Error("Command is required for dev channel.");
  }
  return {
    command: binary,
    args: parts.slice(1),
  };
}

function normalizeEnv(
  env: Record<string, string> | undefined,
  channel: CleoChannel,
  cleoDir?: string,
): Record<string, string> | undefined {
  const result = { ...(env ?? {}) };
  if (channel === "dev" && !result.CLEO_DIR) {
    result.CLEO_DIR = cleoDir ?? CLEO_DEV_DIR_DEFAULT;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function resolvePackageSpec(channel: CleoChannel, version?: string): string {
  const tag = version?.trim() || (channel === "stable" ? "latest" : "beta");
  return `${CLEO_MCP_NPM_PACKAGE}@${tag}`;
}

/**
 * Builds a CLEO MCP server profile configuration from options.
 *
 * @remarks
 * For the dev channel, constructs a config using the provided command and args.
 * For stable/beta channels, constructs an npx-based config with the appropriate
 * package specifier. Dev channel requires a command; stable/beta use npx with
 * the `@cleocode/cleo` package.
 *
 * @param options - The profile build options specifying channel, command, version, etc.
 * @returns The built profile with server name, config, and optional package spec
 * @throws Error if dev channel is selected without a command
 *
 * @example
 * ```typescript
 * const profile = buildCleoProfile({ channel: "stable" });
 * // profile.config.command === "npx"
 * // profile.config.args === ["-y", "@cleocode/cleo@latest", "mcp"]
 * ```
 *
 * @public
 */
export function buildCleoProfile(options: CleoProfileBuildOptions): CleoProfileBuildResult {
  const channel = options.channel;
  const serverName = resolveCleoServerName(channel);

  if (channel === "dev") {
    if (!options.command || options.command.trim() === "") {
      throw new Error("Dev channel requires --command.");
    }

    const parsed = splitCommand(options.command, options.args ?? []);
    const env = normalizeEnv(options.env, channel, options.cleoDir);
    return {
      channel,
      serverName,
      config: {
        command: parsed.command,
        args: parsed.args,
        ...(env ? { env } : {}),
      },
    };
  }

  const packageSpec = resolvePackageSpec(channel, options.version);
  return {
    channel,
    serverName,
    packageSpec,
    config: {
      command: "npx",
      args: ["-y", packageSpec, "mcp"],
    },
  };
}

function expandHome(pathValue: string): string {
  if (pathValue === "~") return homedir();
  if (pathValue.startsWith("~/")) {
    return resolve(homedir(), pathValue.slice(2));
  }
  return pathValue;
}

/**
 * Checks whether a command binary is reachable on the current system.
 *
 * @remarks
 * If the command contains path separators or starts with `~`, it is treated
 * as a filesystem path and checked with `existsSync`. Otherwise, a system
 * PATH lookup is performed using `which` (Unix) or `where` (Windows).
 *
 * @param command - The command or path to check for reachability
 * @returns A reachability result indicating whether the command was found
 *
 * @example
 * ```typescript
 * const result = checkCommandReachability("node");
 * if (result.reachable) {
 *   console.log("Found via", result.method);
 * }
 * ```
 *
 * @public
 */
export function checkCommandReachability(command: string): CommandReachability {
  const hasPathSeparator = command.includes("/") || command.includes("\\");
  if (hasPathSeparator || command.startsWith("~")) {
    const expanded = expandHome(command);
    const candidate = isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
    if (existsSync(candidate)) {
      return { reachable: true, method: "path", detail: candidate };
    }
    return { reachable: false, method: "path", detail: candidate };
  }

  try {
    const lookup = process.platform === "win32" ? "where" : "which";
    execFileSync(lookup, [command], { stdio: "pipe" });
    return { reachable: true, method: "lookup", detail: command };
  } catch {
    return { reachable: false, method: "lookup", detail: command };
  }
}

/**
 * Parses an array of `KEY=value` strings into an environment variable record.
 *
 * @remarks
 * Each string must contain an `=` separator with a non-empty key.
 * Throws on malformed entries. Whitespace around keys and values is trimmed.
 *
 * @param values - Array of `KEY=value` assignment strings
 * @returns A record mapping environment variable names to their values
 * @throws Error if any assignment is malformed (missing `=` or empty key)
 *
 * @example
 * ```typescript
 * const env = parseEnvAssignments(["NODE_ENV=production", "PORT=3000"]);
 * // returns { NODE_ENV: "production", PORT: "3000" }
 * ```
 *
 * @public
 */
export function parseEnvAssignments(values: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const value of values) {
    const idx = value.indexOf("=");
    if (idx <= 0) {
      throw new Error(`Invalid --env value \"${value}\". Use KEY=value.`);
    }
    const key = value.slice(0, idx).trim();
    const val = value.slice(idx + 1).trim();
    if (!key) {
      throw new Error(`Invalid --env value \"${value}\". Key cannot be empty.`);
    }
    env[key] = val;
  }
  return env;
}

/**
 * Extracts the version tag from an npm package specifier string.
 *
 * @remarks
 * Splits on the last `@` character to separate the package name from
 * the version tag. Returns undefined if no version tag is present or
 * the input is falsy.
 *
 * @param packageSpec - The npm package specifier, e.g., `"@cleocode/cleo@1.2.0"`
 * @returns The extracted version tag, or undefined if not present
 *
 * @example
 * ```typescript
 * const tag = extractVersionTag("@cleocode/cleo@1.2.0");
 * // returns "1.2.0"
 * ```
 *
 * @public
 */
export function extractVersionTag(packageSpec?: string): string | undefined {
  if (!packageSpec) return undefined;
  const atIndex = packageSpec.lastIndexOf("@");
  if (atIndex <= 0) return undefined;
  return packageSpec.slice(atIndex + 1);
}

/**
 * Checks whether a source string identifies a CLEO MCP installation.
 *
 * @remarks
 * Performs a case-insensitive comparison after trimming whitespace.
 * Returns true only when the source is exactly `"cleo"`.
 *
 * @param source - The source identifier string to check
 * @returns True if the source represents a CLEO installation
 *
 * @example
 * ```typescript
 * isCleoSource("cleo");  // true
 * isCleoSource("Cleo");  // true
 * isCleoSource("other"); // false
 * ```
 *
 * @public
 */
export function isCleoSource(source: string): boolean {
  return source.trim().toLowerCase() === "cleo";
}
