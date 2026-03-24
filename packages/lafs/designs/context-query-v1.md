# LAFS Context Ledger Query API Design v1

## Executive Summary

This document specifies the `GET /_lafs/context/{ledgerId}` API for efficient context ledger state retrieval. Designed for agent efficiency in multi-step workflows with <10% context overhead target.

---

## 1. API Specification

### 1.1 Endpoint

```
GET /_lafs/context/{ledgerId}
```

### 1.2 Path Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `ledgerId` | string | Yes | Unique context ledger identifier (UUID or URI-safe string) |

### 1.3 Query Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `mode` | enum: `full`, `delta`, `summary` | `full` | Projection mode for response |
| `sinceVersion` | integer | - | For delta mode: return entries after this version |
| `filterByOperation` | string[] | - | Filter entries by operation name(s) |
| `limit` | integer (1-1000) | 100 | Max entries to return |
| `offset` | integer | 0 | Offset for pagination (mode=full only) |
| `cursor` | string | - | Cursor for pagination (mode=delta only) |
| `includeChecksum` | boolean | true | Include integrity checksum |
| `fields` | string[] | - | Field selection for summary mode |

### 1.4 Headers

| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | Yes | Bearer token or API key |
| `Accept` | No | `application/json` (default) |
| `X-LAFS-Client-Version` | No | Client version for compatibility |

---

## 2. Projection Modes

### 2.1 Full Mode (`mode=full`)

Returns complete ledger state including all entries. Use for initial loads or when full state is needed.

**When to use:**
- Initial context load
- Recovery scenarios
- Debugging/tracing

**Response Schema:**
```json
{
  "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
  "_meta": {
    "specVersion": "1.0.0",
    "schemaVersion": "1.0.0",
    "timestamp": "2026-02-16T10:30:00Z",
    "operation": "context.query",
    "requestId": "req_ctx_001",
    "transport": "http",
    "strict": true,
    "mvi": "standard",
    "contextVersion": 42
  },
  "success": true,
  "result": {
    "ledgerId": "ctx_abc123",
    "mode": "full",
    "version": 42,
    "createdAt": "2026-02-16T09:00:00Z",
    "updatedAt": "2026-02-16T10:25:00Z",
    "checksum": "sha256:abc123...",
    "entryCount": 42,
    "entries": [
      {
        "entryId": "ent_001",
        "timestamp": "2026-02-16T09:05:00Z",
        "operation": "task.initialize",
        "requestId": "req_001",
        "contextDelta": { "objective": "Analyze Q1 metrics" }
      }
    ]
  },
  "page": {
    "mode": "offset",
    "limit": 100,
    "offset": 0,
    "hasMore": false,
    "total": 42
  }
}
```

### 2.2 Delta Mode (`mode=delta`)

Returns only changes since specified version. Optimized for ongoing workflows.

**When to use:**
- Step N+1 in multi-step workflow
- Polling for updates
- Minimizing bandwidth

**Query Requirements:**
- `sinceVersion` is REQUIRED for delta mode
- Returns entries where `entry.version > sinceVersion`

**Response Schema:**
```json
{
  "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
  "_meta": {
    "specVersion": "1.0.0",
    "schemaVersion": "1.0.0",
    "timestamp": "2026-02-16T10:30:00Z",
    "operation": "context.query",
    "requestId": "req_ctx_002",
    "transport": "http",
    "strict": true,
    "mvi": "minimal",
    "contextVersion": 42
  },
  "success": true,
  "result": {
    "ledgerId": "ctx_abc123",
    "mode": "delta",
    "fromVersion": 40,
    "toVersion": 42,
    "checksum": "sha256:abc123...",
    "entryCount": 2,
    "entries": [
      {
        "entryId": "ent_041",
        "version": 41,
        "timestamp": "2026-02-16T10:20:00Z",
        "operation": "constraint.add",
        "requestId": "req_041",
        "contextDelta": { "constraints": ["budget < $10K"] }
      },
      {
        "entryId": "ent_042",
        "version": 42,
        "timestamp": "2026-02-16T10:25:00Z",
        "operation": "decision.record",
        "requestId": "req_042",
        "contextDelta": { "decisions": ["Use AWS over GCP"] }
      }
    ],
    "deltaFormat": {
      "type": "append-only",
      "patch": null,
      "merges": null
    }
  },
  "page": {
    "mode": "cursor",
    "limit": 100,
    "nextCursor": "cursor_eyJ2ZXJzaW9uIjo0Mn0=",
    "hasMore": false,
    "total": 2
  }
}
```

