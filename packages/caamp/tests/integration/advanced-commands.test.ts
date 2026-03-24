import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "../../src/types.js";

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  getInstalledProviders: vi.fn(),
  getAllProviders: vi.fn(),
  getProvider: vi.fn(),
  selectProvidersByMinimumPriority: vi.fn(),
  detectMcpConfigConflicts: vi.fn(),
  applyMcpInstallWithPolicy: vi.fn(),
  installBatchWithRollback: vi.fn(),
  updateInstructionsSingleOperation: vi.fn(),
  configureProviderGlobalAndProject: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readFile: mocks.readFile,
}));

vi.mock("../../src/core/registry/detection.js", () => ({
  getInstalledProviders: mocks.getInstalledProviders,
}));

vi.mock("../../src/core/registry/providers.js", () => ({
  getAllProviders: mocks.getAllProviders,
  getProvider: mocks.getProvider,
}));

vi.mock("../../src/core/advanced/orchestration.js", () => ({
  selectProvidersByMinimumPriority: mocks.selectProvidersByMinimumPriority,
  detectMcpConfigConflicts: mocks.detectMcpConfigConflicts,
  applyMcpInstallWithPolicy: mocks.applyMcpInstallWithPolicy,
  installBatchWithRollback: mocks.installBatchWithRollback,
  updateInstructionsSingleOperation: mocks.updateInstructionsSingleOperation,
  configureProviderGlobalAndProject: mocks.configureProviderGlobalAndProject,
}));

import { registerAdvancedCommands } from "../../src/commands/advanced/index.js";

function makeProvider(id: string, priority: Provider["priority"] = "medium"): Provider {
  return {
    id,
    toolName: id,
    vendor: "test",
    agentFlag: id,
    aliases: [],
    pathGlobal: `/tmp/${id}`,
    pathProject: ".",
    instructFile: "AGENTS.md",
    configKey: "mcpServers",
    configFormat: "json",
    configPathGlobal: `/tmp/${id}/config.json`,
    configPathProject: `.config/${id}.json`,
    pathSkills: `/tmp/${id}/skills`,
    pathProjectSkills: `.skills/${id}`,
    detection: { methods: ["binary"], binary: id },
    supportedTransports: ["stdio", "http", "sse"],
    supportsHeaders: true,
    priority,
    status: "active",
    agentSkillsCompatible: true,
  };
}

function createProgram(): Command {
  const program = new Command();
  registerAdvancedCommands(program);
  return program;
}

function parseEnvelope(spy: ReturnType<typeof vi.spyOn>, callIndex = 0): Record<string, unknown> {
  return JSON.parse(String(spy.mock.calls[callIndex]?.[0] ?? "{}")) as Record<string, unknown>;
}

