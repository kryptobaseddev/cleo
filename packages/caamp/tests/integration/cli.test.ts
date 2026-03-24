import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerProvidersCommand } from "../../src/commands/providers.js";

describe("integration: cli command behavior", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns parseable json for providers list --json", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerProvidersCommand(program);

    await program.parseAsync(["node", "test", "providers", "list", "--json"]);

    const output = String(logSpy.mock.calls[0]?.[0] ?? "{}");
    const envelope = JSON.parse(output) as {
      $schema: string;
      _meta: { operation: string };
      success: boolean;
      result: { providers: Array<{ id: string }> };
    };
    expect(envelope.$schema).toBe("https://lafs.dev/schemas/v1/envelope.schema.json");
    expect(envelope._meta.operation).toBe("providers.list");
    expect(envelope.success).toBe(true);
    expect(Array.isArray(envelope.result.providers)).toBe(true);
    expect(envelope.result.providers.length).toBeGreaterThan(0);
    expect(envelope.result.providers[0]?.id).toBeTypeOf("string");
  });

  it("returns parseable json for providers show --json", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerProvidersCommand(program);

    await program.parseAsync(["node", "test", "providers", "show", "claude-code", "--json"]);

    const output = String(logSpy.mock.calls[0]?.[0] ?? "{}");
    const envelope = JSON.parse(output) as {
      $schema: string;
      _meta: { operation: string };
      success: boolean;
      result: { provider: { id: string; toolName: string } };
    };
    expect(envelope.$schema).toBe("https://lafs.dev/schemas/v1/envelope.schema.json");
    expect(envelope._meta.operation).toBe("providers.show");
    expect(envelope.success).toBe(true);
    expect(envelope.result.provider.id).toBe("claude-code");
    expect(envelope.result.provider.toolName).toBeTypeOf("string");
  });

  it("exits non-zero for unknown provider on show", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process-exit");
    }) as never);
    const program = new Command();
    registerProvidersCommand(program);

    await expect(program.parseAsync(["node", "test", "providers", "show", "unknown-provider"])).rejects.toThrow("process-exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
