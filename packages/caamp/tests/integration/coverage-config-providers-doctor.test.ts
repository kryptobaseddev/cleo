/**
 * Coverage tests for config, providers, doctor command branches.
 */
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProvider: vi.fn(),
  getAllProviders: vi.fn(),
  getProviderCount: vi.fn(),
  getRegistryVersion: vi.fn(),
  getProvidersByPriority: vi.fn(),
  detectAllProviders: vi.fn(),
  detectProjectProviders: vi.fn(),
  resolveProviderConfigPath: vi.fn(),
  readConfig: vi.fn(),
  readLockFile: vi.fn(),
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  lstatSync: vi.fn(),
  readlinkSync: vi.fn(),
  execFileSync: vi.fn(),
  getCaampVersion: vi.fn(),
}));

vi.mock("../../src/core/registry/providers.js", () => ({
  getProvider: mocks.getProvider,
  getAllProviders: mocks.getAllProviders,
  getProviderCount: mocks.getProviderCount,
  getRegistryVersion: mocks.getRegistryVersion,
  getProvidersByPriority: mocks.getProvidersByPriority,
}));

vi.mock("../../src/core/registry/detection.js", () => ({
  detectAllProviders: mocks.detectAllProviders,
  detectProjectProviders: mocks.detectProjectProviders,
}));

vi.mock("../../src/core/paths/standard.js", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    resolveProviderConfigPath: mocks.resolveProviderConfigPath,
  };
});

vi.mock("../../src/core/formats/index.js", () => ({
  readConfig: mocks.readConfig,
}));

vi.mock("../../src/core/mcp/lock.js", () => ({
  readLockFile: mocks.readLockFile,
}));

vi.mock("node:fs", () => ({
  existsSync: mocks.existsSync,
  readdirSync: mocks.readdirSync,
  lstatSync: mocks.lstatSync,
  readlinkSync: mocks.readlinkSync,
}));

vi.mock("node:child_process", () => ({
  execFileSync: mocks.execFileSync,
}));

vi.mock("../../src/core/version.js", () => ({
  getCaampVersion: mocks.getCaampVersion,
}));

import { registerConfigCommand } from "../../src/commands/config.js";
import { registerDoctorCommand } from "../../src/commands/doctor.js";
import { registerProvidersCommand } from "../../src/commands/providers.js";

const provider = {
  id: "claude-code",
  toolName: "Claude Code",
  capabilities: {
    mcp: {
      configKey: "mcpServers",
      configFormat: "json",
      configPathGlobal: "/global/claude.json",
      configPathProject: ".claude/settings.json",
      supportedTransports: ["stdio"],
      supportsHeaders: false,
    },
    harness: null,
    skills: { agentsGlobalPath: null, agentsProjectPath: null, precedence: "vendor-only" },
    hooks: {
      supported: [],
      hookConfigPath: null,
      hookConfigPathProject: null,
      hookFormat: null,
      nativeEventCatalog: "canonical",
      canInjectSystemPrompt: false,
      canBlockTools: false,
    },
    spawn: {
      supportsSubagents: false,
      supportsProgrammaticSpawn: false,
      supportsInterAgentComms: false,
      supportsParallelSpawn: false,
      spawnMechanism: null,
      spawnCommand: null,
    },
  },
};

