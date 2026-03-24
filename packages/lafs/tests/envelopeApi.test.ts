import { describe, expect, it } from "vitest";
import {
  createEnvelope,
  LafsError,
  parseLafsResponse,
  runEnvelopeConformance,
  validateEnvelope,
} from "../src/index.js";

describe("envelope API helpers", () => {
  it("creates valid success envelope with defaults", () => {
    const envelope = createEnvelope({
      success: true,
      result: { message: "ok" },
      meta: {
        operation: "example.ok",
        requestId: "req_001",
      },
    });

    const validation = validateEnvelope(envelope);
    expect(validation.valid).toBe(true);
    expect(envelope.$schema).toBe("https://lafs.dev/schemas/v1/envelope.schema.json");
    expect(envelope._meta.transport).toBe("sdk");
    expect(envelope._meta.mvi).toBe("standard");
  });

  it("creates valid error envelope", () => {
    const envelope = createEnvelope({
      success: false,
      error: {
        code: "E_FAKE_UNREGISTERED",
        message: "boom",
      },
      meta: {
        operation: "example.fail",
        requestId: "req_002",
      },
    });

    const validation = validateEnvelope(envelope);
    expect(validation.valid).toBe(true);

    const report = runEnvelopeConformance(envelope);
    expect(report.ok).toBe(false);
    expect(report.checks.some((c) => c.name === "error_code_registered" && !c.pass)).toBe(true);
  });

  it("maps legacy boolean mvi to enum", () => {
    const envelope = createEnvelope({
      success: true,
      result: { message: "ok" },
      meta: {
        operation: "example.legacy",
        requestId: "req_003",
        mvi: true,
      },
    });

    expect(envelope._meta.mvi).toBe("minimal");
    expect(validateEnvelope(envelope).valid).toBe(true);
  });

  it("parseLafsResponse returns result for success", () => {
    const envelope = createEnvelope({
      success: true,
      result: { count: 3 },
      meta: {
        operation: "example.parse",
        requestId: "req_004",
      },
    });

    const result = parseLafsResponse<{ count: number }>(envelope);
    expect(result.count).toBe(3);
  });

  it("parseLafsResponse throws LafsError for error envelopes", () => {
    const envelope = createEnvelope({
      success: false,
      error: {
        code: "E_NOT_FOUND_RESOURCE",
        message: "resource missing",
        category: "NOT_FOUND",
        retryable: false,
      },
      meta: {
        operation: "example.parse.error",
        requestId: "req_005",
      },
    });

    expect(() => parseLafsResponse(envelope)).toThrow(LafsError);
  });
});
