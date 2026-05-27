/**
 * Tests for the update command's readline confirmation prompt.
 * Requires mocking node:readline at the module level.
 */

import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTrackedSkills: vi.fn(),
  checkSkillUpdate: vi.fn(),
  getProvider: vi.fn(),
  installSkill: vi.fn(),
  recordSkillInstall: vi.fn(),
  parseSource: vi.fn(),
  cloneRepo: vi.fn(),
  cloneGitLabRepo: vi.fn(),
  createInterface: vi.fn(),
}));

vi.mock("../../src/core/skills/lock.js", () => ({
  getTrackedSkills: mocks.getTrackedSkills,
  checkSkillUpdate: mocks.checkSkillUpdate,
  recordSkillInstall: mocks.recordSkillInstall,
}));

vi.mock("../../src/core/registry/providers.js", () => ({
  getProvider: mocks.getProvider,
}));

vi.mock("../../src/core/skills/installer.js", () => ({
  installSkill: mocks.installSkill,
}));

vi.mock("../../src/core/sources/parser.js", () => ({
  parseSource: mocks.parseSource,
}));

vi.mock("../../src/core/sources/github.js", () => ({
  cloneRepo: mocks.cloneRepo,
}));

vi.mock("../../src/core/sources/gitlab.js", () => ({
  cloneGitLabRepo: mocks.cloneGitLabRepo,
}));

vi.mock("node:readline", () => ({
  createInterface: mocks.createInterface,
}));

import { registerSkillsUpdate } from "../../src/commands/skills/update.js";

describe("skills update - readline confirmation", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.values(mocks).forEach((mock) => mock?.mockReset?.());
  });

  it("cancels update when user declines confirmation", async () => {
    mocks.getTrackedSkills.mockResolvedValue({
      skill: {
        name: "skill",
        scopedName: "skill",
        source: "owner/repo",
        sourceType: "github",
        agents: ["claude-code"],
        canonicalPath: "/path",
        isGlobal: true,
        installedAt: "2026-01-01T00:00:00Z",
      },
    });
    mocks.checkSkillUpdate.mockResolvedValue({
      hasUpdate: true,
      currentVersion: "abc",
      latestVersion: "def",
      status: "update-available",
    });

    const mockRl = {
      question: vi.fn((_prompt: string, cb: (answer: string) => void) => cb("n")),
      close: vi.fn(),
    };
    mocks.createInterface.mockReturnValue(mockRl);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerSkillsUpdate(program);

    await program.parseAsync(["node", "test", "update", "--human"]);

    const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
    expect(output).toContain("Update cancelled");
    expect(mockRl.close).toHaveBeenCalled();
    // Should not have proceeded to clone
    expect(mocks.cloneRepo).not.toHaveBeenCalled();
  });

  it("proceeds with update when user confirms", async () => {
    mocks.getTrackedSkills.mockResolvedValue({
      skill: {
        name: "skill",
        scopedName: "skill",
        source: "owner/repo",
        sourceType: "github",
        agents: ["claude-code"],
        canonicalPath: "/path",
        isGlobal: true,
        installedAt: "2026-01-01T00:00:00Z",
      },
    });
    mocks.checkSkillUpdate.mockResolvedValue({
      hasUpdate: true,
      currentVersion: "abc",
      latestVersion: "def",
      status: "update-available",
    });
    mocks.parseSource.mockReturnValue({ type: "github", owner: "owner", repo: "repo", ref: "main" });
    mocks.cloneRepo.mockResolvedValue({ localPath: "/tmp/repo", cleanup: async () => {} });
    mocks.getProvider.mockReturnValue({ id: "claude-code", toolName: "Claude Code" });
    mocks.installSkill.mockResolvedValue({ success: true, linkedAgents: ["claude-code"], errors: [], canonicalPath: "/new/path" });
    mocks.recordSkillInstall.mockResolvedValue(undefined);

    const mockRl = {
      question: vi.fn((_prompt: string, cb: (answer: string) => void) => cb("y")),
      close: vi.fn(),
    };
    mocks.createInterface.mockReturnValue(mockRl);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerSkillsUpdate(program);

    await program.parseAsync(["node", "test", "update", "--human"]);

    expect(mocks.cloneRepo).toHaveBeenCalled();
    expect(mocks.installSkill).toHaveBeenCalled();
    const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
    expect(output).toContain("Updated");
  });

  it("proceeds with update when user confirms with 'yes'", async () => {
    mocks.getTrackedSkills.mockResolvedValue({
      skill: {
        name: "skill",
        scopedName: "skill",
        source: "owner/repo",
        sourceType: "github",
        agents: ["claude-code"],
        canonicalPath: "/path",
        isGlobal: true,
        installedAt: "2026-01-01T00:00:00Z",
      },
    });
    mocks.checkSkillUpdate.mockResolvedValue({
      hasUpdate: true,
      currentVersion: "abc",
      latestVersion: "def",
      status: "update-available",
    });
    mocks.parseSource.mockReturnValue({ type: "github", owner: "owner", repo: "repo", ref: "main" });
    mocks.cloneRepo.mockResolvedValue({ localPath: "/tmp/repo", cleanup: async () => {} });
    mocks.getProvider.mockReturnValue({ id: "claude-code", toolName: "Claude Code" });
    mocks.installSkill.mockResolvedValue({ success: true, linkedAgents: ["claude-code"], errors: [], canonicalPath: "/new/path" });
    mocks.recordSkillInstall.mockResolvedValue(undefined);

    const mockRl = {
      question: vi.fn((_prompt: string, cb: (answer: string) => void) => cb("yes")),
      close: vi.fn(),
    };
    mocks.createInterface.mockReturnValue(mockRl);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerSkillsUpdate(program);

    await program.parseAsync(["node", "test", "update", "--human"]);

    expect(mocks.cloneRepo).toHaveBeenCalled();
  });
});
