# LAFS Context Projection Modes Specification

## Section 8.2: Context Projection Modes (Normative)

### 8.2.1 Overview

LAFS defines three context projection modes for efficient context ledger retrieval:

- **Full**: Complete ledger state with all entries
- **Delta**: Incremental changes since a specified version  
- **Summary**: Minimal metadata for state verification

Implementations MUST support all three projection modes. The `mode` query parameter MUST be one of: `full`, `delta`, or `summary`. If `mode` is omitted, implementations MUST default to `full`.

---

### 8.2.2 Query Parameters

The context query endpoint accepts the following parameters:

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `mode` | enum | No | `full` | Projection mode: `full`, `delta`, or `summary` |
| `sinceVersion` | integer | Conditional | — | Starting version for delta mode (REQUIRED when `mode=delta`) |
| `filterByOperation` | string[] | No | — | Filter entries by operation name(s) |
| `limit` | integer (1-1000) | No | 100 | Maximum entries per response |
| `offset` | integer | No | 0 | Offset for offset-based pagination (full mode only) |
| `cursor` | string | No | — | Cursor for cursor-based pagination (delta mode only) |
| `includeChecksum` | boolean | No | `true` | Include integrity checksum in response |

**Parameter Rules:**

- When `mode=delta`, the `sinceVersion` parameter MUST be present and MUST be a non-negative integer.
- When `mode=summary`, pagination parameters (`offset`, `cursor`) MUST be ignored.
- When `mode=full`, the `cursor` parameter MUST be ignored.
- The `filterByOperation` parameter, when present, MUST support:
  - Multiple operation names (OR logic: match any)
  - Wildcard patterns (e.g., `task.*` matches all operations starting with `task.`)
  - Negation prefixes (e.g., `!system.*` excludes system operations)

---

### 8.2.3 Full Projection Mode

#### 8.2.3.1 Purpose

Full mode returns the complete ledger state including all entries. This mode MUST be used for:

- Initial context loads
- Recovery scenarios
- Debugging and audit trails
- When the agent has no cached context state

#### 8.2.3.2 Response Structure

The response body MUST conform to the following structure:

