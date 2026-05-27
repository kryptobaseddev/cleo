# LAFS Token Budget Signaling Specification

## Section 9.4: Token Budget Signaling

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in [RFC 2119](https://tools.ietf.org/html/rfc2119).

---

### 9.4.1 Overview

Token budget signaling enables clients to declare resource constraints that servers MUST respect when generating responses. This mechanism prevents context window overflow in LLM-driven workflows and allows clients to negotiate response sizes appropriate to their consumption capabilities.

A token budget specifies the maximum resources a client is willing to accept in a response. Servers MUST either produce a response within the declared budget or fail with a structured error indicating the constraint violation.

---

### 9.4.2 Request Budget Declaration (`_budget`)

Clients MAY declare resource constraints via the `_budget` request parameter.

#### 9.4.2.1 Budget Object Structure

The `_budget` parameter MUST be an object containing one or more of the following fields:

| Field | Type | Description |
|-------|------|-------------|
| `maxTokens` | integer | Maximum approximate tokens the response should consume |
| `maxBytes` | integer | Maximum byte size of the serialized response |
| `maxItems` | integer | Maximum number of items in list/array responses |

**Constraints:**
- At least one field MUST be present
- All values MUST be positive integers (>= 1)
- `maxTokens` and `maxBytes` SHOULD NOT both exceed 10,000,000 (10MB equivalent)
- Servers MAY reject budgets exceeding implementation limits with `E_VALIDATION_SCHEMA`

#### 9.4.2.2 Example Budget Declaration

```json
{
  "_budget": {
    "maxTokens": 4000,
    "maxBytes": 32768,
    "maxItems": 100
  }
}
```

#### 9.4.2.3 Budget Precedence

When multiple budget constraints are present, servers MUST respect the most restrictive applicable limit:

1. If `maxItems` is specified for list operations, the server MUST NOT return more items than declared
2. If `maxTokens` is specified, the server MUST estimate response tokens and enforce the limit
3. If `maxBytes` is specified, the server MUST measure serialized response size and enforce the limit
4. A response violates the budget if ANY declared constraint is exceeded

---

### 9.4.3 Server Behavior

#### 9.4.3.1 Budget Evaluation

Servers that support budget signaling MUST:

1. Parse the `_budget` parameter from incoming requests
2. Estimate or measure response size before transmission
3. Compare against declared constraints
4. Take one of the following actions:
   - Return the full response if within budget
   - Truncate the response to fit within budget (if truncation is supported)
   - Return `E_MVI_BUDGET_EXCEEDED` error if budget cannot be met

#### 9.4.3.2 Token Estimation Requirement

When `maxTokens` is specified, servers MUST estimate response token count using the algorithm specified in Section 9.4.6 (Normative Token Estimation Algorithm).

Servers MAY use alternative estimation methods provided they:
- Produce estimates within +/- 10% of the normative algorithm
- Never underestimate by more than 10% (conservative bias acceptable)
- Document their estimation method in implementation notes

#### 9.4.3.3 Truncation Strategies

Servers MAY truncate responses to fit within budget using one of these strategies:

**Depth-First Truncation:**
- Remove deepest nested fields first
- Preserve top-level structure
- Best for: Tree-structured data, deeply nested objects

**Field Priority Truncation:**
- Remove fields based on priority list (non-essential fields first)
- Preserve essential fields: `id`, `name`, `success`, `code`, `message`
- Best for: API responses with known schemas

**Hybrid Truncation:**
- Apply field priority first, then depth-first for remaining content
- Best for: General-purpose implementations

When truncation occurs, servers MUST include a warning in `_meta.warnings`:

```json
{
  "code": "E_MVI_BUDGET_TRUNCATED",
  "message": "Response truncated to fit token budget",
  "details": {
    "requestedBudget": 4000,
    "estimatedTokens": 5234,
    "truncationStrategy": "hybrid"
  }
}
```

#### 9.4.3.4 Response Metadata

Servers SHOULD include token estimation metadata in responses:

```json
{
  "_meta": {
    "_tokenEstimate": {
      "estimated": 2847,
      "budget": 4000,
      "method": "character_based"
    }
  }
}
```

The `_tokenEstimate` object SHOULD contain:
- `estimated`: Integer token estimate
- `budget`: Integer budget that was requested (if any)
- `method`: String indicating estimation method (e.g., "character_based", "exact")

---

### 9.4.4 Error Specification

#### 9.4.4.1 E_MVI_BUDGET_EXCEEDED

When a response cannot be produced within the declared budget, servers MUST return error code `E_MVI_BUDGET_EXCEEDED`.

**Error Code:** `E_MVI_BUDGET_EXCEEDED`  
**Category:** `VALIDATION`  
**Retryable:** `true` (client may retry with larger budget or different parameters)  
**HTTP Status:** `413 Payload Too Large`  
**gRPC Status:** `RESOURCE_EXHAUSTED`

#### 9.4.4.2 Error Response Format

```json
{
  "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
  "_meta": {
    "specVersion": "1.0.0",
    "schemaVersion": "1.0.0",
    "timestamp": "2026-02-16T00:00:00Z",
    "operation": "data.query",
    "requestId": "req_abc123",
    "transport": "http",
    "strict": true,
    "mvi": "minimal",
    "contextVersion": 0
  },
  "success": false,
  "result": null,
  "error": {
    "code": "E_MVI_BUDGET_EXCEEDED",
    "message": "Response exceeds declared token budget of 4000 tokens",
    "category": "VALIDATION",
    "retryable": true,
    "retryAfterMs": null,
    "details": {
      "estimatedTokens": 5234,
      "budget": 4000,
      "excessTokens": 1234,
      "constraint": "maxTokens",
      "suggestion": "Increase maxTokens to at least 5300 or use pagination"
    }
  }
}
```

#### 9.4.4.3 Error Details

The `details` object MUST include:
- `estimatedTokens`: Integer estimate of actual response size
- `budget`: Integer budget that was exceeded
- `excessTokens`: Integer difference (estimated - budget)
- `constraint`: String identifying which constraint was violated ("maxTokens", "maxBytes", "maxItems")

The `details` object SHOULD include:
- `suggestion`: Human-readable guidance for resolving the issue

#### 9.4.4.4 Retry Semantics

The `retryable` flag MUST be `true` for budget exceeded errors, indicating that:
- The request was understood and processed
- The failure is due to client-declared constraints, not server error
- Clients MAY retry with modified budget parameters
- Servers MUST NOT suggest `retryAfterMs` (no delay needed)

---

### 9.4.5 Request/Response Examples

#### Example 1: Successful Budget Compliance

**Request:**
```json
{
  "operation": "users.list",
  "_budget": {
    "maxTokens": 2000,
    "maxItems": 50
  }
}
```

**Response:**
```json
{
  "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
  "_meta": {
    "specVersion": "1.0.0",
    "schemaVersion": "1.0.0",
    "timestamp": "2026-02-16T10:30:00Z",
    "operation": "users.list",
    "requestId": "req_001",
    "transport": "http",
    "strict": true,
    "mvi": "standard",
    "contextVersion": 0,
    "_tokenEstimate": {
      "estimated": 1847,
      "budget": 2000,
      "method": "character_based"
    }
  },
  "success": true,
  "result": {
    "users": [
      {"id": "u1", "name": "Alice", "email": "alice@example.com"},
      {"id": "u2", "name": "Bob", "email": "bob@example.com"}
    ],
    "total": 2
  },
  "page": {
    "mode": "offset",
    "limit": 50,
    "offset": 0,
    "hasMore": false
  }
}
```

#### Example 2: Budget Exceeded Error

**Request:**
```json
{
  "operation": "reports.generate",
  "reportType": "analytics",
  "_budget": {
    "maxTokens": 1000
  }
}
```

**Response:**
```json
{
  "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
  "_meta": {
    "specVersion": "1.0.0",
    "schemaVersion": "1.0.0",
    "timestamp": "2026-02-16T10:31:00Z",
    "operation": "reports.generate",
    "requestId": "req_002",
    "transport": "http",
    "strict": true,
    "mvi": "minimal",
    "contextVersion": 0
  },
  "success": false,
  "result": null,
  "error": {
    "code": "E_MVI_BUDGET_EXCEEDED",
    "message": "Response exceeds declared token budget of 1000 tokens",
    "category": "VALIDATION",
    "retryable": true,
    "retryAfterMs": null,
    "details": {
      "estimatedTokens": 8452,
      "budget": 1000,
      "excessTokens": 7452,
      "constraint": "maxTokens",
      "suggestion": "Increase maxTokens to at least 8500 or request a summary"
    }
  }
}
```

#### Example 3: Truncated Response

**Request:**
```json
{
  "operation": "logs.query",
  "query": "level:error",
  "_budget": {
    "maxTokens": 500,
    "maxItems": 10
  }
}
```

**Response:**
```json
{
  "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
  "_meta": {
    "specVersion": "1.0.0",
    "schemaVersion": "1.0.0",
    "timestamp": "2026-02-16T10:32:00Z",
    "operation": "logs.query",
    "requestId": "req_003",
    "transport": "http",
    "strict": true,
    "mvi": "standard",
    "contextVersion": 0,
    "warnings": [
      {
        "code": "E_MVI_BUDGET_TRUNCATED",
        "message": "Response truncated to fit token budget",
        "details": {
          "requestedBudget": 500,
          "estimatedTokens": 1847,
          "truncatedTokens": 487,
          "truncationStrategy": "depth_first"
        }
      }
    ],
    "_tokenEstimate": {
      "estimated": 487,
      "budget": 500,
      "method": "character_based"
    }
  },
  "success": true,
  "result": {
    "logs": [
      {"timestamp": "2026-02-16T10:00:00Z", "level": "error", "message": "Connection timeout"},
      {"timestamp": "2026-02-16T09:45:00Z", "level": "error", "message": "Database error"}
    ],
    "truncated": true,
    "totalAvailable": 42
  }
}
```

---

### 9.4.6 Normative Token Estimation Algorithm

Servers MUST implement token estimation according to this normative algorithm or a method producing equivalent results (within +/- 10%).

#### 9.4.6.1 Algorithm Specification

```
FUNCTION estimate_tokens(value, depth = 0, max_depth = 20, ratio = 4.0):
    
    // Guard against excessive nesting
    IF depth > max_depth:
        RETURN INFINITY
    
    // Null values
    IF value IS null:
        RETURN 1
    
    // Boolean values
    IF value IS boolean:
        RETURN 1
    
    // Numeric values
    IF value IS number:
        // ~1 token per 4 digits
        RETURN max(1, CEIL(LEN(STRINGIFY(value)) / 4))
    
    // String values
    IF value IS string:
        // Count grapheme clusters (user-visible characters)
        graphemes = COUNT_GRAPHEME_CLUSTERS(value)
        // Apply character-to-token ratio
        RETURN max(1, CEIL(graphemes / ratio))
    
    // Array values
    IF value IS array:
        tokens = 2  // Opening and closing brackets
        FOR i FROM 0 TO LENGTH(value) - 1:
            tokens = tokens + estimate_tokens(value[i], depth + 1, max_depth, ratio)
            IF i < LENGTH(value) - 1:
                tokens = tokens + 1  // Comma separator
        RETURN tokens
    
    // Object values
    IF value IS object:
        tokens = 2  // Opening and closing braces
        keys = KEYS(value)
        FOR i FROM 0 TO LENGTH(keys) - 1:
            key = keys[i]
            // Key is always a string
            tokens = tokens + estimate_tokens(key, depth + 1, max_depth, ratio)
            tokens = tokens + 2  // Colon and comma
            tokens = tokens + estimate_tokens(value[key], depth + 1, max_depth, ratio)
        RETURN tokens
    
    RETURN 0
```

#### 9.4.6.2 Character-to-Token Ratios

The algorithm MUST use the following default ratios:

| Tokenizer Style | Ratio | Description |
|----------------|-------|-------------|
| `default` | 4.0 | Conservative default (recommended) |
| `gpt` | 4.0 | OpenAI GPT models (cl100k_base) |
| `claude` | 3.5 | Anthropic Claude models |
| `llama` | 3.8 | Llama family models |

Servers MAY support tokenizer-specific ratios but MUST default to 4.0 when not specified.

#### 9.4.6.3 Unicode Grapheme Counting

String token estimation MUST count grapheme clusters (user-perceived characters) rather than Unicode code points or bytes.

**ASCII Fast Path:**
- IF string contains only ASCII characters (U+0000 to U+007F):
  - RETURN LENGTH(string)

**Full Grapheme Counting:**
- Use language-specific grapheme segmentation (e.g., `Intl.Segmenter` in JavaScript, `unicodedata.grapheme_clusters` in Python)

**Example Grapheme Counts:**
| Input | Graphemes | Notes |
|-------|-----------|-------|
| "Hello" | 5 | ASCII characters |
| "🎉" | 1 | Single emoji |
| "👨‍👩‍👧‍👦" | 1 | Family emoji (ZWJ sequence) |
| "café" | 4 | Composed or decomposed |
| "中文" | 2 | CJK characters |

#### 9.4.6.4 Depth Limits

The algorithm MUST enforce a maximum depth of 20 levels to prevent:
- Stack overflow in recursive implementations
- Excessive computation on deeply nested structures
- Denial of service via malicious payloads

When depth exceeds the limit, the function MUST return INFINITY (or equivalent), forcing budget exceeded behavior.

#### 9.4.6.5 Circular Reference Handling

Servers MUST handle circular references in input data:

```
FUNCTION estimate_tokens_safe(value, depth = 0, seen = EMPTY_SET):
    
    // Detect circular references
    IF value IS object OR value IS array:
        IF CONTAINS(seen, IDENTITY(value)):
            RETURN 1  // Count as single token for circular ref
        seen = seen + IDENTITY(value)
    
    RETURN estimate_tokens(value, depth, seen)
```

#### 9.4.6.6 Implementation Requirements

Token estimation implementations MUST:
- Complete within 10ms for payloads up to 100KB
- Complete within 100ms for payloads up to 1MB
- Use constant memory per estimation (O(1) space complexity)
- Be deterministic (same input always produces same estimate)

---

### 9.4.7 JSON Schema Additions

#### 9.4.7.1 Request Schema Extension

The following schema defines the `_budget` request parameter:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://lafs.dev/schemas/v1/budget.request.schema.json",
  "title": "LAFS Budget Request Extension",
  "type": "object",
  "properties": {
    "_budget": {
      "type": "object",
      "minProperties": 1,
      "properties": {
        "maxTokens": {
          "type": "integer",
          "minimum": 1,
          "description": "Maximum approximate tokens in response"
        },
        "maxBytes": {
          "type": "integer",
          "minimum": 1,
          "description": "Maximum byte size of serialized response"
        },
        "maxItems": {
          "type": "integer",
          "minimum": 1,
          "description": "Maximum number of items in list responses"
        }
      },
      "additionalProperties": false
    }
  }
}
```

#### 9.4.7.2 Envelope Schema Extension

The `_meta` object in envelope responses MAY include:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://lafs.dev/schemas/v1/budget.meta.schema.json",
  "title": "LAFS Budget Metadata Extension",
  "type": "object",
  "properties": {
    "_meta": {
      "type": "object",
      "properties": {
        "_tokenEstimate": {
          "type": "object",
          "properties": {
            "estimated": {
              "type": "integer",
              "minimum": 0,
              "description": "Estimated token count"
            },
            "budget": {
              "type": ["integer", "null"],
              "minimum": 1,
              "description": "Budget that was requested"
            },
            "method": {
              "type": "string",
              "enum": ["character_based", "exact", "sampling"],
              "description": "Estimation method used"
            }
          },
          "required": ["estimated"],
          "additionalProperties": false
        }
      }
    }
  }
}
```

