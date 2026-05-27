import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  formatNetworkError: vi.fn(),
  recommendSkillsByQuery: vi.fn(),
  formatSkillRecommendations: vi.fn(),
  tokenizeCriteriaValue: vi.fn(),
}));

vi.mock("../../src/core/marketplace/client.js", () => ({
  MarketplaceClient: class {
    search = mocks.search;
  },
}));

vi.mock("../../src/core/network/fetch.js", () => ({
  formatNetworkError: mocks.formatNetworkError,
}));

vi.mock("../../src/core/skills/recommendation.js", () => ({
  tokenizeCriteriaValue: mocks.tokenizeCriteriaValue,
  RECOMMENDATION_ERROR_CODES: {
    QUERY_INVALID: "E_SKILLS_QUERY_INVALID",
    NO_MATCHES: "E_SKILLS_NO_MATCHES",
    SOURCE_UNAVAILABLE: "E_SKILLS_SOURCE_UNAVAILABLE",
    CRITERIA_CONFLICT: "E_SKILLS_CRITERIA_CONFLICT",
  },
}));

vi.mock("../../src/core/skills/recommendation-api.js", () => ({
  recommendSkills: mocks.recommendSkillsByQuery,
  formatSkillRecommendations: mocks.formatSkillRecommendations,
}));

import { registerSkillsFind } from "../../src/commands/skills/find.js";

