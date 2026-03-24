/**
 * Per-agent MCP config transformations
 *
 * Most agents use the canonical McpServerConfig directly.
 * These transforms handle agents with non-standard schemas.
 */

import type { McpServerConfig } from "../../types.js";

/**
 * Transform a canonical MCP server config into the Goose YAML extensions format.
 *
 * @remarks
 * Goose uses a YAML-based extensions format with `name`, `type`, and `uri`/`cmd` fields
 * instead of the standard `mcpServers` JSON structure. Remote servers use `sse` or
 * `streamable_http` transport types, while stdio servers use `type: "stdio"` with
 * `cmd` and `args` fields. Environment variables are mapped to `envs`.
 *
 * @param serverName - Display name for the server in Goose config
 * @param config - Canonical MCP server configuration to transform
 * @returns Goose-formatted server configuration object
 *
 * @example
 * ```typescript
 * const gooseConfig = transformGoose("filesystem", {
 *   command: "npx",
 *   args: ["-y", "@modelcontextprotocol/server-filesystem"],
 * });
 * // { name: "filesystem", type: "stdio", cmd: "npx", args: [...], enabled: true, timeout: 300 }
 * ```
 *
 * @public
 */
export function transformGoose(serverName: string, config: McpServerConfig): unknown {
  if (config.url) {
    // Remote server
    const transport = config.type === "sse" ? "sse" : "streamable_http";
    return {
      name: serverName,
      type: transport,
      uri: config.url,
      ...(config.headers ? { headers: config.headers } : {}),
      enabled: true,
      timeout: 300,
    };
  }

  // Stdio server
  return {
    name: serverName,
    type: "stdio",
    cmd: config.command,
    args: config.args ?? [],
    ...(config.env ? { envs: config.env } : {}),
    enabled: true,
    timeout: 300,
  };
}

/**
 * Transform a canonical MCP server config into the Zed context_servers format.
 *
 * @remarks
 * Zed uses a `context_servers` key with `source: "custom"` and either a `url` for
 * remote servers or `command`/`args` for stdio servers. The server name is not included
 * in the config body since it is used as the object key in the parent map.
 *
 * @param _serverName - Server name (unused, Zed uses it as the object key externally)
 * @param config - Canonical MCP server configuration to transform
 * @returns Zed-formatted server configuration object
 *
 * @example
 * ```typescript
 * const zedConfig = transformZed("filesystem", {
 *   command: "npx",
 *   args: ["-y", "@modelcontextprotocol/server-filesystem"],
 * });
 * // { source: "custom", command: "npx", args: [...] }
 * ```
 *
 * @public
 */
export function transformZed(_serverName: string, config: McpServerConfig): unknown {
  if (config.url) {
    return {
      source: "custom",
      type: config.type ?? "http",
      url: config.url,
      ...(config.headers ? { headers: config.headers } : {}),
    };
  }

  return {
    source: "custom",
    command: config.command,
    args: config.args ?? [],
    ...(config.env ? { env: config.env } : {}),
  };
}

/**
 * Transform a canonical MCP server config into the OpenCode mcp format.
 *
 * @remarks
 * OpenCode uses a flat `mcp` key with `type: "local"` or `type: "remote"`. Local servers
 * combine `command` and `args` into a single `command` array. Environment variables are
 * mapped to the `environment` field instead of `env`.
 *
 * @param _serverName - Server name (unused, OpenCode uses it as the object key externally)
 * @param config - Canonical MCP server configuration to transform
 * @returns OpenCode-formatted server configuration object
 *
 * @example
 * ```typescript
 * const openCodeConfig = transformOpenCode("filesystem", {
 *   command: "npx",
 *   args: ["-y", "@modelcontextprotocol/server-filesystem"],
 * });
 * // { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-filesystem"], enabled: true }
 * ```
 *
 * @public
 */