### 2.3 Summary Mode (`mode=summary`)

Returns minimal metadata for quick state verification. Designed for <100ms responses.

**When to use:**
- Version verification before delta query
- Health checks
- Conflict detection (compare checksums)

**Response Schema:**
```json
{
  "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
  "_meta": {
    "specVersion": "1.0.0",
    "schemaVersion": "1.0.0",
    "timestamp": "2026-02-16T10:30:00Z",
    "operation": "context.query",
    "requestId": "req_ctx_003",
    "transport": "http",
    "strict": true,
    "mvi": "minimal",
    "contextVersion": 42
  },
  "success": true,
  "result": {
    "ledgerId": "ctx_abc123",
    "mode": "summary",
    "version": 42,
    "checksum": "sha256:abc123...",
    "entryCount": 42,
    "createdAt": "2026-02-16T09:00:00Z",
    "updatedAt": "2026-02-16T10:25:00Z",
    "isCompacted": false,
    "compactedAt": null
  },
  "page": {
    "mode": "none"
  }
}
```

---

## 3. Delta Format Specification

### 3.1 Delta Types

The LAFS context ledger uses **append-only delta format** for optimal agent performance:

| Delta Type | Use Case | Overhead |
|------------|----------|----------|
| `append-only` | Standard workflow steps | ~2% |
| `json-patch` | Complex state mutations | ~15% |
| `state-snapshot` | Recovery/rebase scenarios | ~100% |

### 3.2 Append-Only Delta Structure

```json
{
  "deltaFormat": {
    "type": "append-only",
    "patch": null,
    "merges": null,
    "metadata": {
      "baseVersion": 40,
      "targetVersion": 42,
      "entryCount": 2,
      "timestamp": "2026-02-16T10:30:00Z"
    }
  },
  "entries": [
    {
      "entryId": "ent_041",
      "version": 41,
      "operation": "constraint.add",
      "contextDelta": { "path": "constraints", "action": "append", "value": "budget < $10K" }
    }
  ]
}
```

### 3.3 ContextDelta Operations

Standard operations for efficient agent processing:

| Operation | Description | Example |
|-----------|-------------|---------|
| `set` | Replace entire value | `{"objective": "New objective"}` |
| `append` | Add to array | `{"constraints": [{"action": "append", "value": "..."}]}` |
| `remove` | Remove from array | `{"constraints": [{"action": "remove", "id": "c1"}]}` |
| `update` | Update nested field | `{"state.phase": "in_progress"}` |

### 3.4 Delta Compression

For large deltas (>10KB), implementations MAY support:

- **Gzip compression** via `Accept-Encoding: gzip`
- **Field filtering** via `_fields` parameter
- **Operation filtering** via `filterByOperation`

---

## 4. Filtering & Field Selection

### 4.1 Operation Filtering

Filter entries by operation type:

```
GET /_lafs/context/ctx_abc123?mode=delta&sinceVersion=40&filterByOperation=decision.record,constraint.add
```

**Behavior:**
- Multiple values: OR logic (match any)
- Wildcard support: `filterByOperation=task.*`
- Negation: `filterByOperation=!system.*`

### 4.2 Field Selection (Summary Mode)

Select specific fields for lightweight responses:

```
GET /_lafs/context/ctx_abc123?mode=summary&fields=version,checksum,updatedAt
```

**Default Fields:**
- `ledgerId`, `version`, `checksum`, `entryCount`

---

## 5. Pagination Strategy

### 5.1 Mode-Specific Pagination

| Mode | Pagination | Use Case |
|------|------------|----------|
| `full` | Offset-based | Browse ledger history |
| `delta` | Cursor-based | Real-time streaming |
| `summary` | None | Single-record metadata |

### 5.2 Cursor Format

Cursor for delta mode is base64-encoded JSON:

```json
// Decoded cursor
{
  "version": 42,
  "timestamp": "2026-02-16T10:25:00Z",
  "entryId": "ent_042"
}
```

### 5.3 Pagination Headers

