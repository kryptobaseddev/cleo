# PLAN-LAFS-RUST: Native Validation Migration

> **Status**: Phase 2 complete, Phase 3 ready  
> **Goal**: Replace AJV schema validation with Rust-native validation via napi-rs  
> **Pattern**: Follow `cant-core` / `cant-napi` established architecture  

---

## Architecture Decision Record

### Problem

`packages/lafs/src/validateEnvelope.ts` uses AJV (ajv + ajv-formats) for JSON Schema
validation of LAFS envelopes. AJV is a large JS dependency (~150KB) loaded via a
`createRequire` CJS hack for ESM compatibility. The schema is loaded from disk at runtime.

### Decision

Create a `crates/lafs-napi/` binding crate (following the `cant-napi` pattern) that:
1. Embeds the JSON Schema at compile time via `include_str!`
2. Uses the `jsonschema` Rust crate for validation
3. Returns **structured errors** matching the existing `StructuredValidationError` shape
4. Is consumed via a `native-loader.ts` with AJV fallback

### Why This Pattern

| Criterion | Decision | Rationale |
|-----------|----------|-----------|
| Crate structure | Separate `lafs-napi` binding crate | Matches `cant-napi` precedent; keeps `lafs-core` usable as pure Rust lib without napi link deps |
| Return type | `#[napi(object)]` structs | Type-safe TS generation, flat struct (no nesting issues) |
| Complex fields | `serde_json::Value` for `params` | With `serde-json` feature, maps directly to JS objects |
| TS integration | `native-loader.ts` + AJV fallback | Graceful degradation when binary unavailable (CI, new devs) |
| types.ts | **KEEP** — not a duplicate | TS consumption SSoT, used by 15+ modules; Rust types are validation SSoT |
| napi versions | Upgrade to stable `napi = "3"`, `napi-derive = "3"` | Alpha versions are 14+ months old; v3 stable since July 2025 |

### What NOT To Do

- **Do NOT annotate `LafsEnvelope` / `LafsMeta` with `#[napi(object)]`** — deeply nested structs with `serde_json::Value`, internally-tagged enums, and `Option<Vec<T>>` create FFI nightmares. Validation operates on raw JSON.
- **Do NOT remove `types.ts`** — it contains type guards, runtime validation sets, and TS-only types (FlagInput, ConformanceReport, BudgetMiddleware, etc.) used across 15+ modules.
- **Do NOT add `@napi-rs/cli` or `napi build` to `packages/lafs`** — the build command runs from the workspace root targeting the Rust crate. The TS package only consumes the output.

---

## Current State (as of 2026-04-06)

### Completed

| Item | Status | Notes |
|------|--------|-------|
| WASM artifacts removed | Done | `packages/contracts/src/wasm/lafs-core/` deleted |
| WASM exports cleaned | Done | `packages/contracts/src/index.ts` updated |
| `lafs-core` Cargo.toml | Done | napi deps added (but wrong versions + wrong crate-type) |
| `build.rs` | Done | `napi_build::setup()` |
| Embedded schema | Done | `include_str!("../../../packages/lafs/schemas/v1/envelope.schema.json")` |
| Rust types (pure) | Done | `LafsEnvelope`, `LafsMeta`, `LafsError`, `LafsPage`, etc. |
| 30 Rust unit tests | Done | All passing — serialization, round-trips, builders |
| jsonschema API fix | Done | Changed `validate()` → `iter_errors()` for multi-error collection |

### Blocked / Needs Rework

| Item | Issue |
|------|-------|
| `lafs-core` crate-type | Currently `["cdylib", "rlib"]` — should be `["rlib"]` only (napi moves to `lafs-napi`) |
| napi versions | Using alpha `3.0.0-alpha.26` — must upgrade to stable `"3"` |
| `validate_envelope` fn | Returns concatenated string, not structured errors |
| `#[napi]` on `lafs-core` | Wrong crate — napi exports belong in dedicated `lafs-napi` binding crate |

