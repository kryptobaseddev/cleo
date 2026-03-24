import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  rankSkills: vi.fn(),
}));

vi.mock("../../src/core/marketplace/client.js", () => ({
  MarketplaceClient: class {
    search = mocks.search;
  },
}));

vi.mock("../../src/core/skills/recommendation.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/core/skills/recommendation.js")>("../../src/core/skills/recommendation.js");
  return {
    ...actual,
    recommendSkills: mocks.rankSkills,
  };
});


import { RECOMMENDATION_ERROR_CODES } from "../../src/core/skills/recommendation.js";
import {
  formatSkillRecommendations,
  recommendSkills,
  searchSkills,
} from "../../src/core/skills/recommendation-api.js";

describe("recommendation api surface", () => {
  beforeEach(() => {
    mocks.search.mockReset();
    mocks.rankSkills.mockReset();
  });

  it("searchSkills returns raw marketplace hits", async () => {
    mocks.search.mockResolvedValue([{ scopedName: "@a/skill" }]);
    const result = await searchSkills("gitbook", { limit: 5 });
    expect(mocks.search).toHaveBeenCalledWith("gitbook", 5);
    expect(result).toEqual([{ scopedName: "@a/skill" }]);
  });

  it("recommendSkills ranks query results", async () => {
    mocks.search.mockResolvedValue([{ scopedName: "@a/skill" }]);
    mocks.rankSkills.mockReturnValue({
      criteria: { query: "gitbook", queryTokens: ["gitbook"], mustHave: [], prefer: [], exclude: [] },
      ranking: [
        {
          skill: { scopedName: "@a/skill" },
          score: 1,
          reasons: [],
          tradeoffs: [],
          excluded: false,
        },
      ],
    });

    await recommendSkills("gitbook", { prefer: ["api"] }, { top: 3 });
    expect(mocks.rankSkills).toHaveBeenCalled();
  });

  it("formats human output with CHOOSE", () => {
    const output = formatSkillRecommendations(
      {
        criteria: { query: "gitbook", queryTokens: ["gitbook"], mustHave: [], prefer: [], exclude: [] },
        ranking: [
          {
            skill: {
              name: "gitbook",
              scopedName: "@demo/gitbook",
              description: "desc",
              author: "demo",
              stars: 100,
              githubUrl: "https://github.com/demo/gitbook",
              repoFullName: "demo/gitbook",
              path: "",
              source: "agentskills.in",
            },
            score: 10,
            reasons: [{ code: "MATCH_TOPIC_GITBOOK" }],
            tradeoffs: [],
            excluded: false,
          },
        ],
      },
      { mode: "human" },
    ) as string;

    expect(output).toContain("1) @demo/gitbook (Recommended)");
    expect(output).toContain("CHOOSE: 1");
  });

  it("searchSkills rejects empty query", async () => {
    await expect(searchSkills("")).rejects.toThrow();
    try {
      await searchSkills("");
    } catch (error: any) {
      expect(error.code).toBe(RECOMMENDATION_ERROR_CODES.QUERY_INVALID);
    }
  });

  it("searchSkills wraps marketplace errors", async () => {
    mocks.search.mockRejectedValue(new Error("network"));
    await expect(searchSkills("test")).rejects.toThrow();
    try {
      await searchSkills("test");
    } catch (error: any) {
      expect(error.code).toBe(RECOMMENDATION_ERROR_CODES.SOURCE_UNAVAILABLE);
    }
  });

  it("searchSkills wraps non-Error marketplace failures", async () => {
    mocks.search.mockRejectedValue("string-error");
    await expect(searchSkills("test")).rejects.toThrow();
    try {
      await searchSkills("test");
    } catch (error: any) {
      expect(error.code).toBe(RECOMMENDATION_ERROR_CODES.SOURCE_UNAVAILABLE);
    }
  });

  it("recommendSkills throws when no matches", async () => {
    mocks.search.mockResolvedValue([]);
    mocks.rankSkills.mockReturnValue({
      criteria: { query: "test", queryTokens: ["test"], mustHave: [], prefer: [], exclude: [] },
      ranking: [],
    });
    await expect(recommendSkills("test", {})).rejects.toThrow();
    try {
      await recommendSkills("test", {});
    } catch (error: any) {
      expect(error.code).toBe(RECOMMENDATION_ERROR_CODES.NO_MATCHES);
    }
  });

  it("formatSkillRecommendations json mode", () => {
    const result = formatSkillRecommendations(
      {
        criteria: { query: "gitbook", queryTokens: ["gitbook"], mustHave: [], prefer: [], exclude: [] },
        ranking: [
          {
            skill: {
              name: "gitbook",
              scopedName: "@demo/gitbook",
              description: "desc",
              author: "demo",
              stars: 100,
              githubUrl: "https://github.com/demo/gitbook",
              repoFullName: "demo/gitbook",
              path: "",
              source: "agentskills.in",
            },
            score: 10,
            reasons: [{ code: "MATCH_TOPIC_GITBOOK" }],
            tradeoffs: [],
            excluded: false,
          },
        ],
      },
      { mode: "json" },
    ) as Record<string, unknown>;

    expect(result).toHaveProperty("query", "gitbook");
    expect(result).toHaveProperty("recommended");
    expect(result).toHaveProperty("options");
    expect(Array.isArray(result.options)).toBe(true);
  });

  it("formatSkillRecommendations json mode with details", () => {
    const result = formatSkillRecommendations(
      {
        criteria: { query: "gitbook", queryTokens: ["gitbook"], mustHave: [], prefer: [], exclude: [] },
        ranking: [
          {
            skill: {
              name: "gitbook",
              scopedName: "@demo/gitbook",
              description: "desc",
              author: "demo",
              stars: 100,
              githubUrl: "https://github.com/demo/gitbook",
              repoFullName: "demo/gitbook",
              path: "",
              source: "agentskills.in",
            },
            score: 10,
            reasons: [{ code: "MATCH_TOPIC_GITBOOK" }],
            tradeoffs: [],
            excluded: false,
          },
        ],
      },
      { mode: "json", details: true },
    ) as Record<string, unknown>;

    expect(result).toHaveProperty("query", "gitbook");
    expect(result).toHaveProperty("options");
    const options = result.options as Record<string, unknown>[];
    expect(options[0]).toHaveProperty("description");
    expect(options[0]).toHaveProperty("source");
    expect(options[0]).toHaveProperty("evidence");
  });

  it("formatSkillRecommendations human mode empty results", () => {
    const output = formatSkillRecommendations(
      {
        criteria: { query: "gitbook", queryTokens: ["gitbook"], mustHave: [], prefer: [], exclude: [] },
        ranking: [],
      },
      { mode: "human" },
    );

    expect(output).toBe("No recommendations found.");
  });

  it("searchSkills uses default limit", async () => {
    mocks.search.mockResolvedValue([]);
    await searchSkills("test");
    expect(mocks.search).toHaveBeenCalledWith("test", 20);
  });
});
