import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, mkdir, writeFile, mkdtemp } from "node:fs/promises";
import { existsSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { installToCanonical, listCanonicalSkills } from "../../src/core/skills/installer.js";
import { validateSkill } from "../../src/core/skills/validator.js";

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "caamp-test-"));
});

afterEach(async () => {
  await rm(testDir, { recursive: true }).catch(() => {});
});

describe("Skill Validator", () => {
  it("validates valid SKILL.md", async () => {
    const skillFile = join(testDir, "SKILL.md");
    await writeFile(skillFile, `---
name: test-skill
description: A test skill for validation
---

# Test Skill

This is a test skill with proper content.
`);

    const result = await validateSkill(skillFile);
    expect(result.valid).toBe(true);
    expect(result.issues.filter((i) => i.level === "error")).toHaveLength(0);
  });

  it("rejects missing name", async () => {
    const skillFile = join(testDir, "SKILL.md");
    await writeFile(skillFile, `---
description: A test skill
---

Content here.
`);

    const result = await validateSkill(skillFile);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.field === "name" && i.level === "error")).toBe(true);
  });

  it("rejects missing description", async () => {
    const skillFile = join(testDir, "SKILL.md");
    await writeFile(skillFile, `---
name: test-skill
---

Content here.
`);

    const result = await validateSkill(skillFile);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.field === "description" && i.level === "error")).toBe(true);
  });

  it("rejects reserved names", async () => {
    const skillFile = join(testDir, "SKILL.md");
    await writeFile(skillFile, `---
name: claude
description: Should be rejected
---

Content.
`);

    const result = await validateSkill(skillFile);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.message.includes("reserved"))).toBe(true);
  });

  it("warns on short description", async () => {
    const skillFile = join(testDir, "SKILL.md");
    await writeFile(skillFile, `---
name: my-skill
description: Short
---

Content here.
`);

    const result = await validateSkill(skillFile);
    expect(result.valid).toBe(true); // warnings don't invalidate
    expect(result.issues.some((i) => i.level === "warning" && i.field === "description")).toBe(true);
  });

  it("rejects non-existent file", async () => {
    const result = await validateSkill(join(testDir, "nonexistent.md"));
    expect(result.valid).toBe(false);
  });

  it("rejects missing frontmatter", async () => {
    const skillFile = join(testDir, "SKILL.md");
    await writeFile(skillFile, "# No frontmatter\n\nJust content.\n");

    const result = await validateSkill(skillFile);
    expect(result.valid).toBe(false);
  });
});

describe("Skill Installer", () => {
  it("installs to canonical location", async () => {
    // Create a mock skill directory
    const sourceDir = join(testDir, "source-skill");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "SKILL.md"), `---
name: test-install
description: Test installation skill
---

Test content.
`);

    const result = await installToCanonical(sourceDir, `test-install-${randomUUID()}`);
    expect(existsSync(result)).toBe(true);
    expect(existsSync(join(result, "SKILL.md"))).toBe(true);

    // Cleanup
    await rm(result, { recursive: true }).catch(() => {});
  });
});
