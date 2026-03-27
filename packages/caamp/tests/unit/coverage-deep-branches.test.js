/**
 * Deep branch coverage tests for lock-utils.ts.
 * Requires module-level mocking of node:fs and node:fs/promises.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
// lock-utils.ts mock setup
const mockOpen = vi.hoisted(() => vi.fn());
const mockMkdir = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockRm = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockReadFile = vi.hoisted(() => vi.fn());
const mockWriteFile = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockRename = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockExistsSync = vi.hoisted(() => vi.fn().mockReturnValue(false));
vi.mock("node:fs/promises", () => ({
    open: mockOpen,
    readFile: mockReadFile,
    writeFile: mockWriteFile,
    mkdir: mockMkdir,
    rm: mockRm,
    rename: mockRename,
}));
vi.mock("node:fs", () => ({
    existsSync: mockExistsSync,
}));
describe("coverage: lock-utils.ts lock guard branches", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockMkdir.mockResolvedValue(undefined);
        mockRm.mockResolvedValue(undefined);
        mockWriteFile.mockResolvedValue(undefined);
        mockRename.mockResolvedValue(undefined);
        mockExistsSync.mockReturnValue(false);
        mockReadFile.mockResolvedValue(JSON.stringify({ version: 1, skills: {}, mcpServers: {} }));
    });
    it("rethrows non-EEXIST error (EACCES) - lines 28-29", async () => {
        const permError = Object.assign(new Error("EACCES"), { code: "EACCES" });
        mockOpen.mockRejectedValue(permError);
        const { writeLockFile } = await import("../../src/core/lock-utils.js");
        await expect(writeLockFile({ version: 1, skills: {}, mcpServers: {} })).rejects.toThrow("EACCES");
    });
    it("rethrows non-Error thrown value - line 28", async () => {
        mockOpen.mockRejectedValue("raw string");
        const { writeLockFile } = await import("../../src/core/lock-utils.js");
        await expect(writeLockFile({ version: 1, skills: {}, mcpServers: {} })).rejects.toBe("raw string");
    });
    it("rethrows Error without code property - line 28", async () => {
        mockOpen.mockRejectedValue(new Error("no code"));
        const { writeLockFile } = await import("../../src/core/lock-utils.js");
        await expect(writeLockFile({ version: 1, skills: {}, mcpServers: {} })).rejects.toThrow("no code");
    });
    it("retries on EEXIST then succeeds - exercises sleep (line 15-17)", async () => {
        const eexistError = Object.assign(new Error("EEXIST"), { code: "EEXIST" });
        const mockHandle = { close: vi.fn().mockResolvedValue(undefined) };
        mockOpen
            .mockRejectedValueOnce(eexistError)
            .mockRejectedValueOnce(eexistError)
            .mockResolvedValueOnce(mockHandle);
        const { writeLockFile } = await import("../../src/core/lock-utils.js");
        await writeLockFile({ version: 1, skills: {}, mcpServers: {} });
        expect(mockOpen).toHaveBeenCalledTimes(3);
        expect(mockRm).toHaveBeenCalled();
    });
    it("times out after all retries - line 35-36", async () => {
        const eexistError = Object.assign(new Error("EEXIST"), { code: "EEXIST" });
        mockOpen.mockRejectedValue(eexistError);
        const { writeLockFile } = await import("../../src/core/lock-utils.js");
        await expect(writeLockFile({ version: 1, skills: {}, mcpServers: {} })).rejects.toThrow("Timed out waiting for lock file guard");
    }, 30000);
    it("readLockFile returns default on non-existent file", async () => {
        mockExistsSync.mockReturnValue(false);
        const { readLockFile } = await import("../../src/core/lock-utils.js");
        const result = await readLockFile();
        expect(result).toEqual({ version: 1, skills: {}, mcpServers: {} });
    });
    it("readLockFile returns parsed content on existing file", async () => {
        mockExistsSync.mockReturnValue(true);
        mockReadFile.mockResolvedValue(JSON.stringify({ version: 1, skills: { x: {} }, mcpServers: {} }));
        const { readLockFile } = await import("../../src/core/lock-utils.js");
        const result = await readLockFile();
        expect(result.skills).toHaveProperty("x");
    });
    it("readLockFile returns default on JSON parse error", async () => {
        mockExistsSync.mockReturnValue(true);
        mockReadFile.mockResolvedValue("{{invalid");
        const { readLockFile } = await import("../../src/core/lock-utils.js");
        const result = await readLockFile();
        expect(result).toEqual({ version: 1, skills: {}, mcpServers: {} });
    });
    it("updateLockFile reads, modifies, writes", async () => {
        const mockHandle = { close: vi.fn().mockResolvedValue(undefined) };
        mockOpen.mockResolvedValue(mockHandle);
        mockExistsSync.mockReturnValue(true);
        mockReadFile.mockResolvedValue(JSON.stringify({ version: 1, skills: {}, mcpServers: {} }));
        const { updateLockFile } = await import("../../src/core/lock-utils.js");
        const result = await updateLockFile((lock) => {
            lock.skills["test"] = {};
        });
        expect(result.skills).toHaveProperty("test");
        expect(mockRename).toHaveBeenCalled();
    });
});
//# sourceMappingURL=coverage-deep-branches.test.js.map