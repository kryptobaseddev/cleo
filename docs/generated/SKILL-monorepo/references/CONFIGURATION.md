# @cleocode/monorepo — Configuration Reference

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

Rate limit configuration for a single category

```typescript
import type { RateLimitConfig } from "@cleocode/monorepo";

const config: Partial<RateLimitConfig> = {
  // Maximum requests allowed in the window
  maxRequests: 0,
  // Time window in milliseconds
  windowMs: 0,
};
```

| Property | Type | Description |
|----------|------|-------------|
| `maxRequests` | `number` | Maximum requests allowed in the window |
| `windowMs` | `number` | Time window in milliseconds |

## `RateLimitingConfig`

Complete rate limiting configuration

```typescript
import type { RateLimitingConfig } from "@cleocode/monorepo";

const config: Partial<RateLimitingConfig> = {
  // Enable/disable rate limiting globally
  enabled: true,
  // Limits for query gateway operations
  query: { /* ... */ },
  // Limits for mutate gateway operations
  mutate: { /* ... */ },
  // Limits for spawn operations (orchestrate.spawn)
  spawn: { /* ... */ },
};
```

| Property | Type | Description |
|----------|------|-------------|
| `enabled` | `boolean` | Enable/disable rate limiting globally |
| `query` | `RateLimitConfig` | Limits for query gateway operations |
| `mutate` | `RateLimitConfig` | Limits for mutate gateway operations |
| `spawn` | `RateLimitConfig` | Limits for spawn operations (orchestrate.spawn) |

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

## `MCPConfig`

```typescript
import type { MCPConfig } from "@cleocode/monorepo";

const config: Partial<MCPConfig> = {
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
| `logLevel` | `"error" | "debug" | "info" | "warn"` | Logging verbosity level (default: 'info') |
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

## `RateLimitConfig`

Rate Limit Configuration

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

## `RateLimitingConfig`

```typescript
import type { RateLimitingConfig } from "@cleocode/monorepo";

const config: Partial<RateLimitingConfig> = {
  enabled: true,
  query: { /* ... */ },
  mutate: { /* ... */ },
  spawn: { /* ... */ },
};
```

| Property | Type | Description |
|----------|------|-------------|
| `enabled` | `boolean` |  |
| `query` | `RateLimitConfig` |  |
| `mutate` | `RateLimitConfig` |  |
| `spawn` | `RateLimitConfig` |  |

## `McpDispatcherConfig`

```typescript
import type { McpDispatcherConfig } from "@cleocode/monorepo";

const config: Partial<McpDispatcherConfig> = {
  rateLimiting: { /* ... */ },
  strictMode: true,
};
```

| Property | Type | Description |
|----------|------|-------------|
| `rateLimiting` | `Partial<RateLimitingConfig> | undefined` |  |
| `strictMode` | `boolean | undefined` |  |

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

## `RateLimitConfig`

Rate limiter configuration

```typescript
import type { RateLimitConfig } from "@cleocode/monorepo";

const config: Partial<RateLimitConfig> = {
  // Maximum requests allowed in the window
  maxRequests: 0,
  // Time window in milliseconds
  windowMs: 0,
};
```

| Property | Type | Description |
|----------|------|-------------|
| `maxRequests` | `number` | Maximum requests allowed in the window |
| `windowMs` | `number` | Time window in milliseconds |

## `OutputConfig`

Output configuration.

```typescript
import type { OutputConfig } from "@cleocode/monorepo";

const config: Partial<OutputConfig> = {
  defaultFormat: { /* ... */ },
  showColor: true,
  showUnicode: true,
  showProgressBars: true,
  dateFormat: { /* ... */ },
};
```

| Property | Type | Description |
|----------|------|-------------|
| `defaultFormat` | `OutputFormat` |  |
| `showColor` | `boolean` |  |
| `showUnicode` | `boolean` |  |
| `showProgressBars` | `boolean` |  |
| `dateFormat` | `DateFormat` |  |

## `BackupConfig`

Backup configuration.

```typescript
import type { BackupConfig } from "@cleocode/monorepo";

const config: Partial<BackupConfig> = {
  maxOperationalBackups: 0,
  maxSafetyBackups: 0,
  compressionEnabled: true,
};
```

| Property | Type | Description |
|----------|------|-------------|
| `maxOperationalBackups` | `number` |  |
| `maxSafetyBackups` | `number` |  |
| `compressionEnabled` | `boolean` |  |

## `HierarchyConfig`

Hierarchy configuration.

```typescript
import type { HierarchyConfig } from "@cleocode/monorepo";

