import { describe, expect, it } from "vitest";
import {
  ComplianceError,
  assertCompliance,
  createEnvelope,
  enforceCompliance,
  withCompliance,
} from "../src/index.js";

describe("compliance APIs", () => {
  const validEnvelope = createEnvelope({
    success: true,
    result: { ok: true },
    meta: {
      operation: "example.ok",
      requestId: "req_comp_1",
    },
  });

  it("enforceCompliance passes valid envelope", () => {
    const result = enforceCompliance(validEnvelope);
    expect(result.ok).toBe(true);
    expect(result.envelope).toBeDefined();
    expect(result.issues).toHaveLength(0);
  });

  it("enforceCompliance reports schema failures", () => {
    const invalid = {
      success: true,
      result: { ok: true },
    };

    const result = enforceCompliance(invalid);
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.stage === "schema")).toBe(true);
  });

  it("enforceCompliance enforces json output policy", () => {
    const result = enforceCompliance(validEnvelope, {
      requireJsonOutput: true,
      flags: { humanFlag: true },
    });

    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.stage === "format")).toBe(true);
  });

  it("assertCompliance throws ComplianceError on failure", () => {
    expect(() =>
      assertCompliance(validEnvelope, {
        requireJsonOutput: true,
        flags: { humanFlag: true },
      }),
    ).toThrow(ComplianceError);
  });

  it("withCompliance wraps producer and rejects non-compliant output", async () => {
    const producer = async () => validEnvelope;
    const wrapped = withCompliance(producer, {
      requireJsonOutput: true,
      flags: { jsonFlag: true },
    });

    await expect(wrapped()).resolves.toBeDefined();

    const badWrapped = withCompliance(producer, {
      requireJsonOutput: true,
      flags: { humanFlag: true },
    });

    await expect(badWrapped()).rejects.toThrow(ComplianceError);
  });
});
