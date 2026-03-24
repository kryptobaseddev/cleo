import { describe, expect, it } from "vitest";
import { projectEnvelope, estimateProjectedTokens } from "../src/mviProjection.js";
import type { LAFSEnvelope } from "../src/types.js";

/** Helper: build a full error envelope with all fields populated. */
function makeFullErrorEnvelope(overrides?: Partial<LAFSEnvelope>): LAFSEnvelope {
  return {
    $schema: "https://lafs.dev/schemas/v1/envelope.schema.json",
    _meta: {
      specVersion: "1.0.0",
      schemaVersion: "1.0.0",
      timestamp: "2026-03-15T12:00:00Z",
      operation: "users.create",
      requestId: "req_abc123",
      transport: "http",
      strict: true,
      mvi: "full",
      contextVersion: 3,
    },
    success: false,
    result: null,
    error: {
      code: "E_VALIDATION_SCHEMA",
      message: "Request body failed JSON Schema validation against users.create input schema.",
      category: "VALIDATION",
      retryable: false,
      retryAfterMs: null,
      details: { field: "email", reason: "invalid format" },
    },
    page: {
      mode: "offset",
      limit: 50,
      offset: 0,
      hasMore: false,
      total: 0,
    },
    _extensions: { "x-trace-id": "trace_xyz" },
    ...overrides,
  };
}

/** Helper: build a full success envelope. */
function makeFullSuccessEnvelope(overrides?: Partial<LAFSEnvelope>): LAFSEnvelope {
  return {
    $schema: "https://lafs.dev/schemas/v1/envelope.schema.json",
    _meta: {
      specVersion: "1.0.0",
      schemaVersion: "1.0.0",
      timestamp: "2026-03-15T12:00:00Z",
      operation: "users.list",
      requestId: "req_def456",
      transport: "http",
      strict: true,
      mvi: "standard",
      contextVersion: 1,
    },
    success: true,
    result: { users: [{ id: 1, name: "Alice" }] },
    ...overrides,
  };
}

