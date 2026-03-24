import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  parseSource: vi.fn(),
  isMarketplaceScoped: vi.fn(),
  installSkill: vi.fn(),
  recordSkillInstall: vi.fn(),
  getInstalledProviders: vi.fn(),
  getProvider: vi.fn(),
  cloneRepo: vi.fn(),
  cloneGitLabRepo: vi.fn(),
  marketplaceGetSkill: vi.fn(),
  formatNetworkError: vi.fn(),
  existsSync: vi.fn(),
  isCatalogAvailable: vi.fn(),
  resolveProfile: vi.fn(),
  getSkillDir: vi.fn(),
  listProfiles: vi.fn(),
  getSkill: vi.fn(),
  listSkills: vi.fn(),
  discoverSkill: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: mocks.existsSync,
}));

vi.mock("../../src/core/sources/parser.js", () => ({
  parseSource: mocks.parseSource,
  isMarketplaceScoped: mocks.isMarketplaceScoped,
}));

vi.mock("../../src/core/skills/installer.js", () => ({
  installSkill: mocks.installSkill,
}));

vi.mock("../../src/core/skills/lock.js", () => ({
  recordSkillInstall: mocks.recordSkillInstall,
}));

vi.mock("../../src/core/registry/detection.js", () => ({
  getInstalledProviders: mocks.getInstalledProviders,
}));

vi.mock("../../src/core/registry/providers.js", () => ({
  getProvider: mocks.getProvider,
}));

vi.mock("../../src/core/sources/github.js", () => ({
  cloneRepo: mocks.cloneRepo,
}));

vi.mock("../../src/core/sources/gitlab.js", () => ({
  cloneGitLabRepo: mocks.cloneGitLabRepo,
}));

vi.mock("../../src/core/network/fetch.js", () => ({
  formatNetworkError: mocks.formatNetworkError,
}));

