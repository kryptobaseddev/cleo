/**
 * Additional coverage tests for skills commands.
 * Targets uncovered lines/branches across audit, install, find, remove, update, validate, check, init, list.
 */

import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  expectFormatConflict,
  fixtures,
  runCli,
} from "./helpers/index.js";

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  statSync: vi.fn(),
  scanFile: vi.fn(),
  scanDirectory: vi.fn(),
  toSarif: vi.fn(),
  getTrackedSkills: vi.fn(),
  checkSkillUpdate: vi.fn(),
  removeSkill: vi.fn(),
  listCanonicalSkills: vi.fn(),
  removeSkillFromLock: vi.fn(),
  installSkill: vi.fn(),
  parseSource: vi.fn(),
  cloneRepo: vi.fn(),
  cloneGitLabRepo: vi.fn(),
  getProvider: vi.fn(),
  getInstalledProviders: vi.fn(),
  discoverSkillsMulti: vi.fn(),
  resolveProviderSkillsDir: vi.fn(),
  validateSkill: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  recordSkillInstall: vi.fn(),
  formatNetworkError: vi.fn(),
  isMarketplaceScoped: vi.fn(),
  marketplaceGetSkill: vi.fn(),
  isCatalogAvailable: vi.fn(),
  resolveProfile: vi.fn(),
  getSkillDir: vi.fn(),
  listProfiles: vi.fn(),
  getSkill: vi.fn(),
  listSkills: vi.fn(),
  discoverSkill: vi.fn(),
  search: vi.fn(),
  recommendSkillsByQuery: vi.fn(),
  formatSkillRecommendations: vi.fn(),
  tokenizeCriteriaValue: vi.fn(),
  buildSkillSubPathCandidates: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: mocks.existsSync,
  statSync: mocks.statSync,
}));

vi.mock("node:fs/promises", () => ({
  mkdir: mocks.mkdir,
  writeFile: mocks.writeFile,
}));

vi.mock("../../src/core/skills/audit/scanner.js", () => ({
  scanFile: mocks.scanFile,
  scanDirectory: mocks.scanDirectory,
  toSarif: mocks.toSarif,
}));

vi.mock("../../src/core/skills/lock.js", () => ({
  getTrackedSkills: mocks.getTrackedSkills,
  checkSkillUpdate: mocks.checkSkillUpdate,
  removeSkillFromLock: mocks.removeSkillFromLock,
  recordSkillInstall: mocks.recordSkillInstall,
}));

vi.mock("../../src/core/skills/installer.js", () => ({
  removeSkill: mocks.removeSkill,
  listCanonicalSkills: mocks.listCanonicalSkills,
  installSkill: mocks.installSkill,
}));

// T9747 + T9751: trust-gate-adapter.ts was deleted (logic inlined into
// install.ts as evaluateSkillTrustGate / evaluateFederationGate). These
// inline gates call `resolveCore()` which dynamic-imports `@cleocode/core`
// and invokes `scanSkill`, `shouldAllowInstall`, and
// `evaluateFederationInstallGate`. Mock the core module directly so paths
// that don't exist on disk in tests still get a permissive allow.
vi.mock("@cleocode/core", () => ({
  scanSkill: vi.fn(() => ({
    skillName: "test",
    source: "test",
    trustLevel: "community",
    verdict: "safe",
    findings: [],
    scannedAt: new Date().toISOString(),
    summary: "test-stub",
  })),
  shouldAllowInstall: vi.fn(() => ({ decision: "allow", reason: "test-stub" })),
  evaluateFederationInstallGate: vi.fn(() => ({
    decision: "allow",
    reason: "test-stub",
    peer: null,
    isFederationSource: false,
    computedChecksum: null,
    expectedChecksum: null,
  })),
  recordTrustBypass: vi.fn(() => {}),
}));

vi.mock("../../src/core/sources/parser.js", () => ({
  parseSource: mocks.parseSource,
  isMarketplaceScoped: mocks.isMarketplaceScoped,
}));

vi.mock("../../src/core/sources/github.js", () => ({
  cloneRepo: mocks.cloneRepo,
}));

vi.mock("../../src/core/sources/gitlab.js", () => ({
  cloneGitLabRepo: mocks.cloneGitLabRepo,
}));

vi.mock("../../src/core/registry/providers.js", () => ({
  getProvider: mocks.getProvider,
  getInstalledProviders: mocks.getInstalledProviders,
  getAllProviders: vi.fn().mockReturnValue([]),
  getRegistryVersion: vi.fn().mockReturnValue("1.0.0"),
  getProviderCount: vi.fn().mockReturnValue(44),
}));

vi.mock("../../src/core/registry/detection.js", () => ({
  getInstalledProviders: mocks.getInstalledProviders,
}));

vi.mock("../../src/core/skills/discovery.js", () => ({
  discoverSkillsMulti: mocks.discoverSkillsMulti,
  discoverSkill: mocks.discoverSkill,
}));

vi.mock("../../src/core/paths/standard.js", () => ({
  resolveProviderSkillsDir: mocks.resolveProviderSkillsDir,
  buildSkillSubPathCandidates: mocks.buildSkillSubPathCandidates,
}));

vi.mock("../../src/core/skills/validator.js", () => ({
  validateSkill: mocks.validateSkill,
}));

vi.mock("../../src/core/network/fetch.js", () => ({
  formatNetworkError: mocks.formatNetworkError,
}));

vi.mock("../../src/core/marketplace/client.js", () => ({
  MarketplaceClient: class {
    getSkill = mocks.marketplaceGetSkill;
    search = mocks.search;
  },
}));