#### 9.4.7.3 Warning Schema Extension

Budget-related warnings use this structure:

```json
{
  "type": "object",
  "properties": {
    "code": {
      "type": "string",
      "enum": ["E_MVI_BUDGET_TRUNCATED"]
    },
    "message": {
      "type": "string"
    },
    "details": {
      "type": "object",
      "properties": {
        "requestedBudget": {
          "type": "integer"
        },
        "estimatedTokens": {
          "type": "integer"
        },
        "truncatedTokens": {
          "type": "integer"
        },
        "truncationStrategy": {
          "type": "string",
          "enum": ["depth_first", "field_priority", "hybrid"]
        }
      }
    }
  },
  "required": ["code", "message"]
}
```

---

### 9.4.8 Compliance

Implementations claiming support for token budget signaling MUST:

1. **Parse `_budget` parameters** - Accept and parse budget declarations in requests
2. **Enforce constraints** - Respect declared budgets or fail with `E_MVI_BUDGET_EXCEEDED`
3. **Estimate accurately** - Token estimates within +/- 10% of actual tokenizers
4. **Report violations** - Include `estimatedTokens`, `budget`, and `excessTokens` in error details
5. **Support retry** - Mark budget exceeded errors as `retryable: true`

Implementations SHOULD:

1. **Include metadata** - Add `_tokenEstimate` to response metadata
2. **Support truncation** - Implement at least one truncation strategy
3. **Document limits** - Publish maximum supported budget values
4. **Handle unicode** - Properly count grapheme clusters
5. **Prevent DoS** - Enforce depth limits and handle circular references