describe("integration: skills find recommend contract", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.search.mockReset();
    mocks.formatNetworkError.mockReset();
    mocks.recommendSkillsByQuery.mockReset();
    mocks.formatSkillRecommendations.mockReset();
    mocks.tokenizeCriteriaValue.mockReset();

    mocks.search.mockResolvedValue([
      {
        name: "docs-pro",
        scopedName: "@demo/docs-pro",
        description: "Modern docs workflow",
        author: "demo",
        stars: 420,
        githubUrl: "https://github.com/demo/docs-pro",
        repoFullName: "demo/docs-pro",
        path: "skills/docs-pro/SKILL.md",
        source: "skillsmp",
      },
    ]);
    mocks.formatNetworkError.mockReturnValue("network down");
    mocks.tokenizeCriteriaValue.mockImplementation((value: string) =>
      value
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean),
    );
    const ranked = {
      criteria: {
        query: "docs",
        queryTokens: ["docs"],
        mustHave: ["docs"],
        prefer: [],
        exclude: [],
      },
      ranking: [
        {
          skill: {
            name: "docs-pro",
            scopedName: "@demo/docs-pro",
            description: "Modern docs workflow",
            author: "demo",
            stars: 420,
            githubUrl: "https://github.com/demo/docs-pro",
            repoFullName: "demo/docs-pro",
            path: "skills/docs-pro/SKILL.md",
            source: "skillsmp",
          },
          score: 42.25,
          reasons: [{ code: "MUST_HAVE_MATCH", detail: "1" }],
          excluded: false,
          breakdown: {
            mustHave: 10,
            prefer: 0,
            query: 3,
            stars: 5,
            metadata: 2,
            modernity: 0,
            exclusionPenalty: 0,
            total: 20,
          },
        },
      ],
    };
    mocks.recommendSkillsByQuery.mockResolvedValue(ranked);
    mocks.formatSkillRecommendations.mockImplementation((result: typeof ranked, opts: { mode: "human" | "json" }) => {
      if (opts.mode === "human") {
        return "Recommended skills:\n\n1) @demo/docs-pro (Recommended)\n   why: MUST_HAVE_MATCH\n   tradeoff: none\n\nCHOOSE: 1";
      }
      return {
        query: result.criteria.query,
        recommended: {
          rank: 1,
          scopedName: "@demo/docs-pro",
          score: 42.25,
          reasons: [{ code: "MUST_HAVE_MATCH", detail: "1" }],
          tradeoffs: [],
        },
        options: [
          {
            rank: 1,
            scopedName: "@demo/docs-pro",
            score: 42.25,
            reasons: [{ code: "MUST_HAVE_MATCH", detail: "1" }],
            tradeoffs: [],
          },
        ],
      };
    });
  });

  it("shows ranked human output and CHOOSE line", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerSkillsFind(program);

    await program.parseAsync(["node", "test", "find", "docs", "--recommend", "--top", "1", "--human"]);

    const lines = logSpy.mock.calls.map((call) => String(call[0] ?? ""));
    expect(lines.some((line) => line.includes("Recommended skills"))).toBe(true);
    expect(lines.some((line) => line.includes("1)") && line.includes("@demo/docs-pro"))).toBe(true);
    expect(lines.some((line) => line.includes("CHOOSE:"))).toBe(true);
  });

  it("returns LAFS envelope with recommendation payload in JSON mode", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerSkillsFind(program);

    await program.parseAsync(["node", "test", "find", "docs", "--recommend", "--json", "--top", "1"]);

    const output = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}")) as {
      $schema: string;
      success: boolean;
      _meta: { operation: string; transport: string };
      result: {
        query: string;
        recommended: { scopedName: string };
        options: Array<{ rank: number; scopedName: string; reasons: Array<{ code: string }>; tradeoffs: string[] }>;
      };
    };

    expect(output.$schema).toBe("https://lafs.dev/schemas/v1/envelope.schema.json");
    expect(output.success).toBe(true);
    expect(output._meta.operation).toBe("skills.find.recommend");
    expect(output._meta.transport).toBe("cli");
    expect(output.result.query).toBe("docs");
    expect(output.result.recommended.scopedName).toBe("@demo/docs-pro");
    expect(output.result.options[0]?.rank).toBe(1);
    expect(output.result.options[0]?.scopedName).toBe("@demo/docs-pro");
    expect(output.result.options[0]?.reasons[0]?.code).toBe("MUST_HAVE_MATCH");
    expect(output.result.options[0]?.tradeoffs).toBeDefined();
  });

  it("expands JSON evidence fields with --details", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerSkillsFind(program);

    await program.parseAsync([
      "node",
      "test",
      "find",
      "docs",
      "--recommend",
      "--json",
      "--details",
      "--top",
      "1",
    ]);

    const output = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}")) as {
      _meta: { mvi: string };
      result: {
        options: Array<{
          reasons: Array<{ code: string }>;
        }>;
      };
    };

    expect(output._meta.mvi).toBe("full");
    expect(output.result.options[0]?.reasons[0]?.code).toBe("MUST_HAVE_MATCH");
  });

  it("returns stable validation and conflict codes in JSON mode", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process-exit");
    }) as never);

    const programValidation = new Command();
    registerSkillsFind(programValidation);

    await expect(
      programValidation.parseAsync(["node", "test", "find", "docs", "--recommend", "--json", "--top", "0"]),
    ).rejects.toThrow("process-exit");

    const validationOutput = JSON.parse(String(errorSpy.mock.calls[0]?.[0] ?? "{}")) as {
      error: { code: string; category: string };
    };
    expect(validationOutput.error.code).toBe("E_SKILLS_QUERY_INVALID");
    expect(validationOutput.error.category).toBe("VALIDATION");

    errorSpy.mockClear();

    const programConflict = new Command();
    registerSkillsFind(programConflict);

    await expect(
      programConflict.parseAsync([
        "node",
        "test",
        "find",
        "docs",
        "--recommend",
        "--json",
        "--must-have",
        "docs",
        "--exclude",
        "docs",
      ]),
    ).rejects.toThrow("process-exit");

    const conflictOutput = JSON.parse(String(errorSpy.mock.calls[0]?.[0] ?? "{}")) as {
      error: { code: string; category: string };
    };
    expect(conflictOutput.error.code).toBe("E_SKILLS_CRITERIA_CONFLICT");
    expect(conflictOutput.error.category).toBe("CONFLICT");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("matches golden LAFS MVI JSON snapshot", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerSkillsFind(program);

    await program.parseAsync(["node", "test", "find", "docs", "--recommend", "--json", "--top", "1"]);

    const output = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}")) as Record<string, unknown>;
    const normalized = {
      ...output,
      _meta: {
        ...(output._meta as Record<string, unknown>),
        timestamp: "<timestamp>",
        requestId: "<request-id>",
      },
    };

    expect(normalized).toMatchInlineSnapshot(`
      {
        "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
        "_meta": {
          "contextVersion": 0,
          "mvi": "standard",
          "operation": "skills.find.recommend",
          "requestId": "<request-id>",
          "schemaVersion": "1.0.0",
          "specVersion": "1.0.0",
          "strict": true,
          "timestamp": "<timestamp>",
          "transport": "cli",
        },
        "error": null,
        "page": null,
        "result": {
          "options": [
            {
              "rank": 1,
              "reasons": [
                {
                  "code": "MUST_HAVE_MATCH",
                  "detail": "1",
                },
              ],
              "scopedName": "@demo/docs-pro",
              "score": 42.25,
              "tradeoffs": [],
            },
          ],
          "query": "docs",
          "recommended": {
            "rank": 1,
            "reasons": [
              {
                "code": "MUST_HAVE_MATCH",
                "detail": "1",
              },
            ],
            "scopedName": "@demo/docs-pro",
            "score": 42.25,
            "tradeoffs": [],
          },
          "selected": [],
        },
        "success": true,
      }
    `);
  });

  it("matches golden LAFS detailed JSON snapshot", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerSkillsFind(program);

    await program.parseAsync([
      "node",
      "test",
      "find",
      "docs",
      "--recommend",
      "--json",
      "--details",
      "--top",
      "1",
    ]);

    const output = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}")) as Record<string, unknown>;
    const normalized = {
      ...output,
      _meta: {
        ...(output._meta as Record<string, unknown>),
        timestamp: "<timestamp>",
        requestId: "<request-id>",
      },
    };

    expect(normalized).toMatchInlineSnapshot(`
      {
        "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
        "_meta": {
          "contextVersion": 0,
          "mvi": "full",
          "operation": "skills.find.recommend",
          "requestId": "<request-id>",
          "schemaVersion": "1.0.0",
          "specVersion": "1.0.0",
          "strict": true,
          "timestamp": "<timestamp>",
          "transport": "cli",
        },
        "error": null,
        "page": null,
        "result": {
          "options": [
            {
              "rank": 1,
              "reasons": [
                {
                  "code": "MUST_HAVE_MATCH",
                  "detail": "1",
                },
              ],
              "scopedName": "@demo/docs-pro",
              "score": 42.25,
              "tradeoffs": [],
            },
          ],
          "query": "docs",
          "recommended": {
            "rank": 1,
            "reasons": [
              {
                "code": "MUST_HAVE_MATCH",
                "detail": "1",
              },
            ],
            "scopedName": "@demo/docs-pro",
            "score": 42.25,
            "tradeoffs": [],
          },
          "selected": [],
        },
        "success": true,
      }
    `);
  });

  it("returns selected item objects with --select in JSON mode", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerSkillsFind(program);

    await program.parseAsync([
      "node",
      "test",
      "find",
      "docs",
      "--recommend",
      "--json",
      "--top",
      "1",
      "--select",
      "1",
    ]);

    const output = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}")) as {
      result: {
        selected: Array<{ rank: number; scopedName: string }>;
      };
    };

    expect(output.result.selected).toHaveLength(1);
    expect(output.result.selected[0]?.rank).toBe(1);
    expect(output.result.selected[0]?.scopedName).toBe("@demo/docs-pro");
  });
});
