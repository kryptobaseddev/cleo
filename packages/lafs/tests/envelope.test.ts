import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  getTransportMapping,
  isRegisteredErrorCode,
  runEnvelopeConformance,
  validateEnvelope,
} from "../src/index.js";

function load(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

describe("LAFS envelope", () => {
  it("accepts valid success envelope", () => {
    const envelope = load("fixtures/valid-success-envelope.json");
    const result = validateEnvelope(envelope);
    expect(result.valid).toBe(true);
  });

  it("rejects invariant-violating envelope", () => {
    const envelope = load("fixtures/invalid-conflict-envelope.json");
    const report = runEnvelopeConformance(envelope);
    expect(report.ok).toBe(false);
    expect(report.checks.some((check) => check.name === "envelope_schema_valid" && !check.pass)).toBe(true);
  });

  it("accepts success envelope without page field (T035)", () => {
    const envelope = load("fixtures/valid-success-no-page.json");
    const result = validateEnvelope(envelope);
    expect(result.valid).toBe(true);

    const report = runEnvelopeConformance(envelope);
    expect(report.ok).toBe(true);
    expect(report.checks.every((check) => check.pass)).toBe(true);
  });

  it("accepts success envelope without error field (T036)", () => {
    const envelope = load("fixtures/valid-success-no-error.json");
    const result = validateEnvelope(envelope);
    expect(result.valid).toBe(true);

    const report = runEnvelopeConformance(envelope);
    expect(report.ok).toBe(true);
    expect(report.checks.every((check) => check.pass)).toBe(true);
  });

  it("still requires error field when success=false (T036)", () => {
    const envelope = {
      $schema: "https://lafs.dev/schemas/v1/envelope.schema.json",
      _meta: {
        specVersion: "1.0.0",
        schemaVersion: "1.0.0",
        timestamp: "2026-02-12T00:00:00Z",
        operation: "example.fail",
        requestId: "req_missing_error",
        transport: "cli",
        strict: true,
        mvi: "minimal",
        contextVersion: 0,
      },
      success: false,
      result: null,
      // error intentionally omitted — should fail validation
    };
    const result = validateEnvelope(envelope);
    expect(result.valid).toBe(false);
  });
});

describe("LAFS error envelope", () => {
  it("isRegisteredErrorCode returns true for registered code E_VALIDATION_SCHEMA", () => {
    expect(isRegisteredErrorCode("E_VALIDATION_SCHEMA")).toBe(true);
  });

  it("isRegisteredErrorCode returns false for unregistered code E_FAKE_UNREGISTERED", () => {
    expect(isRegisteredErrorCode("E_FAKE_UNREGISTERED")).toBe(false);
  });

  it("accepts valid error envelope fixture", () => {
    const envelope = load("fixtures/valid-error-envelope.json");
    const result = validateEnvelope(envelope);
    expect(result.valid).toBe(true);

    const report = runEnvelopeConformance(envelope);
    expect(report.ok).toBe(true);
    expect(report.checks.every((check) => check.pass)).toBe(true);
  });

  it("detects unregistered error code via conformance", () => {
    const envelope = load("fixtures/invalid-unregistered-error.json");
    const report = runEnvelopeConformance(envelope);
    expect(report.ok).toBe(false);
    expect(report.checks.some((check) => check.name === "error_code_registered" && !check.pass)).toBe(true);
  });

  it("passes envelope_invariants for error envelope with non-null result", () => {
    const envelope = load("fixtures/invalid-error-with-result.json");
    const report = runEnvelopeConformance(envelope);
    // result alongside error is valid — validation tools return actionable data
    // (e.g., suggestedFix) alongside error metadata.
    // The envelope_invariants check should pass (result is allowed on error).
    // Other checks (e.g., error_code_registered) may still fail for this fixture.
    const invariantCheck = report.checks.find((c) => c.name === "envelope_invariants");
    expect(invariantCheck?.pass).toBe(true);
  });
});

describe("LAFS pagination mode validation (T044/T045)", () => {
  it("accepts valid cursor pagination fixture", () => {
    const envelope = load("fixtures/valid-cursor-pagination.json");
    const result = validateEnvelope(envelope);
    expect(result.valid).toBe(true);

    const report = runEnvelopeConformance(envelope);
    expect(report.ok).toBe(true);
  });

  it("accepts valid offset pagination fixture", () => {
    const envelope = load("fixtures/valid-offset-pagination.json");
    const result = validateEnvelope(envelope);
    expect(result.valid).toBe(true);

    const report = runEnvelopeConformance(envelope);
    expect(report.ok).toBe(true);
  });

  it("accepts valid none pagination fixture", () => {
    const envelope = load("fixtures/valid-none-pagination.json");
    const result = validateEnvelope(envelope);
    expect(result.valid).toBe(true);

    const report = runEnvelopeConformance(envelope);
    expect(report.ok).toBe(true);
  });

  it("rejects cursor mode missing nextCursor (schema-level)", () => {
    const envelope = load("fixtures/invalid-cursor-missing-fields.json");
    const result = validateEnvelope(envelope);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("nextCursor"))).toBe(true);
  });

  it("rejects offset mode missing required fields", () => {
    const envelope = {
      $schema: "https://lafs.dev/schemas/v1/envelope.schema.json",
      _meta: {
        specVersion: "1.0.0",
        schemaVersion: "1.0.0",
        timestamp: "2026-02-13T00:00:00Z",
        operation: "example.list",
        requestId: "req_bad_offset",
        transport: "http",
        strict: true,
        mvi: "standard",
        contextVersion: 0,
      },
      success: true,
      result: { items: [] },
      page: {
        mode: "offset",
        hasMore: false,
        // missing limit and offset
      },
    };
    const result = validateEnvelope(envelope);
    expect(result.valid).toBe(false);
  });

  it("conformance detects cursor mode with offset field (T046)", () => {
    const envelope = load("fixtures/mixed-pagination-envelope.json");
    const report = runEnvelopeConformance(envelope);
    const check = report.checks.find((c) => c.name === "pagination_mode_consistent");
    expect(check).toBeDefined();
    expect(check!.pass).toBe(false);
    expect(check!.detail).toContain("offset");
  });

  it("conformance passes for clean cursor pagination (T046)", () => {
    const envelope = load("fixtures/valid-cursor-pagination.json");
    const report = runEnvelopeConformance(envelope);
    const check = report.checks.find((c) => c.name === "pagination_mode_consistent");
    expect(check).toBeDefined();
    expect(check!.pass).toBe(true);
  });

  it("allows cursor mode with optional total field", () => {
    const envelope = {
      $schema: "https://lafs.dev/schemas/v1/envelope.schema.json",
      _meta: {
        specVersion: "1.0.0",
        schemaVersion: "1.0.0",
        timestamp: "2026-02-13T00:00:00Z",
        operation: "example.list",
        requestId: "req_cursor_total",
        transport: "http",
        strict: true,
        mvi: "standard",
        contextVersion: 0,
      },
      success: true,
      result: { items: [] },
      page: {
        mode: "cursor",
        nextCursor: null,
        hasMore: false,
        total: 42,
      },
    };
    const result = validateEnvelope(envelope);
    expect(result.valid).toBe(true);
  });
});