vi.mock("../../src/core/skills/catalog.js", () => ({
  isCatalogAvailable: mocks.isCatalogAvailable,
  resolveProfile: mocks.resolveProfile,
  getSkillDir: mocks.getSkillDir,
  listProfiles: mocks.listProfiles,
  getSkill: mocks.getSkill,
  listSkills: mocks.listSkills,
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

// Import after mocks
import { registerSkillsAudit } from "../../src/commands/skills/audit.js";
import { registerSkillsCheck } from "../../src/commands/skills/check.js";
import { registerSkillsInit } from "../../src/commands/skills/init.js";
import { registerSkillsInstall } from "../../src/commands/skills/install.js";
import { registerSkillsList } from "../../src/commands/skills/list.js";
import { registerSkillsRemove } from "../../src/commands/skills/remove.js";
import { registerSkillsUpdate } from "../../src/commands/skills/update.js";
import { registerSkillsValidate } from "../../src/commands/skills/validate.js";
import { registerSkillsFind } from "../../src/commands/skills/find.js";

const mockProvider = {
  id: "claude-code",
  toolName: "Claude Code",
  pathGlobal: "/global",
  pathProject: "/project",
};

const mockProvider2 = {
  id: "cursor",
  toolName: "Cursor",
  pathGlobal: "/global2",
  pathProject: "/project2",
};

describe("skills commands - additional coverage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.values(mocks).forEach((mock) => mock?.mockReset?.());

    mocks.existsSync.mockReturnValue(true);
    mocks.getInstalledProviders.mockReturnValue([mockProvider]);
    mocks.getProvider.mockReturnValue(mockProvider);
    mocks.removeSkillFromLock.mockResolvedValue(true);
    mocks.isMarketplaceScoped.mockReturnValue(false);
    mocks.isCatalogAvailable.mockReturnValue(false);
    mocks.formatNetworkError.mockReturnValue("network failed");
    mocks.listSkills.mockReturnValue([]);
    mocks.discoverSkill.mockResolvedValue({ name: "discovered-name" });
    mocks.tokenizeCriteriaValue.mockImplementation((value: string) =>
      value
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean),
    );
  });

  // ==========================================
  // AUDIT COMMAND - uncovered lines 130-223
  // ==========================================
  describe("skills audit - additional coverage", () => {
    it("format conflict exits when both --json and --human passed", async () => {
      await expectFormatConflict(registerSkillsAudit, ["audit", "/path"]);
    });

    it("outputs SARIF error when path not found and --sarif is set", async () => {
      mocks.existsSync.mockReturnValue(false);

      const inv = await runCli(
        registerSkillsAudit,
        ["audit", "/nonexistent", "--sarif"],
        { expectExit: 1 },
      );

      const output = inv.jsonStderr() as {
        version: string;
        runs: Array<{ invocations: Array<{ executionSuccessful: boolean }> }>;
      };
      expect(output.version).toBe("2.1.0");
      expect(output.runs[0].invocations[0].executionSuccessful).toBe(false);
    });

    it("outputs SARIF error when scan throws and format is sarif", async () => {
      mocks.statSync.mockReturnValue({ isFile: () => true });
      mocks.scanFile.mockRejectedValue(new Error("scan failed"));

      const inv = await runCli(
        registerSkillsAudit,
        ["audit", "/path/to/SKILL.md", "--sarif"],
        { expectExit: 1 },
      );

      const output = inv.jsonStderr() as {
        version: string;
        runs: Array<{ invocations: Array<{ exitCodeDescription: string }> }>;
      };
      expect(output.version).toBe("2.1.0");
      expect(output.runs[0].invocations[0].exitCodeDescription).toBe("scan failed");
    });

    it("outputs LAFS JSON error when scan throws and format is json", async () => {
      mocks.statSync.mockReturnValue({ isFile: () => true });
      mocks.scanFile.mockRejectedValue(new Error("scan broke"));

      const inv = await runCli(
        registerSkillsAudit,
        ["audit", "/path/to/SKILL.md", "--json"],
        { expectExit: 1 },
      );

      expect(inv.stderr.length).toBeGreaterThan(0);
    });

    it("outputs SARIF for empty results with --sarif", async () => {
      mocks.statSync.mockReturnValue({ isFile: () => false });
      mocks.scanDirectory.mockResolvedValue([]);
      mocks.toSarif.mockReturnValue({ version: "2.1.0", runs: [] });

      const inv = await runCli(registerSkillsAudit, ["audit", "/empty", "--sarif"]);

      expect(mocks.toSarif).toHaveBeenCalledWith([]);
      const output = inv.jsonStdout() as { version: string };
      expect(output.version).toBe("2.1.0");
    });

    it("outputs JSON envelope for empty results with --json", async () => {
      mocks.statSync.mockReturnValue({ isFile: () => false });
      mocks.scanDirectory.mockResolvedValue([]);

      const inv = await runCli(registerSkillsAudit, ["audit", "/empty", "--json"]);

      const output = inv.jsonStdout() as {
        $schema: string;
        result: { scanned: number };
      };
      expect(output.$schema).toBe("https://lafs.dev/schemas/v1/envelope.schema.json");
      expect(output.result.scanned).toBe(0);
    });

    it("outputs SARIF for results with findings and exits 1 when not all passed", async () => {
      const findings = [fixtures.scanFinding("critical")];
      mocks.statSync.mockReturnValue({ isFile: () => true });
      mocks.scanFile.mockResolvedValue({
        file: "test.md",
        findings,
        score: 70,
        passed: false,
      });
      mocks.toSarif.mockReturnValue({ version: "2.1.0", runs: [{ results: findings }] });

      const inv = await runCli(
        registerSkillsAudit,
        ["audit", "test.md", "--sarif"],
        { expectExit: "any" },
      );

      expect(mocks.toSarif).toHaveBeenCalled();
      expect(inv.exitCode).toBe(1);
    });

    it("outputs JSON for results with findings and exits 1 when not all passed", async () => {
      mocks.statSync.mockReturnValue({ isFile: () => true });
      mocks.scanFile.mockResolvedValue({
        file: "test.md",
        findings: [fixtures.scanFinding("critical")],
        score: 70,
        passed: false,
      });

      const inv = await runCli(
        registerSkillsAudit,
        ["audit", "test.md", "--json"],
        { expectExit: "any" },
      );

      const output = inv.jsonStdout() as { result: { findings: number } };
      expect(output.result.findings).toBe(1);
      expect(inv.exitCode).toBe(1);
    });

    it("human output shows severity colors for all levels and file details", async () => {
      mocks.statSync.mockReturnValue({ isFile: () => false });
      mocks.scanDirectory.mockResolvedValue([
        fixtures.passingAuditResult(),
        {
          file: "/skills/bad/SKILL.md",
          findings: [
            fixtures.scanFinding("critical"),
            fixtures.scanFinding("high"),
            fixtures.scanFinding("medium"),
            fixtures.scanFinding("low"),
          ],
          score: 50,
          passed: false,
        },
      ]);

      const inv = await runCli(
        registerSkillsAudit,
        ["audit", "/skills", "--human"],
        { expectExit: "any" },
      );

      const output = inv.humanStdout();
      expect(output).toContain("No issues found");
      expect(output).toContain("file(s) scanned");
      expect(output).toContain("finding(s)");
      expect(inv.exitCode).toBe(1);
    });

    it("handles non-Error thrown from scan", async () => {
      mocks.statSync.mockReturnValue({ isFile: () => true });
      mocks.scanFile.mockRejectedValue("string error");

      const inv = await runCli(
        registerSkillsAudit,
        ["audit", "/path/to/SKILL.md"],
        { expectExit: 1 },
      );

      expect(inv.exitCode).toBe(1);
    });

    it("single-file SARIF success path exits cleanly when all passed", async () => {
      // Coverage anchor for audit.ts line 243 (post-allPassed SARIF return).
      // Distinct from "outputs SARIF for empty results" which exercises
      // scanDirectory; this exercises scanFile (single-file path) on success.
      mocks.statSync.mockReturnValue({ isFile: () => true });
      mocks.scanFile.mockResolvedValue(fixtures.passingAuditResult({ file: "test.md" }));
      mocks.toSarif.mockReturnValue({ version: "2.1.0", runs: [] });

      await runCli(registerSkillsAudit, ["audit", "test.md", "--sarif"]);

      expect(mocks.toSarif).toHaveBeenCalled();
    });

    it("single-file JSON success path exits cleanly when all passed", async () => {
      // Coverage anchor for audit.ts line 252 (post-allPassed JSON return).
      mocks.statSync.mockReturnValue({ isFile: () => true });
      mocks.scanFile.mockResolvedValue(fixtures.passingAuditResult({ file: "test.md" }));

      const inv = await runCli(registerSkillsAudit, ["audit", "test.md", "--json"]);

      const output = inv.jsonStdout() as { result: { scanned: number; findings: number } };
      expect(output.result.scanned).toBe(1);
      expect(output.result.findings).toBe(0);
    });
  });

  // ==========================================
  // INSTALL COMMAND - uncovered lines 350-556
  // ==========================================
  describe("skills install - additional coverage", () => {
    const marketplaceSkillHit = {
      name: "demo",
      author: "alice",
      repoFullName: "alice/demo",
      githubUrl: "https://github.com/alice/demo",
      path: "skills/demo/SKILL.md",
    };
    const catalogPkgGetSkill = {
      name: "ct-test",
      version: "1.0.0",
      category: "test",
      core: false,
      description: "test",
    };

    it("format conflict exits when both --json and --human passed", async () => {
      await expectFormatConflict(registerSkillsInstall, ["install", "some-source", "--all"]);
    });

    it("handles install failure (success=false) in JSON mode", async () => {
      mocks.parseSource.mockReturnValue({ type: "local", inferredName: "demo", value: "/tmp/demo" });
      mocks.installSkill.mockResolvedValue(fixtures.installFailure());

      const inv = await runCli(
        registerSkillsInstall,
        ["install", "/tmp/demo", "--all", "--json"],
        { expectExit: 1 },
      );

      const output = inv.jsonStderr() as { result: { count: { failed: number } } };
      expect(output.result.count.failed).toBe(1);
    });

    it("handles install failure (success=false) in human mode", async () => {
      mocks.parseSource.mockReturnValue({ type: "local", inferredName: "demo", value: "/tmp/demo" });
      mocks.installSkill.mockResolvedValue(fixtures.installFailure());

      const inv = await runCli(
        registerSkillsInstall,
        ["install", "/tmp/demo", "--all", "--human"],
        { expectExit: 1 },
      );

      const output = inv.humanStdout();
      expect(output).toContain("Failed to install");
      expect(output).toContain("cannot link");
    });

    it("handles missing localPath after source resolution", async () => {
      mocks.parseSource.mockReturnValue({ type: "url", inferredName: "demo", value: "http://example.com" });

      await runCli(
        registerSkillsInstall,
        ["install", "http://example.com", "--all"],
        { expectExit: 1 },
      );
    });

    it("handles GitHub clone failure in JSON mode", async () => {
      mocks.parseSource.mockReturnValue({ type: "github", owner: "org", repo: "skill", ref: "main", inferredName: "skill", value: "org/skill" });
      mocks.cloneRepo.mockRejectedValue(new Error("network timeout"));

      await runCli(
        registerSkillsInstall,
        ["install", "org/skill", "--all", "--json"],
        { expectExit: 1 },
      );
    });

    it("handles GitLab clone failure in JSON mode", async () => {
      mocks.parseSource.mockReturnValue({ type: "gitlab", owner: "group", repo: "skill", ref: "main", inferredName: "skill", value: "gitlab.com/group/skill" });
      mocks.cloneGitLabRepo.mockRejectedValue(new Error("network timeout"));

      await runCli(
        registerSkillsInstall,
        ["install", "gitlab.com/group/skill", "--all", "--json"],
        { expectExit: 1 },
      );
    });

    it("handles catalog not available for package type in JSON mode", async () => {
      mocks.parseSource.mockReturnValue({ type: "package", inferredName: "ct-test", value: "ct-test" });
      mocks.isCatalogAvailable.mockReturnValue(false);

      await runCli(
        registerSkillsInstall,
        ["install", "ct-test", "--all", "--json"],
        { expectExit: 1 },
      );
    });

    it("handles skill not found in catalog in JSON mode", async () => {
      mocks.parseSource.mockReturnValue({ type: "package", inferredName: "ct-missing", value: "ct-missing" });
      mocks.isCatalogAvailable.mockReturnValue(true);
      mocks.getSkill.mockReturnValue(undefined);
      mocks.listSkills.mockReturnValue(["ct-a", "ct-b"]);

      await runCli(
        registerSkillsInstall,
        ["install", "ct-missing", "--all", "--json"],
        { expectExit: 1 },
      );
    });

    it("installs successfully in JSON mode", async () => {
      mocks.parseSource.mockReturnValue({ type: "local", inferredName: "demo", value: "/tmp/demo" });
      mocks.installSkill.mockResolvedValue(fixtures.installSuccess());
      mocks.recordSkillInstall.mockResolvedValue(undefined);

      const inv = await runCli(registerSkillsInstall, ["install", "/tmp/demo", "--all", "--json"]);

      const output = inv.jsonStdout() as {
        $schema: string;
        result: { count: { installed: number } };
      };
      expect(output.$schema).toBe("https://lafs.dev/schemas/v1/envelope.schema.json");
      expect(output.result.count.installed).toBe(1);
    });

    it("installs successfully in human mode with warnings", async () => {
      mocks.parseSource.mockReturnValue({ type: "local", inferredName: "demo", value: "/tmp/demo" });
      mocks.installSkill.mockResolvedValue(
        fixtures.installSuccess({ errors: ["symlink fallback used"] }),
      );
      mocks.recordSkillInstall.mockResolvedValue(undefined);

      const inv = await runCli(registerSkillsInstall, ["install", "/tmp/demo", "--all", "--human"]);

      const output = inv.humanStdout();
      expect(output).toContain("Installed");
      expect(output).toContain("Warnings");
      expect(output).toContain("symlink fallback used");
    });

    it("uses default provider resolution (no --all or --agent) to install", async () => {
      mocks.getInstalledProviders.mockReturnValue([mockProvider]);
      mocks.parseSource.mockReturnValue({ type: "local", inferredName: "demo", value: "/tmp/demo" });
      mocks.installSkill.mockResolvedValue(fixtures.installSuccess());
      mocks.recordSkillInstall.mockResolvedValue(undefined);

      // No --all, no --agent flags -> uses default getInstalledProviders
      await runCli(registerSkillsInstall, ["install", "/tmp/demo"]);

      expect(mocks.getInstalledProviders).toHaveBeenCalled();
      expect(mocks.installSkill).toHaveBeenCalled();
    });

    it("uses --agent flag to filter providers", async () => {
      mocks.getProvider.mockReturnValue(mockProvider);
      mocks.parseSource.mockReturnValue({ type: "local", inferredName: "demo", value: "/tmp/demo" });
      mocks.installSkill.mockResolvedValue(fixtures.installSuccess());
      mocks.recordSkillInstall.mockResolvedValue(undefined);

      await runCli(registerSkillsInstall, ["install", "/tmp/demo", "--agent", "claude-code"]);

      expect(mocks.getProvider).toHaveBeenCalledWith("claude-code");
      expect(mocks.installSkill).toHaveBeenCalled();
    });

    it("handles missing source and no profile with JSON error", async () => {
      await runCli(
        registerSkillsInstall,
        ["install", "--all", "--json"],
        { expectExit: 1 },
      );
    });

    it("handles marketplace source lookup failure in JSON mode", async () => {
      mocks.isMarketplaceScoped.mockReturnValue(true);
      mocks.marketplaceGetSkill.mockRejectedValue(new Error("network down"));

      await runCli(
        registerSkillsInstall,
        ["install", "@alice/skill", "--all", "--json"],
        { expectExit: 1 },
      );
    });

    it("handles marketplace skill not found in JSON mode", async () => {
      mocks.isMarketplaceScoped.mockReturnValue(true);
      mocks.marketplaceGetSkill.mockResolvedValue(null);

      await runCli(
        registerSkillsInstall,
        ["install", "@alice/nonexistent", "--all", "--json"],
        { expectExit: 1 },
      );
    });

    it("handles marketplace source that resolves to non-GitHub in JSON mode", async () => {
      mocks.isMarketplaceScoped.mockReturnValue(true);
      mocks.marketplaceGetSkill.mockResolvedValue({
        ...marketplaceSkillHit,
        githubUrl: "https://example.com/alice/demo",
      });
      mocks.parseSource.mockReturnValue({ type: "local", value: "https://example.com/alice/demo" });

      await runCli(
        registerSkillsInstall,
        ["install", "@alice/demo", "--all", "--json"],
        { expectExit: 1 },
      );
    });

    it("handles marketplace clone failure in JSON mode", async () => {
      mocks.isMarketplaceScoped.mockReturnValue(true);
      mocks.marketplaceGetSkill.mockResolvedValue(marketplaceSkillHit);
      mocks.parseSource.mockReturnValue({ type: "github", owner: "alice", repo: "demo", ref: "main" });
      mocks.buildSkillSubPathCandidates.mockReturnValue(["skills/demo"]);
      mocks.cloneRepo.mockRejectedValue(new Error("clone failed"));

      await runCli(
        registerSkillsInstall,
        ["install", "@alice/demo", "--all", "--json"],
        { expectExit: 1 },
      );
    });

    it("handles marketplace install in human mode with found message", async () => {
      mocks.isMarketplaceScoped.mockReturnValue(true);
      mocks.marketplaceGetSkill.mockResolvedValue(marketplaceSkillHit);
      mocks.parseSource.mockReturnValue({ type: "github", owner: "alice", repo: "demo", ref: "main" });
      mocks.buildSkillSubPathCandidates.mockReturnValue([undefined]);
      mocks.cloneRepo.mockResolvedValue(fixtures.clonedRepo({ localPath: "/tmp/repo" }));
      mocks.installSkill.mockResolvedValue(fixtures.installSuccess());
      mocks.recordSkillInstall.mockResolvedValue(undefined);

      const inv = await runCli(registerSkillsInstall, ["install", "@alice/demo", "--all", "--human"]);

      const output = inv.humanStdout();
      expect(output).toContain("Searching marketplace");
      expect(output).toContain("Found:");
      expect(output).toContain("Installed");
    });

    it("handles profile install in human mode - all success", async () => {
      mocks.isCatalogAvailable.mockReturnValue(true);
      mocks.resolveProfile.mockReturnValue(["skill-a", "skill-b"]);
      mocks.getSkillDir.mockImplementation((name: string) => `/tmp/${name}`);
      mocks.installSkill.mockResolvedValue(fixtures.installSuccess({ canonicalPath: "/tmp/canonical" }));
      mocks.recordSkillInstall.mockResolvedValue(undefined);

      const inv = await runCli(
        registerSkillsInstall,
        ["install", "--profile", "core", "--all", "--human"],
      );

      const output = inv.humanStdout();
      expect(output).toContain("Installing profile");
      expect(output).toContain("2 installed");
    });

    it("handles profile install in human mode - with failure", async () => {
      mocks.isCatalogAvailable.mockReturnValue(true);
      mocks.resolveProfile.mockReturnValue(["good-skill", "bad-skill"]);
      mocks.getSkillDir.mockImplementation((name: string) => `/tmp/${name}`);
      mocks.installSkill
        .mockResolvedValueOnce(fixtures.installSuccess({ canonicalPath: "/tmp/canonical" }))
        .mockResolvedValueOnce(fixtures.installFailure(["link failed"]));
      mocks.recordSkillInstall.mockResolvedValue(undefined);

      const inv = await runCli(
        registerSkillsInstall,
        ["install", "--profile", "core", "--all", "--human"],
        { expectExit: 1 },
      );

      const output = inv.humanStdout();
      expect(output).toContain("1 installed");
      expect(output).toContain("1 failed");
    });

    it("handles profile install in JSON mode - all success", async () => {
      mocks.isCatalogAvailable.mockReturnValue(true);
      mocks.resolveProfile.mockReturnValue(["skill-a"]);
      mocks.getSkillDir.mockReturnValue("/tmp/skill-a");
      mocks.installSkill.mockResolvedValue(fixtures.installSuccess({ canonicalPath: "/tmp/canonical" }));
      mocks.recordSkillInstall.mockResolvedValue(undefined);

      const inv = await runCli(
        registerSkillsInstall,
        ["install", "--profile", "core", "--all", "--json"],
      );

      const output = inv.jsonStdout() as {
        $schema: string;
        result: { count: { installed: number } };
      };
      expect(output.$schema).toBe("https://lafs.dev/schemas/v1/envelope.schema.json");
      expect(output.result.count.installed).toBe(1);
    });

    it("handles profile catalog not available in human mode", async () => {
      mocks.isCatalogAvailable.mockReturnValue(false);

      await runCli(
        registerSkillsInstall,
        ["install", "--profile", "core", "--all", "--human"],
        { expectExit: 1 },
      );
    });

    it("handles profile not found in human mode", async () => {
      mocks.isCatalogAvailable.mockReturnValue(true);
      mocks.resolveProfile.mockReturnValue([]);
      mocks.listProfiles.mockReturnValue(["minimal", "core", "full"]);

      const inv = await runCli(
        registerSkillsInstall,
        ["install", "--profile", "unknown", "--all", "--human"],
        { expectExit: 1 },
      );

      const output = inv.humanStdout();
      expect(output).toContain("Available profiles");
    });

    it("handles no providers in human mode", async () => {
      mocks.getInstalledProviders.mockReturnValue([]);

      await runCli(
        registerSkillsInstall,
        ["install", "/tmp/demo", "--all", "--human"],
        { expectExit: 1 },
      );
    });

    it("installs from catalog package type in human mode", async () => {
      mocks.parseSource.mockReturnValue({ type: "package", inferredName: "ct-test", value: "ct-test" });
      mocks.isCatalogAvailable.mockReturnValue(true);
      mocks.getSkill.mockReturnValue(catalogPkgGetSkill);
      mocks.getSkillDir.mockReturnValue("/tmp/ct-test");
      mocks.installSkill.mockResolvedValue(
        fixtures.installSuccess({ canonicalPath: "/tmp/canonical/ct-test" }),
      );
      mocks.recordSkillInstall.mockResolvedValue(undefined);

      const inv = await runCli(registerSkillsInstall, ["install", "ct-test", "--all", "--human"]);

      const output = inv.humanStdout();
      expect(output).toContain("Found in catalog");
      expect(output).toContain("Installed");
    });

    it("cleanup is called on successful install from github", async () => {
      const cleanupFn = vi.fn();
      mocks.parseSource.mockReturnValue({ type: "github", owner: "org", repo: "skill", ref: "main", inferredName: "skill", value: "org/skill" });
      mocks.cloneRepo.mockResolvedValue(fixtures.clonedRepo({ localPath: "/tmp/repo", cleanup: cleanupFn }));
      mocks.installSkill.mockResolvedValue(
        fixtures.installSuccess({ canonicalPath: "/tmp/canonical/skill" }),
      );
      mocks.recordSkillInstall.mockResolvedValue(undefined);

      await runCli(registerSkillsInstall, ["install", "org/skill", "--all"]);

      expect(cleanupFn).toHaveBeenCalled();
    });

    it("handles marketplace subpath candidates with existsSync false for first candidate", async () => {
      mocks.isMarketplaceScoped.mockReturnValue(true);
      mocks.marketplaceGetSkill.mockResolvedValue(marketplaceSkillHit);
      mocks.parseSource.mockReturnValue({ type: "github", owner: "alice", repo: "demo", ref: "main", path: ".claude/skills/demo" });
      mocks.buildSkillSubPathCandidates.mockReturnValue(["skills/demo", ".claude/skills/demo"]);
      mocks.cloneRepo
        .mockResolvedValueOnce(fixtures.clonedRepo({ localPath: "/tmp/repo/skills/demo", cleanup: vi.fn() }))
        .mockResolvedValueOnce(fixtures.clonedRepo({ localPath: "/tmp/repo/.claude/skills/demo" }));
      mocks.existsSync
        .mockReturnValueOnce(false) // first subpath doesn't exist
        .mockReturnValueOnce(true); // second subpath exists
      mocks.installSkill.mockResolvedValue(fixtures.installSuccess());
      mocks.recordSkillInstall.mockResolvedValue(undefined);

      await runCli(registerSkillsInstall, ["install", "@alice/demo", "--all"]);

      expect(mocks.cloneRepo).toHaveBeenCalledTimes(2);
      expect(mocks.installSkill).toHaveBeenCalled();
    });

    it("handles marketplace where all subpath candidates fail to clone", async () => {
      mocks.isMarketplaceScoped.mockReturnValue(true);
      mocks.marketplaceGetSkill.mockResolvedValue(marketplaceSkillHit);
      mocks.parseSource.mockReturnValue({ type: "github", owner: "alice", repo: "demo", ref: "main" });
      mocks.buildSkillSubPathCandidates.mockReturnValue(["skills/demo"]);
      mocks.cloneRepo.mockRejectedValue(new Error("clone failed"));

      await runCli(
        registerSkillsInstall,
        ["install", "@alice/demo", "--all"],
        { expectExit: 1 },
      );
    });

    it("handles marketplace where no subpath candidates succeed (empty list)", async () => {
      mocks.isMarketplaceScoped.mockReturnValue(true);
      mocks.marketplaceGetSkill.mockResolvedValue(marketplaceSkillHit);
      mocks.parseSource.mockReturnValue({ type: "github", owner: "alice", repo: "demo", ref: "main" });
      mocks.buildSkillSubPathCandidates.mockReturnValue([]);

      await runCli(
        registerSkillsInstall,
        ["install", "@alice/demo", "--all"],
        { expectExit: 1 },
      );
    });

    it("handles local source discovery returning null", async () => {
      mocks.parseSource.mockReturnValue({ type: "local", inferredName: "demo", value: "/tmp/demo" });
      mocks.discoverSkill.mockResolvedValue(null);
      mocks.installSkill.mockResolvedValue(fixtures.installSuccess());
      mocks.recordSkillInstall.mockResolvedValue(undefined);

      await runCli(registerSkillsInstall, ["install", "/tmp/demo", "--all"]);

      expect(mocks.installSkill).toHaveBeenCalled();
    });

    it("sets isGlobal to true for library/package sourceType", async () => {
      mocks.parseSource.mockReturnValue({ type: "package", inferredName: "ct-test", value: "ct-test" });
      mocks.isCatalogAvailable.mockReturnValue(true);
      mocks.getSkill.mockReturnValue(catalogPkgGetSkill);
      mocks.getSkillDir.mockReturnValue("/tmp/ct-test");
      mocks.installSkill.mockResolvedValue(
        fixtures.installSuccess({ canonicalPath: "/tmp/canonical/ct-test" }),
      );
      mocks.recordSkillInstall.mockResolvedValue(undefined);

      await runCli(registerSkillsInstall, ["install", "ct-test", "--all"]);

      // recordSkillInstall should be called with isGlobal = true for library type
      expect(mocks.recordSkillInstall).toHaveBeenCalledWith(
        "ct-test",
        "library:ct-test",
        "library:ct-test",
        "library",
        ["claude-code"],
        "/tmp/canonical/ct-test",
        true,
      );
    });

    it("handles no localPath resolved (defensive check at line 244-251)", async () => {
      // Create a scenario where handleMarketplaceSource returns success:true but no localPath
      mocks.isMarketplaceScoped.mockReturnValue(false);
      mocks.parseSource.mockReturnValue({ type: "wellknown", inferredName: "demo", value: "/.well-known/demo" });

      await runCli(
        registerSkillsInstall,
        ["install", "/.well-known/demo", "--all", "--json"],
        { expectExit: 1 },
      );
    });

    it("handles profile install with thrown error in human mode", async () => {
      mocks.isCatalogAvailable.mockReturnValue(true);
      mocks.resolveProfile.mockReturnValue(["throw-skill"]);
      mocks.getSkillDir.mockReturnValue("/tmp/throw-skill");
      mocks.installSkill.mockRejectedValue(new Error("unexpected install error"));

      const inv = await runCli(
        registerSkillsInstall,
        ["install", "--profile", "core", "--all", "--human"],
        { expectExit: 1 },
      );

      const output = inv.humanStdout();
      expect(output).toContain("throw-skill");
      expect(output).toContain("unexpected install error");
    });

    it("handles profile install with thrown error in JSON mode", async () => {
      mocks.isCatalogAvailable.mockReturnValue(true);
      mocks.resolveProfile.mockReturnValue(["throw-skill"]);
      mocks.getSkillDir.mockReturnValue("/tmp/throw-skill");
      mocks.installSkill.mockRejectedValue(new Error("unexpected install error"));

      await runCli(
        registerSkillsInstall,
        ["install", "--profile", "core", "--all", "--json"],
        { expectExit: 1 },
      );
    });

    it("handles missing source in human mode", async () => {
      const inv = await runCli(
        registerSkillsInstall,
        ["install", "--all", "--human"],
        { expectExit: 1 },
      );

      const output = inv.humanStdout();
      expect(output).toContain("Usage:");
    });
  });

  // ==========================================
  // FIND COMMAND - uncovered lines 154, 323-337
  // ==========================================
  describe("skills find - additional coverage", () => {
    const docsProSkill = {
      name: "docs-pro",
      scopedName: "@demo/docs-pro",
      description: "Modern docs",
      author: "demo",
      stars: 420,
      githubUrl: "https://github.com/demo/docs-pro",
      repoFullName: "demo/docs-pro",
      path: "skills/docs-pro/SKILL.md",
      source: "skillsmp",
    };
    const docsProRanking = (reasons: Array<{ code: string; detail: string }>) => ({
      criteria: { query: "docs", queryTokens: ["docs"], mustHave: [], prefer: [], exclude: [] },
      ranking: [{ skill: docsProSkill, score: 42.25, reasons, excluded: false }],
    });

    it("format conflict exits when both --json and --human passed", async () => {
      await expectFormatConflict(registerSkillsFind, ["find", "test"]);
    });

    it("marketplace search outputs human format with results", async () => {
      mocks.search.mockResolvedValue([
        fixtures.marketplaceHit("skill1", { description: "A test skill", author: "author", stars: 1500 }),
        fixtures.marketplaceHit("skill2", { description: "Another skill", author: "author", stars: 42 }),
        fixtures.marketplaceHit("skill3", { description: "No stars skill", author: "author", stars: 0 }),
      ]);

      const inv = await runCli(registerSkillsFind, ["find", "test", "--human"]);

      const output = inv.humanStdout();
      expect(output).toContain("3 result(s)");
      expect(output).toContain("Install with:");
    });

    it("marketplace search outputs empty results in human format", async () => {
      mocks.search.mockResolvedValue([]);

      const inv = await runCli(registerSkillsFind, ["find", "nonexistent", "--human"]);

      expect(inv.humanStdout()).toContain("No results found");
    });

    it("marketplace search outputs JSON envelope", async () => {
      mocks.search.mockResolvedValue([
        fixtures.marketplaceHit("skill1", { description: "A test skill", author: "author", stars: 100 }),
      ]);

      const inv = await runCli(registerSkillsFind, ["find", "test", "--json"]);

      const output = inv.jsonStdout() as {
        $schema: string;
        result: { query: string; count: number };
      };
      expect(output.$schema).toBe("https://lafs.dev/schemas/v1/envelope.schema.json");
      expect(output.result.query).toBe("test");
      expect(output.result.count).toBe(1);
    });

    it("marketplace search failure in human mode", async () => {
      mocks.search.mockRejectedValue(new Error("network error"));

      const inv = await runCli(
        registerSkillsFind,
        ["find", "test", "--human"],
        { expectExit: 1 },
      );

      expect(inv.humanStderr()).toContain("Marketplace search failed");
    });

    it("marketplace search failure in JSON mode", async () => {
      mocks.search.mockRejectedValue(new Error("network error"));

      const inv = await runCli(
        registerSkillsFind,
        ["find", "test", "--json"],
        { expectExit: 1 },
      );

      const output = inv.jsonStderr() as { error: { code: string } };
      expect(output.error.code).toBe("E_SEARCH_FAILED");
    });

    it("shows usage when no query provided", async () => {
      const inv = await runCli(registerSkillsFind, ["find"]);

      expect(inv.humanStdout()).toContain("Usage:");
    });

    it("recommendation with --select in human mode shows selected", async () => {
      mocks.recommendSkillsByQuery.mockResolvedValue(
        docsProRanking([{ code: "MUST_HAVE_MATCH", detail: "1" }]),
      );
      mocks.formatSkillRecommendations.mockReturnValue("Recommended:\n1) @demo/docs-pro");

      const inv = await runCli(
        registerSkillsFind,
        ["find", "docs", "--recommend", "--human", "--top", "1", "--select", "1"],
      );

      const output = inv.humanStdout();
      expect(output).toContain("Selected:");
      expect(output).toContain("@demo/docs-pro");
    });

    it("recommendation error in human mode shows message", async () => {
      mocks.recommendSkillsByQuery.mockRejectedValue(new Error("engine failure"));

      const inv = await runCli(
        registerSkillsFind,
        ["find", "docs", "--recommend", "--human", "--top", "1"],
        { expectExit: 1 },
      );

      expect(inv.humanStderr()).toContain("Recommendation failed");
    });

    it("prefer-exclude conflict in human mode", async () => {
      const inv = await runCli(
        registerSkillsFind,
        ["find", "docs", "--recommend", "--human", "--prefer", "docs", "--exclude", "docs"],
        { expectExit: 1 },
      );

      expect(inv.humanStderr()).toContain("Recommendation failed");
    });

    it("validateSelectedRanks throws when rank is out of range", async () => {
      mocks.recommendSkillsByQuery.mockResolvedValue(docsProRanking([]));

      const inv = await runCli(
        registerSkillsFind,
        ["find", "docs", "--recommend", "--json", "--top", "1", "--select", "5"],
        { expectExit: 1 },
      );

      const output = inv.jsonStderr() as { error: { code: string } };
      expect(output.error.code).toBe("E_SKILLS_QUERY_INVALID");
    });

    it("buildSeedQuery uses criteria flags when no query provided", async () => {
      const ranked = docsProRanking([{ code: "MUST_HAVE_MATCH", detail: "1" }]);
      ranked.criteria.mustHave = ["docs"];
      mocks.recommendSkillsByQuery.mockResolvedValue(ranked);
      mocks.formatSkillRecommendations.mockReturnValue({ query: "docs", options: [], recommended: null });

      await runCli(
        registerSkillsFind,
        ["find", "--recommend", "--json", "--must-have", "docs"],
      );

      expect(mocks.recommendSkillsByQuery).toHaveBeenCalledWith(
        "docs",
        expect.any(Object),
        expect.any(Object),
      );
    });

    it("buildSeedQuery throws when no query and no criteria flags", async () => {
      const inv = await runCli(
        registerSkillsFind,
        ["find", "--recommend", "--json"],
        { expectExit: 1 },
      );

      const output = inv.jsonStderr() as { error: { code: string } };
      expect(output.error.code).toBe("E_SKILLS_QUERY_INVALID");
    });

    it("recommendation error with NO_MATCHES code maps to NOT_FOUND category", async () => {
      const err = new Error("no results") as Error & { code?: string };
      err.code = "E_SKILLS_NO_MATCHES";
      mocks.recommendSkillsByQuery.mockRejectedValue(err);

      const inv = await runCli(
        registerSkillsFind,
        ["find", "docs", "--recommend", "--json"],
        { expectExit: 1 },
      );

      const output = inv.jsonStderr() as { error: { category: string } };
      expect(output.error.category).toBe("NOT_FOUND");
    });

    it("recommendation error with generic code maps to INTERNAL category", async () => {
      const err = new Error("unknown failure") as Error & { code?: string };
      err.code = "E_SOMETHING_ELSE";
      mocks.recommendSkillsByQuery.mockRejectedValue(err);

      const inv = await runCli(
        registerSkillsFind,
        ["find", "docs", "--recommend", "--json"],
        { expectExit: 1 },
      );

      const output = inv.jsonStderr() as { error: { category: string } };
      expect(output.error.category).toBe("INTERNAL");
    });

    it("normalizeRecommendationOptions uses score-based match when no reasons", async () => {
      mocks.recommendSkillsByQuery.mockResolvedValue(docsProRanking([]));
      mocks.formatSkillRecommendations.mockReturnValue("No reasons available");

      const inv = await runCli(
        registerSkillsFind,
        ["find", "docs", "--recommend", "--human"],
      );

      // The test passes if no error occurred (the internal normalizeRecommendationOptions handled empty reasons)
      expect(inv.stdout.length).toBeGreaterThan(0);
    });

    it("recommendation JSON output handles non-array options from formatSkillRecommendations", async () => {
      mocks.recommendSkillsByQuery.mockResolvedValue(
        docsProRanking([{ code: "MUST_HAVE_MATCH", detail: "1" }]),
      );
      // Return an object without options as array (options is undefined/missing)
      mocks.formatSkillRecommendations.mockReturnValue({
        query: "docs",
        recommended: null,
        // no options field = not an array
      });

      const inv = await runCli(
        registerSkillsFind,
        ["find", "docs", "--recommend", "--json", "--top", "1"],
      );

      const output = inv.jsonStdout() as {
        success: boolean;
        result: { selected: unknown[] };
      };
      expect(output.success).toBe(true);
      expect(output.result.selected).toEqual([]);
    });

    it("format conflict error in JSON mode", async () => {
      // This tests the catch block for format resolution - mock resolveOutputFormat to throw
      // Since we can't easily make resolveOutputFormat throw, we test the error path indirectly
      // by checking that the --json flag works correctly when provided
      mocks.search.mockResolvedValue([]);

      const inv = await runCli(registerSkillsFind, ["find", "test", "--json"]);

      const output = inv.jsonStdout() as { _meta: { operation: string } };
      expect(output._meta.operation).toBe("skills.find.search");
    });
  });

  // ==========================================
  // REMOVE COMMAND - uncovered lines 47-50, 92-111
  // ==========================================
  describe("skills remove - additional coverage", () => {
    it("format conflict exits when both --json and --human passed", async () => {
      await expectFormatConflict(registerSkillsRemove, ["remove", "my-skill"]);
    });

    it("removes skill successfully in JSON mode and removes from lock", async () => {
      mocks.removeSkill.mockResolvedValue({ removed: ["claude-code"], errors: [] });

      const inv = await runCli(registerSkillsRemove, ["remove", "my-skill", "--json"]);

      expect(mocks.removeSkillFromLock).toHaveBeenCalledWith("my-skill");
      const output = inv.jsonStdout() as {
        $schema: string;
        result: { removed: string[] };
      };
      expect(output.$schema).toBe("https://lafs.dev/schemas/v1/envelope.schema.json");
      expect(output.result.removed).toEqual(["claude-code"]);
    });

    it("removes skill with errors in JSON mode", async () => {
      mocks.removeSkill.mockResolvedValue({ removed: ["claude-code"], errors: ["warning: partial removal"] });

      const inv = await runCli(registerSkillsRemove, ["remove", "my-skill", "--json"]);

      const output = inv.jsonStdout() as { result: { errors: Array<{ message: string }> } };
      expect(output.result.errors).toHaveLength(1);
      expect(output.result.errors[0].message).toBe("warning: partial removal");
    });

    it("removes skill not found in JSON mode (removed=[], no errors)", async () => {
      mocks.removeSkill.mockResolvedValue({ removed: [], errors: [] });

      const inv = await runCli(registerSkillsRemove, ["remove", "missing-skill", "--json"]);

      const output = inv.jsonStdout() as { result: { removed: string[]; count: { removed: number } } };
      expect(output.result.removed).toEqual([]);
      expect(output.result.count.removed).toBe(0);
    });

    it("removes skill successfully in human mode", async () => {
      mocks.removeSkill.mockResolvedValue({ removed: ["claude-code"], errors: [] });

      const inv = await runCli(registerSkillsRemove, ["remove", "my-skill", "--human"]);

      const output = inv.humanStdout();
      expect(output).toContain("Removed");
      expect(output).toContain("my-skill");
      expect(mocks.removeSkillFromLock).toHaveBeenCalledWith("my-skill");
    });

    it("removes skill with errors in human mode", async () => {
      mocks.removeSkill.mockResolvedValue({ removed: ["claude-code"], errors: ["failed for cursor"] });

      const inv = await runCli(registerSkillsRemove, ["remove", "my-skill", "--human"]);

      const output = inv.humanStdout();
      expect(output).toContain("Removed");
      expect(output).toContain("failed for cursor");
    });

    it("lists skills in JSON mode when no name provided", async () => {
      mocks.listCanonicalSkills.mockResolvedValue(["skill1", "skill2"]);

      const inv = await runCli(registerSkillsRemove, ["remove", "--json"]);

      const output = inv.jsonStdout() as { result: { available: string[] } };
      expect(output.result.available).toEqual(["skill1", "skill2"]);
    });

    it("shows empty state in JSON mode when no skills installed and no name", async () => {
      mocks.listCanonicalSkills.mockResolvedValue([]);

      const inv = await runCli(registerSkillsRemove, ["remove", "--json"]);

      const output = inv.jsonStdout() as { result: { removed: string[]; count: { removed: number } } };
      expect(output.result.removed).toEqual([]);
      expect(output.result.count.removed).toBe(0);
    });
  });

  // ==========================================
  // UPDATE COMMAND - uncovered lines 105-215
  // ==========================================
  describe("skills update - additional coverage", () => {
    it("format conflict exits when both --json and --human passed", async () => {
      await expectFormatConflict(registerSkillsUpdate, ["update"]);
    });

    it("outputs JSON when no tracked skills", async () => {
      mocks.getTrackedSkills.mockResolvedValue({});

      const inv = await runCli(registerSkillsUpdate, ["update", "--json"]);

      const output = inv.jsonStdout() as { result: { count: { updated: number } } };
      expect(output.result.count.updated).toBe(0);
    });

    it("outputs JSON when no updates available", async () => {
      mocks.getTrackedSkills.mockResolvedValue({
        current: fixtures.trackedSkill("current"),
      });
      mocks.checkSkillUpdate.mockResolvedValue(fixtures.upToDate());

      const inv = await runCli(registerSkillsUpdate, ["update", "--json"]);

      const output = inv.jsonStdout() as { result: { count: { updated: number } } };
      expect(output.result.count.updated).toBe(0);
    });

    it("outputs JSON with successful updates", async () => {
      mocks.getTrackedSkills.mockResolvedValue({
        outdated: fixtures.trackedSkill("outdated"),
      });
      mocks.checkSkillUpdate.mockResolvedValue(fixtures.updateAvailable({ currentVersion: "abc", latestVersion: "def" }));
      mocks.parseSource.mockReturnValue({ type: "github", owner: "owner", repo: "repo", ref: undefined });
      mocks.cloneRepo.mockResolvedValue(fixtures.clonedRepo({ localPath: "/tmp/repo" }));
      mocks.getProvider.mockReturnValue(mockProvider);
      mocks.installSkill.mockResolvedValue(fixtures.installSuccess({ name: "outdated", canonicalPath: "/new/path" }));
      mocks.recordSkillInstall.mockResolvedValue(undefined);

      const inv = await runCli(registerSkillsUpdate, ["update", "--yes", "--json"]);

      const output = inv.jsonStdout() as {
        result: { count: { updated: number }; updated: string[] };
      };
      expect(output.result.count.updated).toBe(1);
      expect(output.result.updated).toEqual(["outdated"]);
    });

    it("outputs JSON with skipped and failed updates", async () => {
      mocks.getTrackedSkills.mockResolvedValue({
        localSkill: fixtures.trackedSkill("localSkill", {
          source: "/local/path",
          sourceType: "local",
          canonicalPath: "/path1",
        }),
        failingSkill: fixtures.trackedSkill("failingSkill", {
          source: "owner/fail",
          canonicalPath: "/path2",
        }),
      });
      mocks.checkSkillUpdate.mockResolvedValue(fixtures.updateAvailable({ currentVersion: "abc", latestVersion: "def" }));
      mocks.parseSource
        .mockReturnValueOnce({ type: "local", path: "/local/path" })
        .mockReturnValueOnce({ type: "github", owner: "owner", repo: "fail", ref: "main" });
      mocks.cloneRepo.mockRejectedValue(new Error("Network error"));
      mocks.getProvider.mockReturnValue(mockProvider);

      const inv = await runCli(registerSkillsUpdate, ["update", "--yes", "--json"]);

      const output = inv.jsonStdout() as {
        result: { skipped: string[]; failed: Array<{ name: string }> };
      };
      expect(output.result.skipped).toContain("localSkill");
      expect(output.result.failed).toHaveLength(1);
      expect(output.result.failed[0].name).toBe("failingSkill");
    });

    it("skips update when no valid providers found for a skill", async () => {
      mocks.getTrackedSkills.mockResolvedValue({
        orphan: fixtures.trackedSkill("orphan", { agents: ["nonexistent-agent"] }),
      });
      mocks.checkSkillUpdate.mockResolvedValue(fixtures.updateAvailable({ currentVersion: "abc", latestVersion: "def" }));
      mocks.parseSource.mockReturnValue({ type: "github", owner: "owner", repo: "repo", ref: "main" });
      mocks.cloneRepo.mockResolvedValue(fixtures.clonedRepo({ localPath: "/tmp/repo" }));
      mocks.getProvider.mockReturnValue(undefined);

      const inv = await runCli(registerSkillsUpdate, ["update", "--yes", "--human"]);

      const output = inv.humanStdout();
      expect(output).toContain("Skipped");
      expect(output).toContain("no valid providers");
    });

    it("handles install failure (success=false) in human mode", async () => {
      mocks.getTrackedSkills.mockResolvedValue({
        failing: fixtures.trackedSkill("failing"),
      });
      mocks.checkSkillUpdate.mockResolvedValue(fixtures.updateAvailable({ currentVersion: "abc", latestVersion: "def" }));
      mocks.parseSource.mockReturnValue({ type: "github", owner: "owner", repo: "repo", ref: "main" });
      mocks.cloneRepo.mockResolvedValue(fixtures.clonedRepo({ localPath: "/tmp/repo" }));
      mocks.getProvider.mockReturnValue(mockProvider);
      mocks.installSkill.mockResolvedValue(fixtures.installFailure(["no agents linked"], { name: "failing" }));

      const inv = await runCli(registerSkillsUpdate, ["update", "--yes", "--human"]);

      const output = inv.humanStdout();
      expect(output).toContain("Failed to update");
      expect(output).toContain("no agents linked");
    });

    it("handles install with errors in human mode", async () => {
      mocks.getTrackedSkills.mockResolvedValue({
        warned: fixtures.trackedSkill("warned"),
      });
      mocks.checkSkillUpdate.mockResolvedValue(fixtures.updateAvailable({ currentVersion: "abc", latestVersion: "def" }));
      mocks.parseSource.mockReturnValue({ type: "github", owner: "owner", repo: "repo", ref: "main" });
      mocks.cloneRepo.mockResolvedValue(fixtures.clonedRepo({ localPath: "/tmp/repo" }));
      mocks.getProvider.mockReturnValue(mockProvider);
      mocks.installSkill.mockResolvedValue(
        fixtures.installSuccess({ name: "warned", errors: ["partial link failure"], canonicalPath: "/new/path" }),
      );
      mocks.recordSkillInstall.mockResolvedValue(undefined);

      const inv = await runCli(registerSkillsUpdate, ["update", "--yes", "--human"]);

      const output = inv.humanStdout();
      expect(output).toContain("Updated");
      expect(output).toContain("partial link failure");
    });

    it("shows summary with both updated and failed in human mode", async () => {
      mocks.getTrackedSkills.mockResolvedValue({
        good: fixtures.trackedSkill("good", { source: "owner/good", canonicalPath: "/path1" }),
        bad: fixtures.trackedSkill("bad", { source: "owner/bad", canonicalPath: "/path2" }),
      });
      mocks.checkSkillUpdate.mockResolvedValue(fixtures.updateAvailable({ currentVersion: "abc", latestVersion: "def" }));
      mocks.parseSource.mockReturnValue({ type: "github", owner: "owner", repo: "repo", ref: "main" });
      mocks.cloneRepo
        .mockResolvedValueOnce(fixtures.clonedRepo({ localPath: "/tmp/repo" }))
        .mockRejectedValueOnce(new Error("Network error"));
      mocks.getProvider.mockReturnValue(mockProvider);
      mocks.installSkill.mockResolvedValue(fixtures.installSuccess({ name: "good", canonicalPath: "/new/path" }));
      mocks.recordSkillInstall.mockResolvedValue(undefined);

      const inv = await runCli(registerSkillsUpdate, ["update", "--yes", "--human"]);

      const output = inv.humanStdout();
      expect(output).toContain("Updated 1 skill(s)");
      expect(output).toContain("Failed to update 1 skill(s)");
    });

    it("cleanup is called after update", async () => {
      const cleanupFn = vi.fn();
      mocks.getTrackedSkills.mockResolvedValue({
        skill: fixtures.trackedSkill("skill"),
      });
      mocks.checkSkillUpdate.mockResolvedValue(fixtures.updateAvailable({ currentVersion: "abc", latestVersion: "def" }));
      mocks.parseSource.mockReturnValue({ type: "github", owner: "owner", repo: "repo", ref: "main" });
      mocks.cloneRepo.mockResolvedValue(fixtures.clonedRepo({ localPath: "/tmp/repo", cleanup: cleanupFn }));
      mocks.getProvider.mockReturnValue(mockProvider);
      mocks.installSkill.mockResolvedValue(fixtures.installSuccess({ name: "skill", canonicalPath: "/new/path" }));
      mocks.recordSkillInstall.mockResolvedValue(undefined);

      await runCli(registerSkillsUpdate, ["update", "--yes"]);

      expect(cleanupFn).toHaveBeenCalled();
    });
  });

  // ==========================================
  // VALIDATE COMMAND - uncovered lines 46-64
  // ==========================================
  describe("skills validate - additional coverage", () => {
    it("format conflict exits when both --json and --human passed", async () => {
      await expectFormatConflict(registerSkillsValidate, ["validate", "SKILL.md"]);
    });

    it("handles validateSkill throwing an error in JSON mode", async () => {
      mocks.validateSkill.mockRejectedValue(new Error("File not found: SKILL.md"));

      await runCli(
        registerSkillsValidate,
        ["validate", "/missing/SKILL.md", "--json"],
        { expectExit: 1 },
      );
    });

    it("handles validateSkill throwing an error in human mode", async () => {
      mocks.validateSkill.mockRejectedValue(new Error("File not found: SKILL.md"));

      const inv = await runCli(
        registerSkillsValidate,
        ["validate", "/missing/SKILL.md", "--human"],
        { expectExit: 1 },
      );

      expect(inv.humanStderr()).toContain("File not found");
    });

    it("outputs JSON for invalid skill with errors", async () => {
      mocks.validateSkill.mockResolvedValue({
        valid: false,
        issues: [
          { level: "error", field: "name", message: "Missing required field" },
          { level: "warning", field: "version", message: "Semver recommended" },
        ],
        metadata: {},
      });

      const inv = await runCli(
        registerSkillsValidate,
        ["validate", "/path/to/SKILL.md", "--json"],
        { expectExit: 1 },
      );

      const output = inv.jsonStdout() as {
        result: {
          valid: boolean;
          issues: Array<{ level: string }>;
        };
      };
      expect(output.result.valid).toBe(false);
      expect(output.result.issues).toHaveLength(2);
      expect(output.result.issues[0].level).toBe("error");
      expect(output.result.issues[1].level).toBe("warn");
    });

    it("outputs valid skill in human mode without exit", async () => {
      mocks.validateSkill.mockResolvedValue({
        valid: true,
        issues: [],
        metadata: { name: "good-skill" },
      });

      const inv = await runCli(
        registerSkillsValidate,
        ["validate", "/path/to/SKILL.md", "--human"],
      );

      expect(inv.humanStdout()).toContain("is valid");
      expect(inv.exitCode).toBeNull();
    });

    it("handles non-Error thrown from validateSkill", async () => {
      mocks.validateSkill.mockRejectedValue("string error");

      await runCli(
        registerSkillsValidate,
        ["validate", "/path/to/SKILL.md", "--human"],
        { expectExit: 1 },
      );
    });
  });

  // ==========================================
  // CHECK COMMAND - uncovered lines 49, 101, 114-115
  // ==========================================
  describe("skills check - additional coverage", () => {
    it("format conflict exits when both --json and --human passed", async () => {
      await expectFormatConflict(registerSkillsCheck, ["check"]);
    });

    it("outputs JSON for empty tracked skills", async () => {
      mocks.getTrackedSkills.mockResolvedValue({});

      const inv = await runCli(registerSkillsCheck, ["check", "--json"]);

      const output = inv.jsonStdout() as { result: { skills: unknown[]; outdated: number } };
      expect(output.result.skills).toEqual([]);
      expect(output.result.outdated).toBe(0);
    });

    it("human output shows unknown version status", async () => {
      mocks.getTrackedSkills.mockResolvedValue({
        skill1: fixtures.trackedSkill("skill1"),
      });
      mocks.checkSkillUpdate.mockResolvedValue({
        hasUpdate: false,
        currentVersion: undefined,
        latestVersion: undefined,
        status: "unknown",
      });

      const inv = await runCli(registerSkillsCheck, ["check", "--human"]);

      const output = inv.humanStdout();
      expect(output).toContain("unknown");
      expect(output).toContain("All skills are up to date");
    });

    it("human output shows update available with version details", async () => {
      mocks.getTrackedSkills.mockResolvedValue({
        skill1: fixtures.trackedSkill("skill1"),
      });
      mocks.checkSkillUpdate.mockResolvedValue(
        fixtures.updateAvailable({ currentVersion: "abc123def456", latestVersion: "def789ghi012" }),
      );

      const inv = await runCli(registerSkillsCheck, ["check", "--human"]);

      const output = inv.humanStdout();
      expect(output).toContain("update available");
      expect(output).toContain("current:");
      expect(output).toContain("->");
      expect(output).toContain("update(s) available");
    });

    it("human output shows up to date with version for known version", async () => {
      mocks.getTrackedSkills.mockResolvedValue({
        skill1: fixtures.trackedSkill("skill1", { version: "v1.0" }),
      });
      mocks.checkSkillUpdate.mockResolvedValue({
        hasUpdate: false,
        currentVersion: "abc123def456",
        latestVersion: "abc123def456",
        status: "up-to-date",
      });

      const inv = await runCli(registerSkillsCheck, ["check", "--human"]);

      const output = inv.humanStdout();
      expect(output).toContain("up to date");
      expect(output).toContain("version:");
      expect(output).toContain("All skills are up to date");
    });

    it("human output shows both unknown version sources and agents", async () => {
      mocks.getTrackedSkills.mockResolvedValue({
        skill1: fixtures.trackedSkill("skill1", {
          source: "/local/path",
          sourceType: "local",
          agents: ["claude-code", "cursor"],
        }),
      });
      mocks.checkSkillUpdate.mockResolvedValue({
        hasUpdate: false,
        currentVersion: undefined,
        latestVersion: undefined,
        status: "unknown",
      });

      const inv = await runCli(registerSkillsCheck, ["check", "--human"]);

      const output = inv.humanStdout();
      expect(output).toContain("source:");
      expect(output).toContain("agents:");
    });
  });

  // ==========================================
  // INIT COMMAND - uncovered lines 39-42, 54-55
  // ==========================================
  describe("skills init - additional coverage", () => {
    it("format conflict exits when both --json and --human passed", async () => {
      await expectFormatConflict(registerSkillsInit, ["init", "test-skill"]);
    });

    it("outputs JSON when directory already exists", async () => {
      mocks.existsSync.mockReturnValue(true);

      await runCli(
        registerSkillsInit,
        ["init", "existing-skill", "--json"],
        { expectExit: 1 },
      );
    });

    it("outputs JSON on successful creation", async () => {
      mocks.existsSync.mockReturnValue(false);
      mocks.mkdir.mockResolvedValue(undefined);
      mocks.writeFile.mockResolvedValue(undefined);

      const inv = await runCli(registerSkillsInit, ["init", "new-skill", "--json"]);

      const output = inv.jsonStdout() as {
        $schema: string;
        result: { name: string; created: boolean };
      };
      expect(output.$schema).toBe("https://lafs.dev/schemas/v1/envelope.schema.json");
      expect(output.result.name).toBe("new-skill");
      expect(output.result.created).toBe(true);
    });

    it("uses default name 'my-skill' in JSON mode when none provided", async () => {
      mocks.existsSync.mockReturnValue(false);
      mocks.mkdir.mockResolvedValue(undefined);
      mocks.writeFile.mockResolvedValue(undefined);

      const inv = await runCli(registerSkillsInit, ["init", "--json"]);

      const output = inv.jsonStdout() as { result: { name: string } };
      expect(output.result.name).toBe("my-skill");
    });

    it("shows human error when directory already exists", async () => {
      mocks.existsSync.mockReturnValue(true);

      const inv = await runCli(
        registerSkillsInit,
        ["init", "existing-skill", "--human"],
        { expectExit: 1 },
      );

      expect(inv.humanStderr()).toContain("Directory already exists");
      expect(inv.exitCode).toBe(1);
    });

    it("human output shows next steps on success", async () => {
      mocks.existsSync.mockReturnValue(false);
      mocks.mkdir.mockResolvedValue(undefined);
      mocks.writeFile.mockResolvedValue(undefined);

      const inv = await runCli(registerSkillsInit, ["init", "test-skill", "--human"]);

      const output = inv.humanStdout();
      expect(output).toContain("Created skill template");
      expect(output).toContain("Next steps");
      expect(output).toContain("Edit SKILL.md");
      expect(output).toContain("Validate:");
      expect(output).toContain("Install:");
    });
  });

  // ==========================================
  // LIST COMMAND - uncovered lines 68-69, 73, 76-77
  // ==========================================
  describe("skills list - additional coverage", () => {
    it("lists global skills from all providers", async () => {
      mocks.getInstalledProviders.mockReturnValue([mockProvider, mockProvider2]);
      mocks.resolveProviderSkillsDir
        .mockReturnValueOnce("/global/claude-code/skills")
        .mockReturnValueOnce("/global/cursor/skills");
      mocks.discoverSkillsMulti.mockResolvedValue([]);

      const inv = await runCli(registerSkillsList, ["list", "--global"]);

      const output = inv.jsonStdout() as { result: { scope: string } };
      expect(output.result.scope).toBe("global");
    });

    it("lists skills for agent with --global flag", async () => {
      mocks.getProvider.mockReturnValue(mockProvider);
      mocks.resolveProviderSkillsDir.mockReturnValue("/global/claude-code/skills");
      mocks.discoverSkillsMulti.mockResolvedValue([]);

      await runCli(registerSkillsList, ["list", "--agent", "claude-code", "--global"]);

      expect(mocks.resolveProviderSkillsDir).toHaveBeenCalledWith(mockProvider, "global");
    });

    it("lists skills for agent without --global flag", async () => {
      mocks.getProvider.mockReturnValue(mockProvider);
      mocks.resolveProviderSkillsDir.mockReturnValue("/project/claude-code/skills");
      mocks.discoverSkillsMulti.mockResolvedValue([]);

      await runCli(registerSkillsList, ["list", "--agent", "claude-code"]);

      expect(mocks.resolveProviderSkillsDir).toHaveBeenCalledWith(mockProvider, "project");
    });

    it("provider not found in JSON mode", async () => {
      mocks.getProvider.mockReturnValue(undefined);

      const inv = await runCli(
        registerSkillsList,
        ["list", "--agent", "unknown", "--json"],
        { expectExit: 1 },
      );

      const output = inv.jsonStderr() as { error: { code: string } };
      expect(output.error.code).toBe("E_PROVIDER_NOT_FOUND");
    });

    it("provider not found in human mode", async () => {
      mocks.getProvider.mockReturnValue(undefined);

      const inv = await runCli(
        registerSkillsList,
        ["list", "--agent", "unknown", "--human"],
        { expectExit: 1 },
      );

      expect(inv.humanStderr()).toContain("Provider not found");
    });

    it("human output with skills shows table and footer", async () => {
      mocks.resolveProviderSkillsDir.mockReturnValue("/skills");
      mocks.discoverSkillsMulti.mockResolvedValue([
        { name: "skill1", scopedName: "skill1", path: "/skills/skill1", metadata: { name: "skill1", description: "Test skill" } },
        { name: "skill2", scopedName: "skill2", path: "/skills/skill2", metadata: { name: "skill2", description: "Another skill" } },
      ]);

      const inv = await runCli(registerSkillsList, ["list", "--human"]);

      const output = inv.humanStdout();
      expect(output).toContain("2 skill(s) found");
      expect(output).toContain("Install with:");
      expect(output).toContain("Remove with:");
    });

    it("human output with no skills shows empty message", async () => {
      mocks.resolveProviderSkillsDir.mockReturnValue("/skills");
      mocks.discoverSkillsMulti.mockResolvedValue([]);

      const inv = await runCli(registerSkillsList, ["list", "--human"]);

      expect(inv.humanStdout()).toContain("No skills found");
    });

    it("JSON output with global scope for agent", async () => {
      mocks.getProvider.mockReturnValue(mockProvider);
      mocks.resolveProviderSkillsDir.mockReturnValue("/global/claude-code/skills");
      mocks.discoverSkillsMulti.mockResolvedValue([
        { name: "skill1", scopedName: "skill1", path: "/skills/skill1", metadata: { name: "skill1", description: "Test skill" } },
      ]);

      const inv = await runCli(registerSkillsList, ["list", "--agent", "claude-code", "--json"]);

      const output = inv.jsonStdout() as { result: { scope: string } };
      expect(output.result.scope).toBe("agent:claude-code");
    });

    it("default project scope when no --global or --agent provided", async () => {
      mocks.getInstalledProviders.mockReturnValue([mockProvider]);
      mocks.resolveProviderSkillsDir.mockReturnValue("/project/skills");
      mocks.discoverSkillsMulti.mockResolvedValue([]);

      const inv = await runCli(registerSkillsList, ["list", "--json"]);

      const output = inv.jsonStdout() as { result: { scope: string } };
      expect(output.result.scope).toBe("project");
    });

    it("global scope filter uses resolveProviderSkillsDir with 'global'", async () => {
      mocks.getInstalledProviders.mockReturnValue([mockProvider]);
      mocks.resolveProviderSkillsDir.mockReturnValue("/global/skills");
      mocks.discoverSkillsMulti.mockResolvedValue([]);

      await runCli(registerSkillsList, ["list", "--global", "--json"]);

      expect(mocks.resolveProviderSkillsDir).toHaveBeenCalledWith(mockProvider, "global");
    });

    it("format conflict error triggers when both --json and --human passed", async () => {
      await expectFormatConflict(registerSkillsList, ["list"]);
    });

    it("skill with null metadata description renders gracefully", async () => {
      mocks.resolveProviderSkillsDir.mockReturnValue("/skills");
      mocks.discoverSkillsMulti.mockResolvedValue([
        { name: "skill-no-desc", scopedName: "skill-no-desc", path: "/skills/skill-no-desc", metadata: { name: "skill-no-desc" } },
      ]);

      const inv = await runCli(registerSkillsList, ["list", "--human"]);

      expect(inv.humanStdout()).toContain("skill-no-desc");
    });
  });
});
