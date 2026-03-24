# Token Budget Management

**What you'll learn:** How to use LAFS token budget signaling to prevent context window overflow and optimize response sizes for LLM consumption.

## The problem

LLM agents have limited context windows. A response that's too large:
- Exceeds token limits, causing failures
- Wastes tokens on unnecessary data
- Slows down agent processing

## The LAFS solution

LAFS provides **token budget signaling** — a way for clients to declare constraints and for servers to respect them.

## Declaring budgets

Add a `_budget` parameter to your requests:

```json
{
  "_budget": {
    "maxTokens": 4000,
    "maxBytes": 32768,
    "maxItems": 100
  }
}
```

### Budget fields

| Field | Description | Use When |
|-------|-------------|----------|
| `maxTokens` | Maximum approximate tokens | Working with LLMs |
| `maxBytes` | Maximum response size | Network constraints |
| `maxItems` | Maximum list items | Pagination control |

## Server behavior

When a server receives a `_budget` parameter, it **must**:

1. Parse the budget constraints
2. Estimate response size
3. Return response within budget **or** fail with `E_MVI_BUDGET_EXCEEDED`

### Successful constrained response

```json
{
  "_meta": {
    "specVersion": "1.0.0",
    "operation": "users.list",
    "requestId": "req_123",
    "warnings": [{
      "code": "E_MVI_BUDGET_TRUNCATED",
      "message": "Response truncated to fit token budget"
    }],
    "_tokenEstimate": {
      "estimated": 2847,
      "budget": 4000,
      "method": "character_based"
    }
  },
  "success": true,
  "result": {
    "users": [
      { "id": 1, "name": "Alice" },
      { "id": 2, "name": "Bob" }
      // Note: bio fields omitted to fit budget
    ]
  },
  "page": {
    "mode": "cursor",
    "nextCursor": "eyJpZCI6IjMifQ==",
    "hasMore": true
  }
}
```

### Budget exceeded error

```json
{
  "_meta": {
    "specVersion": "1.0.0",
    "operation": "users.list",
    "requestId": "req_123"
  },
  "success": false,
  "error": {
    "code": "E_MVI_BUDGET_EXCEEDED",
    "message": "Response exceeds declared token budget",
    "category": "VALIDATION",
    "retryable": true,
    "details": {
      "estimatedTokens": 5234,
      "budget": 4000,
      "excessTokens": 1234,
      "constraint": "maxTokens"
    }
  }
}
```

## Client implementation

### TypeScript example

```typescript
import { LafsClient } from '@cleocode/lafs';

const client = new LafsClient({
  baseUrl: 'https://api.example.com',
  defaultBudget: {
    maxTokens: 4000,
    maxItems: 50
  }
});

async function getUsers() {
  try {
    const response = await client.request('users.list', {
      _budget: { maxTokens: 4000 }
    });
    
    return response.result;
  } catch (error) {
    if (error.code === 'E_MVI_BUDGET_EXCEEDED') {
      // Reduce budget and retry
      const adjustedBudget = {
        maxTokens: error.details.budget * 0.8
      };
      
      return client.request('users.list', {
        _fields: ['id', 'name'], // Request fewer fields
        _budget: adjustedBudget
      });
    }
    throw error;
  }
}
```

### Combining with field selection

Use `_fields` to request only what you need:

```json
{
  "_fields": ["id", "name", "email"],
  "_budget": {
    "maxTokens": 2000
  }
}
```

## Token estimation

Servers use this algorithm to estimate tokens:

```
Function estimate_tokens(value, depth = 0):
    IF depth > 20: RETURN INFINITY
    IF value IS null: RETURN 1
    IF value IS boolean: RETURN 1
    IF value IS number: RETURN max(1, len(stringify(value)) / 4)
    IF value IS string:
        graphemes = count_grapheme_clusters(value)
        RETURN max(1, graphemes / 4.0)
    IF value IS array:
        tokens = 2  // []
        FOR item IN value:
            tokens += estimate_tokens(item, depth + 1) + 1
        RETURN tokens
    IF value IS object:
        tokens = 2  // {}
        FOR key, val IN value:
            tokens += estimate_tokens(key, depth + 1)
            tokens += 2  // : and ,
            tokens += estimate_tokens(val, depth + 1)
        RETURN tokens
```

## Best practices

1. **Always declare budgets** for LLM-driven workflows
2. **Use `_fields`** to request only necessary data
3. **Handle `E_MVI_BUDGET_EXCEEDED`** with graceful degradation
4. **Respect warnings** about truncation
5. **Monitor token estimates** in `_meta._tokenEstimate`

## Budget guidelines by use case

| Use Case | Recommended Budget | Notes |
|----------|-------------------|-------|
| Quick lookups | 500 tokens | IDs, names only |
| Standard queries | 2000 tokens | Common fields |
| Detailed analysis | 4000 tokens | Full records |
| Bulk operations | 8000 tokens | Use pagination |

## Next steps

- **[Envelope basics](envelope-basics.md)** — Review envelope structure
- **[Error handling](error-handling.md)** — Handle budget exceeded errors
- **[Specification](../specification.md)** — Deep dive into token budget signaling