---

## Phase Plan

### Phase 1: Separate Binding Crate

**Goal**: Clean architecture — pure Rust lib + thin napi binding.

#### 1a. Clean up `crates/lafs-core/`

Remove all napi dependencies. This crate becomes a pure Rust library.

**`crates/lafs-core/Cargo.toml` changes:**
```toml
[lib]
crate-type = ["rlib"]  # was: ["cdylib", "rlib"]

[dependencies]
chrono = { version = "0.4", features = ["serde"] }
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
uuid = { version = "1.0", features = ["v4"] }
jsonschema = "0.28.3"
# REMOVED: napi, napi-derive

[build-dependencies]
# REMOVED: napi-build
```

**`crates/lafs-core/build.rs`**: Delete (no longer needed).

**`crates/lafs-core/src/lib.rs`**: Remove `#[napi_derive::napi]`, `#[allow(unsafe_code)]`,
and `napi::*` imports. Keep the `validate_envelope` function as a pure Rust function
returning `Result<(), Vec<ValidationErrorDetail>>`.

Add a public structured error type:
```rust
/// A single validation error with structured details.
#[derive(Debug, Clone, Serialize)]
pub struct ValidationErrorDetail {
    /// JSON Pointer path to the failing property (e.g., "/_meta/mvi").
    pub path: String,
    /// JSON Schema keyword that triggered the error (e.g., "required", "pattern").
    pub keyword: String,
    /// Human-readable error message.
    pub message: String,
    /// Keyword-specific parameters as a JSON value.
    pub params: serde_json::Value,
}
```

The pure Rust validation function:
```rust
/// Validate a JSON string against the embedded LAFS envelope schema.
///
/// Returns `Ok(())` on success, or `Err(Vec<ValidationErrorDetail>)` with all errors.
pub fn validate_envelope_json(payload: &str) -> Result<(), Vec<ValidationErrorDetail>> {
    // 1. Parse JSON
    // 2. Compile schema (lazy_static or OnceLock)
    // 3. iter_errors() → map to ValidationErrorDetail
    // 4. Return structured errors
}
```

#### 1b. Create `crates/lafs-napi/`

New crate following the `cant-napi` pattern exactly.

**Directory structure:**
```
crates/lafs-napi/
  Cargo.toml
  build.rs        # napi_build::setup()
  src/
    lib.rs        # #[napi] exports
```

**`crates/lafs-napi/Cargo.toml`:**
```toml
[package]
name = "lafs-napi"
version.workspace = true
edition = "2024"
rust-version = "1.88"
description = "napi-rs bindings for lafs-core schema validation"

[lib]
crate-type = ["cdylib"]

[dependencies]
lafs-core = { path = "../lafs-core" }
napi = { version = "3", features = ["napi4", "serde-json"] }
napi-derive = "3"
serde_json = { workspace = true }

[build-dependencies]
napi-build = "1"

[lints.rustdoc]
broken_intra_doc_links = "warn"
```

**`crates/lafs-napi/src/lib.rs`:**
```rust
#![deny(unsafe_code)]
//! napi-rs bindings for lafs-core schema validation.

use napi_derive::napi;

/// A structured validation error exposed to JavaScript.
#[napi(object)]
pub struct JsValidationError {
    /// JSON Pointer path to the failing property.
    pub path: String,
    /// JSON Schema keyword that triggered the error.
    pub keyword: String,
    /// Human-readable error message.
    pub message: String,
    /// Keyword-specific parameters (JSON object).
    pub params: serde_json::Value,
}

/// Result of validating a LAFS envelope.
#[napi(object)]
pub struct JsValidationResult {
    /// Whether the envelope is valid.
    pub valid: bool,
    /// Flattened human-readable error messages.
    pub errors: Vec<String>,
    /// Structured error objects.
    pub structured_errors: Vec<JsValidationError>,
}

/// Validate a JSON string against the LAFS envelope schema.
#[napi]
pub fn lafs_validate_envelope(payload: String) -> JsValidationResult {
    match lafs_core::validate_envelope_json(&payload) {
        Ok(()) => JsValidationResult {
            valid: true,
            errors: vec![],
            structured_errors: vec![],
        },
        Err(details) => {
            let errors: Vec<String> = details
                .iter()
                .map(|d| format!("{} {}", d.path, d.message).trim().to_string())
                .collect();
            let structured_errors: Vec<JsValidationError> = details
                .into_iter()
                .map(|d| JsValidationError {
                    path: d.path,
                    keyword: d.keyword,
                    message: d.message,
                    params: d.params,
                })
                .collect();
            JsValidationResult {
                valid: false,
                errors,
                structured_errors,
            }
        }
    }
}
```