```json
{
  "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
  "_meta": {
    "specVersion": "1.0.0",
    "schemaVersion": "1.0.0",
    "timestamp": "2026-02-16T10:30:00Z",
    "operation": "context.query",
    "requestId": "{request-id}",
    "transport": "http",
    "strict": true,
    "mvi": "standard",
    "contextVersion": 42
  },
  "success": true,
  "result": {
    "ledgerId": "{ledger-id}",
    "mode": "full",
    "version": 42,
    "createdAt": "2026-02-16T09:00:00Z",
    "updatedAt": "2026-02-16T10:25:00Z",
    "checksum": "sha256:{checksum-value}",
    "entryCount": 42,
    "entries": [
      {
        "entryId": "{entry-id}",
        "version": 1,
        "timestamp": "2026-02-16T09:05:00Z",
        "operation": "task.initialize",
        "requestId": "{request-id}",
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

**Required Fields:**

- `result.ledgerId`: The ledger identifier
- `result.mode`: MUST be `"full"`
- `result.version`: Current ledger version (monotonically increasing integer)
- `result.checksum`: Integrity checksum of the complete ledger
- `result.entryCount`: Total number of entries in the ledger
- `result.entries`: Array of ledger entry objects (MAY be paginated)
- `result.createdAt`: ISO 8601 timestamp of ledger creation
- `result.updatedAt`: ISO 8601 timestamp of last update

**Pagination:**

Full mode MUST use offset-based pagination. The `page` object MUST include:
- `mode`: MUST be `"offset"`
- `offset`: Current offset value
- `hasMore`: Boolean indicating if more entries exist
- `total`: Total entry count

#### 8.2.3.3 Example Request/Response

**Request:**
```http
GET /_lafs/context/workflow_abc?mode=full&limit=50 HTTP/1.1
Authorization: Bearer {token}
Accept: application/json
```

**Response:**
```json
{
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
    "ledgerId": "workflow_abc",
    "mode": "full",
    "version": 42,
    "createdAt": "2026-02-16T09:00:00Z",
    "updatedAt": "2026-02-16T10:25:00Z",
    "checksum": "sha256:a1b2c3d4...",
    "entryCount": 42,
    "entries": [
      {
        "entryId": "ent_001",
        "version": 1,
        "timestamp": "2026-02-16T09:05:00Z",
        "operation": "task.initialize",
        "requestId": "req_001",
        "contextDelta": { "objective": "Analyze Q1 metrics" }
      },
      {
        "entryId": "ent_002",
        "version": 2,
        "timestamp": "2026-02-16T09:10:00Z",
        "operation": "constraint.add",
        "requestId": "req_002",
        "contextDelta": { "constraints": ["budget < $50K"] }
      }
    ]
  },
  "page": {
    "mode": "offset",
    "limit": 50,
    "offset": 0,
    "hasMore": false,
    "total": 42
  }
}
```

---

### 8.2.4 Delta Projection Mode

#### 8.2.4.1 Purpose

Delta mode returns only the changes since a specified version. This mode MUST be used for:

- Multi-step workflow continuation
- Polling for updates
- Minimizing bandwidth
- Real-time synchronization

#### 8.2.4.2 Delta Format Specification

The LAFS context ledger uses an **append-only delta format**. Entries MUST be returned in version order.

**Delta Response Structure:**

```json
{
  "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
  "_meta": {
    "specVersion": "1.0.0",
    "schemaVersion": "1.0.0",
    "timestamp": "2026-02-16T10:30:00Z",
    "operation": "context.query",
    "requestId": "{request-id}",
    "transport": "http",
    "strict": true,
    "mvi": "minimal",
    "contextVersion": 42
  },
  "success": true,
  "result": {
    "ledgerId": "{ledger-id}",
    "mode": "delta",
    "fromVersion": 40,
    "toVersion": 42,
    "checksum": "sha256:{checksum-value}",
    "entryCount": 2,
    "entries": [
      {
        "entryId": "{entry-id}",
        "version": 41,
        "timestamp": "2026-02-16T10:20:00Z",
        "operation": "constraint.add",
        "requestId": "{request-id}",
        "contextDelta": { "constraints": ["deadline: 2026-03-01"] }
      }
    ],
    "deltaFormat": {
      "type": "append-only",
      "baseVersion": 40,
      "targetVersion": 42,
      "patch": null,
      "merges": null
    }
  },
  "page": {
    "mode": "cursor",
    "limit": 100,
    "nextCursor": "{base64-encoded-cursor}",
    "hasMore": false,
    "total": 2
  }
}
```

**Required Fields:**

- `result.mode`: MUST be `"delta"`
- `result.fromVersion`: The `sinceVersion` from the request
- `result.toVersion`: The current ledger version
- `result.entries`: Array of entries where `entry.version > sinceVersion`
- `result.deltaFormat.type`: MUST be `"append-only"`
- `result.deltaFormat.baseVersion`: The base version (same as `fromVersion`)
- `result.deltaFormat.targetVersion`: The target version (same as `toVersion`)

**Delta Format Types:**

| Type | Description | Use Case |
|------|-------------|----------|
| `append-only` | Returns new entries since base version | Standard operations |
| `json-patch` | RFC 6902 JSON Patch document | Complex mutations (optional) |
| `state-snapshot` | Complete state diff | Recovery scenarios (optional) |

Implementations MUST support `append-only`. Support for `json-patch` and `state-snapshot` is OPTIONAL.

**ContextDelta Operations:**

Each entry's `contextDelta` object MUST support these operations:

| Operation | Description | Example |
|-----------|-------------|---------|
| `set` | Replace entire value | `{"objective": "New objective"}` |
| `append` | Add to array | `{"constraints": [{"action": "append", "value": "..."}]}` |
| `remove` | Remove from array | `{"constraints": [{"action": "remove", "id": "..."}]}` |
| `update` | Update nested field | `{"state.phase": "in_progress"}` |

**Pagination:**

Delta mode MUST use cursor-based pagination. The `page` object MUST include:
- `mode`: MUST be `"cursor"`
- `nextCursor`: Base64-encoded cursor for next page (absent if `hasMore=false`)
- `hasMore`: Boolean indicating if more entries exist

The cursor MUST be a base64-encoded JSON object containing:
```json
{
  "version": 42,
  "timestamp": "2026-02-16T10:25:00Z",
  "entryId": "ent_042"
}
```

#### 8.2.4.3 Example Request/Response

**Request:**
```http
GET /_lafs/context/workflow_abc?mode=delta&sinceVersion=40&filterByOperation=constraint.add,decision.record HTTP/1.1
Authorization: Bearer {token}
Accept: application/json
```

**Response:**
```json
{
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
    "ledgerId": "workflow_abc",
    "mode": "delta",
    "fromVersion": 40,
    "toVersion": 42,
    "checksum": "sha256:a1b2c3d4...",
    "entryCount": 2,
    "entries": [
      {
        "entryId": "ent_041",
        "version": 41,
        "timestamp": "2026-02-16T10:20:00Z",
        "operation": "constraint.add",
        "requestId": "req_041",
        "contextDelta": { 
          "constraints": [{"action": "append", "value": "budget < $10K"}]
        }
      },
      {
        "entryId": "ent_042",
        "version": 42,
        "timestamp": "2026-02-16T10:25:00Z",
        "operation": "decision.record",
        "requestId": "req_042",
        "contextDelta": { 
          "decisions": [{"action": "append", "value": "Use AWS over GCP"}]
        }
      }
    ],
    "deltaFormat": {
      "type": "append-only",
      "baseVersion": 40,
      "targetVersion": 42,
      "patch": null,
      "merges": null
    }
  },
  "page": {
    "mode": "cursor",
    "limit": 100,
    "hasMore": false,
    "total": 2
  }
}
```

---

### 8.2.5 Summary Projection Mode

#### 8.2.5.1 Purpose

Summary mode returns minimal metadata for state verification. This mode MUST be used for:

- Version verification before delta queries
- Health checks
- Conflict detection (comparing checksums)
- Quick state validation

#### 8.2.5.2 Response Structure

```json
{
  "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
  "_meta": {
    "specVersion": "1.0.0",
    "schemaVersion": "1.0.0",
    "timestamp": "2026-02-16T10:30:00Z",
    "operation": "context.query",
    "requestId": "{request-id}",
    "transport": "http",
    "strict": true,
    "mvi": "minimal",
    "contextVersion": 42
  },
  "success": true,
  "result": {
    "ledgerId": "{ledger-id}",
    "mode": "summary",
    "version": 42,
    "checksum": "sha256:{checksum-value}",
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

**Required Fields:**

- `result.mode`: MUST be `"summary"`
- `result.version`: Current ledger version
- `result.checksum`: Integrity checksum
- `result.entryCount`: Total number of entries
- `result.updatedAt`: Last update timestamp

**Optional Fields:**

- `result.isCompacted`: Whether older entries have been compacted
- `result.compactedAt`: Timestamp of last compaction (if any)
- `result.createdAt`: Ledger creation timestamp

**Pagination:**

Summary mode MUST NOT use pagination. The `page.mode` MUST be `"none"`.

#### 8.2.5.3 Example Request/Response

**Request:**
```http
GET /_lafs/context/workflow_abc?mode=summary HTTP/1.1
Authorization: Bearer {token}
Accept: application/json
```

**Response:**
```json
{
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
    "ledgerId": "workflow_abc",
    "mode": "summary",
    "version": 42,
    "checksum": "sha256:a1b2c3d4...",
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

### 8.2.6 Agent Usage Guidance

#### 8.2.6.1 Mode Selection

Agents MUST select projection modes based on workflow state:

| Scenario | Recommended Mode | Rationale |
|----------|------------------|-----------|
| Initial workflow load | `full` | No cached state; need complete context |
| Step N+1 continuation | `delta` | Have cached state; need only changes |
| Pre-write validation | `summary` | Quick version/checksum verification |
| Recovery after error | `full` | Ensure complete state reconstruction |
| Health monitoring | `summary` | Minimal overhead for status checks |

#### 8.2.6.2 Caching Strategy

Agents SHOULD implement the following caching pattern:

1. **On initial load:** Query with `mode=full`, cache `version` and `checksum`
2. **On subsequent operations:** Query with `mode=delta&sinceVersion={cached_version}`
3. **Before mutations:** Query with `mode=summary` to verify cache validity
4. **On checksum mismatch:** Query with `mode=full` to resync

#### 8.2.6.3 Multi-Step Workflow Example

```
Step 1: Query full context (cache version=5)
Step 2: Do work → Query delta sinceVersion=5 (receive version=6)
Step 3: Do work → Query delta sinceVersion=6 (receive version=7)
Step 4: Do work → Query delta sinceVersion=7 (receive version=8)
Step 5: Do work → Query delta sinceVersion=8 (receive version=9)
```

---

### 8.2.7 Performance Characteristics

#### 8.2.7.1 Efficiency Targets

Implementations SHOULD meet the following performance targets:

| Mode | Target Latency (p99) | Target Payload | Use Case Frequency |
|------|---------------------|----------------|-------------------|
| `summary` | <50ms | <1KB | High (health checks) |
| `delta` | <100ms | <10KB | Very High (normal ops) |
| `full` | <500ms | <100KB | Low (initial/recovery) |

#### 8.2.7.2 Context Overhead

Total context retrieval overhead SHOULD be less than 10% of workflow execution time:

```
Context Overhead = (Context Retrieval Time) / (Total Workflow Time)
```

For a 5-step workflow taking 2500ms total, context retrieval SHOULD take less than 250ms.

#### 8.2.7.3 Optimization Recommendations

Implementations SHOULD:

1. **Index on `(ledgerId, version)`** for O(1) delta queries
2. **Pre-compute checksums** per entry for efficient verification
3. **Support compression** (gzip) via `Accept-Encoding: gzip`
4. **Cache summary responses** at CDN/edge for 5-second TTL
5. **Use connection pooling** for high-throughput scenarios

---

### 8.2.8 Error Scenarios

#### 8.2.8.1 Error Codes

The following error codes MUST be used for context query failures:

| Code | Category | Description | Retryable |
|------|----------|-------------|-----------|
| `E_CONTEXT_NOT_FOUND` | NOT_FOUND | Ledger does not exist | No |
| `E_CONTEXT_VERSION_INVALID` | VALIDATION | `sinceVersion` > current version | No |
| `E_CONTEXT_VERSION_CONFLICT` | CONFLICT | Optimistic lock failure | Yes (100ms) |
| `E_CONTEXT_UNAUTHORIZED` | PERMISSION | Insufficient permissions | No |
| `E_CONTEXT_EXPIRED` | AUTH | Ledger expired/archived | No |
| `E_CONTEXT_COMPACTED` | CONFLICT | Requested version compacted | Yes (with full query) |
| `E_CONTEXT_TOO_LARGE` | VALIDATION | Response exceeds size limit | Yes (reduce limit) |
| `E_CONTEXT_MODE_INVALID` | VALIDATION | Unknown mode parameter | No |
| `E_CONTEXT_FILTER_INVALID` | VALIDATION | Invalid filter expression | No |

#### 8.2.8.2 Error Response Examples

**Ledger Not Found:**
```json
{
  "success": false,
  "error": {
    "code": "E_CONTEXT_NOT_FOUND",
    "message": "Context ledger 'ctx_invalid' not found",
    "category": "NOT_FOUND",
    "retryable": false,
    "details": { "ledgerId": "ctx_invalid" }
  }
}
```

**Version Compacted:**
```json
{
  "success": false,
  "error": {
    "code": "E_CONTEXT_COMPACTED",
    "message": "Requested versions 1-10 have been compacted",
    "category": "CONFLICT",
    "retryable": true,
    "details": {
      "compactedRange": { "from": 1, "to": 10 },
      "availableFrom": 11,
      "suggestion": "Query with mode=full or sinceVersion=10"
    }
  }
}
```

**Invalid Version (Future):**
```json
{
  "success": false,
  "error": {
    "code": "E_CONTEXT_VERSION_INVALID",
    "message": "sinceVersion (100) exceeds current version (42)",
    "category": "VALIDATION",
    "retryable": false,
    "details": { "sinceVersion": 100, "currentVersion": 42 }
  }
}
```

---

### 8.2.9 Integration with _meta.contextVersion

The `_meta.contextVersion` field in LAFS envelopes MUST match the ledger's current version at the time of response generation.

**Synchronization Flow:**

1. Agent queries context → Receives `_meta.contextVersion: 42`
2. Agent performs operation → Updates ledger to version 43
3. Agent queries delta with `sinceVersion=42` → Receives entries for version 43

**Stale Context Detection:**

Agents SHOULD detect stale context using:

```javascript
if (cachedVersion < response._meta.contextVersion) {
  // Fetch delta to catch up
  const delta = await queryContext({ 
    mode: 'delta', 
    sinceVersion: cachedVersion 
  });
  applyDelta(delta);
}
```

---

### 8.2.10 Conformance

Implementations claiming support for context projection modes MUST:

1. Support all three projection modes (`full`, `delta`, `summary`)
2. Validate `sinceVersion` parameter when `mode=delta`
3. Return appropriate error codes for all defined error scenarios
4. Include checksums when `includeChecksum=true`
5. Support pagination as specified for each mode
6. Return `_meta.contextVersion` matching the ledger version

---

*Specification Version: 1.0.0*
*Last Updated: 2026-02-16*
*Status: Normative*
