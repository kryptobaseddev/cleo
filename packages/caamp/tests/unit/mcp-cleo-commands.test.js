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
    resolveFormat: vi.fn(),
    emitJsonError: vi.fn(),
    outputSuccess: vi.fn(),
    isHuman: vi.fn(),
    checkCommandReachability: vi.fn(),
    createInterface: vi.fn(),
    reconcileCleoLock: vi.fn(),
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
vi.mock("../../src/core/lafs.js", () => ({
    resolveFormat: mocks.resolveFormat,
    emitJsonError: mocks.emitJsonError,
    outputSuccess: mocks.outputSuccess,
    ErrorCodes: {
        FORMAT_CONFLICT: "E_FORMAT_CONFLICT",
        PROVIDER_NOT_FOUND: "E_PROVIDER_NOT_FOUND",
        INVALID_INPUT: "E_INVALID_INPUT",
    },
    ErrorCategories: {
        VALIDATION: "VALIDATION",
        NOT_FOUND: "NOT_FOUND",
    },
}));
vi.mock("../../src/core/logger.js", () => ({
    isHuman: mocks.isHuman,
}));
vi.mock("../../src/core/mcp/cleo.js", async (importOriginal) => {
    const original = await importOriginal();
    return {
        ...original,
        checkCommandReachability: mocks.checkCommandReachability,
    };
});
vi.mock("node:readline/promises", () => ({
    createInterface: mocks.createInterface,
}));
vi.mock("../../src/core/mcp/reconcile.js", () => ({
    reconcileCleoLock: mocks.reconcileCleoLock,
}));
import { executeCleoInstall, executeCleoUninstall, executeCleoShow, executeCleoRepair, mapCompatibilityInstallOptions, shouldUseCleoCompatibilityInstall, registerMcpCleoCommands, registerMcpCleoCompatibilityCommands, registerCleoCommands, } from "../../src/commands/mcp/cleo.js";
const provider = {
    id: "claude-code",
    toolName: "Claude Code",
    vendor: "Anthropic",
    agentFlag: "claude-code",
    aliases: [],
    pathGlobal: "/global",
    pathProject: ".",
    instructFile: "CLAUDE.md",
    configKey: "mcpServers",
    configFormat: "json",
    configPathGlobal: "/global/config.json",
    configPathProject: ".claude.json",
    pathSkills: "/global/skills",
    pathProjectSkills: ".skills",
    detection: { methods: ["binary"], binary: "claude" },
    supportedTransports: ["stdio"],
    supportsHeaders: false,
    priority: "high",
    status: "active",
    agentSkillsCompatible: true,
    capabilities: { skills: { agentsGlobalPath: null, agentsProjectPath: null, precedence: "vendor-only" }, hooks: { supported: [], hookConfigPath: null, hookFormat: null }, spawn: { supportsSubagents: false, supportsProgrammaticSpawn: false, supportsInterAgentComms: false, supportsParallelSpawn: false, spawnMechanism: null } },
};
const provider2 = {
    ...provider,
    id: "cursor",
    toolName: "Cursor",
};
describe("commands/mcp/cleo", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        Object.values(mocks).forEach((fn) => fn.mockReset());
        // Default mocks
        mocks.resolveFormat.mockReturnValue("json");
        mocks.isHuman.mockReturnValue(false);
        mocks.getInstalledProviders.mockReturnValue([provider]);
        mocks.getProvider.mockImplementation((id) => id === "claude-code" ? provider : id === "cursor" ? provider2 : undefined);
        mocks.installMcpServerToAll.mockResolvedValue([
            { provider, success: true, scope: "project", configPath: "/tmp/config.json" },
        ]);
        mocks.recordMcpInstall.mockResolvedValue(undefined);
        mocks.removeMcpFromLock.mockResolvedValue(true);
        mocks.getTrackedMcpServers.mockResolvedValue({});
        mocks.removeMcpServer.mockResolvedValue(true);
        mocks.listMcpServers.mockResolvedValue([]);
        mocks.checkCommandReachability.mockReturnValue({
            reachable: true,
            method: "lookup",
            detail: "npx",
        });
        mocks.reconcileCleoLock.mockResolvedValue({
            backfilled: [],
            pruned: [],
            alreadyTracked: 0,
            errors: [],
        });
        // Prevent actual process.exit
        vi.spyOn(process, "exit").mockImplementation((() => {
            throw new Error("process-exit");
        }));
    });
    // ── executeCleoInstall ──────────────────────────────────────────
    describe("executeCleoInstall", () => {
        it("installs stable channel in json mode", async () => {
            mocks.listMcpServers.mockResolvedValue([
                { name: "cleo", config: { command: "npx", args: ["-y", "@cleocode/cleo@latest", "mcp"] } },
            ]);
            await executeCleoInstall("install", { channel: "stable", provider: ["claude-code"], arg: [], env: [], json: true }, "mcp.cleo.install");
            expect(mocks.installMcpServerToAll).toHaveBeenCalledWith([provider], "cleo", expect.objectContaining({ command: "npx" }), "project");
            expect(mocks.recordMcpInstall).toHaveBeenCalled();
            expect(mocks.outputSuccess).toHaveBeenCalled();
        });
        it("installs in human mode with successful validation", async () => {
            mocks.resolveFormat.mockReturnValue("human");
            mocks.listMcpServers.mockResolvedValue([
                { name: "cleo", config: { command: "npx", args: ["-y", "@cleocode/cleo@latest"] } },
            ]);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            await executeCleoInstall("install", { channel: "stable", provider: ["claude-code"], arg: [], env: [], human: true }, "mcp.cleo.install");
            expect(mocks.recordMcpInstall).toHaveBeenCalled();
            expect(logSpy).toHaveBeenCalled();
        });
        it("installs in human mode with failed validation", async () => {
            mocks.resolveFormat.mockReturnValue("human");
            mocks.listMcpServers.mockResolvedValue([
                { name: "cleo", config: { command: "nonexistent-binary" } },
            ]);
            mocks.checkCommandReachability.mockReturnValue({
                reachable: false,
                method: "lookup",
                detail: "nonexistent-binary",
            });
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            await executeCleoInstall("install", { channel: "stable", provider: ["claude-code"], arg: [], env: [], human: true }, "mcp.cleo.install");
            expect(logSpy).toHaveBeenCalled();
        });
        it("installs in human mode with failed install result", async () => {
            mocks.resolveFormat.mockReturnValue("human");
            mocks.installMcpServerToAll.mockResolvedValue([
                { provider, success: false, scope: "project", configPath: "/tmp/config.json", error: "write failed" },
            ]);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            await executeCleoInstall("install", { channel: "stable", provider: ["claude-code"], arg: [], env: [], human: true }, "mcp.cleo.install");
            // recordMcpInstall should NOT be called when no successes
            expect(mocks.recordMcpInstall).not.toHaveBeenCalled();
            expect(logSpy).toHaveBeenCalled();
        });
        it("handles dry run in json mode", async () => {
            await executeCleoInstall("install", {
                channel: "stable",
                provider: ["claude-code"],
                arg: [],
                env: [],
                json: true,
                dryRun: true,
            }, "mcp.cleo.install");
            expect(mocks.outputSuccess).toHaveBeenCalledWith("mcp.cleo.install", "standard", expect.objectContaining({ dryRun: true }));
            expect(mocks.installMcpServerToAll).not.toHaveBeenCalled();
        });
        it("handles dry run in human mode", async () => {
            mocks.resolveFormat.mockReturnValue("human");
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            await executeCleoInstall("install", {
                channel: "stable",
                provider: ["claude-code"],
                arg: [],
                env: [],
                human: true,
                dryRun: true,
            }, "mcp.cleo.install");
            expect(logSpy).toHaveBeenCalled();
            expect(mocks.installMcpServerToAll).not.toHaveBeenCalled();
        });
        it("dry run in human mode shows env when present", async () => {
            mocks.resolveFormat.mockReturnValue("human");
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            await executeCleoInstall("install", {
                channel: "dev",
                provider: ["claude-code"],
                command: "./run.js",
                arg: ["--stdio"],
                env: ["CLEO_DIR=~/.cleo-dev"],
                human: true,
                dryRun: true,
            }, "mcp.cleo.install");
            const envLog = logSpy.mock.calls.find((call) => String(call[0]).includes("Env:"));
            expect(envLog).toBeDefined();
        });
        it("exits when no providers found in json mode", async () => {
            mocks.getInstalledProviders.mockReturnValue([]);
            await expect(executeCleoInstall("install", { channel: "stable", provider: [], arg: [], env: [], json: true }, "mcp.cleo.install")).rejects.toThrow("process-exit");
            expect(mocks.emitJsonError).toHaveBeenCalled();
        });
        it("exits when no providers found in human mode", async () => {
            mocks.resolveFormat.mockReturnValue("human");
            mocks.getInstalledProviders.mockReturnValue([]);
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            await expect(executeCleoInstall("install", { channel: "stable", provider: [], arg: [], env: [], human: true }, "mcp.cleo.install")).rejects.toThrow("process-exit");
            expect(errorSpy).toHaveBeenCalled();
        });
        it("exits on format conflict error", async () => {
            mocks.resolveFormat.mockImplementation(() => {
                throw new Error("Cannot specify both --json and --human");
            });
            await expect(executeCleoInstall("install", { channel: "stable", provider: ["claude-code"], arg: [], env: [], json: true, human: true }, "mcp.cleo.install")).rejects.toThrow("process-exit");
            expect(mocks.emitJsonError).toHaveBeenCalledWith("mcp.cleo.install", "standard", "E_FORMAT_CONFLICT", "Cannot specify both --json and --human", "VALIDATION");
        });
        it("handles format conflict with non-Error object", async () => {
            mocks.resolveFormat.mockImplementation(() => {
                throw "string-error";
            });
            await expect(executeCleoInstall("install", { channel: "stable", provider: ["claude-code"], arg: [], env: [] }, "mcp.cleo.install")).rejects.toThrow("process-exit");
            expect(mocks.emitJsonError).toHaveBeenCalledWith("mcp.cleo.install", "standard", "E_FORMAT_CONFLICT", "string-error", "VALIDATION");
        });
        it("uses --all flag to collect all providers", async () => {
            mocks.listMcpServers.mockResolvedValue([
                { name: "cleo", config: { command: "npx" } },
            ]);
            await executeCleoInstall("install", { channel: "stable", provider: [], all: true, arg: [], env: [], json: true }, "mcp.cleo.install");
            expect(mocks.getInstalledProviders).toHaveBeenCalled();
            expect(mocks.installMcpServerToAll).toHaveBeenCalled();
        });
        it("uses global scope when --global is set", async () => {
            mocks.listMcpServers.mockResolvedValue([
                { name: "cleo", config: { command: "npx" } },
            ]);
            await executeCleoInstall("install", { channel: "stable", provider: ["claude-code"], global: true, arg: [], env: [], json: true }, "mcp.cleo.install");
            expect(mocks.installMcpServerToAll).toHaveBeenCalledWith([provider], "cleo", expect.any(Object), "global");
        });
        it("detects server name conflicts in human mode", async () => {
            mocks.resolveFormat.mockReturnValue("human");
            // Existing server with non-cleo command
            mocks.listMcpServers.mockResolvedValue([
                { name: "cleo", config: { command: "some-other-tool", args: ["serve"] } },
            ]);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            await executeCleoInstall("install", { channel: "stable", provider: ["claude-code"], arg: [], env: [], human: true }, "mcp.cleo.install");
            const warningLog = logSpy.mock.calls.find((call) => String(call[0]).includes("conflict"));
            expect(warningLog).toBeDefined();
        });
        it("validates profile - server missing after write", async () => {
            mocks.resolveFormat.mockReturnValue("json");
            // listMcpServers returns empty for validation (server not found after write)
            mocks.listMcpServers.mockResolvedValue([]);
            await executeCleoInstall("install", { channel: "stable", provider: ["claude-code"], arg: [], env: [], json: true }, "mcp.cleo.install");
            const call = mocks.outputSuccess.mock.calls[0];
            expect(call).toBeDefined();
            const result = call[2];
            const validations = result.providers?.map((p) => p.validation);
            expect(validations?.[0]?.valid).toBe(false);
            expect(validations?.[0]?.reason).toContain("server missing");
        });
        it("validates profile - command without type", async () => {
            mocks.resolveFormat.mockReturnValue("json");
            // Server exists but has no command
            mocks.listMcpServers.mockResolvedValue([
                { name: "cleo", config: { url: "https://example.com" } },
            ]);
            await executeCleoInstall("install", { channel: "stable", provider: ["claude-code"], arg: [], env: [], json: true }, "mcp.cleo.install");
            const call = mocks.outputSuccess.mock.calls[0];
            const result = call[2];
            const validations = result.providers?.map((p) => p.validation);
            expect(validations?.[0]?.valid).toBe(true);
        });
    });
    // ── executeCleoUninstall ────────────────────────────────────────
    describe("executeCleoUninstall", () => {
        it("uninstalls in json mode", async () => {
            await executeCleoUninstall({ channel: "stable", provider: ["claude-code"], json: true }, "mcp.cleo.uninstall");
            expect(mocks.removeMcpServer).toHaveBeenCalledWith(provider, "cleo", "project");
            expect(mocks.removeMcpFromLock).toHaveBeenCalledWith("cleo");
            expect(mocks.outputSuccess).toHaveBeenCalled();
        });
        it("uninstalls in human mode with successful removal", async () => {
            mocks.resolveFormat.mockReturnValue("human");
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            await executeCleoUninstall({ channel: "stable", provider: ["claude-code"], human: true }, "mcp.cleo.uninstall");
            expect(logSpy).toHaveBeenCalled();
            const logOutput = logSpy.mock.calls.map((c) => String(c[0])).join(" ");
            expect(logOutput).toContain("cleo");
        });
        it("uninstalls in human mode with no matching profile", async () => {
            mocks.resolveFormat.mockReturnValue("human");
            mocks.removeMcpServer.mockResolvedValue(false);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            await executeCleoUninstall({ channel: "dev", provider: ["claude-code"], human: true }, "mcp.cleo.uninstall");
            // removeMcpFromLock should NOT be called when nothing was removed
            expect(mocks.removeMcpFromLock).not.toHaveBeenCalled();
            expect(logSpy).toHaveBeenCalled();
        });
        it("handles dry run in json mode", async () => {
            await executeCleoUninstall({ channel: "stable", provider: ["claude-code"], json: true, dryRun: true }, "mcp.cleo.uninstall");
            expect(mocks.outputSuccess).toHaveBeenCalledWith("mcp.cleo.uninstall", "standard", expect.objectContaining({ dryRun: true }));
            expect(mocks.removeMcpServer).not.toHaveBeenCalled();
        });
        it("handles dry run in human mode", async () => {
            mocks.resolveFormat.mockReturnValue("human");
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            await executeCleoUninstall({ channel: "beta", provider: ["claude-code"], human: true, dryRun: true }, "mcp.cleo.uninstall");
            expect(logSpy).toHaveBeenCalled();
            expect(mocks.removeMcpServer).not.toHaveBeenCalled();
        });
        it("uses global scope", async () => {
            await executeCleoUninstall({ channel: "stable", provider: ["claude-code"], global: true, json: true }, "mcp.cleo.uninstall");
            expect(mocks.removeMcpServer).toHaveBeenCalledWith(provider, "cleo", "global");
        });
        it("exits when no providers found in json mode", async () => {
            mocks.getInstalledProviders.mockReturnValue([]);
            await expect(executeCleoUninstall({ channel: "stable", provider: [], json: true }, "mcp.cleo.uninstall")).rejects.toThrow("process-exit");
            expect(mocks.emitJsonError).toHaveBeenCalled();
        });
        it("exits when no providers found in human mode", async () => {
            mocks.resolveFormat.mockReturnValue("human");
            mocks.getInstalledProviders.mockReturnValue([]);
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            await expect(executeCleoUninstall({ channel: "stable", provider: [], human: true }, "mcp.cleo.uninstall")).rejects.toThrow("process-exit");
            expect(errorSpy).toHaveBeenCalled();
        });
        it("exits on format conflict error", async () => {
            mocks.resolveFormat.mockImplementation(() => {
                throw new Error("format conflict");
            });
            await expect(executeCleoUninstall({ channel: "stable", provider: ["claude-code"] }, "mcp.cleo.uninstall")).rejects.toThrow("process-exit");
            expect(mocks.emitJsonError).toHaveBeenCalled();
        });
    });
    // ── executeCleoShow ─────────────────────────────────────────────
    describe("executeCleoShow", () => {
        it("shows profiles in json mode (both scopes by default)", async () => {
            mocks.listMcpServers.mockResolvedValue([
                { name: "cleo", config: { command: "npx", args: ["-y", "@cleocode/cleo@latest"] } },
                { name: "cleo-beta", config: { command: "npx", args: ["-y", "@cleocode/cleo@beta"] } },
                { name: "other-server", config: { command: "node" } },
            ]);
            mocks.getTrackedMcpServers.mockResolvedValue({
                cleo: { name: "cleo", version: "latest", source: "@cleocode/cleo@latest", sourceType: "package", installedAt: "2026-02-15T00:00:00.000Z" },
            });
            await executeCleoShow({ provider: ["claude-code"], json: true }, "mcp.cleo.show");
            expect(mocks.outputSuccess).toHaveBeenCalled();
            const call = mocks.outputSuccess.mock.calls[0];
            // Both project and global scopes scanned, 2 cleo entries per scope = 4 total
            expect(call[2].count).toBe(4);
            expect(call[2].scopes).toEqual(["project", "global"]);
        });
        it("shows profiles filtered by channel", async () => {
            mocks.listMcpServers.mockResolvedValue([
                { name: "cleo", config: { command: "npx", args: ["-y", "@cleocode/cleo@latest"] } },
                { name: "cleo-beta", config: { command: "npx", args: [] } },
            ]);
            await executeCleoShow({ provider: ["claude-code"], channel: "stable", json: true, project: true }, "mcp.cleo.show");
            const call = mocks.outputSuccess.mock.calls[0];
            expect(call[2].count).toBe(1);
            expect(call[2].profiles[0].channel).toBe("stable");
        });
        it("shows profiles in human mode with entries", async () => {
            mocks.resolveFormat.mockReturnValue("human");
            mocks.listMcpServers.mockResolvedValue([
                { name: "cleo", config: { command: "npx", args: ["arg1"], env: { KEY: "val" } } },
            ]);
            mocks.getTrackedMcpServers.mockResolvedValue({
                cleo: { name: "cleo", version: "latest", source: "@cleocode/cleo@latest", sourceType: "package", installedAt: "2026-02-15T00:00:00.000Z" },
            });
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            await executeCleoShow({ provider: ["claude-code"], human: true, project: true }, "mcp.cleo.show");
            expect(logSpy).toHaveBeenCalled();
            const allOutput = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
            expect(allOutput).toContain("CLEO Channel Profiles");
            expect(allOutput).toContain("healthy");
        });
        it("shows 'no profiles found' in human mode when empty", async () => {
            mocks.resolveFormat.mockReturnValue("human");
            mocks.listMcpServers.mockResolvedValue([]);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            await executeCleoShow({ provider: ["claude-code"], human: true }, "mcp.cleo.show");
            const noProfilesLog = logSpy.mock.calls.find((call) => String(call[0]).includes("No CLEO channel profiles found"));
            expect(noProfilesLog).toBeDefined();
        });
        it("--global scans only global scope", async () => {
            mocks.listMcpServers.mockResolvedValue([]);
            await executeCleoShow({ provider: ["claude-code"], global: true, json: true }, "mcp.cleo.show");
            expect(mocks.listMcpServers).toHaveBeenCalledWith(provider, "global");
            expect(mocks.listMcpServers).not.toHaveBeenCalledWith(provider, "project");
            const call = mocks.outputSuccess.mock.calls[0];
            expect(call[2].scopes).toEqual(["global"]);
        });
        it("--project scans only project scope", async () => {
            mocks.listMcpServers.mockResolvedValue([]);
            await executeCleoShow({ provider: ["claude-code"], project: true, json: true }, "mcp.cleo.show");
            expect(mocks.listMcpServers).toHaveBeenCalledWith(provider, "project");
            expect(mocks.listMcpServers).not.toHaveBeenCalledWith(provider, "global");
            const call = mocks.outputSuccess.mock.calls[0];
            expect(call[2].scopes).toEqual(["project"]);
        });
        it("merges lock file data into profiles", async () => {
            mocks.listMcpServers.mockResolvedValue([
                { name: "cleo", config: { command: "npx", args: ["-y", "@cleocode/cleo@latest"] } },
            ]);
            mocks.getTrackedMcpServers.mockResolvedValue({
                cleo: {
                    name: "cleo",
                    version: "latest",
                    source: "@cleocode/cleo@latest",
                    sourceType: "package",
                    installedAt: "2026-02-15T00:00:00.000Z",
                    updatedAt: "2026-02-20T00:00:00.000Z",
                },
            });
            await executeCleoShow({ provider: ["claude-code"], project: true, json: true }, "mcp.cleo.show");
            const call = mocks.outputSuccess.mock.calls[0];
            const profile = call[2].profiles[0];
            expect(profile.version).toBe("latest");
            expect(profile.source).toBe("@cleocode/cleo@latest");
            expect(profile.sourceType).toBe("package");
            expect(profile.installedAt).toBe("2026-02-15T00:00:00.000Z");
            expect(profile.updatedAt).toBe("2026-02-20T00:00:00.000Z");
        });
        it("sets null for lock data when entry not in lock file", async () => {
            mocks.listMcpServers.mockResolvedValue([
                { name: "cleo", config: { command: "npx", args: [] } },
            ]);
            mocks.getTrackedMcpServers.mockResolvedValue({});
            await executeCleoShow({ provider: ["claude-code"], project: true, json: true }, "mcp.cleo.show");
            const call = mocks.outputSuccess.mock.calls[0];
            const profile = call[2].profiles[0];
            expect(profile.version).toBeNull();
            expect(profile.installedAt).toBeNull();
            expect(profile.source).toBeNull();
        });
        it("health: command reachable + lock tracked = healthy", async () => {
            mocks.listMcpServers.mockResolvedValue([
                { name: "cleo", config: { command: "npx", args: [] } },
            ]);
            mocks.getTrackedMcpServers.mockResolvedValue({
                cleo: { name: "cleo", version: "latest", installedAt: "2026-02-15T00:00:00.000Z" },
            });
            mocks.checkCommandReachability.mockReturnValue({ reachable: true, method: "lookup", detail: "npx" });
            await executeCleoShow({ provider: ["claude-code"], project: true, json: true }, "mcp.cleo.show");
            const call = mocks.outputSuccess.mock.calls[0];
            expect(call[2].profiles[0].health.status).toBe("healthy");
        });
        it("health: command not reachable = broken", async () => {
            mocks.listMcpServers.mockResolvedValue([
                { name: "cleo-dev", config: { command: "./dist/mcp/index.js", args: [] } },
            ]);
            mocks.getTrackedMcpServers.mockResolvedValue({
                "cleo-dev": { name: "cleo-dev", version: undefined, installedAt: "2026-02-20T00:00:00.000Z" },
            });
            mocks.checkCommandReachability.mockReturnValue({ reachable: false, method: "path", detail: "./dist/mcp/index.js" });
            await executeCleoShow({ provider: ["claude-code"], project: true, json: true }, "mcp.cleo.show");
            const call = mocks.outputSuccess.mock.calls[0];
            expect(call[2].profiles[0].health.status).toBe("broken");
        });
        it("health: reachable but not in lock = degraded", async () => {
            mocks.listMcpServers.mockResolvedValue([
                { name: "cleo", config: { command: "npx", args: [] } },
            ]);
            mocks.getTrackedMcpServers.mockResolvedValue({});
            mocks.checkCommandReachability.mockReturnValue({ reachable: true, method: "lookup", detail: "npx" });
            await executeCleoShow({ provider: ["claude-code"], project: true, json: true }, "mcp.cleo.show");
            const call = mocks.outputSuccess.mock.calls[0];
            expect(call[2].profiles[0].health.status).toBe("degraded");
        });
        it("emits LAFS warnings for broken and degraded entries", async () => {
            mocks.listMcpServers.mockImplementation((_provider, scope) => {
                if (scope === "project") {
                    return Promise.resolve([
                        { name: "cleo-dev", config: { command: "./dist/mcp/index.js", args: [] } },
                        { name: "cleo", config: { command: "npx", args: [] } },
                    ]);
                }
                return Promise.resolve([]);
            });
            mocks.getTrackedMcpServers.mockResolvedValue({});
            mocks.checkCommandReachability.mockImplementation((cmd) => {
                if (cmd === "./dist/mcp/index.js")
                    return { reachable: false, method: "path", detail: "./dist/mcp/index.js" };
                return { reachable: true, method: "lookup", detail: cmd };
            });
            await executeCleoShow({ provider: ["claude-code"], project: true, json: true }, "mcp.cleo.show");
            // outputSuccess is called with warnings as 6th arg
            const call = mocks.outputSuccess.mock.calls[0];
            const warnings = call[5];
            expect(warnings).toBeDefined();
            expect(warnings.length).toBe(2);
            expect(warnings[0].code).toBe("W_COMMAND_UNREACHABLE");
            expect(warnings[1].code).toBe("W_NOT_TRACKED");
        });
        it("human table output shows issues section for broken entries", async () => {
            mocks.resolveFormat.mockReturnValue("human");
            mocks.listMcpServers.mockResolvedValue([
                { name: "cleo-dev", config: { command: "./dist/mcp/index.js", args: [] } },
            ]);
            mocks.getTrackedMcpServers.mockResolvedValue({});
            mocks.checkCommandReachability.mockReturnValue({ reachable: false, method: "path", detail: "./dist/mcp/index.js" });
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            await executeCleoShow({ provider: ["claude-code"], project: true, human: true }, "mcp.cleo.show");
            const allOutput = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
            expect(allOutput).toContain("Issues:");
            expect(allOutput).toContain("command not reachable");
        });
        it("exits when no providers found in json mode", async () => {
            mocks.getInstalledProviders.mockReturnValue([]);
            await expect(executeCleoShow({ provider: [], json: true }, "mcp.cleo.show")).rejects.toThrow("process-exit");
            expect(mocks.emitJsonError).toHaveBeenCalled();
        });
        it("exits when no providers found in human mode", async () => {
            mocks.resolveFormat.mockReturnValue("human");
            mocks.getInstalledProviders.mockReturnValue([]);
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            await expect(executeCleoShow({ provider: [], human: true }, "mcp.cleo.show")).rejects.toThrow("process-exit");
            expect(errorSpy).toHaveBeenCalled();
        });
        it("exits on format conflict error", async () => {
            mocks.resolveFormat.mockImplementation(() => {
                throw new Error("format conflict");
            });
            await expect(executeCleoShow({ provider: ["claude-code"] }, "mcp.cleo.show")).rejects.toThrow("process-exit");
            expect(mocks.emitJsonError).toHaveBeenCalled();
        });
        it("handles server entry with non-string args and non-object env", async () => {
            mocks.listMcpServers.mockResolvedValue([
                { name: "cleo", config: { command: "npx", args: null, env: null } },
            ]);
            await executeCleoShow({ provider: ["claude-code"], project: true, json: true }, "mcp.cleo.show");
            const call = mocks.outputSuccess.mock.calls[0];
            const profile = call[2].profiles[0];
            expect(profile.args).toEqual([]);
            expect(profile.env).toEqual({});
        });
    });
    // ── mapCompatibilityInstallOptions ──────────────────────────────
    describe("mapCompatibilityInstallOptions", () => {
        it("maps all fields correctly", () => {
            const result = mapCompatibilityInstallOptions({
                channel: "beta",
                provider: ["claude-code"],
                agent: ["cursor"],
                all: true,
                global: true,
                version: "1.0.0",
                command: "./run.js",
                arg: ["--stdio"],
                env: ["KEY=val"],
                cleoDir: "/custom",
                dryRun: true,
                yes: true,
                interactive: true,
                json: true,
                human: false,
            });
            expect(result.channel).toBe("beta");
            expect(result.provider).toEqual(["claude-code", "cursor"]);
            expect(result.all).toBe(true);
            expect(result.global).toBe(true);
            expect(result.version).toBe("1.0.0");
            expect(result.command).toBe("./run.js");
            expect(result.arg).toEqual(["--stdio"]);
            expect(result.env).toEqual(["KEY=val"]);
            expect(result.cleoDir).toBe("/custom");
            expect(result.dryRun).toBe(true);
            expect(result.yes).toBe(true);
            expect(result.interactive).toBe(true);
            expect(result.json).toBe(true);
            expect(result.human).toBe(false);
        });
        it("handles undefined arrays", () => {
            const result = mapCompatibilityInstallOptions({});
            expect(result.provider).toEqual([]);
            expect(result.arg).toEqual([]);
            expect(result.env).toEqual([]);
        });
        it("merges provider and agent arrays", () => {
            const result = mapCompatibilityInstallOptions({
                provider: ["a"],
                agent: ["b", "c"],
            });
            expect(result.provider).toEqual(["a", "b", "c"]);
        });
    });
    // ── Interactive install (runInteractiveInstall) ─────────────────
    describe("interactive install", () => {
        function createMockReadline(answers) {
            let callIndex = 0;
            const rl = {
                question: vi.fn().mockImplementation(() => {
                    const answer = answers[callIndex] ?? "";
                    callIndex += 1;
                    return Promise.resolve(answer);
                }),
                close: vi.fn(),
            };
            mocks.createInterface.mockReturnValue(rl);
            return rl;
        }
        it("runs interactive install flow for stable channel", async () => {
            mocks.resolveFormat.mockReturnValue("human");
            mocks.listMcpServers.mockResolvedValue([
                { name: "cleo", config: { command: "npx", args: ["-y", "@cleocode/cleo@latest"] } },
            ]);
            // Answers: provider selection, channel, confirm
            const rl = createMockReadline(["1", "stable", "y"]);
            vi.spyOn(console, "log").mockImplementation(() => { });
            await executeCleoInstall("install", {
                channel: undefined,
                provider: [],
                interactive: true,
                arg: [],
                env: [],
                human: true,
            }, "mcp.cleo.install");
            expect(rl.question).toHaveBeenCalled();
            expect(rl.close).toHaveBeenCalled();
            expect(mocks.installMcpServerToAll).toHaveBeenCalled();
        });
        it("runs interactive install flow for dev channel", async () => {
            mocks.resolveFormat.mockReturnValue("human");
            mocks.listMcpServers.mockResolvedValue([
                { name: "cleo-dev", config: { command: "./run.js" } },
            ]);
            // Answers: provider selection, channel, command, args, cleoDir, confirm
            const rl = createMockReadline(["all", "dev", "./run.js", "--stdio", "/custom/cleo", "y"]);
            vi.spyOn(console, "log").mockImplementation(() => { });
            await executeCleoInstall("install", {
                channel: undefined,
                provider: [],
                interactive: true,
                arg: [],
                env: [],
                human: true,
            }, "mcp.cleo.install");
            expect(rl.question).toHaveBeenCalled();
            expect(mocks.installMcpServerToAll).toHaveBeenCalled();
        });
        it("cancels interactive install when user declines confirmation", async () => {
            mocks.resolveFormat.mockReturnValue("human");
            // Answers: provider selection, channel, decline
            createMockReadline(["1", "stable", "N"]);
            vi.spyOn(console, "log").mockImplementation(() => { });
            await expect(executeCleoInstall("install", {
                channel: undefined,
                provider: [],
                interactive: true,
                arg: [],
                env: [],
                human: true,
            }, "mcp.cleo.install")).rejects.toThrow("Cancelled");
        });
        it("throws when no providers selected in interactive mode", async () => {
            mocks.resolveFormat.mockReturnValue("human");
            // Answer: empty provider selection
            createMockReadline(["999", "stable", "y"]);
            vi.spyOn(console, "log").mockImplementation(() => { });
            await expect(executeCleoInstall("install", {
                channel: undefined,
                provider: [],
                interactive: true,
                arg: [],
                env: [],
                human: true,
            }, "mcp.cleo.install")).rejects.toThrow("No providers selected");
        });
        it("throws when no installed providers detected", async () => {
            mocks.resolveFormat.mockReturnValue("human");
            mocks.getInstalledProviders.mockReturnValue([]);
            createMockReadline(["1", "stable", "y"]);
            vi.spyOn(console, "log").mockImplementation(() => { });
            await expect(executeCleoInstall("install", {
                channel: undefined,
                provider: [],
                interactive: true,
                arg: [],
                env: [],
                human: true,
            }, "mcp.cleo.install")).rejects.toThrow("No installed providers");
        });
        it("dev channel interactive install with empty args and empty cleoDir uses defaults", async () => {
            mocks.resolveFormat.mockReturnValue("human");
            mocks.listMcpServers.mockResolvedValue([
                { name: "cleo-dev", config: { command: "./run.js" } },
            ]);
            // Answers: provider, channel, command, empty args, empty cleoDir, confirm
            const rl = createMockReadline(["1", "dev", "./run.js", "", "", "y"]);
            vi.spyOn(console, "log").mockImplementation(() => { });
            await executeCleoInstall("install", {
                channel: undefined,
                provider: [],
                interactive: true,
                arg: [],
                env: [],
                human: true,
            }, "mcp.cleo.install");
            expect(rl.question).toHaveBeenCalled();
            expect(mocks.installMcpServerToAll).toHaveBeenCalled();
        });
    });
    // ── registerMcpCleoCompatibilityCommands error paths ────────────
    describe("registerMcpCleoCompatibilityCommands", () => {
        it("rejects update for non-cleo name", async () => {
            const program = new Command();
            registerMcpCleoCompatibilityCommands(program);
            await expect(program.parseAsync(["node", "test", "update", "not-cleo", "--channel", "stable", "--json"])).rejects.toThrow("process-exit");
            expect(mocks.emitJsonError).toHaveBeenCalledWith("mcp.update", "standard", "E_INVALID_INPUT", expect.stringContaining("Only managed profile 'cleo'"), "VALIDATION", { name: "not-cleo" });
        });
        it("rejects uninstall for non-cleo name", async () => {
            const program = new Command();
            registerMcpCleoCompatibilityCommands(program);
            await expect(program.parseAsync(["node", "test", "uninstall", "not-cleo", "--channel", "stable", "--json"])).rejects.toThrow("process-exit");
            expect(mocks.emitJsonError).toHaveBeenCalledWith("mcp.uninstall", "standard", "E_INVALID_INPUT", expect.stringContaining("Only managed profile 'cleo'"), "VALIDATION", { name: "not-cleo" });
        });
        it("rejects show for non-cleo name", async () => {
            const program = new Command();
            registerMcpCleoCompatibilityCommands(program);
            await expect(program.parseAsync(["node", "test", "show", "not-cleo", "--json"])).rejects.toThrow("process-exit");
            expect(mocks.emitJsonError).toHaveBeenCalledWith("mcp.show", "standard", "E_INVALID_INPUT", expect.stringContaining("Only managed profile 'cleo'"), "VALIDATION", { name: "not-cleo" });
        });
    });
    // ── registerMcpCleoCommands action callbacks ────────────────────
    describe("registerMcpCleoCommands", () => {
        it("registers install action callback", async () => {
            mocks.listMcpServers.mockResolvedValue([
                { name: "cleo", config: { command: "npx" } },
            ]);
            const program = new Command();
            registerMcpCleoCommands(program);
            await program.parseAsync([
                "node", "test", "cleo", "install",
                "--channel", "stable",
                "--provider", "claude-code",
                "--json",
            ]);
            expect(mocks.installMcpServerToAll).toHaveBeenCalled();
        });
        it("registers uninstall action callback", async () => {
            const program = new Command();
            registerMcpCleoCommands(program);
            await program.parseAsync([
                "node", "test", "cleo", "uninstall",
                "--channel", "stable",
                "--provider", "claude-code",
                "--json",
            ]);
            expect(mocks.removeMcpServer).toHaveBeenCalled();
        });
        it("registers show action callback", async () => {
            mocks.listMcpServers.mockResolvedValue([]);
            const program = new Command();
            registerMcpCleoCommands(program);
            await program.parseAsync([
                "node", "test", "cleo", "show",
                "--provider", "claude-code",
                "--json",
            ]);
            expect(mocks.outputSuccess).toHaveBeenCalled();
        });
    });
    // ── registerCleoCommands (top-level) ────────────────────────────
    describe("registerCleoCommands", () => {
        it("registers install action callback with cleo.* operation IDs", async () => {
            mocks.listMcpServers.mockResolvedValue([
                { name: "cleo", config: { command: "npx" } },
            ]);
            const program = new Command();
            registerCleoCommands(program);
            await program.parseAsync([
                "node", "test", "cleo", "install",
                "--channel", "stable",
                "--provider", "claude-code",
                "--json",
            ]);
            expect(mocks.installMcpServerToAll).toHaveBeenCalled();
            expect(mocks.outputSuccess).toHaveBeenCalledWith("cleo.install", "standard", expect.any(Object));
        });
        it("registers update action callback", async () => {
            mocks.listMcpServers.mockResolvedValue([
                { name: "cleo", config: { command: "npx" } },
            ]);
            const program = new Command();
            registerCleoCommands(program);
            await program.parseAsync([
                "node", "test", "cleo", "update",
                "--channel", "stable",
                "--provider", "claude-code",
                "--json",
            ]);
            expect(mocks.installMcpServerToAll).toHaveBeenCalled();
            expect(mocks.outputSuccess).toHaveBeenCalledWith("cleo.update", "standard", expect.any(Object));
        });
        it("registers uninstall action callback", async () => {
            const program = new Command();
            registerCleoCommands(program);
            await program.parseAsync([
                "node", "test", "cleo", "uninstall",
                "--channel", "stable",
                "--provider", "claude-code",
                "--json",
            ]);
            expect(mocks.removeMcpServer).toHaveBeenCalled();
            expect(mocks.outputSuccess).toHaveBeenCalledWith("cleo.uninstall", "standard", expect.any(Object));
        });
        it("registers show action callback", async () => {
            mocks.listMcpServers.mockResolvedValue([]);
            const program = new Command();
            registerCleoCommands(program);
            await program.parseAsync([
                "node", "test", "cleo", "show",
                "--provider", "claude-code",
                "--json",
            ]);
            expect(mocks.outputSuccess).toHaveBeenCalled();
            const call = mocks.outputSuccess.mock.calls[0];
            expect(call[0]).toBe("cleo.show");
            expect(call[1]).toBe("standard");
            expect(call[2]).toEqual(expect.objectContaining({ profiles: [], count: 0 }));
        });
    });
    // ── executeCleoRepair ────────────────────────────────────────────
    describe("executeCleoRepair", () => {
        it("outputs JSON with backfilled entries", async () => {
            mocks.reconcileCleoLock.mockResolvedValue({
                backfilled: [
                    {
                        serverName: "cleo",
                        channel: "stable",
                        scope: "project",
                        agents: ["claude-code", "cursor"],
                        source: "@cleocode/cleo@latest",
                        sourceType: "package",
                        version: "latest",
                    },
                ],
                pruned: [],
                alreadyTracked: 3,
                errors: [],
            });
            await executeCleoRepair({ provider: [], json: true }, "cleo.repair");
            expect(mocks.outputSuccess).toHaveBeenCalledWith("cleo.repair", "standard", expect.objectContaining({
                backfilled: expect.arrayContaining([
                    expect.objectContaining({ serverName: "cleo", channel: "stable" }),
                ]),
                alreadyTracked: 3,
                dryRun: false,
            }));
        });
        it("passes dry-run flag through to reconcileCleoLock", async () => {
            await executeCleoRepair({ provider: [], dryRun: true, json: true }, "cleo.repair");
            expect(mocks.reconcileCleoLock).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
            const call = mocks.outputSuccess.mock.calls[0];
            expect(call[2].dryRun).toBe(true);
        });
        it("passes prune flag through to reconcileCleoLock", async () => {
            mocks.reconcileCleoLock.mockResolvedValue({
                backfilled: [],
                pruned: ["cleo-beta"],
                alreadyTracked: 2,
                errors: [],
            });
            await executeCleoRepair({ provider: [], prune: true, json: true }, "cleo.repair");
            expect(mocks.reconcileCleoLock).toHaveBeenCalledWith(expect.objectContaining({ prune: true }));
            const call = mocks.outputSuccess.mock.calls[0];
            expect(call[2].pruned).toEqual(["cleo-beta"]);
        });
        it("shows human-readable output with backfill summary", async () => {
            mocks.resolveFormat.mockReturnValue("human");
            mocks.reconcileCleoLock.mockResolvedValue({
                backfilled: [
                    {
                        serverName: "cleo",
                        channel: "stable",
                        scope: "project",
                        agents: ["claude-code"],
                        source: "@cleocode/cleo@latest",
                        sourceType: "package",
                        version: "latest",
                    },
                ],
                pruned: [],
                alreadyTracked: 0,
                errors: [],
            });
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            await executeCleoRepair({ provider: [], human: true }, "cleo.repair");
            const allOutput = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
            expect(allOutput).toContain("CLEO Lock Repair");
            expect(allOutput).toContain("1 backfilled");
            expect(allOutput).toContain("0 pruned");
        });
        it("shows 'no changes needed' when all tracked", async () => {
            mocks.resolveFormat.mockReturnValue("human");
            mocks.reconcileCleoLock.mockResolvedValue({
                backfilled: [],
                pruned: [],
                alreadyTracked: 5,
                errors: [],
            });
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            await executeCleoRepair({ provider: [], human: true }, "cleo.repair");
            const allOutput = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
            expect(allOutput).toContain("No changes needed");
        });
        it("registers repair via registerMcpCleoCommands", async () => {
            const program = new Command();
            registerMcpCleoCommands(program);
            await program.parseAsync([
                "node", "test", "cleo", "repair",
                "--json",
            ]);
            expect(mocks.reconcileCleoLock).toHaveBeenCalled();
            expect(mocks.outputSuccess).toHaveBeenCalled();
            const call = mocks.outputSuccess.mock.calls[0];
            expect(call[0]).toBe("mcp.cleo.repair");
        });
        it("registers repair via registerCleoCommands", async () => {
            const program = new Command();
            registerCleoCommands(program);
            await program.parseAsync([
                "node", "test", "cleo", "repair",
                "--json",
            ]);
            expect(mocks.reconcileCleoLock).toHaveBeenCalled();
            expect(mocks.outputSuccess).toHaveBeenCalled();
            const call = mocks.outputSuccess.mock.calls[0];
            expect(call[0]).toBe("cleo.repair");
        });
    });
    // ── shouldUseCleoCompatibilityInstall ───────────────────────────
    describe("shouldUseCleoCompatibilityInstall", () => {
        it("returns true for 'cleo' source with a channel", () => {
            expect(shouldUseCleoCompatibilityInstall("cleo", "stable")).toBe(true);
        });
        it("returns true for 'CLEO' (case insensitive) with a channel", () => {
            expect(shouldUseCleoCompatibilityInstall("CLEO", "beta")).toBe(true);
        });
        it("returns true for ' cleo ' with whitespace and a channel", () => {
            expect(shouldUseCleoCompatibilityInstall(" cleo ", "dev")).toBe(true);
        });
        it("returns false when source is not cleo", () => {
            expect(shouldUseCleoCompatibilityInstall("other", "stable")).toBe(false);
        });
        it("returns false when channel is undefined", () => {
            expect(shouldUseCleoCompatibilityInstall("cleo", undefined)).toBe(false);
        });
        it("returns false when channel is empty string", () => {
            expect(shouldUseCleoCompatibilityInstall("cleo", "")).toBe(false);
        });
        it("returns false when channel is whitespace only", () => {
            expect(shouldUseCleoCompatibilityInstall("cleo", "  ")).toBe(false);
        });
    });
});
//# sourceMappingURL=mcp-cleo-commands.test.js.map