import { describe, expect, it } from "vitest";
import { buildInjectionContent, parseInjectionContent, } from "../../src/core/instructions/templates.js";
describe("InjectionTemplate API", () => {
    // ── buildInjectionContent ───────────────────────────────────────
    describe("buildInjectionContent", () => {
        it("builds content from references only", () => {
            const template = {
                references: ["@AGENTS.md"],
            };
            expect(buildInjectionContent(template)).toBe("@AGENTS.md");
        });
        it("builds content from multiple references", () => {
            const template = {
                references: ["@AGENTS.md", "@.cleo/project-context.json"],
            };
            expect(buildInjectionContent(template)).toBe("@AGENTS.md\n@.cleo/project-context.json");
        });
        it("builds content with references and content blocks", () => {
            const template = {
                references: ["@AGENTS.md"],
                content: ["# Custom Section", "Some extra info"],
            };
            const result = buildInjectionContent(template);
            expect(result).toBe("@AGENTS.md\n\n# Custom Section\nSome extra info");
        });
        it("builds content with only content blocks", () => {
            const template = {
                references: [],
                content: ["# Just Content"],
            };
            expect(buildInjectionContent(template)).toBe("# Just Content");
        });
        it("handles empty template", () => {
            const template = {
                references: [],
            };
            expect(buildInjectionContent(template)).toBe("");
        });
    });
    // ── parseInjectionContent ───────────────────────────────────────
    describe("parseInjectionContent", () => {
        it("parses references from @ lines", () => {
            const template = parseInjectionContent("@AGENTS.md\n@.cleo/config.json");
            expect(template.references).toEqual(["@AGENTS.md", "@.cleo/config.json"]);
            expect(template.content).toBeUndefined();
        });
        it("parses mixed references and content", () => {
            const template = parseInjectionContent("@AGENTS.md\n\n# Custom\nSome content");
            expect(template.references).toEqual(["@AGENTS.md"]);
            expect(template.content).toEqual(["# Custom", "Some content"]);
        });
        it("handles content-only input", () => {
            const template = parseInjectionContent("# Just Content\nMore text");
            expect(template.references).toEqual([]);
            expect(template.content).toEqual(["# Just Content", "More text"]);
        });
        it("handles empty input", () => {
            const template = parseInjectionContent("");
            expect(template.references).toEqual([]);
            expect(template.content).toBeUndefined();
        });
    });
    // ── Round-trip ──────────────────────────────────────────────────
    describe("round-trip", () => {
        it("build then parse preserves references", () => {
            const original = {
                references: ["@AGENTS.md", "@.cleo/project-context.json"],
            };
            const built = buildInjectionContent(original);
            const parsed = parseInjectionContent(built);
            expect(parsed.references).toEqual(original.references);
        });
        it("build then parse preserves content", () => {
            const original = {
                references: ["@AGENTS.md"],
                content: ["# Section", "Details here"],
            };
            const built = buildInjectionContent(original);
            const parsed = parseInjectionContent(built);
            expect(parsed.references).toEqual(original.references);
            expect(parsed.content).toEqual(original.content);
        });
    });
});
//# sourceMappingURL=injection-templates.test.js.map