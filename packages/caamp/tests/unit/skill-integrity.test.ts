import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LockEntry, Provider } from "../../src/types.js";

// Mock dependencies
vi.mock("../../src/core/lock-utils.js", () => ({
  readLockFile: vi.fn(),
  updateLockFile: vi.fn(),
}));

vi.mock("../../src/core/paths/standard.js", () => ({
  getCanonicalSkillsDir: vi.fn(),
  resolveProviderSkillsDirs: vi.fn(),
}));

// Import after mocking
const { readLockFile } = await import("../../src/core/lock-utils.js");
const { getCanonicalSkillsDir, resolveProviderSkillsDirs } = await import("../../src/core/paths/standard.js");

// Import the functions under test
const { 
  isCaampOwnedSkill, 
  shouldOverrideSkill, 
  checkSkillIntegrity, 
  checkAllSkillIntegrity 
} = await import("../../src/core/skills/integrity.js");

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `caamp-integrity-test-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
  vi.clearAllMocks();
});

afterEach(async () => {
  await rm(testDir, { recursive: true }).catch(() => {});
});

// ── isCaampOwnedSkill ───────────────────────────────────────────────

describe("isCaampOwnedSkill()", () => {
  it("returns true for ct-* prefixed skills", () => {
    expect(isCaampOwnedSkill("ct-orchestrator")).toBe(true);
    expect(isCaampOwnedSkill("ct-dev-workflow")).toBe(true);
    expect(isCaampOwnedSkill("ct-cleo")).toBe(true);
  });

  it("returns false for non-ct-* skills", () => {
    expect(isCaampOwnedSkill("my-skill")).toBe(false);
    expect(isCaampOwnedSkill("orchestrator")).toBe(false);
    expect(isCaampOwnedSkill("act-something")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isCaampOwnedSkill("")).toBe(false);
  });
});

// ── shouldOverrideSkill ─────────────────────────────────────────────

describe("shouldOverrideSkill()", () => {
  it("returns true when no existing entry", () => {
    expect(shouldOverrideSkill("my-skill", "github:owner/repo", undefined)).toBe(true);
  });

  it("returns true for ct-* skills (CAAMP always wins)", () => {
    const existing: LockEntry = {
      name: "ct-orchestrator",
      scopedName: "ct-orchestrator",
      source: "user/custom-repo",
      sourceType: "github",
      installedAt: new Date().toISOString(),
      agents: ["claude-code"],
      canonicalPath: "/fake/path",
      isGlobal: true,
    };

    expect(shouldOverrideSkill("ct-orchestrator", "@cleocode/skills", existing)).toBe(true);
  });

  it("returns true for non-ct-* skills (user can override)", () => {
    const existing: LockEntry = {
      name: "my-skill",
      scopedName: "my-skill",
      source: "other/repo",
      sourceType: "github",
      installedAt: new Date().toISOString(),
      agents: ["claude-code"],
      canonicalPath: "/fake/path",
      isGlobal: true,
    };

    expect(shouldOverrideSkill("my-skill", "new/source", existing)).toBe(true);
  });
});

// ── checkSkillIntegrity ─────────────────────────────────────────────

describe("checkSkillIntegrity()", () => {
  it("returns 'not-tracked' for skills not in lock file", async () => {
    vi.mocked(readLockFile).mockResolvedValue({
      version: 1,
      skills: {},
      mcpServers: {},
    });
    vi.mocked(getCanonicalSkillsDir).mockReturnValue(join(testDir, "canonical"));

    const result = await checkSkillIntegrity("unknown-skill", []);
    expect(result.status).toBe("not-tracked");
    expect(result.issue).toContain("not tracked");
  });

  it("identifies ct-* skills as CAAMP-owned", async () => {
    vi.mocked(readLockFile).mockResolvedValue({
      version: 1,
      skills: {},
      mcpServers: {},
    });
    vi.mocked(getCanonicalSkillsDir).mockReturnValue(join(testDir, "canonical"));

    const result = await checkSkillIntegrity("ct-orchestrator", []);
    expect(result.isCaampOwned).toBe(true);

    const result2 = await checkSkillIntegrity("my-custom-skill", []);
    expect(result2.isCaampOwned).toBe(false);
  });

  it("returns 'missing-canonical' when canonical directory does not exist", async () => {
    const canonicalDir = join(testDir, "canonical", "missing-skill");
    
    vi.mocked(readLockFile).mockResolvedValue({
      version: 1,
      skills: {
        "missing-skill": {
          name: "missing-skill",
          scopedName: "missing-skill",
          source: "test-source",
          sourceType: "github",
          installedAt: new Date().toISOString(),
          agents: ["claude-code"],
          canonicalPath: canonicalDir,
          isGlobal: true,
        },
      },
      mcpServers: {},
    });

    const result = await checkSkillIntegrity("missing-skill", []);
    expect(result.status).toBe("missing-canonical");
    expect(result.canonicalExists).toBe(false);
    expect(result.issue).toContain("Canonical directory missing");
  });

  it("returns 'intact' when skill is properly installed with valid symlinks", async () => {
    const skillName = "intact-skill";
    const canonicalDir = join(testDir, "canonical", skillName);
    const providerDir = join(testDir, "providers", "claude-code", "skills");
    const linkPath = join(providerDir, skillName);

    // Create canonical directory
    await mkdir(canonicalDir, { recursive: true });
    // Create provider skills directory
    await mkdir(providerDir, { recursive: true });
    // Create symlink
    await symlink(canonicalDir, linkPath);

    vi.mocked(readLockFile).mockResolvedValue({
      version: 1,
      skills: {
        [skillName]: {
          name: skillName,
          scopedName: skillName,
          source: "test-source",
          sourceType: "github",
          installedAt: new Date().toISOString(),
          agents: ["claude-code"],
          canonicalPath: canonicalDir,
          isGlobal: true,
        },
      },
      mcpServers: {},
    });

    vi.mocked(resolveProviderSkillsDirs).mockReturnValue([providerDir]);

    const result = await checkSkillIntegrity(skillName, [{
      id: "claude-code",
      instructFile: "CLAUDE.md",
      pathGlobal: testDir,
    } as Provider]);

    expect(result.status).toBe("intact");
    expect(result.canonicalExists).toBe(true);
    expect(result.linkStatuses).toHaveLength(1);
    expect(result.linkStatuses[0]?.exists).toBe(true);
    expect(result.linkStatuses[0]?.isSymlink).toBe(true);
    expect(result.linkStatuses[0]?.pointsToCanonical).toBe(true);
  });

  it("returns 'broken-symlink' when symlink is missing", async () => {
    const skillName = "broken-skill";
    const canonicalDir = join(testDir, "canonical", skillName);
    const providerDir = join(testDir, "providers", "claude-code", "skills");

    // Create canonical directory but NOT the symlink
    await mkdir(canonicalDir, { recursive: true });

    vi.mocked(readLockFile).mockResolvedValue({
      version: 1,
      skills: {
        [skillName]: {
          name: skillName,
          scopedName: skillName,
          source: "test-source",
          sourceType: "github",
          installedAt: new Date().toISOString(),
          agents: ["claude-code"],
          canonicalPath: canonicalDir,
          isGlobal: true,
        },
      },
      mcpServers: {},
    });

    vi.mocked(resolveProviderSkillsDirs).mockReturnValue([providerDir]);

    const result = await checkSkillIntegrity(skillName, [{
      id: "claude-code",
      instructFile: "CLAUDE.md",
      pathGlobal: testDir,
    } as Provider]);

    expect(result.status).toBe("broken-symlink");
    expect(result.issue).toContain("symlink(s) missing");
  });

  it("returns 'tampered' when symlink points to wrong location", async () => {
    const skillName = "tampered-skill";
    const canonicalDir = join(testDir, "canonical", skillName);
    const wrongDir = join(testDir, "wrong-location");
    const providerDir = join(testDir, "providers", "claude-code", "skills");
    const linkPath = join(providerDir, skillName);

    // Create directories
    await mkdir(canonicalDir, { recursive: true });
    await mkdir(wrongDir, { recursive: true });
    await mkdir(providerDir, { recursive: true });
    // Create symlink pointing to wrong location
    await symlink(wrongDir, linkPath);

    vi.mocked(readLockFile).mockResolvedValue({
      version: 1,
      skills: {
        [skillName]: {
          name: skillName,
          scopedName: skillName,
          source: "test-source",
          sourceType: "github",
          installedAt: new Date().toISOString(),
          agents: ["claude-code"],
          canonicalPath: canonicalDir,
          isGlobal: true,
        },
      },
      mcpServers: {},
    });

    vi.mocked(resolveProviderSkillsDirs).mockReturnValue([providerDir]);

    const result = await checkSkillIntegrity(skillName, [{
      id: "claude-code",
      instructFile: "CLAUDE.md",
      pathGlobal: testDir,
    } as Provider]);

    expect(result.status).toBe("tampered");
    expect(result.issue).toContain("do not point to canonical path");
  });

  it("handles skills with multiple providers", async () => {
    const skillName = "multi-provider-skill";
    const canonicalDir = join(testDir, "canonical", skillName);
    const provider1Dir = join(testDir, "providers", "claude-code", "skills");
    const provider2Dir = join(testDir, "providers", "cursor", "skills");

    await mkdir(canonicalDir, { recursive: true });
    await mkdir(provider1Dir, { recursive: true });
    await mkdir(provider2Dir, { recursive: true });
    await symlink(canonicalDir, join(provider1Dir, skillName));
    await symlink(canonicalDir, join(provider2Dir, skillName));

    vi.mocked(readLockFile).mockResolvedValue({
      version: 1,
      skills: {
        [skillName]: {
          name: skillName,
          scopedName: skillName,
          source: "test-source",
          sourceType: "github",
          installedAt: new Date().toISOString(),
          agents: ["claude-code", "cursor"],
          canonicalPath: canonicalDir,
          isGlobal: true,
        },
      },
      mcpServers: {},
    });

    vi.mocked(resolveProviderSkillsDirs)
      .mockReturnValueOnce([provider1Dir])
      .mockReturnValueOnce([provider2Dir]);

    const result = await checkSkillIntegrity(skillName, [
      { id: "claude-code", instructFile: "CLAUDE.md", pathGlobal: testDir } as Provider,
      { id: "cursor", instructFile: "AGENTS.md", pathGlobal: testDir } as Provider,
    ]);

    expect(result.status).toBe("intact");
    expect(result.linkStatuses).toHaveLength(2);
  });
});

// ── checkAllSkillIntegrity ───────────────────────────────────────────

describe("checkAllSkillIntegrity()", () => {
  it("checks all skills in the lock file", async () => {
    const skill1Dir = join(testDir, "canonical", "skill1");
    const skill2Dir = join(testDir, "canonical", "skill2");
    
    await mkdir(skill1Dir, { recursive: true });
    await mkdir(skill2Dir, { recursive: true });

    vi.mocked(readLockFile).mockResolvedValue({
      version: 1,
      skills: {
        skill1: {
          name: "skill1",
          scopedName: "skill1",
          source: "test-source",
          sourceType: "github",
          installedAt: new Date().toISOString(),
          agents: [],
          canonicalPath: skill1Dir,
          isGlobal: true,
        },
        skill2: {
          name: "skill2",
          scopedName: "skill2",
          source: "test-source",
          sourceType: "github",
          installedAt: new Date().toISOString(),
          agents: [],
          canonicalPath: skill2Dir,
          isGlobal: true,
        },
      },
      mcpServers: {},
    });

    const results = await checkAllSkillIntegrity([]);
    
    expect(results.size).toBe(2);
    expect(results.has("skill1")).toBe(true);
    expect(results.has("skill2")).toBe(true);
    expect(results.get("skill1")?.status).toBe("intact");
    expect(results.get("skill2")?.status).toBe("intact");
  });

  it("returns empty map when no skills in lock file", async () => {
    vi.mocked(readLockFile).mockResolvedValue({
      version: 1,
      skills: {},
      mcpServers: {},
    });

    const results = await checkAllSkillIntegrity([]);
    
    expect(results.size).toBe(0);
  });
});

// ── validateInstructionIntegrity ─────────────────────────────────────

describe("validateInstructionIntegrity()", () => {
  it("reports missing instruction files", async () => {
    const { validateInstructionIntegrity } = await import("../../src/core/skills/integrity.js");

    const providers = [
      {
        id: "test-provider",
        instructFile: "NONEXISTENT.md",
        pathGlobal: testDir,
      } as Provider,
    ];

    const issues = await validateInstructionIntegrity(providers, testDir, "project");
    expect(issues.length).toBe(1);
    expect(issues[0]?.issue).toContain("does not exist");
  });

  it("reports files without CAAMP blocks", async () => {
    const { validateInstructionIntegrity } = await import("../../src/core/skills/integrity.js");

    await writeFile(join(testDir, "PLAIN.md"), "# Just a file\nNo markers here.\n");

    const providers = [
      {
        id: "test-provider",
        instructFile: "PLAIN.md",
        pathGlobal: testDir,
      } as Provider,
    ];

    const issues = await validateInstructionIntegrity(providers, testDir, "project");
    expect(issues.length).toBe(1);
    expect(issues[0]?.issue).toContain("No CAAMP injection block");
  });

  it("reports no issues for current files", async () => {
    const { validateInstructionIntegrity } = await import("../../src/core/skills/integrity.js");

    await writeFile(
      join(testDir, "GOOD.md"),
      "<!-- CAAMP:START -->\n@AGENTS.md\n<!-- CAAMP:END -->\n",
    );

    const providers = [
      {
        id: "test-provider",
        instructFile: "GOOD.md",
        pathGlobal: testDir,
      } as Provider,
    ];

    const issues = await validateInstructionIntegrity(providers, testDir, "project");
    expect(issues.length).toBe(0);
  });

  it("reports outdated files when expected content differs", async () => {
    const { validateInstructionIntegrity } = await import("../../src/core/skills/integrity.js");

    await writeFile(
      join(testDir, "OLD.md"),
      "<!-- CAAMP:START -->\nold content\n<!-- CAAMP:END -->\n",
    );

    const providers = [
      {
        id: "test-provider",
        instructFile: "OLD.md",
        pathGlobal: testDir,
      } as Provider,
    ];

    const issues = await validateInstructionIntegrity(
      providers,
      testDir,
      "project",
      "new content",
    );
    expect(issues.length).toBe(1);
    expect(issues[0]?.issue).toContain("outdated");
  });
});
