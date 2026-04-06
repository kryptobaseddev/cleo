# @cleocode/monorepo — Configuration Reference

## `DetectionConfig`

Configuration for detecting whether a provider is installed.

```typescript
import type { DetectionConfig } from "@cleocode/monorepo";

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
import type { McpServerConfig } from "@cleocode/monorepo";

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

## `LoggerConfig`

```typescript
import type { LoggerConfig } from "@cleocode/monorepo";

const config: Partial<LoggerConfig> = {
  level: "...",
  filePath: "...",
  maxFileSize: 0,
  maxFiles: 0,
};
```

| Property | Type | Description |
|----------|------|-------------|
| `level` | `string` |  |
| `filePath` | `string` |  |
| `maxFileSize` | `number` |  |
| `maxFiles` | `number` |  |

## `HookConfig`

Configuration for the hook system Controls which events are enabled/disabled

```typescript
import type { HookConfig } from "@cleocode/monorepo";

const config: Partial<HookConfig> = {
  // Master switch for hook system
  enabled: true,
  // Per-event enable/disable configuration
  events: { /* ... */ },
};
```

| Property | Type | Description |
|----------|------|-------------|
| `enabled` | `boolean` | Master switch for hook system |
| `events` | `Record<HookEvent, boolean>` | Per-event enable/disable configuration |

## `ConfigChangePayload`

Payload for ConfigChange hook Fired when configuration is updated

```typescript
import type { ConfigChangePayload } from "@cleocode/monorepo";

const config: Partial<ConfigChangePayload> = {
  // Configuration key that changed
  key: "...",
  // Previous value
  previousValue: undefined,
  // New value
  newValue: undefined,
};
```

| Property | Type | Description |
|----------|------|-------------|
| `key` | `string` | Configuration key that changed |
| `previousValue` | `unknown` | Previous value |
| `newValue` | `unknown` | New value |

## `CheckpointConfig`

Checkpoint configuration.

```typescript
import type { CheckpointConfig } from "@cleocode/monorepo";

const config: Partial<CheckpointConfig> = {
  enabled: true,
  debounceMinutes: 0,
  messagePrefix: "...",
  noVerify: true,
};
```

| Property | Type | Description |
|----------|------|-------------|
| `enabled` | `boolean` |  |
| `debounceMinutes` | `number` |  |
| `messagePrefix` | `string` |  |
| `noVerify` | `boolean` |  |

## `SafetyConfig`

Safety configuration options.

```typescript
import type { SafetyConfig } from "@cleocode/monorepo";

const config: Partial<SafetyConfig> = {
  // Enable write verification (default: true)
  verifyWrites: true,
  // Enable collision detection (default: true)
  detectCollisions: true,
  // Enable sequence validation (default: true)
  validateSequence: true,
  // Enable auto-checkpoint (default: true)
  autoCheckpoint: true,
  // Throw on safety violations (default: true)
  strictMode: true,
};
```

| Property | Type | Description |
|----------|------|-------------|
| `verifyWrites` | `boolean` | Enable write verification (default: true) |
| `detectCollisions` | `boolean` | Enable collision detection (default: true) |
| `validateSequence` | `boolean` | Enable sequence validation (default: true) |
| `autoCheckpoint` | `boolean` | Enable auto-checkpoint (default: true) |
| `strictMode` | `boolean` | Throw on safety violations (default: true) |

## `MemoryBridgeConfig`

Configuration for memory bridge content generation.

```typescript
import type { MemoryBridgeConfig } from "@cleocode/monorepo";

const config: Partial<MemoryBridgeConfig> = {
  maxObservations: 0,
  maxLearnings: 0,
  maxPatterns: 0,
  maxDecisions: 0,
  includeHandoff: true,
  includeAntiPatterns: true,
};
```

| Property | Type | Description |
|----------|------|-------------|
| `maxObservations` | `number` |  |
| `maxLearnings` | `number` |  |
| `maxPatterns` | `number` |  |
| `maxDecisions` | `number` |  |
| `includeHandoff` | `boolean` |  |
| `includeAntiPatterns` | `boolean` |  |

## `DispatcherConfig`

```typescript
import type { DispatcherConfig } from "@cleocode/monorepo";

const config: Partial<DispatcherConfig> = {
  handlers: { /* ... */ },
  middlewares: [],
};
```

| Property | Type | Description |
|----------|------|-------------|
| `handlers` | `Map<string, DomainHandler>` |  |
| `middlewares` | `Middleware[] | undefined` |  |

## `BackgroundJobManagerConfig`

Configuration for BackgroundJobManager

```typescript
import type { BackgroundJobManagerConfig } from "@cleocode/monorepo";

const config: Partial<BackgroundJobManagerConfig> = {
  maxJobs: 0,
  retentionMs: 0,
};
```

| Property | Type | Description |
|----------|------|-------------|
| `maxJobs` | `number | undefined` |  |
| `retentionMs` | `number | undefined` |  |

## `RateLimitConfig`

Per-category rate limit thresholds.

```typescript
import type { RateLimitConfig } from "@cleocode/monorepo";

const config: Partial<RateLimitConfig> = {
  // Maximum number of requests allowed within the window.
  maxRequests: 0,
  // Sliding window duration in milliseconds.
  windowMs: 0,
};
```

| Property | Type | Description |
|----------|------|-------------|
| `maxRequests` | `number` | Maximum number of requests allowed within the window. |
| `windowMs` | `number` | Sliding window duration in milliseconds. |

## `RateLimitingConfig`

Full rate limiting configuration across all categories.

```typescript
import type { RateLimitingConfig } from "@cleocode/monorepo";

const config: Partial<RateLimitingConfig> = {
  // Whether rate limiting is active.
  enabled: true,
  // Limits for read-only query operations.
  query: { /* ... */ },
  // Limits for mutate (write) operations.
  mutate: { /* ... */ },
  // Limits for spawn (subagent launch) operations.
  spawn: { /* ... */ },
};
```

| Property | Type | Description |
|----------|------|-------------|
| `enabled` | `boolean` | Whether rate limiting is active. |
| `query` | `RateLimitConfig` | Limits for read-only query operations. |
| `mutate` | `RateLimitConfig` | Limits for mutate (write) operations. |
| `spawn` | `RateLimitConfig` | Limits for spawn (subagent launch) operations. |

## `LifecycleEnforcementConfig`

Lifecycle enforcement configuration (Section 12.2)

```typescript
import type { LifecycleEnforcementConfig } from "@cleocode/monorepo";

