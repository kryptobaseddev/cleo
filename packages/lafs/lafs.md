# LAFS: LLM-Agent-First Specification

> **Version:** 2026.4.0 | **Status:** Production Ready

## 1. Scope

LAFS is a **response envelope contract specification**. It defines the canonical shape of structured responses — success envelopes, error envelopes, pagination metadata, and context preservation — for software systems whose primary consumer is an LLM agent or AI-driven tool.

LAFS is **not** a protocol, framework, or runtime. It specifies **what** a conformant response looks like, not how that response is transported or generated. Implementations MAY deliver LAFS envelopes over HTTP, gRPC, CLI, SDK interfaces, message queues, or any other transport mechanism. LAFS is transport-agnostic and language-agnostic.

LAFS is designed to complement — not compete with — existing agent and tool-integration protocols. The Model Context Protocol (MCP) defines how LLM hosts discover and invoke tools; the Agent-to-Agent protocol (A2A) defines how autonomous agents communicate and delegate tasks. LAFS operates at a different layer: it standardizes the **response contract** that tools and agents SHOULD return, regardless of the protocol used to invoke them. An MCP tool server, an A2A agent, or a plain REST API MAY all return LAFS-conformant envelopes.

While LAFS is purpose-built for AI and LLM tool ecosystems — where deterministic, machine-parseable responses are critical — the specification is generally applicable to any API that benefits from structured, predictable response contracts.

---

## 2. Non-Goals

The following capabilities are intentionally outside the scope of LAFS. This section exists to prevent scope creep and to clarify boundaries with complementary protocols.

1. **Streaming responses.** LAFS defines discrete request/response envelopes. Streaming mechanisms such as SSE or WebSocket are transport concerns and MUST NOT be defined by LAFS.

2. **Asynchronous processing.** LAFS envelopes are synchronous response contracts. Async job patterns (polling, webhooks, callback queues) are application-layer concerns and are outside LAFS scope.

3. **Authentication and authorization.** LAFS is transport-agnostic; auth is a transport or middleware concern. LAFS MAY carry auth-related error codes (e.g., `E_AUTH_*`) but MUST NOT define authentication or authorization flows.

4. **Multi-modal content.** LAFS envelopes carry structured JSON data. Binary payloads, media content negotiation, and multi-modal encoding are outside scope.

5. **Transport binding.** LAFS defines the response envelope shape, not how it maps to HTTP status codes, gRPC metadata, or other transport semantics. Transport mapping specifications are a separate concern.

6. **Service discovery.** LAFS does not define how consumers locate or enumerate LAFS-conformant endpoints. Discovery mechanisms SHOULD be provided by the deployment layer or complementary protocols.

---

## 3. RFC 2119 Keywords

The keywords MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are interpreted per RFC 2119.

---

## 4. Non-Negotiable Protocol Rules

1. Output default MUST be machine-readable JSON.
2. Human-readable mode MUST be explicit opt-in.
3. Context continuity MUST be preserved across steps.
4. MVI (Minimal Viable Information) MUST be default response behavior.
5. Progressive disclosure MUST be used for expanded detail retrieval.
6. Contracts MUST be deterministic and testable.

---

## 5. Format Semantics

### 5.1 Required output semantics

- Default format MUST be `json`.
- `--human` MUST switch output mode to human-readable.
- `--json` MAY be supported as explicit alias/override and is RECOMMENDED.
- Providing both `--human` and `--json` MUST fail with `E_FORMAT_CONFLICT`.
- Explicit flags MUST override env/config defaults.

### 5.2 Recommended precedence

1. Explicit CLI/API request value
2. Project config
3. Global/user config
4. Protocol default (`json`)

### 5.3 Supported formats

LAFS supports exactly two output formats:

- **`json`** (default) — Machine-readable JSON envelope for programmatic consumption
- **`human`** — Human-readable text output for terminal display

#### 5.3.1 Human format definition

