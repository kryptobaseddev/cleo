# Python SDK Reference

**What you'll learn:** How to use the LAFS Python SDK for envelope creation, validation, and conformance testing.

## Installation

```bash
pip install lafs
```

## Core functions

### `create_envelope()`

Create a LAFS-compliant envelope.

```python
from lafs import create_envelope

envelope = create_envelope(
    success=True,
    result={"message": "Hello, World!"},
    meta={
        "operation": "hello.world",
        "requestId": "req_123"
    }
)
```

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `success` | `bool` | Yes | Success indicator |
| `result` | `Any` | Conditional | Result data (required if success=True) |
| `error` | `dict` | Conditional | Error details (required if success=False) |
| `page` | `dict` | No | Pagination info |
| `meta` | `dict` | Yes | Metadata including operation, requestId |

**Returns:** `dict` — LAFS envelope

### `validate_envelope()`

Validate an envelope against the JSON Schema.

```python
from lafs import validate_envelope

result = validate_envelope(envelope)

if result.valid:
    print("Envelope is valid")
else:
    print("Validation errors:", result.errors)
```

**Returns:**

```python
class ValidationResult:
    valid: bool
    errors: List[ValidationError] | None
```

### `parse_lafs_response()`

Parse and validate a LAFS response, extracting the result or raising on error.

```python
from lafs import parse_lafs_response, LafsError

try:
    result = parse_lafs_response(envelope)
    print("Result:", result)
except LafsError as e:
    print(f"LAFS Error: {e.code} - {e.message}")
    if e.retryable:
        # Retry logic
        pass
```

### `is_registered_error_code()`

Check if an error code is in the LAFS registry.

```python
from lafs import is_registered_error_code

if is_registered_error_code("E_NOT_FOUND_RESOURCE"):
    print("Valid error code")
```

## Conformance testing

### `run_envelope_conformance()`

Run the full conformance test suite on an envelope.

```python
from lafs import run_envelope_conformance

report = run_envelope_conformance(
    envelope,
    tier="standard",  # 'core', 'standard', or 'complete'
    strict=True
)

print(f"All checks passed: {report.ok}")
print(f"Passed: {len(report.passed)}")
print(f"Failed: {len(report.failed)}")

# Individual check results
for check in report.checks:
    status = "PASS" if check.passed else "FAIL"
    print(f"{check.name}: {status}")
    if not check.passed:
        print(f"  Error: {check.error}")
```

**Conformance checks:**

| Check | Tier | Description |
|-------|------|-------------|
| `envelope_schema_valid` | Core | Validates against JSON Schema |
| `envelope_invariants` | Core | Checks success/result/error consistency |
| `error_code_registered` | Core | Verifies error code exists in registry |
| `meta_mvi_present` | Standard | Validates MVI disclosure level |
| `meta_strict_present` | Standard | Checks strict mode declaration |
| `strict_mode_behavior` | Standard | Validates optional field handling |
| `strict_mode_enforced` | Standard | Checks unknown property rejection |
| `pagination_mode_consistent` | Standard | Validates pagination metadata |

## Data classes

### `LafsEnvelope`

```python
from dataclasses import dataclass
from typing import Any, Optional

@dataclass
class LafsEnvelope:
    _meta: MetaData
    success: bool
    result: Optional[Any]
    error: Optional[LafsError]
    page: Optional[PageMetadata] = None
    _extensions: Optional[dict] = None
    $schema: Optional[str] = None
```

### `LafsError`

```python
from dataclasses import dataclass
from typing import Optional

@dataclass
class LafsError:
    code: str
    message: str
    category: str  # VALIDATION, NOT_FOUND, AUTH, etc.
    retryable: bool
    retry_after_ms: Optional[int] = None
    details: Optional[dict] = None
```

### Error categories

```python
ERROR_CATEGORIES = [
    "VALIDATION",
    "NOT_FOUND",
    "AUTH",
    "PERMISSION",
    "RATE_LIMIT",
    "CONFLICT",
    "TRANSIENT",
    "INTERNAL",
    "CONTRACT",
    "MIGRATION"
]
```

### `PageMetadata`

```python
from dataclasses import dataclass
from typing import Union

@dataclass
class CursorPageMetadata:
    mode: str = "cursor"
    next_cursor: str
    has_more: bool

@dataclass
class OffsetPageMetadata:
    mode: str = "offset"
    offset: int
    limit: int
    total: int
    has_more: bool

PageMetadata = Union[CursorPageMetadata, OffsetPageMetadata]
```

## Error handling

### `LafsError` exception

```python
from lafs import LafsError, parse_lafs_response

try:
    result = parse_lafs_response(envelope)
except LafsError as e:
    print(f"Code: {e.code}")
    print(f"Category: {e.category}")
    print(f"Retryable: {e.retryable}")
    
    if e.retryable:
        # Implement retry
        pass
```

## Advanced usage

### Custom validation with jsonschema

```python
import json
from jsonschema import validate, ValidationError

# Load schema
with open('schemas/v1/envelope.schema.json') as f:
    schema = json.load(f)

# Validate
try:
    validate(envelope, schema)
    print("Valid!")
except ValidationError as e:
    print(f"Validation error: {e.message}")
```

### Token estimation

```python
from lafs import estimate_tokens

data = {"users": [{"id": 1, "name": "Alice"}]}
tokens = estimate_tokens(data)
print(f"Estimated tokens: {tokens}")
```

### Flask integration example

```python
from flask import Flask, request, jsonify
from lafs import create_envelope, validate_envelope
import uuid

app = Flask(__name__)

@app.route('/api/users', methods=['GET'])
def get_users():
    request_id = request.headers.get('X-Request-Id', str(uuid.uuid4()))
    
    try:
        users = fetch_users_from_db()
        
        envelope = create_envelope(
            success=True,
            result={"users": users},
            meta={
                "operation": "users.list",
                "requestId": request_id,
                "timestamp": datetime.utcnow().isoformat()
            }
        )
        
        response = jsonify(envelope)
        response.headers['X-Request-Id'] = request_id
        return response
        
    except Exception as e:
        envelope = create_envelope(
            success=False,
            error={
                "code": "E_INTERNAL_ERROR",
                "message": str(e),
                "category": "INTERNAL",
                "retryable": False
            },
            meta={
                "operation": "users.list",
                "requestId": request_id
            }
        )
        return jsonify(envelope), 500

if __name__ == '__main__':
    app.run(debug=True)
```

## Next steps

- **[TypeScript SDK](typescript.md)** — TypeScript SDK reference
- **[CLI Reference](cli.md)** — Command-line tools
- **[Envelope basics](../getting-started/envelope-basics.md)** — Learn about envelopes