const config: Partial<LifecycleEnforcementConfig> = {
  // Enforcement mode: strict blocks, advisory warns, off skips
  mode: undefined,
  // Stages that may be skipped without failing gates
  allowSkip: "...",
  // Emergency bypass flag - disables all gate checks
  emergencyBypass: true,
};
```

| Property | Type | Description |
|----------|------|-------------|
| `mode` | `"strict" | "advisory" | "off"` | Enforcement mode: strict blocks, advisory warns, off skips |
| `allowSkip` | `string[]` | Stages that may be skipped without failing gates |
| `emergencyBypass` | `boolean` | Emergency bypass flag - disables all gate checks |

## `ProtocolValidationConfig`

Protocol validation configuration (Section 12.3)

```typescript
import type { ProtocolValidationConfig } from "@cleocode/monorepo";

const config: Partial<ProtocolValidationConfig> = {
  // Enable strict protocol validation
  strictMode: true,
  // Block operations on protocol violations
  blockOnViolation: true,
  // Log protocol violations to audit trail
  logViolations: true,
};
```

| Property | Type | Description |
|----------|------|-------------|
| `strictMode` | `boolean` | Enable strict protocol validation |
| `blockOnViolation` | `boolean` | Block operations on protocol violations |
| `logViolations` | `boolean` | Log protocol violations to audit trail |

## `DispatchConfig`

```typescript
import type { DispatchConfig } from "@cleocode/monorepo";

const config: Partial<DispatchConfig> = {
  // Path to CLEO CLI binary (default: 'cleo')
  cliPath: "...",
  // Operation timeout in milliseconds (default: 30000)
  timeout: 0,
  // Logging verbosity level (default: 'info')
  logLevel: undefined,
  // Enable token tracking metrics (default: false)
  enableMetrics: true,
  // Retry count for failed operations (default: 3)
  maxRetries: 0,
  // Enable query cache (default: true)
  queryCache: true,
  // Query cache TTL in milliseconds (default: 30000)
  queryCacheTtl: 0,
  // Enable audit logging (default: true)
  auditLog: true,
  // Strict validation mode (default: true)
  strictValidation: true,
  // Lifecycle enforcement configuration (Section 12.2)
  lifecycleEnforcement: { /* ... */ },
  // Protocol validation configuration (Section 12.3)
  protocolValidation: { /* ... */ },
  // Rate limiting configuration (Section 13.3)
  rateLimiting: { /* ... */ },
};
```

| Property | Type | Description |
|----------|------|-------------|
| `cliPath` | `string` | Path to CLEO CLI binary (default: 'cleo') |
| `timeout` | `number` | Operation timeout in milliseconds (default: 30000) |
| `logLevel` | `"error" | "warn" | "info" | "debug"` | Logging verbosity level (default: 'info') |
| `enableMetrics` | `boolean` | Enable token tracking metrics (default: false) |
| `maxRetries` | `number` | Retry count for failed operations (default: 3) |
| `queryCache` | `boolean` | Enable query cache (default: true) |
| `queryCacheTtl` | `number` | Query cache TTL in milliseconds (default: 30000) |
| `auditLog` | `boolean` | Enable audit logging (default: true) |
| `strictValidation` | `boolean` | Strict validation mode (default: true) |
| `lifecycleEnforcement` | `LifecycleEnforcementConfig` | Lifecycle enforcement configuration (Section 12.2) |
| `protocolValidation` | `ProtocolValidationConfig` | Protocol validation configuration (Section 12.3) |
| `rateLimiting` | `RateLimitingConfig` | Rate limiting configuration (Section 13.3) |

## `ProjectionConfig`

Configuration for a single MVI projection tier.

```typescript
import type { ProjectionConfig } from "@cleocode/monorepo";

const config: Partial<ProjectionConfig> = {
  // Operations allowed at this tier
  allowedDomains: "...",
  // Fields to exclude from responses
  excludeFields: "...",
  // Maximum depth for nested objects
  maxDepth: 0,
};
```

| Property | Type | Description |
|----------|------|-------------|
| `allowedDomains` | `string[]` | Operations allowed at this tier |
| `excludeFields` | `string[] | undefined` | Fields to exclude from responses |
| `maxDepth` | `number | undefined` | Maximum depth for nested objects |

## `TransportConfig`

Transport-specific configuration stored per agent credential.

```typescript
import type { TransportConfig } from "@cleocode/monorepo";

const config: Partial<TransportConfig> = {
  // Polling interval in milliseconds (for HTTP polling transport).
  pollIntervalMs: 0,
  // SSE endpoint URL (for Server-Sent Events transport).
  sseEndpoint: "...",
  // WebSocket URL (for WebSocket transport).
  wsUrl: "...",
  // HTTP polling endpoint path (for HTTP polling transport).
  pollEndpoint: "...",
  // Fallback API base URL (used when primary apiBaseUrl is unreachable).
  apiBaseUrlFallback: "...",
};
```

| Property | Type | Description |
|----------|------|-------------|
| `pollIntervalMs` | `number | undefined` | Polling interval in milliseconds (for HTTP polling transport). |
| `sseEndpoint` | `string | undefined` | SSE endpoint URL (for Server-Sent Events transport). |
| `wsUrl` | `string | undefined` | WebSocket URL (for WebSocket transport). |
| `pollEndpoint` | `string | undefined` | HTTP polling endpoint path (for HTTP polling transport). |
| `apiBaseUrlFallback` | `string | undefined` | Fallback API base URL (used when primary apiBaseUrl is unreachable). |

## `ConduitConfig`

Configuration for creating a Conduit instance.

```typescript
import type { ConduitConfig } from "@cleocode/monorepo";

const config: Partial<ConduitConfig> = {
  // Agent ID to connect as.
  agentId: "...",
  // API base URL (for cloud implementations).
  apiBaseUrl: "...",
  // API key for authentication.
  apiKey: "...",
  // Poll interval in milliseconds (for polling implementations). Default: 5000.
  pollIntervalMs: 0,
  // WebSocket URL (for local SignalDock implementations).
  wsUrl: "...",
};
```

| Property | Type | Description |
|----------|------|-------------|
| `agentId` | `string` | Agent ID to connect as. |
| `apiBaseUrl` | `string | undefined` | API base URL (for cloud implementations). |
| `apiKey` | `string | undefined` | API key for authentication. |
| `pollIntervalMs` | `number | undefined` | Poll interval in milliseconds (for polling implementations). Default: 5000. |
| `wsUrl` | `string | undefined` | WebSocket URL (for local SignalDock implementations). |

## `TransportConnectConfig`

Configuration passed to Transport.connect().

```typescript
import type { TransportConnectConfig } from "@cleocode/monorepo";

const config: Partial<TransportConnectConfig> = {
  // Agent ID to connect as.
  agentId: "...",
  // API key for authentication.
  apiKey: "...",
  // Base URL of the messaging API.
  apiBaseUrl: "...",
};
```

| Property | Type | Description |
|----------|------|-------------|
| `agentId` | `string` | Agent ID to connect as. |
| `apiKey` | `string` | API key for authentication. |
| `apiBaseUrl` | `string` | Base URL of the messaging API. |

## `OutputConfig`

Output configuration.

```typescript
import type { OutputConfig } from "@cleocode/monorepo";