The `human` format produces plain text output optimized for terminal display:

- Suitable for direct human consumption in CLI environments
- NOT markdown, NOT tables, NOT structured data
- May include ANSI colors (respect `NO_COLOR` environment variable)
- Example: Tabular data displayed with aligned columns using spaces

```
ID    Name          Status
----  ------------  --------
123   Alpha         active
456   Beta          pending
```

#### 5.3.2 Rejected formats

The following formats were explicitly rejected to maintain protocol minimalism:

| Format | Status | Rationale |
|--------|--------|-----------|
| `text` | ❌ Rejected | Ambiguous overlap with `human`. Use `human` format with `NO_COLOR=1` for plain text. |
| `markdown` | ❌ Rejected | Presentation format, not data format. Generate from JSON if markdown rendering is needed. |
| `table` | ❌ Rejected | Presentation concern. Use `jq` + `column` command or `human` format for tabular display. |
| `jsonl` | ❌ Rejected | Streaming format violates LAFS discrete envelope contract (see Section 2: Non-Goals). |

**Design principle:** LAFS is a response envelope contract, not a presentation layer. Six formats = format proliferation = protocol bloat.

#### 5.3.3 Achieving presentation goals with json format

Consumers needing presentation formats should:

1. Request `json` format from LAFS-compliant services
2. Transform JSON to desired presentation format using standard tools:
   - **Markdown:** `jq` + template engine
   - **Tables:** `jq` + `column` command
   - **Plain text:** `jq` with `-r` (raw) output

### 5.4 Cross-layer flag interaction

Flags operate on two independent layers: **format** (`--human`, `--json`, `--quiet`) and **field extraction** (`--field`, `--fields`, `--mvi`). When flags from both layers are combined, the following semantics apply:

#### 5.4.1 Filter-then-render (default)

When `--field` or `--fields` are combined with a format flag, the field extraction layer applies **first**, followed by the format layer:

- **`--human + --field`**: Extract the named field from the result, then render the extracted value in human-readable format. Implementations SHOULD emit a warning but MUST NOT error.
- **`--human + --fields`**: Filter result keys, then render the filtered result in human-readable format. Same warning behavior.
- **`--json + --field`**: Extract the named field and output as plain text (no envelope). This is the default behavior (no cross-layer concern).
- **`--json + --fields`**: Filter result keys within the JSON envelope. This is the default behavior.
- **`--quiet + --field`**: Valid combination. Extract field, output plain text.
- **`--quiet + --fields`**: Valid combination. Filter keys, output minimal.

#### 5.4.2 Error conditions

Cross-layer combinations that involve conflicting format flags still error per §5.1:

- **`--human + --json + --field`**: MUST fail with `E_FORMAT_CONFLICT` (format layer conflict, §5.1).
- **`--field + --fields`**: MUST fail with `E_FIELD_CONFLICT` (field layer conflict, §9.2).

#### 5.4.3 MVI interaction

- **`--human + --mvi`**: The `--mvi` level MAY be honored for metadata filtering; human rendering is the primary output format. No error or warning.

---

## 6. Canonical Response Envelope

All responses MUST conform to `schemas/v1/envelope.schema.json`.

```json
{
  "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
  "_meta": {
    "specVersion": "1.0.0",
    "schemaVersion": "1.0.0",
    "timestamp": "2026-02-11T00:00:00Z",
    "operation": "operation.name",
    "requestId": "req_123",
    "transport": "cli",
    "strict": true,
    "mvi": "standard",
    "contextVersion": 0
  },
  "success": true,
  "result": {},
  "error": null,
  "page": null
}
```

### 6.1 Envelope invariants

- `success=true` implies `error=null` or error omitted.
- `success=false` implies `result=null` and `error` MUST be present.
- The `page` and `error` fields are optional when their value would be null. In strict mode, producers SHOULD omit these fields rather than set them to null.
- Unknown fields SHOULD be rejected when strict mode is enabled.