export function transformOpenCode(_serverName: string, config: McpServerConfig): unknown {
  if (config.url) {
    return {
      type: "remote",
      url: config.url,
      enabled: true,
      ...(config.headers ? { headers: config.headers } : {}),
    };
  }

  return {
    type: "local",
    command: [config.command, ...(config.args ?? [])],
    enabled: true,
    ...(config.env ? { environment: config.env } : {}),
  };
}

/**
 * Transform a canonical MCP server config into the Codex TOML mcp_servers format.
 *
 * @remarks
 * Codex uses a TOML-based `mcp_servers` key. Remote servers include `type` and `url`,
 * while stdio servers use `command`/`args`/`env` fields without a `type` discriminator.
 *
 * @param _serverName - Server name (unused, Codex uses it as the TOML table key externally)
 * @param config - Canonical MCP server configuration to transform
 * @returns Codex-formatted server configuration object
 *
 * @example
 * ```typescript
 * const codexConfig = transformCodex("filesystem", {
 *   command: "npx",
 *   args: ["-y", "@modelcontextprotocol/server-filesystem"],
 * });
 * // { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] }
 * ```
 *
 * @public
 */
export function transformCodex(_serverName: string, config: McpServerConfig): unknown {
  if (config.url) {
    return {
      type: config.type ?? "http",
      url: config.url,
      ...(config.headers ? { headers: config.headers } : {}),
    };
  }

  return {
    command: config.command,
    args: config.args ?? [],
    ...(config.env ? { env: config.env } : {}),
  };
}

/**
 * Transform a canonical MCP server config into the Cursor mcpServers format.
 *
 * @remarks
 * Cursor uses the standard `mcpServers` key but strips the `type` field from remote
 * server configs, keeping only `url` and optional `headers`. Stdio configs pass
 * through unchanged since they already match the expected format.
 *
 * @param _serverName - Server name (unused, Cursor uses it as the object key externally)
 * @param config - Canonical MCP server configuration to transform
 * @returns Cursor-formatted server configuration object
 *
 * @example
 * ```typescript
 * const cursorConfig = transformCursor("remote-server", {
 *   type: "http",
 *   url: "https://mcp.example.com",
 * });
 * // { url: "https://mcp.example.com" }
 * ```
 *
 * @public
 */
export function transformCursor(_serverName: string, config: McpServerConfig): unknown {
  if (config.url) {
    return {
      url: config.url,
      ...(config.headers ? { headers: config.headers } : {}),
    };
  }

  // Stdio passthrough
  return config;
}

/**
 * Get the config transform function for a provider, or `undefined` for passthrough.
 *
 * Providers with non-standard MCP config schemas (Goose, Zed, OpenCode, Codex, Cursor)
 * require transforms to convert the canonical {@link McpServerConfig} into their
 * provider-specific format.
 *
 * @remarks
 * Five of the 28+ supported providers use non-standard MCP config schemas.
 * This function acts as a registry of transform functions, returning `undefined`
 * for providers that accept the canonical format directly (the majority).
 * The returned function takes a server name and canonical config and produces
 * the provider-specific shape.
 *
 * @param providerId - Provider ID to look up (e.g. `"goose"`, `"zed"`)
 * @returns Transform function, or `undefined` if the provider uses the canonical format
 *
 * @example
 * ```typescript
 * const transform = getTransform("goose");
 * if (transform) {
 *   const gooseConfig = transform("my-server", { command: "npx", args: ["-y", "@mcp/server"] });
 * }
 * ```
 *
 * @see {@link transformGoose}
 * @see {@link transformZed}
 *
 * @public
 */
export function getTransform(
  providerId: string,
): ((name: string, config: McpServerConfig) => unknown) | undefined {
  switch (providerId) {
    case "goose":
      return transformGoose;
    case "zed":
      return transformZed;
    case "opencode":
      return transformOpenCode;
    case "codex":
      return transformCodex;
    case "cursor":
      return transformCursor;
    default:
      return undefined;
  }
}