const config: Partial<OutputConfig> = {
  // Default output format for CLI responses.
  defaultFormat: { /* ... */ },
  // Whether to use ANSI color codes in terminal output.
  showColor: true,
  // Whether to use Unicode symbols (checkmarks, arrows) in output.
  showUnicode: true,
  // Whether to display progress bars for long-running operations.
  showProgressBars: true,
  // Date display format for timestamps in output.
  dateFormat: { /* ... */ },
};
```

| Property | Type | Description |
|----------|------|-------------|
| `defaultFormat` | `OutputFormat` | Default output format for CLI responses. |
| `showColor` | `boolean` | Whether to use ANSI color codes in terminal output. |
| `showUnicode` | `boolean` | Whether to use Unicode symbols (checkmarks, arrows) in output. |
| `showProgressBars` | `boolean` | Whether to display progress bars for long-running operations. |
| `dateFormat` | `DateFormat` | Date display format for timestamps in output. |

## `BackupConfig`

Backup configuration.

```typescript
import type { BackupConfig } from "@cleocode/monorepo";

const config: Partial<BackupConfig> = {
  // Maximum number of operational backups to retain during normal operations.
  maxOperationalBackups: 0,
  // Maximum number of safety backups to retain for disaster recovery.
  maxSafetyBackups: 0,
  // Whether to compress backup files to reduce disk usage.
  compressionEnabled: true,
};
```

| Property | Type | Description |
|----------|------|-------------|
| `maxOperationalBackups` | `number` | Maximum number of operational backups to retain during normal operations. |
| `maxSafetyBackups` | `number` | Maximum number of safety backups to retain for disaster recovery. |
| `compressionEnabled` | `boolean` | Whether to compress backup files to reduce disk usage. |

## `HierarchyConfig`

Hierarchy configuration.

```typescript
import type { HierarchyConfig } from "@cleocode/monorepo";

const config: Partial<HierarchyConfig> = {
  // Maximum nesting depth for task hierarchy (epic  task  subtask).
  maxDepth: 0,
  // Maximum number of sibling tasks under a single parent.
  maxSiblings: 0,
  // Whether deleting a parent cascades to all descendant tasks.
  cascadeDelete: true,
  // Maximum number of active (non-done) siblings. 0 = disabled.
  maxActiveSiblings: 0,
  // Whether done tasks count toward the sibling limit.
  countDoneInLimit: true,
  // Enforcement profile preset. Explicit fields override preset values.
  enforcementProfile: { /* ... */ },
};
```

| Property | Type | Description |
|----------|------|-------------|
| `maxDepth` | `number` | Maximum nesting depth for task hierarchy (epic  task  subtask). |
| `maxSiblings` | `number` | Maximum number of sibling tasks under a single parent. |
| `cascadeDelete` | `boolean` | Whether deleting a parent cascades to all descendant tasks. |
| `maxActiveSiblings` | `number` | Maximum number of active (non-done) siblings. 0 = disabled. |
| `countDoneInLimit` | `boolean` | Whether done tasks count toward the sibling limit. |
| `enforcementProfile` | `EnforcementProfile` | Enforcement profile preset. Explicit fields override preset values. |

## `SessionConfig`

Session configuration.

```typescript
import type { SessionConfig } from "@cleocode/monorepo";

const config: Partial<SessionConfig> = {
  // Whether to auto-start a session on first mutate operation.
  autoStart: true,
  // Whether session end requires at least one note.
  requireNotes: true,
  // Whether multiple concurrent sessions are allowed.
  multiSession: true,
};
```

| Property | Type | Description |
|----------|------|-------------|
| `autoStart` | `boolean` | Whether to auto-start a session on first mutate operation. |
| `requireNotes` | `boolean` | Whether session end requires at least one note. |
| `multiSession` | `boolean` | Whether multiple concurrent sessions are allowed. |

## `LoggingConfig`

Logging configuration.

```typescript
import type { LoggingConfig } from "@cleocode/monorepo";

const config: Partial<LoggingConfig> = {
  // Minimum log level to record (default: 'info')
  level: { /* ... */ },
  // Log file path relative to .cleo/ (default: 'logs/cleo.log')
  filePath: "...",
  // Max log file size in bytes before rotation (default: 10MB)
  maxFileSize: 0,
  // Number of rotated log files to retain (default: 5)
  maxFiles: 0,
  // Days to retain audit_log rows before pruning (default: 90)
  auditRetentionDays: 0,
  // Whether to archive pruned rows to compressed JSONL before deletion (default: true)
  archiveBeforePrune: true,
};
```

| Property | Type | Description |
|----------|------|-------------|
| `level` | `LogLevel` | Minimum log level to record (default: 'info') |
| `filePath` | `string` | Log file path relative to .cleo/ (default: 'logs/cleo.log') |
| `maxFileSize` | `number` | Max log file size in bytes before rotation (default: 10MB) |
| `maxFiles` | `number` | Number of rotated log files to retain (default: 5) |
| `auditRetentionDays` | `number` | Days to retain audit_log rows before pruning (default: 90) |
| `archiveBeforePrune` | `boolean` | Whether to archive pruned rows to compressed JSONL before deletion (default: true) |

## `AcceptanceEnforcementConfig`

Acceptance criteria enforcement settings.

```typescript
import type { AcceptanceEnforcementConfig } from "@cleocode/monorepo";

const config: Partial<AcceptanceEnforcementConfig> = {
  // Enforcement mode.
  mode: { /* ... */ },
  // Task priorities that require AC.
  requiredForPriorities: "...",
  // Minimum acceptance criteria count.
  minimumCriteria: 0,
};
```

| Property | Type | Description |
|----------|------|-------------|
| `mode` | `AcceptanceEnforcementMode` | Enforcement mode. |
| `requiredForPriorities` | `string[]` | Task priorities that require AC. |
| `minimumCriteria` | `number` | Minimum acceptance criteria count. |

## `SessionEnforcementConfig`

Session enforcement settings.

```typescript
import type { SessionEnforcementConfig } from "@cleocode/monorepo";

const config: Partial<SessionEnforcementConfig> = {
  // Whether mutate operations require an active session.
  requiredForMutate: true,
};
```

| Property | Type | Description |
|----------|------|-------------|
| `requiredForMutate` | `boolean` | Whether mutate operations require an active session. |

## `EnforcementConfig`

Top-level enforcement configuration.

```typescript
import type { EnforcementConfig } from "@cleocode/monorepo";

