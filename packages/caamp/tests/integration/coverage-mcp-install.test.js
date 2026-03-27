/**
 * Coverage tests for mcp install command - targets uncovered lines/branches.
 */
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
    parseSource: vi.fn(),
    installMcpServerToAll: vi.fn(),
    buildServerConfig: vi.fn(),
    recordMcpInstall: vi.fn(),
    getInstalledProviders: vi.fn(),
    getProvider: vi.fn(),
}));
vi.mock("../../src/core/sources/parser.js", () => ({
    parseSource: mocks.parseSource,
}));
vi.mock("../../src/core/mcp/installer.js", () => ({
    installMcpServerToAll: mocks.installMcpServerToAll,
    buildServerConfig: mocks.buildServerConfig,
}));
vi.mock("../../src/core/mcp/lock.js", () => ({
    recordMcpInstall: mocks.recordMcpInstall,
}));
vi.mock("../../src/core/registry/detection.js", () => ({
    getInstalledProviders: mocks.getInstalledProviders,
}));
vi.mock("../../src/core/registry/providers.js", () => ({
    getProvider: mocks.getProvider,
}));
import { registerMcpInstall } from "../../src/commands/mcp/install.js";
const provider = { id: "claude-code", toolName: "Claude Code" };
describe("coverage: mcp install", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        Object.values(mocks).forEach((m) => m.mockReset());
        mocks.parseSource.mockReturnValue({ type: "package", value: "@acme/mcp", inferredName: "acme" });
        mocks.buildServerConfig.mockReturnValue({ command: "npx", args: ["-y", "@acme/mcp"] });
        mocks.getInstalledProviders.mockReturnValue([provider]);
        mocks.getProvider.mockImplementation((name) => name === "claude-code" ? provider : undefined);
        mocks.installMcpServerToAll.mockResolvedValue([
            { provider, success: true, scope: "project", configPath: "/tmp/c.json" },
        ]);
        mocks.recordMcpInstall.mockResolvedValue(undefined);
    });
    // Lines 68-69: headers parsing
    it("parses headers from --header flag", async () => {
        vi.spyOn(console, "log").mockImplementation(() => { });
        const program = new Command();
        registerMcpInstall(program);
        await program.parseAsync([
            "node", "test", "install", "@acme/mcp", "--all",
            "--header", "Authorization: Bearer token123",
            "--header", "X-Custom: value",
            "--dry-run",
        ]);
        expect(mocks.buildServerConfig).toHaveBeenCalledWith(expect.anything(), "http", { Authorization: "Bearer token123", "X-Custom": "value" });
    });
    // Lines 139-146: human-readable output for success + failure results
    it("prints human-readable success/failure results", async () => {
        mocks.installMcpServerToAll.mockResolvedValue([
            { provider: { id: "claude-code", toolName: "Claude Code" }, success: true, scope: "project", configPath: "/tmp/c.json" },
            { provider: { id: "cursor", toolName: "Cursor" }, success: false, scope: "project", configPath: "", error: "write failed" },
        ]);
        mocks.getInstalledProviders.mockReturnValue([
            { id: "claude-code", toolName: "Claude Code" },
            { id: "cursor", toolName: "Cursor" },
        ]);
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
        const program = new Command();
        registerMcpInstall(program);
        await program.parseAsync(["node", "test", "install", "@acme/mcp", "--all", "--human"]);
        const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
        expect(output).toContain("Claude Code");
        expect(output).toContain("write failed");
    });
    // Lines 168-169: human-readable summary after install
    it("prints human-readable summary line", async () => {
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
        const program = new Command();
        registerMcpInstall(program);
        await program.parseAsync(["node", "test", "install", "@acme/mcp", "--all", "--human"]);
        const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
        expect(output).toContain("1/1 providers configured.");
    });
    // Line 97: human error when no providers found
    it("exits with human error when no providers found", async () => {
        mocks.getInstalledProviders.mockReturnValue([]);
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
        const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
            throw new Error("process-exit");
        }));
        const program = new Command();
        registerMcpInstall(program);
        await expect(program.parseAsync(["node", "test", "install", "@acme/mcp", "--all", "--human"])).rejects.toThrow("process-exit");
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("No target providers found."));
    });
    // Branch: --agent specific resolution
    it("resolves providers via --agent flag", async () => {
        vi.spyOn(console, "log").mockImplementation(() => { });
        const program = new Command();
        registerMcpInstall(program);
        await program.parseAsync(["node", "test", "install", "@acme/mcp", "--agent", "claude-code"]);
        expect(mocks.getProvider).toHaveBeenCalledWith("claude-code");
    });
    // Branch: dry-run with --human
    it("shows human-readable dry-run output", async () => {
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
        const program = new Command();
        registerMcpInstall(program);
        await program.parseAsync(["node", "test", "install", "@acme/mcp", "--all", "--dry-run", "--human"]);
        const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
        expect(output).toContain("Dry run - would install:");
        expect(output).toContain("Scope: project");
    });
    // Branch: no lock record when all installs fail
    it("does not record lock when all installs fail", async () => {
        mocks.installMcpServerToAll.mockResolvedValue([
            { provider, success: false, scope: "project", configPath: "", error: "fail" },
        ]);
        vi.spyOn(console, "log").mockImplementation(() => { });
        const program = new Command();
        registerMcpInstall(program);
        await program.parseAsync(["node", "test", "install", "@acme/mcp", "--all", "--json"]);
        expect(mocks.recordMcpInstall).not.toHaveBeenCalled();
    });
    // Branch: format conflict
    it("exits with format conflict error", async () => {
        vi.spyOn(console, "error").mockImplementation(() => { });
        const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
            throw new Error("process-exit");
        }));
        const program = new Command();
        registerMcpInstall(program);
        await expect(program.parseAsync(["node", "test", "install", "@acme/mcp", "--json", "--human"])).rejects.toThrow("process-exit");
        expect(exitSpy).toHaveBeenCalledWith(1);
    });
    // Branch: global scope + human progress message
    it("installs to global scope with --global flag in human mode", async () => {
        vi.spyOn(console, "log").mockImplementation(() => { });
        const program = new Command();
        registerMcpInstall(program);
        await program.parseAsync(["node", "test", "install", "@acme/mcp", "--all", "--global", "--human"]);
        expect(mocks.installMcpServerToAll).toHaveBeenCalledWith(expect.anything(), "acme", expect.anything(), "global");
    });
    // Lines 89-90: default path (no --all, no --agent) falls through to getInstalledProviders
    it("uses default installed providers when no --all or --agent given", async () => {
        vi.spyOn(console, "log").mockImplementation(() => { });
        const program = new Command();
        registerMcpInstall(program);
        // No --all, no --agent flags
        await program.parseAsync(["node", "test", "install", "@acme/mcp"]);
        expect(mocks.getInstalledProviders).toHaveBeenCalled();
        expect(mocks.installMcpServerToAll).toHaveBeenCalled();
    });
});
//# sourceMappingURL=coverage-mcp-install.test.js.map