#### 1c. Register in Cargo workspace

Add `"crates/lafs-napi"` to workspace members in root `Cargo.toml`.

### Phase 2: Structured Error Mapping (Rust)

**Goal**: Map `jsonschema::ValidationErrorKind` → AJV-compatible keyword strings and params.

This is the critical piece. The jsonschema crate returns errors as a `ValidationErrorKind` enum.
We need to map each variant to:
1. A keyword string matching AJV's keyword names
2. A params object matching AJV's params shape

#### Keyword Mapping

| `ValidationErrorKind` variant | AJV keyword string | AJV params shape |
|-------------------------------|-------------------|-----------------|
| `Required { property }` | `"required"` | `{ "missingProperty": <string> }` |
| `Pattern { pattern }` | `"pattern"` | `{ "pattern": <string> }` |
| `Enum { options }` | `"enum"` | `{ "allowedValues": <array> }` |
| `Type { kind }` | `"type"` | `{ "type": <string> }` |
| `Minimum { limit }` | `"minimum"` | `{ "limit": <number>, "comparison": ">=" }` |
| `Maximum { limit }` | `"maximum"` | `{ "limit": <number>, "comparison": "<=" }` |
| `ExclusiveMinimum { limit }` | `"exclusiveMinimum"` | `{ "limit": <number>, "comparison": ">" }` |
| `ExclusiveMaximum { limit }` | `"exclusiveMaximum"` | `{ "limit": <number>, "comparison": "<" }` |
| `MinLength { limit }` | `"minLength"` | `{ "limit": <number> }` |
| `MaxLength { limit }` | `"maxLength"` | `{ "limit": <number> }` |
| `MinItems { limit }` | `"minItems"` | `{ "limit": <number> }` |
| `MaxItems { limit }` | `"maxItems"` | `{ "limit": <number> }` |
| `MinProperties { limit }` | `"minProperties"` | `{ "limit": <number> }` |
| `MaxProperties { limit }` | `"maxProperties"` | `{ "limit": <number> }` |
| `MultipleOf { multiple_of }` | `"multipleOf"` | `{ "multipleOf": <number> }` |
| `Constant { expected_value }` | `"const"` | `{ "allowedValue": <value> }` |
| `Format { format }` | `"format"` | `{ "format": <string> }` |
| `AdditionalProperties { unexpected }` | `"additionalProperties"` | `{ "additionalProperty": <string> }` |
| `AdditionalItems { limit }` | `"additionalItems"` | `{ "limit": <number> }` |
| `UniqueItems` | `"uniqueItems"` | `{}` |
| `Not { schema }` | `"not"` | `{}` |
| `AnyOf` | `"anyOf"` | `{}` |
| `OneOfNotValid` | `"oneOf"` | `{}` |
| `OneOfMultipleValid` | `"oneOf"` | `{}` |
| `Contains` | `"contains"` | `{}` |
| `FalseSchema` | `"false"` | `{}` |
| Other / `Custom` | `"unknown"` | `{}` |

#### Test Contracts (from `structuredValidation.test.ts`)