describe("integration: advanced command wrappers", () => {
  const alpha = makeProvider("alpha", "high");
  const beta = makeProvider("beta", "medium");

  beforeEach(() => {
    vi.restoreAllMocks();

    mocks.readFile.mockReset();
    mocks.getInstalledProviders.mockReset();
    mocks.getAllProviders.mockReset();
    mocks.getProvider.mockReset();
    mocks.selectProvidersByMinimumPriority.mockReset();
    mocks.detectMcpConfigConflicts.mockReset();
    mocks.applyMcpInstallWithPolicy.mockReset();
    mocks.installBatchWithRollback.mockReset();
    mocks.updateInstructionsSingleOperation.mockReset();
    mocks.configureProviderGlobalAndProject.mockReset();

    mocks.readFile.mockImplementation(async (path: string) => {
      if (path.includes("mcp")) {
        return JSON.stringify([{ serverName: "filesystem", config: { command: "npx" } }]);
      }
      if (path.includes("skills")) {
        return JSON.stringify([{ sourcePath: "./skills/demo", skillName: "demo" }]);
      }
      if (path.includes("content")) {
        return "instruction content from file";
      }
      throw new Error(`ENOENT: ${path}`);
    });

    mocks.getInstalledProviders.mockReturnValue([alpha, beta]);
    mocks.getAllProviders.mockReturnValue([alpha, beta]);
    mocks.getProvider.mockImplementation((id: string) => {
      if (id === "alpha") return alpha;
      if (id === "beta") return beta;
      return undefined;
    });

    mocks.selectProvidersByMinimumPriority.mockImplementation((providers: Provider[]) => providers);
    mocks.detectMcpConfigConflicts.mockResolvedValue([{ code: "existing-mismatch", providerId: "alpha" }]);
    mocks.applyMcpInstallWithPolicy.mockResolvedValue({
      conflicts: [],
      applied: [{ providerId: "alpha", serverName: "filesystem", scope: "project", success: true }],
      skipped: [],
    });
    mocks.installBatchWithRollback.mockResolvedValue({
      success: true,
      providerIds: ["alpha"],
      mcpApplied: 1,
      skillsApplied: 1,
      rollbackPerformed: false,
      rollbackErrors: [],
    });
    mocks.updateInstructionsSingleOperation.mockResolvedValue({
      updatedFiles: 1,
      actions: [{ file: "/repo/AGENTS.md", action: "updated", providers: ["alpha"], configFormats: ["json"] }],
    });
    mocks.configureProviderGlobalAndProject.mockResolvedValue({
      providerId: "alpha",
      configPaths: { global: "/tmp/alpha/config.json", project: "/repo/.config/alpha.json" },
      mcp: {
        global: [{ serverName: "g", success: true }],
        project: [{ serverName: "p", success: true }],
      },
      instructions: {
        global: { size: 12 },
        project: { size: 20 },
      },
    });
  });

  it("registers all advanced subcommands", () => {
    const program = createProgram();
    const advanced = program.commands.find((command) => command.name() === "advanced");
    const names = (advanced?.commands ?? []).map((command) => command.name());

    expect(names).toEqual([
      "providers",
      "batch",
      "conflicts",
      "apply",
      "instructions",
      "configure",
    ]);
  });

  it("runs providers wrapper successfully", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();

    await program.parseAsync(["node", "test", "advanced", "providers", "--agent", "alpha", "--min-tier", "medium"]);

    expect(mocks.selectProvidersByMinimumPriority).toHaveBeenCalledWith([alpha], "medium");
    const envelope = parseEnvelope(logSpy);
    expect(envelope["success"]).toBe(true);
  });

  it("fails providers wrapper on invalid tier and exits", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process-exit:1");
    }) as never);
    const program = createProgram();

    await expect(
      program.parseAsync(["node", "test", "advanced", "providers", "--agent", "alpha", "--min-tier", "urgent"]),
    ).rejects.toThrow("process-exit:1");

    expect(exitSpy).toHaveBeenCalledWith(1);
    const envelope = parseEnvelope(errorSpy);
    expect(envelope["success"]).toBe(false);
    expect((envelope["error"] as { message: string }).message).toContain("Invalid tier");
  });

  it("runs conflicts wrapper and emits detail payload", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();

    await program.parseAsync([
      "node",
      "test",
      "advanced",
      "conflicts",
      "--agent",
      "alpha",
      "--mcp-file",
      "/tmp/mcp.json",
      "--details",
    ]);

    expect(mocks.detectMcpConfigConflicts).toHaveBeenCalledWith(
      [alpha],
      [{ serverName: "filesystem", config: { command: "npx" } }],
      undefined,
    );
    const envelope = parseEnvelope(logSpy);
    expect(envelope["success"]).toBe(true);
  });

  it("fails conflicts wrapper when no providers are selected", async () => {
    mocks.selectProvidersByMinimumPriority.mockReturnValueOnce([]);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process-exit:1");
    }) as never);
    const program = createProgram();

    await expect(
      program.parseAsync(["node", "test", "advanced", "conflicts", "--agent", "alpha", "--mcp-file", "/tmp/mcp.json"]),
    ).rejects.toThrow("process-exit:1");

    expect(exitSpy).toHaveBeenCalledWith(1);
    const envelope = parseEnvelope(errorSpy);
    expect((envelope["error"] as { message: string }).message).toContain("No target providers");
  });

  it("runs apply wrapper with policy", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();

    await program.parseAsync([
      "node",
      "test",
      "advanced",
      "apply",
      "--agent",
      "alpha",
      "--mcp-file",
      "/tmp/mcp.json",
      "--policy",
      "skip",
    ]);

    expect(mocks.applyMcpInstallWithPolicy).toHaveBeenCalledWith(
      [alpha],
      [{ serverName: "filesystem", config: { command: "npx" } }],
      "skip",
      undefined,
    );
    const envelope = parseEnvelope(logSpy);
    expect(envelope["success"]).toBe(true);
  });

  it("fails apply wrapper on invalid policy", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process-exit:1");
    }) as never);
    const program = createProgram();

    await expect(
      program.parseAsync([
        "node",
        "test",
        "advanced",
        "apply",
        "--agent",
        "alpha",
        "--mcp-file",
        "/tmp/mcp.json",
        "--policy",
        "invalid",
      ]),
    ).rejects.toThrow("process-exit:1");

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mocks.applyMcpInstallWithPolicy).not.toHaveBeenCalled();
    const envelope = parseEnvelope(errorSpy);
    expect((envelope["error"] as { message: string }).message).toContain("Invalid policy");
  });

  it("runs batch wrapper with MCP and skill operations", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();

    await program.parseAsync([
      "node",
      "test",
      "advanced",
      "batch",
      "--agent",
      "alpha",
      "--mcp-file",
      "/tmp/mcp.json",
      "--skills-file",
      "/tmp/skills.json",
      "--project-dir",
      "/repo",
    ]);

    expect(mocks.installBatchWithRollback).toHaveBeenCalledWith({
      providers: [alpha],
      minimumPriority: "low",
      mcp: [{ serverName: "filesystem", config: { command: "npx" } }],
      skills: [{ sourcePath: "./skills/demo", skillName: "demo" }],
      projectDir: "/repo",
    });
    const envelope = parseEnvelope(logSpy);
    expect(envelope["success"]).toBe(true);
  });

  it("fails batch wrapper when no operation inputs are provided", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process-exit:1");
    }) as never);
    const program = createProgram();

    await expect(
      program.parseAsync(["node", "test", "advanced", "batch", "--agent", "alpha"]),
    ).rejects.toThrow("process-exit:1");

    expect(exitSpy).toHaveBeenCalledWith(1);
    const envelope = parseEnvelope(errorSpy);
    expect((envelope["error"] as { message: string }).message).toContain("No operations provided");
  });

  it("runs instructions wrapper with file content", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();

    await program.parseAsync([
      "node",
      "test",
      "advanced",
      "instructions",
      "--agent",
      "alpha",
      "--scope",
      "global",
      "--content-file",
      "/tmp/content.txt",
      "--details",
    ]);

    expect(mocks.updateInstructionsSingleOperation).toHaveBeenCalledWith(
      [alpha],
      "instruction content from file",
      "global",
      undefined,
    );
    const envelope = parseEnvelope(logSpy);
    expect(envelope["success"]).toBe(true);
  });

  it("fails instructions wrapper for invalid scope", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process-exit:1");
    }) as never);
    const program = createProgram();

    await expect(
      program.parseAsync([
        "node",
        "test",
        "advanced",
        "instructions",
        "--agent",
        "alpha",
        "--scope",
        "team",
        "--content",
        "inline",
      ]),
    ).rejects.toThrow("process-exit:1");

    expect(exitSpy).toHaveBeenCalledWith(1);
    const envelope = parseEnvelope(errorSpy);
    expect((envelope["error"] as { message: string }).message).toContain("Invalid scope");
  });

  it("runs configure wrapper with scoped instructions", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();

    await program.parseAsync([
      "node",
      "test",
      "advanced",
      "configure",
      "--agent",
      "alpha",
      "--global-mcp-file",
      "/tmp/global-mcp.json",
      "--project-mcp-file",
      "/tmp/project-mcp.json",
      "--instruction-global",
      "global-inline",
      "--instruction-project-file",
      "/tmp/content.txt",
    ]);

    expect(mocks.configureProviderGlobalAndProject).toHaveBeenCalledWith(alpha, {
      globalMcp: [{ serverName: "filesystem", config: { command: "npx" } }],
      projectMcp: [{ serverName: "filesystem", config: { command: "npx" } }],
      instructionContent: {
        global: "global-inline",
        project: "instruction content from file",
      },
      projectDir: undefined,
    });

    const envelope = parseEnvelope(logSpy);
    expect(envelope["success"]).toBe(true);
  });

  it("fails configure wrapper for unknown provider", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process-exit:1");
    }) as never);
    const program = createProgram();

    await expect(
      program.parseAsync([
        "node",
        "test",
        "advanced",
        "configure",
        "--agent",
        "ghost",
        "--instruction",
        "use this",
      ]),
    ).rejects.toThrow("process-exit:1");

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mocks.configureProviderGlobalAndProject).not.toHaveBeenCalled();
    const envelope = parseEnvelope(errorSpy);
    expect((envelope["error"] as { message: string }).message).toContain("Unknown provider: ghost");
  });

  // ── apply.ts uncovered paths ──────────────────────────────────────────

  it("apply with --details flag emits full result", async () => {
    const fullResult = {
      conflicts: [],
      applied: [{ providerId: "alpha", serverName: "filesystem", scope: "project", success: true }],
      skipped: [],
    };
    mocks.applyMcpInstallWithPolicy.mockResolvedValueOnce(fullResult);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();

    await program.parseAsync([
      "node",
      "test",
      "advanced",
      "apply",
      "--agent",
      "alpha",
      "--mcp-file",
      "/tmp/mcp.json",
      "--policy",
      "skip",
      "--details",
    ]);

    const envelope = parseEnvelope(logSpy);
    expect(envelope["success"]).toBe(true);
    const result = envelope["result"] as Record<string, unknown>;
    // --details returns the full orchestration result in data, not summary counts
    const data = result["data"] as Record<string, unknown>;
    expect(data).toHaveProperty("applied");
    expect(data).toHaveProperty("conflicts");
    expect(data).toHaveProperty("skipped");
    expect(Array.isArray(data["applied"])).toBe(true);
  });

  it("apply with fail policy and conflicts", async () => {
    mocks.applyMcpInstallWithPolicy.mockResolvedValueOnce({
      conflicts: [{ code: "existing-mismatch", providerId: "alpha" }],
      applied: [],
      skipped: [],
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process-exit:1");
    }) as never);
    const program = createProgram();

    await expect(
      program.parseAsync([
        "node",
        "test",
        "advanced",
        "apply",
        "--agent",
        "alpha",
        "--mcp-file",
        "/tmp/mcp.json",
        "--policy",
        "fail",
      ]),
    ).rejects.toThrow("process-exit:1");

    expect(exitSpy).toHaveBeenCalledWith(1);
    const envelope = parseEnvelope(errorSpy);
    expect(envelope["success"]).toBe(false);
    expect((envelope["error"] as { message: string }).message).toContain("Conflicts detected and policy is set to fail");
  });

  it("apply with failed writes", async () => {
    mocks.applyMcpInstallWithPolicy.mockResolvedValueOnce({
      conflicts: [],
      applied: [{ providerId: "alpha", serverName: "filesystem", scope: "project", success: false }],
      skipped: [],
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process-exit:1");
    }) as never);
    const program = createProgram();

    await expect(
      program.parseAsync([
        "node",
        "test",
        "advanced",
        "apply",
        "--agent",
        "alpha",
        "--mcp-file",
        "/tmp/mcp.json",
        "--policy",
        "skip",
      ]),
    ).rejects.toThrow("process-exit:1");

    expect(exitSpy).toHaveBeenCalledWith(1);
    const envelope = parseEnvelope(errorSpy);
    expect(envelope["success"]).toBe(false);
    expect((envelope["error"] as { message: string }).message).toContain("One or more MCP writes failed");
  });

  it("apply with no providers exits", async () => {
    mocks.selectProvidersByMinimumPriority.mockReturnValueOnce([]);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process-exit:1");
    }) as never);
    const program = createProgram();

    await expect(
      program.parseAsync([
        "node",
        "test",
        "advanced",
        "apply",
        "--agent",
        "alpha",
        "--mcp-file",
        "/tmp/mcp.json",
      ]),
    ).rejects.toThrow("process-exit:1");

    expect(exitSpy).toHaveBeenCalledWith(1);
    const envelope = parseEnvelope(errorSpy);
    expect(envelope["success"]).toBe(false);
    expect((envelope["error"] as { message: string }).message).toContain("No target providers resolved");
  });

  // ── instructions.ts uncovered paths ───────────────────────────────────

  it("instructions with inline --content", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();

    await program.parseAsync([
      "node",
      "test",
      "advanced",
      "instructions",
      "--agent",
      "alpha",
      "--scope",
      "global",
      "--content",
      "direct text",
    ]);

    expect(mocks.updateInstructionsSingleOperation).toHaveBeenCalledWith(
      [alpha],
      "direct text",
      "global",
      undefined,
    );
    const envelope = parseEnvelope(logSpy);
    expect(envelope["success"]).toBe(true);
  });

  it("instructions fails when neither content nor content-file provided", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process-exit:1");
    }) as never);
    const program = createProgram();

    await expect(
      program.parseAsync([
        "node",
        "test",
        "advanced",
        "instructions",
        "--agent",
        "alpha",
        "--scope",
        "project",
      ]),
    ).rejects.toThrow("process-exit:1");

    expect(exitSpy).toHaveBeenCalledWith(1);
    const envelope = parseEnvelope(errorSpy);
    expect(envelope["success"]).toBe(false);
    expect((envelope["error"] as { message: string }).message).toContain("Instruction content is required");
  });

  it("instructions with --scope project --project-dir", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();

    await program.parseAsync([
      "node",
      "test",
      "advanced",
      "instructions",
      "--agent",
      "alpha",
      "--scope",
      "project",
      "--content",
      "some instructions",
      "--project-dir",
      "/my/project",
    ]);

    expect(mocks.updateInstructionsSingleOperation).toHaveBeenCalledWith(
      [alpha],
      "some instructions",
      "project",
      "/my/project",
    );
    const envelope = parseEnvelope(logSpy);
    expect(envelope["success"]).toBe(true);
  });

  // ── batch.ts uncovered paths ──────────────────────────────────────────

  it("batch reports rollback when it occurs", async () => {
    mocks.installBatchWithRollback.mockResolvedValueOnce({
      success: false,
      providerIds: ["alpha"],
      mcpApplied: 0,
      skillsApplied: 0,
      rollbackPerformed: true,
      rollbackErrors: [],
      error: "MCP write failed mid-batch",
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process-exit:1");
    }) as never);
    const program = createProgram();

    await expect(
      program.parseAsync([
        "node",
        "test",
        "advanced",
        "batch",
        "--agent",
        "alpha",
        "--mcp-file",
        "/tmp/mcp.json",
        "--project-dir",
        "/repo",
      ]),
    ).rejects.toThrow("process-exit:1");

    expect(exitSpy).toHaveBeenCalledWith(1);
    const envelope = parseEnvelope(errorSpy);
    expect(envelope["success"]).toBe(false);
    expect((envelope["error"] as { message: string }).message).toBe("MCP write failed mid-batch");
  });

  it("batch with only mcp-file (no skills-file)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();

    await program.parseAsync([
      "node",
      "test",
      "advanced",
      "batch",
      "--agent",
      "alpha",
      "--mcp-file",
      "/tmp/mcp.json",
    ]);

    expect(mocks.installBatchWithRollback).toHaveBeenCalledWith({
      providers: [alpha],
      minimumPriority: "low",
      mcp: [{ serverName: "filesystem", config: { command: "npx" } }],
      skills: [],
      projectDir: undefined,
    });
    const envelope = parseEnvelope(logSpy);
    expect(envelope["success"]).toBe(true);
  });

  it("batch with only skills-file (no mcp-file)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();

    await program.parseAsync([
      "node",
      "test",
      "advanced",
      "batch",
      "--agent",
      "alpha",
      "--skills-file",
      "/tmp/skills.json",
    ]);

    expect(mocks.installBatchWithRollback).toHaveBeenCalledWith({
      providers: [alpha],
      minimumPriority: "low",
      mcp: [],
      skills: [{ sourcePath: "./skills/demo", skillName: "demo" }],
      projectDir: undefined,
    });
    const envelope = parseEnvelope(logSpy);
    expect(envelope["success"]).toBe(true);
  });

  // ── common.ts uncovered paths ─────────────────────────────────────────

  it("resolves providers via --all flag", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = createProgram();

    await program.parseAsync([
      "node",
      "test",
      "advanced",
      "apply",
      "--all",
      "--mcp-file",
      "/tmp/mcp.json",
      "--policy",
      "skip",
    ]);

    expect(mocks.getAllProviders).toHaveBeenCalled();
    expect(mocks.getInstalledProviders).not.toHaveBeenCalled();
    const envelope = parseEnvelope(logSpy);
    expect(envelope["success"]).toBe(true);
  });

  it("handles getProvider returning undefined", async () => {
    mocks.getProvider.mockImplementation((id: string) => {
      if (id === "alpha") return alpha;
      return undefined;
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process-exit:1");
    }) as never);
    const program = createProgram();

    await expect(
      program.parseAsync([
        "node",
        "test",
        "advanced",
        "apply",
        "--agent",
        "alpha",
        "--agent",
        "nonexistent",
        "--mcp-file",
        "/tmp/mcp.json",
      ]),
    ).rejects.toThrow("process-exit:1");

    expect(exitSpy).toHaveBeenCalledWith(1);
    const envelope = parseEnvelope(errorSpy);
    expect(envelope["success"]).toBe(false);
    expect((envelope["error"] as { message: string }).message).toContain("nonexistent");
  });
});
