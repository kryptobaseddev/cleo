# @cleocode/lafs — Configuration Reference

## `ServiceConfig`

Legacy service configuration.

```typescript
import type { ServiceConfig } from "@cleocode/lafs";

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
import type { EndpointConfig } from "@cleocode/lafs";

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
import type { DiscoveryConfig } from "@cleocode/lafs";

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
import type { LafsA2AConfig } from "@cleocode/lafs";

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
import type { CircuitBreakerConfig } from "@cleocode/lafs";

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
import type { HealthCheckConfig } from "@cleocode/lafs";

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
import type { GracefulShutdownConfig } from "@cleocode/lafs";

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
