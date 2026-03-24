import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "../../src/types.js";

const mocks = vi.hoisted(() => ({
  writeConfig: vi.fn(),
  getTransform: vi.fn(),
  resolveConfigPath: vi.fn(),
}));

vi.mock("../../src/core/formats/index.js", () => ({
  writeConfig: mocks.writeConfig,
}));

vi.mock("../../src/core/mcp/transforms.js", () => ({
  getTransform: mocks.getTransform,
}));

vi.mock("../../src/core/mcp/reader.js", () => ({
  resolveConfigPath: mocks.resolveConfigPath,
}));

import { buildServerConfig, installMcpServer, installMcpServerToAll } from "../../src/core/mcp/installer.js";

function provider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: "claude-code",
    toolName: "Claude Code",
    vendor: "Anthropic",
    agentFlag: "claude",
    aliases: [],
    pathGlobal: "",
    pathProject: "",
    instructFile: "CLAUDE.md",
    configKey: "mcpServers",
    configFormat: "json",
    configPathGlobal: "/tmp/global.json",
    configPathProject: ".claude/settings.json",
    pathSkills: "",
    pathProjectSkills: "",
    detection: { methods: [] },
    supportedTransports: ["stdio", "sse", "http"],
    supportsHeaders: true,
    priority: "high",
    status: "active",
    agentSkillsCompatible: true,
    ...overrides,
  };
}

describe("mcp installer", () => {
  beforeEach(() => {
    mocks.writeConfig.mockReset();
    mocks.getTransform.mockReset();
    mocks.resolveConfigPath.mockReset();
    mocks.resolveConfigPath.mockReturnValue("/tmp/project.json");
  });

  it("returns error when provider does not support selected scope", async () => {
    mocks.resolveConfigPath.mockReturnValue(null);

    const result = await installMcpServer(provider(), "server", { command: "npx", args: ["-y", "pkg"] });

    expect(result.success).toBe(false);
    expect(result.error).toContain("does not support");
    expect(mocks.writeConfig).not.toHaveBeenCalled();
  });

  it("writes transformed config when provider transform exists", async () => {
    mocks.getTransform.mockReturnValue((_name: string, config: unknown) => ({ wrapped: config }));

    const result = await installMcpServer(provider({ id: "goose" }), "server", { command: "node", args: ["a.js"] });

    expect(result.success).toBe(true);
    expect(mocks.writeConfig).toHaveBeenCalledWith(
      "/tmp/project.json",
      "json",
      "mcpServers",
      "server",
      { wrapped: { command: "node", args: ["a.js"] } },
    );
  });

  it("returns failure when write throws", async () => {
    mocks.writeConfig.mockRejectedValue(new Error("disk full"));

    const result = await installMcpServer(provider(), "server", { command: "npx", args: ["-y", "pkg"] });

    expect(result.success).toBe(false);
    expect(result.error).toBe("disk full");
  });

  it("installs to all providers and preserves count", async () => {
    const providers = [provider({ id: "a" }), provider({ id: "b" })];
    const results = await installMcpServerToAll(providers, "server", { command: "npx", args: ["-y", "pkg"] });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.success)).toBe(true);
  });

  it("builds remote/package/command configs", () => {
    expect(buildServerConfig({ type: "remote", value: "https://mcp.example.com" }, "sse", { Authorization: "Bearer x" })).toEqual({
      type: "sse",
      url: "https://mcp.example.com",
      headers: { Authorization: "Bearer x" },
    });

    expect(buildServerConfig({ type: "package", value: "@modelcontextprotocol/server-filesystem" })).toEqual({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem"],
    });

    expect(buildServerConfig({ type: "command", value: "uvx mcp-server" })).toEqual({
      command: "uvx",
      args: ["mcp-server"],
    });
  });
});
