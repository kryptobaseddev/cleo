import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MarketplaceAdapter, MarketplaceResult } from "../../src/core/marketplace/types.js";
import { MarketplaceClient } from "../../src/core/marketplace/client.js";
import { SkillsMPAdapter } from "../../src/core/marketplace/skillsmp.js";
import { SkillsShAdapter } from "../../src/core/marketplace/skillssh.js";

// ── Helpers ─────────────────────────────────────────────────────────

function makeResult(overrides: Partial<MarketplaceResult> & { scopedName: string }): MarketplaceResult {
  return {
    name: overrides.scopedName.split("/").pop() ?? "skill",
    description: "A test skill",
    author: "tester",
    stars: 10,
    githubUrl: "https://github.com/test/repo",
    repoFullName: "test/repo",
    path: "",
    source: "test",
    ...overrides,
  };
}

function makeMockAdapter(
  name: string,
  searchResults: MarketplaceResult[],
  getSkillResult: MarketplaceResult | null = null,
): MarketplaceAdapter {
  return {
    name,
    search: vi.fn().mockResolvedValue(searchResults),
    getSkill: vi.fn().mockResolvedValue(getSkillResult),
  };
}

// ── Mock fetch globally ─────────────────────────────────────────────

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ── MarketplaceClient ───────────────────────────────────────────────

describe("MarketplaceClient", () => {
  it("accepts custom adapters", () => {
    const adapter = makeMockAdapter("custom", []);
    const client = new MarketplaceClient([adapter]);
    expect(client).toBeDefined();
  });

  it("searches all adapters in parallel and merges results", async () => {
    const r1 = makeResult({ scopedName: "@a/skill1", stars: 5, source: "mp" });
    const r2 = makeResult({ scopedName: "@b/skill2", stars: 10, source: "sh" });

    const a1 = makeMockAdapter("mp", [r1]);
    const a2 = makeMockAdapter("sh", [r2]);
    const client = new MarketplaceClient([a1, a2]);

    const results = await client.search("test");
    expect(results).toHaveLength(2);
    // Sorted by stars descending
    expect(results[0]?.scopedName).toBe("@b/skill2");
    expect(results[1]?.scopedName).toBe("@a/skill1");
  });

  it("deduplicates by scopedName keeping higher star count", async () => {
    const r1 = makeResult({ scopedName: "@a/dup", stars: 5, source: "mp" });
    const r2 = makeResult({ scopedName: "@a/dup", stars: 20, source: "sh" });

    const a1 = makeMockAdapter("mp", [r1]);
    const a2 = makeMockAdapter("sh", [r2]);
    const client = new MarketplaceClient([a1, a2]);

    const results = await client.search("dup");
    expect(results).toHaveLength(1);
    expect(results[0]?.stars).toBe(20);
    expect(results[0]?.source).toBe("sh");
  });

  it("handles adapter errors gracefully (returns empty for failed adapter)", async () => {
    const good = makeResult({ scopedName: "@a/ok", stars: 1 });
    const a1: MarketplaceAdapter = {
      name: "failing",
      search: vi.fn().mockRejectedValue(new Error("network down")),
      getSkill: vi.fn().mockRejectedValue(new Error("network down")),
    };
    const a2 = makeMockAdapter("good", [good]);
    const client = new MarketplaceClient([a1, a2]);

    const results = await client.search("test");
    expect(results).toHaveLength(1);
    expect(results[0]?.scopedName).toBe("@a/ok");
  });

  it("throws when all adapters fail during search", async () => {
    const a1: MarketplaceAdapter = {
      name: "failing-1",
      search: vi.fn().mockRejectedValue(new Error("network down")),
      getSkill: vi.fn().mockResolvedValue(null),
    };
    const a2: MarketplaceAdapter = {
      name: "failing-2",
      search: vi.fn().mockRejectedValue(new Error("timeout")),
      getSkill: vi.fn().mockResolvedValue(null),
    };
    const client = new MarketplaceClient([a1, a2]);

    await expect(client.search("test")).rejects.toThrow("All marketplace sources failed.");
  });

  it("throws when all adapters fail during search", async () => {
    const a1: MarketplaceAdapter = {
      name: "failing-1",
      search: vi.fn().mockRejectedValue(new Error("network down")),
      getSkill: vi.fn().mockResolvedValue(null),
    };
    const a2: MarketplaceAdapter = {
      name: "failing-2",
      search: vi.fn().mockRejectedValue(new Error("timeout")),
      getSkill: vi.fn().mockResolvedValue(null),
    };
    const client = new MarketplaceClient([a1, a2]);

    await expect(client.search("test")).rejects.toThrow("All marketplace sources failed.");
  });

  it("respects limit parameter", async () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      makeResult({ scopedName: `@a/s${i}`, stars: 10 - i }),
    );
    const adapter = makeMockAdapter("big", items);
    const client = new MarketplaceClient([adapter]);

    const results = await client.search("test", 3);
    expect(results).toHaveLength(3);
  });

  it("getSkill returns first matching result across adapters", async () => {
    const skill = makeResult({ scopedName: "@a/found", stars: 42 });
    const a1 = makeMockAdapter("empty", [], null);
    const a2 = makeMockAdapter("has-it", [], skill);
    const client = new MarketplaceClient([a1, a2]);

    const result = await client.getSkill("@a/found");
    expect(result).not.toBeNull();
    expect(result?.scopedName).toBe("@a/found");
  });

  it("getSkill returns null when no adapter has the skill", async () => {
    const a1 = makeMockAdapter("empty1", [], null);
    const a2 = makeMockAdapter("empty2", [], null);
    const client = new MarketplaceClient([a1, a2]);

    const result = await client.getSkill("@a/missing");
    expect(result).toBeNull();
  });

  it("getSkill handles adapter errors and continues to next", async () => {
    const skill = makeResult({ scopedName: "@a/recover", stars: 7 });
    const a1: MarketplaceAdapter = {
      name: "failing",
      search: vi.fn().mockResolvedValue([]),
      getSkill: vi.fn().mockRejectedValue(new Error("timeout")),
    };
    const a2 = makeMockAdapter("ok", [], skill);
    const client = new MarketplaceClient([a1, a2]);

    const result = await client.getSkill("@a/recover");
    expect(result).not.toBeNull();
    expect(result?.scopedName).toBe("@a/recover");
  });

  it("getSkill throws when all adapters fail", async () => {
    const a1: MarketplaceAdapter = {
      name: "failing-1",
      search: vi.fn().mockResolvedValue([]),
      getSkill: vi.fn().mockRejectedValue(new Error("timeout")),
    };
    const a2: MarketplaceAdapter = {
      name: "failing-2",
      search: vi.fn().mockResolvedValue([]),
      getSkill: vi.fn().mockRejectedValue(new Error("network down")),
    };
    const client = new MarketplaceClient([a1, a2]);

    await expect(client.getSkill("@a/missing")).rejects.toThrow("All marketplace sources failed.");
  });

  it("getSkill throws when all adapters fail", async () => {
    const a1: MarketplaceAdapter = {
      name: "failing-1",
      search: vi.fn().mockResolvedValue([]),
      getSkill: vi.fn().mockRejectedValue(new Error("timeout")),
    };
    const a2: MarketplaceAdapter = {
      name: "failing-2",
      search: vi.fn().mockResolvedValue([]),
      getSkill: vi.fn().mockRejectedValue(new Error("network down")),
    };
    const client = new MarketplaceClient([a1, a2]);

    await expect(client.getSkill("@a/missing")).rejects.toThrow("All marketplace sources failed.");
  });
});