describe("LAFS strict mode conformance (T041)", () => {
  it("fails strict_mode_behavior when success=true has explicit error:null", () => {
    const envelope = {
      $schema: "https://lafs.dev/schemas/v1/envelope.schema.json",
      _meta: {
        specVersion: "1.0.0",
        schemaVersion: "1.0.0",
        timestamp: "2026-02-12T00:00:00Z",
        operation: "example.list",
        requestId: "req_strict_null_error",
        transport: "cli",
        strict: true,
        mvi: "minimal",
        contextVersion: 0,
      },
      success: true,
      result: { items: [] },
      error: null, // explicit null in strict mode — should fail strict check
      page: {
        mode: "offset" as const,
        limit: 50,
        offset: 0,
        hasMore: false,
        total: 0,
      },
    };
    const report = runEnvelopeConformance(envelope);
    expect(report.ok).toBe(false);
    const strictCheck = report.checks.find((c) => c.name === "strict_mode_behavior");
    expect(strictCheck).toBeDefined();
    expect(strictCheck!.pass).toBe(false);
  });

  it("fails strict_mode_behavior when page is explicit null", () => {
    const envelope = {
      $schema: "https://lafs.dev/schemas/v1/envelope.schema.json",
      _meta: {
        specVersion: "1.0.0",
        schemaVersion: "1.0.0",
        timestamp: "2026-02-12T00:00:00Z",
        operation: "example.list",
        requestId: "req_strict_null_page",
        transport: "cli",
        strict: true,
        mvi: "minimal",
        contextVersion: 0,
      },
      success: true,
      result: { items: [] },
      page: null, // explicit null in strict mode — should fail strict check
    };
    const report = runEnvelopeConformance(envelope);
    expect(report.ok).toBe(false);
    const strictCheck = report.checks.find((c) => c.name === "strict_mode_behavior");
    expect(strictCheck).toBeDefined();
    expect(strictCheck!.pass).toBe(false);
  });

  it("passes strict_mode_behavior when optional fields are omitted", () => {
    const envelope = load("fixtures/valid-success-no-page.json");
    const report = runEnvelopeConformance(envelope);
    expect(report.ok).toBe(true);
    const strictCheck = report.checks.find((c) => c.name === "strict_mode_behavior");
    expect(strictCheck).toBeDefined();
    expect(strictCheck!.pass).toBe(true);
  });

  it("skips strict_mode_behavior when strict=false", () => {
    const envelope = {
      $schema: "https://lafs.dev/schemas/v1/envelope.schema.json",
      _meta: {
        specVersion: "1.0.0",
        schemaVersion: "1.0.0",
        timestamp: "2026-02-12T00:00:00Z",
        operation: "example.list",
        requestId: "req_nonstrict",
        transport: "cli",
        strict: false,
        mvi: "minimal",
        contextVersion: 0,
      },
      success: true,
      result: { items: [] },
      error: null, // explicit null but strict=false — no strict check emitted
      page: null,
    };
    const report = runEnvelopeConformance(envelope);
    const strictCheck = report.checks.find((c) => c.name === "strict_mode_behavior");
    expect(strictCheck).toBeUndefined();
    expect(report.ok).toBe(true);
  });
});