```http
X-LAFS-Page-Mode: cursor
X-LAFS-Page-Next-Cursor: cursor_eyJ2ZXJzaW9uIjo0Mn0=
X-LAFS-Page-Has-More: false
```

---

## 6. Security Model

### 6.1 Authentication

**Required:** Bearer token in `Authorization` header

```http
Authorization: Bearer <jwt_token>
```

Token MUST include:
- `sub`: Agent/entity identifier
- `scope`: Context access permissions
- `exp`: Expiration time

### 6.2 Authorization Levels

| Level | Permissions | Use Case |
|-------|-------------|----------|
| `context:read` | Read any ledger | Monitoring/debugging |
| `context:read:{ledgerId}` | Read specific ledger | Workflow participants |
| `context:write` | Create/modify ledgers | Context managers |
| `context:admin` | Full access including delete | System operators |

### 6.3 Access Control Matrix

| Ledger State | Anonymous | Read Scope | Write Scope | Admin |
|--------------|-----------|------------|-------------|-------|
| Public | summary only | full/delta/summary | full+write | all |
| Protected | deny | delta/summary | full+write | all |
| Private | deny | deny | full+write | all |

### 6.4 Audit Logging

All context queries MUST be logged:

```json
{
  "timestamp": "2026-02-16T10:30:00Z",
  "agentId": "agent_001",
  "ledgerId": "ctx_abc123",
  "operation": "context.query",
  "mode": "delta",
  "sinceVersion": 40,
  "entriesReturned": 2,
  "clientIp": "10.0.0.1"
}
```

---

## 7. Integration with _meta.contextVersion

### 7.1 Context Version Synchronization

The `_meta.contextVersion` in LAFS envelopes MUST match the ledger's current version:

```
Step 1: Agent calls API -> Response includes _meta.contextVersion: 42
Step 2: Agent performs operation -> Updates ledger to version 43
Step 3: Agent queries delta -> Uses sinceVersion=42, receives version 43
```

### 7.2 Stale Context Detection

Agents SHOULD verify context version before operations:

```javascript
// Pseudo-code for stale context detection
if (currentVersion < expectedVersion) {
  // Fetch delta to catch up
  const delta = await queryContext({ mode: 'delta', sinceVersion: currentVersion });
  applyDelta(delta);
}
```

### 7.3 Optimistic Concurrency

For write operations, include `If-Match` header with expected version:

```http
POST /_lafs/context/ctx_abc123/entries
If-Match: "42"
```

Conflict response (version mismatch):

```json
{
  "success": false,
  "error": {
    "code": "E_CONTEXT_VERSION_CONFLICT",
    "message": "Context version mismatch: expected 42, found 43",
    "category": "CONFLICT",
    "retryable": true,
    "retryAfterMs": 100,
    "details": {
      "expectedVersion": 42,
      "actualVersion": 43
    }
  }
}
```

---

## 8. Performance Considerations

### 8.1 Efficiency Targets

| Metric | Target | Measurement |
|--------|--------|-------------|
| Summary mode latency | <50ms | p99 response time |
| Delta mode latency | <100ms | p99 for <10 entries |
| Full mode latency | <500ms | p99 for 100 entries |
| Context overhead | <10% | (context_time / total_time) |
| Payload size | <10KB | Typical delta response |

### 8.2 Caching Strategy

Implementations SHOULD support:

| Cache Level | Scope | TTL |
|-------------|-------|-----|
| CDN/Edge | Summary mode | 5 seconds |
| Application | Delta queries | 1 second |
| Database | Ledger metadata | 30 seconds |

### 8.3 Optimization Techniques

1. **Index on `(ledgerId, version)`** for O(1) delta queries
2. **Pre-computed checksums** stored per entry
3. **Lazy loading** for `contextDelta` fields
4. **Connection pooling** for high-throughput scenarios

### 8.4 Agent Workflow Optimization

For a 5-step workflow, recommended pattern:

```
Step 1: Query full context (once, ~100ms)
Steps 2-5: Query delta from last known version (~20ms each)
Total context overhead: 180ms / 5 steps = 36ms per step
Target workflow time: 500ms per step
Context overhead: 36/500 = 7.2% ✓
```

---

## 9. Error Scenarios

### 9.1 Error Codes

