# Shared Utilities

This directory contains shared library functions used across domain handlers.

## Implemented Modules

### Response Formatter (T2912)

**Files**: `formatter.ts`, `schema.ts`

Response formatter with _meta envelope wrapping for consistent CLI/MCP output.

**Usage**:
```typescript
import { formatSuccess, formatError, createError } from './lib/formatter.js';

// Success response
const response = formatSuccess('tasks.show', { taskId: 'T001', title: 'Test' });

// Error response
const error = createError('E_NOT_FOUND', 'Task not found', 4, {
  suggestion: 'Check task ID',
  fix: 'cleo find "Test"',
  alternatives: [{ action: 'List all', command: 'cleo list' }]
});
const response = formatError('tasks.show', error);
```

**Response Format**:
```json
{
  "$schema": "https://cleo-dev.com/schemas/v1/output.schema.json",
  "_meta": {
    "format": "json",
    "version": "0.80.2",
    "command": "tasks.show",
    "timestamp": "2026-02-03T12:34:56.789Z",
    "session": "session_123"
  },
  "success": true,
  "data": { ... }
}
```

**Recoverable Errors**:
Exit codes that support retry with exponential backoff:
- `7` - E_RETRYABLE
- `20-22` - Lock/state errors
- `60-63` - Protocol violations (research, consensus, spec, decomposition)

**Tests**: `__tests__/formatter.test.ts`, `__tests__/schema.test.ts`

### Configuration (T2928)

**Files**: `config.ts`, `defaults.ts`

Configuration loader with support for environment variables, config files, and defaults.

**Configuration Sources** (priority order):
1. Environment variables (`CLEO_MCP_*`)
2. Config file (`.cleo/config.json`)
3. Defaults

**Available Options**:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `cliPath` | string | `'cleo'` | Path to CLEO CLI binary |
| `timeout` | number | `30000` | Operation timeout (milliseconds) |
| `logLevel` | enum | `'info'` | Logging verbosity |
| `enableMetrics` | boolean | `false` | Enable token tracking |
| `maxRetries` | number | `3` | Retry count |
| `queryCacheTtl` | number | `30000` | Cache TTL |
| `auditLog` | boolean | `true` | Enable audit logging |
| `strictValidation` | boolean | `true` | Strict validation mode |

**Usage**:
```typescript
import { getConfig } from './lib/config.js';

const config = getConfig();
console.log(`Timeout: ${config.timeout}ms`);
```

**Environment Variables**:
```bash
export CLEO_MCP_CLIPATH=/usr/local/bin/cleo
export CLEO_MCP_TIMEOUT=60000
export CLEO_MCP_LOGLEVEL=debug
export CLEO_MCP_ENABLEMETRICS=true
```

**Tests**: `__tests__/config.test.ts`

### Domain Router (T2911)

**Files**: `router.ts`

Domain router that dispatches operations to appropriate handlers with _meta envelope wrapping.

**Usage**:
```typescript
import { DomainRouter } from './lib/router.js';

const router = new DomainRouter();
const response = await router.routeOperation({
  gateway: 'cleo_query',
  domain: 'tasks',
  operation: 'get',
  params: { taskId: 'T001' }
});
```

## Planned Modules

1. **cli-wrapper.ts** - Execute CLEO CLI commands and parse JSON output
   - `executeCliCommand(command: string, args: string[]): Promise<unknown>`
   - Handles stdout/stderr parsing
   - Maps exit codes to error responses
   - Implements retry logic for retryable errors (7, 20, 21, 22, 60-63)

2. **validation.ts** - Input validation helpers
   - `validateTaskId(id: string): boolean`
   - `validatePath(path: string): boolean`
   - `validateEnum(value: string, allowed: string[]): boolean`
   - `sanitizeInput(input: unknown): unknown`

3. **exit-codes.ts** - Exit code constants and error mapping
   - Maps CLI exit codes to error responses
   - Determines if error is retryable
   - Provides actionable fix suggestions

4. **types.ts** - Shared TypeScript types
   - Request/response interfaces
   - Domain-specific types
   - Error types

## Implementation Notes

All utilities must:
- Use TypeScript strict mode
- Include JSDoc comments
- Handle errors gracefully
- Support async operations where needed
- Maintain single source of truth with CLI
- Use formatter for all responses
