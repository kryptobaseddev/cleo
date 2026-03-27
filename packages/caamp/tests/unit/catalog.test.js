import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as catalog from "../../src/core/skills/catalog.js";
import { buildLibraryFromFiles } from "../../src/core/skills/library-loader.js";
describe("catalog - registration and delegation", () => {
    let fixtureRoot;
    beforeEach(() => {
        catalog.clearRegisteredLibrary();
        // Create a fixture skill library on disk
        fixtureRoot = join(tmpdir(), `caamp-catalog-test-${Date.now()}`);
        mkdirSync(fixtureRoot, { recursive: true });
        writeFileSync(join(fixtureRoot, "skills.json"), JSON.stringify({
            version: "2.0.0",
            skills: [
                {
                    name: "alpha-skill",
                    description: "Alpha skill for testing",
                    version: "1.0.0",
                    path: "skills/alpha-skill/SKILL.md",
                    references: [],
                    core: true,
                    category: "core",
                    tier: 0,
                    protocol: null,
                    dependencies: [],
                    sharedResources: [],
                    compatibility: ["claude-code"],
                    license: "MIT",
                    metadata: {},
                },
            ],
        }));
        mkdirSync(join(fixtureRoot, "skills", "alpha-skill"), { recursive: true });
        writeFileSync(join(fixtureRoot, "skills", "alpha-skill", "SKILL.md"), "# Alpha Skill\nContent here.");
        mkdirSync(join(fixtureRoot, "skills"), { recursive: true });
        writeFileSync(join(fixtureRoot, "skills", "manifest.json"), JSON.stringify({
            $schema: "",
            _meta: {},
            dispatch_matrix: { by_task_type: {}, by_keyword: {}, by_protocol: {} },
            skills: [],
        }));
    });
    afterEach(() => {
        catalog.clearRegisteredLibrary();
        if (existsSync(fixtureRoot)) {
            rmSync(fixtureRoot, { recursive: true, force: true });
        }
    });
    // ── isCatalogAvailable ──────────────────────────────────────────
    it("isCatalogAvailable returns false when no library registered", () => {
        // Clear env to prevent auto-discovery
        const orig = process.env["CAAMP_SKILL_LIBRARY"];
        delete process.env["CAAMP_SKILL_LIBRARY"];
        try {
            expect(catalog.isCatalogAvailable()).toBe(false);
        }
        finally {
            if (orig !== undefined)
                process.env["CAAMP_SKILL_LIBRARY"] = orig;
        }
    });
    it("isCatalogAvailable returns true after registerSkillLibrary", () => {
        const library = buildLibraryFromFiles(fixtureRoot);
        catalog.registerSkillLibrary(library);
        expect(catalog.isCatalogAvailable()).toBe(true);
    });
    // ── registerSkillLibrary ────────────────────────────────────────
    it("registerSkillLibrary makes library available", () => {
        const library = buildLibraryFromFiles(fixtureRoot);
        catalog.registerSkillLibrary(library);
        const skills = catalog.listSkills();
        expect(skills).toContain("alpha-skill");
    });
    // ── registerSkillLibraryFromPath ────────────────────────────────
    it("registerSkillLibraryFromPath loads from directory with skills.json", () => {
        catalog.registerSkillLibraryFromPath(fixtureRoot);
        expect(catalog.isCatalogAvailable()).toBe(true);
        expect(catalog.listSkills()).toContain("alpha-skill");
    });
    // ── clearRegisteredLibrary ──────────────────────────────────────
    it("clearRegisteredLibrary removes the library", () => {
        catalog.registerSkillLibraryFromPath(fixtureRoot);
        expect(catalog.isCatalogAvailable()).toBe(true);
        catalog.clearRegisteredLibrary();
        const orig = process.env["CAAMP_SKILL_LIBRARY"];
        delete process.env["CAAMP_SKILL_LIBRARY"];
        try {
            expect(catalog.isCatalogAvailable()).toBe(false);
        }
        finally {
            if (orig !== undefined)
                process.env["CAAMP_SKILL_LIBRARY"] = orig;
        }
    });
    // ── Auto-discovery via env var ──────────────────────────────────
    it("auto-discovers library from CAAMP_SKILL_LIBRARY env var", () => {
        const orig = process.env["CAAMP_SKILL_LIBRARY"];
        process.env["CAAMP_SKILL_LIBRARY"] = fixtureRoot;
        try {
            // No explicit registration, should auto-discover
            expect(catalog.isCatalogAvailable()).toBe(true);
            expect(catalog.listSkills()).toContain("alpha-skill");
        }
        finally {
            catalog.clearRegisteredLibrary();
            if (orig !== undefined) {
                process.env["CAAMP_SKILL_LIBRARY"] = orig;
            }
            else {
                delete process.env["CAAMP_SKILL_LIBRARY"];
            }
        }
    });
    // ── Delegate functions ──────────────────────────────────────────
    describe("delegates to registered library", () => {
        beforeEach(() => {
            catalog.registerSkillLibraryFromPath(fixtureRoot);
        });
        it("getSkills returns entries", () => {
            const skills = catalog.getSkills();
            expect(Array.isArray(skills)).toBe(true);
            expect(skills.length).toBeGreaterThan(0);
            expect(skills[0].name).toBe("alpha-skill");
        });
        it("getManifest returns manifest", () => {
            const manifest = catalog.getManifest();
            expect(manifest).toBeDefined();
            expect(manifest.dispatch_matrix).toBeDefined();
        });
        it("listSkills returns names", () => {
            expect(catalog.listSkills()).toContain("alpha-skill");
        });
        it("getSkill returns entry", () => {
            const skill = catalog.getSkill("alpha-skill");
            expect(skill).toBeDefined();
            expect(skill.description).toBe("Alpha skill for testing");
        });
        it("getSkill returns undefined for nonexistent", () => {
            expect(catalog.getSkill("nonexistent")).toBeUndefined();
        });
        it("getSkillPath returns path", () => {
            const path = catalog.getSkillPath("alpha-skill");
            expect(path).toMatch(/SKILL\.md$/);
        });
        it("getSkillDir returns directory path", () => {
            const dir = catalog.getSkillDir("alpha-skill");
            expect(dir).toContain("alpha-skill");
        });
        it("readSkillContent returns content", () => {
            const content = catalog.readSkillContent("alpha-skill");
            expect(content).toContain("# Alpha Skill");
        });
        it("getCoreSkills returns core only", () => {
            const core = catalog.getCoreSkills();
            expect(core).toHaveLength(1);
            expect(core[0].core).toBe(true);
        });
        it("getSkillsByCategory filters", () => {
            const core = catalog.getSkillsByCategory("core");
            expect(core.length).toBeGreaterThan(0);
        });
        it("getSkillDependencies returns deps", () => {
            const deps = catalog.getSkillDependencies("alpha-skill");
            expect(Array.isArray(deps)).toBe(true);
        });
        it("resolveDependencyTree resolves", () => {
            const resolved = catalog.resolveDependencyTree(["alpha-skill"]);
            expect(resolved).toContain("alpha-skill");
        });
        it("listProfiles returns profiles", () => {
            const profiles = catalog.listProfiles();
            expect(Array.isArray(profiles)).toBe(true);
        });
        it("listSharedResources returns resources", () => {
            const resources = catalog.listSharedResources();
            expect(Array.isArray(resources)).toBe(true);
        });
        it("listProtocols returns protocols", () => {
            const protocols = catalog.listProtocols();
            expect(Array.isArray(protocols)).toBe(true);
        });
        it("validateSkillFrontmatter validates", () => {
            const result = catalog.validateSkillFrontmatter("alpha-skill");
            expect(typeof result.valid).toBe("boolean");
            expect(Array.isArray(result.issues)).toBe(true);
        });
        it("validateAll validates all", () => {
            const results = catalog.validateAll();
            expect(results).toBeInstanceOf(Map);
            expect(results.has("alpha-skill")).toBe(true);
        });
        it("getDispatchMatrix returns matrix", () => {
            const matrix = catalog.getDispatchMatrix();
            expect(matrix).toBeDefined();
            expect(typeof matrix.by_task_type).toBe("object");
        });
        it("getVersion returns version", () => {
            expect(catalog.getVersion()).toBe("2.0.0");
        });
        it("getLibraryRoot returns path", () => {
            expect(catalog.getLibraryRoot()).toBe(fixtureRoot);
        });
    });
    // ── Error when no library ───────────────────────────────────────
    it("throws descriptive error when calling functions without library", () => {
        const orig = process.env["CAAMP_SKILL_LIBRARY"];
        delete process.env["CAAMP_SKILL_LIBRARY"];
        try {
            expect(() => catalog.listSkills()).toThrow("No skill library registered");
        }
        finally {
            if (orig !== undefined)
                process.env["CAAMP_SKILL_LIBRARY"] = orig;
        }
    });
});
//# sourceMappingURL=catalog.test.js.map