const config: Partial<EnforcementConfig> = {
  // Acceptance criteria enforcement.
  acceptance: { /* ... */ },
  // Session enforcement.
  session: { /* ... */ },
};
```

| Property | Type | Description |
|----------|------|-------------|
| `acceptance` | `AcceptanceEnforcementConfig` | Acceptance criteria enforcement. |
| `session` | `SessionEnforcementConfig` | Session enforcement. |

## `VerificationConfig`

Verification gate configuration.

```typescript
import type { VerificationConfig } from "@cleocode/monorepo";

const config: Partial<VerificationConfig> = {
  // Whether verification gates are enabled.
  enabled: true,
  // Maximum verification rounds.
  maxRounds: 0,
  // Gate names required for completion.
  requiredGates: "...",
};
```

| Property | Type | Description |
|----------|------|-------------|
| `enabled` | `boolean` | Whether verification gates are enabled. |
| `maxRounds` | `number` | Maximum verification rounds. |
| `requiredGates` | `string[]` | Gate names required for completion. |

## `LifecycleConfig`

Lifecycle enforcement configuration.

```typescript
import type { LifecycleConfig } from "@cleocode/monorepo";

const config: Partial<LifecycleConfig> = {
  // Enforcement mode controlling how lifecycle rules are applied.
  mode: { /* ... */ },
};
```

| Property | Type | Description |
|----------|------|-------------|
| `mode` | `LifecycleEnforcementMode` | Enforcement mode controlling how lifecycle rules are applied. |

## `SharingConfig`

Sharing configuration for multi-contributor .cleo/ state management.

```typescript
import type { SharingConfig } from "@cleocode/monorepo";

const config: Partial<SharingConfig> = {
  // Sharing mode (default: 'none').
  mode: { /* ... */ },
  // Files/patterns in .cleo/ to commit to project git (relative to .cleo/).
  commitAllowlist: "...",
  // Files/patterns to always exclude, even if in commitAllowlist.
  denylist: "...",
};
```

| Property | Type | Description |
|----------|------|-------------|
| `mode` | `SharingMode` | Sharing mode (default: 'none'). |
| `commitAllowlist` | `string[]` | Files/patterns in .cleo/ to commit to project git (relative to .cleo/). |
| `denylist` | `string[]` | Files/patterns to always exclude, even if in commitAllowlist. |

## `BrainMemoryBridgeConfig`

Brain memory bridge refresh configuration. Controls when `.cleo/memory-bridge.md` is automatically regenerated.   T134  T135

```typescript
import type { BrainMemoryBridgeConfig } from "@cleocode/monorepo";

const config: Partial<BrainMemoryBridgeConfig> = {
  // Whether to automatically regenerate memory-bridge.md on lifecycle events (default: true).
  autoRefresh: true,
  // Whether to include scope-aware memory context in generated bridge (default: false).
  contextAware: true,
  // Maximum token budget for memory bridge content (default: 2000).
  maxTokens: 0,
};
```

| Property | Type | Description |
|----------|------|-------------|
| `autoRefresh` | `boolean` | Whether to automatically regenerate memory-bridge.md on lifecycle events (default: true). |
| `contextAware` | `boolean` | Whether to include scope-aware memory context in generated bridge (default: false). |
| `maxTokens` | `number` | Maximum token budget for memory bridge content (default: 2000). |

## `BrainEmbeddingConfig`

Brain embedding provider configuration.   T134  T136

```typescript
import type { BrainEmbeddingConfig } from "@cleocode/monorepo";

const config: Partial<BrainEmbeddingConfig> = {
  // Whether semantic embedding is enabled (default: false).
  enabled: true,
  // Embedding provider to use (default: 'local').
  provider: undefined,
};
```

| Property | Type | Description |
|----------|------|-------------|
| `enabled` | `boolean` | Whether semantic embedding is enabled (default: false). |
| `provider` | `"local" | "openai"` | Embedding provider to use (default: 'local'). |

## `BrainSummarizationConfig`

Brain session summarization configuration.   T134  T140

```typescript
import type { BrainSummarizationConfig } from "@cleocode/monorepo";

const config: Partial<BrainSummarizationConfig> = {
  // Whether session summarization is enabled (default: false).
  enabled: true,
};
```

| Property | Type | Description |
|----------|------|-------------|
| `enabled` | `boolean` | Whether session summarization is enabled (default: false). |

## `BrainConfig`

Brain (BRAIN memory system) configuration. Controls automated memory capture, embedding generation, memory bridge refresh behavior, and session summarization.   T134  T135

```typescript
import type { BrainConfig } from "@cleocode/monorepo";

const config: Partial<BrainConfig> = {
  // Whether to automatically capture observations from lifecycle events (default: true).
  autoCapture: true,
  // Whether to capture file change events (default: false).
  captureFiles: true,
  // Unused. CLI dispatch only.
  captureMcp: true,
  // Whether to capture active-work dispatch mutations (tasks.add, tasks.update) (default: false).
  captureWork: true,
  // Embedding provider settings.
  embedding: { /* ... */ },
  // Memory bridge auto-refresh settings.
  memoryBridge: { /* ... */ },
  // Session summarization settings.
  summarization: { /* ... */ },
};
```

| Property | Type | Description |
|----------|------|-------------|
| `autoCapture` | `boolean` | Whether to automatically capture observations from lifecycle events (default: true). |
| `captureFiles` | `boolean` | Whether to capture file change events (default: false). |
| `captureMcp` | `boolean` | Unused. CLI dispatch only. |
| `captureWork` | `boolean` | Whether to capture active-work dispatch mutations (tasks.add, tasks.update) (default: false). |
| `embedding` | `BrainEmbeddingConfig` | Embedding provider settings. |
| `memoryBridge` | `BrainMemoryBridgeConfig` | Memory bridge auto-refresh settings. |
| `summarization` | `BrainSummarizationConfig` | Session summarization settings. |

## `SignalDockConfig`

SignalDock integration configuration.

```typescript
import type { SignalDockConfig } from "@cleocode/monorepo";

const config: Partial<SignalDockConfig> = {
  // Whether SignalDock transport is enabled (default: false).
  enabled: true,
  // Transport mode: 'http' for REST API client, 'native' for napi-rs bindings (default: 'http').
  mode: { /* ... */ },
  // SignalDock API server endpoint (default: 'http://localhost:4000').
  endpoint: "...",
  // Prefix for CLEO agent names in SignalDock registry (default: 'cleo-').
  agentPrefix: "...",
  // Default privacy tier for registered agents (default: 'private').
  privacyTier: undefined,
};
```

| Property | Type | Description |
|----------|------|-------------|
| `enabled` | `boolean` | Whether SignalDock transport is enabled (default: false). |
| `mode` | `SignalDockMode` | Transport mode: 'http' for REST API client, 'native' for napi-rs bindings (default: 'http'). |
| `endpoint` | `string` | SignalDock API server endpoint (default: 'http://localhost:4000'). |
| `agentPrefix` | `string` | Prefix for CLEO agent names in SignalDock registry (default: 'cleo-'). |
| `privacyTier` | `"public" | "discoverable" | "private"` | Default privacy tier for registered agents (default: 'private'). |

## `CleoConfig`

CLEO project configuration (config.json).

```typescript
import type { CleoConfig } from "@cleocode/monorepo";