describe("LAFS strict/lenient additional-properties enforcement (T038)", () => {
  const baseMeta = {
    specVersion: "1.0.0",
    schemaVersion: "1.0.0",
    timestamp: "2026-02-12T00:00:00Z",
    operation: "example.list",
    transport: "cli",
    mvi: "minimal",
    contextVersion: 0,
  };

  it("strict:true rejects unknown top-level properties", () => {
    const envelope = {
      $schema: "https://lafs.dev/schemas/v1/envelope.schema.json",
      _meta: { ...baseMeta, strict: true, requestId: "req_strict_reject" },
      success: true,
      result: { items: [] },
      customField: "should be rejected",
    };
    const result = validateEnvelope(envelope);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("additional"))).toBe(true);
  });

  it("strict:false allows unknown top-level properties", () => {
    const envelope = {
      $schema: "https://lafs.dev/schemas/v1/envelope.schema.json",
      _meta: { ...baseMeta, strict: false, requestId: "req_lenient_allow" },
      success: true,
      result: { items: [] },
      error: null,
      page: null,
      customField: "should be allowed",
    };
    const result = validateEnvelope(envelope);
    expect(result.valid).toBe(true);
  });

  it("_extensions is allowed in strict mode", () => {
    const envelope = {
      $schema: "https://lafs.dev/schemas/v1/envelope.schema.json",
      _meta: { ...baseMeta, strict: true, requestId: "req_strict_ext" },
      success: true,
      result: { items: [] },
      _extensions: { "x-trace-id": "abc123" },
    };
    const result = validateEnvelope(envelope);
    expect(result.valid).toBe(true);
  });

  it("_extensions is allowed in lenient mode", () => {
    const envelope = {
      $schema: "https://lafs.dev/schemas/v1/envelope.schema.json",
      _meta: { ...baseMeta, strict: false, requestId: "req_lenient_ext" },
      success: true,
      result: { items: [] },
      error: null,
      page: null,
      _extensions: { "x-vendor-data": { nested: true } },
    };
    const result = validateEnvelope(envelope);
    expect(result.valid).toBe(true);
  });

  it("conformance strict_mode_enforced passes for strict:true envelope", () => {
    const envelope = {
      $schema: "https://lafs.dev/schemas/v1/envelope.schema.json",
      _meta: { ...baseMeta, strict: true, requestId: "req_conf_strict" },
      success: true,
      result: { items: [] },
    };
    const report = runEnvelopeConformance(envelope);
    const check = report.checks.find((c) => c.name === "strict_mode_enforced");
    expect(check).toBeDefined();
    expect(check!.pass).toBe(true);
  });

  it("conformance strict_mode_enforced passes for strict:false envelope", () => {
    const envelope = {
      $schema: "https://lafs.dev/schemas/v1/envelope.schema.json",
      _meta: { ...baseMeta, strict: false, requestId: "req_conf_lenient" },
      success: true,
      result: { items: [] },
      error: null,
      page: null,
    };
    const report = runEnvelopeConformance(envelope);
    const check = report.checks.find((c) => c.name === "strict_mode_enforced");
    expect(check).toBeDefined();
    expect(check!.pass).toBe(true);
  });
});

