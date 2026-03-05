# T5318 Wave 2 Prep Notes

Prepared for T5335 (initLogger), T5336 (MCP startup), T5337 (audit middleware + config).

---

## 1. Logger File: `src/core/logger.ts`

**Current `initLogger()` signature** (line 48):
```typescript
export function initLogger(cleoDir: string, config: LoggerConfig): pino.Logger
```

**`LoggerConfig` interface** (line 20-25, same file):
```typescript
export interface LoggerConfig {
  level: string;
  filePath: string;
  maxFileSize: number;
  maxFiles: number;
}
```

**Pino constructor** (lines 73-82) — NO `base` object currently:
```typescript
rootLogger = pino(
  {
    level: config.level,
    formatters: {
      level: (label: string) => ({ level: label.toUpperCase() }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  transport,
);
```

**T5335 must**: Add `projectHash?: string` as 3rd param. If provided, add `base: { projectHash }` to pino options. If absent, log warn AFTER logger is created (so it goes to file, not stderr).

**Exports**: `initLogger`, `getLogger`, `getLogDir`, `closeLogger`

---

## 2. MCP `console.error` Call Sites: `src/mcp/index.ts`

| Line | Content | Classification |
|------|---------|---------------|
| 52-55 | Node.js version check failure | PRE-INIT: KEEP as console.error |
| 65 | Global bootstrap warning | PRE-INIT: KEEP as console.error |
| 69 | "Loading configuration..." | POST-CONFIG: migrate to Pino info |
| 73 | "Starting server..." | POST-CONFIG: migrate to Pino info |
| 74 | Log level info | POST-CONFIG: migrate to Pino info |
| 75 | Metrics status | POST-CONFIG: migrate to Pino info |
| 78 | "Initializing dispatch layer..." | POST-CONFIG: migrate to Pino info |
| 83 | "Dispatch layer initialized" | POST-CONFIG: migrate to Pino info |
| 88 | "Background job manager initialized" | POST-CONFIG: migrate to Pino info |
| 92 | Query cache status | POST-CONFIG: migrate to Pino info |
| 123 | Tool call name | REQUEST: migrate to Pino debug |
| 125 | Tool call arguments (debug-only) | REQUEST: migrate to Pino debug |
| 189 | Cache hit (debug-only) | REQUEST: migrate to Pino debug |
| 206 | Result (debug-only) | REQUEST: migrate to Pino debug |
| 218 | Budget enforcement (debug-only) | REQUEST: migrate to Pino debug |
| 231 | Cache invalidated (debug-only) | REQUEST: migrate to Pino debug |
| 244 | Error in tool call | REQUEST: migrate to Pino error |
| 284 | "Connecting to stdio transport..." | POST-CONFIG: migrate to Pino info |
| 288 | "Server started successfully" | POST-CONFIG: migrate to Pino info |
| 289 | "Ready for requests" | POST-CONFIG: migrate to Pino info |
| 291 | "Failed to start server" | FATAL: migrate to Pino fatal, keep console.error as backup |
| 300 | Shutdown signal received | SHUTDOWN: KEEP as console.error (logger may be closing) |
| 310 | "Server closed" | SHUTDOWN: KEEP as console.error |
| 312 | "Error during shutdown" | SHUTDOWN: KEEP as console.error |
| 323 | Uncaught error | SHUTDOWN: KEEP as console.error |
| 352 | Fatal error in main() | FATAL: KEEP as console.error |

**Total**: 25 console.error call sites. 16 to migrate, 9 to keep.

**CRITICAL GOTCHA**: `initLogger()` must be inserted AFTER `loadConfig()` at line 70 but BEFORE `initMcpDispatcher()` at line 79. The insertion point is between lines 75 and 77.

---

## 3. Audit Middleware: `src/dispatch/middleware/audit.ts`

**`writeToSqlite()` insert statement** (lines 86-103):
```typescript
await db.insert(auditLog).values({
  id: randomUUID(),
  timestamp: entry.timestamp,
  action: entry.operation,
  taskId: entry.metadata.taskId ?? 'system',
  actor: entry.metadata.userId ?? 'agent',
  detailsJson: JSON.stringify(entry.params),
  // Dispatch-level columns (ADR-019)
  domain: entry.domain,
  operation: entry.operation,
  sessionId: entry.sessionId,
  requestId: requestId ?? null,
  durationMs: entry.result.duration,
  success: entry.result.success ? 1 : 0,
  source: entry.metadata.source,
  gateway: entry.metadata.gateway ?? null,
  errorMessage: entry.error ?? null,
}).run();
```

**T5337 must add**: `projectHash: projectHash ?? null` to this values object.

**How to get projectHash**: Import `readProjectInfo` from `src/core/project-info.ts` (created by T5333). Cache the result in a module-level variable since project-info.json is immutable. Pattern:
```typescript
let cachedProjectHash: string | null | undefined; // undefined = not yet read
async function getProjectHash(): Promise<string | null> {
  if (cachedProjectHash !== undefined) return cachedProjectHash;
  try {
    const { readProjectInfo } = await import('../../core/project-info.js');
    const info = readProjectInfo(process.cwd());
    cachedProjectHash = info?.projectId ?? info?.projectHash ?? null;
  } catch {
    cachedProjectHash = null;
  }
  return cachedProjectHash;
}
```