const config: Partial<CleoConfig> = {
  // Configuration schema version string.
  version: "...",
  // Output formatting preferences.
  output: { /* ... */ },
  // Database backup retention and compression settings.
  backup: { /* ... */ },
  // Task hierarchy depth and sibling constraints.
  hierarchy: { /* ... */ },
  // Session auto-start and multi-session policies.
  session: { /* ... */ },
  // Acceptance criteria and session enforcement rules.
  enforcement: { /* ... */ },
  // Verification gate pipeline settings.
  verification: { /* ... */ },
  // Task lifecycle enforcement mode.
  lifecycle: { /* ... */ },
  // Log level, rotation, and audit retention settings.
  logging: { /* ... */ },
  // Multi-contributor `.cleo/` state sharing settings.
  sharing: { /* ... */ },
  // SignalDock inter-agent transport (optional, disabled by default).
  signaldock: { /* ... */ },
  // Brain memory system configuration (optional, uses defaults when absent).
  brain: { /* ... */ },
};
```

| Property | Type | Description |
|----------|------|-------------|
| `version` | `string` | Configuration schema version string. |
| `output` | `OutputConfig` | Output formatting preferences. |
| `backup` | `BackupConfig` | Database backup retention and compression settings. |
| `hierarchy` | `HierarchyConfig` | Task hierarchy depth and sibling constraints. |
| `session` | `SessionConfig` | Session auto-start and multi-session policies. |
| `enforcement` | `EnforcementConfig` | Acceptance criteria and session enforcement rules. |
| `verification` | `VerificationConfig` | Verification gate pipeline settings. |
| `lifecycle` | `LifecycleConfig` | Task lifecycle enforcement mode. |
| `logging` | `LoggingConfig` | Log level, rotation, and audit retention settings. |
| `sharing` | `SharingConfig` | Multi-contributor `.cleo/` state sharing settings. |
| `signaldock` | `SignalDockConfig | undefined` | SignalDock inter-agent transport (optional, disabled by default). |
| `brain` | `BrainConfig | undefined` | Brain memory system configuration (optional, uses defaults when absent). |

## `MemoryBridgeConfig`

Memory bridge types for CLEO provider adapters. Defines the shape of .cleo/memory-bridge.md content for cross-provider memory sharing.   T5240

```typescript
import type { MemoryBridgeConfig } from "@cleocode/monorepo";

const config: Partial<MemoryBridgeConfig> = {
  // Maximum number of recent observations to include in the bridge.
  maxObservations: 0,
  // Maximum number of key learnings to include.
  maxLearnings: 0,
  // Maximum number of patterns (follow/avoid) to include.
  maxPatterns: 0,
  // Maximum number of recent decisions to include.
  maxDecisions: 0,
  // Whether to include the last session handoff summary.
  includeHandoff: true,
  // Whether to include anti-patterns alongside follow-patterns.
  includeAntiPatterns: true,
};
```

| Property | Type | Description |
|----------|------|-------------|
| `maxObservations` | `number` | Maximum number of recent observations to include in the bridge. |
| `maxLearnings` | `number` | Maximum number of key learnings to include. |
| `maxPatterns` | `number` | Maximum number of patterns (follow/avoid) to include. |
| `maxDecisions` | `number` | Maximum number of recent decisions to include. |
| `includeHandoff` | `boolean` | Whether to include the last session handoff summary. |
| `includeAntiPatterns` | `boolean` | Whether to include anti-patterns alongside follow-patterns. |

## `SkillsConfigureParams`

```typescript
import type { SkillsConfigureParams } from "@cleocode/monorepo";

const config: Partial<SkillsConfigureParams> = {
  name: "...",
  config: { /* ... */ },
};
```

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` |  |
| `config` | `Record<string, unknown>` |  |

## `SkillsConfigureResult`

```typescript
import type { SkillsConfigureResult } from "@cleocode/monorepo";

const config: Partial<SkillsConfigureResult> = {
  name: "...",
  configured: true,
  config: { /* ... */ },
};
```

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` |  |
| `configured` | `boolean` |  |
| `config` | `Record<string, unknown>` |  |

## `SystemConfigGetParams`

```typescript
import type { SystemConfigGetParams } from "@cleocode/monorepo";

const config: Partial<SystemConfigGetParams> = {
  key: "...",
};
```

| Property | Type | Description |
|----------|------|-------------|
| `key` | `string` |  |

## `SystemConfigGetResult`

```typescript
import type { SystemConfigGetResult } from "@cleocode/monorepo";

const config: Partial<SystemConfigGetResult> = {
  key: "...",
  value: undefined,
  type: "...",
};
```

| Property | Type | Description |
|----------|------|-------------|
| `key` | `string` |  |
| `value` | `unknown` |  |
| `type` | `string` |  |

## `SystemConfigSetParams`

```typescript
import type { SystemConfigSetParams } from "@cleocode/monorepo";

const config: Partial<SystemConfigSetParams> = {
  key: "...",
  value: undefined,
};
```

| Property | Type | Description |
|----------|------|-------------|
| `key` | `string` |  |
| `value` | `unknown` |  |

## `SystemConfigSetResult`

```typescript
import type { SystemConfigSetResult } from "@cleocode/monorepo";

const config: Partial<SystemConfigSetResult> = {
  key: "...",
  value: undefined,
  previousValue: undefined,
};
```

| Property | Type | Description |
|----------|------|-------------|
| `key` | `string` |  |
| `value` | `unknown` |  |
| `previousValue` | `unknown` |  |

## `ArtifactConfig`

Artifact configuration from release config.

```typescript
import type { ArtifactConfig } from "@cleocode/monorepo";

const config: Partial<ArtifactConfig> = {
  type: { /* ... */ },
  buildCommand: "...",
  publishCommand: "...",
  package: "...",
  registry: "...",
  options: { /* ... */ },
};
```

| Property | Type | Description |
|----------|------|-------------|
| `type` | `ArtifactType` |  |
| `buildCommand` | `string | undefined` |  |
| `publishCommand` | `string | undefined` |  |
| `package` | `string | undefined` |  |
| `registry` | `string | undefined` |  |
| `options` | `{ [key: string]: unknown; provenance?: boolean; access?: string; tag?: string; attestations?: boolean; } | undefined` |  |

## `ReleaseConfig`

Release configuration shape.

```typescript
import type { ReleaseConfig } from "@cleocode/monorepo";

