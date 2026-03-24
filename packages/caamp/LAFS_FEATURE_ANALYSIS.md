# LAFS Feature Analysis

## Executive Summary

**Verdict: Most proposed additions should be REJECTED or relegated to IMPLEMENTATION_DETAIL.**

The proposed features represent a fundamental misunderstanding of LAFS's purpose. LAFS is **not** a presentation layer protocol—it's a **response envelope contract** for machine consumption. Six format types, execution profiling data, and TTY detection all violate core design principles.

**Key Findings:**
- **Format types**: Only `json` and `human` are justified. The other four are presentation concerns, not protocol concerns.
- **Envelope fields**: Only `session` and `warnings` belong in the core protocol. The rest are debugging/implementation details.
- **Flag features**: `--quiet` is justified. Multiple format values and TTY detection violate MVI and transport agnosticism.

**Bottom Line**: LAFS should remain lean. Feature bloat transforms it from a focused envelope contract into an unwieldy meta-protocol that competes with its own design principles.

---

## Format Types Analysis

### Current: json | human

**Status: SUFFICIENT**

These two formats align perfectly with LAFS design principles:

| Format | Purpose | MVI Alignment |
|--------|---------|---------------|
| `json` | Machine-parseable, deterministic, schema-validated | ✅ Default - zero ambiguity |
| `human` | Human-readable with colors, formatting, visual cues | ✅ Explicit opt-in only |

The dichotomy is intentional: **machine-first, human-opt-in**. This separation is clean, testable, and transport-agnostic.

---

### Proposed: text

- **Recommendation**: **REJECT**
- **Justification**: 
  - **Violates MVI principle**: What problem does `text` solve that `human` doesn't? The distinction is semantic noise.
  - **Violates Progressive Disclosure**: If `text` means "plain text without formatting," that's just `human` without colors. That's a rendering concern, not a format concern.
  - **Schema complexity**: Adding a third format doubles the testing matrix (json↔text, json↔human, text↔human) for zero functional gain.
- **Use Case**: None that isn't already covered by `human` with `--no-color` or environment detection.
- **Alternative**: Implement as `--human --no-color` or `NO_COLOR=1` environment variable in CAAMP's implementation. Not a LAFS protocol concern.

**Critical Question**: If a user wants "plain text output," do they mean:
1. Machine-parseable structured data? → Use `json`
2. Human-readable without ANSI codes? → Use `human` with color suppression

There is no third category. `text` is a false distinction.

---

### Proposed: markdown

- **Recommendation**: **REJECT** (or IMPLEMENTATION_DETAIL at best)
- **Justification**:
  - **Violates Transport Agnosticism**: Markdown assumes a text-pipe consumer. LAFS envelopes may travel over HTTP, gRPC, or message queues where Markdown is meaningless.
  - **Violates MVI**: Markdown is verbose. Headers, bullet points, and formatting add bytes without adding data.
  - **Ambiguous semantics**: Is the Markdown wrapping the JSON envelope? Or replacing it? If replacing it, the envelope structure is lost. If wrapping it, it's redundant.
- **Use Case**: "I want LLM-readable output" → LLMs parse JSON better than Markdown.
- **Alternative**: 
  - If the goal is human-readable docs: Generate Markdown from JSON via a post-processor.
  - If the goal is LLM-friendly: JSON is already optimal. Use `_fields` and `_expand` for progressive disclosure.
  - If absolutely required: Implement as an `_extension` field: `_extensions: { "x-caamp-output-md": "..." }`

**The Markdown Fallacy**: Markdown is a *presentation* format for humans reading in a text editor or rendered HTML. LAFS targets *agents* consuming structured data. These are incompatible goals.

---

### Proposed: table

- **Recommendation**: **REJECT** (presentation concern)
- **Justification**:
  - **Violates MVI**: ASCII/Unicode tables add massive padding (spaces, borders, newlines) for visual alignment.
  - **Violates Data Structure Concerns**: "Table" describes how data should look, not what it is. The underlying data is still an array of objects—that's `json` format.
  - **Fragile across transports**: Tabular formatting breaks when piped, copied, or displayed in variable-width contexts.
- **Use Case**: "I want to quickly scan results in a terminal" → This is a valid use case, but it's a **consumer-side rendering** concern.
- **Alternative**: 
  - Implement as CAAMP-specific wrapper: `caamp skills list | caamp-fmt table`
  - Use existing CLI tools: `caamp skills list | jq -r '.result.skills[] | "\(.name)\t\(.version)"' | column -t`
  - Or simply: use `human` format which may choose to render lists as tables when appropriate

