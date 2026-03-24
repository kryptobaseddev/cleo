import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  installMcpServerToAll: vi.fn(),
  recordMcpInstall: vi.fn(),
  removeMcpFromLock: vi.fn(),
  getTrackedMcpServers: vi.fn(),
  listMcpServers: vi.fn(),
  removeMcpServer: vi.fn(),
  getInstalledProviders: vi.fn(),
  getProvider: vi.fn(),
}));

vi.mock("../../src/core/mcp/installer.js", () => ({
  installMcpServerToAll: mocks.installMcpServerToAll,
}));

vi.mock("../../src/core/mcp/lock.js", () => ({
  recordMcpInstall: mocks.recordMcpInstall,
  removeMcpFromLock: mocks.removeMcpFromLock,
  getTrackedMcpServers: mocks.getTrackedMcpServers,
}));

vi.mock("../../src/core/mcp/reader.js", () => ({
  listMcpServers: mocks.listMcpServers,
  removeMcpServer: mocks.removeMcpServer,
}));

vi.mock("../../src/core/registry/detection.js", () => ({
  getInstalledProviders: mocks.getInstalledProviders,
}));

vi.mock("../../src/core/registry/providers.js", () => ({
  getProvider: mocks.getProvider,
}));

import { registerMcpCleoCommands, registerMcpCleoCompatibilityCommands } from "../../src/commands/mcp/cleo.js";

const provider = { id: "claude-code", toolName: "Claude Code" };

describe("integration: mcp cleo commands", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.values(mocks).forEach((fn) => fn.mockReset());

    mocks.getInstalledProviders.mockReturnValue([provider]);
    mocks.getProvider.mockImplementation((name: string) => (name === "claude-code" ? provider : undefined));
    mocks.installMcpServerToAll.mockResolvedValue([
      { provider, success: true, scope: "project", configPath: "/tmp/claude.json" },
    ]);
    mocks.recordMcpInstall.mockResolvedValue(undefined);
    mocks.removeMcpFromLock.mockResolvedValue(true);
    mocks.getTrackedMcpServers.mockResolvedValue({});
    mocks.removeMcpServer.mockResolvedValue(true);
    mocks.listMcpServers.mockResolvedValue([
      { name: "cleo-beta", config: { command: "node", args: ["-v"] } },
      { name: "cleo", config: { command: "node", args: ["-v"] } },
    ]);
  });

  it("updates CLEO beta profile through dedicated command", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerMcpCleoCommands(program);

    await program.parseAsync([
      "node",
      "test",
      "cleo",
      "update",
      "--channel",
      "beta",
      "--provider",
      "claude-code",
      "--json",
    ]);

    expect(mocks.installMcpServerToAll).toHaveBeenCalledWith(
      [provider],
      "cleo-beta",
      expect.objectContaining({ command: "npx" }),
      "project",
    );

    const output = String(logSpy.mock.calls[0]?.[0] ?? "{}");
    const envelope = JSON.parse(output);
    expect(envelope.success).toBe(true);
    expect(envelope.result.channel).toBe("beta");
  });

  it("uninstalls CLEO dev profile through compatibility command", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerMcpCleoCompatibilityCommands(program);

    await program.parseAsync([
      "node",
      "test",
      "uninstall",
      "cleo",
      "--channel",
      "dev",
      "--provider",
      "claude-code",
      "--json",
    ]);

    expect(mocks.removeMcpServer).toHaveBeenCalledWith(provider, "cleo-dev", "project");

    const output = String(logSpy.mock.calls[0]?.[0] ?? "{}");
    const envelope = JSON.parse(output);
    expect(envelope.success).toBe(true);
    expect(envelope.result.channel).toBe("dev");
  });

  it("shows installed CLEO profiles with channel filter", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerMcpCleoCompatibilityCommands(program);

    await program.parseAsync([
      "node",
      "test",
      "show",
      "cleo",
      "--provider",
      "claude-code",
      "--channel",
      "stable",
      "--json",
    ]);

    const output = String(logSpy.mock.calls[0]?.[0] ?? "{}");
    const envelope = JSON.parse(output);
    expect(envelope.success).toBe(true);
    // Scans both project and global scopes, finding "cleo" in each
    expect(envelope.result.count).toBe(2);
    expect(envelope.result.profiles[0].serverName).toBe("cleo");
    expect(envelope.result.profiles[0].channel).toBe("stable");
    expect(envelope.result.scopes).toEqual(["project", "global"]);
  });
});
