# @cleocode/caamp — Configuration Reference

## `DetectionConfig`

Configuration for detecting whether a provider is installed.

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

| Property | Type | Description |
|----------|------|-------------|
| `methods` | `DetectionMethod[]` | Detection methods to try, in order. |
| `binary` | `string | undefined` | Binary name to look up on PATH (for `"binary"` method). |
| `directories` | `string[] | undefined` | Directories to check for existence (for `"directory"` method). |
| `appBundle` | `string | undefined` | macOS .app bundle name (for `"appBundle"` method). |
| `flatpakId` | `string | undefined` | Flatpak application ID (for `"flatpak"` method). |

## `McpServerConfig`

Canonical MCP server configuration.

```typescript
import type { McpServerConfig } from "@cleocode/caamp";

const config: Partial<McpServerConfig> = {
  // Transport type (`"stdio"`, `"sse"`, or `"http"`).
  type: { /* ... */ },
  // URL for remote MCP servers.
  url: "...",
  // HTTP headers for remote MCP servers.
  headers: { /* ... */ },
  // Command to run for stdio MCP servers.
  command: "...",
  // Arguments for the stdio command.
  args: "...",
  // Environment variables for the stdio process.
  env: { /* ... */ },
};
```

| Property | Type | Description |
|----------|------|-------------|
| `type` | `TransportType | undefined` | Transport type (`"stdio"`, `"sse"`, or `"http"`). |
| `url` | `string | undefined` | URL for remote MCP servers. |
| `headers` | `Record<string, string> | undefined` | HTTP headers for remote MCP servers. |
| `command` | `string | undefined` | Command to run for stdio MCP servers. |
| `args` | `string[] | undefined` | Arguments for the stdio command. |
| `env` | `Record<string, string> | undefined` | Environment variables for the stdio process. |

## `PiModelsConfig`

Entire `models.json` document shape used by Pi.

```typescript
import type { PiModelsConfig } from "@cleocode/caamp";

const config: Partial<PiModelsConfig> = {
  // Map of provider id → provider block.
  providers: { /* ... */ },
};
```

| Property | Type | Description |
|----------|------|-------------|
| `providers` | `Record<string, PiModelProvider>` | Map of provider id → provider block. |
