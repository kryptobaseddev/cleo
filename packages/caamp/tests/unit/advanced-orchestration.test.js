import { existsSync, lstatSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
/* ── Hoisted mocks for skills-related orchestration paths ────────── */
const mockedSkills = vi.hoisted(() => {
    const os = require("node:os");
    const path = require("node:path");
    const canonicalRoot = path.join(os.tmpdir(), `caamp-canonical-${process.pid}`);
    return {
        canonicalRoot,
        installSkillFn: vi.fn(),
        removeSkillFn: vi.fn(),
    };
});
vi.mock("../../src/core/paths/agents.js", async (importOriginal) => {
    const path = require("node:path");
    const original = await importOriginal();
    return {
        ...original,
        CANONICAL_SKILLS_DIR: path.join(mockedSkills.canonicalRoot, "skills"),
    };
});
vi.mock("../../src/core/skills/installer.js", async (importOriginal) => {
    const original = await importOriginal();
    return {
        ...original,
        installSkill: mockedSkills.installSkillFn,
        removeSkill: mockedSkills.removeSkillFn,
    };
});
import { installBatchWithRollback, selectProvidersByMinimumPriority, updateInstructionsSingleOperation, } from "../../src/core/advanced/orchestration.js";
let testDir;
function makeProvider(id, overrides = {}) {
    return {
        id,
        toolName: id,
        vendor: "test",
        agentFlag: id,
        aliases: [],
        pathGlobal: join(testDir, "global", id),
        pathProject: ".",
        instructFile: "AGENTS.md",
        configKey: "mcpServers",
        configFormat: "json",
        configPathGlobal: join(testDir, "global", id, "config.json"),
        configPathProject: `.config/${id}.json`,
        pathSkills: join(testDir, "skills", id, "global"),
        pathProjectSkills: `.skills/${id}`,
        detection: { methods: ["binary"], binary: id },
        supportedTransports: ["stdio", "http", "sse"],
        supportsHeaders: true,
        priority: "medium",
        status: "active",
        agentSkillsCompatible: true,
        capabilities: { skills: { agentsGlobalPath: null, agentsProjectPath: null, precedence: "vendor-only" }, hooks: { supported: [], hookConfigPath: null, hookFormat: null }, spawn: { supportsSubagents: false, supportsProgrammaticSpawn: false, supportsInterAgentComms: false, supportsParallelSpawn: false, spawnMechanism: null } },
        ...overrides,
    };
}
beforeEach(async () => {
    testDir = join(tmpdir(), `caamp-advanced-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    mockedSkills.installSkillFn.mockReset();
    mockedSkills.removeSkillFn.mockReset();
});
afterEach(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => { });
    await rm(mockedSkills.canonicalRoot, { recursive: true, force: true }).catch(() => { });
});
describe("selectProvidersByMinimumPriority", () => {
    it("filters and sorts by priority", () => {
        const providers = [
            makeProvider("low-1", { priority: "low" }),
            makeProvider("high-1", { priority: "high" }),
            makeProvider("medium-1", { priority: "medium" }),
        ];
        const result = selectProvidersByMinimumPriority(providers, "medium");
        expect(result.map((provider) => provider.id)).toEqual(["high-1", "medium-1"]);
    });
});
describe("updateInstructionsSingleOperation", () => {
    it("updates one shared file and reports provider/config-format coverage", async () => {
        const p1 = makeProvider("p1", { configFormat: "json", instructFile: "AGENTS.md" });
        const p2 = makeProvider("p2", { configFormat: "yaml", instructFile: "AGENTS.md" });
        const result = await updateInstructionsSingleOperation([p1, p2], "Shared block content", "project", testDir);
        expect(result.updatedFiles).toBe(1);
        expect(result.actions[0]?.providers.sort()).toEqual(["p1", "p2"]);
        expect(result.actions[0]?.configFormats.sort()).toEqual(["json", "yaml"]);
    });
});
describe("selectProvidersByMinimumPriority - edge cases", () => {
    it("returns all providers when minimum priority is 'low'", () => {
        const providers = [
            makeProvider("low-1", { priority: "low" }),
            makeProvider("high-1", { priority: "high" }),
            makeProvider("medium-1", { priority: "medium" }),
        ];
        const result = selectProvidersByMinimumPriority(providers, "low");
        expect(result).toHaveLength(3);
        expect(result.map((p) => p.id)).toEqual(["high-1", "medium-1", "low-1"]);
    });
    it("returns only high when minimum priority is 'high'", () => {
        const providers = [
            makeProvider("low-1", { priority: "low" }),
            makeProvider("high-1", { priority: "high" }),
            makeProvider("medium-1", { priority: "medium" }),
        ];
        const result = selectProvidersByMinimumPriority(providers, "high");
        expect(result).toHaveLength(1);
        expect(result[0]?.id).toBe("high-1");
    });
    it("returns empty array when no providers match", () => {
        const providers = [
            makeProvider("low-1", { priority: "low" }),
            makeProvider("medium-1", { priority: "medium" }),
        ];
        const result = selectProvidersByMinimumPriority(providers, "high");
        expect(result).toHaveLength(0);
    });
    it("defaults to 'low' minimum when not specified", () => {
        const providers = [
            makeProvider("low-1", { priority: "low" }),
            makeProvider("high-1", { priority: "high" }),
        ];
        const result = selectProvidersByMinimumPriority(providers);
        expect(result).toHaveLength(2);
    });
});
describe("installBatchWithRollback - skill operations", () => {
    const canonicalSkillsDir = join(mockedSkills.canonicalRoot, "skills");
    it("installs skills successfully and reports skillsApplied", async () => {
        const provider = makeProvider("skill-ok", { priority: "high" });
        mockedSkills.installSkillFn.mockResolvedValue({
            name: "my-skill",
            canonicalPath: join(canonicalSkillsDir, "my-skill"),
            linkedAgents: ["skill-ok"],
            errors: [],
            success: true,
        });
        const result = await installBatchWithRollback({
            providers: [provider],
            minimumPriority: "high",
            skills: [{
                    sourcePath: "/tmp/fake-skill-source",
                    skillName: "my-skill",
                    isGlobal: true,
                }],
            projectDir: testDir,
        });
        expect(result.success).toBe(true);
        expect(result.skillsApplied).toBe(1);
        expect(result.rollbackPerformed).toBe(false);
        expect(mockedSkills.installSkillFn).toHaveBeenCalledOnce();
    });
    it("rolls back skills when installSkill returns errors", async () => {
        const provider = makeProvider("skill-fail", { priority: "high" });
        mockedSkills.installSkillFn.mockResolvedValue({
            name: "bad-skill",
            canonicalPath: join(canonicalSkillsDir, "bad-skill"),
            linkedAgents: ["skill-fail"],
            errors: ["Link failed: permission denied"],
            success: false,
        });
        mockedSkills.removeSkillFn.mockResolvedValue({ removed: ["skill-fail"], errors: [] });
        const result = await installBatchWithRollback({
            providers: [provider],
            minimumPriority: "high",
            skills: [{
                    sourcePath: "/tmp/fake-skill-source",
                    skillName: "bad-skill",
                    isGlobal: true,
                }],
            projectDir: testDir,
        });
        expect(result.success).toBe(false);
        expect(result.rollbackPerformed).toBe(true);
        expect(result.error).toContain("Link failed: permission denied");
        expect(mockedSkills.removeSkillFn).toHaveBeenCalledOnce();
    });
    it("defaults isGlobal to true when not specified in skill operation", async () => {
        const provider = makeProvider("skill-default", { priority: "medium" });
        mockedSkills.installSkillFn.mockResolvedValue({
            name: "default-skill",
            canonicalPath: join(canonicalSkillsDir, "default-skill"),
            linkedAgents: ["skill-default"],
            errors: [],
            success: true,
        });
        await installBatchWithRollback({
            providers: [provider],
            skills: [{
                    sourcePath: "/tmp/fake-source",
                    skillName: "default-skill",
                    // isGlobal intentionally omitted
                }],
            projectDir: testDir,
        });
        // installSkill should be called with isGlobal=true (the default)
        expect(mockedSkills.installSkillFn).toHaveBeenCalledWith("/tmp/fake-source", "default-skill", expect.any(Array), true, testDir);
    });
    it("records rollback errors when removeSkill throws during rollback", async () => {
        const provider = makeProvider("skill-rb-err", { priority: "high" });
        // First skill succeeds, second fails
        mockedSkills.installSkillFn
            .mockResolvedValueOnce({
            name: "good-skill",
            canonicalPath: join(canonicalSkillsDir, "good-skill"),
            linkedAgents: ["skill-rb-err"],
            errors: [],
            success: true,
        })
            .mockResolvedValueOnce({
            name: "bad-skill",
            canonicalPath: join(canonicalSkillsDir, "bad-skill"),
            linkedAgents: [],
            errors: ["Install failed"],
            success: false,
        });
        mockedSkills.removeSkillFn.mockRejectedValue(new Error("removeSkill blew up"));
        const result = await installBatchWithRollback({
            providers: [provider],
            minimumPriority: "high",
            skills: [
                { sourcePath: "/tmp/s1", skillName: "good-skill", isGlobal: true },
                { sourcePath: "/tmp/s2", skillName: "bad-skill", isGlobal: true },
            ],
            projectDir: testDir,
        });
        expect(result.success).toBe(false);
        expect(result.rollbackPerformed).toBe(true);
        expect(result.rollbackErrors.length).toBeGreaterThan(0);
        expect(result.rollbackErrors.some((e) => e.includes("removeSkill blew up"))).toBe(true);
    });
});
describe("installBatchWithRollback - snapshot/restore skill state", () => {
    const canonicalSkillsDir = join(mockedSkills.canonicalRoot, "skills");
    it("snapshots and restores symlink state at provider skill paths during rollback", async () => {
        const provider = makeProvider("snap-sym", { priority: "high" });
        const skillLinkPath = join(testDir, "skills", "snap-sym", "global", "test-skill");
        // Pre-create a symlink at the skill link path
        await mkdir(join(testDir, "skills", "snap-sym", "global"), { recursive: true });
        const symlinkTarget = join(testDir, "symlink-target-dir");
        await mkdir(symlinkTarget, { recursive: true });
        await symlink(symlinkTarget, skillLinkPath, "dir");
        // Verify the symlink exists
        expect(lstatSync(skillLinkPath).isSymbolicLink()).toBe(true);
        // installSkill will fail, triggering rollback
        mockedSkills.installSkillFn.mockResolvedValue({
            name: "test-skill",
            canonicalPath: join(canonicalSkillsDir, "test-skill"),
            linkedAgents: ["snap-sym"],
            errors: ["Skill install error"],
            success: false,
        });
        mockedSkills.removeSkillFn.mockResolvedValue({ removed: ["snap-sym"], errors: [] });
        const result = await installBatchWithRollback({
            providers: [provider],
            minimumPriority: "high",
            skills: [{
                    sourcePath: "/tmp/fake-source",
                    skillName: "test-skill",
                    isGlobal: true,
                }],
            projectDir: testDir,
        });
        expect(result.success).toBe(false);
        expect(result.rollbackPerformed).toBe(true);
        // After rollback, the symlink should be restored
        expect(existsSync(skillLinkPath)).toBe(true);
        expect(lstatSync(skillLinkPath).isSymbolicLink()).toBe(true);
    });
    it("snapshots and restores directory state at provider skill paths during rollback", async () => {
        const provider = makeProvider("snap-dir", { priority: "high" });
        const skillLinkPath = join(testDir, "skills", "snap-dir", "global", "test-skill");
        // Pre-create a real directory (not symlink) with contents
        await mkdir(skillLinkPath, { recursive: true });
        await writeFile(join(skillLinkPath, "SKILL.md"), "# Original skill content");
        mockedSkills.installSkillFn.mockResolvedValue({
            name: "test-skill",
            canonicalPath: join(canonicalSkillsDir, "test-skill"),
            linkedAgents: ["snap-dir"],
            errors: ["Skill install error"],
            success: false,
        });
        mockedSkills.removeSkillFn.mockResolvedValue({ removed: ["snap-dir"], errors: [] });
        const result = await installBatchWithRollback({
            providers: [provider],
            minimumPriority: "high",
            skills: [{
                    sourcePath: "/tmp/fake-source",
                    skillName: "test-skill",
                    isGlobal: true,
                }],
            projectDir: testDir,
        });
        expect(result.success).toBe(false);
        expect(result.rollbackPerformed).toBe(true);
        // After rollback, the directory and its contents should be restored
        expect(existsSync(skillLinkPath)).toBe(true);
        expect(lstatSync(skillLinkPath).isDirectory()).toBe(true);
        const content = await readFile(join(skillLinkPath, "SKILL.md"), "utf-8");
        expect(content).toBe("# Original skill content");
    });
    it("snapshots and restores file state at provider skill paths during rollback", async () => {
        const provider = makeProvider("snap-file", { priority: "high" });
        const skillLinkPath = join(testDir, "skills", "snap-file", "global", "test-skill");
        // Pre-create a file (not directory) at the skill link path
        await mkdir(join(testDir, "skills", "snap-file", "global"), { recursive: true });
        await writeFile(skillLinkPath, "file-based skill marker");
        mockedSkills.installSkillFn.mockResolvedValue({
            name: "test-skill",
            canonicalPath: join(canonicalSkillsDir, "test-skill"),
            linkedAgents: ["snap-file"],
            errors: ["Skill install error"],
            success: false,
        });
        mockedSkills.removeSkillFn.mockResolvedValue({ removed: ["snap-file"], errors: [] });
        const result = await installBatchWithRollback({
            providers: [provider],
            minimumPriority: "high",
            skills: [{
                    sourcePath: "/tmp/fake-source",
                    skillName: "test-skill",
                    isGlobal: true,
                }],
            projectDir: testDir,
        });
        expect(result.success).toBe(false);
        expect(result.rollbackPerformed).toBe(true);
        // After rollback, the file should be restored
        expect(existsSync(skillLinkPath)).toBe(true);
        expect(lstatSync(skillLinkPath).isFile()).toBe(true);
        const content = await readFile(skillLinkPath, "utf-8");
        expect(content).toBe("file-based skill marker");
    });
    it("snapshots missing state and cleans up after rollback", async () => {
        const provider = makeProvider("snap-missing", { priority: "high" });
        const skillLinkPath = join(testDir, "skills", "snap-missing", "global", "test-skill");
        // Don't create anything at the link path - it's "missing"
        await mkdir(join(testDir, "skills", "snap-missing", "global"), { recursive: true });
        mockedSkills.installSkillFn.mockResolvedValue({
            name: "test-skill",
            canonicalPath: join(canonicalSkillsDir, "test-skill"),
            linkedAgents: ["snap-missing"],
            errors: ["Skill install error"],
            success: false,
        });
        mockedSkills.removeSkillFn.mockResolvedValue({ removed: [], errors: [] });
        const result = await installBatchWithRollback({
            providers: [provider],
            minimumPriority: "high",
            skills: [{
                    sourcePath: "/tmp/fake-source",
                    skillName: "test-skill",
                    isGlobal: true,
                }],
            projectDir: testDir,
        });
        expect(result.success).toBe(false);
        expect(result.rollbackPerformed).toBe(true);
        // After rollback, the path should still not exist (was "missing" before)
        expect(existsSync(skillLinkPath)).toBe(false);
    });
    it("snapshots and restores canonical skill directory during rollback", async () => {
        const provider = makeProvider("snap-canonical", { priority: "high" });
        const canonicalPath = join(canonicalSkillsDir, "test-skill");
        // Pre-create the canonical skill directory with content
        await mkdir(canonicalPath, { recursive: true });
        await writeFile(join(canonicalPath, "SKILL.md"), "# Canonical content");
        mockedSkills.installSkillFn.mockResolvedValue({
            name: "test-skill",
            canonicalPath,
            linkedAgents: ["snap-canonical"],
            errors: ["Skill install error"],
            success: false,
        });
        mockedSkills.removeSkillFn.mockResolvedValue({ removed: ["snap-canonical"], errors: [] });
        const result = await installBatchWithRollback({
            providers: [provider],
            minimumPriority: "high",
            skills: [{
                    sourcePath: "/tmp/fake-source",
                    skillName: "test-skill",
                    isGlobal: true,
                }],
            projectDir: testDir,
        });
        expect(result.success).toBe(false);
        expect(result.rollbackPerformed).toBe(true);
        // After rollback, the canonical directory should be restored with its content
        expect(existsSync(canonicalPath)).toBe(true);
        const content = await readFile(join(canonicalPath, "SKILL.md"), "utf-8");
        expect(content).toBe("# Canonical content");
    });
});
describe("updateInstructionsSingleOperation - global scope", () => {
    it("writes to global instruction paths when scope is 'global'", async () => {
        const p1 = makeProvider("global-p1", { configFormat: "json", instructFile: "AGENTS.md" });
        const result = await updateInstructionsSingleOperation([p1], "Global instruction content", "global", testDir);
        expect(result.scope).toBe("global");
        expect(result.updatedFiles).toBe(1);
        const globalInstructionPath = join(p1.pathGlobal, p1.instructFile);
        expect(existsSync(globalInstructionPath)).toBe(true);
        const content = await readFile(globalInstructionPath, "utf-8");
        expect(content).toContain("Global instruction content");
    });
});
//# sourceMappingURL=advanced-orchestration.test.js.map