describe("projectEnvelope", () => {
  describe("minimal level", () => {
    it("strips $schema, result:null, error.message, error.category, error.retryable from error envelope", () => {
      const env = makeFullErrorEnvelope();
      const projected = projectEnvelope(env, "minimal");

      // Must NOT have these fields
      expect(projected).not.toHaveProperty("$schema");
      expect(projected).not.toHaveProperty("page");

      // error must not have message, category, retryable
      const err = projected.error as Record<string, unknown>;
      expect(err).not.toHaveProperty("message");
      expect(err).not.toHaveProperty("category");
      expect(err).not.toHaveProperty("retryable");
    });

    it("keeps success, error.code, error.details (when non-empty), _meta.requestId, _meta.contextVersion", () => {
      const env = makeFullErrorEnvelope();
      const projected = projectEnvelope(env, "minimal");

      expect(projected.success).toBe(false);

      const err = projected.error as Record<string, unknown>;
      expect(err.code).toBe("E_VALIDATION_SCHEMA");
      expect(err.details).toEqual({ field: "email", reason: "invalid format" });

      const meta = projected._meta as Record<string, unknown>;
      expect(meta.requestId).toBe("req_abc123");
      expect(meta.contextVersion).toBe(3);
    });

    it("omits error.retryAfterMs when null", () => {
      const env = makeFullErrorEnvelope();
      const projected = projectEnvelope(env, "minimal");
      const err = projected.error as Record<string, unknown>;
      expect(err).not.toHaveProperty("retryAfterMs");
    });

    it("keeps error.retryAfterMs when non-null", () => {
      const env = makeFullErrorEnvelope();
      env.error!.retryAfterMs = 5000;
      const projected = projectEnvelope(env, "minimal");
      const err = projected.error as Record<string, unknown>;
      expect(err.retryAfterMs).toBe(5000);
    });

    it("omits error.details when empty", () => {
      const env = makeFullErrorEnvelope();
      env.error!.details = {};
      const projected = projectEnvelope(env, "minimal");
      const err = projected.error as Record<string, unknown>;
      expect(err).not.toHaveProperty("details");
    });

    it("strips _meta echo-back fields (specVersion, schemaVersion, timestamp, operation, transport, strict)", () => {
      const env = makeFullErrorEnvelope();
      const projected = projectEnvelope(env, "minimal");
      const meta = projected._meta as Record<string, unknown>;

      expect(meta).not.toHaveProperty("specVersion");
      expect(meta).not.toHaveProperty("schemaVersion");
      expect(meta).not.toHaveProperty("timestamp");
      expect(meta).not.toHaveProperty("operation");
      expect(meta).not.toHaveProperty("transport");
      expect(meta).not.toHaveProperty("strict");
      expect(meta).not.toHaveProperty("mvi");
    });

    it("includes result for success envelopes", () => {
      const env = makeFullSuccessEnvelope();
      const projected = projectEnvelope(env, "minimal");

      expect(projected.success).toBe(true);
      expect(projected.result).toEqual({ users: [{ id: 1, name: "Alice" }] });
      expect(projected).not.toHaveProperty("error");
    });
  });

  describe("standard level", () => {
    it("includes $schema and core _meta fields", () => {
      const env = makeFullErrorEnvelope({ _meta: { ...makeFullErrorEnvelope()._meta, mvi: "standard" } });
      const projected = projectEnvelope(env, "standard");

      expect(projected.$schema).toBe("https://lafs.dev/schemas/v1/envelope.schema.json");

      const meta = projected._meta as Record<string, unknown>;
      expect(meta.timestamp).toBeDefined();
      expect(meta.operation).toBeDefined();
      expect(meta.requestId).toBeDefined();
      expect(meta.mvi).toBeDefined();
      expect(meta.contextVersion).toBeDefined();
    });

    it("strips _meta.transport, _meta.strict, _meta.specVersion, _meta.schemaVersion", () => {
      const env = makeFullErrorEnvelope();
      const projected = projectEnvelope(env, "standard");
      const meta = projected._meta as Record<string, unknown>;

      expect(meta).not.toHaveProperty("transport");
      expect(meta).not.toHaveProperty("strict");
      expect(meta).not.toHaveProperty("specVersion");
      expect(meta).not.toHaveProperty("schemaVersion");
    });

    it("keeps full error object at standard level", () => {
      const env = makeFullErrorEnvelope();
      const projected = projectEnvelope(env, "standard");

      expect(projected.error).toEqual(env.error);
    });

    it("includes page when present", () => {
      const env = makeFullErrorEnvelope();
      const projected = projectEnvelope(env, "standard");

      expect(projected.page).toEqual(env.page);
    });
  });

  describe("full level", () => {
    it("returns envelope unchanged", () => {
      const env = makeFullErrorEnvelope();
      const projected = projectEnvelope(env, "full");

      // Full should return the exact same object reference
      expect(projected).toBe(env);
    });
  });

  describe("custom level", () => {
    it("returns envelope unchanged (same as full)", () => {
      const env = makeFullErrorEnvelope();
      const projected = projectEnvelope(env, "custom");

      expect(projected).toBe(env);
    });
  });

  describe("default level from envelope _meta.mvi", () => {
    it("uses _meta.mvi when no explicit level is provided", () => {
      const env = makeFullErrorEnvelope({ _meta: { ...makeFullErrorEnvelope()._meta, mvi: "minimal" } });
      const projected = projectEnvelope(env);

      // Should behave as minimal
      expect(projected).not.toHaveProperty("$schema");
      const meta = projected._meta as Record<string, unknown>;
      expect(meta).not.toHaveProperty("timestamp");
    });
  });

  describe("token savings verification", () => {
    it("minimal projection is at least 60% smaller than full for error envelopes", () => {
      const env = makeFullErrorEnvelope();
      const fullJson = JSON.stringify(env);
      const minimalProjected = projectEnvelope(env, "minimal");
      const minimalJson = JSON.stringify(minimalProjected);

      const reduction = 1 - minimalJson.length / fullJson.length;
      expect(reduction).toBeGreaterThanOrEqual(0.6);
    });
  });

  describe("idempotence", () => {
    it("projectEnvelope(projectEnvelope(env, minimal), minimal) produces same output", () => {
      const env = makeFullErrorEnvelope();
      const first = projectEnvelope(env, "minimal");
      // Cast back to LAFSEnvelope-like shape for second projection
      const second = projectEnvelope(first as unknown as LAFSEnvelope, "minimal");
      expect(second).toEqual(first);
    });
  });

  describe("extensions handling", () => {
    it("includes _extensions when non-empty", () => {
      const env = makeFullErrorEnvelope({
        _extensions: { "x-custom": "value", "x-other": 42 },
      });
      const projected = projectEnvelope(env, "minimal");
      expect(projected._extensions).toEqual({ "x-custom": "value", "x-other": 42 });
    });

    it("omits _extensions when empty object", () => {
      const env = makeFullErrorEnvelope({ _extensions: {} });
      const projected = projectEnvelope(env, "minimal");
      expect(projected).not.toHaveProperty("_extensions");
    });

    it("omits _extensions when undefined", () => {
      const env = makeFullErrorEnvelope();
      delete (env as unknown as Record<string, unknown>)._extensions;
      const projected = projectEnvelope(env, "minimal");
      expect(projected).not.toHaveProperty("_extensions");
    });
  });

  describe("sessionId handling", () => {
    it("includes sessionId in minimal meta when present", () => {
      const env = makeFullErrorEnvelope({
        _meta: { ...makeFullErrorEnvelope()._meta, sessionId: "sess_abc" },
      });
      const projected = projectEnvelope(env, "minimal");
      const meta = projected._meta as Record<string, unknown>;
      expect(meta.sessionId).toBe("sess_abc");
    });

    it("omits sessionId in minimal meta when absent", () => {
      const env = makeFullErrorEnvelope();
      const projected = projectEnvelope(env, "minimal");
      const meta = projected._meta as Record<string, unknown>;
      expect(meta).not.toHaveProperty("sessionId");
    });

    it("includes sessionId in standard meta when present", () => {
      const env = makeFullErrorEnvelope({
        _meta: { ...makeFullErrorEnvelope()._meta, sessionId: "sess_xyz" },
      });
      const projected = projectEnvelope(env, "standard");
      const meta = projected._meta as Record<string, unknown>;
      expect(meta.sessionId).toBe("sess_xyz");
    });
  });

  describe("warnings handling", () => {
    it("includes warnings in minimal meta when present", () => {
      const env = makeFullErrorEnvelope({
        _meta: {
          ...makeFullErrorEnvelope()._meta,
          warnings: [{ code: "W_DEPRECATED", message: "Field x is deprecated" }],
        },
      });
      const projected = projectEnvelope(env, "minimal");
      const meta = projected._meta as Record<string, unknown>;
      expect(meta.warnings).toEqual([{ code: "W_DEPRECATED", message: "Field x is deprecated" }]);
    });

    it("omits warnings in minimal meta when empty array", () => {
      const env = makeFullErrorEnvelope({
        _meta: { ...makeFullErrorEnvelope()._meta, warnings: [] },
      });
      const projected = projectEnvelope(env, "minimal");
      const meta = projected._meta as Record<string, unknown>;
      expect(meta).not.toHaveProperty("warnings");
    });

    it("includes warnings in standard meta when present", () => {
      const env = makeFullErrorEnvelope({
        _meta: {
          ...makeFullErrorEnvelope()._meta,
          warnings: [{ code: "W_SLOW", message: "Slow query" }],
        },
      });
      const projected = projectEnvelope(env, "standard");
      const meta = projected._meta as Record<string, unknown>;
      expect(meta.warnings).toEqual([{ code: "W_SLOW", message: "Slow query" }]);
    });
  });
});

describe("estimateProjectedTokens", () => {
  it("returns a positive number for any projected envelope", () => {
    const env = makeFullErrorEnvelope();
    const projected = projectEnvelope(env, "minimal");
    const tokens = estimateProjectedTokens(projected);
    expect(tokens).toBeGreaterThan(0);
  });

  it("estimates fewer tokens for minimal than full", () => {
    const env = makeFullErrorEnvelope();
    const minimal = projectEnvelope(env, "minimal");
    const full = projectEnvelope(env, "full");

    expect(estimateProjectedTokens(minimal)).toBeLessThan(estimateProjectedTokens(full));
  });

  it("uses ~4 chars per token heuristic", () => {
    const simple: Record<string, unknown> = { a: 1 };
    const json = JSON.stringify(simple); // {"a":1} = 7 chars
    expect(estimateProjectedTokens(simple)).toBe(Math.ceil(json.length / 4));
  });
});