| Code | Category | Description | Retryable |
|------|----------|-------------|-----------|
| `E_CONTEXT_NOT_FOUND` | NOT_FOUND | Ledger does not exist | No |
| `E_CONTEXT_VERSION_INVALID` | VALIDATION | sinceVersion > current version | No |
| `E_CONTEXT_VERSION_CONFLICT` | CONFLICT | Optimistic lock failure | Yes (100ms) |
| `E_CONTEXT_UNAUTHORIZED` | PERMISSION | Insufficient permissions | No |
| `E_CONTEXT_EXPIRED` | AUTH | Ledger expired/archived | No |
| `E_CONTEXT_COMPACTED` | CONFLICT | Requested version compacted | Yes (with full query) |
| `E_CONTEXT_TOO_LARGE` | VALIDATION | Response exceeds size limit | Yes (reduce limit) |
| `E_CONTEXT_MODE_INVALID` | VALIDATION | Unknown mode parameter | No |
| `E_CONTEXT_FILTER_INVALID` | VALIDATION | Invalid filter expression | No |

### 9.2 Error Examples

**Ledger Not Found:**

```json
{
  "success": false,
  "error": {
    "code": "E_CONTEXT_NOT_FOUND",
    "message": "Context ledger 'ctx_invalid' not found",
    "category": "NOT_FOUND",
    "retryable": false,
    "retryAfterMs": null,
    "details": {
      "ledgerId": "ctx_invalid",
      "suggestion": "Check ledgerId or create new context"
    }
  }
}
```

**Version Compacted:**

```json
{
  "success": false,
  "error": {
    "code": "E_CONTEXT_COMPACTED",
    "message": "Requested version 1-10 have been compacted",
    "category": "CONFLICT",
    "retryable": true,
    "retryAfterMs": null,
    "details": {
      "compactedRange": { "from": 1, "to": 10 },
      "availableFrom": 11,
      "suggestion": "Query with mode=full or sinceVersion=10"
    }
  }
}
```

---

## 10. Request/Response Examples

### 10.1 Typical Multi-Step Workflow

**Step 1: Initialize and Load Full Context**

Request:
```http
GET /_lafs/context/workflow_abc?mode=full&limit=50
Authorization: Bearer token123
```

Response:
```json
{
  "_meta": { "contextVersion": 5, ... },
  "result": {
    "ledgerId": "workflow_abc",
    "version": 5,
    "entries": [...],
    ...
  }
}
```

**Step 2: Agent Work + Delta Query**

Request:
```http
GET /_lafs/context/workflow_abc?mode=delta&sinceVersion=5&filterByOperation=constraint.add
Authorization: Bearer token123
```

Response:
```json
{
  "_meta": { "contextVersion": 6, ... },
  "result": {
    "fromVersion": 5,
    "toVersion": 6,
    "entries": [{
      "operation": "constraint.add",
      "contextDelta": { "constraints": ["deadline: 2026-03-01"] }
    }]
  }
}
```

**Step 3: Verify with Summary Before Write**

Request:
```http
GET /_lafs/context/workflow_abc?mode=summary
Authorization: Bearer token123
```

Response:
```json
{
  "result": {
    "version": 6,
    "checksum": "sha256:xyz789...",
    "updatedAt": "2026-02-16T10:35:00Z"
  }
}
```

### 10.2 Error Recovery

Request:
```http
GET /_lafs/context/workflow_abc?mode=delta&sinceVersion=100
Authorization: Bearer token123
```

Response (version too old, compacted):
```json
{
  "success": false,
  "error": {
    "code": "E_CONTEXT_COMPACTED",
    "message": "Version 100 has been compacted. Earliest available: 95",
    "details": {
      "earliestVersion": 95,
      "currentVersion": 110
    }
  }
}
```

Recovery: Query from earliest available version
```http
GET /_lafs/context/workflow_abc?mode=delta&sinceVersion=95
```

---

## 11. OpenAPI Specification (YAML)

