/**
 * Coverage tests for instructions inject, update, check commands.
 */
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkAllInjections: vi.fn(),
  injectAll: vi.fn(),
  generateInjectionContent: vi.fn(),
  groupByInstructFile: vi.fn(),
  getInstalledProviders: vi.fn(),
  getAllProviders: vi.fn(),
  getProvider: vi.fn(),
}));

vi.mock("../../src/core/instructions/injector.js", () => ({
  checkAllInjections: mocks.checkAllInjections,
  injectAll: mocks.injectAll,
}));

vi.mock("../../src/core/instructions/templates.js", () => ({
  generateInjectionContent: mocks.generateInjectionContent,
  groupByInstructFile: mocks.groupByInstructFile,
}));

vi.mock("../../src/core/registry/detection.js", () => ({
  getInstalledProviders: mocks.getInstalledProviders,
}));

vi.mock("../../src/core/registry/providers.js", () => ({
  getAllProviders: mocks.getAllProviders,
  getProvider: mocks.getProvider,
}));

import { registerInstructionsCheck } from "../../src/commands/instructions/check.js";
import { registerInstructionsInject } from "../../src/commands/instructions/inject.js";
import { registerInstructionsUpdate } from "../../src/commands/instructions/update.js";

const providerA = { id: "claude-code", instructFile: "CLAUDE.md" };

describe("coverage: instructions inject", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.values(mocks).forEach((m) => m.mockReset());

    mocks.getInstalledProviders.mockReturnValue([providerA]);
    mocks.getAllProviders.mockReturnValue([providerA]);
    mocks.getProvider.mockImplementation((name: string) =>
      name === "claude-code" ? providerA : undefined,
    );
    mocks.generateInjectionContent.mockReturnValue("default content");
    mocks.groupByInstructFile.mockReturnValue(new Map([["CLAUDE.md", [providerA]]]));
  });

  // Lines 115-119: json output after inject
  it("outputs json after successful inject", async () => {
    mocks.injectAll.mockResolvedValue(new Map([["CLAUDE.md", "created"]]));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerInstructionsInject(program);

    await program.parseAsync(["node", "test", "inject", "--all", "--json"]);

    const output = String(logSpy.mock.calls[0]?.[0] ?? "{}");
    const envelope = JSON.parse(output);
    expect(envelope.success).toBe(true);
    expect(envelope.result.injected).toEqual(["CLAUDE.md"]);
    expect(envelope.result.count).toBe(1);
  });

  // Lines 123-124: human-readable with "updated" and "unchanged" action icons
  it("shows human inject results with updated icon", async () => {
    mocks.injectAll.mockResolvedValue(new Map([["CLAUDE.md", "updated"]]));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerInstructionsInject(program);

    await program.parseAsync(["node", "test", "inject", "--all", "--human"]);

    const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
    expect(output).toContain("CLAUDE.md");
    expect(output).toContain("updated");
    expect(output).toContain("1 file(s) processed.");
  });

  it("shows human inject results with unchanged icon", async () => {
    mocks.injectAll.mockResolvedValue(new Map([["CLAUDE.md", "unchanged"]]));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerInstructionsInject(program);

    await program.parseAsync(["node", "test", "inject", "--all", "--human"]);

    const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
    expect(output).toContain("CLAUDE.md");
  });

  // Branch: dry-run json output
  it("outputs json dry-run result", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerInstructionsInject(program);

    await program.parseAsync(["node", "test", "inject", "--all", "--dry-run", "--json"]);

    const output = String(logSpy.mock.calls[0]?.[0] ?? "{}");
    const envelope = JSON.parse(output);
    expect(envelope.result.dryRun).toBe(true);
    expect(envelope.result.wouldInject).toBeDefined();
  });

  // Branch: format conflict
  it("exits with format conflict error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process-exit");
    }) as never);

    const program = new Command();
    registerInstructionsInject(program);

    await expect(
      program.parseAsync(["node", "test", "inject", "--all", "--json", "--human"]),
    ).rejects.toThrow("process-exit");

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // Branch: no providers found in human mode
  it("exits with human error when no providers found", async () => {
    mocks.getProvider.mockReturnValue(undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process-exit");
    }) as never);

    const program = new Command();
    registerInstructionsInject(program);

    await expect(
      program.parseAsync(["node", "test", "inject", "--agent", "unknown", "--human"]),
    ).rejects.toThrow("process-exit");

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("No providers found."));
  });

  // Branch: no providers found in json mode
  it("exits with json error when no providers found", async () => {
    mocks.getProvider.mockReturnValue(undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process-exit");
    }) as never);

    const program = new Command();
    registerInstructionsInject(program);

    await expect(
      program.parseAsync(["node", "test", "inject", "--agent", "unknown", "--json"]),
    ).rejects.toThrow("process-exit");

    const output = String(errorSpy.mock.calls[0]?.[0] ?? "{}");
    const envelope = JSON.parse(output);
    expect(envelope.success).toBe(false);
  });

  // Lines 65-66: default provider resolution (no --all, no --agent)
  it("uses default installed providers when no --all or --agent given", async () => {
    mocks.injectAll.mockResolvedValue(new Map([["CLAUDE.md", "created"]]));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerInstructionsInject(program);

    await program.parseAsync(["node", "test", "inject"]);

    expect(mocks.getInstalledProviders).toHaveBeenCalled();
    expect(mocks.injectAll).toHaveBeenCalled();
  });

  // Branch: dry-run human output
  it("shows human-readable dry-run output", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerInstructionsInject(program);

    await program.parseAsync(["node", "test", "inject", "--all", "--dry-run", "--human"]);

    const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
    expect(output).toContain("Dry run - would inject into:");
  });
});

