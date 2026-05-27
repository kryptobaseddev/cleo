import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  randomUUID: vi.fn(),
  isRegisteredErrorCode: vi.fn(),
}));

vi.mock("node:crypto", () => ({
  randomUUID: mocks.randomUUID,
}));

vi.mock("@cleocode/lafs", () => ({
  isRegisteredErrorCode: mocks.isRegisteredErrorCode,
}));

import {
  LAFSCommandError,
  emitError,
  emitSuccess,
  runLafsCommand,
} from "../../src/commands/advanced/lafs.js";

describe("advanced/lafs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-12T10:00:00.000Z"));
    mocks.randomUUID.mockReset();
    mocks.isRegisteredErrorCode.mockReset();
    mocks.randomUUID.mockReturnValue("test-request-id");
    mocks.isRegisteredErrorCode.mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("constructs LAFS command errors with inferred category", () => {
    const error = new LAFSCommandError(
      "E_ADVANCED_VALIDATION_PRIORITY",
      "Invalid tier",
      "Use high, medium, or low",
    );

    expect(error.code).toBe("E_ADVANCED_VALIDATION_PRIORITY");
    expect(error.category).toBe("VALIDATION");
    expect(error.recoverable).toBe(true);
    expect(error.retryAfterMs).toBeNull();
  });

  it("emits a success envelope with deterministic metadata", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    emitSuccess("advanced.batch", { applied: 2 }, "minimal");

    const output = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}")) as {
      success: boolean;
      result: { applied: number };
      error: null;
      _meta: { requestId: string; timestamp: string; operation: string; mvi: string };
    };

    expect(output.success).toBe(true);
    expect(output.result).toEqual({ applied: 2 });
    expect(output.error).toBeNull();
    expect(output._meta.requestId).toBe("test-request-id");
    expect(output._meta.timestamp).toBe("2026-02-12T10:00:00.000Z");
    expect(output._meta.operation).toBe("advanced.batch");
    expect(output._meta.mvi).toBe("minimal");
  });

  it("emits structured registered LAFS errors", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.isRegisteredErrorCode.mockImplementation((code: string) => code === "E_ADVANCED_VALIDATION_PRIORITY");

    emitError(
      "advanced.batch",
      new LAFSCommandError(
        "E_ADVANCED_VALIDATION_PRIORITY",
        "Invalid tier",
        "Use one of: high, medium, low.",
        true,
        { field: "tier" },
      ),
    );

    const output = JSON.parse(String(errorSpy.mock.calls[0]?.[0] ?? "{}")) as {
      success: boolean;
      error: {
        code: string;
        category: string;
        retryable: boolean;
        details: { hint: string; payload: { field: string } };
      };
    };

    expect(output.success).toBe(false);
    expect(output.error.code).toBe("E_ADVANCED_VALIDATION_PRIORITY");
    expect(output.error.category).toBe("VALIDATION");
    expect(output.error.retryable).toBe(true);
    expect(output.error.details.hint).toContain("high, medium, low");
    expect(output.error.details.payload).toEqual({ field: "tier" });
  });

  it("falls back to internal code for unknown command errors", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    emitError(
      "advanced.batch",
      new LAFSCommandError("E_CUSTOM_NOT_FOUND", "Missing", "Check inputs", false),
    );

    const output = JSON.parse(String(errorSpy.mock.calls[0]?.[0] ?? "{}")) as {
      error: { code: string; category: string; retryable: boolean };
    };

    expect(output.error.code).toBe("E_INTERNAL_UNEXPECTED");
    expect(output.error.category).toBe("NOT_FOUND");
    expect(output.error.retryable).toBe(false);
  });

  it("handles unexpected non-LAFS errors", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    emitError("advanced.batch", new Error("boom"));

    const output = JSON.parse(String(errorSpy.mock.calls[0]?.[0] ?? "{}")) as {
      error: { code: string; message: string; category: string; details: { hint: string } };
    };

    expect(output.error.code).toBe("E_INTERNAL_UNEXPECTED");
    expect(output.error.message).toBe("boom");
    expect(output.error.category).toBe("INTERNAL");
    expect(output.error.details.hint).toContain("--verbose");
  });

  it("runs commands through success and failure envelope paths", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process-exit");
    }) as never);

    await runLafsCommand("advanced.batch", "standard", async () => ({ ok: true }));
    expect(logSpy).toHaveBeenCalledTimes(1);

    await expect(
      runLafsCommand(
        "advanced.batch",
        "standard",
        async () => Promise.reject(new LAFSCommandError("E_ADVANCED_CONFLICT", "conflict", "retry", false)),
      ),
    ).rejects.toThrow("process-exit");

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