**Schema Violation**: Tables don't fit the LAFS envelope structure. Where does `$schema` go in an ASCII table?

---

### Proposed: jsonl

- **Recommendation**: **REJECT** (transport concern, not envelope concern)
- **Justification**:
  - **Violates Transport Agnosticism**: JSON Lines is specifically designed for streaming log processing and line-based Unix tools. LAFS explicitly excludes streaming from scope (Section 2 Non-Goals: "Streaming mechanisms such as SSE or WebSocket are transport concerns").
  - **Violates Envelope Invariants**: LAFS Section 6.1 requires exactly one envelope per response. JSONL implies multiple independent JSON objects—no envelope wrapper.
  - **Schema validation becomes impossible**: You can't validate a JSONL stream against `envelope.schema.json` because each line is a partial envelope without `_meta` context.
- **Use Case**: "Streaming large datasets" → LAFS explicitly excludes streaming.
- **Alternative**: 
  - If streaming is needed: Use a transport-level streaming protocol (SSE, WebSocket) where each message IS a complete LAFS envelope.
  - If line-based processing is needed: Use `jq` to extract fields: `caamp skills list | jq -c '.result.skills[]'`

**Critical Point**: JSONL and LAFS are philosophically incompatible. LAFS envelopes are **discrete response contracts** (Section 2). JSONL is a **streaming serialization format**. Pick one.

---

## Envelope Fields Analysis

### executionMs

- **Recommendation**: **PROGRESSIVE_DISCLOSURE** (via `_extensions`)
- **Justification**:
  - **Violates MVI**: Profiling data is debugging information. It's not required for the agent to function.
  - **Not Universal**: Execution time is meaningless for cached responses, async operations, or streaming partials.
  - **Timing attacks**: Exposing precise execution times could leak sensitive information about backend implementation.
- **Use Case**: Performance profiling during development or optimization.
- **Alternative**: 
  - Add to `_extensions`: `_extensions: { "x-caamp-timing": { "executionMs": 42 } }`
  - Request via `_fields` parameter: `?executionMs` could trigger inclusion
  - Implement as separate profiling endpoint: `GET /_debug/timing/{requestId}`

**Protocol Boundary**: Profiling is observability. Observability is not the envelope's concern. It's a cross-cutting concern best handled by tracing middleware.

---

### checksum

- **Recommendation**: **REJECT** (TLS covers this)
- **Justification**:
  - **Violates Transport Agnosticism**: Data integrity is already guaranteed by TLS in 99.9% of deployments.
  - **Violates MVI**: Checksums add bytes to every response for theoretical integrity verification.
  - **Circular dependency**: To verify the checksum, you must trust the checksum value—but if the transport is compromised, the checksum could be tampered with too.
  - **Schema validation is the integrity check**: If the JSON parses and validates against the schema, it's intact.
- **Use Case**: "I need to verify response hasn't been corrupted" → TLS + JSON parse success + schema validation.
- **Alternative**: 
  - If end-to-end integrity is needed beyond TLS: Use signed envelopes with JWS (JSON Web Signature) in `_extensions`.
  - If audit trail is needed: Include `requestId` and verify server-side logs.

**LAFS Security Considerations (Section 13.2)**: "LAFS does not define integrity protection at the envelope level. If envelope integrity is required, implementers SHOULD use transport-level security (e.g., TLS)."

---

### source

- **Recommendation**: **REJECT** (version metadata bloat)
- **Justification**:
  - **Violates MVI**: Version metadata (git refs, build hashes, deployment IDs) can be huge. Including it in every response is wasteful.
  - **Unbounded size**: Git refs can be 40-character SHAs. Build metadata could be KBs. This violates MVI's lean default.
  - **Already in `_meta`**: `_meta.specVersion` and `_meta.schemaVersion` exist. What additional "source" is needed?
- **Use Case**: "I need to know which version of the service handled this request" → Use `_meta.specVersion`.
- **Alternative**: 
  - If detailed source info is needed: Separate metadata endpoint: `GET /_meta/version`
  - Add to `_extensions`: `_extensions: { "x-caamp-source": "git:abc123" }`
  - Include in request debugging: Server logs, not response envelope.

**The "Source" Ambiguity**: Does `source` mean:
- Code version? → Already in `_meta`
- Server instance? → Infrastructure concern, not protocol concern
- Git repository? → Varies by deployment; breaks hermetic builds

Too vague. Too big. Not MVI.

---

### session

