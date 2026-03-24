import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getInstalledProviders: vi.fn(),
  getProvider: vi.fn(),
  listMcpServers: vi.fn(),
  removeMcpServer: vi.fn(),
  resolveConfigPath: vi.fn(),
  removeMcpFromLock: vi.fn(),
  existsSync: vi.fn(),
}));

vi.mock("../../src/core/registry/detection.js", () => ({
  getInstalledProviders: mocks.getInstalledProviders,
}));

vi.mock("../../src/core/registry/providers.js", () => ({
  getProvider: mocks.getProvider,
}));

vi.mock("../../src/core/mcp/reader.js", () => ({
  listMcpServers: mocks.listMcpServers,
  removeMcpServer: mocks.removeMcpServer,
  resolveConfigPath: mocks.resolveConfigPath,
}));

vi.mock("../../src/core/mcp/lock.js", () => ({
  removeMcpFromLock: mocks.removeMcpFromLock,
}));

vi.mock("node:fs", () => ({
  existsSync: mocks.existsSync,
}));

import { registerMcpDetect } from "../../src/commands/mcp/detect.js";
import { registerMcpList } from "../../src/commands/mcp/list.js";
import { registerMcpRemove } from "../../src/commands/mcp/remove.js";

const providerA = {
  id: "claude-code",
  toolName: "Claude Code",
  configPathProject: ".claude/settings.json",
};

const providerB = {
  id: "cursor",
  toolName: "Cursor",
  configPathProject: null,
};

describe("integration: mcp command wrappers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.getInstalledProviders.mockReset();
    mocks.getProvider.mockReset();
    mocks.listMcpServers.mockReset();
    mocks.removeMcpServer.mockReset();
    mocks.resolveConfigPath.mockReset();
    mocks.removeMcpFromLock.mockReset();
    mocks.existsSync.mockReset();

    mocks.getInstalledProviders.mockReturnValue([providerA, providerB]);
    mocks.getProvider.mockImplementation((name: string) => {
      if (name === "claude-code") return providerA;
      if (name === "cursor") return providerB;
      return undefined;
    });
    mocks.removeMcpFromLock.mockResolvedValue(true);
  });

  it("lists entries as json for a selected agent", async () => {
    mocks.listMcpServers.mockResolvedValue([
      {
        providerId: "claude-code",
        name: "filesystem",
        config: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] },
      },
    ]);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerMcpList(program);

    await program.parseAsync(["node", "test", "list", "--agent", "claude-code", "--json"]);

    expect(mocks.listMcpServers).toHaveBeenCalledWith(providerA, "project");
    const output = String(logSpy.mock.calls[0]?.[0] ?? "{}");
    const envelope = JSON.parse(output);
    expect(envelope.$schema).toBe("https://lafs.dev/schemas/v1/envelope.schema.json");
    expect(envelope.success).toBe(true);
    expect(envelope.result.servers).toEqual([{ name: "filesystem", command: "npx", scope: "project" }]);
    expect(envelope.result.count).toBe(1);
  });

  it("lists entries with provider alias", async () => {
    mocks.listMcpServers.mockResolvedValue([
      {
        providerId: "claude-code",
        name: "filesystem",
        config: { command: "npx" },
      },
    ]);

    const program = new Command();
    registerMcpList(program);

    await program.parseAsync(["node", "test", "list", "--provider", "claude-code", "--json"]);

    expect(mocks.listMcpServers).toHaveBeenCalledWith(providerA, "project");
  });

  it("shows empty-state message when no servers are configured", async () => {
    mocks.listMcpServers.mockResolvedValue([]);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerMcpList(program);

    await program.parseAsync(["node", "test", "list", "--human"]);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("No MCP servers configured."));
  });

  it("removes server across all providers and updates lock", async () => {
    mocks.removeMcpServer.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const program = new Command();
    registerMcpRemove(program);

    await program.parseAsync(["node", "test", "remove", "filesystem", "--all", "--global"]);

    expect(mocks.removeMcpServer).toHaveBeenNthCalledWith(1, providerA, "filesystem", "global");
    expect(mocks.removeMcpServer).toHaveBeenNthCalledWith(2, providerB, "filesystem", "global");
    expect(mocks.removeMcpFromLock).toHaveBeenCalledWith("filesystem");
  });

  it("removes server via provider alias", async () => {
    mocks.removeMcpServer.mockResolvedValue(true);

    const program = new Command();
    registerMcpRemove(program);

    await program.parseAsync(["node", "test", "remove", "filesystem", "--provider", "claude-code", "--json"]);

    expect(mocks.removeMcpServer).toHaveBeenCalledWith(providerA, "filesystem", "project");
  });

  it("reports not found when no provider removal succeeds", async () => {
    mocks.removeMcpServer.mockResolvedValue(false);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process-exit");
    }) as never);
    const program = new Command();
    registerMcpRemove(program);

    await expect(program.parseAsync(["node", "test", "remove", "missing", "--agent", "unknown-agent"])).rejects.toThrow("process-exit");

    expect(mocks.removeMcpServer).not.toHaveBeenCalled();
    expect(mocks.removeMcpFromLock).not.toHaveBeenCalled();
    // In JSON mode (default), error goes to stderr as LAFS envelope
    const output = String(errorSpy.mock.calls[0]?.[0] ?? "{}");
    const envelope = JSON.parse(output);
    expect(envelope.success).toBe(false);
    expect(envelope.error.code).toBe("E_PROVIDER_NOT_FOUND");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("detects provider MCP state and outputs json", async () => {
    mocks.getInstalledProviders.mockReturnValue([providerA]);
    mocks.resolveConfigPath.mockImplementation((provider: { id: string }, scope: "global" | "project") => {
      if (scope === "global") return `/tmp/${provider.id}.json`;
      return `/repo/.${provider.id}.json`;
    });
    mocks.existsSync.mockImplementation((path: string) => path.startsWith("/tmp/"));
    mocks.listMcpServers.mockImplementation((provider: { id: string }, scope: "global" | "project") => {
      if (scope === "global") {
        return Promise.resolve([{ name: `${provider.id}-global` }]);
      }
      return Promise.resolve([{ name: `${provider.id}-project` }]);
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerMcpDetect(program);

    await program.parseAsync(["node", "test", "detect", "--json"]);

    const output = String(logSpy.mock.calls[0]?.[0] ?? "{}");
    const envelope = JSON.parse(output);
    expect(envelope.$schema).toBe("https://lafs.dev/schemas/v1/envelope.schema.json");
    expect(envelope.success).toBe(true);
    expect(envelope.result.providers).toEqual([
      {
        id: "claude-code",
        configsFound: 1,
        servers: ["claude-code-global", "claude-code-project"],
      },
    ]);
    expect(envelope.result.totalConfigs).toBe(1);
  });

  it("prints human readable detect output when no configs exist", async () => {
    mocks.getInstalledProviders.mockReturnValue([providerB]);
    mocks.resolveConfigPath.mockReturnValue(null);
    mocks.existsSync.mockReturnValue(false);
    mocks.listMcpServers.mockResolvedValue([]);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerMcpDetect(program);

    await program.parseAsync(["node", "test", "detect", "--human"]);

    const lines = logSpy.mock.calls.map((call) => String(call[0] ?? ""));
    expect(lines.some((line) => line.includes("no servers"))).toBe(true);
    expect(lines.some((line) => line.includes("G = global config, P = project config"))).toBe(true);
  });
});