const config: Partial<HierarchyConfig> = {
  maxDepth: 0,
  maxSiblings: 0,
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
| `maxDepth` | `number` |  |
| `maxSiblings` | `number` |  |
| `cascadeDelete` | `boolean` |  |
| `maxActiveSiblings` | `number` | Maximum number of active (non-done) siblings. 0 = disabled. |
| `countDoneInLimit` | `boolean` | Whether done tasks count toward the sibling limit. |
| `enforcementProfile` | `EnforcementProfile` | Enforcement profile preset. Explicit fields override preset values. |

## `SessionConfig`

Session configuration.

```typescript
import type { SessionConfig } from "@cleocode/monorepo";

const config: Partial<SessionConfig> = {
  autoStart: true,
  requireNotes: true,
  multiSession: true,
};
```

| Property | Type | Description |
|----------|------|-------------|
| `autoStart` | `boolean` |  |
| `requireNotes` | `boolean` |  |
| `multiSession` | `boolean` |  |

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

## `LifecycleConfig`

Lifecycle enforcement configuration.

```typescript
import type { LifecycleConfig } from "@cleocode/monorepo";

const config: Partial<LifecycleConfig> = {
  mode: { /* ... */ },
};
```

| Property | Type | Description |
|----------|------|-------------|
| `mode` | `LifecycleEnforcementMode` |  |

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
  version: "...",
  output: { /* ... */ },
  backup: { /* ... */ },
  hierarchy: { /* ... */ },
  session: { /* ... */ },
  lifecycle: { /* ... */ },
  logging: { /* ... */ },
  sharing: { /* ... */ },
  // SignalDock inter-agent transport (optional, disabled by default).
  signaldock: { /* ... */ },
};
```

| Property | Type | Description |
|----------|------|-------------|
| `version` | `string` |  |
| `output` | `OutputConfig` |  |
| `backup` | `BackupConfig` |  |
| `hierarchy` | `HierarchyConfig` |  |
| `session` | `SessionConfig` |  |
| `lifecycle` | `LifecycleConfig` |  |
| `logging` | `LoggingConfig` |  |
| `sharing` | `SharingConfig` |  |
| `signaldock` | `SignalDockConfig | undefined` | SignalDock inter-agent transport (optional, disabled by default). |

## `MemoryBridgeConfig`

Memory bridge types for CLEO provider adapters. Defines the shape of .cleo/memory-bridge.md content for cross-provider memory sharing.   T5240

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
| `options` | `{ [key: string]: unknown; provenance?: boolean | undefined; access?: string | undefined; tag?: string | undefined; attestations?: boolean | undefined; } | undefined` |  |

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
  versionBump: [],
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
| `versionBump` | `{ files: { file: string; strategy: string; field?: string | undefined; }[]; }` |  |
| `security` | `{ enableProvenance: boolean; slsaLevel: number; requireSignedCommits: boolean; }` |  |
| `gitflow` | `GitFlowConfig | undefined` |  |
| `channels` | `ChannelConfig | undefined` |  |
| `push` | `{ mode?: PushMode | undefined; } | undefined` |  |

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

## `SignalDockTransportConfig`

Configuration for SignalDockTransport.

```typescript
import type { SignalDockTransportConfig } from "@cleocode/monorepo";

const config: Partial<SignalDockTransportConfig> = {
  // Base URL of the SignalDock API server.
  endpoint: "...",
  // Prefix for agent names (e.g., "cleo-" - "cleo-orchestrator").
  agentPrefix: "...",
  // Default privacy tier for registered agents.
  privacyTier: { /* ... */ },
};
```

| Property | Type | Description |
|----------|------|-------------|
| `endpoint` | `string` | Base URL of the SignalDock API server. |
| `agentPrefix` | `string` | Prefix for agent names (e.g., "cleo-" - "cleo-orchestrator"). |
| `privacyTier` | `PrivacyTier` | Default privacy tier for registered agents. |

## `TransportFactoryConfig`

Configuration for transport selection.

```typescript
import type { TransportFactoryConfig } from "@cleocode/monorepo";

const config: Partial<TransportFactoryConfig> = {
  enabled: true,
  mode: undefined,
  endpoint: "...",
  agentPrefix: "...",
  privacyTier: undefined,
};
```

| Property | Type | Description |
|----------|------|-------------|
| `enabled` | `boolean` |  |
| `mode` | `"http" | "native"` |  |
| `endpoint` | `string` |  |
| `agentPrefix` | `string` |  |
| `privacyTier` | `"public" | "discoverable" | "private"` |  |

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