---

### 9.4.9 References

- [RFC 2119](https://tools.ietf.org/html/rfc2119) - Key words for use in RFCs
- LAFS Section 9 - MVI and Progressive Disclosure
- LAFS Error Registry - `E_MVI_BUDGET_EXCEEDED` definition
- LAFS Envelope Schema - Response envelope structure
- T087 Prototype Report - Budget enforcement validation (`/prototypes/budget-enforcement.md`)

---

### 9.4.10 Appendix: Reference Implementation (Pseudocode)

```python
class TokenBudgetEnforcer:
    """
    Reference implementation of token budget enforcement.
    """
    
    DEFAULT_RATIO = 4.0
    MAX_DEPTH = 20
    
    def enforce_budget(self, response, budget):
        """
        Enforce budget constraints on a response.
        
        Returns: (response, truncated) tuple
        """
        result = response.get('result')
        
        # Check item count for lists
        if budget.get('maxItems') and isinstance(result, list):
            if len(result) > budget['maxItems']:
                result = result[:budget['maxItems']]
                response['result'] = result
                response['_meta']['warnings'] = response['_meta'].get('warnings', []) + [{
                    'code': 'E_MVI_BUDGET_TRUNCATED',
                    'message': f'List truncated from {len(result)} to {budget["maxItems"]} items'
                }]
        
        # Check token budget
        if budget.get('maxTokens'):
            estimated = self.estimate_tokens(result)
            
            if estimated > budget['maxTokens']:
                # Try truncation
                truncated = self.truncate_to_budget(result, budget['maxTokens'])
                truncated_estimate = self.estimate_tokens(truncated)
                
                if truncated_estimate <= budget['maxTokens']:
                    # Truncation successful
                    response['result'] = truncated
                    response['_meta']['warnings'] = response['_meta'].get('warnings', []) + [{
                        'code': 'E_MVI_BUDGET_TRUNCATED',
                        'message': 'Response truncated to fit token budget',
                        'details': {
                            'requestedBudget': budget['maxTokens'],
                            'estimatedTokens': estimated,
                            'truncatedTokens': truncated_estimate
                        }
                    }]
                else:
                    # Cannot truncate enough - return error
                    return self._budget_exceeded_error(estimated, budget)
        
        # Add metadata
        response['_meta']['_tokenEstimate'] = {
            'estimated': self.estimate_tokens(response['result']),
            'budget': budget.get('maxTokens'),
            'method': 'character_based'
        }
        
        return response, False
    
    def estimate_tokens(self, value, depth=0):
        """Normative token estimation algorithm."""
        if depth > self.MAX_DEPTH:
            return float('inf')
        
        if value is None:
            return 1
        
        if isinstance(value, bool):
            return 1
        
        if isinstance(value, (int, float)):
            return max(1, len(str(value)) // 4)
        
        if isinstance(value, str):
            # Count graphemes (simplified)
            if value.isascii():
                return max(1, int(len(value) / self.DEFAULT_RATIO))
            else:
                graphemes = self._count_graphemes(value)
                return max(1, int(graphemes / self.DEFAULT_RATIO))
        
        if isinstance(value, list):
            tokens = 2  # []
            for i, item in enumerate(value):
                tokens += self.estimate_tokens(item, depth + 1)
                if i < len(value) - 1:
                    tokens += 1  # comma
            return tokens
        
        if isinstance(value, dict):
            tokens = 2  # {}
            items = list(value.items())
            for i, (key, val) in enumerate(items):
                tokens += self.estimate_tokens(str(key), depth + 1)
                tokens += 2  # : and ,
                tokens += self.estimate_tokens(val, depth + 1)
            return tokens
        
        return 0
    
    def truncate_to_budget(self, value, budget, depth=0):
        """Truncate value to fit within budget."""
        estimate = self.estimate_tokens(value, depth)
        
        if estimate <= budget:
            return value
        
        if isinstance(value, list):
            truncated = []
            current_budget = budget - 2  // Account for []
            
            for item in value:
                item_estimate = self.estimate_tokens(item, depth + 1)
                if item_estimate + 1 <= current_budget:
                    truncated.append(item)
                    current_budget -= item_estimate + 1
                else:
                    break
            
            return truncated
        
        if isinstance(value, dict):
            essential = ['id', 'name', 'success', 'code', 'message']
            truncated = {}
            current_budget = budget - 2  // Account for {}
            
            for key in essential:
                if key in value:
                    key_estimate = self.estimate_tokens(value[key], depth + 1)
                    key_tokens = len(key) // 4 + 2
                    if key_estimate + key_tokens <= current_budget:
                        truncated[key] = value[key]
                        current_budget -= key_estimate + key_tokens
            
            return truncated
        
        if isinstance(value, str):
            chars_to_keep = int((budget - 2) * self.DEFAULT_RATIO)
            return value[:chars_to_keep] + '...' if len(value) > chars_to_keep else value
        
        return value
    
    def _budget_exceeded_error(self, estimated, budget):
        """Generate budget exceeded error response."""
        return {
            'success': False,
            'result': None,
            'error': {
                'code': 'E_MVI_BUDGET_EXCEEDED',
                'message': f'Response exceeds token budget of {budget["maxTokens"]} tokens',
                'category': 'VALIDATION',
                'retryable': True,
                'retryAfterMs': None,
                'details': {
                    'estimatedTokens': estimated,
                    'budget': budget['maxTokens'],
                    'excessTokens': estimated - budget['maxTokens'],
                    'constraint': 'maxTokens'
                }
            }
        }, True
```

---

**End of Token Budget Signaling Specification**

*Specification Version: 1.0.0*  
*Status: Normative*  
*Based on: T087 Prototype Validation*