Tests explicitly verify:
- `keyword === 'pattern'` for pattern violations
- `keyword === 'required'` for missing required fields
- `keyword === 'enum'` for enum violations
- `params.pattern` is a string for pattern errors
- `structuredErrors.length === errors.length` (parity)
- Each error has `path: string`, `keyword: string`, `message: string`

#### Schema Path Extraction

`jsonschema::ValidationError` provides:
- `instance_path: Location` — JSON Pointer to the failing VALUE (e.g., `/_meta/mvi`)
- `schema_path: Location` — JSON Pointer to the failing SCHEMA keyword
- `kind: ValidationErrorKind` — the enum variant
- `instance: Cow<Value>` — the actual failing value

`Location.as_str()` returns the JSON Pointer string directly. Empty string means root.
Map empty string to `"/"` for AJV compatibility.

#### Schema Compilation Caching

Use `std::sync::OnceLock` to compile the schema exactly once:

```rust
use std::sync::OnceLock;

static COMPILED_SCHEMA: OnceLock<jsonschema::Validator> = OnceLock::new();

fn get_validator() -> &'static jsonschema::Validator {
    COMPILED_SCHEMA.get_or_init(|| {
        let schema: serde_json::Value = serde_json::from_str(LAFS_ENVELOPE_SCHEMA)
            .expect("embedded schema is valid JSON");
        jsonschema::validator_for(&schema)
            .expect("embedded schema compiles")
    })
}
```

### Phase 3: TypeScript Integration

**Goal**: Wire native binding into `packages/lafs` with AJV fallback.

#### 3a. Create `packages/lafs/src/native-loader.ts`

Follow the `packages/cant/src/native-loader.ts` pattern:

```typescript
import { createRequire } from 'node:module';

interface LafsNativeModule {
  lafsValidateEnvelope(payload: string): {
    valid: boolean;
    errors: string[];
    structuredErrors: Array<{
      path: string;
      keyword: string;
      message: string;
      params: Record<string, unknown>;
    }>;
  };
}

let nativeModule: LafsNativeModule | null = null;
let loadAttempted = false;

function ensureLoaded(): void {
  if (loadAttempted) return;
  loadAttempted = true;
  const require = createRequire(import.meta.url);
  try {
    nativeModule = require('@cleocode/lafs-native') as LafsNativeModule;
  } catch {
    try {
      nativeModule = require('../../crates/lafs-napi') as LafsNativeModule;
    } catch {
      nativeModule = null;
    }
  }
}

export function isNativeAvailable(): boolean {
  ensureLoaded();
  return nativeModule !== null;
}

export function getNativeModule(): LafsNativeModule | null {
  ensureLoaded();
  return nativeModule;
}
```

#### 3b. Modify `packages/lafs/src/validateEnvelope.ts`

Add native-first validation with AJV fallback:

```typescript
import { getNativeModule } from './native-loader.js';
// ... existing AJV imports stay as fallback ...

export function validateEnvelope(input: unknown): EnvelopeValidationResult {
  const native = getNativeModule();
  if (native) {
    // Native path: serialize → validate in Rust → deserialize result
    const payload = JSON.stringify(input);
    const result = native.lafsValidateEnvelope(payload);
    return {
      valid: result.valid,
      errors: result.errors,
      structuredErrors: result.structuredErrors.map((se) => ({
        path: se.path,
        keyword: se.keyword,
        message: se.message,
        params: se.params,
      })),
    };
  }

  // AJV fallback (existing code, unchanged)
  const valid = validate(input);
  // ... rest of existing implementation ...
}
```

#### 3c. Build Script

Add to the repo root or `packages/lafs/package.json`:

```json
{
  "scripts": {
    "build:native": "cd ../../crates/lafs-napi && cargo build --release",
    "build": "rm -rf dist && tsc -p tsconfig.build.json"
  }
}
```

The native build is intentionally **separate** from the TS build. It is NOT a hard
prerequisite — the AJV fallback ensures everything works without Rust.

### Phase 4: Verification

#### 4a. Rust Tests