describe("LAFS transport mapping helper/conformance (T059/T060)", () => {
  it("returns HTTP/GRPC/CLI mappings for a registered code", () => {
    expect(getTransportMapping("E_NOT_FOUND_RESOURCE", "http")?.value).toBe(404);
    expect(getTransportMapping("E_NOT_FOUND_RESOURCE", "grpc")?.value).toBe("NOT_FOUND");
    expect(getTransportMapping("E_NOT_FOUND_RESOURCE", "cli")?.value).toBe(4);
  });

  it("returns null mapping for unregistered code", () => {
    expect(getTransportMapping("E_FAKE_UNREGISTERED", "http")).toBeNull();
  });

  it("passes transport mapping conformance for registered error code", () => {
    const envelope = load("fixtures/valid-error-envelope.json");
    const report = runEnvelopeConformance(envelope);
    const check = report.checks.find((c) => c.name === "transport_mapping_consistent");
    expect(check).toBeDefined();
    expect(check!.pass).toBe(true);
  });

  it("fails transport mapping conformance for unregistered error code", () => {
    const envelope = load("fixtures/invalid-unregistered-error.json");
    const report = runEnvelopeConformance(envelope);
    const check = report.checks.find((c) => c.name === "transport_mapping_consistent");
    expect(check).toBeDefined();
    expect(check!.pass).toBe(false);
  });
});

describe("LAFS context mutation conformance (T055)", () => {
  it("fails when context-required mutation succeeds without context identity", () => {
    const envelope = {
      $schema: "https://lafs.dev/schemas/v1/envelope.schema.json",
      _meta: {
        specVersion: "1.0.0",
        schemaVersion: "1.0.0",
        timestamp: "2026-02-25T00:00:00Z",
        operation: "orders.update",
        requestId: "req_context_missing",
        transport: "http",
        strict: true,
        mvi: "standard",
        contextVersion: 0,
      },
      success: true,
      result: { ok: true },
      _extensions: {
        context: { required: true },
      },
    };

    const report = runEnvelopeConformance(envelope);
    const check = report.checks.find((c) => c.name === "context_mutation_failure");
    expect(check).toBeDefined();
    expect(check!.pass).toBe(false);
  });

  it("passes when context-required mutation fails with E_CONTEXT_MISSING", () => {
    const envelope = {
      $schema: "https://lafs.dev/schemas/v1/envelope.schema.json",
      _meta: {
        specVersion: "1.0.0",
        schemaVersion: "1.0.0",
        timestamp: "2026-02-25T00:00:00Z",
        operation: "orders.update",
        requestId: "req_context_error",
        transport: "http",
        strict: true,
        mvi: "standard",
        contextVersion: 0,
      },
      success: false,
      result: null,
      error: {
        code: "E_CONTEXT_MISSING",
        message: "context required",
        category: "CONTRACT",
        retryable: false,
        retryAfterMs: null,
        details: {},
      },
      _extensions: {
        lafsContextRequired: true,
      },
    };

    const report = runEnvelopeConformance(envelope);
    const check = report.checks.find((c) => c.name === "context_mutation_failure");
    expect(check).toBeDefined();
    expect(check!.pass).toBe(true);
  });
});

describe("LAFS context preservation validation (T054/T056)", () => {
  it("accepts valid context ledger fixture", () => {
    const envelope = load("fixtures/valid-context-ledger.json");
    const validation = validateEnvelope(envelope);
    expect(validation.valid).toBe(true);

    const report = runEnvelopeConformance(envelope);
    const check = report.checks.find((c) => c.name === "context_preservation_valid");
    expect(check).toBeDefined();
    expect(check!.pass).toBe(true);
  });

  it("detects stale context with non-monotonic version", () => {
    const envelope = load("fixtures/invalid-context-stale.json");
    const validation = validateEnvelope(envelope);
    expect(validation.valid).toBe(true);

    const report = runEnvelopeConformance(envelope);
    const check = report.checks.find((c) => c.name === "context_preservation_valid");
    expect(check).toBeDefined();
    expect(check!.pass).toBe(false);
    expect(check!.detail).toContain("non-monotonic");
  });

  it("handles missing context fixture with correct error code", () => {
    const envelope = load("fixtures/invalid-context-missing.json");
    const validation = validateEnvelope(envelope);
    expect(validation.valid).toBe(true);

    const report = runEnvelopeConformance(envelope);
    const mutationCheck = report.checks.find((c) => c.name === "context_mutation_failure");
    expect(mutationCheck).toBeDefined();
    expect(mutationCheck!.pass).toBe(true);
  });
});
