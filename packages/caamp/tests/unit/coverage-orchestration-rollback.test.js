/**
 * Coverage tests for orchestration.ts rollback error paths.
 * Targets lines 357, 364-365, 371-372 (catch blocks during rollback).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
const mockInstallMcpServer = vi.hoisted(() => vi.fn());
const mockInstallSkill = vi.hoisted(() => vi.fn());
const mockRemoveSkill = vi.hoisted(() => vi.fn());
const mockExistsSyncFn = vi.hoisted(() => vi.fn().mockReturnValue(false));
const mockLstatSync = vi.hoisted(() => vi.fn());
const mockMkdir = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockRm = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockCp = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockWriteFile = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockReadFile = vi.hoisted(() => vi.fn().mockResolvedValue("{}"));
const mockReadlink = vi.hoisted(() => vi.fn().mockResolvedValue("/target"));
const mockSymlink = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockResolveConfigPath = vi.hoisted(() => vi.fn().mockReturnValue(null));
vi.mock("node:fs", () => ({
    existsSync: mockExistsSyncFn,
    lstatSync: mockLstatSync,
}));
vi.mock("node:fs/promises", () => ({
    mkdir: mockMkdir,
    rm: mockRm,
    cp: mockCp,
    writeFile: mockWriteFile,
    readFile: mockReadFile,
    readlink: mockReadlink,
    symlink: mockSymlink,
}));
vi.mock("../../src/core/mcp/installer.js", () => ({
    installMcpServer: mockInstallMcpServer,
}));
vi.mock("../../src/core/skills/installer.js", () => ({
    installSkill: mockInstallSkill,
    removeSkill: mockRemoveSkill,
}));
vi.mock("../../src/core/mcp/reader.js", () => ({
    listMcpServers: vi.fn().mockResolvedValue([]),
    resolveConfigPath: mockResolveConfigPath,
}));
vi.mock("../../src/core/instructions/injector.js", () => ({
    injectAll: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock("../../src/core/instructions/templates.js", () => ({
    groupByInstructFile: vi.fn().mockReturnValue(new Map()),
    generateInjectionContent: vi.fn().mockReturnValue("content"),
}));
vi.mock("../../src/core/paths/agents.js", () => ({
    CANONICAL_SKILLS_DIR: "/tmp/test-skills",
}));
vi.mock("../../src/core/registry/detection.js", () => ({
    getInstalledProviders: vi.fn().mockReturnValue([]),
}));
vi.mock("../../src/core/mcp/transforms.js", () => ({
    getTransform: vi.fn().mockReturnValue(null),
}));
describe("coverage: orchestration.ts rollback error paths", () => {
    const provider = {
        id: "p1",
        priority: "high",
        configFormat: "json",
        configKey: "mcpServers",
        pathSkills: "/tmp/skills",
        pathProjectSkills: ".skills",
    };
    beforeEach(() => {
        vi.clearAllMocks();
        mockMkdir.mockResolvedValue(undefined);
        mockRm.mockResolvedValue(undefined);
        mockCp.mockResolvedValue(undefined);
        mockWriteFile.mockResolvedValue(undefined);
        mockReadFile.mockResolvedValue("{}");
        mockSymlink.mockResolvedValue(undefined);
        mockExistsSyncFn.mockReturnValue(false);
        mockResolveConfigPath.mockReturnValue(null);
        mockLstatSync.mockReturnValue({ isSymbolicLink: () => false, isDirectory: () => false });
    });
    it("successful batch (no rollback)", async () => {
        const { installBatchWithRollback } = await import("../../src/core/advanced/orchestration.js");
        mockInstallMcpServer.mockResolvedValue({ success: true, configPath: "/tmp/test.json" });
        mockInstallSkill.mockResolvedValue({ success: true, linkedAgents: ["p1"], errors: [] });
        const result = await installBatchWithRollback({
            providers: [provider],
            mcp: [{ serverName: "test", config: { command: "npx" } }],
            skills: [{ skillName: "s", sourcePath: "/tmp/s", isGlobal: true }],
            projectDir: "/tmp/project",
        });
        expect(result.success).toBe(true);
        expect(result.rollbackPerformed).toBe(false);
    });
    it("MCP install failure triggers rollback", async () => {
        const { installBatchWithRollback } = await import("../../src/core/advanced/orchestration.js");
        mockInstallMcpServer.mockResolvedValue({ success: false, error: "MCP failed" });
        const result = await installBatchWithRollback({
            providers: [provider],
            mcp: [{ serverName: "test", config: { command: "npx" } }],
            skills: [],
            projectDir: "/tmp/project",
        });
        expect(result.success).toBe(false);
        expect(result.rollbackPerformed).toBe(true);
    });
    it("removeSkill throws during rollback (line 357)", async () => {
        const { installBatchWithRollback } = await import("../../src/core/advanced/orchestration.js");
        mockInstallSkill
            .mockResolvedValueOnce({ success: true, linkedAgents: ["p1"], errors: [] })
            .mockResolvedValueOnce({ success: true, linkedAgents: ["p1"], errors: ["fail"] });
        mockRemoveSkill.mockRejectedValue(new Error("removal failed"));
        const result = await installBatchWithRollback({
            providers: [provider],
            mcp: [],
            skills: [
                { skillName: "a", sourcePath: "/tmp/a", isGlobal: true },
                { skillName: "b", sourcePath: "/tmp/b", isGlobal: true },
            ],
            projectDir: "/tmp/project",
        });
        expect(result.success).toBe(false);
        expect(result.rollbackPerformed).toBe(true);
        expect(result.rollbackErrors.some(e => e.includes("removal failed"))).toBe(true);
    });
    it("restoreConfigSnapshots throws during rollback (lines 364-365)", async () => {
        const { installBatchWithRollback } = await import("../../src/core/advanced/orchestration.js");
        mockResolveConfigPath.mockReturnValue("/tmp/config.json");
        mockExistsSyncFn.mockReturnValue(true);
        mockReadFile.mockResolvedValue(JSON.stringify({ mcpServers: { old: {} } }));
        mockInstallMcpServer.mockResolvedValue({ success: false, error: "MCP failed" });
        mockWriteFile.mockRejectedValue(new Error("write restore failed"));
        const result = await installBatchWithRollback({
            providers: [provider],
            mcp: [{ serverName: "test", config: { command: "npx" } }],
            skills: [],
            projectDir: "/tmp/project",
        });
        expect(result.success).toBe(false);
        expect(result.rollbackPerformed).toBe(true);
        expect(result.rollbackErrors.some(e => e.includes("write restore failed"))).toBe(true);
    });
    it("restoreSkillSnapshot throws during rollback (lines 371-372)", async () => {
        const { installBatchWithRollback } = await import("../../src/core/advanced/orchestration.js");
        // Make canonical path "exist" for snapshot
        mockExistsSyncFn.mockReturnValue(true);
        mockLstatSync.mockReturnValue({ isSymbolicLink: () => false, isDirectory: () => true });
        mockInstallSkill.mockResolvedValue({ success: true, linkedAgents: ["p1"], errors: ["fail"] });
        mockRemoveSkill.mockResolvedValue(undefined);
        // First cp calls are for snapshotSkillState backup, let them succeed
        // Later cp calls are for restoreSkillSnapshot, make them fail
        let cpCallCount = 0;
        mockCp.mockImplementation(async () => {
            cpCallCount++;
            if (cpCallCount > 2) {
                throw new Error("restore snapshot failed");
            }
        });
        const result = await installBatchWithRollback({
            providers: [provider],
            mcp: [],
            skills: [{ skillName: "s", sourcePath: "/tmp/s", isGlobal: true }],
            projectDir: "/tmp/project",
        });
        expect(result.success).toBe(false);
        expect(result.rollbackPerformed).toBe(true);
        expect(result.rollbackErrors.some(e => e.includes("restore snapshot failed"))).toBe(true);
    });
    it("non-Error thrown during removeSkill rollback (line 357 String branch)", async () => {
        const { installBatchWithRollback } = await import("../../src/core/advanced/orchestration.js");
        mockInstallSkill.mockResolvedValue({ success: true, linkedAgents: ["p1"], errors: ["fail"] });
        mockRemoveSkill.mockRejectedValue("string error");
        const result = await installBatchWithRollback({
            providers: [provider],
            mcp: [],
            skills: [{ skillName: "s", sourcePath: "/tmp/s", isGlobal: true }],
            projectDir: "/tmp/project",
        });
        expect(result.success).toBe(false);
        expect(result.rollbackErrors).toContain("string error");
    });
    it("non-Error thrown during restoreConfigSnapshots (line 364 String branch)", async () => {
        const { installBatchWithRollback } = await import("../../src/core/advanced/orchestration.js");
        mockResolveConfigPath.mockReturnValue("/tmp/config.json");
        mockExistsSyncFn.mockReturnValue(true);
        mockReadFile.mockResolvedValue("{}");
        mockInstallMcpServer.mockResolvedValue({ success: false, error: "fail" });
        mockWriteFile.mockRejectedValue("non-error restore");
        const result = await installBatchWithRollback({
            providers: [provider],
            mcp: [{ serverName: "test", config: { command: "npx" } }],
            skills: [],
            projectDir: "/tmp/project",
        });
        expect(result.success).toBe(false);
        expect(result.rollbackErrors).toContain("non-error restore");
    });
});
//# sourceMappingURL=coverage-orchestration-rollback.test.js.map