describe("coverage: config command branches", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.values(mocks).forEach((m) => m.mockReset());
    mocks.getProvider.mockReturnValue(provider);
  });

  // Lines 69-72: json error when config file does not exist
  it("outputs json error when config file does not exist", async () => {
    mocks.resolveProviderConfigPath.mockReturnValue("/nonexistent.json");
    mocks.existsSync.mockReturnValue(false);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process-exit");
    }) as never);

    const program = new Command();
    registerConfigCommand(program);

    await expect(
      program.parseAsync(["node", "test", "config", "show", "claude-code", "--json"]),
    ).rejects.toThrow("process-exit");

    const output = String(errorSpy.mock.calls[0]?.[0] ?? "{}");
    const envelope = JSON.parse(output);
    expect(envelope.success).toBe(false);
    expect(envelope.error.code).toBe("E_FILE_NOT_FOUND");
  });

  // Lines 100-101: human error on config read failure
  it("shows human error when config read fails", async () => {
    mocks.resolveProviderConfigPath.mockReturnValue("/broken.json");
    mocks.existsSync.mockReturnValue(true);
    mocks.readConfig.mockRejectedValue(new Error("Parse error"));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process-exit");
    }) as never);

    const program = new Command();
    registerConfigCommand(program);

    await expect(
      program.parseAsync(["node", "test", "config", "show", "claude-code", "--human"]),
    ).rejects.toThrow("process-exit");

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Error reading config: Parse error"));
  });

  // Branch: format conflict on show
  it("exits with format conflict on config show", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process-exit");
    }) as never);

    const program = new Command();
    registerConfigCommand(program);

    await expect(
      program.parseAsync(["node", "test", "config", "show", "claude-code", "--json", "--human"]),
    ).rejects.toThrow("process-exit");

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // Branch: provider not found in human mode
  it("shows human error when provider not found on show", async () => {
    mocks.getProvider.mockReturnValue(undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process-exit");
    }) as never);

    const program = new Command();
    registerConfigCommand(program);

    await expect(
      program.parseAsync(["node", "test", "config", "show", "unknown", "--human"]),
    ).rejects.toThrow("process-exit");

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Provider not found: unknown"));
  });
});

describe("coverage: doctor command branches", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.values(mocks).forEach((m) => m.mockReset());

    mocks.execFileSync.mockReturnValue("10.0.0");
    mocks.getCaampVersion.mockReturnValue("0.3.0");
    mocks.getAllProviders.mockReturnValue([]);
    mocks.getProviderCount.mockReturnValue(44);
    mocks.detectAllProviders.mockReturnValue([]);
    mocks.readLockFile.mockResolvedValue({ version: 1, skills: {}, mcpServers: {} });
    mocks.readConfig.mockResolvedValue({});
    mocks.existsSync.mockReturnValue(false);
    mocks.readdirSync.mockReturnValue([]);
    mocks.lstatSync.mockReturnValue({ isSymbolicLink: () => false, isDirectory: () => false });
    mocks.readlinkSync.mockReturnValue("/some/path");
  });

  // Lines 424-425: handleFormatError
  it("exits via handleFormatError when both flags used", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process-exit");
    }) as never);

    const program = new Command();
    registerDoctorCommand(program);

    await expect(
      program.parseAsync(["node", "test", "doctor", "--json", "--human"]),
    ).rejects.toThrow("process-exit");

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // Branch: human error from outer catch
  it("prints human error from outer catch", async () => {
    mocks.getAllProviders.mockImplementation(() => {
      throw new Error("registry boom");
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process-exit");
    }) as never);

    const program = new Command();
    registerDoctorCommand(program);

    await expect(
      program.parseAsync(["node", "test", "doctor", "--human"]),
    ).rejects.toThrow("process-exit");

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Error: registry boom"));
  });
});

describe("coverage: providers command branches", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.values(mocks).forEach((m) => m.mockReset());

    mocks.getRegistryVersion.mockReturnValue("1.0.0");
    mocks.getProviderCount.mockReturnValue(44);
  });

  // Lines 190-193: providers show format conflict
  it("exits with format conflict on providers show", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process-exit");
    }) as never);

    const program = new Command();
    registerProvidersCommand(program);

    await expect(
      program.parseAsync(["node", "test", "providers", "show", "claude-code", "--json", "--human"]),
    ).rejects.toThrow("process-exit");

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // Lines 204-205: human error when provider not found on show
  it("shows human error when provider not found on show", async () => {
    mocks.getProvider.mockReturnValue(undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process-exit");
    }) as never);

    const program = new Command();
    registerProvidersCommand(program);

    await expect(
      program.parseAsync(["node", "test", "providers", "show", "unknown", "--human"]),
    ).rejects.toThrow("process-exit");

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Provider not found: unknown"));
  });

  // Branch: providers list format conflict
  it("exits with format conflict on providers list", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process-exit");
    }) as never);

    const program = new Command();
    registerProvidersCommand(program);

    await expect(
      program.parseAsync(["node", "test", "providers", "list", "--json", "--human"]),
    ).rejects.toThrow("process-exit");

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // Branch: providers detect format conflict
  it("exits with format conflict on providers detect", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process-exit");
    }) as never);

    const program = new Command();
    registerProvidersCommand(program);

    await expect(
      program.parseAsync(["node", "test", "providers", "detect", "--json", "--human"]),
    ).rejects.toThrow("process-exit");

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
