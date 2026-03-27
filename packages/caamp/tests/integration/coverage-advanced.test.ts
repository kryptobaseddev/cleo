/**
 * Coverage tests for advanced command branches (common.ts, configure.ts, batch.ts,
 * conflicts.ts, instructions.ts, lafs.ts, providers.ts).
 */
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
  capabilities: { skills: { agentsGlobalPath: null, agentsProjectPath: null, precedence: "vendor-only" }, hooks: { supported: [], hookConfigPath: null, hookFormat: null }, spawn: { supportsSubagents: false, supportsProgrammaticSpawn: false, supportsInterAgentComms: false, supportsParallelSpawn: false, spawnMechanism: null } },
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

describe("coverage: advanced commands", () => {
  const alpha = makeProvider("alpha", "high");
  const beta = makeProvider("beta", "medium");

  beforeEach(() => {
    vi.restoreAllMocks();
    Object.values(mocks).forEach((m) => m.mockReset());

    mocks.readFile.mockImplementation(async (path: string) => {
      if (path.includes("mcp") || path.includes("global-mcp") || path.includes("project-mcp")) {
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
    mocks.detectMcpConfigConflicts.mockResolvedValue([]);
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

  // ── common.ts ──────────────────────────────────────────────────────────

  it("readSkillOperations: invalid skillName", async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify([{ sourcePath: "./skills/demo", skillName: "" }]));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("x"); }) as never);

    await expect(
      createProgram().parseAsync(["node", "test", "advanced", "batch", "--agent", "alpha", "--skills-file", "/tmp/skills.json"]),
    ).rejects.toThrow("x");

    expect((parseEnvelope(errorSpy)["error"] as { message: string }).message).toContain("Invalid skillName");
  });

  it("readSkillOperations: invalid isGlobal", async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify([{ sourcePath: "./skills/demo", skillName: "demo", isGlobal: "true" }]));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("x"); }) as never);

    await expect(
      createProgram().parseAsync(["node", "test", "advanced", "batch", "--agent", "alpha", "--skills-file", "/tmp/skills.json"]),
    ).rejects.toThrow("x");

    expect((parseEnvelope(errorSpy)["error"] as { message: string }).message).toContain("Invalid isGlobal");
  });

  it("readMcpOperations: non-array JSON", async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify({ serverName: "test" }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("x"); }) as never);

    await expect(
      createProgram().parseAsync(["node", "test", "advanced", "conflicts", "--agent", "alpha", "--mcp-file", "/tmp/mcp.json"]),
    ).rejects.toThrow("x");

    expect((parseEnvelope(errorSpy)["error"] as { message: string }).message).toContain("must be a JSON array");
  });

  it("readMcpOperations: non-object item", async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify(["string"]));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("x"); }) as never);

    await expect(
      createProgram().parseAsync(["node", "test", "advanced", "conflicts", "--agent", "alpha", "--mcp-file", "/tmp/mcp.json"]),
    ).rejects.toThrow("x");

    expect((parseEnvelope(errorSpy)["error"] as { message: string }).message).toContain("Invalid MCP operation at index 0");
  });

  it("readMcpOperations: empty serverName", async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify([{ serverName: "", config: {} }]));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("x"); }) as never);

    await expect(
      createProgram().parseAsync(["node", "test", "advanced", "conflicts", "--agent", "alpha", "--mcp-file", "/tmp/mcp.json"]),
    ).rejects.toThrow("x");

    expect((parseEnvelope(errorSpy)["error"] as { message: string }).message).toContain("Invalid serverName");
  });

  it("readMcpOperations: invalid config (string)", async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify([{ serverName: "test", config: "string" }]));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("x"); }) as never);

    await expect(
      createProgram().parseAsync(["node", "test", "advanced", "conflicts", "--agent", "alpha", "--mcp-file", "/tmp/mcp.json"]),
    ).rejects.toThrow("x");

    expect((parseEnvelope(errorSpy)["error"] as { message: string }).message).toContain("Invalid config");
  });

  it("readMcpOperations: config as array", async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify([{ serverName: "test", config: [1, 2] }]));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("x"); }) as never);

    await expect(
      createProgram().parseAsync(["node", "test", "advanced", "conflicts", "--agent", "alpha", "--mcp-file", "/tmp/mcp.json"]),
    ).rejects.toThrow("x");

    expect((parseEnvelope(errorSpy)["error"] as { message: string }).message).toContain("Invalid config");
  });

  it("readMcpOperations: invalid scope", async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify([{ serverName: "test", config: { command: "npx" }, scope: "team" }]));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("x"); }) as never);

    await expect(
      createProgram().parseAsync(["node", "test", "advanced", "conflicts", "--agent", "alpha", "--mcp-file", "/tmp/mcp.json"]),
    ).rejects.toThrow("x");

    expect((parseEnvelope(errorSpy)["error"] as { message: string }).message).toContain("Invalid scope");
  });

  it("readMcpOperations: valid operation with scope field", async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify([{ serverName: "test", config: { command: "npx" }, scope: "global" }]));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await createProgram().parseAsync(["node", "test", "advanced", "conflicts", "--agent", "alpha", "--mcp-file", "/tmp/mcp.json"]);

    expect(parseEnvelope(logSpy)["success"]).toBe(true);
  });

  it("readSkillOperations: non-array", async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify({ sourcePath: "x" }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("x"); }) as never);

    await expect(
      createProgram().parseAsync(["node", "test", "advanced", "batch", "--agent", "alpha", "--skills-file", "/tmp/skills.json"]),
    ).rejects.toThrow("x");

    expect((parseEnvelope(errorSpy)["error"] as { message: string }).message).toContain("must be a JSON array");
  });

  it("readSkillOperations: non-object item", async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify([42]));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("x"); }) as never);

    await expect(
      createProgram().parseAsync(["node", "test", "advanced", "batch", "--agent", "alpha", "--skills-file", "/tmp/skills.json"]),
    ).rejects.toThrow("x");

    expect((parseEnvelope(errorSpy)["error"] as { message: string }).message).toContain("Invalid skill operation");
  });

  it("readSkillOperations: empty sourcePath", async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify([{ sourcePath: "", skillName: "demo" }]));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("x"); }) as never);

    await expect(
      createProgram().parseAsync(["node", "test", "advanced", "batch", "--agent", "alpha", "--skills-file", "/tmp/skills.json"]),
    ).rejects.toThrow("x");

    expect((parseEnvelope(errorSpy)["error"] as { message: string }).message).toContain("Invalid sourcePath");
  });

  it("readSkillOperations: with isGlobal=true", async () => {
    mocks.readFile.mockImplementation(async (path: string) => {
      if (path.includes("skills")) return JSON.stringify([{ sourcePath: "./s", skillName: "s", isGlobal: true }]);
      if (path.includes("mcp")) return JSON.stringify([{ serverName: "fs", config: { command: "npx" } }]);
      throw new Error("ENOENT");
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await createProgram().parseAsync(["node", "test", "advanced", "batch", "--agent", "alpha", "--skills-file", "/tmp/skills.json"]);
    expect(parseEnvelope(logSpy)["success"]).toBe(true);
  });

  it("readTextInput: both content and content-file", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("x"); }) as never);

    await expect(
      createProgram().parseAsync([
        "node", "test", "advanced", "instructions",
        "--agent", "alpha", "--scope", "global",
        "--content", "inline", "--content-file", "/tmp/content.txt",
      ]),
    ).rejects.toThrow("x");

    expect((parseEnvelope(errorSpy)["error"] as { message: string }).message).toContain("either inline content or a content file");
  });

  it("readTextInput: unreadable content file", async () => {
    mocks.readFile.mockRejectedValue(new Error("ENOENT"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("x"); }) as never);

    await expect(
      createProgram().parseAsync([
        "node", "test", "advanced", "instructions",
        "--agent", "alpha", "--scope", "global",
        "--content-file", "/tmp/bad.txt",
      ]),
    ).rejects.toThrow("x");

    expect((parseEnvelope(errorSpy)["error"] as { message: string }).message).toContain("Failed to read content file");
  });

  it("readJsonFile: file read failure", async () => {
    mocks.readFile.mockRejectedValue(new Error("EACCES"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("x"); }) as never);

    await expect(
      createProgram().parseAsync(["node", "test", "advanced", "conflicts", "--agent", "alpha", "--mcp-file", "/tmp/bad.json"]),
    ).rejects.toThrow("x");

    expect((parseEnvelope(errorSpy)["error"] as { message: string }).message).toContain("Failed to read JSON file");
  });

  // ── configure.ts ───────────────────────────────────────────────────────

  it("configure: no operations provided", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("x"); }) as never);

    await expect(
      createProgram().parseAsync(["node", "test", "advanced", "configure", "--agent", "alpha"]),
    ).rejects.toThrow("x");

    expect((parseEnvelope(errorSpy)["error"] as { message: string }).message).toContain("No configuration operations");
  });

  it("configure: MCP global write failures", async () => {
    mocks.configureProviderGlobalAndProject.mockResolvedValue({
      providerId: "alpha",
      configPaths: { global: "/g", project: "/p" },
      mcp: { global: [{ serverName: "g", success: false }], project: [] },
      instructions: {},
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("x"); }) as never);

    await expect(
      createProgram().parseAsync(["node", "test", "advanced", "configure", "--agent", "alpha", "--global-mcp-file", "/tmp/global-mcp.json"]),
    ).rejects.toThrow("x");

    expect((parseEnvelope(errorSpy)["error"] as { message: string }).message).toContain("MCP writes failed");
  });

  it("configure: MCP project write failures", async () => {
    mocks.configureProviderGlobalAndProject.mockResolvedValue({
      providerId: "alpha",
      configPaths: { global: "/g", project: "/p" },
      mcp: { global: [], project: [{ serverName: "p", success: false }] },
      instructions: {},
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("x"); }) as never);

    await expect(
      createProgram().parseAsync(["node", "test", "advanced", "configure", "--agent", "alpha", "--project-mcp-file", "/tmp/project-mcp.json"]),
    ).rejects.toThrow("x");

    expect((parseEnvelope(errorSpy)["error"] as { message: string }).message).toContain("MCP writes failed");
  });

  it("configure: shared --instruction flag (string mode)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await createProgram().parseAsync(["node", "test", "advanced", "configure", "--agent", "alpha", "--instruction", "shared"]);

    expect(mocks.configureProviderGlobalAndProject).toHaveBeenCalledWith(alpha, expect.objectContaining({
      instructionContent: "shared",
    }));
    const result = parseEnvelope(logSpy)["result"] as Record<string, unknown>;
    expect((result["constraints"] as Record<string, unknown>)["instructionMode"]).toBe("shared");
  });

  it("configure: --instruction-file flag", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await createProgram().parseAsync(["node", "test", "advanced", "configure", "--agent", "alpha", "--instruction-file", "/tmp/content.txt"]);

    expect(mocks.configureProviderGlobalAndProject).toHaveBeenCalledWith(alpha, expect.objectContaining({
      instructionContent: "instruction content from file",
    }));
  });

  it("configure: scoped global+project instructions", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await createProgram().parseAsync([
      "node", "test", "advanced", "configure",
      "--agent", "alpha",
      "--instruction-global-file", "/tmp/content.txt",
      "--instruction-project", "project inline",
    ]);

    expect(mocks.configureProviderGlobalAndProject).toHaveBeenCalledWith(alpha, expect.objectContaining({
      instructionContent: { global: "instruction content from file", project: "project inline" },
    }));
    const result = parseEnvelope(logSpy)["result"] as Record<string, unknown>;
    expect((result["constraints"] as Record<string, unknown>)["instructionMode"]).toBe("scoped");
  });

  it("configure: instructionMode 'none' with only MCP", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await createProgram().parseAsync(["node", "test", "advanced", "configure", "--agent", "alpha", "--global-mcp-file", "/tmp/global-mcp.json"]);

    const result = parseEnvelope(logSpy)["result"] as Record<string, unknown>;
    expect((result["constraints"] as Record<string, unknown>)["instructionMode"]).toBe("none");
  });

  it("configure: --details returns full result", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await createProgram().parseAsync([
      "node", "test", "advanced", "configure",
      "--agent", "alpha", "--instruction", "test", "--details",
    ]);

    const result = parseEnvelope(logSpy)["result"] as Record<string, unknown>;
    expect((result["data"] as Record<string, unknown>)).toHaveProperty("providerId");
  });

  it("configure: --project-dir is passed", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await createProgram().parseAsync([
      "node", "test", "advanced", "configure",
      "--agent", "alpha", "--instruction", "test", "--project-dir", "/custom",
    ]);

    expect(mocks.configureProviderGlobalAndProject).toHaveBeenCalledWith(alpha, expect.objectContaining({
      projectDir: "/custom",
    }));
  });

  // ── batch.ts ───────────────────────────────────────────────────────────

  it("batch: no providers resolved", async () => {
    mocks.selectProvidersByMinimumPriority.mockReturnValueOnce([]);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("x"); }) as never);

    await expect(
      createProgram().parseAsync(["node", "test", "advanced", "batch", "--agent", "alpha", "--mcp-file", "/tmp/mcp.json"]),
    ).rejects.toThrow("x");

    expect((parseEnvelope(errorSpy)["error"] as { message: string }).message).toContain("No target providers");
  });

  it("batch: --details returns full result", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await createProgram().parseAsync([
      "node", "test", "advanced", "batch",
      "--agent", "alpha", "--mcp-file", "/tmp/mcp.json", "--details",
    ]);

    const result = parseEnvelope(logSpy)["result"] as Record<string, unknown>;
    expect((result["data"] as Record<string, unknown>)).toHaveProperty("success");
  });

  // ── conflicts.ts ──────────────────────────────────────────────────────

  it("conflicts: without --details returns summary with countByCode", async () => {
    mocks.detectMcpConfigConflicts.mockResolvedValue([
      { code: "existing-mismatch", providerId: "alpha" },
      { code: "existing-mismatch", providerId: "beta" },
    ]);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await createProgram().parseAsync([
      "node", "test", "advanced", "conflicts",
      "--agent", "alpha", "--mcp-file", "/tmp/mcp.json",
    ]);

    const result = parseEnvelope(logSpy)["result"] as Record<string, unknown>;
    const data = result["data"] as Record<string, unknown>;
    expect(data["conflictCount"]).toBe(2);
    expect(data["countByCode"]).toBeDefined();
    expect(data["sample"]).toBeDefined();
  });

  // ── instructions.ts ───────────────────────────────────────────────────

  it("instructions: no providers resolved", async () => {
    mocks.selectProvidersByMinimumPriority.mockReturnValueOnce([]);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("x"); }) as never);

    await expect(
      createProgram().parseAsync([
        "node", "test", "advanced", "instructions",
        "--agent", "alpha", "--scope", "project", "--content", "test",
      ]),
    ).rejects.toThrow("x");

    expect((parseEnvelope(errorSpy)["error"] as { message: string }).message).toContain("No target providers");
  });

  // ── lafs.ts branches ──────────────────────────────────────────────────

  it("lafs: emitError for non-Error thrown value (line 128)", async () => {
    mocks.installBatchWithRollback.mockImplementation(async () => {
      throw "raw string error";
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("x"); }) as never);

    await expect(
      createProgram().parseAsync(["node", "test", "advanced", "batch", "--agent", "alpha", "--mcp-file", "/tmp/mcp.json"]),
    ).rejects.toThrow("x");

    const envelope = parseEnvelope(errorSpy);
    const error = envelope["error"] as { code: string; message: string };
    expect(error.code).toBe("E_INTERNAL_UNEXPECTED");
    expect(error.message).toBe("raw string error");
  });

  // ── providers.ts (advanced) ───────────────────────────────────────────

  it("providers: --details returns full provider objects", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await createProgram().parseAsync([
      "node", "test", "advanced", "providers",
      "--agent", "alpha", "--min-tier", "high", "--details",
    ]);

    const result = parseEnvelope(logSpy)["result"] as Record<string, unknown>;
    const data = result["data"] as unknown[];
    expect((data[0] as Record<string, unknown>)).toHaveProperty("toolName");
  });

  // Line 32: providers with --all flag sets selectionMode to "registry"
  it("providers: --all flag sets selectionMode to registry", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await createProgram().parseAsync([
      "node", "test", "advanced", "providers", "--all",
    ]);

    const result = parseEnvelope(logSpy)["result"] as Record<string, unknown>;
    expect((result["constraints"] as Record<string, unknown>)["selectionMode"]).toBe("registry");
  });

  // ── lafs.ts inferErrorCategory branches (lines 58-62) ─────────────────

  // These branches are tested via LAFSCommandError constructor with codes containing AUTH, PERMISSION, etc.
  // We need to trigger errors with these codes.

  it("lafs: inferErrorCategory handles AUTH code", async () => {
    // Simulate an error with AUTH in the code via resolveProviders failure
    mocks.getProvider.mockReturnValue(undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("x"); }) as never);

    // We can't easily trigger an AUTH error from CLI, so test via direct import
    const { LAFSCommandError, emitError } = await import("../../src/commands/advanced/lafs.js");

    const authErr = new LAFSCommandError("E_AUTH_FAILED", "Auth failed", "Re-authenticate");
    expect(authErr.category).toBe("AUTH");

    const permErr = new LAFSCommandError("E_PERMISSION_DENIED", "Denied", "Check perms");
    expect(permErr.category).toBe("PERMISSION");

    const rateErr = new LAFSCommandError("E_RATE_LIMIT_HIT", "Rate limited", "Wait");
    expect(rateErr.category).toBe("RATE_LIMIT");

    const migErr = new LAFSCommandError("E_MIGRATION_REQUIRED", "Need migration", "Migrate");
    expect(migErr.category).toBe("MIGRATION");

    const contractErr = new LAFSCommandError("E_CONTRACT_VIOLATION", "Contract", "Fix");
    expect(contractErr.category).toBe("CONTRACT");

    // Also test the INTERNAL fallback
    const internalErr = new LAFSCommandError("E_UNKNOWN_THING", "Unknown", "Check logs");
    expect(internalErr.category).toBe("INTERNAL");
  });

  // ── batch.ts line 64: batch failed with error message ──────────────────

  it("batch: failed with specific error message", async () => {
    mocks.installBatchWithRollback.mockResolvedValue({
      success: false,
      error: "Specific rollback failure",
      providerIds: [],
      mcpApplied: 0,
      skillsApplied: 0,
      rollbackPerformed: true,
      rollbackErrors: [],
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("x"); }) as never);

    await expect(
      createProgram().parseAsync(["node", "test", "advanced", "batch", "--agent", "alpha", "--mcp-file", "/tmp/mcp.json"]),
    ).rejects.toThrow("x");

    const envelope = parseEnvelope(errorSpy);
    expect((envelope["error"] as { message: string }).message).toBe("Specific rollback failure");
  });

  it("batch: failed without error message uses default", async () => {
    mocks.installBatchWithRollback.mockResolvedValue({
      success: false,
      providerIds: [],
      mcpApplied: 0,
      skillsApplied: 0,
      rollbackPerformed: true,
      rollbackErrors: [],
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("x"); }) as never);

    await expect(
      createProgram().parseAsync(["node", "test", "advanced", "batch", "--agent", "alpha", "--mcp-file", "/tmp/mcp.json"]),
    ).rejects.toThrow("x");

    const envelope = parseEnvelope(errorSpy);
    expect((envelope["error"] as { message: string }).message).toBe("Batch operation failed.");
  });

  // ── configure.ts: only global instruction (no project) ────────────────

  it("configure: only global instruction provided (no project)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await createProgram().parseAsync([
      "node", "test", "advanced", "configure",
      "--agent", "alpha",
      "--instruction-global", "global only text",
    ]);

    expect(mocks.configureProviderGlobalAndProject).toHaveBeenCalledWith(alpha, expect.objectContaining({
      instructionContent: { global: "global only text" },
    }));
  });

  it("configure: only project instruction provided (no global)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await createProgram().parseAsync([
      "node", "test", "advanced", "configure",
      "--agent", "alpha",
      "--instruction-project", "project only text",
    ]);

    expect(mocks.configureProviderGlobalAndProject).toHaveBeenCalledWith(alpha, expect.objectContaining({
      instructionContent: { project: "project only text" },
    }));
  });

  // ── configure.ts lines 137-138: instructions.global/project undefined ──

  it("configure: result with undefined instructions", async () => {
    mocks.configureProviderGlobalAndProject.mockResolvedValue({
      providerId: "alpha",
      configPaths: { global: "/g", project: "/p" },
      mcp: { global: [], project: [] },
      instructions: {},  // global and project are undefined
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await createProgram().parseAsync([
      "node", "test", "advanced", "configure",
      "--agent", "alpha", "--instruction", "test",
    ]);

    const result = parseEnvelope(logSpy)["result"] as Record<string, unknown>;
    const data = result["data"] as Record<string, unknown>;
    const updates = data["instructionUpdates"] as Record<string, number>;
    expect(updates.global).toBe(0);
    expect(updates.project).toBe(0);
  });

  // ── common.ts line 70: non-Error thrown in readJsonFile ────────────────

  it("readJsonFile: handles non-Error thrown value", async () => {
    mocks.readFile.mockImplementation(async () => {
      throw "raw string error";  // non-Error
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("x"); }) as never);

    await expect(
      createProgram().parseAsync(["node", "test", "advanced", "conflicts", "--agent", "alpha", "--mcp-file", "/tmp/bad.json"]),
    ).rejects.toThrow("x");

    const envelope = parseEnvelope(errorSpy);
    expect((envelope["error"] as { message: string }).message).toContain("Failed to read JSON file");
  });

  // ── common.ts line 216: non-Error thrown in readTextInput ──────────────

  it("readTextInput: handles non-Error thrown value", async () => {
    mocks.readFile.mockImplementation(async () => {
      throw 42;  // non-Error
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("x"); }) as never);

    await expect(
      createProgram().parseAsync([
        "node", "test", "advanced", "instructions",
        "--agent", "alpha", "--scope", "global",
        "--content-file", "/tmp/bad.txt",
      ]),
    ).rejects.toThrow("x");

    const envelope = parseEnvelope(errorSpy);
    expect((envelope["error"] as { message: string }).message).toContain("Failed to read content file");
  });

  // ── common.ts resolveProviders: some providers found, some not ─────────

  it("resolveProviders: throws when some agent IDs are unknown", async () => {
    mocks.getProvider.mockImplementation((id: string) => {
      if (id === "alpha") return alpha;
      return undefined;
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("x"); }) as never);

    await expect(
      createProgram().parseAsync([
        "node", "test", "advanced", "providers",
        "--agent", "alpha", "--agent", "unknown-provider",
      ]),
    ).rejects.toThrow("x");

    const envelope = parseEnvelope(errorSpy);
    expect((envelope["error"] as { message: string }).message).toContain("Unknown provider(s)");
  });

  // ── common.ts parsePriority: invalid tier ──────────────────────────────

  it("parsePriority: fails on invalid tier", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("x"); }) as never);

    await expect(
      createProgram().parseAsync([
        "node", "test", "advanced", "providers",
        "--min-tier", "ultra",
      ]),
    ).rejects.toThrow("x");

    const envelope = parseEnvelope(errorSpy);
    expect((envelope["error"] as { message: string }).message).toContain("Invalid tier: ultra");
  });

  // ── instructions.ts: invalid scope ──────────────────────────────────────

  it("instructions: fails on invalid scope", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("x"); }) as never);

    await expect(
      createProgram().parseAsync([
        "node", "test", "advanced", "instructions",
        "--agent", "alpha", "--scope", "team",
        "--content", "test",
      ]),
    ).rejects.toThrow("x");

    const envelope = parseEnvelope(errorSpy);
    expect((envelope["error"] as { message: string }).message).toContain("Invalid scope");
  });

  // ── instructions.ts: empty content ──────────────────────────────────────

  it("instructions: fails on empty content", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("x"); }) as never);

    await expect(
      createProgram().parseAsync([
        "node", "test", "advanced", "instructions",
        "--agent", "alpha", "--scope", "project",
      ]),
    ).rejects.toThrow("x");

    const envelope = parseEnvelope(errorSpy);
    expect((envelope["error"] as { message: string }).message).toContain("Instruction content is required");
  });

  // ── batch.ts: no operations ────────────────────────────────────────────

  it("batch: fails when no operations provided", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("x"); }) as never);

    await expect(
      createProgram().parseAsync(["node", "test", "advanced", "batch", "--agent", "alpha"]),
    ).rejects.toThrow("x");

    const envelope = parseEnvelope(errorSpy);
    expect((envelope["error"] as { message: string }).message).toContain("No operations provided");
  });

  // ── conflicts.ts: no providers resolved ────────────────────────────────

  it("conflicts: fails when no providers resolved", async () => {
    mocks.selectProvidersByMinimumPriority.mockReturnValueOnce([]);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("x"); }) as never);

    await expect(
      createProgram().parseAsync([
        "node", "test", "advanced", "conflicts",
        "--agent", "alpha", "--mcp-file", "/tmp/mcp.json",
      ]),
    ).rejects.toThrow("x");

    const envelope = parseEnvelope(errorSpy);
    expect((envelope["error"] as { message: string }).message).toContain("No target providers");
  });

  // ── configure.ts: unknown provider ─────────────────────────────────────

  it("configure: fails when provider not found", async () => {
    mocks.getProvider.mockReturnValue(undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("x"); }) as never);

    await expect(
      createProgram().parseAsync([
        "node", "test", "advanced", "configure",
        "--agent", "unknown-agent",
        "--instruction", "test",
      ]),
    ).rejects.toThrow("x");

    const envelope = parseEnvelope(errorSpy);
    expect((envelope["error"] as { message: string }).message).toContain("Unknown provider");
  });
});
