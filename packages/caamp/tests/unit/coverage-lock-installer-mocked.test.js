/**
 * Coverage tests for skills/lock.ts with mocked dependencies.
 * Targets: fetchLatestSha branches, checkSkillUpdate paths, recordSkillInstall, removeSkillFromLock.
 *
 * Also covers: mcp/installer.ts error and transform branches.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
// Mocks for skills/lock.ts
const mockReadLockFile = vi.hoisted(() => vi.fn());
const mockUpdateLockFile = vi.hoisted(() => vi.fn());
const mockParseSource = vi.hoisted(() => vi.fn());
const mockListRemote = vi.hoisted(() => vi.fn());
vi.mock("../../src/core/lock-utils.js", () => ({
    readLockFile: mockReadLockFile,
    updateLockFile: mockUpdateLockFile,
}));
vi.mock("../../src/core/sources/parser.js", () => ({
    parseSource: mockParseSource,
}));
vi.mock("simple-git", () => ({
    simpleGit: () => ({
        listRemote: mockListRemote,
    }),
}));
// ── skills/lock.ts ───────────────────────────────────────────────────────────
describe("coverage: skills/lock.ts checkSkillUpdate branches", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });
    it("returns unknown for non-existent skill", async () => {
        mockReadLockFile.mockResolvedValue({ version: 1, skills: {}, mcpServers: {} });
        const { checkSkillUpdate } = await import("../../src/core/skills/lock.js");
        const result = await checkSkillUpdate("nonexistent");
        expect(result.hasUpdate).toBe(false);
        expect(result.status).toBe("unknown");
    });
    it("returns unknown for local source type (line 162-167)", async () => {
        mockReadLockFile.mockResolvedValue({
            version: 1,
            skills: { "s": { name: "s", sourceType: "local", version: "1.0", source: "." } },
            mcpServers: {},
        });
        const { checkSkillUpdate } = await import("../../src/core/skills/lock.js");
        const result = await checkSkillUpdate("s");
        expect(result.status).toBe("unknown");
        expect(result.currentVersion).toBe("1.0");
    });
    it("returns unknown for package source type", async () => {
        mockReadLockFile.mockResolvedValue({
            version: 1,
            skills: { "s": { name: "s", sourceType: "package", version: "1.0", source: "@mcp/test" } },
            mcpServers: {},
        });
        const { checkSkillUpdate } = await import("../../src/core/skills/lock.js");
        const result = await checkSkillUpdate("s");
        expect(result.status).toBe("unknown");
    });
    it("returns unknown when parseSource has no owner/repo (lines 171-176)", async () => {
        mockReadLockFile.mockResolvedValue({
            version: 1,
            skills: { "s": { name: "s", sourceType: "github", version: "abc", source: "x" } },
            mcpServers: {},
        });
        mockParseSource.mockReturnValue({ type: "github", owner: undefined, repo: undefined });
        const { checkSkillUpdate } = await import("../../src/core/skills/lock.js");
        const result = await checkSkillUpdate("s");
        expect(result.status).toBe("unknown");
    });
    it("returns unknown when fetchLatestSha returns null (lines 183-188)", async () => {
        mockReadLockFile.mockResolvedValue({
            version: 1,
            skills: { "s": { name: "s", sourceType: "github", version: "abc", source: "o/r" } },
            mcpServers: {},
        });
        mockParseSource.mockReturnValue({ type: "github", owner: "o", repo: "r" });
        mockListRemote.mockResolvedValue(""); // empty = no SHA
        const { checkSkillUpdate } = await import("../../src/core/skills/lock.js");
        const result = await checkSkillUpdate("s");
        expect(result.status).toBe("unknown");
    });
    it("returns up-to-date when SHA matches (line 192)", async () => {
        mockReadLockFile.mockResolvedValue({
            version: 1,
            skills: { "s": { name: "s", sourceType: "github", version: "abc1234567890", source: "o/r" } },
            mcpServers: {},
        });
        mockParseSource.mockReturnValue({ type: "github", owner: "o", repo: "r" });
        mockListRemote.mockResolvedValue("abc1234567890abcdef\tHEAD\n");
        const { checkSkillUpdate } = await import("../../src/core/skills/lock.js");
        const result = await checkSkillUpdate("s");
        expect(result.status).toBe("up-to-date");
        expect(result.hasUpdate).toBe(false);
        expect(result.latestVersion).toBe("abc123456789");
    });
    it("returns update-available when SHA differs (line 192)", async () => {
        mockReadLockFile.mockResolvedValue({
            version: 1,
            skills: { "s": { name: "s", sourceType: "github", version: "old1234567890", source: "o/r" } },
            mcpServers: {},
        });
        mockParseSource.mockReturnValue({ type: "github", owner: "o", repo: "r" });
        mockListRemote.mockResolvedValue("new9876543210abcdef\tHEAD\n");
        const { checkSkillUpdate } = await import("../../src/core/skills/lock.js");
        const result = await checkSkillUpdate("s");
        expect(result.status).toBe("update-available");
        expect(result.hasUpdate).toBe(true);
    });
    it("returns update-available when no currentVersion (line 192)", async () => {
        mockReadLockFile.mockResolvedValue({
            version: 1,
            skills: { "s": { name: "s", sourceType: "github", version: undefined, source: "o/r" } },
            mcpServers: {},
        });
        mockParseSource.mockReturnValue({ type: "github", owner: "o", repo: "r" });
        mockListRemote.mockResolvedValue("abc1234567890abcdef\tHEAD\n");
        const { checkSkillUpdate } = await import("../../src/core/skills/lock.js");
        const result = await checkSkillUpdate("s");
        expect(result.hasUpdate).toBe(true);
        expect(result.currentVersion).toBe("unknown");
    });
    it("uses ref when provided for gitlab (line 118-120)", async () => {
        mockReadLockFile.mockResolvedValue({
            version: 1,
            skills: { "s": { name: "s", sourceType: "gitlab", version: "abc", source: "o/r" } },
            mcpServers: {},
        });
        mockParseSource.mockReturnValue({ type: "gitlab", owner: "o", repo: "r", ref: "develop" });
        mockListRemote.mockResolvedValue("abc1234567890\trefs/heads/develop\n");
        const { checkSkillUpdate } = await import("../../src/core/skills/lock.js");
        await checkSkillUpdate("s");
        expect(mockListRemote).toHaveBeenCalledWith(["--refs", expect.stringContaining("gitlab.com"), "develop"]);
    });
    it("uses HEAD when no ref (line 116-119)", async () => {
        mockReadLockFile.mockResolvedValue({
            version: 1,
            skills: { "s": { name: "s", sourceType: "github", version: "abc", source: "o/r" } },
            mcpServers: {},
        });
        mockParseSource.mockReturnValue({ type: "github", owner: "o", repo: "r", ref: undefined });
        mockListRemote.mockResolvedValue("abc1234567890\tHEAD\n");
        const { checkSkillUpdate } = await import("../../src/core/skills/lock.js");
        await checkSkillUpdate("s");
        expect(mockListRemote).toHaveBeenCalledWith([expect.stringContaining("github.com"), "HEAD"]);
    });
    it("handles fetchLatestSha git error (line 126)", async () => {
        mockReadLockFile.mockResolvedValue({
            version: 1,
            skills: { "s": { name: "s", sourceType: "github", version: "abc", source: "o/r" } },
            mcpServers: {},
        });
        mockParseSource.mockReturnValue({ type: "github", owner: "o", repo: "r" });
        mockListRemote.mockRejectedValue(new Error("git error"));
        const { checkSkillUpdate } = await import("../../src/core/skills/lock.js");
        const result = await checkSkillUpdate("s");
        expect(result.status).toBe("unknown");
    });
    it("recordSkillInstall creates new entry", async () => {
        mockUpdateLockFile.mockImplementation(async (updater) => {
            const lock = { version: 1, skills: {}, mcpServers: {} };
            await updater(lock);
            return lock;
        });
        const { recordSkillInstall } = await import("../../src/core/skills/lock.js");
        await recordSkillInstall("s", "@a/s", "o/r", "github", ["claude-code"], "/path", true, undefined, "v1");
        expect(mockUpdateLockFile).toHaveBeenCalled();
    });
    it("recordSkillInstall merges with existing entry (lines 52-66)", async () => {
        mockUpdateLockFile.mockImplementation(async (updater) => {
            const lock = {
                version: 1,
                skills: {
                    "s": {
                        name: "s", scopedName: "@old/s", source: "old/r", sourceType: "github",
                        version: "old", installedAt: "2024-01-01", updatedAt: "2024-01-01",
                        agents: ["claude-code"], canonicalPath: "/old", isGlobal: true, projectDir: "/proj",
                    },
                },
                mcpServers: {},
            };
            await updater(lock);
            return lock;
        });
        const { recordSkillInstall } = await import("../../src/core/skills/lock.js");
        await recordSkillInstall("s", "@new/s", "new/r", "github", ["gemini-cli"], "/new", false, "/proj2", "new");
        expect(mockUpdateLockFile).toHaveBeenCalled();
    });
    it("removeSkillFromLock returns true when skill found", async () => {
        mockUpdateLockFile.mockImplementation(async (updater) => {
            const lock = { version: 1, skills: { "s": { name: "s" } }, mcpServers: {} };
            await updater(lock);
            return lock;
        });
        const { removeSkillFromLock } = await import("../../src/core/skills/lock.js");
        expect(await removeSkillFromLock("s")).toBe(true);
    });
    it("removeSkillFromLock returns false when skill not found", async () => {
        mockUpdateLockFile.mockImplementation(async (updater) => {
            const lock = { version: 1, skills: {}, mcpServers: {} };
            await updater(lock);
            return lock;
        });
        const { removeSkillFromLock } = await import("../../src/core/skills/lock.js");
        expect(await removeSkillFromLock("nonexistent")).toBe(false);
    });
    it("getTrackedSkills returns skills from lock", async () => {
        mockReadLockFile.mockResolvedValue({
            version: 1,
            skills: { "a": { name: "a" }, "b": { name: "b" } },
            mcpServers: {},
        });
        const { getTrackedSkills } = await import("../../src/core/skills/lock.js");
        const skills = await getTrackedSkills();
        expect(Object.keys(skills).length).toBe(2);
    });
});
// ── mcp/installer.ts ─────────────────────────────────────────────────────────
describe("coverage: mcp/installer.ts error and transform branches", () => {
    const mockWriteConfig = vi.hoisted(() => vi.fn());
    const mockResolveConfigPathFn = vi.hoisted(() => vi.fn());
    const mockGetTransform = vi.hoisted(() => vi.fn());
    vi.mock("../../src/core/formats/index.js", () => ({
        writeConfig: mockWriteConfig,
        readConfig: vi.fn(),
    }));
    vi.mock("../../src/core/mcp/reader.js", () => ({
        resolveConfigPath: mockResolveConfigPathFn,
    }));
    vi.mock("../../src/core/mcp/transforms.js", () => ({
        getTransform: mockGetTransform,
    }));
    vi.mock("../../src/core/logger.js", () => ({
        debug: vi.fn(),
        isHuman: () => false,
        setQuiet: vi.fn(),
        setVerbose: vi.fn(),
    }));
    beforeEach(() => {
        vi.clearAllMocks();
    });
    it("installMcpServer returns error when no configPath (line 81-89)", async () => {
        mockResolveConfigPathFn.mockReturnValue(null);
        mockGetTransform.mockReturnValue(null);
        const { installMcpServer } = await import("../../src/core/mcp/installer.js");
        const result = await installMcpServer({ id: "test", configFormat: "json", configKey: "mcpServers" }, "my-server", { command: "npx" });
        expect(result.success).toBe(false);
        expect(result.error).toContain("does not support");
    });
    it("installMcpServer applies transform (line 41-43)", async () => {
        mockResolveConfigPathFn.mockReturnValue("/tmp/config.json");
        const transform = vi.fn().mockReturnValue({ transformed: true });
        mockGetTransform.mockReturnValue(transform);
        mockWriteConfig.mockResolvedValue(undefined);
        const { installMcpServer } = await import("../../src/core/mcp/installer.js");
        const result = await installMcpServer({ id: "goose", configFormat: "yaml", configKey: "extensions" }, "my-server", { command: "npx" });
        expect(result.success).toBe(true);
        expect(transform).toHaveBeenCalledWith("my-server", { command: "npx" });
    });
    it("installMcpServer catches Error on write (line 116)", async () => {
        mockResolveConfigPathFn.mockReturnValue("/tmp/config.json");
        mockGetTransform.mockReturnValue(null);
        mockWriteConfig.mockRejectedValue(new Error("write failed"));
        const { installMcpServer } = await import("../../src/core/mcp/installer.js");
        const result = await installMcpServer({ id: "test", configFormat: "json", configKey: "mcpServers" }, "my-server", { command: "npx" });
        expect(result.success).toBe(false);
        expect(result.error).toBe("write failed");
    });
    it("installMcpServer catches non-Error on write (line 116)", async () => {
        mockResolveConfigPathFn.mockReturnValue("/tmp/config.json");
        mockGetTransform.mockReturnValue(null);
        mockWriteConfig.mockRejectedValue("string error");
        const { installMcpServer } = await import("../../src/core/mcp/installer.js");
        const result = await installMcpServer({ id: "test", configFormat: "json", configKey: "mcpServers" }, "my-server", { command: "npx" });
        expect(result.success).toBe(false);
        expect(result.error).toBe("string error");
    });
    it("installMcpServerToAll calls installMcpServer for each provider", async () => {
        mockResolveConfigPathFn.mockReturnValue("/tmp/config.json");
        mockGetTransform.mockReturnValue(null);
        mockWriteConfig.mockResolvedValue(undefined);
        const { installMcpServerToAll } = await import("../../src/core/mcp/installer.js");
        const results = await installMcpServerToAll([
            { id: "a", configFormat: "json", configKey: "mcpServers" },
            { id: "b", configFormat: "json", configKey: "mcpServers" },
        ], "my-server", { command: "npx" }, "global", "/project");
        expect(results.length).toBe(2);
        expect(results.every(r => r.success)).toBe(true);
    });
});
//# sourceMappingURL=coverage-lock-installer-mocked.test.js.map