// ── SkillsMPAdapter ─────────────────────────────────────────────────

describe("SkillsMPAdapter", () => {
  it("constructs correct search URL with query params", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ skills: [], total: 0, limit: 20, offset: 0 }),
    });
    globalThis.fetch = mockFetch;

    const adapter = new SkillsMPAdapter();
    await adapter.search("react hooks", 5);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const url = mockFetch.mock.calls[0]?.[0] as string;
    expect(url).toContain("agentskills.in/api/skills");
    expect(url).toContain("search=react+hooks");
    expect(url).toContain("limit=5");
    expect(url).toContain("sortBy=stars");
  });

  it("maps API response to MarketplaceResult format", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          skills: [
            {
              id: "1",
              name: "test-skill",
              description: "A great skill",
              author: "alice",
              scopedName: "@alice/test-skill",
              stars: 100,
              forks: 5,
              githubUrl: "https://github.com/alice/test-skill",
              repoFullName: "alice/test-skill",
              path: "skills/test",
              category: "dev",
              hasContent: true,
            },
          ],
          total: 1,
          limit: 20,
          offset: 0,
        }),
    });

    const adapter = new SkillsMPAdapter();
    const results = await adapter.search("test");

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      name: "test-skill",
      scopedName: "@alice/test-skill",
      description: "A great skill",
      author: "alice",
      stars: 100,
      githubUrl: "https://github.com/alice/test-skill",
      repoFullName: "alice/test-skill",
      path: "skills/test",
      source: "agentskills.in",
    });
  });

  it("throws on non-ok response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });

    const adapter = new SkillsMPAdapter();
    await expect(adapter.search("fail")).rejects.toThrow("status 500");
  });

  it("throws on network error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const adapter = new SkillsMPAdapter();
    await expect(adapter.search("error")).rejects.toThrow("Network request failed");
  });

  it("getSkill searches by plain name and then matches exact scopedName", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          skills: [
            {
              id: "1",
              name: "target",
              description: "Target skill",
              author: "bob",
              scopedName: "@bob/target",
              stars: 50,
              forks: 2,
              githubUrl: "https://github.com/bob/target",
              repoFullName: "bob/target",
              path: "",
              hasContent: true,
            },
          ],
          total: 1,
          limit: 50,
          offset: 0,
        }),
    });
    globalThis.fetch = mockFetch;

    const adapter = new SkillsMPAdapter();
    const result = await adapter.getSkill("@bob/target");
    expect(result).not.toBeNull();
    expect(result!.scopedName).toBe("@bob/target");

    const url = mockFetch.mock.calls[0]![0] as string;
    expect(url).toContain("search=target");
    expect(url).toContain("limit=50");
  });

  it("getSkill retries with additional query terms when first lookup misses", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ skills: [], total: 0, limit: 50, offset: 0 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            skills: [
              {
                id: "1",
                name: "target",
                description: "Target skill",
                author: "bob",
                scopedName: "@bob/target",
                stars: 50,
                forks: 2,
                githubUrl: "https://github.com/bob/target",
                repoFullName: "bob/target",
                path: "",
                hasContent: true,
              },
            ],
            total: 1,
            limit: 50,
            offset: 0,
          }),
      });
    globalThis.fetch = mockFetch;

    const adapter = new SkillsMPAdapter();
    const result = await adapter.getSkill("@bob/target");
    expect(result).not.toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const firstUrl = mockFetch.mock.calls[0]![0] as string;
    const secondUrl = mockFetch.mock.calls[1]![0] as string;
    expect(firstUrl).toContain("search=target");
    expect(secondUrl).toContain("search=bob+target");
  });

  it("getSkill returns null when no match", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ skills: [], total: 0, limit: 1, offset: 0 }),
    });

    const adapter = new SkillsMPAdapter();
    const result = await adapter.getSkill("@nobody/nothing");
    expect(result).toBeNull();
  });
});

