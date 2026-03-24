# Error Handling with LAFS

**What you'll learn:** How to work with LAFS error codes, implement retry logic, and provide actionable error information to your agents.

## The LAFS error model

LAFS errors follow a standardized structure:

```json
{
  "code": "E_NOT_FOUND_RESOURCE",
  "message": "User with ID 999 not found",
  "category": "NOT_FOUND",
  "retryable": false,
  "retryAfterMs": null,
  "details": {
    "resourceType": "user",
    "resourceId": "999"
  }
}
```

## Error code structure

All LAFS error codes follow this pattern:

```
E_<DOMAIN>_<SPECIFIC>
```

Examples:
- `E_VALIDATION_SCHEMA` — Schema validation failed
- `E_NOT_FOUND_RESOURCE` — Resource not found
- `E_RATE_LIMIT_EXCEEDED` — Rate limit hit
- `E_CONTEXT_MISSING` — Required context missing

## Registered error categories

| Category | Description | Example Codes |
|----------|-------------|---------------|
| `VALIDATION` | Input validation errors | `E_VALIDATION_SCHEMA`, `E_VALIDATION_REQUIRED` |
| `NOT_FOUND` | Resource not found | `E_NOT_FOUND_RESOURCE`, `E_NOT_FOUND_ENDPOINT` |
| `AUTH` | Authentication errors | `E_AUTH_TOKEN_EXPIRED`, `E_AUTH_INVALID` |
| `PERMISSION` | Authorization errors | `E_PERMISSION_DENIED` |
| `RATE_LIMIT` | Rate limiting | `E_RATE_LIMIT_EXCEEDED` |
| `CONFLICT` | Resource conflicts | `E_CONFLICT_VERSION` |
| `TRANSIENT` | Temporary failures | `E_TRANSIENT_TIMEOUT`, `E_TRANSIENT_UNAVAILABLE` |
| `INTERNAL` | Server errors | `E_INTERNAL_ERROR` |
| `CONTRACT` | Protocol violations | `E_CONTEXT_MISSING` |
| `MIGRATION` | Version mismatches | `E_MIGRATION_UNSUPPORTED_VERSION` |

## Retry semantics

The `retryable` field tells you if an error might succeed on retry:

```typescript
interface LafsError {
  code: string;
  message: string;
  category: string;
  retryable: boolean;
  retryAfterMs: number | null;  // Hint for when to retry
  details: Record<string, unknown>;
}
```

### Retry logic implementation

```typescript
import { LafsError } from '@cleocode/lafs';

async function callWithRetry<T>(
  operation: () => Promise<T>,
  maxRetries = 3
): Promise<T> {
  let lastError: LafsError | null = null;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!isLafsError(error) || !error.retryable) {
        throw error; // Not retryable
      }
      
      lastError = error;
      
      if (attempt < maxRetries) {
        // Calculate delay
        const delayMs = error.retryAfterMs 
          ?? Math.min(1000 * Math.pow(2, attempt), 30000);
        
        console.log(`Retry ${attempt + 1}/${maxRetries} after ${delayMs}ms`);
        await sleep(delayMs);
      }
    }
  }
  
  throw new Error(`Max retries exceeded: ${lastError?.message}`);
}
```

## Handling specific error types

### Validation errors

```typescript
function handleValidationError(error: LafsError) {
  if (error.code === 'E_VALIDATION_SCHEMA') {
    // Show field-level errors
    const fieldErrors = error.details.fieldErrors;
    return {
      type: 'validation',
      message: 'Please fix the following errors:',
      fields: fieldErrors
    };
  }
}
```

### Rate limiting

```typescript
async function handleRateLimit(error: LafsError) {
  if (error.category === 'RATE_LIMIT') {
    const retryAfter = error.retryAfterMs || 60000;
    
    // Inform user
    console.log(`Rate limited. Retrying in ${retryAfter}ms...`);
    
    // Wait and retry
    await sleep(retryAfter);
    return true; // Signal to retry
  }
  return false;
}
```

### Not found errors

```typescript
function handleNotFound(error: LafsError) {
  if (error.category === 'NOT_FOUND') {
    // No point retrying - resource doesn't exist
    return {
      type: 'not_found',
      message: error.message,
      suggestions: [
        'Check the resource ID is correct',
        'Verify the resource hasn\'t been deleted'
      ]
    };
  }
}
```

## Error code reference

See the complete error registry at [`schemas/v1/error-registry.json`](../../schemas/v1/error-registry.json).

### Common errors you'll encounter

| Code | When It Happens | What To Do |
|------|-----------------|------------|
| `E_VALIDATION_SCHEMA` | Request doesn't match schema | Fix request structure |
| `E_NOT_FOUND_RESOURCE` | Resource doesn't exist | Verify resource ID |
| `E_RATE_LIMIT_EXCEEDED` | Too many requests | Implement backoff |
| `E_CONTEXT_MISSING` | Multi-step context lost | Restart workflow |
| `E_FORMAT_CONFLICT` | Conflicting format flags | Check CLI flags |
| `E_MVI_BUDGET_EXCEEDED` | Response too large | Request fewer fields |

## Best practices

1. **Always check `retryable`** before retrying
2. **Respect `retryAfterMs`** when provided
3. **Use exponential backoff** for transient errors
4. **Log error details** for debugging
5. **Provide actionable messages** in user-facing errors

## Next steps

- **[Token budgets](token-budgets.md)** — Prevent context overflow with budget signaling
- **[Integration guides](../integrations/)** — See errors in context
- **[Envelope basics](envelope-basics.md)** — Review envelope structure
