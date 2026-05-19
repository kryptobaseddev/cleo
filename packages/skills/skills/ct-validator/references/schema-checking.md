# Schema Checking

Deeper guidance for Schema Validation mode (Mode 1 from
`validation-modes.md`). Schema checking is the most mechanical of the
four modes — but only if the inputs are correctly configured. This
reference covers the configuration pitfalls and tool-selection rules.

## Pick the Right Engine

| Engine | Strength | When to use |
|--------|----------|-------------|
| AJV (`ajv-cli`) | Fast; draft-07 / 2019-09 / 2020-12 | Generic JSON Schema validation |
| Zod | Type-safe; integrates with TypeScript | Project-internal data validation |
| drizzle-orm/zod | Schema → Zod auto-generation | Drizzle ORM consumers |
| jsonschema (Python) | Cross-language; same draft support | Python-side validation |
| `cargo schema` / serde | Type-safe; Rust-side | Rust crates |

The CLEO repo's primary engine is Zod (via `@cleocode/contracts`) — most
internal schemas are exported as Zod schemas with optional drizzle
codegen. Use Zod's `safeParse` to get structured errors.

For external contracts (LAFS envelope spec, JSON-RPC requests from
non-CLEO clients), use AJV or jsonschema for cross-language portability.

## Draft Selection

Always state the draft explicitly. Draft-07 and draft-2020-12 have
incompatible semantics around `$ref`, `if/then/else`, and tuple arrays.

| Draft | Best for | Caveats |
|-------|----------|---------|
| draft-04 | Legacy | `id` not `$id`; many engines deprecated this |
| draft-07 | Industry standard | Most engines support fully |
| draft-2019-09 | New work, conservative | `$defs` replaces `definitions` |
| draft-2020-12 | New work, full | Some engines lag |

CLEO contracts target draft-07 unless the schema needs 2020-12-only
features (typically `prefixItems` for tuple arrays). Add the explicit
`"$schema"` field on every published schema:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "TaskEnvelope",
  "type": "object",
  "required": ["success", "meta"],
  ...
}
```

## The Standard Validation Loop

```bash
# 1. Choose engine; choose draft
ENGINE=ajv
DRAFT=draft-07

# 2. Resolve schema file (must include $schema or pass --spec)
SCHEMA=packages/contracts/schemas/envelope.json

# 3. Iterate over data files
for DATA in path/to/*.json; do
  echo "=== $DATA ==="
  npx ajv validate -s "$SCHEMA" -d "$DATA" --spec=$DRAFT --all-errors
done

# 4. Aggregate by file in the report
```

The `--all-errors` flag (AJV) or `--exhaustive` (Zod's `safeParse` does
this by default) is essential — the spec ground rule is "report every
violation", not "stop at the first one".

## Pitfalls

### 1. $ref Resolution Failure

**Symptom.** Validator complains "could not resolve $ref" or "unknown
keyword $ref".

**Cause.** Schema references another file by relative path; the engine
does not know the base directory.

**Fix.** Pass `--ref` (AJV) pointing at the referenced files, or inline
the references with `$defs`. For multi-file schemas, use AJV's
`addSchema()` API or a bundler step that flattens before validation.

### 2. Implicit Type Coercion

**Symptom.** A string `"123"` validates against `{"type": "number"}`.

**Cause.** Engine has coercion enabled (`coerceTypes: true` in AJV).

**Fix.** Disable coercion for strict validation:

```javascript
new Ajv({ coerceTypes: false, strict: true, allErrors: true })
```

CLEO contracts are strict by default — incoming data must already be
typed correctly.

### 3. Missing required not flagged

**Symptom.** A required field is missing; schema says it's required;
validator passes.

**Cause.** The schema's `required` is at the wrong level (nested vs
top), or the validator is in non-strict mode.

**Fix.** Re-check the schema structure. `required` must be a peer of
`properties` at the same nesting level.

### 4. Additional Properties Silently Allowed

**Symptom.** Data has extra fields not in the schema; validator passes.

**Cause.** Schema does not specify `additionalProperties: false`.

**Fix.** CLEO contracts default to `additionalProperties: false` — extra
fields indicate either drift in the producer or a malicious payload.
Override only with an inline justification.

## Reporting Schema Violations

Each violation goes in the report as:

```markdown
### Violations

| Path | Keyword | Actual | Expected | File |
|------|---------|--------|----------|------|
| `/data/items/3/id` | required | (absent) | string | manifest-instance.json |
| `/data/version` | type | "1.2.3" (string) | number | manifest-instance.json |
| `/meta/timestamp` | format | "today" | date-time | manifest-instance.json |
| `/error.code` | enum | "E_WUT" | one of [E_NOT_FOUND, E_VALIDATION, ...] | response.json |
```

The Path column uses JSON Pointer (RFC 6901). The Keyword column names
the schema constraint violated. Actual + Expected gives the diff
needed to fix.

## Bulk Schema Validation

When validating many instances (e.g., every manifest file in
`.cleo/agent-outputs/`), produce a summary table first, then drill
into failures.

```markdown
## Summary

- **Files validated**: 47
- **Pass**: 42
- **Fail**: 5
- **Compliance**: 89.4%

## Failed Files

| File | Violations |
|------|-----------|
| `.cleo/agent-outputs/2026-05-19_old.md` | 3 |
| `.cleo/agent-outputs/2026-05-19_draft.md` | 1 |
| ... | ... |

## Detail (per-file)

### `.cleo/agent-outputs/2026-05-19_old.md`

| Path | Keyword | Actual | Expected |
|------|---------|--------|----------|
| ... | ... | ... | ... |
```

Bulk reports SHOULD be machine-readable. Emit a sibling JSON report
under the same name when the consumer is automation.

## Self-Test the Schema

Before trusting any schema for validation, verify it accepts known-good
instances and rejects known-bad instances. Maintain a `fixtures/`
directory next to the schema:

```text
packages/contracts/schemas/envelope.json
packages/contracts/schemas/fixtures/envelope-valid.json
packages/contracts/schemas/fixtures/envelope-missing-success.json
packages/contracts/schemas/fixtures/envelope-wrong-type.json
```

A test that exercises all three confirms the schema does what it
claims. Without fixtures, schema drift goes undetected.