vi.mock("../../src/core/marketplace/client.js", () => ({
  MarketplaceClient: class {
    getSkill = mocks.marketplaceGetSkill;
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

vi.mock("../../src/core/skills/discovery.js", () => ({
  discoverSkill: mocks.discoverSkill,
}));

import { registerSkillsInstall } from "../../src/commands/skills/install.js";

const provider = {
  id: "claude-code",
  toolName: "Claude Code",
};

describe("integration: skills install command", () => {
  beforeEach(() => {
    mocks.parseSource.mockReset();
    mocks.isMarketplaceScoped.mockReset();
    mocks.installSkill.mockReset();
    mocks.recordSkillInstall.mockReset();
    mocks.getInstalledProviders.mockReset();
    mocks.getProvider.mockReset();
    mocks.cloneRepo.mockReset();
    mocks.cloneGitLabRepo.mockReset();
    mocks.marketplaceGetSkill.mockReset();
    mocks.formatNetworkError.mockReset();
    mocks.existsSync.mockReset();
    mocks.isCatalogAvailable.mockReset();
    mocks.resolveProfile.mockReset();
    mocks.getSkillDir.mockReset();
    mocks.listProfiles.mockReset();
    mocks.getSkill.mockReset();
    mocks.listSkills.mockReset();
    mocks.discoverSkill.mockReset();

    mocks.isMarketplaceScoped.mockReturnValue(false);
    mocks.isCatalogAvailable.mockReturnValue(false);
    mocks.discoverSkill.mockResolvedValue({ name: "discovered-name" });
    mocks.listSkills.mockReturnValue([]);
    mocks.parseSource.mockReturnValue({ type: "local", inferredName: "demo", value: "/tmp/demo" });
    mocks.getInstalledProviders.mockReturnValue([provider]);
    mocks.installSkill.mockResolvedValue({
      success: true,
      canonicalPath: "/tmp/canonical/demo",
      linkedAgents: ["claude-code"],
      errors: [],
    });
    mocks.recordSkillInstall.mockResolvedValue(undefined);
    mocks.cloneRepo.mockResolvedValue({ localPath: "/tmp/repo", cleanup: async () => {} });
    mocks.cloneGitLabRepo.mockResolvedValue({ localPath: "/tmp/repo", cleanup: async () => {} });
    mocks.formatNetworkError.mockReturnValue("network failed");
    mocks.existsSync.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("installs local source and records lock entry", async () => {
    const program = new Command();
    registerSkillsInstall(program);

    await program.parseAsync(["node", "test", "install", "./skill", "--all"]);

    expect(mocks.installSkill).toHaveBeenCalled();
    expect(mocks.recordSkillInstall).toHaveBeenCalled();
  });

  it("installs marketplace scoped source via GitHub clone", async () => {
    mocks.isMarketplaceScoped.mockReturnValue(true);
    mocks.marketplaceGetSkill.mockResolvedValue({
      name: "demo",
      author: "alice",
      repoFullName: "alice/demo",
      githubUrl: "https://github.com/alice/demo",
      path: "skills/demo/SKILL.md",
    });
    mocks.parseSource.mockReturnValueOnce({ type: "github", owner: "alice", repo: "demo", ref: "main" });

    const program = new Command();
    registerSkillsInstall(program);

    await program.parseAsync(["node", "test", "install", "@alice/demo", "--all"]);

    expect(mocks.cloneRepo).toHaveBeenCalled();
    expect(mocks.installSkill).toHaveBeenCalled();
  });

  it("falls back to parsed GitHub path when marketplace path is incomplete", async () => {
    mocks.isMarketplaceScoped.mockReturnValue(true);
    mocks.marketplaceGetSkill.mockResolvedValue({
      name: "demo",
      author: "alice",
      repoFullName: "alice/demo",
      githubUrl: "https://github.com/alice/demo/tree/main/.claude/skills/demo",
      path: "skills/demo/SKILL.md",
    });
    mocks.parseSource.mockReturnValueOnce({
      type: "github",
      owner: "alice",
      repo: "demo",
      ref: "main",
      path: ".claude/skills/demo",
    });
    mocks.cloneRepo
      .mockResolvedValueOnce({ localPath: "/tmp/repo/skills/demo", cleanup: async () => {} })
      .mockResolvedValueOnce({ localPath: "/tmp/repo/.claude/skills/demo", cleanup: async () => {} });
    mocks.existsSync
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    const program = new Command();
    registerSkillsInstall(program);

    await program.parseAsync(["node", "test", "install", "@alice/demo", "--all"]);

    expect(mocks.cloneRepo).toHaveBeenNthCalledWith(1, "alice", "demo", "main", "skills/demo");
    expect(mocks.cloneRepo).toHaveBeenNthCalledWith(2, "alice", "demo", "main", ".claude/skills/demo");
    expect(mocks.installSkill).toHaveBeenCalled();
  });

  it("exits when no providers are available", async () => {
    mocks.getInstalledProviders.mockReturnValue([]);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process-exit");
    }) as never);

    const program = new Command();
    registerSkillsInstall(program);

    await expect(program.parseAsync(["node", "test", "install", "./skill", "--all"])).rejects.toThrow("process-exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("installs skill from --profile flag", async () => {
    mocks.isCatalogAvailable.mockReturnValue(true);
    mocks.resolveProfile.mockReturnValue(["skill1", "skill2"]);
    mocks.getSkillDir.mockImplementation((name: string) => `/tmp/${name}`);

    const program = new Command();
    registerSkillsInstall(program);

    await program.parseAsync(["node", "test", "install", "--profile", "core", "--all"]);

    expect(mocks.installSkill).toHaveBeenCalledTimes(2);
    expect(mocks.installSkill).toHaveBeenCalledWith("/tmp/skill1", "skill1", [provider], false);
    expect(mocks.installSkill).toHaveBeenCalledWith("/tmp/skill2", "skill2", [provider], false);
    expect(mocks.recordSkillInstall).toHaveBeenCalledTimes(2);
  });

  it("exits when profile not found", async () => {
    mocks.isCatalogAvailable.mockReturnValue(true);
    mocks.resolveProfile.mockReturnValue([]);
    mocks.listProfiles.mockReturnValue(["minimal", "core"]);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process-exit");
    }) as never);

    const program = new Command();
    registerSkillsInstall(program);

    await expect(
      program.parseAsync(["node", "test", "install", "--profile", "unknown", "--all"]),
    ).rejects.toThrow("process-exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits when catalog not available for --profile", async () => {
    mocks.isCatalogAvailable.mockReturnValue(false);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process-exit");
    }) as never);

    const program = new Command();
    registerSkillsInstall(program);

    await expect(
      program.parseAsync(["node", "test", "install", "--profile", "core", "--all"]),
    ).rejects.toThrow("process-exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits when source is missing and no profile", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process-exit");
    }) as never);

    const program = new Command();
    registerSkillsInstall(program);

    await expect(
      program.parseAsync(["node", "test", "install", "--all"]),
    ).rejects.toThrow("process-exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("installs GitHub source", async () => {
    mocks.parseSource.mockReturnValue({
      type: "github",
      owner: "org",
      repo: "skill",
      ref: "main",
      inferredName: "skill",
      value: "org/skill",
    });

    const program = new Command();
    registerSkillsInstall(program);

    await program.parseAsync(["node", "test", "install", "org/skill", "--all"]);

    expect(mocks.cloneRepo).toHaveBeenCalledWith("org", "skill", "main", undefined);
    expect(mocks.installSkill).toHaveBeenCalled();
    expect(mocks.recordSkillInstall).toHaveBeenCalled();
  });

  it("installs GitLab source", async () => {
    mocks.parseSource.mockReturnValue({
      type: "gitlab",
      owner: "group",
      repo: "skill",
      ref: "main",
      inferredName: "skill",
      value: "gitlab.com/group/skill",
    });

    const program = new Command();
    registerSkillsInstall(program);

    await program.parseAsync(["node", "test", "install", "gitlab.com/group/skill", "--all"]);

    expect(mocks.cloneGitLabRepo).toHaveBeenCalledWith("group", "skill", "main", undefined);
    expect(mocks.installSkill).toHaveBeenCalled();
    expect(mocks.recordSkillInstall).toHaveBeenCalled();
  });

  it("installs from registered library (package/library type)", async () => {
    mocks.parseSource.mockReturnValue({
      type: "package",
      inferredName: "ct-test",
      value: "ct-test",
    });
    mocks.isCatalogAvailable.mockReturnValue(true);
    mocks.getSkill.mockReturnValue({
      name: "ct-test",
      version: "1.0.0",
      category: "test",
      core: false,
      description: "test",
    });
    mocks.getSkillDir.mockReturnValue("/tmp/ct-test");

    const program = new Command();
    registerSkillsInstall(program);

    await program.parseAsync(["node", "test", "install", "ct-test", "--all"]);

    expect(mocks.installSkill).toHaveBeenCalledWith("/tmp/ct-test", "ct-test", [provider], false);
    expect(mocks.recordSkillInstall).toHaveBeenCalledWith(
      "ct-test",
      "library:ct-test",
      "library:ct-test",
      "library",
      ["claude-code"],
      "/tmp/canonical/demo",
      true,
    );
  });

  it("shows warnings when install has errors", async () => {
    mocks.installSkill.mockResolvedValue({
      success: true,
      canonicalPath: "/tmp/demo",
      linkedAgents: ["claude-code"],
      errors: ["provider x: link failed"],
    });

    const consoleSpy = vi.spyOn(console, "log");

    const program = new Command();
    registerSkillsInstall(program);

    await program.parseAsync(["node", "test", "install", "./skill", "--all", "--human"]);

    const output = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("Warnings");
    expect(output).toContain("provider x: link failed");
  });

  it("handles profile with failed skills gracefully", async () => {
    mocks.isCatalogAvailable.mockReturnValue(true);
    mocks.resolveProfile.mockReturnValue(["good-skill", "bad-skill"]);
    mocks.getSkillDir.mockImplementation((name: string) => `/tmp/${name}`);
    mocks.installSkill
      .mockResolvedValueOnce({
        success: true,
        canonicalPath: "/tmp/good-skill",
        linkedAgents: ["claude-code"],
        errors: [],
      })
      .mockRejectedValueOnce(new Error("install exploded"));

    // In JSON mode (default), profile failures output error envelope to stderr
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process-exit");
    }) as never);

    const program = new Command();
    registerSkillsInstall(program);

    await expect(
      program.parseAsync(["node", "test", "install", "--profile", "core", "--all"]),
    ).rejects.toThrow("process-exit");

    // Verify the error envelope contains the summary with 1 installed and 1 failed
    const output = String(errorSpy.mock.calls[0]?.[0] ?? "{}");
    const envelope = JSON.parse(output);
    expect(envelope.result.count.installed).toBe(1);
    expect(envelope.result.count.failed).toBe(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