// ── SkillsShAdapter ─────────────────────────────────────────────────

describe("SkillsShAdapter", () => {
  it("constructs correct search URL", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ results: [], total: 0 }),
    });
    globalThis.fetch = mockFetch;

    const adapter = new SkillsShAdapter();
    await adapter.search("vue", 10);

    const url = mockFetch.mock.calls[0]?.[0] as string;
    expect(url).toContain("skills.sh/api/search");
    expect(url).toContain("q=vue");
    expect(url).toContain("limit=10");
  });

  it("maps response to MarketplaceResult with constructed scopedName", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          results: [
            {
              name: "my-skill",
              author: "carol",
              description: "A skill from skills.sh",
              repo: "carol/my-skill",
              stars: 77,
              url: "https://github.com/carol/my-skill",
            },
          ],
          total: 1,
        }),
    });

    const adapter = new SkillsShAdapter();
    const results = await adapter.search("my-skill");

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      name: "my-skill",
      scopedName: "@carol/my-skill",
      description: "A skill from skills.sh",
      author: "carol",
      stars: 77,
      githubUrl: "https://github.com/carol/my-skill",
      repoFullName: "carol/my-skill",
      path: "",
      source: "skills.sh",
    });
  });

  it("defaults stars to 0 when not provided", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          results: [
            {
              name: "no-stars",
              author: "dan",
              description: "no stars",
              repo: "dan/no-stars",
              url: "https://github.com/dan/no-stars",
              // stars omitted
            },
          ],
          total: 1,
        }),
    });

    const adapter = new SkillsShAdapter();
    const results = await adapter.search("no-stars");
    expect(results[0]?.stars).toBe(0);
  });

  it("throws on non-ok response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });

    const adapter = new SkillsShAdapter();
    await expect(adapter.search("fail")).rejects.toThrow("status 404");
  });

  it("throws on network error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("DNS failure"));

    const adapter = new SkillsShAdapter();
    await expect(adapter.search("error")).rejects.toThrow("Network request failed");
  });

  it("getSkill delegates to search and finds exact match", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          results: [
            {
              name: "exact",
              author: "eve",
              description: "exact match",
              repo: "eve/exact",
              stars: 30,
              url: "https://github.com/eve/exact",
            },
            {
              name: "other",
              author: "eve",
              description: "not this one",
              repo: "eve/other",
              stars: 5,
              url: "https://github.com/eve/other",
            },
          ],
          total: 2,
        }),
    });

    const adapter = new SkillsShAdapter();
    const result = await adapter.getSkill("@eve/exact");
    expect(result).not.toBeNull();
    expect(result?.scopedName).toBe("@eve/exact");
  });

  it("getSkill returns null when no exact match found", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          results: [
            {
              name: "wrong",
              author: "frank",
              description: "not it",
              repo: "frank/wrong",
              stars: 1,
              url: "https://github.com/frank/wrong",
            },
          ],
          total: 1,
        }),
    });

    const adapter = new SkillsShAdapter();
    const result = await adapter.getSkill("@frank/right");
    expect(result).toBeNull();
  });
});