const config: Partial<ReleaseConfig> = {
  versioningScheme: "...",
  tagPrefix: "...",
  changelogFormat: "...",
  changelogFile: "...",
  artifactType: "...",
  gates: [],
  versionBump: { /* ... */ },
  security: { /* ... */ },
  gitflow: { /* ... */ },
  channels: { /* ... */ },
  push: { /* ... */ },
};
```

| Property | Type | Description |
|----------|------|-------------|
| `versioningScheme` | `string` |  |
| `tagPrefix` | `string` |  |
| `changelogFormat` | `string` |  |
| `changelogFile` | `string` |  |
| `artifactType` | `string` |  |
| `gates` | `ReleaseGate[]` |  |
| `versionBump` | `{ files: Array<{ file: string; strategy: string; field?: string; }>; }` |  |
| `security` | `{ enableProvenance: boolean; slsaLevel: number; requireSignedCommits: boolean; }` |  |
| `gitflow` | `GitFlowConfig | undefined` |  |
| `channels` | `ChannelConfig | undefined` |  |
| `push` | `{ mode?: PushMode; } | undefined` |  |

## `GitFlowConfig`

GitFlow branch configuration.

```typescript
import type { GitFlowConfig } from "@cleocode/monorepo";

const config: Partial<GitFlowConfig> = {
  enabled: true,
  branches: { /* ... */ },
};
```

| Property | Type | Description |
|----------|------|-------------|
| `enabled` | `boolean` |  |
| `branches` | `{ main: string; develop: string; featurePrefix: string; hotfixPrefix: string; releasePrefix: string; }` |  |

## `ChannelConfig`

Channel-to-branch mapping for npm dist-tag resolution.

```typescript
import type { ChannelConfig } from "@cleocode/monorepo";

const config: Partial<ChannelConfig> = {
  main: "...",
  develop: "...",
  feature: "...",
  custom: { /* ... */ },
};
```

| Property | Type | Description |
|----------|------|-------------|
| `main` | `string` |  |
| `develop` | `string` |  |
| `feature` | `string` |  |
| `custom` | `Record<string, string> | undefined` |  |

## `MigrationLoggerConfig`

Migration logger configuration

```typescript
import type { MigrationLoggerConfig } from "@cleocode/monorepo";

const config: Partial<MigrationLoggerConfig> = {
  // Maximum number of log files to retain
  maxLogFiles: 0,
  // Minimum log level to record
  minLevel: { /* ... */ },
  // Enable console output in addition to file logging
  consoleOutput: true,
};
```

| Property | Type | Description |
|----------|------|-------------|
| `maxLogFiles` | `number | undefined` | Maximum number of log files to retain |
| `minLevel` | `LogLevel | undefined` | Minimum log level to record |
| `consoleOutput` | `boolean | undefined` | Enable console output in addition to file logging |

## `RemoteConfig`

Remote configuration.

```typescript
import type { RemoteConfig } from "@cleocode/monorepo";

const config: Partial<RemoteConfig> = {
  name: "...",
  url: "...",
};
```

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` |  |
| `url` | `string` |  |

## `RateLimitConfig`

Rate limiter configuration

```typescript
import type { RateLimitConfig } from "@cleocode/monorepo";

const config: Partial<RateLimitConfig> = {
  maxRequests: 0,
  windowMs: 0,
};
```

| Property | Type | Description |
|----------|------|-------------|
| `maxRequests` | `number` |  |
| `windowMs` | `number` |  |

## `AgentConfig`

Agent configuration from AGENT.md or agent definition.

```typescript
import type { AgentConfig } from "@cleocode/monorepo";

const config: Partial<AgentConfig> = {
  name: "...",
  description: "...",
  model: "...",
  allowedTools: "...",
  customInstructions: "...",
};
```

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` |  |
| `description` | `string` |  |
| `model` | `string | undefined` |  |
| `allowedTools` | `string[] | undefined` |  |
| `customInstructions` | `string | undefined` |  |

## `SkillsMpConfig`

SkillsMP configuration.

```typescript
import type { SkillsMpConfig } from "@cleocode/monorepo";

const config: Partial<SkillsMpConfig> = {
  enabled: true,
  cacheDir: "...",
};
```

| Property | Type | Description |
|----------|------|-------------|
| `enabled` | `boolean` |  |
| `cacheDir` | `string` |  |

## `TemplateConfig`

The full template config output.

```typescript
import type { TemplateConfig } from "@cleocode/monorepo";

const config: Partial<TemplateConfig> = {
  templates: [],
  generatedAt: "...",
  sourceDir: "...",
};
```

| Property | Type | Description |
|----------|------|-------------|
| `templates` | `IssueTemplate[]` |  |
| `generatedAt` | `string` |  |
| `sourceDir` | `string` |  |

## `SkillsPrecedenceConfig`

Configuration for skill precedence resolution across providers.

```typescript
import type { SkillsPrecedenceConfig } from "@cleocode/monorepo";

const config: Partial<SkillsPrecedenceConfig> = {
  // Default precedence mode when no provider-specific override exists.
  defaultPrecedence: { /* ... */ },
  // Per-provider precedence overrides (provider ID - precedence).
  providerOverrides: { /* ... */ },
};
```

| Property | Type | Description |
|----------|------|-------------|
| `defaultPrecedence` | `SkillsPrecedence | undefined` | Default precedence mode when no provider-specific override exists. |
| `providerOverrides` | `Record<string, SkillsPrecedence> | undefined` | Per-provider precedence overrides (provider ID - precedence). |

## `WorkflowExecutorConfig`

Configuration options for the workflow executor.

```typescript
import type { WorkflowExecutorConfig } from "@cleocode/monorepo";

const config: Partial<WorkflowExecutorConfig> = {
  // Maximum number of discretion evaluations per workflow run (default: 100).
  maxDiscretionEvaluations: 0,
  // The session ID for this execution.
  sessionId: "...",
  // The agent ID performing the execution.
  agentId: "...",
};
```

| Property | Type | Description |
|----------|------|-------------|
| `maxDiscretionEvaluations` | `number | undefined` | Maximum number of discretion evaluations per workflow run (default: 100). |
| `sessionId` | `string | undefined` | The session ID for this execution. |
| `agentId` | `string | undefined` | The agent ID performing the execution. |

## `ServiceConfig`

Legacy service configuration.

```typescript
import type { ServiceConfig } from "@cleocode/monorepo";

const config: Partial<ServiceConfig> = {
  // Service name
  name: "...",
  // Service version
  version: "...",
  // Human-readable description.
  description: "...",
};
```

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | Service name |
| `version` | `string` | Service version |
| `description` | `string | undefined` | Human-readable description. |

## `EndpointConfig`

Legacy endpoint configuration.

```typescript
import type { EndpointConfig } from "@cleocode/monorepo";