### 6.2 Extensions

The envelope supports an optional `_extensions` object for vendor-specific metadata. Because `_extensions` is a declared property in the schema, it is permitted regardless of strict mode.

- Keys SHOULD use the `x-` prefix convention (e.g., `x-myvendor-trace-id`).
- Consumers MUST NOT rely on extension fields for protocol-required behavior.
- Producers MAY omit `_extensions` entirely; the field is always optional.

#### 6.2.1 Extension use cases

The following examples demonstrate common use cases for `_extensions`. These fields were rejected from the core protocol but are valid extension use cases.

**Example 1: Performance timing**

```typescript
// Extension type definition
interface XTimingExtension {
  "x-timing": {
    executionMs: number;        // Total request execution time
    parseMs?: number;           // Input parsing time
    queryMs?: number;           // Database query time
    serializeMs?: number;       // Response serialization time
  };
}
```

```json
{
  "_extensions": {
    "x-timing": {
      "executionMs": 42,
      "queryMs": 15,
      "serializeMs": 3
    }
  }
}
```

**Example 2: Source metadata**

```typescript
interface XSourceExtension {
  "x-source": {
    gitRef?: string;           // Git commit SHA
    apiVersion?: string;       // API implementation version
    buildTimestamp?: string;   // ISO 8601 build time
    deployment?: string;       // Deployment environment (staging, prod)
  };
}
```

```json
{
  "_extensions": {
    "x-source": {
      "gitRef": "abc123def456",
      "apiVersion": "2.1.0",
      "deployment": "production"
    }
  }
}
```

**Example 3: Applied filters**

```typescript
interface XFiltersExtension {
  "x-filters": {
    applied: Array<{
      field: string;
      operator: "eq" | "neq" | "gt" | "lt" | "contains";
      value: unknown;
    }>;
    omitted: string[];         // Fields excluded due to permissions
  };
}
```

```json
{
  "_extensions": {
    "x-filters": {
      "applied": [
        { "field": "status", "operator": "eq", "value": "active" },
        { "field": "createdAt", "operator": "gt", "value": "2024-01-01" }
      ],
      "omitted": ["internalNotes", "costCenter"]
    }
  }
}
```

**Example 4: Result summary**

```typescript
interface XSummaryExtension {
  "x-summary": {
    totalCount: number;        // Total matching records
    returnedCount: number;     // Records in this response
    aggregated?: {
      revenue?: number;
      count?: number;
      average?: number;
    };
  };
}
```

```json
{
  "_extensions": {
    "x-summary": {
      "totalCount": 150,
      "returnedCount": 25,
      "aggregated": {
        "revenue": 125000.00,
        "average": 833.33
      }
    }
  }
}
```

#### 6.2.2 Extension best practices

1. **Use x- prefix** — All extension keys MUST start with `x-` (e.g., `x-caamp-timing`)
2. **Document your schema** — Publish extension schemas separately from LAFS core
3. **Don't rely on extensions for core behavior** — Extensions are informational only
4. **Version your extensions** — Include version in extension key if schema may change (e.g., `x-vendor-v2-field`)
5. **Keep extensions optional** — Consumers MUST be able to operate without extension data
6. **Namespace by vendor** — Use vendor prefix to avoid collisions (e.g., `x-caamp-`, `x-acme-`)

#### 6.2.3 When to use extensions vs core protocol

| Use Case | Core Protocol | Extensions |
|----------|---------------|------------|
| Session correlation | ✅ sessionId | — |
| Soft warnings | ✅ warnings array | — |
| Performance timing | — | ✅ x-timing |
| Source/version metadata | — | ✅ x-source |
| Debug filters | — | ✅ x-filters |
| Derived summaries | — | ✅ x-summary |
| Data integrity (TLS covers) | — | ✅ x-checksum (if needed) |

**Guideline:** If a field is required for basic operation, it belongs in core. If it's useful for debugging, monitoring, or rich display, it belongs in extensions.

