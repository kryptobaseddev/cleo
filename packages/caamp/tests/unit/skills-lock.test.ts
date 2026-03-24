import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readLockFile: vi.fn(),
  writeLockFile: vi.fn(),
  updateLockFile: vi.fn(),
  simpleGit: vi.fn(),
  parseSource: vi.fn(),
  existsSync: vi.fn(),
  mkdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  open: vi.fn(),
  rm: vi.fn(),
  rename: vi.fn(),
  execFileAsync: vi.fn(),
}));

vi.mock("../../src/core/lock-utils.js", () => ({
  readLockFile: mocks.readLockFile,
  writeLockFile: mocks.writeLockFile,
  updateLockFile: mocks.updateLockFile,
}));

vi.mock("simple-git", () => ({
  simpleGit: mocks.simpleGit,
}));

vi.mock("../../src/core/sources/parser.js", () => ({
  parseSource: mocks.parseSource,
}));

vi.mock("node:fs", () => ({
  existsSync: mocks.existsSync,
}));

vi.mock("node:fs/promises", () => ({
  mkdir: mocks.mkdir,
  readFile: mocks.readFile,
  writeFile: mocks.writeFile,
  open: mocks.open,
  rm: mocks.rm,
  rename: mocks.rename,
}));

vi.mock("node:child_process", () => ({
  // execFile needs to be a function that, when promisified, returns execFileAsync.
  // promisify calls the function with (...args, callback), so we create a wrapper.
  execFile: (...args: unknown[]) => {
    const callback = args[args.length - 1] as (err: Error | null, result?: { stdout: string }) => void;
    mocks.execFileAsync(args[0], args[1])
      .then((result: { stdout: string }) => callback(null, result))
      .catch((err: Error) => callback(err));
  },
}));

import {
  checkAllSkillUpdates,
  checkSkillUpdate,
  getTrackedSkills,
  recordSkillInstall,
  removeSkillFromLock,
} from "../../src/core/skills/lock.js";
import type { CaampLockFile, LockEntry } from "../../src/types.js";

const mockLockFile = (overrides: Partial<CaampLockFile> = {}): CaampLockFile => ({
  version: 1,
  skills: {},
  mcpServers: {},
  ...overrides,
});

const mockSkillEntry = (overrides: Partial<LockEntry> = {}): LockEntry => ({
  name: "test-skill",
  scopedName: "test-skill",
  source: "https://github.com/owner/repo",
  sourceType: "github",
  version: "abc123def456",
  installedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  agents: ["claude-code"],
  canonicalPath: "/path/to/test-skill",
  isGlobal: true,
  ...overrides,
});