const config: Partial<EndpointConfig> = {
  // Envelope endpoint URL
  envelope: "...",
  // Context endpoint URL.
  context: "...",
  // Discovery endpoint URL
  discovery: "...",
};
```

| Property | Type | Description |
|----------|------|-------------|
| `envelope` | `string` | Envelope endpoint URL |
| `context` | `string | undefined` | Context endpoint URL. |
| `discovery` | `string` | Discovery endpoint URL |

## `DiscoveryConfig`

Configuration for the discovery middleware (A2A v1.0 format).

```typescript
import type { DiscoveryConfig } from "@cleocode/monorepo";

const config: Partial<DiscoveryConfig> = {
  // Agent information (required for A2A v1.0; omit only with legacy `service`).
  agent: { /* ... */ },
  // Base URL for constructing absolute URLs.
  baseUrl: "...",
  // Cache duration in seconds.
  cacheMaxAge: 0,
  // Schema URL override.
  schemaUrl: "...",
  // Optional custom response headers.
  headers: { /* ... */ },
  // Automatically include LAFS as an A2A extension in Agent Card. Pass `true` for defaults, or an object to customize parameters.
  autoIncludeLafsExtension: true,
  // Legacy service configuration.
  service: { /* ... */ },
  // Legacy capabilities list.
  capabilities: [],
  // Legacy endpoint URLs.
  endpoints: { /* ... */ },
  // Legacy LAFS version override.
  lafsVersion: "...",
};
```

| Property | Type | Description |
|----------|------|-------------|
| `agent` | `Omit<AgentCard, "$schema"> | undefined` | Agent information (required for A2A v1.0; omit only with legacy `service`). |
| `baseUrl` | `string | undefined` | Base URL for constructing absolute URLs. |
| `cacheMaxAge` | `number | undefined` | Cache duration in seconds. |
| `schemaUrl` | `string | undefined` | Schema URL override. |
| `headers` | `Record<string, string> | undefined` | Optional custom response headers. |
| `autoIncludeLafsExtension` | `boolean | { required?: boolean; supportsContextLedger?: boolean; supportsTokenBudgets?: boolean; } | undefined` | Automatically include LAFS as an A2A extension in Agent Card. Pass `true` for defaults, or an object to customize parameters. |
| `service` | `ServiceConfig | undefined` | Legacy service configuration. |
| `capabilities` | `Capability[] | undefined` | Legacy capabilities list. |
| `endpoints` | `{ envelope: string; context?: string; discovery?: string; } | undefined` | Legacy endpoint URLs. |
| `lafsVersion` | `string | undefined` | Legacy LAFS version override. |

## `LafsA2AConfig`

Configuration for LAFS A2A integration.

```typescript
import type { LafsA2AConfig } from "@cleocode/monorepo";

const config: Partial<LafsA2AConfig> = {
  // Default token budget for all operations.
  defaultBudget: { /* ... */ },
  // Whether to automatically wrap responses in LAFS envelopes.
  envelopeResponses: true,
  // A2A protocol version to use.
  protocolVersion: "...",
  // Extension URIs to activate for all requests.
  defaultExtensions: "...",
};
```

| Property | Type | Description |
|----------|------|-------------|
| `defaultBudget` | `{ maxTokens?: number; maxItems?: number; maxBytes?: number; } | undefined` | Default token budget for all operations. |
| `envelopeResponses` | `boolean | undefined` | Whether to automatically wrap responses in LAFS envelopes. |
| `protocolVersion` | `string | undefined` | A2A protocol version to use. |
| `defaultExtensions` | `string[] | undefined` | Extension URIs to activate for all requests. |

## `CircuitBreakerConfig`

Configuration options for a `CircuitBreaker` instance.

```typescript
import type { CircuitBreakerConfig } from "@cleocode/monorepo";

const config: Partial<CircuitBreakerConfig> = {
  // Unique identifier for this circuit breaker, used in log messages and metrics.
  name: "...",
  // Number of failures required to trip the circuit from CLOSED to OPEN.
  failureThreshold: 0,
  // Milliseconds to wait before transitioning from OPEN to HALF_OPEN.
  resetTimeout: 0,
  // Maximum number of trial calls allowed while in the HALF_OPEN state.
  halfOpenMaxCalls: 0,
  // Consecutive successes required in HALF_OPEN to close the circuit.
  successThreshold: 0,
};
```

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | Unique identifier for this circuit breaker, used in log messages and metrics. |
| `failureThreshold` | `number | undefined` | Number of failures required to trip the circuit from CLOSED to OPEN. |
| `resetTimeout` | `number | undefined` | Milliseconds to wait before transitioning from OPEN to HALF_OPEN. |
| `halfOpenMaxCalls` | `number | undefined` | Maximum number of trial calls allowed while in the HALF_OPEN state. |
| `successThreshold` | `number | undefined` | Consecutive successes required in HALF_OPEN to close the circuit. |

## `HealthCheckConfig`

Configuration for the `healthCheck` middleware.

```typescript
import type { HealthCheckConfig } from "@cleocode/monorepo";

const config: Partial<HealthCheckConfig> = {
  // URL path at which the health endpoint is mounted.
  path: "...",
  // Array of custom health check functions to run on each request.
  checks: [],
};
```

| Property | Type | Description |
|----------|------|-------------|
| `path` | `string | undefined` | URL path at which the health endpoint is mounted. |
| `checks` | `HealthCheckFunction[] | undefined` | Array of custom health check functions to run on each request. |

## `GracefulShutdownConfig`

Configuration for the `gracefulShutdown` handler.

```typescript
import type { GracefulShutdownConfig } from "@cleocode/monorepo";

const config: Partial<GracefulShutdownConfig> = {
  // Maximum time in milliseconds to wait for in-flight requests before forcing exit.
  timeout: 0,
  // POSIX signals that trigger a graceful shutdown.
  signals: [],
  // Callback invoked at the start of shutdown, before the server stops accepting connections.
  onShutdown: undefined,
  // Callback invoked after all connections have closed (or the timeout elapsed).
  onClose: undefined,
};
```

| Property | Type | Description |
|----------|------|-------------|
| `timeout` | `number | undefined` | Maximum time in milliseconds to wait for in-flight requests before forcing exit. |
| `signals` | `NodeJS.Signals[] | undefined` | POSIX signals that trigger a graceful shutdown. |
| `onShutdown` | `(() => Promise<void> | void) | undefined` | Callback invoked at the start of shutdown, before the server stops accepting connections. |
| `onClose` | `(() => Promise<void> | void) | undefined` | Callback invoked after all connections have closed (or the timeout elapsed). |

## `AgentPollerConfig`

Poller configuration.

```typescript
import type { AgentPollerConfig } from "@cleocode/monorepo";

