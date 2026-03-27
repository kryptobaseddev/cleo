import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
    getInstalledProviders: vi.fn(),
    getTrackedMcpServers: vi.fn(),
    recordMcpInstall: vi.fn(),
    removeMcpFromLock: vi.fn(),
    listMcpServers: vi.fn(),
}));
vi.mock("../../src/core/registry/detection.js", () => ({
    getInstalledProviders: mocks.getInstalledProviders,
}));
vi.mock("../../src/core/mcp/lock.js", () => ({
    getTrackedMcpServers: mocks.getTrackedMcpServers,
    recordMcpInstall: mocks.recordMcpInstall,
    removeMcpFromLock: mocks.removeMcpFromLock,
}));
vi.mock("../../src/core/mcp/reader.js", () => ({
    listMcpServers: mocks.listMcpServers,
}));
import { inferCleoLockData, reconcileCleoLock } from "../../src/core/mcp/reconcile.js";
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
    capabilities: {
        skills: {
            agentsGlobalPath: "/global/skills",
            agentsProjectPath: ".skills",
            precedence: "agents-canonical",
        },
        hooks: { supported: [], hookConfigPath: null, hookFormat: null },
        spawn: {
            supportsSubagents: false,
            supportsProgrammaticSpawn: false,
            supportsInterAgentComms: false,
            supportsParallelSpawn: false,
            spawnMechanism: null,
        },
    },
};
const provider2 = {
    ...provider,
    id: "cursor",
    toolName: "Cursor",
};
describe("inferCleoLockData", () => {
    it("detects npx + cleo package as package source", () => {
        const result = inferCleoLockData({ command: "npx", args: ["-y", "@cleocode/cleo@latest", "mcp"] }, "stable");
        expect(result.sourceType).toBe("package");
        expect(result.source).toBe("@cleocode/cleo@latest");
        expect(result.version).toBe("latest");
    });
    it("detects beta package spec", () => {
        const result = inferCleoLockData({ command: "npx", args: ["-y", "@cleocode/cleo@beta", "mcp"] }, "beta");
        expect(result.sourceType).toBe("package");
        expect(result.source).toBe("@cleocode/cleo@beta");
        expect(result.version).toBe("beta");
    });
    it("detects dev channel as command source", () => {
        const result = inferCleoLockData({ command: "/home/user/cleo/dist/cli.js", args: ["mcp"] }, "dev");
        expect(result.sourceType).toBe("command");
        expect(result.source).toBe("/home/user/cleo/dist/cli.js");
        expect(result.version).toBeUndefined();
    });
    it("detects path-based command as command source", () => {
        const result = inferCleoLockData({ command: "./local/bin/cleo", args: ["serve"] }, "stable");
        expect(result.sourceType).toBe("command");
        expect(result.source).toBe("./local/bin/cleo");
        expect(result.version).toBeUndefined();
    });
    it("falls back to command + args for unknown patterns", () => {
        const result = inferCleoLockData({ command: "node", args: ["server.js"] }, "stable");
        expect(result.sourceType).toBe("command");
        expect(result.source).toBe("node server.js");
        expect(result.version).toBeUndefined();
    });
    it("handles empty config gracefully", () => {
        const result = inferCleoLockData({}, "stable");
        expect(result.sourceType).toBe("command");
        expect(result.source).toBe("unknown");
        expect(result.version).toBeUndefined();
    });
});
describe("reconcileCleoLock", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        Object.values(mocks).forEach((fn) => fn.mockReset());
        mocks.getInstalledProviders.mockReturnValue([provider, provider2]);
        mocks.getTrackedMcpServers.mockResolvedValue({});
        mocks.recordMcpInstall.mockResolvedValue(undefined);
        mocks.removeMcpFromLock.mockResolvedValue(true);
        mocks.listMcpServers.mockResolvedValue([]);
    });
    it("backfills untracked CLEO entries", async () => {
        mocks.listMcpServers.mockResolvedValue([
            { name: "cleo", config: { command: "npx", args: ["-y", "@cleocode/cleo@latest", "mcp"] } },
        ]);
        const result = await reconcileCleoLock({ project: true });
        expect(result.backfilled).toHaveLength(1);
        expect(result.backfilled[0]).toEqual(expect.objectContaining({
            serverName: "cleo",
            channel: "stable",
            sourceType: "package",
        }));
        // Agents should include both providers since both have the entry
        expect(result.backfilled[0].agents).toContain("claude-code");
        expect(result.backfilled[0].agents).toContain("cursor");
        expect(mocks.recordMcpInstall).toHaveBeenCalled();
    });
    it("skips already-tracked entries", async () => {
        mocks.getTrackedMcpServers.mockResolvedValue({
            cleo: { name: "cleo", source: "@cleocode/cleo@latest", sourceType: "package", version: "latest" },
        });
        mocks.listMcpServers.mockResolvedValue([
            { name: "cleo", config: { command: "npx", args: ["-y", "@cleocode/cleo@latest", "mcp"] } },
        ]);
        const result = await reconcileCleoLock();
        expect(result.backfilled).toHaveLength(0);
        expect(result.alreadyTracked).toBeGreaterThan(0);
        expect(mocks.recordMcpInstall).not.toHaveBeenCalled();
    });
    it("prunes orphaned CLEO lock entries", async () => {
        mocks.getTrackedMcpServers.mockResolvedValue({
            cleo: { name: "cleo", source: "@cleocode/cleo@latest", sourceType: "package" },
            "cleo-beta": { name: "cleo-beta", source: "@cleocode/cleo@beta", sourceType: "package" },
        });
        // Only "cleo" exists in live config, "cleo-beta" is orphaned
        mocks.listMcpServers.mockResolvedValue([
            { name: "cleo", config: { command: "npx", args: ["-y", "@cleocode/cleo@latest", "mcp"] } },
        ]);
        const result = await reconcileCleoLock({ prune: true });
        expect(result.pruned).toContain("cleo-beta");
        expect(mocks.removeMcpFromLock).toHaveBeenCalledWith("cleo-beta");
    });
    it("does not write when dry-run is true", async () => {
        mocks.listMcpServers.mockResolvedValue([
            { name: "cleo", config: { command: "npx", args: ["-y", "@cleocode/cleo@latest", "mcp"] } },
        ]);
        const result = await reconcileCleoLock({ dryRun: true, project: true });
        expect(result.backfilled).toHaveLength(1);
        expect(mocks.recordMcpInstall).not.toHaveBeenCalled();
    });
    it("does not prune when dry-run is true", async () => {
        mocks.getTrackedMcpServers.mockResolvedValue({
            "cleo-beta": { name: "cleo-beta", source: "@cleocode/cleo@beta", sourceType: "package" },
        });
        mocks.listMcpServers.mockResolvedValue([]);
        const result = await reconcileCleoLock({ prune: true, dryRun: true });
        expect(result.pruned).toContain("cleo-beta");
        expect(mocks.removeMcpFromLock).not.toHaveBeenCalled();
    });
    it("ignores non-CLEO server entries", async () => {
        mocks.listMcpServers.mockResolvedValue([
            { name: "filesystem", config: { command: "node", args: ["fs-server.js"] } },
            { name: "cleo", config: { command: "npx", args: ["-y", "@cleocode/cleo@latest", "mcp"] } },
        ]);
        const result = await reconcileCleoLock({ project: true });
        expect(result.backfilled).toHaveLength(1);
        expect(result.backfilled[0].serverName).toBe("cleo");
    });
    it("merges agents from multiple providers into a single backfill", async () => {
        // Both providers return the same "cleo" entry
        mocks.listMcpServers.mockResolvedValue([
            { name: "cleo", config: { command: "npx", args: ["-y", "@cleocode/cleo@latest", "mcp"] } },
        ]);
        const result = await reconcileCleoLock();
        // Should be one backfill entry with both agents
        const backfillEntry = result.backfilled.find((b) => b.serverName === "cleo" && b.scope === "project");
        expect(backfillEntry).toBeDefined();
        expect(backfillEntry.agents).toContain("claude-code");
        expect(backfillEntry.agents).toContain("cursor");
    });
    it("respects --global scope filter", async () => {
        mocks.listMcpServers.mockResolvedValue([
            { name: "cleo", config: { command: "npx", args: ["-y", "@cleocode/cleo@latest", "mcp"] } },
        ]);
        await reconcileCleoLock({ global: true });
        // Should only be called with "global" scope
        for (const call of mocks.listMcpServers.mock.calls) {
            expect(call[1]).toBe("global");
        }
    });
    it("respects --project scope filter", async () => {
        mocks.listMcpServers.mockResolvedValue([
            { name: "cleo", config: { command: "npx", args: ["-y", "@cleocode/cleo@latest", "mcp"] } },
        ]);
        await reconcileCleoLock({ project: true });
        for (const call of mocks.listMcpServers.mock.calls) {
            expect(call[1]).toBe("project");
        }
    });
    it("handles errors during backfill gracefully", async () => {
        mocks.listMcpServers.mockResolvedValue([
            { name: "cleo", config: { command: "npx", args: ["-y", "@cleocode/cleo@latest", "mcp"] } },
        ]);
        mocks.recordMcpInstall.mockRejectedValue(new Error("Lock file write failed"));
        const result = await reconcileCleoLock({ project: true });
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]?.message).toContain("Failed to backfill cleo");
        expect(result.errors[0]?.message).toContain("Lock file write failed");
        expect(result.backfilled).toHaveLength(0);
    });
    it("handles non-Error exceptions during backfill", async () => {
        mocks.listMcpServers.mockResolvedValue([
            { name: "cleo", config: { command: "npx", args: ["-y", "@cleocode/cleo@latest", "mcp"] } },
        ]);
        mocks.recordMcpInstall.mockRejectedValue("String error");
        const result = await reconcileCleoLock({ project: true });
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]?.message).toContain("String error");
    });
    it("handles listMcpServers errors for each provider", async () => {
        mocks.listMcpServers.mockRejectedValue(new Error("Config read error"));
        const result = await reconcileCleoLock({});
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors[0]?.message).toContain("Failed to read config");
        expect(result.backfilled).toHaveLength(0);
    });
});
//# sourceMappingURL=mcp-reconcile.test.js.map