---

## 7. Error Contract

Errors MUST conform to envelope `error` shape and use codes from `schemas/v1/error-registry.json`.

```json
{
  "code": "E_VALIDATION_SCHEMA",
  "message": "Invalid input payload",
  "category": "VALIDATION",
  "retryable": false,
  "retryAfterMs": null,
  "details": {
    "field": "limit"
  }
}
```

### 7.1 Error code naming convention

Error codes MUST match the pattern: `^E_[A-Z0-9]+_[A-Z0-9_]+$`

The structure is **E\_\<DOMAIN\>\_\<SPECIFIC\>**, where:

- **E\_** — required prefix identifying the value as an error code.
- **DOMAIN** — a short uppercase token describing the error's semantic area (e.g., `VALIDATION`, `CONTEXT`, `RATE`, `MIGRATION`). The domain is descriptive; it does not need to equal the `category` enum value.
- **SPECIFIC** — one or more uppercase tokens (separated by `_`) that distinguish the error within its domain (e.g., `SCHEMA`, `MISSING`, `UNSUPPORTED_VERSION`).

Examples from the registry:

| Code | Domain | Specific | Category |
|---|---|---|---|
| `E_VALIDATION_SCHEMA` | `VALIDATION` | `SCHEMA` | VALIDATION |
| `E_NOT_FOUND_RESOURCE` | `NOT` | `FOUND_RESOURCE` | NOT_FOUND |
| `E_CONTEXT_MISSING` | `CONTEXT` | `MISSING` | CONTRACT |
| `E_MIGRATION_UNSUPPORTED_VERSION` | `MIGRATION` | `UNSUPPORTED_VERSION` | MIGRATION |

