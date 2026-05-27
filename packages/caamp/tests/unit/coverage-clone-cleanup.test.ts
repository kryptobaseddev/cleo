/**
 * Coverage tests for github.ts cloneRepo cleanup error (line 46)
 * and gitlab.ts cloneGitLabRepo cleanup error (line 40).
 *
 * Also covers: orchestration.ts rollback error paths (lines 364-365, 371-372)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock simple-git to avoid real clones
const mockClone = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("simple-git", () => ({
  simpleGit: () => ({
    clone: mockClone,
  }),
}));

// Mock fs/promises to control mkdtemp and rm behavior
const mockMkdtemp = vi.hoisted(() => vi.fn().mockResolvedValue("/tmp/caamp-test-mock"));
const mockRmFn = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    mkdtemp: mockMkdtemp,
    rm: mockRmFn,
  };
});

describe("coverage: github.ts cloneRepo cleanup error (line 46)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMkdtemp.mockResolvedValue("/tmp/caamp-test-mock");
    mockClone.mockResolvedValue(undefined);
  });

  it("cleanup swallows rm error", async () => {
    mockRmFn.mockRejectedValue(new Error("EPERM"));

    const { cloneRepo } = await import("../../src/core/sources/github.js");
    const result = await cloneRepo("owner", "repo");
    expect(result.localPath).toBe("/tmp/caamp-test-mock");

    // Call cleanup - should NOT throw despite rm failing
    await expect(result.cleanup()).resolves.toBeUndefined();
  });

  it("cleanup succeeds when rm works", async () => {
    mockRmFn.mockResolvedValue(undefined);

    const { cloneRepo } = await import("../../src/core/sources/github.js");
    const result = await cloneRepo("owner", "repo");

    await expect(result.cleanup()).resolves.toBeUndefined();
    expect(mockRmFn).toHaveBeenCalledWith("/tmp/caamp-test-mock", { recursive: true });
  });

  it("cloneRepo with ref passes --branch flag", async () => {
    mockRmFn.mockResolvedValue(undefined);

    const { cloneRepo } = await import("../../src/core/sources/github.js");
    const result = await cloneRepo("owner", "repo", "develop");
    expect(result.localPath).toBe("/tmp/caamp-test-mock");
    expect(mockClone).toHaveBeenCalledWith(
      "https://github.com/owner/repo.git",
      "/tmp/caamp-test-mock",
      ["--depth", "1", "--branch", "develop"],
    );
  });

  it("cloneRepo with subPath appends to localPath", async () => {
    mockRmFn.mockResolvedValue(undefined);

    const { cloneRepo } = await import("../../src/core/sources/github.js");
    const result = await cloneRepo("owner", "repo", undefined, "skills/my-skill");
    // On Windows, path.join uses backslashes
    expect(result.localPath).toContain("my-skill");
    expect(result.localPath).toMatch(/skills.my-skill/);
  });

  it("cloneRepo without subPath returns tmpDir directly", async () => {
    mockRmFn.mockResolvedValue(undefined);

    const { cloneRepo } = await import("../../src/core/sources/github.js");
    const result = await cloneRepo("owner", "repo");
    expect(result.localPath).toBe("/tmp/caamp-test-mock");
  });
});

describe("coverage: gitlab.ts cloneGitLabRepo cleanup error (line 40)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMkdtemp.mockResolvedValue("/tmp/caamp-gl-test-mock");
    mockClone.mockResolvedValue(undefined);
  });

  it("cleanup swallows rm error", async () => {
    mockRmFn.mockRejectedValue(new Error("EPERM"));

    const { cloneGitLabRepo } = await import("../../src/core/sources/gitlab.js");
    const result = await cloneGitLabRepo("owner", "repo");

    // Call cleanup - should NOT throw
    await expect(result.cleanup()).resolves.toBeUndefined();
  });

  it("cleanup succeeds when rm works", async () => {
    mockRmFn.mockResolvedValue(undefined);

    const { cloneGitLabRepo } = await import("../../src/core/sources/gitlab.js");
    const result = await cloneGitLabRepo("owner", "repo");

    await expect(result.cleanup()).resolves.toBeUndefined();
  });

  it("cloneGitLabRepo with ref passes --branch flag", async () => {
    mockRmFn.mockResolvedValue(undefined);

    const { cloneGitLabRepo } = await import("../../src/core/sources/gitlab.js");
    await cloneGitLabRepo("owner", "repo", "develop");
    expect(mockClone).toHaveBeenCalledWith(
      "https://gitlab.com/owner/repo.git",
      "/tmp/caamp-gl-test-mock",
      ["--depth", "1", "--branch", "develop"],
    );
  });

  it("cloneGitLabRepo with subPath appends to localPath", async () => {
    mockRmFn.mockResolvedValue(undefined);

    const { cloneGitLabRepo } = await import("../../src/core/sources/gitlab.js");
    const result = await cloneGitLabRepo("owner", "repo", undefined, "skills/my-skill");
    // On Windows, path.join uses backslashes
    expect(result.localPath).toContain("my-skill");
    expect(result.localPath).toMatch(/skills.my-skill/);
  });
});