- **Recommendation**: **ACCEPT WITH MODIFICATION**
- **Justification**:
  - **Aligns with Context Preservation (Section 8)**: LAFS already requires context preservation across multi-step operations.
  - **Necessary for stateful workflows**: Agents need to correlate requests in a session.
  - **Bounded and deterministic**: Session IDs have predictable formats (UUIDs, tokens).
- **Use Case**: Multi-step operations where the agent needs to maintain state across commands.
- **Alternative**: None—this belongs in core protocol.
- **Proposed Location**: `_meta.sessionId` (not top-level `session`).
- **Schema Addition**:
  ```json
  {
    "_meta": {
      "sessionId": "sess_abc123xyz",
      "contextVersion": 5,
      "ledgerId": "ledger_def456"
    }
  }
  ```

**Already Partially Covered**: `_meta.contextVersion` exists. Adding `sessionId` and `ledgerId` completes the Context Preservation requirement.

---

### warnings

- **Recommendation**: **ACCEPT** (fills a gap)
- **Justification**:
  - **Fills a critical gap**: LAFS has `error` for failures, but no mechanism for soft warnings (e.g., deprecated fields used, partial success, non-fatal issues).
  - **Maintains success=true**: Warnings don't fail the operation, but inform the agent of issues.
  - **Bounded and structured**: Array of warning objects with code/message (similar to errors).
- **Use Case**: 
  - "Request succeeded but you used a deprecated field"
  - "Partial results returned due to permission filtering"
  - "Rate limit approaching"
- **Alternative**: None—this is a justified addition.
- **Proposed Schema**:
  ```json
  {
    "_meta": {
      "warnings": [
        {
          "code": "W_DEPRECATED_FIELD",
          "message": "Field 'legacyId' is deprecated, use 'id'",
          "severity": "warning"
        }
      ]
    }
  }
  ```

**Critical Distinction**: Warnings (W_*) vs Errors (E_*). Warnings don't prevent success.

---

### filters

- **Recommendation**: **REJECT** (debug info)
- **Justification**:
  - **Violates MVI**: Returning the filters applied is just echoing the request. The agent already knows what it sent.
  - **Violates Progressive Disclosure**: If the agent needs confirmation of filters, it can request them via `_fields` in the result.
  - **Not actionable**: Knowing "filters were applied" doesn't change agent behavior.
- **Use Case**: "I want to verify my filters were respected" → Schema validation + result inspection.
- **Alternative**: 
  - Include filter info in `result` when explicitly requested via `_fields`.
  - Implement as `_extensions`: `_extensions: { "x-caamp-applied-filters": [...] }`
  - Use request/response logging for debugging.

**The Echo Problem**: Echoing request parameters in the response is an anti-pattern. It doubles payload size for zero benefit to a stateful agent.

---

### summary

- **Recommendation**: **REJECT** (redundant with result)
- **Justification**:
  - **Violates MVI**: A summary is derived data. Derived data is not minimal.
  - **Ambiguous semantics**: What goes in `summary` vs `result`? Who decides? This creates protocol confusion.
  - **Agent can compute summaries**: Agents are LLMs. They can summarize `result` content if needed.
- **Use Case**: "I want a quick overview without parsing the full result" → Use `_fields` to request only summary fields.
- **Alternative**: 
  - Use `_fields` parameter to limit response to summary fields: `?include=summary`
  - Use `_expand` with summary mode if applicable.
  - Client-side summarization.

**Schema Redundancy**: If `result` contains `{ count: 50, items: [...] }`, what would `summary` add? `{ total: 50 }`? That's already in `result`.

---

## Flag Features Analysis

### --quiet

- **Recommendation**: **ACCEPT**
- **Justification**:
  - **Aligns with MVI**: Suppressing non-essential output (progress bars, informational messages) is the essence of MVI.
  - **Useful for scripting**: Piped workflows need clean stdout/stderr.
  - **Well-defined semantics**: "Only output errors and essential results."
- **Use Case**: 
  - CI/CD pipelines that only care about exit codes
  - Scripts parsing stdout that don't want progress messages
- **Alternative**: None—this is a justified addition.
- **Implementation**: 
  - Suppress `console.log()` for informational messages
  - Still output LAFS envelope to stdout (if `--json`) or essential result (if `--human`)
  - Still output errors to stderr

---

### --format multiple values

