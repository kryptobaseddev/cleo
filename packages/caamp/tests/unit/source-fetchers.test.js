import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
    cloneMock: vi.fn(),
    fetchWithTimeoutMock: vi.fn(),
}));
vi.mock("simple-git", () => ({
    simpleGit: () => ({ clone: mocks.cloneMock }),
}));
vi.mock("../../src/core/network/fetch.js", () => ({
    fetchWithTimeout: mocks.fetchWithTimeoutMock,
}));
import { cloneRepo, fetchRawFile, repoExists } from "../../src/core/sources/github.js";
import { cloneGitLabRepo, fetchGitLabRawFile } from "../../src/core/sources/gitlab.js";
import { discoverWellKnown } from "../../src/core/sources/wellknown.js";
describe("source fetchers", () => {
    beforeEach(() => {
        mocks.cloneMock.mockResolvedValue(undefined);
        mocks.fetchWithTimeoutMock.mockReset();
    });
    afterEach(() => {
        vi.clearAllMocks();
    });
    it("clones GitHub repositories with depth options", async () => {
        const result = await cloneRepo("owner", "repo", "main", "skills/demo");
        expect(mocks.cloneMock).toHaveBeenCalledTimes(1);
        const [url, dir, options] = mocks.cloneMock.mock.calls[0];
        expect(url).toBe("https://github.com/owner/repo.git");
        expect(dir).toContain("caamp-");
        expect(options).toEqual(["--depth", "1", "--branch", "main"]);
        expect(result.localPath).toContain("skills");
        expect(result.localPath).toContain("demo");
        await expect(result.cleanup()).resolves.toBeUndefined();
    });
    it("clones GitLab repositories with depth options", async () => {
        const result = await cloneGitLabRepo("group", "repo", "develop");
        expect(mocks.cloneMock).toHaveBeenCalledTimes(1);
        const [url, dir, options] = mocks.cloneMock.mock.calls[0];
        expect(url).toBe("https://gitlab.com/group/repo.git");
        expect(dir).toContain("caamp-gl-");
        expect(options).toEqual(["--depth", "1", "--branch", "develop"]);
        await expect(result.cleanup()).resolves.toBeUndefined();
    });
    it("fetches raw GitHub file content", async () => {
        mocks.fetchWithTimeoutMock.mockResolvedValue({
            ok: true,
            text: vi.fn().mockResolvedValue("content"),
        });
        await expect(fetchRawFile("owner", "repo", "README.md")).resolves.toBe("content");
        expect(mocks.fetchWithTimeoutMock).toHaveBeenCalledWith("https://raw.githubusercontent.com/owner/repo/main/README.md");
    });
    it("returns null when GitHub raw fetch fails", async () => {
        mocks.fetchWithTimeoutMock.mockRejectedValue(new Error("timeout"));
        await expect(fetchRawFile("owner", "repo", "README.md")).resolves.toBeNull();
    });
    it("checks GitHub repo existence with HEAD request", async () => {
        mocks.fetchWithTimeoutMock.mockResolvedValue({ ok: true });
        await expect(repoExists("owner", "repo")).resolves.toBe(true);
        expect(mocks.fetchWithTimeoutMock).toHaveBeenCalledWith("https://api.github.com/repos/owner/repo", { method: "HEAD" });
    });
    it("fetches raw GitLab file content", async () => {
        mocks.fetchWithTimeoutMock.mockResolvedValue({
            ok: true,
            text: vi.fn().mockResolvedValue("gitlab-content"),
        });
        await expect(fetchGitLabRawFile("group", "repo", "dir/README.md")).resolves.toBe("gitlab-content");
        expect(mocks.fetchWithTimeoutMock).toHaveBeenCalledWith("https://gitlab.com/group/repo/-/raw/main/dir%2FREADME.md");
    });
    it("clones GitHub repo without ref (no --branch flag)", async () => {
        const result = await cloneRepo("owner", "repo");
        expect(mocks.cloneMock).toHaveBeenCalledTimes(1);
        const [url, dir, options] = mocks.cloneMock.mock.calls[0];
        expect(url).toBe("https://github.com/owner/repo.git");
        expect(options).toEqual(["--depth", "1"]);
        expect(result.localPath).toBe(dir);
        await result.cleanup();
    });
    it("returns null when GitHub raw response is not ok", async () => {
        mocks.fetchWithTimeoutMock.mockResolvedValue({
            ok: false,
            status: 404,
        });
        await expect(fetchRawFile("owner", "repo", "missing.md")).resolves.toBeNull();
    });
    it("returns false when GitHub repo does not exist", async () => {
        mocks.fetchWithTimeoutMock.mockResolvedValue({ ok: false });
        await expect(repoExists("owner", "nonexistent")).resolves.toBe(false);
    });
    it("returns false when repoExists throws network error", async () => {
        mocks.fetchWithTimeoutMock.mockRejectedValue(new Error("network error"));
        await expect(repoExists("owner", "repo")).resolves.toBe(false);
    });
    it("returns discovered well-known skills", async () => {
        mocks.fetchWithTimeoutMock.mockResolvedValue({
            ok: true,
            json: vi.fn().mockResolvedValue({
                skills: [{ name: "demo", description: "Demo", url: "https://example.com/demo" }],
            }),
        });
        const skills = await discoverWellKnown("example.com");
        expect(skills).toEqual([{ name: "demo", description: "Demo", url: "https://example.com/demo" }]);
        expect(mocks.fetchWithTimeoutMock).toHaveBeenCalledWith("https://example.com/.well-known/skills/index.json");
    });
});
//# sourceMappingURL=source-fetchers.test.js.map