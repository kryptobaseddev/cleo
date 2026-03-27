/**
 * Coverage tests that mock the network/fetch module for:
 * - wellknown.ts (all branches)
 * - gitlab.ts (ref branch, error catch)
 * - github.ts (cleanup error, fetchRawFile branches)
 * - skillsmp.ts (getSkill search variations)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
const mockFetchWithTimeout = vi.hoisted(() => vi.fn());
vi.mock("../../src/core/network/fetch.js", () => ({
    fetchWithTimeout: mockFetchWithTimeout,
    ensureOkResponse: (r) => r,
    formatNetworkError: (e) => e instanceof Error ? e.message : String(e),
}));
// ── wellknown.ts ─────────────────────────────────────────────────────────────
describe("coverage: wellknown.ts all branches", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });
    it("returns skills on successful fetch (lines 21-24)", async () => {
        mockFetchWithTimeout.mockResolvedValue({
            ok: true,
            json: async () => ({ skills: [{ name: "test", description: "desc", url: "https://example.com" }] }),
        });
        const { discoverWellKnown } = await import("../../src/core/sources/wellknown.js");
        const result = await discoverWellKnown("example.com");
        expect(result.length).toBe(1);
        expect(result[0].name).toBe("test");
    });
    it("returns empty on non-ok response (line 21)", async () => {
        mockFetchWithTimeout.mockResolvedValue({ ok: false });
        const { discoverWellKnown } = await import("../../src/core/sources/wellknown.js");
        const result = await discoverWellKnown("example.com");
        expect(result).toEqual([]);
    });
    it("returns empty when no skills property (line 24 ?? fallback)", async () => {
        mockFetchWithTimeout.mockResolvedValue({
            ok: true,
            json: async () => ({}),
        });
        const { discoverWellKnown } = await import("../../src/core/sources/wellknown.js");
        const result = await discoverWellKnown("example.com");
        expect(result).toEqual([]);
    });
    it("returns empty on fetch error (line 25-26)", async () => {
        mockFetchWithTimeout.mockRejectedValue(new Error("network"));
        const { discoverWellKnown } = await import("../../src/core/sources/wellknown.js");
        const result = await discoverWellKnown("example.com");
        expect(result).toEqual([]);
    });
});
// ── gitlab.ts ────────────────────────────────────────────────────────────────
describe("coverage: gitlab.ts ref and error branches", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });
    it("fetchGitLabRawFile with explicit ref (line 40)", async () => {
        mockFetchWithTimeout.mockResolvedValue({
            ok: true,
            text: async () => "file content",
        });
        const { fetchGitLabRawFile } = await import("../../src/core/sources/gitlab.js");
        const result = await fetchGitLabRawFile("owner", "repo", "path/file", "develop");
        expect(result).toBe("file content");
        expect(mockFetchWithTimeout).toHaveBeenCalledWith(expect.stringContaining("develop"));
    });
    it("fetchGitLabRawFile with default ref", async () => {
        mockFetchWithTimeout.mockResolvedValue({
            ok: true,
            text: async () => "main content",
        });
        const { fetchGitLabRawFile } = await import("../../src/core/sources/gitlab.js");
        const result = await fetchGitLabRawFile("owner", "repo", "path/file");
        expect(result).toBe("main content");
        expect(mockFetchWithTimeout).toHaveBeenCalledWith(expect.stringContaining("main"));
    });
    it("fetchGitLabRawFile returns null on non-ok (line 60)", async () => {
        mockFetchWithTimeout.mockResolvedValue({ ok: false });
        const { fetchGitLabRawFile } = await import("../../src/core/sources/gitlab.js");
        const result = await fetchGitLabRawFile("owner", "repo", "path");
        expect(result).toBeNull();
    });
    it("fetchGitLabRawFile returns null on error (lines 60-61)", async () => {
        mockFetchWithTimeout.mockRejectedValue(new Error("network"));
        const { fetchGitLabRawFile } = await import("../../src/core/sources/gitlab.js");
        const result = await fetchGitLabRawFile("owner", "repo", "path");
        expect(result).toBeNull();
    });
});
// ── github.ts ────────────────────────────────────────────────────────────────
describe("coverage: github.ts branches", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });
    it("fetchRawFile returns content on success", async () => {
        mockFetchWithTimeout.mockResolvedValue({
            ok: true,
            text: async () => "# README",
        });
        const { fetchRawFile } = await import("../../src/core/sources/github.js");
        const result = await fetchRawFile("owner", "repo", "README.md");
        expect(result).toBe("# README");
    });
    it("fetchRawFile returns null on non-ok", async () => {
        mockFetchWithTimeout.mockResolvedValue({ ok: false });
        const { fetchRawFile } = await import("../../src/core/sources/github.js");
        const result = await fetchRawFile("owner", "repo", "README.md");
        expect(result).toBeNull();
    });
    it("fetchRawFile returns null on error (line 46 catch)", async () => {
        mockFetchWithTimeout.mockRejectedValue(new Error("network"));
        const { fetchRawFile } = await import("../../src/core/sources/github.js");
        const result = await fetchRawFile("owner", "repo", "README.md");
        expect(result).toBeNull();
    });
    it("fetchRawFile uses custom ref", async () => {
        mockFetchWithTimeout.mockResolvedValue({
            ok: true,
            text: async () => "develop content",
        });
        const { fetchRawFile } = await import("../../src/core/sources/github.js");
        const result = await fetchRawFile("owner", "repo", "README.md", "develop");
        expect(result).toBe("develop content");
        expect(mockFetchWithTimeout).toHaveBeenCalledWith(expect.stringContaining("develop"));
    });
    it("repoExists returns true on ok", async () => {
        mockFetchWithTimeout.mockResolvedValue({ ok: true });
        const { repoExists } = await import("../../src/core/sources/github.js");
        expect(await repoExists("owner", "repo")).toBe(true);
    });
    it("repoExists returns false on non-ok", async () => {
        mockFetchWithTimeout.mockResolvedValue({ ok: false });
        const { repoExists } = await import("../../src/core/sources/github.js");
        expect(await repoExists("owner", "repo")).toBe(false);
    });
    it("repoExists returns false on error", async () => {
        mockFetchWithTimeout.mockRejectedValue(new Error("network"));
        const { repoExists } = await import("../../src/core/sources/github.js");
        expect(await repoExists("owner", "repo")).toBe(false);
    });
});
// ── skillsmp.ts ──────────────────────────────────────────────────────────────
describe("coverage: skillsmp.ts getSkill search variations", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });
    it("getSkill with scoped name: searches 3 terms, matches on second", async () => {
        const matchSkill = {
            id: "1", name: "memory", description: "Memory skill", author: "anthropic",
            scopedName: "@anthropic/memory", stars: 100, forks: 10,
            githubUrl: "https://github.com/anthropic/memory", repoFullName: "anthropic/memory",
            path: "", hasContent: true,
        };
        // First search (name only) - no match
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ skills: [], total: 0, limit: 50, offset: 0 }),
        });
        // Second search (author name) - match
        mockFetchWithTimeout.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ skills: [matchSkill], total: 1, limit: 50, offset: 0 }),
        });
        const { SkillsMPAdapter } = await import("../../src/core/marketplace/skillsmp.js");
        const adapter = new SkillsMPAdapter();
        const result = await adapter.getSkill("@anthropic/memory");
        expect(result).not.toBeNull();
        expect(result.scopedName).toBe("@anthropic/memory");
    });
    it("getSkill with non-scoped name: searches just 1 term (line 83 null path)", async () => {
        mockFetchWithTimeout.mockResolvedValue({
            ok: true,
            json: async () => ({ skills: [], total: 0, limit: 50, offset: 0 }),
        });
        const { SkillsMPAdapter } = await import("../../src/core/marketplace/skillsmp.js");
        const adapter = new SkillsMPAdapter();
        const result = await adapter.getSkill("plain-name");
        expect(result).toBeNull();
        expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
    });
    it("getSkill returns null when no match across all searches", async () => {
        const otherSkill = {
            id: "1", name: "other", description: "", author: "x",
            scopedName: "@x/other", stars: 0, forks: 0,
            githubUrl: "", repoFullName: "", path: "", hasContent: false,
        };
        mockFetchWithTimeout.mockResolvedValue({
            ok: true,
            json: async () => ({ skills: [otherSkill], total: 1, limit: 50, offset: 0 }),
        });
        const { SkillsMPAdapter } = await import("../../src/core/marketplace/skillsmp.js");
        const adapter = new SkillsMPAdapter();
        const result = await adapter.getSkill("@anthropic/memory");
        expect(result).toBeNull();
    });
    it("getSkill deduplicates search terms (line 87 seen check)", async () => {
        mockFetchWithTimeout.mockResolvedValue({
            ok: true,
            json: async () => ({ skills: [], total: 0, limit: 50, offset: 0 }),
        });
        const { SkillsMPAdapter } = await import("../../src/core/marketplace/skillsmp.js");
        const adapter = new SkillsMPAdapter();
        await adapter.getSkill("@a/a");
        // "a", "a a", "@a/a" - 3 unique terms
        expect(mockFetchWithTimeout).toHaveBeenCalledTimes(3);
    });
    it("getSkill matches on author/name format", async () => {
        const skill = {
            id: "1", name: "mem", description: "", author: "auth",
            scopedName: "", stars: 0, forks: 0,
            githubUrl: "", repoFullName: "", path: "", hasContent: false,
        };
        // Match by `@${author}/${name}` format on line 100
        mockFetchWithTimeout.mockResolvedValue({
            ok: true,
            json: async () => ({ skills: [skill], total: 1, limit: 50, offset: 0 }),
        });
        const { SkillsMPAdapter } = await import("../../src/core/marketplace/skillsmp.js");
        const adapter = new SkillsMPAdapter();
        const result = await adapter.getSkill("@auth/mem");
        // skill.scopedName is "" but `@${skill.author}/${skill.name}` === "@auth/mem"
        expect(result).not.toBeNull();
    });
    it("search maps results to MarketplaceResult format", async () => {
        mockFetchWithTimeout.mockResolvedValue({
            ok: true,
            json: async () => ({
                skills: [{
                        id: "1", name: "test", description: "Test", author: "author",
                        scopedName: "@author/test", stars: 42, forks: 5,
                        githubUrl: "https://github.com/author/test", repoFullName: "author/test",
                        path: "skills/test", category: "impl", hasContent: true,
                    }],
                total: 1, limit: 20, offset: 0,
            }),
        });
        const { SkillsMPAdapter } = await import("../../src/core/marketplace/skillsmp.js");
        const adapter = new SkillsMPAdapter();
        const results = await adapter.search("test", 10);
        expect(results.length).toBe(1);
        expect(results[0].source).toBe("agentskills.in");
        expect(results[0].stars).toBe(42);
    });
});
//# sourceMappingURL=coverage-network-mocked.test.js.map