- **Recommendation**: **REJECT** (payload bloat)
- **Justification**:
  - **Violates MVI**: Why would one response need multiple formats? The consumer needs ONE representation.
  - **Payload explosion**: `{ json: {...}, human: "...", markdown: "..." }` triples response size.
  - **Violates Progressive Disclosure**: If the agent wants multiple formats, it can make multiple requests.
  - **Schema violation**: LAFS envelope has single `result` field. Multiple formats would require schema changes.
- **Use Case**: "I want to let the consumer choose" → Consumer should specify format in request, not receive all formats.
- **Alternative**: 
  - Client makes multiple requests with different format parameters.
  - Server-side content negotiation via `Accept` header (HTTP) or `--format` (CLI).

**The False Optimization**: Multiple formats in one response seems convenient but optimizes for the wrong thing. It optimizes for "fewer requests" instead of "lean responses." LAFS optimizes for lean.

---

### TTY auto-detection

- **Recommendation**: **REJECT** (violates transport agnosticism)
- **Justification**:
  - **Violates Transport Agnosticism**: TTY detection is Unix-specific. LAFS envelopes may travel over HTTP (no TTY), gRPC (no TTY), or message queues (no TTY).
  - **Implicit behavior violates explicit contract**: LAFS Section 5.1: "Human-readable mode MUST be explicit opt-in." TTY detection makes human mode implicit when a TTY is detected.
  - **Non-deterministic**: Same command produces different output based on execution context. This breaks reproducibility.
  - **Already handled by `--human`**: If a human is running the command, they can explicitly pass `--human`.
- **Use Case**: "I want automatic color/formatting when running interactively" → Use shell aliases or wrapper scripts.
- **Alternative**: 
  - Environment variable: `CAAMP_HUMAN=1` in `.bashrc`
  - Shell alias: `alias caamp='caamp --human'`
  - Project config: Set `defaultFormat: "human"` for interactive projects

**LAFS Non-Negotiable Rule #2**: "Human-readable mode MUST be explicit opt-in." TTY detection is implicit behavior. Forbidden.

---

## Format Definitions (Precise Semantics)

### json
**Definition**: Machine-readable LAFS envelope conforming to `schemas/v1/envelope.schema.json`
**When to use**: Default for all programmatic consumption, piping, testing, agent consumption
**Output**: Valid JSON object with `$schema`, `_meta`, `success`, `result`, `error`, `page` fields
**Example**:
```json
{
  "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
  "_meta": { "specVersion": "1.0.0", "timestamp": "2026-02-18T00:00:00Z", ... },
  "success": true,
  "result": { "data": "..." },
  "error": null,
  "page": null
}
```

### human
**Definition**: Human-readable formatted output optimized for terminal display
**When to use**: Interactive terminal sessions where a human is reading the output
**Output**: May use colors (unless `NO_COLOR` is set), tables, headers, icons, and other visual formatting
**Constraints**: 
- Must NOT be default (explicit `--human` flag required)
- Should still be pipeable (no interactive prompts mixed with output)
- May omit envelope structure if clearly documented as "human-only"

---

### text (REJECTED)
**Definition**: Undefined—ambiguous overlap with `human`
**Why rejected**: Distinction between "text" and "human" is arbitrary. Both are human-readable text formats.
**Recommendation**: Use `human` with `--no-color` or `NO_COLOR=1`

### markdown (REJECTED)
**Definition**: Markdown-formatted text
**Why rejected**: Presentation format, not data format. Assumes text-pipe transport.
**Recommendation**: Generate Markdown from JSON via post-processor if needed

### table (REJECTED)
**Definition**: ASCII/Unicode tabular formatting
**Why rejected**: Presentation concern, not data concern. Doesn't fit envelope structure.
**Recommendation**: Use `human` format which may render as table, or post-process JSON

### jsonl (REJECTED)
**Definition**: JSON Lines format (newline-delimited JSON objects)
**Why rejected**: Streaming format incompatible with LAFS's discrete envelope contract.
**Recommendation**: Use streaming transport where each message is a complete LAFS envelope

---

## Recommendations for CAAMP

Given this analysis, CAAMP should:

### 1. Reject Format Expansion
**Keep only**: `json` (default) and `human` (explicit opt-in)

**Action items**:
- Do NOT implement `text`, `markdown`, `table`, or `jsonl` format types
- Do NOT accept multiple `--format` values
- Document that `human` format may support `--no-color` or respect `NO_COLOR` environment variable

### 2. Use `_extensions` for Debugging/Profiling Data
**Move to `_extensions`**:
- `executionMs` → `_extensions["x-caamp-timing"]`
- `source` → `_extensions["x-caamp-source"]`
- `filters` → `_extensions["x-caamp-filters"]`

