/**
 * Tests for format resolution error branches in skills commands that use
 * resolveOutputFormat from @cleocode/lafs (validate, list, find).
 */

import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const protocolMock = vi.hoisted(() => ({
  resolveOutputFormat: vi.fn(),
}));

const commonMocks = vi.hoisted(() => ({
  validateSkill: vi.fn(),
  isHuman: vi.fn(),
  getProvider: vi.fn(),
  getInstalledProviders: vi.fn(),
  discoverSkillsMulti: vi.fn(),
  resolveProviderSkillsDir: vi.fn(),
  search: vi.fn(),
  formatNetworkError: vi.fn(),
  recommendSkillsByQuery: vi.fn(),
  formatSkillRecommendations: vi.fn(),
  tokenizeCriteriaValue: vi.fn(),
}));

vi.mock("@cleocode/lafs", () => ({
  resolveOutputFormat: protocolMock.resolveOutputFormat,
}));

vi.mock("../../src/core/logger.js", () => ({
  isHuman: commonMocks.isHuman,
}));

vi.mock("../../src/core/skills/validator.js", () => ({
  validateSkill: commonMocks.validateSkill,
}));

vi.mock("../../src/core/lafs.js", () => ({
  buildEnvelope: vi.fn().mockReturnValue({ $schema: "test" }),
  ErrorCategories: {
    VALIDATION: "VALIDATION",
    NOT_FOUND: "NOT_FOUND",
    CONFLICT: "CONFLICT",
  },
  ErrorCodes: {
    FORMAT_CONFLICT: "E_FORMAT_CONFLICT",
    FILE_NOT_FOUND: "E_FILE_NOT_FOUND",
  },
  emitJsonError: vi.fn(),
}));

vi.mock("../../src/core/registry/providers.js", () => ({
  getProvider: commonMocks.getProvider,
}));

vi.mock("../../src/core/registry/detection.js", () => ({
  getInstalledProviders: commonMocks.getInstalledProviders,
}));

vi.mock("../../src/core/skills/discovery.js", () => ({
  discoverSkillsMulti: commonMocks.discoverSkillsMulti,
}));

vi.mock("../../src/core/paths/standard.js", () => ({
  resolveProviderSkillsDir: commonMocks.resolveProviderSkillsDir,
}));

vi.mock("../../src/core/marketplace/client.js", () => ({
  MarketplaceClient: class {
    search = commonMocks.search;
  },
}));

vi.mock("../../src/core/network/fetch.js", () => ({
  formatNetworkError: commonMocks.formatNetworkError,
}));

vi.mock("../../src/core/skills/recommendation.js", () => ({
  tokenizeCriteriaValue: commonMocks.tokenizeCriteriaValue,
  RECOMMENDATION_ERROR_CODES: {
    QUERY_INVALID: "E_SKILLS_QUERY_INVALID",
    NO_MATCHES: "E_SKILLS_NO_MATCHES",
    SOURCE_UNAVAILABLE: "E_SKILLS_SOURCE_UNAVAILABLE",
    CRITERIA_CONFLICT: "E_SKILLS_CRITERIA_CONFLICT",
  },
}));

vi.mock("../../src/core/skills/recommendation-api.js", () => ({
  recommendSkills: commonMocks.recommendSkillsByQuery,
  formatSkillRecommendations: commonMocks.formatSkillRecommendations,
}));

import { registerSkillsValidate } from "../../src/commands/skills/validate.js";
import { registerSkillsList } from "../../src/commands/skills/list.js";
import { registerSkillsFind } from "../../src/commands/skills/find.js";

describe("skills commands - protocol format resolution error branches", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    protocolMock.resolveOutputFormat.mockReset();
    Object.values(commonMocks).forEach((mock) => mock?.mockReset?.());
    commonMocks.isHuman.mockReturnValue(false);
    commonMocks.getInstalledProviders.mockReturnValue([{ id: "claude-code", toolName: "Claude Code" }]);
    commonMocks.tokenizeCriteriaValue.mockImplementation((value: string) =>
      value.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
    );
  });

  describe("validate command - format error", () => {
    it("exits with error when resolveOutputFormat throws", async () => {
      protocolMock.resolveOutputFormat.mockImplementation(() => {
        throw new Error("Cannot specify both --json and --human");
      });

      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("process-exit");
      }) as never);

      const program = new Command();
      registerSkillsValidate(program);

      await expect(
        program.parseAsync(["node", "test", "validate", "/path/to/SKILL.md"]),
      ).rejects.toThrow("process-exit");

      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe("list command - format error", () => {
    it("exits with error when resolveOutputFormat throws", async () => {
      protocolMock.resolveOutputFormat.mockImplementation(() => {
        throw new Error("Cannot specify both --json and --human");
      });

      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("process-exit");
      }) as never);

      const program = new Command();
      registerSkillsList(program);

      await expect(
        program.parseAsync(["node", "test", "list"]),
      ).rejects.toThrow("process-exit");

      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe("find command - format error in non-json mode", () => {
    it("exits with error logged to stderr when resolveOutputFormat throws and --json is not set", async () => {
      protocolMock.resolveOutputFormat.mockImplementation(() => {
        throw new Error("Format conflict detected");
      });

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("process-exit");
      }) as never);

      const program = new Command();
      registerSkillsFind(program);

      await expect(
        program.parseAsync(["node", "test", "find", "test"]),
      ).rejects.toThrow("process-exit");

      const output = errorSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
      expect(output).toContain("Format conflict detected");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("exits with JSON error when resolveOutputFormat throws and --json is set", async () => {
      protocolMock.resolveOutputFormat.mockImplementation(() => {
        throw new Error("Format conflict detected");
      });

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("process-exit");
      }) as never);

      const program = new Command();
      registerSkillsFind(program);

      await expect(
        program.parseAsync(["node", "test", "find", "test", "--json"]),
      ).rejects.toThrow("process-exit");

      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });
});