```yaml
openapi: 3.0.3
info:
  title: LAFS Context Ledger Query API
  version: 1.0.0
  description: Query context ledger state for multi-step agent workflows

paths:
  /_lafs/context/{ledgerId}:
    get:
      operationId: queryContext
      summary: Query context ledger state
      parameters:
        - name: ledgerId
          in: path
          required: true
          schema:
            type: string
        - name: mode
          in: query
          schema:
            type: string
            enum: [full, delta, summary]
            default: full
        - name: sinceVersion
          in: query
          schema:
            type: integer
            minimum: 0
        - name: filterByOperation
          in: query
          schema:
            type: array
            items:
              type: string
        - name: limit
          in: query
          schema:
            type: integer
            minimum: 1
            maximum: 1000
            default: 100
        - name: offset
          in: query
          schema:
            type: integer
            minimum: 0
            default: 0
        - name: cursor
          in: query
          schema:
            type: string
        - name: includeChecksum
          in: query
          schema:
            type: boolean
            default: true
      responses:
        '200':
          description: Context ledger state
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ContextQueryResponse'
        '400':
          description: Invalid parameters
        '401':
          description: Unauthorized
        '403':
          description: Forbidden
        '404':
          description: Ledger not found
        '409':
          description: Version conflict

components:
  schemas:
    ContextQueryResponse:
      allOf:
        - $ref: 'https://lafs.dev/schemas/v1/envelope.schema.json'
        - type: object
          properties:
            result:
              oneOf:
                - $ref: '#/components/schemas/FullContextResult'
                - $ref: '#/components/schemas/DeltaContextResult'
                - $ref: '#/components/schemas/SummaryContextResult'
    
    FullContextResult:
      type: object
      properties:
        mode:
          const: full
        ledgerId:
          type: string
        version:
          type: integer
        entries:
          type: array
          items:
            $ref: '#/components/schemas/LedgerEntry'
    
    DeltaContextResult:
      type: object
      properties:
        mode:
          const: delta
        fromVersion:
          type: integer
        toVersion:
          type: integer
        entries:
          type: array
          items:
            $ref: '#/components/schemas/LedgerEntry'
        deltaFormat:
          $ref: '#/components/schemas/DeltaFormat'
    
    SummaryContextResult:
      type: object
      properties:
        mode:
          const: summary
        version:
          type: integer
        checksum:
          type: string
        entryCount:
          type: integer
    
    LedgerEntry:
      type: object
      required: [entryId, timestamp, operation, contextDelta]
      properties:
        entryId:
          type: string
        version:
          type: integer
        timestamp:
          type: string
          format: date-time
        operation:
          type: string
        requestId:
          type: string
        contextDelta:
          type: object
    
    DeltaFormat:
      type: object
      properties:
        type:
          type: string
          enum: [append-only, json-patch, state-snapshot]
        metadata:
          type: object
```

---

## 12. Implementation Checklist

- [ ] Endpoint implementation with all three modes
- [ ] Delta query with sinceVersion support
- [ ] Operation filtering with wildcard support
- [ ] Pagination (offset for full, cursor for delta)
- [ ] Authentication/authorization middleware
- [ ] Audit logging for all queries
- [ ] Error handling for all defined error codes
- [ ] Caching layer for summary mode
- [ ] Database indexing on (ledgerId, version)
- [ ] Rate limiting per agent/ledger
- [ ] Compression support (gzip)
- [ ] Integration tests for 5-step workflow scenario
- [ ] Performance benchmarks (<10% overhead)

---

## 13. Appendix: Design Decisions

### A. Why Append-Only Delta?

Append-only was chosen over JSON Patch because:
1. **Deterministic replay**: Entries can be replayed in order
2. **Audit trail**: Complete history preserved
3. **Agent simplicity**: Linear processing model
4. **Conflict reduction**: No merge conflicts in append-only log

### B. Why Three Projection Modes?

Three modes balance flexibility with simplicity:
- `full`: Power users, debugging, initial load
- `delta`: Production workflows, minimal overhead
- `summary`: Health checks, version sync, ultra-low latency

### C. Why Cursor Pagination for Delta?

Cursors provide:
- **Consistency**: Results don't shift during pagination
- **Efficiency**: O(1) seek vs O(n) offset
- **Real-time**: Works with streaming updates

### D. Version vs Timestamp

Both version (integer) and timestamp are included:
- **Version**: Deterministic ordering, conflict detection
- **Timestamp**: Human debugging, audit trails

---

*Document Version: 1.0.0*
*Last Updated: 2026-02-16*
*Status: Design Complete*