**Benefits**:
- Keeps core envelope lean (MVI)
- Allows optional inclusion via request parameters
- Vendor-namespaced (won't conflict with future LAFS spec)

### 3. Implement `warnings` in `_meta`
**Add to CAAMP's LAFS implementation**:
```typescript
_meta: {
  // ... existing fields
  warnings: [
    {
      code: "W_DEPRECATED",
      message: "...",
      severity: "warning"
    }
  ]
}
```

**Use cases**:
- Deprecated field usage
- Partial success scenarios
- Rate limit approaching (soft warning before hard `RATE_LIMIT` error)

### 4. Implement `sessionId` in `_meta`
**Add to support Context Preservation**:
```typescript
_meta: {
  // ... existing fields
  sessionId: "sess_abc123",
  contextVersion: 5,
  ledgerId: "ledger_def456"
}
```

**Aligns with LAFS Section 8**: Context Preservation for multi-step operations.

### 5. Reject TTY Auto-Detection
**Do NOT implement**: Automatic format switching based on TTY detection

**Reason**: Violates LAFS Non-Negotiable Rule #2: "Human-readable mode MUST be explicit opt-in."

**Alternative for users**:
- Document shell alias: `alias caamp='caamp --human'`
- Support `CAAMP_DEFAULT_FORMAT=human` environment variable
- Project-level config: `.caamp/config.json` with `"defaultFormat": "human"`

### 6. Implement `--quiet` Flag
**Add to all CAAMP commands**:
- Suppress informational/progress output
- Still output LAFS envelope (if `--json`) or essential result (if `--human`)
- Still output errors

### 7. Keep Checksums at Transport Layer
**Do NOT implement**: Envelope-level checksums

**Reason**: TLS provides integrity. JSON parse + schema validation provides structural integrity.

**If needed for audit**: Use `requestId` and server-side logging.

### 8. Document Rejection Rationale
**Add to CAAMP's LAFS compliance docs**:
- Explain why CAAMP doesn't support `text`, `markdown`, `table`, `jsonl`
- Reference this analysis document
- Show alternatives (post-processors, `_extensions`, etc.)

---

## Conclusion

The proposed LAFS additions represent **feature creep** that would compromise the protocol's core strengths. LAFS succeeds because it's **focused**: machine-first JSON envelopes with optional human-readable mode. Every addition must justify itself against:

1. **MVI**: Does the agent need this to function?
2. **Progressive Disclosure**: Can this be opt-in rather than default?
3. **Transport Agnosticism**: Does this assume a specific transport mechanism?
4. **Schema-First**: Can this be validated and remain deterministic?

Most proposed additions fail one or more of these tests. They should be **rejected** or implemented as **CAAMP-specific extensions** (via `_extensions`) rather than protocol-level changes.

**The LAFS agent is right to push back.** A lean, focused protocol beats a bloated meta-protocol every time.

---

## Appendix: Decision Matrix

| Feature | Recommendation | Principle Violated | Justification |
|---------|---------------|-------------------|---------------|
| `text` format | ❌ REJECT | MVI, Ambiguity | Indistinguishable from `human` |
| `markdown` format | ❌ REJECT | Transport Agnosticism | Presentation concern |
| `table` format | ❌ REJECT | MVI, Data Structure | Rendering concern |
| `jsonl` format | ❌ REJECT | Transport Agnosticism | Streaming vs discrete conflict |
| `executionMs` | 🔶 PROGRESSIVE_DISCLOSURE | MVI | Debugging info → `_extensions` |
| `checksum` | ❌ REJECT | Transport Agnosticism | TLS already covers this |
| `source` | ❌ REJECT | MVI | Version metadata bloat |
| `session` | ✅ ACCEPT | Context Preservation | Justified, Section 8 alignment |
| `warnings` | ✅ ACCEPT | Fills Gap | Soft errors needed |
| `filters` | ❌ REJECT | MVI | Echoes request params |
| `summary` | ❌ REJECT | MVI, Redundancy | Derived data, use `_fields` |
| `--quiet` | ✅ ACCEPT | MVI Alignment | Useful for scripting |
| `--format multiple` | ❌ REJECT | MVI, Payload Bloat | One format per request |
| TTY auto-detection | ❌ REJECT | Explicit Opt-in Rule | Violates Non-Negotiable Rule #2 |

**Summary**: 10 REJECT, 2 ACCEPT, 2 PROGRESSIVE_DISCLOSURE

**The ratio speaks for itself.**
