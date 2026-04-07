---
name: SKILL-caamp
description: >
  Central AI Agent Managed Packages - unified provider registry and package manager for AI coding agents Use when: (1) running caamp CLI commands, (2) calling its 276 API functions, (3) configuring @cleocode/caamp, (4) understanding its 180 type definitions, (5) working with its 8 classes, (6) user mentions "ai", "agent", "skills", "cli", "claude", (7) user mentions "@cleocode/caamp" or asks about its API.
---

# @cleocode/caamp

Central AI Agent Managed Packages - unified provider registry and package manager for AI coding agents

## Quick Start

```bash
npm install -D @cleocode/caamp
```

```bash
npx caamp --help
```

## API

| Function | Description |
|----------|-------------|
| `getPlatformPaths()` | Get OS-appropriate paths for CAAMP's global directories. |
| `getSystemInfo()` | Get a cached system information snapshot. |
| `_resetPlatformPathsCache()` | Invalidate the path and system info caches. Use in tests after mutating AGENTS_HOME env var. |
| `getPlatformLocations()` | Resolves platform-specific directory locations for the current OS. |
| `getAgentsHome()` | Returns the global agents home directory path. |
| `getProjectAgentsDir()` | Returns the project-local `.agents` directory path. |
| `resolveProjectPath()` | Resolves a relative path against a project directory. |
| `getCanonicalSkillsDir()` | Returns the canonical skills storage directory path. |
| `getLockFilePath()` | Returns the path to the CAAMP lock file. |
| `getAgentsMcpDir()` | Gets the MCP directory within the `.agents/` standard structure. |
| `getAgentsMcpServersPath()` | Gets the MCP servers.json path within the `.agents/` standard structure. |
| `getAgentsInstructFile()` | Gets the primary AGENTS.md instruction file path within `.agents/`. |
| `getAgentsConfigPath()` | Gets the config.toml path within the `.agents/` standard structure. |
| `getAgentsWikiDir()` | Gets the wiki directory within the `.agents/` standard structure. |
| `getAgentsSpecDir()` | Gets the spec directory within the `.agents/` standard structure. |
| ... | 261 more — see API reference |

## Configuration

```typescript
import type { DetectionConfig } from "@cleocode/caamp";

const config: Partial<DetectionConfig> = {
  // Detection methods to try, in order.
  methods: [],
  // Binary name to look up on PATH (for `"binary"` method).
  binary: "...",
  // Directories to check for existence (for `"directory"` method).
  directories: "...",
  // macOS .app bundle name (for `"appBundle"` method).
  appBundle: "...",
  // Flatpak application ID (for `"flatpak"` method).
  flatpakId: "...",
};
```

See [references/CONFIGURATION.md](references/CONFIGURATION.md) for full details.

## Gotchas

- `HookEvent` is deprecated: Use `CanonicalHookEvent` from `../hooks/types.js` for the normalized CAAMP taxonomy. This type remains for backward compatibility with registry.json's `capabilities.hooks.supported` string arrays.
- `CtSkillEntry` is deprecated: Use `SkillLibraryEntry` instead.
- `CtValidationResult` is deprecated: Use `SkillLibraryValidationResult` instead.
- `CtValidationIssue` is deprecated: Use `SkillLibraryValidationIssue` instead.
- `CtProfileDefinition` is deprecated: Use `SkillLibraryProfile` instead.
- `CtDispatchMatrix` is deprecated: Use `SkillLibraryDispatchMatrix` instead.
- `CtManifest` is deprecated: Use `SkillLibraryManifest` instead.
- `CtManifestSkill` is deprecated: Use `SkillLibraryManifestSkill` instead.
- `resolveProvidersRegistryPath()` throws: Error if `providers/registry.json` cannot be found within 8 parent levels
- `ensureProviderInstructionFile()` throws: Error if the provider ID is not found in the registry
- `ensureAllProviderInstructionFiles()` throws: Error if any provider ID is not found in the registry
- `resolveTierDir()` throws: `Error` when `tier='project'` and no `projectDir` is supplied
- `resolveDefaultTargetProviders()` throws: `PiRequiredError` when mode is `'force-pi'` and Pi is not   installed.
- `resolveFormat()` throws: Error if format flags conflict
- `readConfig()` throws: If the file cannot be read or the format is unsupported
- `writeConfig()` throws: If the format is unsupported
- `removeConfig()` throws: If the format is unsupported
- `installMcpServer()` throws: `Error` when the provider has no MCP capability or no   project-scoped config path is available.
- `requireMcpProvider()` throws: `LAFSCommandError` when the provider is unknown or has no   MCP capability.
- `parseScope()` throws: `LAFSCommandError` when `raw` is set to an invalid value.
- `parseEnvAssignment()` throws: `LAFSCommandError` when the token is malformed.
- `fetchWithTimeout()` throws: `NetworkError` on timeout or network failure
- `ensureOkResponse()` throws: `NetworkError` when `response.ok` is `false`
- `requirePiHarness()` throws: `LAFSCommandError` when Pi is not installed.
- `parseScope()` throws: `LAFSCommandError` when `raw` is set to an invalid value.
- `recommendSkills()` throws: Error with `code` and `issues` properties when criteria are invalid
- `loadLibraryFromModule()` throws: If the module cannot be loaded or does not implement SkillLibrary
- `buildLibraryFromFiles()` throws: If skills.json is not found at the root
- `registerSkillLibraryFromPath()` throws: Error if the library cannot be loaded from the given path

## Key Types

- **`SkillLibraryEntry`** — A single skill entry in a library catalog.
- **`SkillLibraryValidationResult`** — Validation result from skill frontmatter validation.
- **`SkillLibraryValidationIssue`** — A single validation issue.
- **`SkillLibraryProfile`** — Profile definition for grouped skill installation.
- **`SkillLibraryDispatchMatrix`** — Dispatch matrix for task routing to skills.
- **`SkillLibraryManifestSkill`** — Skill entry within the library manifest.
- **`SkillLibraryManifest`** — Full manifest structure for a skill library.
- **`SkillLibrary`** — Standard interface for a skill library.  Any directory or module providing skills must implement this contract. CAAMP uses it to discover, resolve, and install skills from any source.
- **`RegistryDetection`** — Raw detection configuration as stored in registry.json.
- **`ProviderPriority`** — Priority tier identifier stored in registry.json.

## References

- [references/CONFIGURATION.md](references/CONFIGURATION.md) — Full config options
- [references/API-REFERENCE.md](references/API-REFERENCE.md) — Signatures, parameters, examples
