/**
 * Coverage tests for mcp list, remove, detect commands - targets uncovered lines/branches.
 */
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
    getInstalledProviders: vi.fn(),
    getProvider: vi.fn(),
    listMcpServers: vi.fn(),
    removeMcpServer: vi.fn(),
    resolveConfigPath: vi.fn(),
    resolvePreferredConfigScope: vi.fn(),
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
vi.mock("../../src/core/paths/standard.js", () => ({
    resolvePreferredConfigScope: mocks.resolvePreferredConfigScope,
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
describe("coverage: mcp list", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        Object.values(mocks).forEach((m) => m.mockReset());
        mocks.getInstalledProviders.mockReturnValue([providerA]);
        mocks.getProvider.mockImplementation((name) => name === "claude-code" ? providerA : undefined);
        mocks.resolvePreferredConfigScope.mockReturnValue("project");
        mocks.listMcpServers.mockResolvedValue([]);
    });
    // Lines 51-60: provider not found with --agent in json and human mode
    it("exits with json error when --agent provider not found", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
        const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
            throw new Error("process-exit");
        }));
        const program = new Command();
        registerMcpList(program);
        await expect(program.parseAsync(["node", "test", "list", "--agent", "unknown", "--json"])).rejects.toThrow("process-exit");
        const output = String(errorSpy.mock.calls[0]?.[0] ?? "{}");
        const envelope = JSON.parse(output);
        expect(envelope.success).toBe(false);
        expect(envelope.error.code).toBe("E_PROVIDER_NOT_FOUND");
    });
    it("exits with human error when --agent provider not found", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
        const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
            throw new Error("process-exit");
        }));
        const program = new Command();
        registerMcpList(program);
        await expect(program.parseAsync(["node", "test", "list", "--agent", "unknown", "--human"])).rejects.toThrow("process-exit");
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Provider not found: unknown"));
    });
    // Lines 96-105: human-readable output with entries
    it("prints human-readable list with entries", async () => {
        mocks.listMcpServers.mockResolvedValue([
            { name: "filesystem", config: { command: "npx" } },
            { name: "fetch", config: { url: "https://example.com" } },
        ]);
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
        const program = new Command();
        registerMcpList(program);
        await program.parseAsync(["node", "test", "list", "--agent", "claude-code", "--human"]);
        const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
        expect(output).toContain("2 MCP server(s) configured:");
        expect(output).toContain("filesystem");
        expect(output).toContain("npx");
        expect(output).toContain("G = global config, P = project config");
    });
    // Branch: entry with no command
    it("handles entries without command in human mode", async () => {
        mocks.listMcpServers.mockResolvedValue([
            { name: "fetch-server", config: { url: "https://example.com" } },
        ]);
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
        const program = new Command();
        registerMcpList(program);
        await program.parseAsync(["node", "test", "list", "--agent", "claude-code", "--human"]);
        const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
        expect(output).toContain("fetch-server");
    });
    // Branch: format conflict
    it("exits with format conflict error", async () => {
        vi.spyOn(console, "error").mockImplementation(() => { });
        const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
            throw new Error("process-exit");
        }));
        const program = new Command();
        registerMcpList(program);
        await expect(program.parseAsync(["node", "test", "list", "--json", "--human"])).rejects.toThrow("process-exit");
        expect(exitSpy).toHaveBeenCalledWith(1);
    });
    // Branch: json output with global scope
    it("lists global scope entries as JSON", async () => {
        mocks.listMcpServers.mockResolvedValue([
            { name: "global-server", config: { command: "node" } },
        ]);
        mocks.resolvePreferredConfigScope.mockReturnValue("global");
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
        const program = new Command();
        registerMcpList(program);
        await program.parseAsync(["node", "test", "list", "--global", "--json"]);
        const output = String(logSpy.mock.calls[0]?.[0] ?? "{}");
        const envelope = JSON.parse(output);
        expect(envelope.success).toBe(true);
        expect(envelope.result.scope).toBe("global");
    });
});
describe("coverage: mcp remove", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        Object.values(mocks).forEach((m) => m.mockReset());
        mocks.getInstalledProviders.mockReturnValue([providerA]);
        mocks.getProvider.mockImplementation((name) => name === "claude-code" ? providerA : undefined);
        mocks.removeMcpServer.mockResolvedValue(true);
        mocks.removeMcpFromLock.mockResolvedValue(true);
    });
    // Lines 85-86, 103-108: human-readable success and summary
    it("prints human-readable success per provider and summary", async () => {
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
        const program = new Command();
        registerMcpRemove(program);
        await program.parseAsync(["node", "test", "remove", "filesystem", "--all", "--human"]);
        const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
        expect(output).toContain("Removed from Claude Code");
        expect(output).toContain("Removed \"filesystem\" from 1 provider(s).");
    });
    it("prints human not-found message", async () => {
        mocks.removeMcpServer.mockResolvedValue(false);
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
        const program = new Command();
        registerMcpRemove(program);
        await program.parseAsync(["node", "test", "remove", "missing-server", "--all", "--human"]);
        const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
        expect(output).toContain("not found in any provider config");
    });
    // Branch: no providers found in human mode
    it("exits with human error when no providers found", async () => {
        mocks.getInstalledProviders.mockReturnValue([]);
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
        const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
            throw new Error("process-exit");
        }));
        const program = new Command();
        registerMcpRemove(program);
        await expect(program.parseAsync(["node", "test", "remove", "srv", "--all", "--human"])).rejects.toThrow("process-exit");
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("No target providers found."));
    });
    // Branch: --agent specific resolution
    it("resolves providers via --agent flag", async () => {
        vi.spyOn(console, "log").mockImplementation(() => { });
        const program = new Command();
        registerMcpRemove(program);
        await program.parseAsync(["node", "test", "remove", "filesystem", "--agent", "claude-code"]);
        expect(mocks.getProvider).toHaveBeenCalledWith("claude-code");
    });
    // Branch: json with notFound
    it("outputs json with notFound providers", async () => {
        mocks.removeMcpServer.mockResolvedValue(false);
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
        const program = new Command();
        registerMcpRemove(program);
        await program.parseAsync(["node", "test", "remove", "missing", "--all", "--json"]);
        const output = String(logSpy.mock.calls[0]?.[0] ?? "{}");
        const envelope = JSON.parse(output);
        expect(envelope.result.notFound).toEqual(["claude-code"]);
    });
    // Branch: format conflict
    it("exits with format conflict error", async () => {
        vi.spyOn(console, "error").mockImplementation(() => { });
        const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
            throw new Error("process-exit");
        }));
        const program = new Command();
        registerMcpRemove(program);
        await expect(program.parseAsync(["node", "test", "remove", "srv", "--json", "--human"])).rejects.toThrow("process-exit");
        expect(exitSpy).toHaveBeenCalledWith(1);
    });
    // Lines 63-64: default provider resolution (no --all, no --agent)
    it("uses default installed providers when no --all or --agent given", async () => {
        vi.spyOn(console, "log").mockImplementation(() => { });
        const program = new Command();
        registerMcpRemove(program);
        await program.parseAsync(["node", "test", "remove", "filesystem"]);
        expect(mocks.getInstalledProviders).toHaveBeenCalled();
        expect(mocks.removeMcpServer).toHaveBeenCalled();
    });
});
describe("coverage: mcp detect", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        Object.values(mocks).forEach((m) => m.mockReset());
        mocks.getInstalledProviders.mockReturnValue([]);
        mocks.listMcpServers.mockResolvedValue([]);
        mocks.resolveConfigPath.mockReturnValue(null);
        mocks.existsSync.mockReturnValue(false);
    });
    // Lines 37-40: format conflict error
    it("exits with format conflict error", async () => {
        vi.spyOn(console, "error").mockImplementation(() => { });
        const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
            throw new Error("process-exit");
        }));
        const program = new Command();
        registerMcpDetect(program);
        await expect(program.parseAsync(["node", "test", "detect", "--json", "--human"])).rejects.toThrow("process-exit");
        expect(exitSpy).toHaveBeenCalledWith(1);
    });
    // Lines 88-93: human-readable output with providers that have configs
    it("shows human-readable detect output with providers and configs", async () => {
        const testProvider = {
            id: "claude-code",
            toolName: "Claude Code",
            configPathProject: ".claude/settings.json",
        };
        mocks.getInstalledProviders.mockReturnValue([testProvider]);
        mocks.resolveConfigPath.mockImplementation((_p, scope) => scope === "global" ? "/global/claude.json" : "/project/claude.json");
        mocks.existsSync.mockReturnValue(true);
        mocks.listMcpServers.mockResolvedValue([
            { name: "filesystem", config: { command: "npx" } },
        ]);
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
        const program = new Command();
        registerMcpDetect(program);
        await program.parseAsync(["node", "test", "detect", "--human"]);
        const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
        expect(output).toContain("1 provider(s) with MCP support:");
        expect(output).toContain("claude-code");
        expect(output).toContain("G = global config, P = project config");
    });
    // Branch: detect with no servers shows "no servers"
    it("shows 'no servers' when provider has no MCP entries", async () => {
        const testProvider = {
            id: "cursor",
            toolName: "Cursor",
            configPathProject: ".cursor/settings.json",
        };
        mocks.getInstalledProviders.mockReturnValue([testProvider]);
        mocks.resolveConfigPath.mockReturnValue(null);
        mocks.existsSync.mockReturnValue(false);
        mocks.listMcpServers.mockResolvedValue([]);
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
        const program = new Command();
        registerMcpDetect(program);
        await program.parseAsync(["node", "test", "detect", "--human"]);
        const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
        expect(output).toContain("no servers");
    });
});
//# sourceMappingURL=coverage-mcp-list-remove-detect.test.js.map