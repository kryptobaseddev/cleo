# Understanding LAFS Envelopes

**What you'll learn:** The structure of a LAFS envelope, its invariants, and how to use it effectively in your agent workflows.

## The envelope structure

Every LAFS response follows this canonical shape:

```json
{
  "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
  "_meta": {
    "specVersion": "1.0.0",
    "schemaVersion": "1.0.0",
    "timestamp": "2026-02-16T10:00:00Z",
    "operation": "users.list",
    "requestId": "req_123",
    "transport": "http",
    "strict": true,
    "mvi": "standard",
    "contextVersion": 0
  },
  "success": true,
  "result": {
    "users": [
      { "id": 1, "name": "Alice" },
      { "id": 2, "name": "Bob" }
    ]
  },
  "error": null,
  "page": {
    "mode": "cursor",
    "nextCursor": "eyJpZCI6IjIifQ==",
    "hasMore": true
  }
}
```

## Envelope fields explained

### `_meta` (required)

Metadata about the response:

| Field | Type | Description |
|-------|------|-------------|
| `specVersion` | string | LAFS spec version (SemVer) |
| `schemaVersion` | string | Schema version used |
| `timestamp` | string | ISO 8601 timestamp |
| `operation` | string | Operation identifier (e.g., `users.list`) |
| `requestId` | string | Unique request identifier |
| `transport` | string | Transport used (`http`, `grpc`, `cli`, etc.) |
| `strict` | boolean | Strict mode enabled |
| `mvi` | string | MVI disclosure level (`minimal`, `standard`, `full`, `custom`) |
| `contextVersion` | integer | Context ledger version |
| `sessionId` | string | Session identifier for multi-step workflows (optional) |
| `warnings` | array | Non-fatal warnings (deprecations, etc.) (optional) |

### `success` (required)

Boolean indicating success or failure. **Must** be consistent with `result` and `error`:

- `true` → `result` contains data, `error` is null
- `false` → `result` is null, `error` contains details

### `result` (conditional)

Your actual response data. Present when `success: true`.

```json
{
  "success": true,
  "result": {
    "user": {
      "id": 1,
      "name": "Alice",
      "email": "alice@example.com"
    }
  }
}
```

### `error` (conditional)

Error details when `success: false`. Uses registered error codes.

```json
{
  "success": false,
  "error": {
    "code": "E_NOT_FOUND_RESOURCE",
    "message": "User not found",
    "category": "NOT_FOUND",
    "retryable": false,
    "details": {
      "resourceType": "user",
      "resourceId": "999"
    }
  }
}
```

### `page` (optional)

Pagination metadata for list operations.

**Cursor mode:**
```json
{
  "page": {
    "mode": "cursor",
    "nextCursor": "eyJpZCI6IjEwIn0=",
    "hasMore": true
  }
}
```

**Offset mode:**
```json
{
  "page": {
    "mode": "offset",
    "offset": 20,
    "limit": 10,
    "total": 100,
    "hasMore": true
  }
}
```

## Envelope invariants

These rules **must** always hold:

1. `success=true` → `error` is null (or omitted)
2. `success=false` → `result` is null and `error` is present
3. In strict mode, unknown top-level fields are rejected
4. `page` and `error` can be omitted when null

## Working with envelopes

### Validating an envelope

```typescript
import { validateEnvelope } from '@cleocode/lafs';

const envelope = await fetch('/api/data').then(r => r.json());
const validation = validateEnvelope(envelope);

if (!validation.valid) {
  console.error('Validation errors:', validation.errors);
}
```

### Checking success/error

```typescript
function handleResponse(envelope: LafsEnvelope) {
  if (envelope.success) {
    // Work with envelope.result
    return processData(envelope.result);
  } else {
    // Handle envelope.error
    const error = envelope.error;
    if (error.retryable) {
      // Retry with exponential backoff
      return retryWithBackoff(error);
    }
    throw new Error(`${error.code}: ${error.message}`);
  }
}
```

### Handling pagination

```typescript
async function* paginatedList(endpoint: string) {
  let hasMore = true;
  let cursor: string | undefined;

  while (hasMore) {
    const url = cursor 
      ? `${endpoint}?cursor=${cursor}` 
      : endpoint;
    
    const envelope = await fetch(url).then(r => r.json());
    
    if (!envelope.success) {
      throw new Error(envelope.error.message);
    }

    yield envelope.result.items;

    if (envelope.page?.hasMore) {
      cursor = envelope.page.nextCursor;
      hasMore = true;
    } else {
      hasMore = false;
    }
  }
}

// Usage
for await (const items of paginatedList('/api/users')) {
  console.log('Got', items.length, 'items');
}
```

## Extensions

Add vendor-specific metadata using `_extensions`:

```json
{
  "_meta": { ... },
  "success": true,
  "result": { ... },
  "_extensions": {
    "x-myvendor-trace-id": "trace_abc123",
    "x-myvendor-region": "us-east-1"
  }
}
```

## Next steps

- **[Handle errors](error-handling.md)** — Deep dive into error codes and retry logic
- **[Manage token budgets](token-budgets.md)** — Prevent context window overflow
- **[Reference: Envelope Schema](../../schemas/v1/envelope.schema.json)** — Complete schema definition
