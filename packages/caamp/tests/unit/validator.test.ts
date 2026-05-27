import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateSkill } from "../../src/core/skills/validator.js";

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "caamp-validator-"));
});

afterEach(async () => {
  await rm(testDir, { recursive: true }).catch(() => {});
});

/** Write a SKILL.md file into testDir and return its path. */
function writeSkill(content: string, filename = "SKILL.md"): Promise<string> {
  const filePath = join(testDir, filename);
  return writeFile(filePath, content, "utf-8").then(() => filePath);
}

describe("validateSkill", () => {
  // ── 1. File does not exist ────────────────────────────────────────────
  it("returns valid:false with file error when file does not exist", async () => {
    const result = await validateSkill(join(testDir, "nonexistent.md"));

    expect(result.valid).toBe(false);
    expect(result.metadata).toBeNull();
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toEqual({
      level: "error",
      field: "file",
      message: "File does not exist",
    });
  });

  // ── 2. Missing frontmatter ────────────────────────────────────────────
  it("returns error when file has no frontmatter delimiters", async () => {
    const filePath = await writeSkill("# Just a heading\n\nNo frontmatter here.");

    const result = await validateSkill(filePath);

    expect(result.valid).toBe(false);
    expect(result.metadata).toBeNull();
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      level: "error",
      field: "frontmatter",
      message: expect.stringContaining("Missing YAML frontmatter"),
    });
  });

  // ── 3. Invalid YAML frontmatter ───────────────────────────────────────
  it("returns error when YAML frontmatter is malformed", async () => {
    const filePath = await writeSkill(
      "---\nname: [\ninvalid yaml: {{\n---\n\n# Body\n",
    );

    const result = await validateSkill(filePath);

    expect(result.valid).toBe(false);
    expect(result.metadata).toBeNull();
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      level: "error",
      field: "frontmatter",
      message: expect.stringContaining("Invalid YAML frontmatter"),
    });
  });

  // ── 4. Missing name field ─────────────────────────────────────────────
  it("returns error when name field is missing", async () => {
    const filePath = await writeSkill(
      "---\ndescription: A valid description that is long enough to avoid warnings about short text.\n---\n\n# Body content\n",
    );

    const result = await validateSkill(filePath);

    expect(result.valid).toBe(false);
    const nameIssue = result.issues.find(
      (i) => i.field === "name" && i.level === "error",
    );
    expect(nameIssue).toBeDefined();
    expect(nameIssue!.message).toBe("Missing required field: name");
  });

  // ── 5. Missing description field ──────────────────────────────────────
  it("returns error when description field is missing", async () => {
    const filePath = await writeSkill(
      "---\nname: my-skill\n---\n\n# Body content\n",
    );

    const result = await validateSkill(filePath);

    expect(result.valid).toBe(false);
    const descIssue = result.issues.find(
      (i) => i.field === "description" && i.level === "error",
    );
    expect(descIssue).toBeDefined();
    expect(descIssue!.message).toBe("Missing required field: description");
  });

  // ── 6. Name too long (65+ chars) ──────────────────────────────────────
  it("returns error when name exceeds 64 characters", async () => {
    const longName = "a".repeat(65);
    const filePath = await writeSkill(
      `---\nname: ${longName}\ndescription: A valid description that is long enough to avoid warnings about short text.\n---\n\n# Body\n`,
    );

    const result = await validateSkill(filePath);

    expect(result.valid).toBe(false);
    const nameIssue = result.issues.find(
      (i) => i.field === "name" && i.message.includes("too long"),
    );
    expect(nameIssue).toBeDefined();
    expect(nameIssue!.level).toBe("error");
    expect(nameIssue!.message).toContain("65 chars");
    expect(nameIssue!.message).toContain("max 64");
  });

  // ── 7. Invalid name pattern ───────────────────────────────────────────
  describe("invalid name patterns", () => {
    it.each([
      { name: "MySkill", reason: "uppercase letters" },
      { name: "my skill", reason: "spaces" },
      { name: "my_skill", reason: "underscores" },
      { name: "my.skill", reason: "dots" },
      { name: "-leading-hyphen", reason: "leading hyphen" },
      { name: "trailing-hyphen-", reason: "trailing hyphen" },
      { name: "my@skill", reason: "special characters" },
    ])("returns error for name with $reason ($name)", async ({ name }) => {
      const filePath = await writeSkill(
        `---\nname: "${name}"\ndescription: A valid description that is long enough to avoid warnings about short text.\n---\n\n# Body\n`,
      );

      const result = await validateSkill(filePath);

      const patternIssue = result.issues.find(
        (i) => i.field === "name" && i.message.includes("lowercase"),
      );
      expect(patternIssue).toBeDefined();
      expect(patternIssue!.level).toBe("error");
    });
  });

  // ── 8. Reserved name ──────────────────────────────────────────────────
  describe("reserved names", () => {
    it.each(["claude", "anthropic", "openai", "google", "microsoft", "cursor", "windsurf", "codex", "gemini", "copilot"])(
      "returns error for reserved name '%s'",
      async (reserved) => {
        const filePath = await writeSkill(
          `---\nname: ${reserved}\ndescription: A valid description that is long enough to avoid warnings about short text.\n---\n\n# Body\n`,
        );

        const result = await validateSkill(filePath);

        expect(result.valid).toBe(false);
        const reservedIssue = result.issues.find(
          (i) => i.field === "name" && i.message.includes("reserved"),
        );
        expect(reservedIssue).toBeDefined();
        expect(reservedIssue!.level).toBe("error");
        expect(reservedIssue!.message).toContain(`"${reserved}"`);
      },
    );
  });

  // ── 9. Name with HTML tags ────────────────────────────────────────────
  it("returns error when name contains HTML tags", async () => {
    const filePath = await writeSkill(
      `---\nname: "<script>test</script>"\ndescription: A valid description that is long enough to avoid warnings about short text.\n---\n\n# Body\n`,
    );

    const result = await validateSkill(filePath);

    expect(result.valid).toBe(false);
    const htmlIssue = result.issues.find(
      (i) => i.field === "name" && i.message.includes("XML/HTML"),
    );
    expect(htmlIssue).toBeDefined();
    expect(htmlIssue!.level).toBe("error");
  });

  // ── 10. Description too long (1025+ chars) ────────────────────────────
  it("returns error when description exceeds 1024 characters", async () => {
    const longDesc = "a".repeat(1025);
    const filePath = await writeSkill(
      `---\nname: my-skill\ndescription: "${longDesc}"\n---\n\n# Body\n`,
    );

    const result = await validateSkill(filePath);

    expect(result.valid).toBe(false);
    const descIssue = result.issues.find(
      (i) => i.field === "description" && i.message.includes("too long"),
    );
    expect(descIssue).toBeDefined();
    expect(descIssue!.level).toBe("error");
    expect(descIssue!.message).toContain("1025 chars");
    expect(descIssue!.message).toContain("max 1024");
  });

  // ── 11. Short description (< 50 chars) ────────────────────────────────
  it("returns warning when description is shorter than 50 characters", async () => {
    const shortDesc = "Short desc.";
    const filePath = await writeSkill(
      `---\nname: my-skill\ndescription: "${shortDesc}"\n---\n\n# Body\n`,
    );

    const result = await validateSkill(filePath);

    // Warnings do not cause valid:false
    expect(result.valid).toBe(true);
    const warnIssue = result.issues.find(
      (i) => i.field === "description" && i.level === "warning",
    );
    expect(warnIssue).toBeDefined();
    expect(warnIssue!.message).toContain("short");
    expect(warnIssue!.message).toContain(`${shortDesc.length} chars`);
  });

  // ── 12. Description with HTML tags ────────────────────────────────────
  it("returns error when description contains HTML tags", async () => {
    const filePath = await writeSkill(
      `---\nname: my-skill\ndescription: "A <b>bold</b> description that is long enough to avoid warnings about short text."\n---\n\n# Body\n`,
    );

    const result = await validateSkill(filePath);

    expect(result.valid).toBe(false);
    const htmlIssue = result.issues.find(
      (i) => i.field === "description" && i.message.includes("XML/HTML"),
    );
    expect(htmlIssue).toBeDefined();
    expect(htmlIssue!.level).toBe("error");
  });

  // ── 13. Body too long (501+ lines) ────────────────────────────────────
  it("returns warning when body exceeds 500 lines", async () => {
    const bodyLines = Array.from({ length: 501 }, (_, i) => `Line ${i + 1}`).join("\n");
    const filePath = await writeSkill(
      `---\nname: my-skill\ndescription: A valid description that is long enough to avoid warnings about short text.\n---\n\n${bodyLines}\n`,
    );

    const result = await validateSkill(filePath);

    // Warnings do not cause valid:false
    expect(result.valid).toBe(true);
    const bodyIssue = result.issues.find(
      (i) => i.field === "body" && i.level === "warning" && i.message.includes("long"),
    );
    expect(bodyIssue).toBeDefined();
    expect(bodyIssue!.message).toContain("501 lines");
    expect(bodyIssue!.message).toContain("splitting");
  });

  // ── 14. Empty body ────────────────────────────────────────────────────
  it("returns warning when body is empty (frontmatter only)", async () => {
    const filePath = await writeSkill(
      "---\nname: my-skill\ndescription: A valid description that is long enough to avoid warnings about short text.\n---\n",
    );

    const result = await validateSkill(filePath);

    expect(result.valid).toBe(true);
    const emptyIssue = result.issues.find(
      (i) => i.field === "body" && i.level === "warning" && i.message.includes("Empty"),
    );
    expect(emptyIssue).toBeDefined();
    expect(emptyIssue!.message).toContain("Add instructions");
  });

  // ── 15. Valid skill file ──────────────────────────────────────────────
  it("returns valid:true with metadata for a well-formed skill", async () => {
    const filePath = await writeSkill(
      `---\nname: my-awesome-skill\ndescription: A comprehensive skill for doing awesome things with proper tooling and workflows.\n---\n\n# My Awesome Skill\n\nThis skill helps you do awesome things.\n`,
    );

    const result = await validateSkill(filePath);

    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.metadata).toEqual({
      name: "my-awesome-skill",
      description:
        "A comprehensive skill for doing awesome things with proper tooling and workflows.",
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────────
  describe("edge cases", () => {
    it("accepts a single-character name", async () => {
      const filePath = await writeSkill(
        `---\nname: x\ndescription: A valid description that is long enough to avoid warnings about short text.\n---\n\n# Body\n`,
      );

      const result = await validateSkill(filePath);

      const nameErrors = result.issues.filter(
        (i) => i.field === "name" && i.level === "error",
      );
      expect(nameErrors).toHaveLength(0);
    });

    it("accepts a name at exactly 64 characters", async () => {
      const name64 = "a".repeat(64);
      const filePath = await writeSkill(
        `---\nname: ${name64}\ndescription: A valid description that is long enough to avoid warnings about short text.\n---\n\n# Body\n`,
      );

      const result = await validateSkill(filePath);

      const lengthIssue = result.issues.find(
        (i) => i.field === "name" && i.message.includes("too long"),
      );
      expect(lengthIssue).toBeUndefined();
    });

    it("accepts a description at exactly 1024 characters", async () => {
      const desc1024 = "a".repeat(1024);
      const filePath = await writeSkill(
        `---\nname: my-skill\ndescription: "${desc1024}"\n---\n\n# Body\n`,
      );

      const result = await validateSkill(filePath);

      const lengthIssue = result.issues.find(
        (i) => i.field === "description" && i.message.includes("too long"),
      );
      expect(lengthIssue).toBeUndefined();
    });

    it("accumulates multiple errors from the same file", async () => {
      // Missing both name and description
      const filePath = await writeSkill("---\nfoo: bar\n---\n\n# Body\n");

      const result = await validateSkill(filePath);

      expect(result.valid).toBe(false);
      const errors = result.issues.filter((i) => i.level === "error");
      expect(errors.length).toBeGreaterThanOrEqual(2);
      expect(errors.map((e) => e.field)).toContain("name");
      expect(errors.map((e) => e.field)).toContain("description");
    });

    it("returns body at exactly 500 lines without warning", async () => {
      const bodyLines = Array.from({ length: 500 }, (_, i) => `Line ${i + 1}`).join("\n");
      const filePath = await writeSkill(
        `---\nname: my-skill\ndescription: A valid description that is long enough to avoid warnings about short text.\n---\n\n${bodyLines}\n`,
      );

      const result = await validateSkill(filePath);

      const bodyWarn = result.issues.find(
        (i) => i.field === "body" && i.message.includes("long"),
      );
      expect(bodyWarn).toBeUndefined();
    });
  });
});
