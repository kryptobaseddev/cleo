/**
 * Core MCP server config management module.
 *
 * @remarks
 * Barrel export for the reader, installer, and remover used by the
 * `caamp mcp` command group. Each submodule operates against a
 * provider's `capabilities.mcp` block via the format-agnostic
 * `core/formats` substrate, so this layer is provider-agnostic and
 * does NOT speak the MCP protocol — it just edits `mcpServers`-style
 * config entries inside other tools' files.
 *
 * @packageDocumentation
 */

export type {
  InstallMcpServerOptions,
  InstallMcpServerResult,
} from './installer.js';
export { installMcpServer } from './installer.js';
export type {
  McpDetectionEntry,
  McpScope,
  McpServerEntriesByProvider,
} from './reader.js';
export {
  detectMcpInstallations,
  listAllMcpServers,
  listMcpServers,
  resolveMcpConfigPath,
} from './reader.js';

export type {
  RemoveMcpServerOptions,
  RemoveMcpServerResult,
} from './remover.js';
export { removeMcpServer, removeMcpServerFromAll } from './remover.js';