**Pino log call** (lines 154-166) does NOT include `projectHash` either — but it will inherit from the root logger base context if T5335 adds it to `pino({ base: { projectHash } })`. No change needed in audit.ts for the Pino path.

---

## 4. LoggingConfig Location and Current Fields

**Canonical type**: `src/types/config.ts:57-66`
```typescript
export interface LoggingConfig {
  level: LogLevel;
  filePath: string;
  maxFileSize: number;
  maxFiles: number;
}
```

**Defaults**: `src/core/config.ts:48-53`
```typescript
logging: {
  level: 'info',
  filePath: 'logs/cleo.log',
  maxFileSize: 10 * 1024 * 1024, // 10MB
  maxFiles: 5,
},
```

**T5337 must add** to `LoggingConfig`:
- `auditRetentionDays: number` (default: 90)
- `archiveBeforePrune: boolean` (default: true)

Update BOTH `src/types/config.ts` (interface) AND `src/core/config.ts` (defaults).

**Note**: There is ALSO a `LoggerConfig` in `src/core/logger.ts:20-25` (4 fields, same shape but `level: string` not `LogLevel`). This is the logger's own config — it does NOT need the retention fields (those are for audit pruning, not pino).

---

## 5. Gotchas for Wave 2 Agents

### GOTCHA 1: Two Config Systems
MCP has its own `MCPConfig` at `src/mcp/lib/defaults.ts` with `logLevel` as a flat string field. CLI uses `CleoConfig` from `src/types/config.ts` with nested `logging: LoggingConfig`. T5336 agent must construct a `LoggerConfig` object from MCPConfig fields:
```typescript
// MCPConfig has: config.logLevel (string)
// LoggerConfig needs: { level, filePath, maxFileSize, maxFiles }
// Construct manually:
initLogger(join(process.cwd(), '.cleo'), {
  level: config.logLevel ?? 'info',
  filePath: 'logs/cleo.log',
  maxFileSize: 10 * 1024 * 1024,
  maxFiles: 5,
}, projectInfo?.projectId);
```

### GOTCHA 2: logger.ts LoggerConfig vs types/config.ts LoggingConfig
These are two SEPARATE interfaces with the same 4 fields but different names:
- `LoggerConfig` (src/core/logger.ts:20) — used by `initLogger()`
- `LoggingConfig` (src/types/config.ts:57) — used by `CleoConfig.logging`

They are compatible (same fields). Do NOT accidentally merge them or rename one.

### GOTCHA 3: MCP loadConfig returns MCPConfig, not CleoConfig
`src/mcp/lib/config.ts:loadConfig()` returns `MCPConfig`. The CLI's `src/core/config.ts:loadConfig()` returns `CleoConfig`. They are different types. T5336 must use the MCP one (already imported) and construct LoggerConfig manually.

### GOTCHA 4: Audit middleware config
`audit.ts` line 131 calls `getConfig()` from `src/dispatch/lib/config.ts`, NOT from `src/mcp/lib/config.ts` or `src/core/config.ts`. Check what this `getConfig()` returns:
```typescript
import { getConfig } from '../lib/config.js';  // dispatch config
```
The `config.auditLog` boolean check (line 132) comes from this dispatch config. T5337 must find where dispatch config stores the auditLog flag.

### GOTCHA 5: projectHash vs projectId field naming
Existing `project-info.json` has `projectHash` (12-char SHA-256 hex of path). T5333 is adding `projectId` (UUID). The audit column is named `project_hash` in the DB schema (T5334). Decide which value to store: prefer `projectId` (UUID, stable across dir moves) if available, fall back to `projectHash`.

### GOTCHA 6: closeLogger() needed in MCP shutdown
T5336 must call `closeLogger()` in the `shutdown()` function (line 299) to flush pino buffers before process exit. Import it alongside `initLogger`.

### GOTCHA 7: auditRetentionDays env var
T5337 should add `CLEO_AUDIT_RETENTION_DAYS` env var support. Check if this belongs in `src/core/config.ts` env resolution or needs separate handling.

---

## 6. File Dependency Map

```
T5333 (project-info.ts) ─────────────────────────────────┐
   creates: src/core/project-info.ts                      │
   modifies: src/core/scaffold.ts (add projectId field)   │
                                                          │
T5334 (drizzle migration) ────────────────────────────────┤
   modifies: src/store/schema.ts (add projectHash column) │
                                                          │
T5335 (initLogger projectHash) ───────────────────────────┤
   modifies: src/core/logger.ts                           │
   depends on: T5333 (needs readProjectInfo for testing)  │
                                                          │
T5336 (MCP startup) ──────────────────────────────────────┤
   modifies: src/mcp/index.ts                             │
   depends on: T5333 (readProjectInfo), T5335 (initLogger │
   with projectHash param)                                │
                                                          │
T5337 (audit middleware + config) ────────────────────────┘
   modifies: src/dispatch/middleware/audit.ts
   modifies: src/types/config.ts
   modifies: src/core/config.ts
   depends on: T5333 (readProjectInfo), T5334 (schema column)
```
