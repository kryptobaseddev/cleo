# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0] - 2026-02-11

### Added

- Unified provider registry with 28 AI coding agent definitions (T002)
- Provider auto-detection engine supporting binary, directory, appBundle, and flatpak methods (T003)
- Config format handlers for JSON/JSONC (with comment preservation), YAML, and TOML (T004)
- MCP server config installer with provider-specific format transforms (T005)
- Lock file management for tracking MCP servers and skills at ~/.agents/.caamp-lock.json (T006)
- Skills installer (canonical + symlink model), discovery, validator, and audit scanner with SARIF output (T007)
- Source parser for GitHub, npm, URL, local, and command sources (T008)
- Instructions injection system for agent config files with CLEO-style marker blocks (T009)
- Marketplace client for skill discovery and search (T010)
- Full CLI with commander.js: providers, mcp, skills, instructions, and marketplace commands (T011)
- Library API: src/core/mcp/reader.ts with resolveConfigPath, listMcpServers, listAllMcpServers, removeMcpServer (T012)
- Format router: removeConfig() paralleling readConfig/writeConfig (T013)
- McpServerEntry type for typed MCP list results (T014)
- 57 library exports from src/index.ts for programmatic usage (T016)
- Published as @cleocode/caamp on npm (T020)
- GitHub repository at https://github.com/kryptobaseddev/caamp (T019)

### Changed

- Refactored mcp list/remove/detect CLI commands to delegate to core reader module (T015)
- Moved resolveConfigPath from installer.ts to reader.ts as single source of truth (T017)
- Updated package name from caamp to @cleocode/caamp with public publishConfig (T018)