describe("coverage: instructions update", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.values(mocks).forEach((m) => m.mockReset());

    mocks.getInstalledProviders.mockReturnValue([providerA]);
    mocks.generateInjectionContent.mockReturnValue("default content");
  });

  // Lines 38-41: format conflict
  it("exits with format conflict error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process-exit");
    }) as never);

    const program = new Command();
    registerInstructionsUpdate(program);

    await expect(
      program.parseAsync(["node", "test", "update", "--json", "--human"]),
    ).rejects.toThrow("process-exit");

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // Lines 53-57: json output when all files up to date
  it("outputs json when all files are current", async () => {
    mocks.checkAllInjections.mockResolvedValue([
      { provider: "claude-code", file: "CLAUDE.md", status: "current", fileExists: true },
    ]);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerInstructionsUpdate(program);

    await program.parseAsync(["node", "test", "update", "--json"]);

    const output = String(logSpy.mock.calls[0]?.[0] ?? "{}");
    const envelope = JSON.parse(output);
    expect(envelope.result.count.updated).toBe(0);
  });

  // Lines 91-96: json output after successful update
  it("outputs json after successful update", async () => {
    mocks.checkAllInjections.mockResolvedValue([
      { provider: "claude-code", file: "CLAUDE.md", status: "outdated", fileExists: true },
    ]);
    mocks.injectAll.mockResolvedValue(new Map([["CLAUDE.md", "updated"]]));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerInstructionsUpdate(program);

    await program.parseAsync(["node", "test", "update", "--json"]);

    const output = String(logSpy.mock.calls[0]?.[0] ?? "{}");
    const envelope = JSON.parse(output);
    expect(envelope.result.updated).toEqual(["CLAUDE.md"]);
    expect(envelope.result.count.updated).toBe(1);
  });
});

describe("coverage: instructions check", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.values(mocks).forEach((m) => m.mockReset());

    mocks.getInstalledProviders.mockReturnValue([providerA]);
    mocks.getAllProviders.mockReturnValue([providerA]);
    mocks.getProvider.mockImplementation((name: string) =>
      name === "claude-code" ? providerA : undefined,
    );
  });

  // Lines 102-108: human output for "missing" and "none" statuses
  it("prints human-readable output with missing status", async () => {
    mocks.checkAllInjections.mockResolvedValue([
      { provider: "claude-code", file: "CLAUDE.md", status: "missing", fileExists: false },
    ]);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerInstructionsCheck(program);

    await program.parseAsync(["node", "test", "check", "--agent", "claude-code", "--human"]);

    const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
    expect(output).toContain("missing");
  });

  it("prints human-readable output with none status", async () => {
    mocks.checkAllInjections.mockResolvedValue([
      { provider: "claude-code", file: "CLAUDE.md", status: "none", fileExists: true },
    ]);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerInstructionsCheck(program);

    await program.parseAsync(["node", "test", "check", "--agent", "claude-code", "--human"]);

    const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
    expect(output).toContain("no injection");
  });

  // Branch: format conflict
  it("exits with format conflict error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process-exit");
    }) as never);

    const program = new Command();
    registerInstructionsCheck(program);

    await expect(
      program.parseAsync(["node", "test", "check", "--json", "--human"]),
    ).rejects.toThrow("process-exit");

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // Branch: current and outdated statuses in human output (lines 94-96)
  it("prints human-readable output with current status", async () => {
    mocks.checkAllInjections.mockResolvedValue([
      { provider: "claude-code", file: "CLAUDE.md", status: "current", fileExists: true },
    ]);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerInstructionsCheck(program);

    await program.parseAsync(["node", "test", "check", "--agent", "claude-code", "--human"]);

    const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
    expect(output).toContain("current");
  });

  it("prints human-readable output with outdated status", async () => {
    mocks.checkAllInjections.mockResolvedValue([
      { provider: "claude-code", file: "CLAUDE.md", status: "outdated", fileExists: true },
    ]);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerInstructionsCheck(program);

    await program.parseAsync(["node", "test", "check", "--agent", "claude-code", "--human"]);

    const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
    expect(output).toContain("outdated");
  });

  // Lines 60-61: default provider resolution (no --all, no --agent)
  it("uses default installed providers when no --all or --agent given", async () => {
    mocks.checkAllInjections.mockResolvedValue([
      { provider: "claude-code", file: "CLAUDE.md", status: "current", fileExists: true },
    ]);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerInstructionsCheck(program);

    await program.parseAsync(["node", "test", "check"]);

    expect(mocks.getInstalledProviders).toHaveBeenCalled();
    expect(mocks.checkAllInjections).toHaveBeenCalled();
  });
});
