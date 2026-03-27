import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureAllProviderInstructionFiles, ensureProviderInstructionFile, inject, } from "../../src/core/instructions/injector.js";
let testDir;
beforeEach(async () => {
    testDir = join(tmpdir(), `caamp-idempotent-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
});
afterEach(async () => {
    await rm(testDir, { recursive: true }).catch(() => { });
});
// ── Idempotent inject() ─────────────────────────────────────────────
describe("inject() idempotency", () => {
    it("returns 'created' on first call to a new file", async () => {
        const filePath = join(testDir, "NEW.md");
        const result = await inject(filePath, "content here");
        expect(result).toBe("created");
    });
    it("returns 'intact' when called again with same content", async () => {
        const filePath = join(testDir, "IDEMPOTENT.md");
        const first = await inject(filePath, "same content");
        expect(first).toBe("created");
        const second = await inject(filePath, "same content");
        expect(second).toBe("intact");
        const third = await inject(filePath, "same content");
        expect(third).toBe("intact");
    });
    it("returns 'updated' when content changes", async () => {
        const filePath = join(testDir, "UPDATE.md");
        await inject(filePath, "version 1");
        const result = await inject(filePath, "version 2");
        expect(result).toBe("updated");
        const content = await readFile(filePath, "utf-8");
        expect(content).toContain("version 2");
        expect(content).not.toContain("version 1");
    });
    it("returns 'intact' after update when called with same new content", async () => {
        const filePath = join(testDir, "STABLE.md");
        await inject(filePath, "v1");
        await inject(filePath, "v2");
        const result = await inject(filePath, "v2");
        expect(result).toBe("intact");
    });
    it("does not modify file when returning 'intact'", async () => {
        const filePath = join(testDir, "NOWRITE.md");
        await inject(filePath, "keep this");
        const contentAfterFirst = await readFile(filePath, "utf-8");
        await inject(filePath, "keep this");
        const contentAfterSecond = await readFile(filePath, "utf-8");
        expect(contentAfterFirst).toBe(contentAfterSecond);
    });
    it("returns 'added' when file exists but has no markers", async () => {
        const filePath = join(testDir, "EXISTING.md");
        await writeFile(filePath, "# Existing content\n");
        const result = await inject(filePath, "new block");
        expect(result).toBe("added");
        const content = await readFile(filePath, "utf-8");
        expect(content).toContain("<!-- CAAMP:START -->");
        expect(content).toContain("new block");
        expect(content).toContain("# Existing content");
    });
    it("handles whitespace-only differences as intact", async () => {
        const filePath = join(testDir, "WHITESPACE.md");
        await inject(filePath, "  content with spaces  ");
        const result = await inject(filePath, "content with spaces");
        expect(result).toBe("intact");
    });
    it("never creates duplicate CAAMP blocks", async () => {
        const filePath = join(testDir, "NODUP.md");
        // Simulate repeated calls (the original bug scenario)
        for (let i = 0; i < 10; i++) {
            await inject(filePath, "@AGENTS.md");
        }
        const content = await readFile(filePath, "utf-8");
        const startCount = (content.match(/<!-- CAAMP:START -->/g) || []).length;
        const endCount = (content.match(/<!-- CAAMP:END -->/g) || []).length;
        expect(startCount).toBe(1);
        expect(endCount).toBe(1);
    });
    it("preserves surrounding content during updates", async () => {
        const filePath = join(testDir, "PRESERVE.md");
        await writeFile(filePath, "# Header\n\n<!-- CAAMP:START -->\nold\n<!-- CAAMP:END -->\n\n# Footer\n");
        await inject(filePath, "new");
        const content = await readFile(filePath, "utf-8");
        expect(content).toContain("# Header");
        expect(content).toContain("# Footer");
        expect(content).toContain("new");
        expect(content).not.toContain("old");
    });
    it("consolidates multiple duplicate CAAMP blocks", async () => {
        const filePath = join(testDir, "CONSOLIDATE.md");
        // Simulate pre-existing duplicate blocks from v1.7.0
        await writeFile(filePath, "<!-- CAAMP:START -->\n@~/.cleo/templates/CLEO-INJECTION.md\n<!-- CAAMP:END -->\n<!-- CAAMP:START -->\n@~/.cleo/templates/CLEO-INJECTION.md\n<!-- CAAMP:END -->\n<!-- CAAMP:START -->\n@~/.cleo/templates/CLEO-INJECTION.md\n<!-- CAAMP:END -->");
        const result = await inject(filePath, "@~/.cleo/templates/CLEO-INJECTION.md");
        expect(result).toBe("consolidated");
        const content = await readFile(filePath, "utf-8");
        const startCount = (content.match(/<!-- CAAMP:START -->/g) || []).length;
        const endCount = (content.match(/<!-- CAAMP:END -->/g) || []).length;
        expect(startCount).toBe(1);
        expect(endCount).toBe(1);
        expect(content).toContain("@~/.cleo/templates/CLEO-INJECTION.md");
    });
    it("returns 'intact' after consolidation when called again", async () => {
        const filePath = join(testDir, "CONSOLIDATE-IDEMPOTENT.md");
        // Create multiple duplicate blocks
        await writeFile(filePath, "<!-- CAAMP:START -->\ncontent\n<!-- CAAMP:END -->\n<!-- CAAMP:START -->\ncontent\n<!-- CAAMP:END -->");
        // First call consolidates
        const first = await inject(filePath, "content");
        expect(first).toBe("consolidated");
        // Second call should be intact
        const second = await inject(filePath, "content");
        expect(second).toBe("intact");
        // Verify still only one block
        const content = await readFile(filePath, "utf-8");
        expect((content.match(/<!-- CAAMP:START -->/g) || []).length).toBe(1);
    });
    it("consolidates multiple blocks with different content and applies new content", async () => {
        const filePath = join(testDir, "CONSOLIDATE-UPDATE.md");
        // Multiple blocks with different content
        await writeFile(filePath, "<!-- CAAMP:START -->\nold content 1\n<!-- CAAMP:END -->\n<!-- CAAMP:START -->\nold content 2\n<!-- CAAMP:END -->\n<!-- CAAMP:START -->\nold content 3\n<!-- CAAMP:END -->");
        const result = await inject(filePath, "new unified content");
        expect(result).toBe("consolidated");
        const content = await readFile(filePath, "utf-8");
        expect((content.match(/<!-- CAAMP:START -->/g) || []).length).toBe(1);
        expect(content).toContain("new unified content");
        expect(content).not.toContain("old content 1");
        expect(content).not.toContain("old content 2");
        expect(content).not.toContain("old content 3");
    });
    it("preserves surrounding content when consolidating duplicates", async () => {
        const filePath = join(testDir, "CONSOLIDATE-PRESERVE.md");
        await writeFile(filePath, "# Header\n\n<!-- CAAMP:START -->\ncontent\n<!-- CAAMP:END -->\n<!-- CAAMP:START -->\ncontent\n<!-- CAAMP:END -->\n\n# Footer");
        const result = await inject(filePath, "content");
        expect(result).toBe("consolidated");
        const fileContent = await readFile(filePath, "utf-8");
        expect(fileContent).toContain("# Header");
        expect(fileContent).toContain("# Footer");
        expect((fileContent.match(/<!-- CAAMP:START -->/g) || []).length).toBe(1);
    });
    it("handles 69 duplicate blocks (real-world scenario)", async () => {
        const filePath = join(testDir, "MANY-DUPLICATES.md");
        // Create 69 duplicate blocks
        const blocks = Array(69)
            .fill(null)
            .map(() => "<!-- CAAMP:START -->\n@~/.cleo/templates/CLEO-INJECTION.md\n<!-- CAAMP:END -->")
            .join("\n");
        await writeFile(filePath, blocks);
        const result = await inject(filePath, "@~/.cleo/templates/CLEO-INJECTION.md");
        expect(result).toBe("consolidated");
        const content = await readFile(filePath, "utf-8");
        expect((content.match(/<!-- CAAMP:START -->/g) || []).length).toBe(1);
        expect((content.match(/<!-- CAAMP:END -->/g) || []).length).toBe(1);
    });
});
// ── ensureProviderInstructionFile ────────────────────────────────────
describe("ensureProviderInstructionFile()", () => {
    it("creates instruction file for a known provider", async () => {
        const result = await ensureProviderInstructionFile("claude-code", testDir, {
            references: ["@AGENTS.md"],
        });
        expect(result.providerId).toBe("claude-code");
        expect(result.instructFile).toBe("CLAUDE.md");
        expect(result.action).toBe("created");
        expect(result.filePath).toBe(join(testDir, "CLAUDE.md"));
        const content = await readFile(result.filePath, "utf-8");
        expect(content).toContain("@AGENTS.md");
        expect(content).toContain("<!-- CAAMP:START -->");
    });
    it("is idempotent on repeated calls", async () => {
        const first = await ensureProviderInstructionFile("claude-code", testDir, {
            references: ["@AGENTS.md"],
        });
        expect(first.action).toBe("created");
        const second = await ensureProviderInstructionFile("claude-code", testDir, {
            references: ["@AGENTS.md"],
        });
        expect(second.action).toBe("intact");
    });
    it("updates when references change", async () => {
        await ensureProviderInstructionFile("claude-code", testDir, {
            references: ["@AGENTS.md"],
        });
        const result = await ensureProviderInstructionFile("claude-code", testDir, {
            references: ["@AGENTS.md", "@.cleo/project-context.json"],
        });
        expect(result.action).toBe("updated");
    });
    it("throws for unknown provider", async () => {
        await expect(ensureProviderInstructionFile("nonexistent-provider", testDir, {
            references: ["@AGENTS.md"],
        })).rejects.toThrow('Unknown provider: "nonexistent-provider"');
    });
    it("includes content blocks when provided", async () => {
        const result = await ensureProviderInstructionFile("claude-code", testDir, {
            references: ["@AGENTS.md"],
            content: ["# Custom Section", "Extra info"],
        });
        const content = await readFile(result.filePath, "utf-8");
        expect(content).toContain("@AGENTS.md");
        expect(content).toContain("# Custom Section");
        expect(content).toContain("Extra info");
    });
    it("uses provider instructFile from registry (not hardcoded)", async () => {
        // gemini-cli should use GEMINI.md per registry
        const result = await ensureProviderInstructionFile("gemini-cli", testDir, {
            references: ["@AGENTS.md"],
        });
        expect(result.instructFile).toBe("GEMINI.md");
        expect(result.filePath).toBe(join(testDir, "GEMINI.md"));
    });
});
// ── ensureAllProviderInstructionFiles ────────────────────────────────
describe("ensureAllProviderInstructionFiles()", () => {
    it("deduplicates providers sharing the same instruction file", async () => {
        // Most providers use AGENTS.md — should only create one file for them
        const results = await ensureAllProviderInstructionFiles(["cursor", "windsurf"], testDir, { references: ["@AGENTS.md"] });
        // Both cursor and windsurf use AGENTS.md — should deduplicate
        expect(results.length).toBe(1);
        expect(results[0]?.instructFile).toBe("AGENTS.md");
    });
    it("creates separate files for providers with different instruction files", async () => {
        const results = await ensureAllProviderInstructionFiles(["claude-code", "gemini-cli"], testDir, { references: ["@AGENTS.md"] });
        expect(results.length).toBe(2);
        const files = results.map((r) => r.instructFile).sort();
        expect(files).toEqual(["CLAUDE.md", "GEMINI.md"]);
    });
    it("throws for unknown provider in the list", async () => {
        await expect(ensureAllProviderInstructionFiles(["claude-code", "fake-provider"], testDir, { references: ["@AGENTS.md"] })).rejects.toThrow('Unknown provider: "fake-provider"');
    });
});
//# sourceMappingURL=injector-idempotent.test.js.map