const config: Partial<AgentPollerConfig> = {
  // Agent ID to poll as.
  agentId: "...",
  // API key for authentication.
  apiKey: "...",
  // API base URL.
  apiBaseUrl: "...",
  // Poll interval in milliseconds. Default: 5000.
  pollIntervalMs: 0,
  // Known group conversation IDs to monitor for mentions.
  groupConversationIds: "...",
  // Max messages to fetch per group conversation poll. Default: 15.
  groupPollLimit: 0,
  // Transport instance for polling messages. When provided, poll() delegates to transport.poll() instead of raw HTTP. The transport must already be connected before passing to AgentPoller.
  transport: { /* ... */ },
};
```

| Property | Type | Description |
|----------|------|-------------|
| `agentId` | `string` | Agent ID to poll as. |
| `apiKey` | `string` | API key for authentication. |
| `apiBaseUrl` | `string` | API base URL. |
| `pollIntervalMs` | `number | undefined` | Poll interval in milliseconds. Default: 5000. |
| `groupConversationIds` | `string[] | undefined` | Known group conversation IDs to monitor for mentions. |
| `groupPollLimit` | `number | undefined` | Max messages to fetch per group conversation poll. Default: 15. |
| `transport` | `Transport | undefined` | Transport instance for polling messages. When provided, poll() delegates to transport.poll() instead of raw HTTP. The transport must already be connected before passing to AgentPoller. |

## `HeartbeatConfig`

Heartbeat service configuration.

```typescript
import type { HeartbeatConfig } from "@cleocode/monorepo";

const config: Partial<HeartbeatConfig> = {
  // Agent ID to send heartbeats for.
  agentId: "...",
  // API key for authentication.
  apiKey: "...",
  // API base URL.
  apiBaseUrl: "...",
  // Heartbeat interval in milliseconds. Default: 30000 (30s).
  intervalMs: 0,
};
```

| Property | Type | Description |
|----------|------|-------------|
| `agentId` | `string` | Agent ID to send heartbeats for. |
| `apiKey` | `string` | API key for authentication. |
| `apiBaseUrl` | `string` | API base URL. |
| `intervalMs` | `number | undefined` | Heartbeat interval in milliseconds. Default: 30000 (30s). |

## `KeyRotationConfig`

Key rotation service configuration.

```typescript
import type { KeyRotationConfig } from "@cleocode/monorepo";

const config: Partial<KeyRotationConfig> = {
  // Agent ID to monitor.
  agentId: "...",
  // AgentRegistryAPI instance for credential lookup and rotation.
  registry: { /* ... */ },
  // Check interval in milliseconds. Default: 3600000 (1 hour).
  checkIntervalMs: 0,
  // Max key age in milliseconds before rotation. Default: 2592000000 (30 days).
  maxKeyAgeMs: 0,
};
```

| Property | Type | Description |
|----------|------|-------------|
| `agentId` | `string` | Agent ID to monitor. |
| `registry` | `AgentRegistryAPI` | AgentRegistryAPI instance for credential lookup and rotation. |
| `checkIntervalMs` | `number | undefined` | Check interval in milliseconds. Default: 3600000 (1 hour). |
| `maxKeyAgeMs` | `number | undefined` | Max key age in milliseconds before rotation. Default: 2592000000 (30 days). |

## `SseConnectionConfig`

SSE connection service configuration.

```typescript
import type { SseConnectionConfig } from "@cleocode/monorepo";

const config: Partial<SseConnectionConfig> = {
  // Agent ID to connect as.
  agentId: "...",
  // API key for authentication.
  apiKey: "...",
  // API base URL.
  apiBaseUrl: "...",
  // SSE endpoint URL. If omitted, uses apiBaseUrl + /sse.
  sseEndpoint: "...",
  // Transport instance to use. Injected by createRuntime.
  transport: { /* ... */ },
};
```

| Property | Type | Description |
|----------|------|-------------|
| `agentId` | `string` | Agent ID to connect as. |
| `apiKey` | `string` | API key for authentication. |
| `apiBaseUrl` | `string` | API base URL. |
| `sseEndpoint` | `string | undefined` | SSE endpoint URL. If omitted, uses apiBaseUrl + /sse. |
| `transport` | `Transport` | Transport instance to use. Injected by createRuntime. |

## `RuntimeConfig`

Configuration for createRuntime().

```typescript
import type { RuntimeConfig } from "@cleocode/monorepo";

const config: Partial<RuntimeConfig> = {
  // Agent ID to run as. If omitted, uses the most recently used active agent.
  agentId: "...",
  // Poll interval in milliseconds. Default: 5000.
  pollIntervalMs: 0,
  // Known group conversation IDs to monitor for mentions.
  groupConversationIds: "...",
  // Max messages per group conversation poll. Default: 15.
  groupPollLimit: 0,
  // Heartbeat interval in milliseconds. Default: 30000. Set to 0 to disable.
  heartbeatIntervalMs: 0,
  // Max key age in milliseconds before rotation. Default: 30 days. Set to 0 to disable.
  maxKeyAgeMs: 0,
  // SSE endpoint URL. If set, enables persistent SSE connection.
  sseEndpoint: "...",
  // Transport factory for SSE connection. Caller provides to avoid circular deps.
  createSseTransport: undefined,
  // Pre-created transport instance. When provided, bypasses auto-resolution. The transport must NOT be connected yet — createRuntime handles connection.
  transport: { /* ... */ },
};
```

| Property | Type | Description |
|----------|------|-------------|
| `agentId` | `string | undefined` | Agent ID to run as. If omitted, uses the most recently used active agent. |
| `pollIntervalMs` | `number | undefined` | Poll interval in milliseconds. Default: 5000. |
| `groupConversationIds` | `string[] | undefined` | Known group conversation IDs to monitor for mentions. |
| `groupPollLimit` | `number | undefined` | Max messages per group conversation poll. Default: 15. |
| `heartbeatIntervalMs` | `number | undefined` | Heartbeat interval in milliseconds. Default: 30000. Set to 0 to disable. |
| `maxKeyAgeMs` | `number | undefined` | Max key age in milliseconds before rotation. Default: 30 days. Set to 0 to disable. |
| `sseEndpoint` | `string | undefined` | SSE endpoint URL. If set, enables persistent SSE connection. |
| `createSseTransport` | `(() => import("@cleocode/contracts").Transport) | undefined` | Transport factory for SSE connection. Caller provides to avoid circular deps. |
| `transport` | `Transport | undefined` | Pre-created transport instance. When provided, bypasses auto-resolution. The transport must NOT be connected yet — createRuntime handles connection. |