describe("skills lock", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.values(mocks).forEach((mock) => mock?.mockReset?.());
  });

  describe("recordSkillInstall", () => {
    it("creates new skill entry in lock file", async () => {
      const lock = mockLockFile();
      mocks.updateLockFile.mockImplementation(async (updater) => {
        await updater(lock);
        return lock;
      });

      await recordSkillInstall(
        "my-skill",
        "my-skill",
        "owner/repo",
        "github",
        ["claude-code"],
        "/path/to/skill",
        true,
      );

      expect(lock.skills["my-skill"]).toBeDefined();
      expect(lock.skills["my-skill"]?.name).toBe("my-skill");
      expect(lock.skills["my-skill"]?.agents).toEqual(["claude-code"]);
      expect(lock.skills["my-skill"]?.isGlobal).toBe(true);
    });

    it("updates existing skill entry", async () => {
      const existingEntry = mockSkillEntry({
        name: "existing-skill",
        agents: ["claude-code"],
        installedAt: "2026-01-01T00:00:00.000Z",
      });
      const lock = mockLockFile({
        skills: { "existing-skill": existingEntry },
      });

      mocks.updateLockFile.mockImplementation(async (updater) => {
        await updater(lock);
        return lock;
      });

      await recordSkillInstall(
        "existing-skill",
        "existing-skill",
        "owner/repo",
        "github",
        ["cursor"],
        "/new/path",
        false,
        "/project",
        "def789",
      );

      expect(lock.skills["existing-skill"]?.agents).toEqual(["claude-code", "cursor"]);
      expect(lock.skills["existing-skill"]?.isGlobal).toBe(true); // Preserved from existing
      expect(lock.skills["existing-skill"]?.installedAt).toBe("2026-01-01T00:00:00.000Z");
      expect(lock.skills["existing-skill"]?.version).toBe("def789");
    });

    it("merges agents without duplicates", async () => {
      const existingEntry = mockSkillEntry({
        name: "my-skill",
        agents: ["claude-code", "cursor"],
      });
      const lock = mockLockFile({ skills: { "my-skill": existingEntry } });

      mocks.updateLockFile.mockImplementation(async (updater) => {
        await updater(lock);
        return lock;
      });

      await recordSkillInstall(
        "my-skill",
        "my-skill",
        "owner/repo",
        "github",
        ["cursor", "windsurf"],
        "/path",
        true,
      );

      expect(lock.skills["my-skill"]?.agents).toEqual(["claude-code", "cursor", "windsurf"]);
    });

    it("preserves existing source if not provided", async () => {
      const existingEntry = mockSkillEntry({
        name: "my-skill",
        source: "original/source",
        sourceType: "github",
      });
      const lock = mockLockFile({ skills: { "my-skill": existingEntry } });

      mocks.updateLockFile.mockImplementation(async (updater) => {
        await updater(lock);
        return lock;
      });

      await recordSkillInstall(
        "my-skill",
        "my-skill",
        "new/source",
        "gitlab",
        ["claude-code"],
        "/path",
        true,
      );

      expect(lock.skills["my-skill"]?.source).toBe("original/source");
      expect(lock.skills["my-skill"]?.sourceType).toBe("github");
    });

    it("stores project directory for project-scoped installs", async () => {
      const lock = mockLockFile();
      mocks.updateLockFile.mockImplementation(async (updater) => {
        await updater(lock);
        return lock;
      });

      await recordSkillInstall(
        "project-skill",
        "project-skill",
        "owner/repo",
        "github",
        ["claude-code"],
        "/path/to/skill",
        false,
        "/my/project",
      );

      expect(lock.skills["project-skill"]?.isGlobal).toBe(false);
      expect(lock.skills["project-skill"]?.projectDir).toBe("/my/project");
    });

    it("stores version when provided", async () => {
      const lock = mockLockFile();
      mocks.updateLockFile.mockImplementation(async (updater) => {
        await updater(lock);
        return lock;
      });

      await recordSkillInstall(
        "versioned-skill",
        "versioned-skill",
        "owner/repo",
        "github",
        ["claude-code"],
        "/path",
        true,
        undefined,
        "v1.2.3",
      );

      expect(lock.skills["versioned-skill"]?.version).toBe("v1.2.3");
    });

    it("updates updatedAt timestamp on each call", async () => {
      const existingEntry = mockSkillEntry({
        name: "my-skill",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      const lock = mockLockFile({ skills: { "my-skill": existingEntry } });

      mocks.updateLockFile.mockImplementation(async (updater) => {
        await updater(lock);
        return lock;
      });

      await recordSkillInstall(
        "my-skill",
        "my-skill",
        "owner/repo",
        "github",
        ["claude-code"],
        "/path",
        true,
      );

      expect(lock.skills["my-skill"]?.updatedAt).not.toBe("2026-01-01T00:00:00.000Z");
      expect(new Date(lock.skills["my-skill"]?.updatedAt ?? "").getTime()).toBeGreaterThan(0);
    });
  });

  describe("removeSkillFromLock", () => {
    it("removes skill from lock file", async () => {
      const lock = mockLockFile({
        skills: {
          "to-remove": mockSkillEntry({ name: "to-remove" }),
          "keep": mockSkillEntry({ name: "keep" }),
        },
      });

      mocks.updateLockFile.mockImplementation(async (updater) => {
        await updater(lock);
        return lock;
      });

      const result = await removeSkillFromLock("to-remove");

      expect(result).toBe(true);
      expect(lock.skills["to-remove"]).toBeUndefined();
      expect(lock.skills["keep"]).toBeDefined();
    });

    it("returns false when skill not found", async () => {
      const lock = mockLockFile({
        skills: { "existing": mockSkillEntry({ name: "existing" }) },
      });

      mocks.updateLockFile.mockImplementation(async (updater) => {
        await updater(lock);
        return lock;
      });

      const result = await removeSkillFromLock("nonexistent");

      expect(result).toBe(false);
      expect(lock.skills["existing"]).toBeDefined();
    });

    it("handles empty skills object", async () => {
      const lock = mockLockFile();

      mocks.updateLockFile.mockImplementation(async (updater) => {
        await updater(lock);
        return lock;
      });

      const result = await removeSkillFromLock("anything");

      expect(result).toBe(false);
    });
  });

  describe("getTrackedSkills", () => {
    it("returns all tracked skills", async () => {
      const skills = {
        "skill1": mockSkillEntry({ name: "skill1" }),
        "skill2": mockSkillEntry({ name: "skill2" }),
      };
      mocks.readLockFile.mockResolvedValue(mockLockFile({ skills }));

      const result = await getTrackedSkills();

      expect(result).toEqual(skills);
    });

    it("returns empty object when no skills", async () => {
      mocks.readLockFile.mockResolvedValue(mockLockFile());

      const result = await getTrackedSkills();

      expect(result).toEqual({});
    });

    it("handles read errors gracefully", async () => {
      mocks.readLockFile.mockRejectedValue(new Error("Read error"));

      await expect(getTrackedSkills()).rejects.toThrow("Read error");
    });
  });

  describe("checkSkillUpdate", () => {
    it("returns unknown when skill not found", async () => {
      mocks.readLockFile.mockResolvedValue(mockLockFile());

      const result = await checkSkillUpdate("nonexistent");

      expect(result.hasUpdate).toBe(false);
      expect(result.status).toBe("unknown");
    });

    it("returns unknown for local source type", async () => {
      mocks.readLockFile.mockResolvedValue(mockLockFile({
        skills: {
          "local-skill": mockSkillEntry({
            name: "local-skill",
            sourceType: "local",
            version: "abc123",
          }),
        },
      }));

      const result = await checkSkillUpdate("local-skill");

      expect(result.hasUpdate).toBe(false);
      expect(result.status).toBe("unknown");
      expect(result.currentVersion).toBe("abc123");
    });

    it("returns unknown for package source type", async () => {
      mocks.readLockFile.mockResolvedValue(mockLockFile({
        skills: {
          "pkg-skill": mockSkillEntry({
            name: "pkg-skill",
            sourceType: "package",
            version: "1.0.0",
          }),
        },
      }));

      const result = await checkSkillUpdate("pkg-skill");

      expect(result.status).toBe("unknown");
    });

    it("detects update available for GitHub source", async () => {
      mocks.readLockFile.mockResolvedValue(mockLockFile({
        skills: {
          "github-skill": mockSkillEntry({
            name: "github-skill",
            sourceType: "github",
            source: "owner/repo",
            version: "abc123",
          }),
        },
      }));
      mocks.parseSource.mockReturnValue({ type: "github", owner: "owner", repo: "repo", ref: undefined });
      mocks.simpleGit.mockReturnValue({
        listRemote: vi.fn().mockResolvedValue("def456789abc HEAD"),
      });

      const result = await checkSkillUpdate("github-skill");

      expect(result.hasUpdate).toBe(true);
      expect(result.status).toBe("update-available");
      expect(result.currentVersion).toBe("abc123");
      expect(result.latestVersion).toBe("def456789abc");
    });

    it("detects up-to-date for GitHub source", async () => {
      mocks.readLockFile.mockResolvedValue(mockLockFile({
        skills: {
          "current-skill": mockSkillEntry({
            name: "current-skill",
            sourceType: "github",
            source: "owner/repo",
            version: "abc123def456",
          }),
        },
      }));
      mocks.parseSource.mockReturnValue({ type: "github", owner: "owner", repo: "repo", ref: undefined });
      mocks.simpleGit.mockReturnValue({
        listRemote: vi.fn().mockResolvedValue("abc123def789 HEAD"),
      });

      const result = await checkSkillUpdate("current-skill");

      expect(result.hasUpdate).toBe(false);
      expect(result.status).toBe("up-to-date");
    });

    it("detects update available for GitLab source", async () => {
      mocks.readLockFile.mockResolvedValue(mockLockFile({
        skills: {
          "gitlab-skill": mockSkillEntry({
            name: "gitlab-skill",
            sourceType: "gitlab",
            source: "gitlab.com/owner/repo",
            version: "old123",
          }),
        },
      }));
      mocks.parseSource.mockReturnValue({ type: "gitlab", owner: "owner", repo: "repo", ref: undefined });
      mocks.simpleGit.mockReturnValue({
        listRemote: vi.fn().mockResolvedValue("new456 HEAD"),
      });

      const result = await checkSkillUpdate("gitlab-skill");

      expect(result.hasUpdate).toBe(true);
      expect(result.status).toBe("update-available");
    });

    it("returns unknown when git ls-remote fails", async () => {
      mocks.readLockFile.mockResolvedValue(mockLockFile({
        skills: {
          "unreachable-skill": mockSkillEntry({
            name: "unreachable-skill",
            sourceType: "github",
            source: "owner/private",
            version: "abc123",
          }),
        },
      }));
      mocks.parseSource.mockReturnValue({ type: "github", owner: "owner", repo: "private", ref: undefined });
      mocks.simpleGit.mockReturnValue({
        listRemote: vi.fn().mockRejectedValue(new Error("Authentication failed")),
      });

      const result = await checkSkillUpdate("unreachable-skill");

      expect(result.hasUpdate).toBe(false);
      expect(result.status).toBe("unknown");
    });

    it("returns unknown when source parsing fails", async () => {
      mocks.readLockFile.mockResolvedValue(mockLockFile({
        skills: {
          "bad-source": mockSkillEntry({
            name: "bad-source",
            sourceType: "github",
            source: "invalid",
            version: "abc123",
          }),
        },
      }));
      mocks.parseSource.mockReturnValue({ type: "github", owner: undefined, repo: undefined });

      const result = await checkSkillUpdate("bad-source");

      expect(result.status).toBe("unknown");
    });

    it("handles missing version field", async () => {
      mocks.readLockFile.mockResolvedValue(mockLockFile({
        skills: {
          "no-version": mockSkillEntry({
            name: "no-version",
            sourceType: "github",
            source: "owner/repo",
            version: undefined,
          }),
        },
      }));
      mocks.parseSource.mockReturnValue({ type: "github", owner: "owner", repo: "repo" });
      mocks.simpleGit.mockReturnValue({
        listRemote: vi.fn().mockResolvedValue("abc123 HEAD"),
      });

      const result = await checkSkillUpdate("no-version");

      expect(result.hasUpdate).toBe(true);
      expect(result.currentVersion).toBe("unknown");
    });

    it("uses --refs flag for named refs", async () => {
      mocks.readLockFile.mockResolvedValue(mockLockFile({
        skills: {
          "ref-skill": mockSkillEntry({
            name: "ref-skill",
            sourceType: "github",
            source: "owner/repo#v1.0",
            version: "abc123",
          }),
        },
      }));
      mocks.parseSource.mockReturnValue({ type: "github", owner: "owner", repo: "repo", ref: "v1.0" });
      const listRemote = vi.fn().mockResolvedValue("def456 HEAD");
      mocks.simpleGit.mockReturnValue({ listRemote });

      await checkSkillUpdate("ref-skill");

      expect(listRemote).toHaveBeenCalledWith(["--refs", "https://github.com/owner/repo.git", "v1.0"]);
    });

    it("does not use --refs for HEAD", async () => {
      mocks.readLockFile.mockResolvedValue(mockLockFile({
        skills: {
          "head-skill": mockSkillEntry({
            name: "head-skill",
            sourceType: "github",
            source: "owner/repo",
            version: "abc123",
          }),
        },
      }));
      mocks.parseSource.mockReturnValue({ type: "github", owner: "owner", repo: "repo", ref: undefined });
      const listRemote = vi.fn().mockResolvedValue("def456 HEAD");
      mocks.simpleGit.mockReturnValue({ listRemote });

      await checkSkillUpdate("head-skill");

      expect(listRemote).toHaveBeenCalledWith(["https://github.com/owner/repo.git", "HEAD"]);
    });

    it("truncates latestVersion to 12 characters", async () => {
      mocks.readLockFile.mockResolvedValue(mockLockFile({
        skills: {
          "long-sha": mockSkillEntry({
            name: "long-sha",
            sourceType: "github",
            source: "owner/repo",
            version: "abc123",
          }),
        },
      }));
      mocks.parseSource.mockReturnValue({ type: "github", owner: "owner", repo: "repo" });
      mocks.simpleGit.mockReturnValue({
        listRemote: vi.fn().mockResolvedValue("abcdef123456789012345678901234567890abcd HEAD"),
      });

      const result = await checkSkillUpdate("long-sha");

      expect(result.latestVersion?.length).toBe(12);
    });

    it("checks library sourceType and detects update available", async () => {
      mocks.readLockFile.mockResolvedValue(mockLockFile({
        skills: {
          "lib-skill": mockSkillEntry({
            name: "lib-skill",
            sourceType: "library",
            source: "@cleocode/ct-skills:ct-research",
            version: "1.0.0",
          }),
        },
      }));
      mocks.parseSource.mockReturnValue({
        type: "library",
        owner: "@cleocode/ct-skills",
        repo: "ct-research",
      });
      mocks.execFileAsync.mockResolvedValue({ stdout: "2.0.0\n" });

      const result = await checkSkillUpdate("lib-skill");

      expect(result.hasUpdate).toBe(true);
      expect(result.status).toBe("update-available");
      expect(result.currentVersion).toBe("1.0.0");
      expect(result.latestVersion).toBe("2.0.0");
    });

    it("library sourceType is up-to-date when versions match", async () => {
      mocks.readLockFile.mockResolvedValue(mockLockFile({
        skills: {
          "lib-current": mockSkillEntry({
            name: "lib-current",
            sourceType: "library",
            source: "@cleocode/ct-skills:ct-research",
            version: "1.5.0",
          }),
        },
      }));
      mocks.parseSource.mockReturnValue({
        type: "library",
        owner: "@cleocode/ct-skills",
        repo: "ct-research",
      });
      mocks.execFileAsync.mockResolvedValue({ stdout: "1.5.0\n" });

      const result = await checkSkillUpdate("lib-current");

      expect(result.hasUpdate).toBe(false);
      expect(result.status).toBe("up-to-date");
    });

    it("library sourceType returns unknown when npm view fails", async () => {
      mocks.readLockFile.mockResolvedValue(mockLockFile({
        skills: {
          "lib-fail": mockSkillEntry({
            name: "lib-fail",
            sourceType: "library",
            source: "@cleocode/ct-skills:ct-research",
            version: "1.0.0",
          }),
        },
      }));
      mocks.parseSource.mockReturnValue({
        type: "library",
        owner: "@cleocode/ct-skills",
        repo: "ct-research",
      });
      mocks.execFileAsync.mockRejectedValue(new Error("npm view failed"));

      const result = await checkSkillUpdate("lib-fail");

      expect(result.hasUpdate).toBe(false);
      expect(result.status).toBe("unknown");
    });

    it("library sourceType with no current version shows update available", async () => {
      mocks.readLockFile.mockResolvedValue(mockLockFile({
        skills: {
          "lib-no-ver": mockSkillEntry({
            name: "lib-no-ver",
            sourceType: "library",
            source: "@cleocode/ct-skills:ct-research",
            version: undefined,
          }),
        },
      }));
      mocks.parseSource.mockReturnValue({
        type: "library",
        owner: "@cleocode/ct-skills",
        repo: "ct-research",
      });
      mocks.execFileAsync.mockResolvedValue({ stdout: "1.0.0\n" });

      const result = await checkSkillUpdate("lib-no-ver");

      expect(result.hasUpdate).toBe(true);
      expect(result.currentVersion).toBe("unknown");
      expect(result.latestVersion).toBe("1.0.0");
    });

    it("returns unknown for github sourceType where parsed.repo is null", async () => {
      mocks.readLockFile.mockResolvedValue(mockLockFile({
        skills: {
          "no-repo": mockSkillEntry({
            name: "no-repo",
            sourceType: "github",
            source: "some-source",
            version: "abc123",
          }),
        },
      }));
      mocks.parseSource.mockReturnValue({ type: "github", owner: "owner", repo: undefined });

      const result = await checkSkillUpdate("no-repo");

      expect(result.hasUpdate).toBe(false);
      expect(result.status).toBe("unknown");
    });
  });

  describe("checkAllSkillUpdates", () => {
    it("checks all tracked skills for updates", async () => {
      const lock = mockLockFile({
        skills: {
          "skill-a": mockSkillEntry({
            name: "skill-a",
            sourceType: "github",
            source: "owner/repo-a",
            version: "abc123",
          }),
          "skill-b": mockSkillEntry({
            name: "skill-b",
            sourceType: "local",
            source: "./local-skill",
            version: "def456",
          }),
        },
      });
      // readLockFile is called by checkAllSkillUpdates AND by each checkSkillUpdate call
      mocks.readLockFile.mockResolvedValue(lock);
      mocks.parseSource.mockReturnValue({ type: "github", owner: "owner", repo: "repo-a" });
      mocks.simpleGit.mockReturnValue({
        listRemote: vi.fn().mockResolvedValue("newsha123456 HEAD"),
      });

      const results = await checkAllSkillUpdates();

      expect(Object.keys(results)).toHaveLength(2);
      expect(results["skill-a"]).toBeDefined();
      expect(results["skill-b"]).toBeDefined();
      // local sourceType should be unknown
      expect(results["skill-b"]?.status).toBe("unknown");
    });

    it("returns empty object when no skills tracked", async () => {
      mocks.readLockFile.mockResolvedValue(mockLockFile());

      const results = await checkAllSkillUpdates();

      expect(results).toEqual({});
    });
  });
});
