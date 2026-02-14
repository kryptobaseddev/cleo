# CLEO MCP Schema Registry

**Version**: 1.0.0
**Task**: T2925
**Spec**: [MCP Server Specification](../../docs/specs/MCP-SERVER-SPECIFICATION.md)

---

## Overview

Comprehensive JSON Schema definitions for all **96 MCP operations** across **8 domains** in CLEO's two-gateway MCP server architecture.

### Coverage

| Category | Count | Description |
|----------|-------|-------------|
| **Total Operations** | 96 | Complete MCP API surface |
| **Request Schemas** | 93 | Input validation schemas |
| **Response Schemas** | 95 | Output validation schemas (93 + 2 common) |
| **Common Schemas** | 3 | Shared structures (_meta, error, pagination) |
| **Domains** | 8 | Functional domain groups |

---

## Architecture

### Directory Structure

```
schemas/
├── index.json                      # Schema registry
├── common/                         # Shared schemas
│   ├── meta.schema.json           # _meta envelope
│   ├── error.schema.json          # Error structure
│   └── pagination.schema.json     # Pagination
├── requests/                       # Request schemas (123)
│   ├── tasks/                     # 21 operations
│   ├── session/                   # 12 operations
│   ├── orchestrate/               # 12 operations
│   ├── research/                  # 10 operations
│   ├── lifecycle/                 # 10 operations
│   ├── validate/                  # 11 operations
│   ├── release/                   # 7 operations
│   ├── system/                    # 24 operations
│   ├── issues/                    # 4 operations
│   └── skills/                    # 12 operations
└── responses/                      # Response schemas (123)
    ├── common-success.schema.json # Base success
    ├── common-error.schema.json   # Base error
    └── {domain}/                  # Domain-specific responses
```

### Gateway Operations

| Gateway | Domains | Operations | Purpose |
|---------|---------|------------|---------|
| `cleo_query` | 9 | 63 | Read-only operations |
| `cleo_mutate` | 10 | 60 | State-modifying operations |

---

## Domain Breakdown

### tasks (21 operations)

**Queries (10)**:
- get, list, find, exists, tree
- blockers, deps, analyze, next, relates

**Mutations (11)**:
- create, update, complete, delete, archive
- unarchive, reparent, promote, reorder, reopen, relates.add

### session (12 operations)

**Queries (5)**:
- status, list, show, focus.get, history

**Mutations (7)**:
- start, end, resume, suspend
- focus.set, focus.clear, gc

### orchestrate (12 operations)

**Queries (7)**:
- status, next, ready, analyze
- context, waves, skill.list

**Mutations (5)**:
- startup, spawn, validate
- parallel.start, parallel.end

### research (10 operations)

**Queries (6)**:
- show, list, query, pending
- stats, manifest.read

**Mutations (4)**:
- inject, link
- manifest.append, manifest.archive

### lifecycle (10 operations)

**Queries (5)**:
- check, status, history
- gates, prerequisites

**Mutations (5)**:
- progress, skip, reset
- gate.pass, gate.fail

### validate (11 operations)

**Queries (9)**:
- schema, protocol, task, manifest, output
- compliance.summary, compliance.violations
- test.status, test.coverage

**Mutations (2)**:
- compliance.record, test.run

### release (7 operations)

**Mutations (7)**:
- prepare, changelog, commit
- tag, push, gates.run, rollback

### system (24 operations)

**Queries (14)**:
- version, doctor, config.get, stats, context
- job.status, job.list, dash, roadmap, labels
- compliance, log, archive-stats, sequence

**Mutations (10)**:
- init, config.set, backup, restore
- migrate, sync, cleanup, job.cancel, safestop, uncancel

### issues (4 operations)

**Queries (1)**:
- diagnostics

**Mutations (3)**:
- create_bug, create_feature, create_help

### skills (12 operations)

**Queries (6)**:
- list, show, search
- dispatch, verify, dependencies

**Mutations (6)**:
- install, uninstall, enable
- disable, configure, refresh

---

## Schema Conventions

### Request Schema Pattern

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "{domain}.{operation} request",
  "description": "Operation description",
  "type": "object",
  "properties": {
    "param": {
      "type": "string",
      "description": "Parameter description"
    }
  },
  "required": ["param"],
  "additionalProperties": false
}
```

### Response Schema Pattern

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "{domain}.{operation} response",
  "description": "Response data description",
  "allOf": [
    {
      "$ref": "../common-success.schema.json"
    },
    {
      "properties": {
        "data": {
          "type": "object",
          "description": "Domain-specific data"
        }
      }
    }
  ]
}
```

### Common Envelope

All responses wrap data in standard envelope:

```json
{
  "_meta": {
    "gateway": "cleo_query|cleo_mutate",
    "domain": "tasks",
    "operation": "get",
    "version": "1.0.0",
    "timestamp": "2026-02-04T08:20:00Z",
    "duration_ms": 45
  },
  "success": true,
  "data": { /* operation-specific */ }
}
```

---

## Validation Usage

### Node.js (Ajv)

```javascript
const Ajv = require('ajv');
const ajv = new Ajv();

// Load schemas
const metaSchema = require('./common/meta.schema.json');
const requestSchema = require('./requests/tasks/get.schema.json');

// Validate request
const validateRequest = ajv.compile(requestSchema);
const valid = validateRequest({ taskId: "T2925" });

if (!valid) {
  console.error(validateRequest.errors);
}
```

### CLI Validation

```bash
# Install ajv-cli
npm install -g ajv-cli

# Validate request
ajv validate -s schemas/requests/tasks/get.schema.json \
  -d '{"taskId":"T2925"}'

# Validate response
ajv validate -s schemas/responses/tasks/get.schema.json \
  -d response.json
```

---

## Schema Generation

Schemas were generated via scripts (see git history):

1. `generate-schemas.sh` - Session, orchestrate, research domains
2. `generate-schemas-part2.sh` - Validate, release, system domains
3. `generate-response-schemas.sh` - All 98 response schemas

**Regeneration** (if schema spec changes):

```bash
cd mcp-server
./generate-schemas.sh
./generate-schemas-part2.sh
./generate-response-schemas.sh
```

---

## Integration Checklist

- [x] Create schema directory structure
- [x] Generate all 98 request schemas
- [x] Generate all 98 response schemas
- [x] Create common schemas (_meta, error, pagination)
- [x] Create schema index registry
- [ ] Add schema validation to domain handlers
- [ ] Update package.json to include schemas/ in distribution
- [ ] Create integration tests using schemas

---

## References

- [MCP Server Specification](../../docs/specs/MCP-SERVER-SPECIFICATION.md)
- [JSON Schema Draft-07](https://json-schema.org/draft-07/schema)
- [Ajv JSON Schema Validator](https://ajv.js.org/)

---

**Task**: T2925
**Date**: 2026-02-04
**Status**: Complete
