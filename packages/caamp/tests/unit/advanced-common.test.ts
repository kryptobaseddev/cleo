import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "../../src/types.js";

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  getInstalledProviders: vi.fn(),
  getAllProviders: vi.fn(),
  getProvider: vi.fn(),
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

import {
  parsePriority,
  readJsonFile,
  readMcpOperations,
  readSkillOperations,
  readTextInput,
  resolveProviders,
} from "../../src/commands/advanced/common.js";
import { LAFSCommandError } from "../../src/commands/advanced/lafs.js";

function makeProvider(id: string): Provider {
  return {
    id,
    toolName: id,
    vendor: "test",
    agentFlag: id,
    aliases: [],
    pathGlobal: "/tmp",
    pathProject: ".",
    instructFile: "AGENTS.md",
    configKey: "mcpServers",
    configFormat: "json",
    configPathGlobal: "/tmp/config.json",
    configPathProject: ".config/test.json",
    pathSkills: "/tmp/skills",
    pathProjectSkills: ".skills",
    detection: { methods: ["binary"], binary: id },
    supportedTransports: ["stdio", "http", "sse"],
    supportsHeaders: true,
    priority: "medium",
    status: "active",
    agentSkillsCompatible: true,
  };
}

describe("advanced/common", () => {
  beforeEach(() => {
    mocks.readFile.mockReset();
    mocks.getInstalledProviders.mockReset();
    mocks.getAllProviders.mockReset();
    mocks.getProvider.mockReset();
  });

  it("validates provider priority values", () => {
    expect(parsePriority("high")).toBe("high");
    expect(() => parsePriority("urgent")).toThrowError(LAFSCommandError);

    try {
      parsePriority("urgent");
    } catch (error) {
      const lafsError = error as LAFSCommandError;
      expect(lafsError.code).toBe("E_ADVANCED_VALIDATION_PRIORITY");
      expect(lafsError.suggestion).toContain("high, medium, low");
    }
  });

  it("resolves providers from all, installed, and agent selections", () => {
    const a = makeProvider("alpha");
    const b = makeProvider("beta");

    mocks.getAllProviders.mockReturnValue([a, b]);
    mocks.getInstalledProviders.mockReturnValue([b]);
    mocks.getProvider.mockImplementation((id: string) => (id === "alpha" ? a : undefined));

    expect(resolveProviders({ all: true }).map((provider) => provider.id)).toEqual(["alpha", "beta"]);
    expect(resolveProviders({}).map((provider) => provider.id)).toEqual(["beta"]);
    expect(resolveProviders({ agent: ["alpha"] }).map((provider) => provider.id)).toEqual(["alpha"]);
  });

  it("throws when selected providers are missing", () => {
    const alpha = makeProvider("alpha");
    mocks.getProvider.mockImplementation((id: string) => (id === "alpha" ? alpha : undefined));

    expect(() => resolveProviders({ agent: ["alpha", "ghost"] })).toThrowError(LAFSCommandError);

    try {
      resolveProviders({ agent: ["alpha", "ghost"] });
    } catch (error) {
      const lafsError = error as LAFSCommandError;
      expect(lafsError.code).toBe("E_ADVANCED_PROVIDER_NOT_FOUND");
      expect(lafsError.message).toContain("ghost");
    }
  });

  it("wraps JSON parse and read failures", async () => {
    mocks.readFile.mockResolvedValueOnce('{"ok":true}');
    await expect(readJsonFile("/tmp/ok.json")).resolves.toEqual({ ok: true });

    mocks.readFile.mockResolvedValueOnce("{not-json");
    await expect(readJsonFile("/tmp/bad.json")).rejects.toMatchObject({
      code: "E_ADVANCED_INPUT_JSON",
      details: { reason: expect.stringContaining("JSON") },
    });

    mocks.readFile.mockRejectedValueOnce(new Error("ENOENT"));
    await expect(readJsonFile("/tmp/missing.json")).rejects.toMatchObject({
      code: "E_ADVANCED_INPUT_JSON",
      details: { reason: "ENOENT" },
    });
  });

  it("validates MCP operations structure and scope", async () => {
    mocks.readFile.mockResolvedValueOnce(
      JSON.stringify([{ serverName: "srv", config: { command: "npx" }, scope: "project" }]),
    );
    await expect(readMcpOperations("/tmp/mcp-valid.json")).resolves.toEqual([
      { serverName: "srv", config: { command: "npx" }, scope: "project" },
    ]);

    mocks.readFile.mockResolvedValueOnce(JSON.stringify({ serverName: "not-array" }));
    await expect(readMcpOperations("/tmp/mcp-not-array.json")).rejects.toMatchObject({
      code: "E_ADVANCED_VALIDATION_MCP_ARRAY",
    });

    mocks.readFile.mockResolvedValueOnce(JSON.stringify([{ serverName: "srv", config: { command: "npx" }, scope: "team" }]));
    await expect(readMcpOperations("/tmp/mcp-bad-scope.json")).rejects.toMatchObject({
      code: "E_ADVANCED_VALIDATION_SCOPE",
    });
  });

  it("validates skill operations and text input mode", async () => {
    mocks.readFile.mockResolvedValueOnce(
      JSON.stringify([{ sourcePath: "./skills/my-skill", skillName: "my-skill", isGlobal: false }]),
    );
    await expect(readSkillOperations("/tmp/skills-valid.json")).resolves.toEqual([
      { sourcePath: "./skills/my-skill", skillName: "my-skill", isGlobal: false },
    ]);

    mocks.readFile.mockResolvedValueOnce(JSON.stringify([{ sourcePath: "./skills/my-skill", skillName: "my-skill", isGlobal: "yes" }]));
    await expect(readSkillOperations("/tmp/skills-bad-scope.json")).rejects.toMatchObject({
      code: "E_ADVANCED_VALIDATION_SKILL_SCOPE",
    });

    await expect(readTextInput("inline", "/tmp/content.txt")).rejects.toMatchObject({
      code: "E_ADVANCED_VALIDATION_INPUT_MODE",
    });

    expect(await readTextInput("inline", undefined)).toBe("inline");

    mocks.readFile.mockResolvedValueOnce("from-file");
    await expect(readTextInput(undefined, "/tmp/content.txt")).resolves.toBe("from-file");

    mocks.readFile.mockRejectedValueOnce(new Error("not-readable"));
    await expect(readTextInput(undefined, "/tmp/missing.txt")).rejects.toMatchObject({
      code: "E_ADVANCED_INPUT_TEXT",
      details: { reason: "not-readable" },
    });
  });
});
