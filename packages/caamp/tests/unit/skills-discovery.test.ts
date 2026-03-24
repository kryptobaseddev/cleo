import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
  existsSync: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readFile: mocks.readFile,
  readdir: mocks.readdir,
}));

vi.mock("node:fs", () => ({
  existsSync: mocks.existsSync,
}));

import {
  discoverSkill,
  discoverSkills,
  discoverSkillsMulti,
  parseSkillFile,
} from "../../src/core/skills/discovery.js";

describe("skills discovery", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.readFile.mockReset();
    mocks.readdir.mockReset();
    mocks.existsSync.mockReset();
  });

  describe("parseSkillFile", () => {
    it("parses valid SKILL.md with frontmatter", async () => {
      mocks.readFile.mockResolvedValue(`---
name: test-skill
description: A test skill
license: MIT
---

# Test Skill

Instructions here.`);

      const result = await parseSkillFile("/path/to/SKILL.md");

      expect(result).not.toBeNull();
      expect(result?.name).toBe("test-skill");
      expect(result?.description).toBe("A test skill");
      expect(result?.license).toBe("MIT");
    });

    it("parses skill with allowed tools", async () => {
      mocks.readFile.mockResolvedValue(`---
name: tool-skill
description: Uses tools
allowed-tools: tool1 tool2 tool3
---

# Tool Skill`);

      const result = await parseSkillFile("/path/to/SKILL.md");

      expect(result?.allowedTools).toEqual(["tool1", "tool2", "tool3"]);
    });

    it("parses skill with allowedTools array", async () => {
      mocks.readFile.mockResolvedValue(`---
name: array-skill
description: Uses array tools
allowedTools: [tool1, tool2]
---

# Array Skill`);

      const result = await parseSkillFile("/path/to/SKILL.md");

      expect(result?.allowedTools).toEqual(["tool1", "tool2"]);
    });

    it("parses skill with metadata", async () => {
      mocks.readFile.mockResolvedValue(`---
name: meta-skill
description: Has metadata
metadata:
  author: Test Author
  version: "1.0"
---

# Meta Skill`);

      const result = await parseSkillFile("/path/to/SKILL.md");

      expect(result?.metadata).toEqual({
        author: "Test Author",
        version: "1.0",
      });
    });

    it("parses skill with compatibility", async () => {
      mocks.readFile.mockResolvedValue(`---
name: compat-skill
description: Compatible with agents
compatibility: claude-code >= 1.0
---

# Compatible Skill`);

      const result = await parseSkillFile("/path/to/SKILL.md");

      expect(result?.compatibility).toBe("claude-code >= 1.0");
    });

    it("returns null for missing name", async () => {
      mocks.readFile.mockResolvedValue(`---
description: Missing name field
---

# No Name Skill`);

      const result = await parseSkillFile("/path/to/SKILL.md");

      expect(result).toBeNull();
    });

    it("returns null for missing description", async () => {
      mocks.readFile.mockResolvedValue(`---
name: no-desc-skill
---

# No Description Skill`);

      const result = await parseSkillFile("/path/to/SKILL.md");

      expect(result).toBeNull();
    });

    it("returns null when file cannot be read", async () => {
      mocks.readFile.mockRejectedValue(new Error("ENOENT"));

      const result = await parseSkillFile("/nonexistent/SKILL.md");

      expect(result).toBeNull();
    });

    it("handles invalid YAML gracefully", async () => {
      mocks.readFile.mockResolvedValue(`---
name: [invalid: yaml: syntax
---

Content`);

      const result = await parseSkillFile("/path/to/SKILL.md");

      expect(result).toBeNull();
    });

    it("handles missing frontmatter", async () => {
      mocks.readFile.mockResolvedValue("# Just markdown content\n\nNo frontmatter here.");

      const result = await parseSkillFile("/path/to/SKILL.md");

      expect(result).toBeNull();
    });

    it("handles empty file", async () => {
      mocks.readFile.mockResolvedValue("");

      const result = await parseSkillFile("/path/to/SKILL.md");

      expect(result).toBeNull();
    });

    it("handles special characters in description", async () => {
      mocks.readFile.mockResolvedValue(`---
name: special-skill
description: "Description with &lt;special&gt; \\"chars\\""
---

# Special Skill`);

      const result = await parseSkillFile("/path/to/SKILL.md");

      expect(result?.description).toContain("special");
    });
  });

  describe("discoverSkill", () => {
    it("discovers skill at directory path", async () => {
      mocks.existsSync.mockReturnValue(true);
      mocks.readFile.mockResolvedValue(`---
name: found-skill
description: A discovered skill
---

# Found Skill`);

      const result = await discoverSkill("/skills/found-skill");

      expect(result).not.toBeNull();
      expect(result?.name).toBe("found-skill");
      expect(result?.scopedName).toBe("found-skill");
      expect(result?.path).toBe("/skills/found-skill");
    });

    it("returns null when SKILL.md does not exist", async () => {
      mocks.existsSync.mockReturnValue(false);

      const result = await discoverSkill("/skills/missing");

      expect(result).toBeNull();
    });

    it("returns null when SKILL.md is invalid", async () => {
      mocks.existsSync.mockReturnValue(true);
      mocks.readFile.mockResolvedValue("---\ninvalid: yaml\n---\n\nContent");

      const result = await discoverSkill("/skills/invalid");

      expect(result).toBeNull();
    });
  });

  describe("discoverSkills", () => {
    it("returns empty array for non-existent directory", async () => {
      mocks.existsSync.mockReturnValue(false);

      const results = await discoverSkills("/nonexistent");

      expect(results).toEqual([]);
    });

    it("discovers skills in directory", async () => {
      mocks.existsSync.mockReturnValue(true);
      mocks.readdir.mockResolvedValue([
        { name: "skill1", isDirectory: () => true, isSymbolicLink: () => false },
        { name: "skill2", isDirectory: () => true, isSymbolicLink: () => false },
      ] as unknown[] as ReturnType<typeof mocks.readdir>);

      // Track which file is being read
      let callCount = 0;
      mocks.readFile.mockImplementation(() => {
        callCount++;
        return Promise.resolve(`---
name: skill${callCount}
description: Skill ${callCount}
---

# Skill ${callCount}`);
      });

      const results = await discoverSkills("/skills");

      expect(results).toHaveLength(2);
      expect(results[0]?.name).toBe("skill1");
      expect(results[1]?.name).toBe("skill2");
    });

    it("skips non-directory entries", async () => {
      mocks.existsSync.mockReturnValue(true);
      mocks.readdir.mockResolvedValue([
        { name: "file.txt", isDirectory: () => false, isSymbolicLink: () => false },
        { name: "readme.md", isDirectory: () => false, isSymbolicLink: () => false },
      ] as unknown[] as ReturnType<typeof mocks.readdir>);

      const results = await discoverSkills("/skills");

      expect(results).toEqual([]);
    });

    it("follows symbolic links to skill directories", async () => {
      mocks.existsSync.mockReturnValue(true);
      mocks.readdir.mockResolvedValue([
        { name: "linked", isDirectory: () => false, isSymbolicLink: () => true },
      ] as unknown[] as ReturnType<typeof mocks.readdir>);

      mocks.readFile.mockResolvedValue(`---
name: linked-skill
description: A linked skill
---

# Linked Skill`);

      const results = await discoverSkills("/skills");

      expect(results).toHaveLength(1);
      expect(results[0]?.name).toBe("linked-skill");
    });

    it("handles invalid skills gracefully", async () => {
      mocks.existsSync.mockReturnValue(true);
      mocks.readdir.mockResolvedValue([
        { name: "valid", isDirectory: () => true, isSymbolicLink: () => false },
        { name: "invalid", isDirectory: () => true, isSymbolicLink: () => false },
      ] as unknown[] as ReturnType<typeof mocks.readdir>);

      // The second call (for invalid skill) returns content without required fields
      let callCount = 0;
      mocks.readFile.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve(`---
name: valid-skill
description: A valid skill
---

# Valid Skill`);
        }
        // Return content without name/description - invalid skill
        return Promise.resolve(`---
someField: value
---

# Invalid Skill`);
      });

      const results = await discoverSkills("/skills");

      expect(results).toHaveLength(1);
      expect(results[0]?.name).toBe("valid-skill");
    });

    it("handles empty directory", async () => {
      mocks.existsSync.mockReturnValue(true);
      mocks.readdir.mockResolvedValue([]);

      const results = await discoverSkills("/empty");

      expect(results).toEqual([]);
    });

    it("handles directory with only files", async () => {
      mocks.existsSync.mockReturnValue(true);
      mocks.readdir.mockResolvedValue([
        { name: "file1.txt", isDirectory: () => false, isSymbolicLink: () => false },
        { name: "file2.md", isDirectory: () => false, isSymbolicLink: () => false },
      ] as unknown[] as ReturnType<typeof mocks.readdir>);

      const results = await discoverSkills("/files-only");

      expect(results).toEqual([]);
    });

    it("handles read errors gracefully", async () => {
      mocks.existsSync.mockReturnValue(true);
      mocks.readdir.mockRejectedValue(new Error("Permission denied"));

      await expect(discoverSkills("/restricted")).rejects.toThrow("Permission denied");
    });
  });

  describe("discoverSkillsMulti", () => {
    it("discovers skills across multiple directories", async () => {
      mocks.existsSync.mockReturnValue(true);
      mocks.readdir.mockImplementation((path: string) => {
        if (path.includes("dir1")) {
          return Promise.resolve([
            { name: "skill1", isDirectory: () => true, isSymbolicLink: () => false },
          ] as unknown[] as ReturnType<typeof mocks.readdir>);
        }
        return Promise.resolve([
          { name: "skill2", isDirectory: () => true, isSymbolicLink: () => false },
        ] as unknown[] as ReturnType<typeof mocks.readdir>);
      });

      let callCount = 0;
      mocks.readFile.mockImplementation(() => {
        callCount++;
        return Promise.resolve(`---
name: skill${callCount}
description: Skill ${callCount}
---

# Skill ${callCount}`);
      });

      const results = await discoverSkillsMulti(["/dir1", "/dir2"]);

      expect(results).toHaveLength(2);
    });

    it("deduplicates skills by name", async () => {
      mocks.existsSync.mockReturnValue(true);
      mocks.readdir.mockResolvedValue([
        { name: "duplicate", isDirectory: () => true, isSymbolicLink: () => false },
      ] as unknown[] as ReturnType<typeof mocks.readdir>);

      mocks.readFile.mockResolvedValue(`---
name: same-skill
description: Same skill in both dirs
---

# Same Skill`);

      const results = await discoverSkillsMulti(["/dir1", "/dir2"]);

      expect(results).toHaveLength(1);
      expect(results[0]?.name).toBe("same-skill");
    });

    it("handles empty directory list", async () => {
      const results = await discoverSkillsMulti([]);

      expect(results).toEqual([]);
    });

    it("handles non-existent directories in list", async () => {
      mocks.existsSync.mockImplementation((path: string) =>
        !path.includes("nonexistent")
      );
      mocks.readdir.mockResolvedValue([
        { name: "skill1", isDirectory: () => true, isSymbolicLink: () => false },
      ] as unknown[] as ReturnType<typeof mocks.readdir>);

      mocks.readFile.mockResolvedValue(`---
name: skill1
description: A skill
---

# Skill`);

      const results = await discoverSkillsMulti(["/exists", "/nonexistent"]);

      expect(results).toHaveLength(1);
    });

    it("handles all non-existent directories", async () => {
      mocks.existsSync.mockReturnValue(false);

      const results = await discoverSkillsMulti(["/nonexistent1", "/nonexistent2"]);

      expect(results).toEqual([]);
    });

    it("preserves first occurrence on duplicates", async () => {
      mocks.existsSync.mockReturnValue(true);
      mocks.readdir.mockImplementation((path: string) => {
        if (path.includes("dir1")) {
          return Promise.resolve([
            { name: "skill", isDirectory: () => true, isSymbolicLink: () => false },
          ] as unknown[] as ReturnType<typeof mocks.readdir>);
        }
        return Promise.resolve([
          { name: "skill", isDirectory: () => true, isSymbolicLink: () => false },
        ] as unknown[] as ReturnType<typeof mocks.readdir>);
      });

      mocks.readFile.mockImplementation((path: string) => {
        const dir = path.includes("dir1") ? "dir1" : "dir2";
        return Promise.resolve(`---
name: skill
description: From ${dir}
---

# Skill`);
      });

      const results = await discoverSkillsMulti(["/dir1", "/dir2"]);

      expect(results).toHaveLength(1);
      expect(results[0]?.metadata.description).toBe("From dir1");
    });
  });
});