```bash
# Pure Rust validation tests in lafs-core
cargo test -p lafs-core

# Binding smoke tests in lafs-napi (if we add any)
cargo test -p lafs-napi
```

#### 4b. TypeScript Tests

```bash
# Full test suite — all 20 test files must pass
cd packages/lafs && pnpm run test

# Critical tests for this migration:
pnpm exec vitest run tests/structuredValidation.test.ts
pnpm exec vitest run tests/envelope.test.ts
pnpm exec vitest run tests/compliance.test.ts
```

#### 4c. Quality Gates

```bash
pnpm biome check --write .
pnpm run build
pnpm run test
```

### Phase 5: AJV Removal (Future — Only After Full Parity Verified)

Once the native binding is stable and tested in production:

1. Remove `ajv` and `ajv-formats` from `packages/lafs/package.json`
2. Remove the AJV fallback code from `validateEnvelope.ts`
3. Make the native binding a hard requirement
4. Remove `native-loader.ts` — import directly

**This is a separate PR**. Do not bundle with the initial migration.

---

## Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| jsonschema crate produces different errors than AJV | Medium | Keyword mapping + params mapping; run full test suite to catch discrepancies |
| `if/then/else` conditional schema behavior differs | Medium | The envelope schema uses `if/then/else` for strict mode and pagination; test thoroughly |
| Native binary not available on all platforms | Low | AJV fallback guarantees functionality; native is optional |
| napi-rs `serde_json::Value` interop | Low | Already proven in `cant-napi` (`JsParseDocumentResult.document` uses it) |
| `allErrors` mode difference | Medium | AJV uses `allErrors: true`; jsonschema `iter_errors()` collects all; verify parity |

---

## Out of Scope

- Removing `types.ts` (it is NOT a duplicate — it's the TS consumption SSoT)
- Adding `#[napi(object)]` to `LafsEnvelope` / `LafsMeta` / `LafsError` (deeply nested; use JSON serialization)
- Multi-platform binary distribution via `optionalDependencies` (not needed for internal use)
- Publishing `@cleocode/lafs-native` to npm (future, after stabilization)
- Replacing any validation logic beyond `validateEnvelope()` (conformance checks stay in TS)

---

## File Change Summary

### New Files

| File | Purpose |
|------|---------|
| `crates/lafs-napi/Cargo.toml` | Binding crate manifest |
| `crates/lafs-napi/build.rs` | `napi_build::setup()` |
| `crates/lafs-napi/src/lib.rs` | `#[napi]` exports with `JsValidationResult` |
| `packages/lafs/src/native-loader.ts` | Native addon loader with fallback |

### Modified Files

| File | Change |
|------|--------|
| `Cargo.toml` (workspace root) | Add `"crates/lafs-napi"` to members |
| `crates/lafs-core/Cargo.toml` | Remove napi deps, change crate-type to `["rlib"]` |
| `crates/lafs-core/src/lib.rs` | Remove `#[napi]`, add `ValidationErrorDetail`, refactor `validate_envelope_json()` |
| `packages/lafs/src/validateEnvelope.ts` | Add native-first path with AJV fallback |
| `packages/lafs/src/index.ts` | Export native loader utilities |

### Deleted Files

| File | Reason |
|------|--------|
| `crates/lafs-core/build.rs` | No longer needed (napi-build moves to lafs-napi) |

---

## Implementation Order

```
Phase 1a: Clean lafs-core (remove napi, add ValidationErrorDetail, refactor validation)
Phase 1b: Create lafs-napi (new crate, #[napi] exports)
Phase 1c: Register in workspace
Phase 2:  Keyword/params mapping (the hard part — match ValidationErrorKind exhaustively)
Phase 3a: Create native-loader.ts
Phase 3b: Modify validateEnvelope.ts (native-first + AJV fallback)
Phase 4:  Run full test suite, fix any discrepancies
Phase 5:  (Future PR) Remove AJV after production validation
```

Estimated effort: **medium** (well-defined mapping, established pattern, clear test contracts).