Registered categories (the `category` field in error objects): `VALIDATION`, `AUTH`, `PERMISSION`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMIT`, `TRANSIENT`, `INTERNAL`, `CONTRACT`, `MIGRATION`.

Custom error codes MUST match the same regex pattern. Implementations SHOULD choose a domain token that clearly communicates the error's origin.

### 7.2 Required behavior

- Error codes MUST be stable within major versions.
- Retry semantics MUST be encoded in `retryable` and `retryAfterMs`.
- CLI/HTTP/gRPC mappings SHOULD follow the registry.

### 7.3 Agent action semantics

Error objects MAY include an `agentAction` field providing a machine-readable
instruction for the consuming agent. When present, `agentAction` MUST be one of:

| Value | Semantics |
|-------|-----------|
| `retry` | Transient failure. Agent SHOULD retry the same request, optionally after `retryAfterMs`. |
| `retry_modified` | Request was invalid. Agent SHOULD modify request parameters and retry. The `details` field SHOULD indicate which parameters to change. |
| `wait` | Rate limited. Agent MUST wait at least `retryAfterMs` milliseconds before retrying. Exponential backoff is RECOMMENDED. |
| `escalate` | Requires human or operator intervention. Agent SHOULD surface the error to the user with the `requestId` for correlation. |
| `stop` | Terminal error. Agent MUST NOT retry this request. |
| `refresh_context` | Context is stale. Agent SHOULD fetch fresh context via `contextVersion` and retry. |
| `authenticate` | Authentication required or expired. Agent SHOULD obtain or refresh credentials before retrying. |

When `agentAction` is absent, agents SHOULD derive the action from `category`
using the default mapping published in the error registry.

Implementations SHOULD always include `agentAction` in error responses to
eliminate ambiguity and reduce agent reasoning overhead.

#### 7.3.1 Escalation signal

Error objects MAY include an `escalationRequired` boolean field. When `true`,
the agent MUST NOT attempt automated recovery and SHOULD surface the error
to a human operator. This field is independent of `retryable`: an error may
be retryable by a human but not by an agent.

#### 7.3.2 Suggested action

Error objects MAY include a `suggestedAction` string field providing a brief,
specific instruction for recovery. This field is distinct from `message` (which
describes what happened) and carries actionable guidance for the consumer.

#### 7.3.3 Documentation URL

Error objects MAY include a `docUrl` string field containing a URI pointing to
documentation for the error type. Agents capable of web retrieval MAY use this
for autonomous error resolution. The error registry SHOULD publish `docUrl`
values for all registered error codes.

---

## 8. Context Preservation

Multi-step operations MUST preserve a context ledger with at least:

- `objective`
- `constraints[]`
- `references[]`
- `decisions[]`
- `openIssues[]`
- `state`
- `version`

Rules:

- Version MUST increase monotonically by 1 for accepted mutations.
- Accepted active constraints MUST NOT be silently removed.
- Decisions affecting output MUST be represented in ledger state.
- Missing required context for a mutating step MUST fail with structured error.

### 8.1 Context Retrieval

Agents MAY retrieve context ledger state via `GET /_lafs/context/{ledgerId}` with projection modes.

#### 8.1.1 Projection Modes

**Full Mode (`mode=full`):**
Returns complete ledger including all entries.
- Use for: Initial loads, recovery scenarios
- Supports: Offset-based pagination
- Response includes: All ledger fields

**Delta Mode (`mode=delta&sinceVersion=N`):**
Returns only entries added since version N.
- Use for: Active workflows (efficient sync)
- Response includes:
```json
{
  "ledgerId": "ctx_abc123",
  "mode": "delta",
  "fromVersion": 10,
  "toVersion": 15,
  "entries": [/* new entries only */],
  "removedConstraints": [/* constraints no longer active */],
  "checksum": "sha256:..."
}
```

**Summary Mode (`mode=summary`):**
Returns checksum and version for validation.
- Use for: Quick sync validation
- Response includes only: `ledgerId`, `version`, `checksum`, `entryCount`

#### 8.1.2 Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `mode` | enum | `full`, `delta`, `summary` |
| `sinceVersion` | integer | For delta mode: return entries after this version |
| `filterByOperation` | string[] | Filter entries by operation name(s) |
| `limit` | integer | Max entries (1-1000, default 100) |
| `includeChecksum` | boolean | Include integrity checksum (default true) |

#### 8.1.3 Agent Guidance

- **Initial load**: Use `mode=full` once
- **Active workflows**: Use `mode=delta` with last known version
- **Validation**: Use `mode=summary` to verify sync state
- **Default recommendation**: `delta` mode for agent-optimal behavior

### 8.2 Lazy Context Retrieval

To reduce token and I/O overhead, implementations SHOULD support lazy retrieval semantics:

- Clients SHOULD start with `mode=summary` and request `mode=delta` only when `version` or `checksum` changes.
- Delta responses SHOULD be bounded by `limit` and MAY return paged deltas.
- Servers SHOULD treat context retrieval as task-scoped and MUST NOT leak entries across `contextId` domains.
- When a consumer requests additional context beyond MVI defaults, servers MAY return progressive context slices rather than full ledgers.
- If requested context scope cannot be satisfied within declared budget, servers SHOULD fail with `E_MVI_BUDGET_EXCEEDED`.

---

## 9. MVI and Progressive Disclosure

### 9.1 MVI default

- Default list/batch outputs MUST only contain fields required for next action.
- Verbose fields SHOULD be omitted by default.
- Systems SHOULD publish operation-level MVI budgets.
- `_meta.mvi` MUST be one of: `minimal`, `standard`, `full`, or `custom`.
- `_meta` MUST always be present as a structural envelope field. `success` MUST
  always be present. `error` MUST be present when `success` is `false`.
- MVI levels govern the verbosity of `result`, `_meta` fields, and `error` fields.
  At `minimal`, implementations SHOULD omit fields that are derivable from the
  error registry or that echo back request parameters the agent already knows.
- The following envelope structural invariants are NOT affected by MVI level:
  the mutual exclusivity of `result` and `error`, the presence of `success`,
  and the presence of `_meta`.
- `minimal`: MUST include only fields within `result` sufficient for the next
  agent action (typically identifiers and status). Implementations SHOULD
  document which fields constitute `minimal` per operation.
- `standard` (default): MUST include all commonly useful fields for the
  operation.
- `full`: MUST include all available fields including verbose and
  rarely-accessed data.
- `custom`: MUST be set by the server when `_fields` projection has been
  applied, indicating the result does not conform to any predefined disclosure
  level. `custom` is not a client-requestable level.

#### 9.1.1 MVI field inclusion for `_meta`

At `minimal`, `_meta` MUST include only:
- `requestId` (REQUIRED)
- `contextVersion` (REQUIRED)
- `sessionId` (REQUIRED when present in the full response)
- `warnings` (REQUIRED when present in the full response)

At `standard`, `_meta` MUST additionally include:
- `timestamp`
- `operation`
- `mvi`

At `full`, `_meta` MUST include all defined fields including `specVersion`,
`schemaVersion`, `transport`, and `strict`.

Fields omitted at a given MVI level are echo-backs of request parameters that
the agent already knows, or static constants that do not vary per response.

#### 9.1.2 MVI field inclusion for `error`

At `minimal`, `error` MUST include only:
- `code` (REQUIRED)
- `agentAction` (REQUIRED when present)
- `retryAfterMs` (REQUIRED when non-null)
- `details` (REQUIRED when non-empty)
- `escalationRequired` (REQUIRED when present)

At `standard` and `full`, `error` MUST include all fields defined in Section 7,
including `message`, `category`, `retryable`, and `retryAfterMs`.

Fields omitted at `minimal` are either human-readable prose (`message`) or
derivable from the error code via the error registry (`category`, `retryable`).

#### 9.1.3 MVI field inclusion for envelope structure

At `minimal`:
- `$schema` MAY be omitted (static constant)
- `result` MAY be omitted when its value is `null` (derivable from `success: false`)

At `standard` and `full`, all structural fields MUST be present per the
envelope schema.

### 9.2 Field selection (`_fields`)

Clients MAY request a subset of response fields via the `_fields` request
parameter.

- `_fields` MUST be an array of strings identifying `result` field names.
  Path notation (e.g., `task.title`) is not defined by this specification.
- When `result` is an array, `_fields` applies to the keys of each element.
- When `result` is a wrapper object whose values are entities or arrays of
  entities (e.g., `{ "task": { ... } }` or `{ "items": [...] }`), servers
  SHOULD apply `_fields` to the nested entity fields rather than the wrapper's
  own keys.
- When `_fields` is present, the server MUST return only the requested fields
  plus any MVI-required fields for the declared disclosure level.
  The server MUST set `_meta.mvi` to `custom` in the response.
- When `_fields` is absent, the server MUST return fields appropriate for the
  declared `_meta.mvi` disclosure level.
- If a requested field does not exist on the resource, the server SHOULD omit
  it silently (no error). Servers MAY include a warning in `_meta.warnings`
  for unknown fields.
- `_fields` MUST NOT affect envelope structural fields (`$schema`, `_meta`,
  `success`, `error`, `page`, `_extensions`); it applies only to the contents
  of `result`.

### 9.3 Expansion mechanism (`_expand`)

Clients MAY request expanded/nested data via the `_expand` request parameter.

- `_expand` MUST be an array of strings identifying relationships or nested resources to include inline.
- When `_expand` is present, the server MUST resolve and inline the requested expansions within `result`.
- If a requested expansion field is not recognized, the server MUST return error code `E_DISCLOSURE_UNKNOWN_FIELD` with category `VALIDATION`.
- Servers SHOULD document available expansion fields per operation.
- Expansion depth MUST be limited to prevent unbounded recursion. Servers SHOULD enforce a maximum expansion depth and return `E_MVI_BUDGET_EXCEEDED` if exceeded.

### 9.4 Pagination

- List operations SHOULD return deterministic `page` metadata.
- Pagination mode (offset or cursor) MUST be documented.
- Mixed pagination modes in one request MUST fail validation.
- `page.limit` SHOULD represent the effective item window after `_fields`/`_expand` processing.
- When `_meta.mvi` is `minimal` and projected payload size exceeds budget, servers SHOULD reduce `page.limit` rather than silently truncate item content.
- If limit reduction still cannot satisfy declared budget, servers MUST fail with `E_MVI_BUDGET_EXCEEDED`.

### 9.5 Token Budget Signaling

Token budget signaling enables clients to declare resource constraints that servers MUST respect when generating responses. This mechanism prevents context window overflow in LLM-driven workflows.

#### 9.5.1 Budget Declaration (`_budget`)

Clients MAY declare resource constraints via the `_budget` request parameter:

```json
{
  "_budget": {
    "maxTokens": 4000,
    "maxBytes": 32768,
    "maxItems": 100
  }
}
```

**Fields:**
- `maxTokens` (integer) - Maximum approximate tokens
- `maxBytes` (integer) - Maximum byte size
- `maxItems` (integer) - Maximum items in lists

**Constraints:**
- At least one field MUST be present
- All values MUST be positive integers
- Servers MAY reject budgets exceeding implementation limits

#### 9.5.2 Server Behavior

Servers MUST:
1. Parse `_budget` from incoming requests
2. Estimate/measure response size
3. Return response within budget OR fail with `E_MVI_BUDGET_EXCEEDED`

Servers MAY truncate responses using:
- **Depth-first**: Remove deepest nested fields
- **Field priority**: Remove non-essential fields first
- **Hybrid**: Combine both strategies

When truncation occurs, servers MUST include:
```json
{
  "_meta": {
    "warnings": [{
      "code": "E_MVI_BUDGET_TRUNCATED",
      "message": "Response truncated to fit token budget"
    }],
    "_tokenEstimate": {
      "estimated": 2847,
      "budget": 4000,
      "method": "character_based"
    }
  }
}
```

#### 9.5.3 Error Specification

**E_MVI_BUDGET_EXCEEDED:**
- **Category:** `VALIDATION`
- **Retryable:** `true`
- **Details:** `estimatedTokens`, `budget`, `excessTokens`, `constraint`

```json
{
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

#### 9.5.4 Token Estimation Algorithm (Normative)

Servers MUST implement this algorithm or equivalent (within +/- 10%):

```
FUNCTION estimate_tokens(value, depth = 0):
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

**Requirements:**
- Count grapheme clusters (not bytes) for unicode
- Enforce max depth of 20
- Handle circular references
- Complete within 10ms for 100KB payloads

---

## 10. Strictness

- Agent surfaces SHOULD default `strict=true`.
- Strict mode violations SHOULD fail with contract/validation error codes.
- Response metadata MUST expose strict mode status.

---

## 11. Versioning and Deprecation

- Protocol versions MUST follow SemVer.
- Minor/patch changes MUST be backward compatible.
- Breaking changes MUST require major version increments.
- Deprecated fields MUST have documented sunset policy.

Versioning and deprecation policies are specified inline in this section. See TSDoc on `src/deprecationRegistry.ts` for the runtime deprecation API.

---

## 12. Conformance

Conforming implementations MUST pass the conformance checks listed below and schema validation for the canonical envelope. See TSDoc on `src/conformance.ts` and `src/conformanceProfiles.ts` for the programmatic conformance API.

### 12.1 Adoption Tiers

LAFS defines three adoption tiers to enable gradual conformance. Each tier builds on the previous tier's requirements. Implementations MUST declare which tier they target and MUST pass all checks required by that tier.

#### 12.1.1 Core Tier

The Core tier represents **minimum viable LAFS adoption**. It verifies that responses use the canonical envelope shape and satisfy basic structural invariants.

Required conformance checks:

| Check | Description |
|---|---|
| `envelope_schema_valid` | Response validates against `schemas/v1/envelope.schema.json` |
| `envelope_invariants` | `success`/`result`/`error` mutual exclusivity holds (Section 6.1) |

Use cases: quick adoption, internal APIs, prototyping, evaluating LAFS fit.

#### 12.1.2 Standard Tier

The Standard tier is **recommended for production** use. It adds semantic checks for error codes, metadata flags, and format defaults on top of all Core tier requirements.

Required conformance checks — all Core checks, plus:

| Check | Description |
|---|---|
| `error_code_registered` | All error codes come from the registered error registry (Section 7) |
| `meta_mvi_present` | `_meta.mvi` flag is present and valid (Section 9.1) |
| `meta_strict_present` | `_meta.strict` flag is present and boolean (Section 10) |
| `json_protocol_default` | JSON is the default output format when no explicit format is requested (Section 5.1) |

Use cases: production APIs, public-facing services, third-party integrations.

#### 12.1.3 Complete Tier

The Complete tier represents **full LAFS compliance**. It adds configuration, flag-handling, and advanced feature checks on top of all Standard tier requirements.

Required conformance checks — all Standard checks, plus:

| Check | Description |
|---|---|
| `config_override_respected` | Project/user config-based format overrides are correctly applied (Section 5.2) |
| `flag_conflict_rejected` | Conflicting format flags (e.g., `--human --json`) are properly rejected with `E_FORMAT_CONFLICT` (Section 5.1) |
| `context_validation` | Context preservation invariants hold for multi-step operations (Section 8) |
| `pagination_validation` | Pagination metadata validates when present (Section 9.3) |

Use cases: official LAFS-conformant implementations, reference implementations, certification.

> **Note:** `context_validation` and `pagination_validation` are reserved check names. Implementations SHOULD treat these as automatically passing until the corresponding conformance runners are available.

---

## 13. Security Considerations

This section addresses security threats relevant to LAFS envelope production and consumption. LAFS is transport-agnostic and does not define its own cryptographic or authentication mechanisms; implementers MUST rely on the underlying transport and application layers for those controls.

### 13.1 Injection attacks

LAFS envelopes carry user-provided data in `result`, `error`, and `details` fields. Implementers MUST sanitize all envelope contents before rendering in HTML, constructing shell commands, or executing in eval-like contexts. Error messages MUST NOT contain unsanitized user input. Implementations that embed envelope values in SQL, LDAP, or similar query languages MUST use parameterized interfaces.

### 13.2 Tampering

LAFS does not define integrity protection at the envelope level. If envelope integrity is required, implementers SHOULD use transport-level security (e.g., TLS) and MAY implement envelope signing as an extension. Consumers MUST NOT trust envelope contents without verifying the transport channel. Implementations that relay envelopes across trust boundaries SHOULD re-validate against `schemas/v1/envelope.schema.json` at each boundary.

### 13.3 Information disclosure

Error details MAY contain sensitive information such as stack traces, internal paths, or database identifiers. Implementations SHOULD distinguish between development and production error detail levels. The `details` field in error objects MUST NOT expose internal system information in production environments. Implementations SHOULD define an explicit allow-list of fields permitted in production error responses.

### 13.4 Replay attacks

LAFS includes `requestId` and `timestamp` in `_meta` for correlation (Section 6). Implementers MAY use these fields for replay detection but MUST NOT rely solely on them, as LAFS does not mandate uniqueness or freshness guarantees for these values. Transport-level replay protection (e.g., TLS with appropriate session management) is RECOMMENDED.

### 13.5 Denial of service

Large envelope payloads could be used for resource exhaustion. Implementations SHOULD enforce maximum envelope size limits appropriate to their deployment context. Pagination (Section 9.3) SHOULD be used to bound response sizes for list operations. Implementations SHOULD reject envelopes that exceed the configured size limit with a structured error.
