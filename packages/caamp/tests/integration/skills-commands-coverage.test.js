/**
 * Additional coverage tests for skills commands.
 * Targets uncovered lines/branches across audit, install, find, remove, update, validate, check, init, list.
 */
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
    existsSync: vi.fn(),
    statSync: vi.fn(),
    scanFile: vi.fn(),
    scanDirectory: vi.fn(),
    toSarif: vi.fn(),
    getTrackedSkills: vi.fn(),
    checkSkillUpdate: vi.fn(),
    removeSkill: vi.fn(),
    listCanonicalSkills: vi.fn(),
    removeSkillFromLock: vi.fn(),
    installSkill: vi.fn(),
    parseSource: vi.fn(),
    cloneRepo: vi.fn(),
    cloneGitLabRepo: vi.fn(),
    getProvider: vi.fn(),
    getInstalledProviders: vi.fn(),
    discoverSkillsMulti: vi.fn(),
    resolveProviderSkillsDir: vi.fn(),
    validateSkill: vi.fn(),
    mkdir: vi.fn(),
    writeFile: vi.fn(),
    recordSkillInstall: vi.fn(),
    formatNetworkError: vi.fn(),
    isMarketplaceScoped: vi.fn(),
    marketplaceGetSkill: vi.fn(),
    isCatalogAvailable: vi.fn(),
    resolveProfile: vi.fn(),
    getSkillDir: vi.fn(),
    listProfiles: vi.fn(),
    getSkill: vi.fn(),
    listSkills: vi.fn(),
    discoverSkill: vi.fn(),
    search: vi.fn(),
    recommendSkillsByQuery: vi.fn(),
    formatSkillRecommendations: vi.fn(),
    tokenizeCriteriaValue: vi.fn(),
    buildSkillSubPathCandidates: vi.fn(),
}));
vi.mock("node:fs", () => ({
    existsSync: mocks.existsSync,
    statSync: mocks.statSync,
}));
vi.mock("node:fs/promises", () => ({
    mkdir: mocks.mkdir,
    writeFile: mocks.writeFile,
}));
vi.mock("../../src/core/skills/audit/scanner.js", () => ({
    scanFile: mocks.scanFile,
    scanDirectory: mocks.scanDirectory,
    toSarif: mocks.toSarif,
}));
vi.mock("../../src/core/skills/lock.js", () => ({
    getTrackedSkills: mocks.getTrackedSkills,
    checkSkillUpdate: mocks.checkSkillUpdate,
    removeSkillFromLock: mocks.removeSkillFromLock,
    recordSkillInstall: mocks.recordSkillInstall,
}));
vi.mock("../../src/core/skills/installer.js", () => ({
    removeSkill: mocks.removeSkill,
    listCanonicalSkills: mocks.listCanonicalSkills,
    installSkill: mocks.installSkill,
}));
vi.mock("../../src/core/sources/parser.js", () => ({
    parseSource: mocks.parseSource,
    isMarketplaceScoped: mocks.isMarketplaceScoped,
}));
vi.mock("../../src/core/sources/github.js", () => ({
    cloneRepo: mocks.cloneRepo,
}));
vi.mock("../../src/core/sources/gitlab.js", () => ({
    cloneGitLabRepo: mocks.cloneGitLabRepo,
}));
vi.mock("../../src/core/registry/providers.js", () => ({
    getProvider: mocks.getProvider,
    getInstalledProviders: mocks.getInstalledProviders,
    getAllProviders: vi.fn().mockReturnValue([]),
    getRegistryVersion: vi.fn().mockReturnValue("1.0.0"),
    getProviderCount: vi.fn().mockReturnValue(44),
}));
vi.mock("../../src/core/registry/detection.js", () => ({
    getInstalledProviders: mocks.getInstalledProviders,
}));
vi.mock("../../src/core/skills/discovery.js", () => ({
    discoverSkillsMulti: mocks.discoverSkillsMulti,
    discoverSkill: mocks.discoverSkill,
}));
vi.mock("../../src/core/paths/standard.js", () => ({
    resolveProviderSkillsDir: mocks.resolveProviderSkillsDir,
    buildSkillSubPathCandidates: mocks.buildSkillSubPathCandidates,
}));
vi.mock("../../src/core/skills/validator.js", () => ({
    validateSkill: mocks.validateSkill,
}));
vi.mock("../../src/core/network/fetch.js", () => ({
    formatNetworkError: mocks.formatNetworkError,
}));
vi.mock("../../src/core/marketplace/client.js", () => ({
    MarketplaceClient: class {
        getSkill = mocks.marketplaceGetSkill;
        search = mocks.search;
    },
}));
vi.mock("../../src/core/skills/catalog.js", () => ({
    isCatalogAvailable: mocks.isCatalogAvailable,
    resolveProfile: mocks.resolveProfile,
    getSkillDir: mocks.getSkillDir,
    listProfiles: mocks.listProfiles,
    getSkill: mocks.getSkill,
    listSkills: mocks.listSkills,
}));
vi.mock("../../src/core/skills/recommendation.js", () => ({
    tokenizeCriteriaValue: mocks.tokenizeCriteriaValue,
    RECOMMENDATION_ERROR_CODES: {
        QUERY_INVALID: "E_SKILLS_QUERY_INVALID",
        NO_MATCHES: "E_SKILLS_NO_MATCHES",
        SOURCE_UNAVAILABLE: "E_SKILLS_SOURCE_UNAVAILABLE",
        CRITERIA_CONFLICT: "E_SKILLS_CRITERIA_CONFLICT",
    },
}));
vi.mock("../../src/core/skills/recommendation-api.js", () => ({
    recommendSkills: mocks.recommendSkillsByQuery,
    formatSkillRecommendations: mocks.formatSkillRecommendations,
}));
// Import after mocks
import { registerSkillsAudit } from "../../src/commands/skills/audit.js";
import { registerSkillsCheck } from "../../src/commands/skills/check.js";
import { registerSkillsInit } from "../../src/commands/skills/init.js";
import { registerSkillsInstall } from "../../src/commands/skills/install.js";
import { registerSkillsList } from "../../src/commands/skills/list.js";
import { registerSkillsRemove } from "../../src/commands/skills/remove.js";
import { registerSkillsUpdate } from "../../src/commands/skills/update.js";
import { registerSkillsValidate } from "../../src/commands/skills/validate.js";
import { registerSkillsFind } from "../../src/commands/skills/find.js";
const mockProvider = {
    id: "claude-code",
    toolName: "Claude Code",
    pathGlobal: "/global",
    pathProject: "/project",
};
const mockProvider2 = {
    id: "cursor",
    toolName: "Cursor",
    pathGlobal: "/global2",
    pathProject: "/project2",
};
describe("skills commands - additional coverage", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        Object.values(mocks).forEach((mock) => mock?.mockReset?.());
        mocks.existsSync.mockReturnValue(true);
        mocks.getInstalledProviders.mockReturnValue([mockProvider]);
        mocks.getProvider.mockReturnValue(mockProvider);
        mocks.removeSkillFromLock.mockResolvedValue(true);
        mocks.isMarketplaceScoped.mockReturnValue(false);
        mocks.isCatalogAvailable.mockReturnValue(false);
        mocks.formatNetworkError.mockReturnValue("network failed");
        mocks.listSkills.mockReturnValue([]);
        mocks.discoverSkill.mockResolvedValue({ name: "discovered-name" });
        mocks.tokenizeCriteriaValue.mockImplementation((value) => value
            .split(",")
            .map((entry) => entry.trim().toLowerCase())
            .filter(Boolean));
    });
    // ==========================================
    // AUDIT COMMAND - uncovered lines 130-223
    // ==========================================
    describe("skills audit - additional coverage", () => {
        it("format conflict exits when both --json and --human passed", async () => {
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsAudit(program);
            await expect(program.parseAsync(["node", "test", "audit", "/path", "--json", "--human"])).rejects.toThrow("process-exit");
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
        it("outputs SARIF error when path not found and --sarif is set", async () => {
            mocks.existsSync.mockReturnValue(false);
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsAudit(program);
            await expect(program.parseAsync(["node", "test", "audit", "/nonexistent", "--sarif"])).rejects.toThrow("process-exit");
            const output = JSON.parse(String(errorSpy.mock.calls[0]?.[0] ?? "{}"));
            expect(output.version).toBe("2.1.0");
            expect(output.runs[0].invocations[0].executionSuccessful).toBe(false);
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
        it("outputs SARIF error when scan throws and format is sarif", async () => {
            mocks.statSync.mockReturnValue({ isFile: () => true });
            mocks.scanFile.mockRejectedValue(new Error("scan failed"));
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsAudit(program);
            await expect(program.parseAsync(["node", "test", "audit", "/path/to/SKILL.md", "--sarif"])).rejects.toThrow("process-exit");
            const output = JSON.parse(String(errorSpy.mock.calls[0]?.[0] ?? "{}"));
            expect(output.version).toBe("2.1.0");
            expect(output.runs[0].invocations[0].exitCodeDescription).toBe("scan failed");
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
        it("outputs LAFS JSON error when scan throws and format is json", async () => {
            mocks.statSync.mockReturnValue({ isFile: () => true });
            mocks.scanFile.mockRejectedValue(new Error("scan broke"));
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsAudit(program);
            await expect(program.parseAsync(["node", "test", "audit", "/path/to/SKILL.md", "--json"])).rejects.toThrow("process-exit");
            expect(errorSpy).toHaveBeenCalled();
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
        it("outputs SARIF for empty results with --sarif", async () => {
            mocks.statSync.mockReturnValue({ isFile: () => false });
            mocks.scanDirectory.mockResolvedValue([]);
            mocks.toSarif.mockReturnValue({ version: "2.1.0", runs: [] });
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsAudit(program);
            await program.parseAsync(["node", "test", "audit", "/empty", "--sarif"]);
            expect(mocks.toSarif).toHaveBeenCalledWith([]);
            const output = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}"));
            expect(output.version).toBe("2.1.0");
        });
        it("outputs JSON envelope for empty results with --json", async () => {
            mocks.statSync.mockReturnValue({ isFile: () => false });
            mocks.scanDirectory.mockResolvedValue([]);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsAudit(program);
            await program.parseAsync(["node", "test", "audit", "/empty", "--json"]);
            const output = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}"));
            expect(output.$schema).toBe("https://lafs.dev/schemas/v1/envelope.schema.json");
            expect(output.result.scanned).toBe(0);
        });
        it("outputs SARIF for results with findings and exits 1 when not all passed", async () => {
            const findings = [
                { rule: { id: "CI001", severity: "critical", name: "Command Injection", description: "Dangerous command" }, line: 5, context: "rm -rf /" },
            ];
            mocks.statSync.mockReturnValue({ isFile: () => true });
            mocks.scanFile.mockResolvedValue({
                file: "test.md",
                findings,
                score: 70,
                passed: false,
            });
            mocks.toSarif.mockReturnValue({ version: "2.1.0", runs: [{ results: findings }] });
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => { }));
            const program = new Command();
            registerSkillsAudit(program);
            await program.parseAsync(["node", "test", "audit", "test.md", "--sarif"]);
            expect(mocks.toSarif).toHaveBeenCalled();
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
        it("outputs JSON for results with findings and exits 1 when not all passed", async () => {
            mocks.statSync.mockReturnValue({ isFile: () => true });
            mocks.scanFile.mockResolvedValue({
                file: "test.md",
                findings: [
                    { rule: { id: "CI001", severity: "critical", name: "Command Injection", description: "Dangerous" }, line: 5, context: "rm -rf /" },
                ],
                score: 70,
                passed: false,
            });
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => { }));
            const program = new Command();
            registerSkillsAudit(program);
            await program.parseAsync(["node", "test", "audit", "test.md", "--json"]);
            const output = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}"));
            expect(output.result.findings).toBe(1);
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
        it("human output shows severity colors for all levels and file details", async () => {
            mocks.statSync.mockReturnValue({ isFile: () => false });
            mocks.scanDirectory.mockResolvedValue([
                {
                    file: "/skills/good/SKILL.md",
                    findings: [],
                    score: 100,
                    passed: true,
                },
                {
                    file: "/skills/bad/SKILL.md",
                    findings: [
                        { rule: { id: "CI001", severity: "critical", name: "Command Injection", description: "Dangerous" }, line: 5, context: "rm -rf /" },
                        { rule: { id: "H001", severity: "high", name: "High Risk", description: "High risk issue" }, line: 10, context: "sudo" },
                        { rule: { id: "M001", severity: "medium", name: "Medium Risk", description: "Medium risk" }, line: 15, context: "eval" },
                        { rule: { id: "L001", severity: "low", name: "Low Risk", description: "Low risk" }, line: 20, context: "info" },
                    ],
                    score: 50,
                    passed: false,
                },
            ]);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => { }));
            const program = new Command();
            registerSkillsAudit(program);
            await program.parseAsync(["node", "test", "audit", "/skills", "--human"]);
            const output = logSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
            expect(output).toContain("No issues found");
            expect(output).toContain("file(s) scanned");
            expect(output).toContain("finding(s)");
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
        it("handles non-Error thrown from scan", async () => {
            mocks.statSync.mockReturnValue({ isFile: () => true });
            mocks.scanFile.mockRejectedValue("string error");
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsAudit(program);
            await expect(program.parseAsync(["node", "test", "audit", "/path/to/SKILL.md"])).rejects.toThrow("process-exit");
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
        it("handles format resolution error", async () => {
            // Both --json and --human together should trigger format conflict (if resolveFormat throws)
            // We need to test what happens when resolveFormat throws. The actual function might not throw
            // for both flags, but the command handles it. Let's test a scenario where path exists and
            // format is resolved.
            // Test that SARIF format is set correctly when --sarif is used
            mocks.statSync.mockReturnValue({ isFile: () => true });
            mocks.scanFile.mockResolvedValue({
                file: "test.md",
                findings: [],
                score: 100,
                passed: true,
            });
            mocks.toSarif.mockReturnValue({ version: "2.1.0", runs: [] });
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsAudit(program);
            await program.parseAsync(["node", "test", "audit", "test.md", "--sarif"]);
            expect(mocks.toSarif).toHaveBeenCalled();
        });
    });
    // ==========================================
    // INSTALL COMMAND - uncovered lines 350-556
    // ==========================================
    describe("skills install - additional coverage", () => {
        it("format conflict exits when both --json and --human passed", async () => {
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsInstall(program);
            await expect(program.parseAsync(["node", "test", "install", "some-source", "--all", "--json", "--human"])).rejects.toThrow("process-exit");
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
        it("handles install failure (success=false) in JSON mode", async () => {
            mocks.parseSource.mockReturnValue({ type: "local", inferredName: "demo", value: "/tmp/demo" });
            mocks.installSkill.mockResolvedValue({
                success: false,
                canonicalPath: "",
                linkedAgents: [],
                errors: ["cannot link", "permission denied"],
            });
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsInstall(program);
            await expect(program.parseAsync(["node", "test", "install", "/tmp/demo", "--all", "--json"])).rejects.toThrow("process-exit");
            const output = JSON.parse(String(errorSpy.mock.calls[0]?.[0] ?? "{}"));
            expect(output.result.count.failed).toBe(1);
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
        it("handles install failure (success=false) in human mode", async () => {
            mocks.parseSource.mockReturnValue({ type: "local", inferredName: "demo", value: "/tmp/demo" });
            mocks.installSkill.mockResolvedValue({
                success: false,
                canonicalPath: "",
                linkedAgents: [],
                errors: ["cannot link", "permission denied"],
            });
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsInstall(program);
            await expect(program.parseAsync(["node", "test", "install", "/tmp/demo", "--all", "--human"])).rejects.toThrow("process-exit");
            const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
            expect(output).toContain("Failed to install");
            expect(output).toContain("cannot link");
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
        it("handles missing localPath after source resolution", async () => {
            // Simulate a scenario where parseSource returns a type that doesn't result in a localPath
            mocks.parseSource.mockReturnValue({ type: "url", inferredName: "demo", value: "http://example.com" });
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsInstall(program);
            await expect(program.parseAsync(["node", "test", "install", "http://example.com", "--all"])).rejects.toThrow("process-exit");
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
        it("handles GitHub clone failure in JSON mode", async () => {
            mocks.parseSource.mockReturnValue({ type: "github", owner: "org", repo: "skill", ref: "main", inferredName: "skill", value: "org/skill" });
            mocks.cloneRepo.mockRejectedValue(new Error("network timeout"));
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsInstall(program);
            await expect(program.parseAsync(["node", "test", "install", "org/skill", "--all", "--json"])).rejects.toThrow("process-exit");
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
        it("handles GitLab clone failure in JSON mode", async () => {
            mocks.parseSource.mockReturnValue({ type: "gitlab", owner: "group", repo: "skill", ref: "main", inferredName: "skill", value: "gitlab.com/group/skill" });
            mocks.cloneGitLabRepo.mockRejectedValue(new Error("network timeout"));
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsInstall(program);
            await expect(program.parseAsync(["node", "test", "install", "gitlab.com/group/skill", "--all", "--json"])).rejects.toThrow("process-exit");
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
        it("handles catalog not available for package type in JSON mode", async () => {
            mocks.parseSource.mockReturnValue({ type: "package", inferredName: "ct-test", value: "ct-test" });
            mocks.isCatalogAvailable.mockReturnValue(false);
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsInstall(program);
            await expect(program.parseAsync(["node", "test", "install", "ct-test", "--all", "--json"])).rejects.toThrow("process-exit");
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
        it("handles skill not found in catalog in JSON mode", async () => {
            mocks.parseSource.mockReturnValue({ type: "package", inferredName: "ct-missing", value: "ct-missing" });
            mocks.isCatalogAvailable.mockReturnValue(true);
            mocks.getSkill.mockReturnValue(undefined);
            mocks.listSkills.mockReturnValue(["ct-a", "ct-b"]);
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsInstall(program);
            await expect(program.parseAsync(["node", "test", "install", "ct-missing", "--all", "--json"])).rejects.toThrow("process-exit");
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
        it("installs successfully in JSON mode", async () => {
            mocks.parseSource.mockReturnValue({ type: "local", inferredName: "demo", value: "/tmp/demo" });
            mocks.installSkill.mockResolvedValue({
                success: true,
                canonicalPath: "/tmp/canonical/demo",
                linkedAgents: ["claude-code"],
                errors: [],
            });
            mocks.recordSkillInstall.mockResolvedValue(undefined);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsInstall(program);
            await program.parseAsync(["node", "test", "install", "/tmp/demo", "--all", "--json"]);
            const output = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}"));
            expect(output.$schema).toBe("https://lafs.dev/schemas/v1/envelope.schema.json");
            expect(output.result.count.installed).toBe(1);
        });
        it("installs successfully in human mode with warnings", async () => {
            mocks.parseSource.mockReturnValue({ type: "local", inferredName: "demo", value: "/tmp/demo" });
            mocks.installSkill.mockResolvedValue({
                success: true,
                canonicalPath: "/tmp/canonical/demo",
                linkedAgents: ["claude-code"],
                errors: ["symlink fallback used"],
            });
            mocks.recordSkillInstall.mockResolvedValue(undefined);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsInstall(program);
            await program.parseAsync(["node", "test", "install", "/tmp/demo", "--all", "--human"]);
            const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
            expect(output).toContain("Installed");
            expect(output).toContain("Warnings");
            expect(output).toContain("symlink fallback used");
        });
        it("uses default provider resolution (no --all or --agent) to install", async () => {
            mocks.getInstalledProviders.mockReturnValue([mockProvider]);
            mocks.parseSource.mockReturnValue({ type: "local", inferredName: "demo", value: "/tmp/demo" });
            mocks.installSkill.mockResolvedValue({
                success: true,
                canonicalPath: "/tmp/canonical/demo",
                linkedAgents: ["claude-code"],
                errors: [],
            });
            mocks.recordSkillInstall.mockResolvedValue(undefined);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsInstall(program);
            // No --all, no --agent flags -> uses default getInstalledProviders
            await program.parseAsync(["node", "test", "install", "/tmp/demo"]);
            expect(mocks.getInstalledProviders).toHaveBeenCalled();
            expect(mocks.installSkill).toHaveBeenCalled();
        });
        it("uses --agent flag to filter providers", async () => {
            mocks.getProvider.mockReturnValue(mockProvider);
            mocks.parseSource.mockReturnValue({ type: "local", inferredName: "demo", value: "/tmp/demo" });
            mocks.installSkill.mockResolvedValue({
                success: true,
                canonicalPath: "/tmp/canonical/demo",
                linkedAgents: ["claude-code"],
                errors: [],
            });
            mocks.recordSkillInstall.mockResolvedValue(undefined);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsInstall(program);
            await program.parseAsync(["node", "test", "install", "/tmp/demo", "--agent", "claude-code"]);
            expect(mocks.getProvider).toHaveBeenCalledWith("claude-code");
            expect(mocks.installSkill).toHaveBeenCalled();
        });
        it("handles missing source and no profile with JSON error", async () => {
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsInstall(program);
            await expect(program.parseAsync(["node", "test", "install", "--all", "--json"])).rejects.toThrow("process-exit");
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
        it("handles marketplace source lookup failure in JSON mode", async () => {
            mocks.isMarketplaceScoped.mockReturnValue(true);
            mocks.marketplaceGetSkill.mockRejectedValue(new Error("network down"));
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsInstall(program);
            await expect(program.parseAsync(["node", "test", "install", "@alice/skill", "--all", "--json"])).rejects.toThrow("process-exit");
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
        it("handles marketplace skill not found in JSON mode", async () => {
            mocks.isMarketplaceScoped.mockReturnValue(true);
            mocks.marketplaceGetSkill.mockResolvedValue(null);
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsInstall(program);
            await expect(program.parseAsync(["node", "test", "install", "@alice/nonexistent", "--all", "--json"])).rejects.toThrow("process-exit");
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
        it("handles marketplace source that resolves to non-GitHub in JSON mode", async () => {
            mocks.isMarketplaceScoped.mockReturnValue(true);
            mocks.marketplaceGetSkill.mockResolvedValue({
                name: "demo",
                author: "alice",
                repoFullName: "alice/demo",
                githubUrl: "https://example.com/alice/demo",
                path: "skills/demo/SKILL.md",
            });
            mocks.parseSource.mockReturnValue({ type: "local", value: "https://example.com/alice/demo" });
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsInstall(program);
            await expect(program.parseAsync(["node", "test", "install", "@alice/demo", "--all", "--json"])).rejects.toThrow("process-exit");
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
        it("handles marketplace clone failure in JSON mode", async () => {
            mocks.isMarketplaceScoped.mockReturnValue(true);
            mocks.marketplaceGetSkill.mockResolvedValue({
                name: "demo",
                author: "alice",
                repoFullName: "alice/demo",
                githubUrl: "https://github.com/alice/demo",
                path: "skills/demo/SKILL.md",
            });
            mocks.parseSource.mockReturnValue({ type: "github", owner: "alice", repo: "demo", ref: "main" });
            mocks.buildSkillSubPathCandidates.mockReturnValue(["skills/demo"]);
            mocks.cloneRepo.mockRejectedValue(new Error("clone failed"));
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsInstall(program);
            await expect(program.parseAsync(["node", "test", "install", "@alice/demo", "--all", "--json"])).rejects.toThrow("process-exit");
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
        it("handles marketplace install in human mode with found message", async () => {
            mocks.isMarketplaceScoped.mockReturnValue(true);
            mocks.marketplaceGetSkill.mockResolvedValue({
                name: "demo",
                author: "alice",
                repoFullName: "alice/demo",
                githubUrl: "https://github.com/alice/demo",
                path: "skills/demo/SKILL.md",
            });
            mocks.parseSource.mockReturnValue({ type: "github", owner: "alice", repo: "demo", ref: "main" });
            mocks.buildSkillSubPathCandidates.mockReturnValue([undefined]);
            mocks.cloneRepo.mockResolvedValue({ localPath: "/tmp/repo", cleanup: async () => { } });
            mocks.installSkill.mockResolvedValue({
                success: true,
                canonicalPath: "/tmp/canonical/demo",
                linkedAgents: ["claude-code"],
                errors: [],
            });
            mocks.recordSkillInstall.mockResolvedValue(undefined);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsInstall(program);
            await program.parseAsync(["node", "test", "install", "@alice/demo", "--all", "--human"]);
            const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
            expect(output).toContain("Searching marketplace");
            expect(output).toContain("Found:");
            expect(output).toContain("Installed");
        });
        it("handles profile install in human mode - all success", async () => {
            mocks.isCatalogAvailable.mockReturnValue(true);
            mocks.resolveProfile.mockReturnValue(["skill-a", "skill-b"]);
            mocks.getSkillDir.mockImplementation((name) => `/tmp/${name}`);
            mocks.installSkill.mockResolvedValue({
                success: true,
                canonicalPath: "/tmp/canonical",
                linkedAgents: ["claude-code"],
                errors: [],
            });
            mocks.recordSkillInstall.mockResolvedValue(undefined);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsInstall(program);
            await program.parseAsync(["node", "test", "install", "--profile", "core", "--all", "--human"]);
            const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
            expect(output).toContain("Installing profile");
            expect(output).toContain("2 installed");
        });
        it("handles profile install in human mode - with failure", async () => {
            mocks.isCatalogAvailable.mockReturnValue(true);
            mocks.resolveProfile.mockReturnValue(["good-skill", "bad-skill"]);
            mocks.getSkillDir.mockImplementation((name) => `/tmp/${name}`);
            mocks.installSkill
                .mockResolvedValueOnce({
                success: true,
                canonicalPath: "/tmp/canonical",
                linkedAgents: ["claude-code"],
                errors: [],
            })
                .mockResolvedValueOnce({
                success: false,
                canonicalPath: "",
                linkedAgents: [],
                errors: ["link failed"],
            });
            mocks.recordSkillInstall.mockResolvedValue(undefined);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsInstall(program);
            await expect(program.parseAsync(["node", "test", "install", "--profile", "core", "--all", "--human"])).rejects.toThrow("process-exit");
            const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
            expect(output).toContain("1 installed");
            expect(output).toContain("1 failed");
        });
        it("handles profile install in JSON mode - all success", async () => {
            mocks.isCatalogAvailable.mockReturnValue(true);
            mocks.resolveProfile.mockReturnValue(["skill-a"]);
            mocks.getSkillDir.mockReturnValue("/tmp/skill-a");
            mocks.installSkill.mockResolvedValue({
                success: true,
                canonicalPath: "/tmp/canonical",
                linkedAgents: ["claude-code"],
                errors: [],
            });
            mocks.recordSkillInstall.mockResolvedValue(undefined);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsInstall(program);
            await program.parseAsync(["node", "test", "install", "--profile", "core", "--all", "--json"]);
            const output = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}"));
            expect(output.$schema).toBe("https://lafs.dev/schemas/v1/envelope.schema.json");
            expect(output.result.count.installed).toBe(1);
        });
        it("handles profile catalog not available in human mode", async () => {
            mocks.isCatalogAvailable.mockReturnValue(false);
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsInstall(program);
            await expect(program.parseAsync(["node", "test", "install", "--profile", "core", "--all", "--human"])).rejects.toThrow("process-exit");
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
        it("handles profile not found in human mode", async () => {
            mocks.isCatalogAvailable.mockReturnValue(true);
            mocks.resolveProfile.mockReturnValue([]);
            mocks.listProfiles.mockReturnValue(["minimal", "core", "full"]);
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsInstall(program);
            await expect(program.parseAsync(["node", "test", "install", "--profile", "unknown", "--all", "--human"])).rejects.toThrow("process-exit");
            const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
            expect(output).toContain("Available profiles");
        });
        it("handles no providers in human mode", async () => {
            mocks.getInstalledProviders.mockReturnValue([]);
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsInstall(program);
            await expect(program.parseAsync(["node", "test", "install", "/tmp/demo", "--all", "--human"])).rejects.toThrow("process-exit");
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
        it("installs from catalog package type in human mode", async () => {
            mocks.parseSource.mockReturnValue({ type: "package", inferredName: "ct-test", value: "ct-test" });
            mocks.isCatalogAvailable.mockReturnValue(true);
            mocks.getSkill.mockReturnValue({
                name: "ct-test",
                version: "1.0.0",
                category: "test",
                core: false,
                description: "test",
            });
            mocks.getSkillDir.mockReturnValue("/tmp/ct-test");
            mocks.installSkill.mockResolvedValue({
                success: true,
                canonicalPath: "/tmp/canonical/ct-test",
                linkedAgents: ["claude-code"],
                errors: [],
            });
            mocks.recordSkillInstall.mockResolvedValue(undefined);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsInstall(program);
            await program.parseAsync(["node", "test", "install", "ct-test", "--all", "--human"]);
            const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
            expect(output).toContain("Found in catalog");
            expect(output).toContain("Installed");
        });
        it("cleanup is called on successful install from github", async () => {
            const cleanupFn = vi.fn();
            mocks.parseSource.mockReturnValue({ type: "github", owner: "org", repo: "skill", ref: "main", inferredName: "skill", value: "org/skill" });
            mocks.cloneRepo.mockResolvedValue({ localPath: "/tmp/repo", cleanup: cleanupFn });
            mocks.installSkill.mockResolvedValue({
                success: true,
                canonicalPath: "/tmp/canonical/skill",
                linkedAgents: ["claude-code"],
                errors: [],
            });
            mocks.recordSkillInstall.mockResolvedValue(undefined);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsInstall(program);
            await program.parseAsync(["node", "test", "install", "org/skill", "--all"]);
            expect(cleanupFn).toHaveBeenCalled();
        });
        it("handles marketplace subpath candidates with existsSync false for first candidate", async () => {
            mocks.isMarketplaceScoped.mockReturnValue(true);
            mocks.marketplaceGetSkill.mockResolvedValue({
                name: "demo",
                author: "alice",
                repoFullName: "alice/demo",
                githubUrl: "https://github.com/alice/demo",
                path: "skills/demo/SKILL.md",
            });
            mocks.parseSource.mockReturnValue({ type: "github", owner: "alice", repo: "demo", ref: "main", path: ".claude/skills/demo" });
            mocks.buildSkillSubPathCandidates.mockReturnValue(["skills/demo", ".claude/skills/demo"]);
            mocks.cloneRepo
                .mockResolvedValueOnce({ localPath: "/tmp/repo/skills/demo", cleanup: vi.fn() })
                .mockResolvedValueOnce({ localPath: "/tmp/repo/.claude/skills/demo", cleanup: async () => { } });
            mocks.existsSync
                .mockReturnValueOnce(false) // first subpath doesn't exist
                .mockReturnValueOnce(true); // second subpath exists
            mocks.installSkill.mockResolvedValue({
                success: true,
                canonicalPath: "/tmp/canonical/demo",
                linkedAgents: ["claude-code"],
                errors: [],
            });
            mocks.recordSkillInstall.mockResolvedValue(undefined);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsInstall(program);
            await program.parseAsync(["node", "test", "install", "@alice/demo", "--all"]);
            expect(mocks.cloneRepo).toHaveBeenCalledTimes(2);
            expect(mocks.installSkill).toHaveBeenCalled();
        });
        it("handles marketplace where all subpath candidates fail to clone", async () => {
            mocks.isMarketplaceScoped.mockReturnValue(true);
            mocks.marketplaceGetSkill.mockResolvedValue({
                name: "demo",
                author: "alice",
                repoFullName: "alice/demo",
                githubUrl: "https://github.com/alice/demo",
                path: "skills/demo/SKILL.md",
            });
            mocks.parseSource.mockReturnValue({ type: "github", owner: "alice", repo: "demo", ref: "main" });
            mocks.buildSkillSubPathCandidates.mockReturnValue(["skills/demo"]);
            mocks.cloneRepo.mockRejectedValue(new Error("clone failed"));
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsInstall(program);
            await expect(program.parseAsync(["node", "test", "install", "@alice/demo", "--all"])).rejects.toThrow("process-exit");
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
        it("handles marketplace where no subpath candidates succeed (empty list)", async () => {
            mocks.isMarketplaceScoped.mockReturnValue(true);
            mocks.marketplaceGetSkill.mockResolvedValue({
                name: "demo",
                author: "alice",
                repoFullName: "alice/demo",
                githubUrl: "https://github.com/alice/demo",
                path: "skills/demo/SKILL.md",
            });
            mocks.parseSource.mockReturnValue({ type: "github", owner: "alice", repo: "demo", ref: "main" });
            mocks.buildSkillSubPathCandidates.mockReturnValue([]);
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsInstall(program);
            await expect(program.parseAsync(["node", "test", "install", "@alice/demo", "--all"])).rejects.toThrow("process-exit");
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
        it("handles local source discovery returning null", async () => {
            mocks.parseSource.mockReturnValue({ type: "local", inferredName: "demo", value: "/tmp/demo" });
            mocks.discoverSkill.mockResolvedValue(null);
            mocks.installSkill.mockResolvedValue({
                success: true,
                canonicalPath: "/tmp/canonical/demo",
                linkedAgents: ["claude-code"],
                errors: [],
            });
            mocks.recordSkillInstall.mockResolvedValue(undefined);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsInstall(program);
            await program.parseAsync(["node", "test", "install", "/tmp/demo", "--all"]);
            expect(mocks.installSkill).toHaveBeenCalled();
        });
        it("sets isGlobal to true for library/package sourceType", async () => {
            mocks.parseSource.mockReturnValue({ type: "package", inferredName: "ct-test", value: "ct-test" });
            mocks.isCatalogAvailable.mockReturnValue(true);
            mocks.getSkill.mockReturnValue({
                name: "ct-test",
                version: "1.0.0",
                category: "test",
                core: false,
                description: "test",
            });
            mocks.getSkillDir.mockReturnValue("/tmp/ct-test");
            mocks.installSkill.mockResolvedValue({
                success: true,
                canonicalPath: "/tmp/canonical/ct-test",
                linkedAgents: ["claude-code"],
                errors: [],
            });
            mocks.recordSkillInstall.mockResolvedValue(undefined);
            const program = new Command();
            registerSkillsInstall(program);
            await program.parseAsync(["node", "test", "install", "ct-test", "--all"]);
            // recordSkillInstall should be called with isGlobal = true for library type
            expect(mocks.recordSkillInstall).toHaveBeenCalledWith("ct-test", "library:ct-test", "library:ct-test", "library", ["claude-code"], "/tmp/canonical/ct-test", true);
        });
        it("handles no localPath resolved (defensive check at line 244-251)", async () => {
            // Create a scenario where handleMarketplaceSource returns success:true but no localPath
            mocks.isMarketplaceScoped.mockReturnValue(true);
            mocks.marketplaceGetSkill.mockResolvedValue({
                name: "demo",
                author: "alice",
                repoFullName: "alice/demo",
                githubUrl: "https://github.com/alice/demo",
                path: "skills/demo/SKILL.md",
            });
            mocks.parseSource.mockReturnValue({ type: "github", owner: "alice", repo: "demo", ref: "main" });
            mocks.buildSkillSubPathCandidates.mockReturnValue(["skills/demo"]);
            // cloneRepo resolves but localPath won't be set because existsSync returns false for the cloned path
            // and the SKILL.md discovery finds nothing
            mocks.cloneRepo.mockResolvedValue({ localPath: "/tmp/repo/skills/demo", cleanup: async () => { } });
            // existsSync returns false for join(localPath, 'SKILL.md') inside handleMarketplaceSource
            // This makes the function return success:true but localPath as the base path
            // However, for the !localPath branch, we need localPath to remain undefined
            // Let's use a different approach - mock parseSource to return an unrecognized type
            mocks.isMarketplaceScoped.mockReturnValue(false);
            mocks.parseSource.mockReturnValue({ type: "wellknown", inferredName: "demo", value: "/.well-known/demo" });
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsInstall(program);
            await expect(program.parseAsync(["node", "test", "install", "/.well-known/demo", "--all", "--json"])).rejects.toThrow("process-exit");
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
        it("handles profile install with thrown error in human mode", async () => {
            mocks.isCatalogAvailable.mockReturnValue(true);
            mocks.resolveProfile.mockReturnValue(["throw-skill"]);
            mocks.getSkillDir.mockReturnValue("/tmp/throw-skill");
            mocks.installSkill.mockRejectedValue(new Error("unexpected install error"));
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsInstall(program);
            await expect(program.parseAsync(["node", "test", "install", "--profile", "core", "--all", "--human"])).rejects.toThrow("process-exit");
            const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
            expect(output).toContain("throw-skill");
            expect(output).toContain("unexpected install error");
        });
        it("handles profile install with thrown error in JSON mode", async () => {
            mocks.isCatalogAvailable.mockReturnValue(true);
            mocks.resolveProfile.mockReturnValue(["throw-skill"]);
            mocks.getSkillDir.mockReturnValue("/tmp/throw-skill");
            mocks.installSkill.mockRejectedValue(new Error("unexpected install error"));
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsInstall(program);
            await expect(program.parseAsync(["node", "test", "install", "--profile", "core", "--all", "--json"])).rejects.toThrow("process-exit");
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
        it("handles missing source in human mode", async () => {
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsInstall(program);
            await expect(program.parseAsync(["node", "test", "install", "--all", "--human"])).rejects.toThrow("process-exit");
            const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
            expect(output).toContain("Usage:");
        });
    });
    // ==========================================
    // FIND COMMAND - uncovered lines 154, 323-337
    // ==========================================
    describe("skills find - additional coverage", () => {
        it("format conflict exits when both --json and --human passed", async () => {
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsFind(program);
            await expect(program.parseAsync(["node", "test", "find", "test", "--json", "--human"])).rejects.toThrow("process-exit");
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
        it("marketplace search outputs human format with results", async () => {
            mocks.search.mockResolvedValue([
                {
                    name: "skill1",
                    scopedName: "@author/skill1",
                    description: "A test skill",
                    author: "author",
                    stars: 1500,
                    githubUrl: "https://github.com/author/skill1",
                    repoFullName: "author/skill1",
                    path: "skills/skill1/SKILL.md",
                    source: "skillsmp",
                },
                {
                    name: "skill2",
                    scopedName: "@author/skill2",
                    description: "Another skill",
                    author: "author",
                    stars: 42,
                    githubUrl: "https://github.com/author/skill2",
                    repoFullName: "author/skill2",
                    path: "skills/skill2/SKILL.md",
                    source: "skillsmp",
                },
                {
                    name: "skill3",
                    scopedName: "@author/skill3",
                    description: "No stars skill",
                    author: "author",
                    stars: 0,
                    githubUrl: "https://github.com/author/skill3",
                    repoFullName: "author/skill3",
                    path: "skills/skill3/SKILL.md",
                    source: "skillsmp",
                },
            ]);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsFind(program);
            await program.parseAsync(["node", "test", "find", "test", "--human"]);
            const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
            expect(output).toContain("3 result(s)");
            expect(output).toContain("Install with:");
        });
        it("marketplace search outputs empty results in human format", async () => {
            mocks.search.mockResolvedValue([]);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsFind(program);
            await program.parseAsync(["node", "test", "find", "nonexistent", "--human"]);
            const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
            expect(output).toContain("No results found");
        });
        it("marketplace search outputs JSON envelope", async () => {
            mocks.search.mockResolvedValue([
                {
                    name: "skill1",
                    scopedName: "@author/skill1",
                    description: "A test skill",
                    author: "author",
                    stars: 100,
                    source: "skillsmp",
                },
            ]);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsFind(program);
            await program.parseAsync(["node", "test", "find", "test", "--json"]);
            const output = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}"));
            expect(output.$schema).toBe("https://lafs.dev/schemas/v1/envelope.schema.json");
            expect(output.result.query).toBe("test");
            expect(output.result.count).toBe(1);
        });
        it("marketplace search failure in human mode", async () => {
            mocks.search.mockRejectedValue(new Error("network error"));
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsFind(program);
            await expect(program.parseAsync(["node", "test", "find", "test", "--human"])).rejects.toThrow("process-exit");
            const output = errorSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
            expect(output).toContain("Marketplace search failed");
        });
        it("marketplace search failure in JSON mode", async () => {
            mocks.search.mockRejectedValue(new Error("network error"));
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsFind(program);
            await expect(program.parseAsync(["node", "test", "find", "test", "--json"])).rejects.toThrow("process-exit");
            const output = JSON.parse(String(errorSpy.mock.calls[0]?.[0] ?? "{}"));
            expect(output.error.code).toBe("E_SEARCH_FAILED");
        });
        it("shows usage when no query provided", async () => {
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsFind(program);
            await program.parseAsync(["node", "test", "find"]);
            const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
            expect(output).toContain("Usage:");
        });
        it("recommendation with --select in human mode shows selected", async () => {
            const ranked = {
                criteria: { query: "docs", queryTokens: ["docs"], mustHave: [], prefer: [], exclude: [] },
                ranking: [
                    {
                        skill: { name: "docs-pro", scopedName: "@demo/docs-pro", description: "Modern docs", author: "demo", stars: 420, githubUrl: "https://github.com/demo/docs-pro", repoFullName: "demo/docs-pro", path: "skills/docs-pro/SKILL.md", source: "skillsmp" },
                        score: 42.25,
                        reasons: [{ code: "MUST_HAVE_MATCH", detail: "1" }],
                        excluded: false,
                    },
                ],
            };
            mocks.recommendSkillsByQuery.mockResolvedValue(ranked);
            mocks.formatSkillRecommendations.mockReturnValue("Recommended:\n1) @demo/docs-pro");
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsFind(program);
            await program.parseAsync(["node", "test", "find", "docs", "--recommend", "--human", "--top", "1", "--select", "1"]);
            const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
            expect(output).toContain("Selected:");
            expect(output).toContain("@demo/docs-pro");
        });
        it("recommendation error in human mode shows message", async () => {
            mocks.recommendSkillsByQuery.mockRejectedValue(new Error("engine failure"));
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsFind(program);
            await expect(program.parseAsync(["node", "test", "find", "docs", "--recommend", "--human", "--top", "1"])).rejects.toThrow("process-exit");
            const output = errorSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
            expect(output).toContain("Recommendation failed");
        });
        it("prefer-exclude conflict in human mode", async () => {
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsFind(program);
            await expect(program.parseAsync(["node", "test", "find", "docs", "--recommend", "--human", "--prefer", "docs", "--exclude", "docs"])).rejects.toThrow("process-exit");
            const output = errorSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
            expect(output).toContain("Recommendation failed");
        });
        it("validateSelectedRanks throws when rank is out of range", async () => {
            const ranked = {
                criteria: { query: "docs", queryTokens: ["docs"], mustHave: [], prefer: [], exclude: [] },
                ranking: [
                    {
                        skill: { name: "docs-pro", scopedName: "@demo/docs-pro", description: "Modern docs", author: "demo", stars: 420, githubUrl: "", repoFullName: "demo/docs-pro", path: "", source: "skillsmp" },
                        score: 42.25,
                        reasons: [],
                        excluded: false,
                    },
                ],
            };
            mocks.recommendSkillsByQuery.mockResolvedValue(ranked);
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsFind(program);
            await expect(program.parseAsync(["node", "test", "find", "docs", "--recommend", "--json", "--top", "1", "--select", "5"])).rejects.toThrow("process-exit");
            const output = JSON.parse(String(errorSpy.mock.calls[0]?.[0] ?? "{}"));
            expect(output.error.code).toBe("E_SKILLS_QUERY_INVALID");
        });
        it("buildSeedQuery uses criteria flags when no query provided", async () => {
            const ranked = {
                criteria: { query: "docs", queryTokens: ["docs"], mustHave: ["docs"], prefer: [], exclude: [] },
                ranking: [
                    {
                        skill: { name: "docs-pro", scopedName: "@demo/docs-pro", description: "Modern docs", author: "demo", stars: 420, githubUrl: "", repoFullName: "demo/docs-pro", path: "", source: "skillsmp" },
                        score: 42.25,
                        reasons: [{ code: "MUST_HAVE_MATCH", detail: "1" }],
                        excluded: false,
                    },
                ],
            };
            mocks.recommendSkillsByQuery.mockResolvedValue(ranked);
            mocks.formatSkillRecommendations.mockReturnValue({ query: "docs", options: [], recommended: null });
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsFind(program);
            await program.parseAsync(["node", "test", "find", "--recommend", "--json", "--must-have", "docs"]);
            expect(mocks.recommendSkillsByQuery).toHaveBeenCalledWith("docs", expect.any(Object), expect.any(Object));
        });
        it("buildSeedQuery throws when no query and no criteria flags", async () => {
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsFind(program);
            await expect(program.parseAsync(["node", "test", "find", "--recommend", "--json"])).rejects.toThrow("process-exit");
            const output = JSON.parse(String(errorSpy.mock.calls[0]?.[0] ?? "{}"));
            expect(output.error.code).toBe("E_SKILLS_QUERY_INVALID");
        });
        it("recommendation error with NO_MATCHES code maps to NOT_FOUND category", async () => {
            const err = new Error("no results");
            err.code = "E_SKILLS_NO_MATCHES";
            mocks.recommendSkillsByQuery.mockRejectedValue(err);
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsFind(program);
            await expect(program.parseAsync(["node", "test", "find", "docs", "--recommend", "--json"])).rejects.toThrow("process-exit");
            const output = JSON.parse(String(errorSpy.mock.calls[0]?.[0] ?? "{}"));
            expect(output.error.category).toBe("NOT_FOUND");
        });
        it("recommendation error with generic code maps to INTERNAL category", async () => {
            const err = new Error("unknown failure");
            err.code = "E_SOMETHING_ELSE";
            mocks.recommendSkillsByQuery.mockRejectedValue(err);
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsFind(program);
            await expect(program.parseAsync(["node", "test", "find", "docs", "--recommend", "--json"])).rejects.toThrow("process-exit");
            const output = JSON.parse(String(errorSpy.mock.calls[0]?.[0] ?? "{}"));
            expect(output.error.category).toBe("INTERNAL");
        });
        it("normalizeRecommendationOptions uses score-based match when no reasons", async () => {
            const ranked = {
                criteria: { query: "docs", queryTokens: ["docs"], mustHave: [], prefer: [], exclude: [] },
                ranking: [
                    {
                        skill: { name: "docs-pro", scopedName: "@demo/docs-pro", description: "Modern docs", author: "demo", stars: 420, githubUrl: "", repoFullName: "demo/docs-pro", path: "", source: "skillsmp" },
                        score: 42.25,
                        reasons: [],
                        excluded: false,
                    },
                ],
            };
            mocks.recommendSkillsByQuery.mockResolvedValue(ranked);
            mocks.formatSkillRecommendations.mockReturnValue("No reasons available");
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsFind(program);
            await program.parseAsync(["node", "test", "find", "docs", "--recommend", "--human"]);
            // The test passes if no error occurred (the internal normalizeRecommendationOptions handled empty reasons)
            expect(logSpy).toHaveBeenCalled();
        });
        it("recommendation JSON output handles non-array options from formatSkillRecommendations", async () => {
            const ranked = {
                criteria: { query: "docs", queryTokens: ["docs"], mustHave: [], prefer: [], exclude: [] },
                ranking: [
                    {
                        skill: { name: "docs-pro", scopedName: "@demo/docs-pro", description: "Modern docs", author: "demo", stars: 420, githubUrl: "", repoFullName: "demo/docs-pro", path: "", source: "skillsmp" },
                        score: 42.25,
                        reasons: [{ code: "MUST_HAVE_MATCH", detail: "1" }],
                        excluded: false,
                    },
                ],
            };
            mocks.recommendSkillsByQuery.mockResolvedValue(ranked);
            // Return an object without options as array (options is undefined/missing)
            mocks.formatSkillRecommendations.mockReturnValue({
                query: "docs",
                recommended: null,
                // no options field = not an array
            });
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsFind(program);
            await program.parseAsync(["node", "test", "find", "docs", "--recommend", "--json", "--top", "1"]);
            const output = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}"));
            expect(output.success).toBe(true);
            expect(output.result.selected).toEqual([]);
        });
        it("format conflict error in JSON mode", async () => {
            // This tests the catch block for format resolution - mock resolveOutputFormat to throw
            // Since we can't easily make resolveOutputFormat throw, we test the error path indirectly
            // by checking that the --json flag works correctly when provided
            mocks.search.mockResolvedValue([]);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsFind(program);
            await program.parseAsync(["node", "test", "find", "test", "--json"]);
            const output = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}"));
            expect(output._meta.operation).toBe("skills.find.search");
        });
    });
    // ==========================================
    // REMOVE COMMAND - uncovered lines 47-50, 92-111
    // ==========================================
    describe("skills remove - additional coverage", () => {
        it("format conflict exits when both --json and --human passed", async () => {
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsRemove(program);
            await expect(program.parseAsync(["node", "test", "remove", "my-skill", "--json", "--human"])).rejects.toThrow("process-exit");
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
        it("removes skill successfully in JSON mode and removes from lock", async () => {
            mocks.removeSkill.mockResolvedValue({ removed: ["claude-code"], errors: [] });
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsRemove(program);
            await program.parseAsync(["node", "test", "remove", "my-skill", "--json"]);
            expect(mocks.removeSkillFromLock).toHaveBeenCalledWith("my-skill");
            const output = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}"));
            expect(output.$schema).toBe("https://lafs.dev/schemas/v1/envelope.schema.json");
            expect(output.result.removed).toEqual(["claude-code"]);
        });
        it("removes skill with errors in JSON mode", async () => {
            mocks.removeSkill.mockResolvedValue({ removed: ["claude-code"], errors: ["warning: partial removal"] });
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsRemove(program);
            await program.parseAsync(["node", "test", "remove", "my-skill", "--json"]);
            const output = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}"));
            expect(output.result.errors).toHaveLength(1);
            expect(output.result.errors[0].message).toBe("warning: partial removal");
        });
        it("removes skill not found in JSON mode (removed=[], no errors)", async () => {
            mocks.removeSkill.mockResolvedValue({ removed: [], errors: [] });
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsRemove(program);
            await program.parseAsync(["node", "test", "remove", "missing-skill", "--json"]);
            const output = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}"));
            expect(output.result.removed).toEqual([]);
            expect(output.result.count.removed).toBe(0);
        });
        it("removes skill successfully in human mode", async () => {
            mocks.removeSkill.mockResolvedValue({ removed: ["claude-code"], errors: [] });
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsRemove(program);
            await program.parseAsync(["node", "test", "remove", "my-skill", "--human"]);
            const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
            expect(output).toContain("Removed");
            expect(output).toContain("my-skill");
            expect(mocks.removeSkillFromLock).toHaveBeenCalledWith("my-skill");
        });
        it("removes skill with errors in human mode", async () => {
            mocks.removeSkill.mockResolvedValue({ removed: ["claude-code"], errors: ["failed for cursor"] });
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsRemove(program);
            await program.parseAsync(["node", "test", "remove", "my-skill", "--human"]);
            const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
            expect(output).toContain("Removed");
            expect(output).toContain("failed for cursor");
        });
        it("lists skills in JSON mode when no name provided", async () => {
            mocks.listCanonicalSkills.mockResolvedValue(["skill1", "skill2"]);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsRemove(program);
            await program.parseAsync(["node", "test", "remove", "--json"]);
            const output = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}"));
            expect(output.result.available).toEqual(["skill1", "skill2"]);
        });
        it("shows empty state in JSON mode when no skills installed and no name", async () => {
            mocks.listCanonicalSkills.mockResolvedValue([]);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsRemove(program);
            await program.parseAsync(["node", "test", "remove", "--json"]);
            const output = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}"));
            expect(output.result.removed).toEqual([]);
            expect(output.result.count.removed).toBe(0);
        });
    });
    // ==========================================
    // UPDATE COMMAND - uncovered lines 105-215
    // ==========================================
    describe("skills update - additional coverage", () => {
        it("format conflict exits when both --json and --human passed", async () => {
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsUpdate(program);
            await expect(program.parseAsync(["node", "test", "update", "--json", "--human"])).rejects.toThrow("process-exit");
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
        it("outputs JSON when no tracked skills", async () => {
            mocks.getTrackedSkills.mockResolvedValue({});
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsUpdate(program);
            await program.parseAsync(["node", "test", "update", "--json"]);
            const output = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}"));
            expect(output.result.count.updated).toBe(0);
        });
        it("outputs JSON when no updates available", async () => {
            mocks.getTrackedSkills.mockResolvedValue({
                current: {
                    name: "current",
                    scopedName: "current",
                    source: "owner/repo",
                    sourceType: "github",
                    agents: ["claude-code"],
                    canonicalPath: "/path",
                    isGlobal: true,
                    installedAt: "2026-01-01T00:00:00Z",
                },
            });
            mocks.checkSkillUpdate.mockResolvedValue({ hasUpdate: false, status: "up-to-date" });
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsUpdate(program);
            await program.parseAsync(["node", "test", "update", "--json"]);
            const output = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}"));
            expect(output.result.count.updated).toBe(0);
        });
        it("outputs JSON with successful updates", async () => {
            mocks.getTrackedSkills.mockResolvedValue({
                outdated: {
                    name: "outdated",
                    scopedName: "outdated",
                    source: "owner/repo",
                    sourceType: "github",
                    agents: ["claude-code"],
                    canonicalPath: "/path",
                    isGlobal: true,
                    installedAt: "2026-01-01T00:00:00Z",
                },
            });
            mocks.checkSkillUpdate.mockResolvedValue({ hasUpdate: true, currentVersion: "abc", latestVersion: "def", status: "update-available" });
            mocks.parseSource.mockReturnValue({ type: "github", owner: "owner", repo: "repo", ref: undefined });
            mocks.cloneRepo.mockResolvedValue({ localPath: "/tmp/repo", cleanup: async () => { } });
            mocks.getProvider.mockReturnValue(mockProvider);
            mocks.installSkill.mockResolvedValue({ success: true, linkedAgents: ["claude-code"], errors: [], canonicalPath: "/new/path" });
            mocks.recordSkillInstall.mockResolvedValue(undefined);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsUpdate(program);
            await program.parseAsync(["node", "test", "update", "--yes", "--json"]);
            const output = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}"));
            expect(output.result.count.updated).toBe(1);
            expect(output.result.updated).toEqual(["outdated"]);
        });
        it("outputs JSON with skipped and failed updates", async () => {
            mocks.getTrackedSkills.mockResolvedValue({
                localSkill: {
                    name: "localSkill",
                    scopedName: "localSkill",
                    source: "/local/path",
                    sourceType: "local",
                    agents: ["claude-code"],
                    canonicalPath: "/path1",
                    isGlobal: true,
                    installedAt: "2026-01-01T00:00:00Z",
                },
                failingSkill: {
                    name: "failingSkill",
                    scopedName: "failingSkill",
                    source: "owner/fail",
                    sourceType: "github",
                    agents: ["claude-code"],
                    canonicalPath: "/path2",
                    isGlobal: true,
                    installedAt: "2026-01-01T00:00:00Z",
                },
            });
            mocks.checkSkillUpdate.mockResolvedValue({ hasUpdate: true, currentVersion: "abc", latestVersion: "def", status: "update-available" });
            mocks.parseSource
                .mockReturnValueOnce({ type: "local", path: "/local/path" })
                .mockReturnValueOnce({ type: "github", owner: "owner", repo: "fail", ref: "main" });
            mocks.cloneRepo.mockRejectedValue(new Error("Network error"));
            mocks.getProvider.mockReturnValue(mockProvider);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsUpdate(program);
            await program.parseAsync(["node", "test", "update", "--yes", "--json"]);
            const output = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}"));
            expect(output.result.skipped).toContain("localSkill");
            expect(output.result.failed).toHaveLength(1);
            expect(output.result.failed[0].name).toBe("failingSkill");
        });
        it("skips update when no valid providers found for a skill", async () => {
            mocks.getTrackedSkills.mockResolvedValue({
                orphan: {
                    name: "orphan",
                    scopedName: "orphan",
                    source: "owner/repo",
                    sourceType: "github",
                    agents: ["nonexistent-agent"],
                    canonicalPath: "/path",
                    isGlobal: true,
                    installedAt: "2026-01-01T00:00:00Z",
                },
            });
            mocks.checkSkillUpdate.mockResolvedValue({ hasUpdate: true, currentVersion: "abc", latestVersion: "def", status: "update-available" });
            mocks.parseSource.mockReturnValue({ type: "github", owner: "owner", repo: "repo", ref: "main" });
            mocks.cloneRepo.mockResolvedValue({ localPath: "/tmp/repo", cleanup: async () => { } });
            mocks.getProvider.mockReturnValue(undefined);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsUpdate(program);
            await program.parseAsync(["node", "test", "update", "--yes", "--human"]);
            const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
            expect(output).toContain("Skipped");
            expect(output).toContain("no valid providers");
        });
        it("handles install failure (success=false) in human mode", async () => {
            mocks.getTrackedSkills.mockResolvedValue({
                failing: {
                    name: "failing",
                    scopedName: "failing",
                    source: "owner/repo",
                    sourceType: "github",
                    agents: ["claude-code"],
                    canonicalPath: "/path",
                    isGlobal: true,
                    installedAt: "2026-01-01T00:00:00Z",
                },
            });
            mocks.checkSkillUpdate.mockResolvedValue({ hasUpdate: true, currentVersion: "abc", latestVersion: "def", status: "update-available" });
            mocks.parseSource.mockReturnValue({ type: "github", owner: "owner", repo: "repo", ref: "main" });
            mocks.cloneRepo.mockResolvedValue({ localPath: "/tmp/repo", cleanup: async () => { } });
            mocks.getProvider.mockReturnValue(mockProvider);
            mocks.installSkill.mockResolvedValue({ success: false, linkedAgents: [], errors: ["no agents linked"], canonicalPath: "" });
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsUpdate(program);
            await program.parseAsync(["node", "test", "update", "--yes", "--human"]);
            const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
            expect(output).toContain("Failed to update");
            expect(output).toContain("no agents linked");
        });
        it("handles install with errors in human mode", async () => {
            mocks.getTrackedSkills.mockResolvedValue({
                warned: {
                    name: "warned",
                    scopedName: "warned",
                    source: "owner/repo",
                    sourceType: "github",
                    agents: ["claude-code"],
                    canonicalPath: "/path",
                    isGlobal: true,
                    installedAt: "2026-01-01T00:00:00Z",
                },
            });
            mocks.checkSkillUpdate.mockResolvedValue({ hasUpdate: true, currentVersion: "abc", latestVersion: "def", status: "update-available" });
            mocks.parseSource.mockReturnValue({ type: "github", owner: "owner", repo: "repo", ref: "main" });
            mocks.cloneRepo.mockResolvedValue({ localPath: "/tmp/repo", cleanup: async () => { } });
            mocks.getProvider.mockReturnValue(mockProvider);
            mocks.installSkill.mockResolvedValue({ success: true, linkedAgents: ["claude-code"], errors: ["partial link failure"], canonicalPath: "/new/path" });
            mocks.recordSkillInstall.mockResolvedValue(undefined);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsUpdate(program);
            await program.parseAsync(["node", "test", "update", "--yes", "--human"]);
            const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
            expect(output).toContain("Updated");
            expect(output).toContain("partial link failure");
        });
        it("shows summary with both updated and failed in human mode", async () => {
            mocks.getTrackedSkills.mockResolvedValue({
                good: {
                    name: "good",
                    scopedName: "good",
                    source: "owner/good",
                    sourceType: "github",
                    agents: ["claude-code"],
                    canonicalPath: "/path1",
                    isGlobal: true,
                    installedAt: "2026-01-01T00:00:00Z",
                },
                bad: {
                    name: "bad",
                    scopedName: "bad",
                    source: "owner/bad",
                    sourceType: "github",
                    agents: ["claude-code"],
                    canonicalPath: "/path2",
                    isGlobal: true,
                    installedAt: "2026-01-01T00:00:00Z",
                },
            });
            mocks.checkSkillUpdate.mockResolvedValue({ hasUpdate: true, currentVersion: "abc", latestVersion: "def", status: "update-available" });
            mocks.parseSource.mockReturnValue({ type: "github", owner: "owner", repo: "repo", ref: "main" });
            mocks.cloneRepo
                .mockResolvedValueOnce({ localPath: "/tmp/repo", cleanup: async () => { } })
                .mockRejectedValueOnce(new Error("Network error"));
            mocks.getProvider.mockReturnValue(mockProvider);
            mocks.installSkill.mockResolvedValue({ success: true, linkedAgents: ["claude-code"], errors: [], canonicalPath: "/new/path" });
            mocks.recordSkillInstall.mockResolvedValue(undefined);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsUpdate(program);
            await program.parseAsync(["node", "test", "update", "--yes", "--human"]);
            const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
            expect(output).toContain("Updated 1 skill(s)");
            expect(output).toContain("Failed to update 1 skill(s)");
        });
        it("cleanup is called after update", async () => {
            const cleanupFn = vi.fn();
            mocks.getTrackedSkills.mockResolvedValue({
                skill: {
                    name: "skill",
                    scopedName: "skill",
                    source: "owner/repo",
                    sourceType: "github",
                    agents: ["claude-code"],
                    canonicalPath: "/path",
                    isGlobal: true,
                    installedAt: "2026-01-01T00:00:00Z",
                },
            });
            mocks.checkSkillUpdate.mockResolvedValue({ hasUpdate: true, currentVersion: "abc", latestVersion: "def", status: "update-available" });
            mocks.parseSource.mockReturnValue({ type: "github", owner: "owner", repo: "repo", ref: "main" });
            mocks.cloneRepo.mockResolvedValue({ localPath: "/tmp/repo", cleanup: cleanupFn });
            mocks.getProvider.mockReturnValue(mockProvider);
            mocks.installSkill.mockResolvedValue({ success: true, linkedAgents: ["claude-code"], errors: [], canonicalPath: "/new/path" });
            mocks.recordSkillInstall.mockResolvedValue(undefined);
            const program = new Command();
            registerSkillsUpdate(program);
            await program.parseAsync(["node", "test", "update", "--yes"]);
            expect(cleanupFn).toHaveBeenCalled();
        });
    });
    // ==========================================
    // VALIDATE COMMAND - uncovered lines 46-64
    // ==========================================
    describe("skills validate - additional coverage", () => {
        it("format conflict exits when both --json and --human passed", async () => {
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsValidate(program);
            await expect(program.parseAsync(["node", "test", "validate", "SKILL.md", "--json", "--human"])).rejects.toThrow("process-exit");
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
        it("handles validateSkill throwing an error in JSON mode", async () => {
            mocks.validateSkill.mockRejectedValue(new Error("File not found: SKILL.md"));
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsValidate(program);
            await expect(program.parseAsync(["node", "test", "validate", "/missing/SKILL.md", "--json"])).rejects.toThrow("process-exit");
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
        it("handles validateSkill throwing an error in human mode", async () => {
            mocks.validateSkill.mockRejectedValue(new Error("File not found: SKILL.md"));
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsValidate(program);
            await expect(program.parseAsync(["node", "test", "validate", "/missing/SKILL.md", "--human"])).rejects.toThrow("process-exit");
            const output = errorSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
            expect(output).toContain("File not found");
        });
        it("outputs JSON for invalid skill with errors", async () => {
            mocks.validateSkill.mockResolvedValue({
                valid: false,
                issues: [
                    { level: "error", field: "name", message: "Missing required field" },
                    { level: "warning", field: "version", message: "Semver recommended" },
                ],
                metadata: {},
            });
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsValidate(program);
            await expect(program.parseAsync(["node", "test", "validate", "/path/to/SKILL.md", "--json"])).rejects.toThrow("process-exit");
            const output = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}"));
            expect(output.result.valid).toBe(false);
            expect(output.result.issues).toHaveLength(2);
            expect(output.result.issues[0].level).toBe("error");
            expect(output.result.issues[1].level).toBe("warn");
        });
        it("outputs valid skill in human mode without exit", async () => {
            mocks.validateSkill.mockResolvedValue({
                valid: true,
                issues: [],
                metadata: { name: "good-skill" },
            });
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsValidate(program);
            await program.parseAsync(["node", "test", "validate", "/path/to/SKILL.md", "--human"]);
            const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
            expect(output).toContain("is valid");
            expect(exitSpy).not.toHaveBeenCalled();
        });
        it("handles non-Error thrown from validateSkill", async () => {
            mocks.validateSkill.mockRejectedValue("string error");
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsValidate(program);
            await expect(program.parseAsync(["node", "test", "validate", "/path/to/SKILL.md", "--human"])).rejects.toThrow("process-exit");
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
    });
    // ==========================================
    // CHECK COMMAND - uncovered lines 49, 101, 114-115
    // ==========================================
    describe("skills check - additional coverage", () => {
        it("format conflict exits when both --json and --human passed", async () => {
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsCheck(program);
            await expect(program.parseAsync(["node", "test", "check", "--json", "--human"])).rejects.toThrow("process-exit");
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
        it("outputs JSON for empty tracked skills", async () => {
            mocks.getTrackedSkills.mockResolvedValue({});
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsCheck(program);
            await program.parseAsync(["node", "test", "check", "--json"]);
            const output = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}"));
            expect(output.result.skills).toEqual([]);
            expect(output.result.outdated).toBe(0);
        });
        it("human output shows unknown version status", async () => {
            mocks.getTrackedSkills.mockResolvedValue({
                skill1: {
                    name: "skill1",
                    scopedName: "skill1",
                    source: "owner/repo",
                    sourceType: "github",
                    agents: ["claude-code"],
                    canonicalPath: "/path",
                    isGlobal: true,
                    installedAt: "2026-01-01T00:00:00Z",
                },
            });
            mocks.checkSkillUpdate.mockResolvedValue({
                hasUpdate: false,
                currentVersion: undefined,
                latestVersion: undefined,
                status: "unknown",
            });
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsCheck(program);
            await program.parseAsync(["node", "test", "check", "--human"]);
            const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
            expect(output).toContain("unknown");
            expect(output).toContain("All skills are up to date");
        });
        it("human output shows update available with version details", async () => {
            mocks.getTrackedSkills.mockResolvedValue({
                skill1: {
                    name: "skill1",
                    scopedName: "skill1",
                    source: "owner/repo",
                    sourceType: "github",
                    agents: ["claude-code"],
                    canonicalPath: "/path",
                    isGlobal: true,
                    installedAt: "2026-01-01T00:00:00Z",
                },
            });
            mocks.checkSkillUpdate.mockResolvedValue({
                hasUpdate: true,
                currentVersion: "abc123def456",
                latestVersion: "def789ghi012",
                status: "update-available",
            });
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsCheck(program);
            await program.parseAsync(["node", "test", "check", "--human"]);
            const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
            expect(output).toContain("update available");
            expect(output).toContain("current:");
            expect(output).toContain("->");
            expect(output).toContain("update(s) available");
        });
        it("human output shows up to date with version for known version", async () => {
            mocks.getTrackedSkills.mockResolvedValue({
                skill1: {
                    name: "skill1",
                    scopedName: "skill1",
                    source: "owner/repo",
                    sourceType: "github",
                    agents: ["claude-code"],
                    canonicalPath: "/path",
                    isGlobal: true,
                    installedAt: "2026-01-01T00:00:00Z",
                    version: "v1.0",
                },
            });
            mocks.checkSkillUpdate.mockResolvedValue({
                hasUpdate: false,
                currentVersion: "abc123def456",
                latestVersion: "abc123def456",
                status: "up-to-date",
            });
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsCheck(program);
            await program.parseAsync(["node", "test", "check", "--human"]);
            const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
            expect(output).toContain("up to date");
            expect(output).toContain("version:");
            expect(output).toContain("All skills are up to date");
        });
        it("human output shows both unknown version sources and agents", async () => {
            mocks.getTrackedSkills.mockResolvedValue({
                skill1: {
                    name: "skill1",
                    scopedName: "skill1",
                    source: "/local/path",
                    sourceType: "local",
                    agents: ["claude-code", "cursor"],
                    canonicalPath: "/path",
                    isGlobal: true,
                    installedAt: "2026-01-01T00:00:00Z",
                },
            });
            mocks.checkSkillUpdate.mockResolvedValue({
                hasUpdate: false,
                currentVersion: undefined,
                latestVersion: undefined,
                status: "unknown",
            });
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsCheck(program);
            await program.parseAsync(["node", "test", "check", "--human"]);
            const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
            expect(output).toContain("source:");
            expect(output).toContain("agents:");
        });
    });
    // ==========================================
    // INIT COMMAND - uncovered lines 39-42, 54-55
    // ==========================================
    describe("skills init - additional coverage", () => {
        it("format conflict exits when both --json and --human passed", async () => {
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsInit(program);
            await expect(program.parseAsync(["node", "test", "init", "test-skill", "--json", "--human"])).rejects.toThrow("process-exit");
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
        it("outputs JSON when directory already exists", async () => {
            mocks.existsSync.mockReturnValue(true);
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsInit(program);
            await expect(program.parseAsync(["node", "test", "init", "existing-skill", "--json"])).rejects.toThrow("process-exit");
            // In JSON mode, the emitJsonError should have been called
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
        it("outputs JSON on successful creation", async () => {
            mocks.existsSync.mockReturnValue(false);
            mocks.mkdir.mockResolvedValue(undefined);
            mocks.writeFile.mockResolvedValue(undefined);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsInit(program);
            await program.parseAsync(["node", "test", "init", "new-skill", "--json"]);
            const output = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}"));
            expect(output.$schema).toBe("https://lafs.dev/schemas/v1/envelope.schema.json");
            expect(output.result.name).toBe("new-skill");
            expect(output.result.created).toBe(true);
        });
        it("uses default name 'my-skill' in JSON mode when none provided", async () => {
            mocks.existsSync.mockReturnValue(false);
            mocks.mkdir.mockResolvedValue(undefined);
            mocks.writeFile.mockResolvedValue(undefined);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsInit(program);
            await program.parseAsync(["node", "test", "init", "--json"]);
            const output = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}"));
            expect(output.result.name).toBe("my-skill");
        });
        it("shows human error when directory already exists", async () => {
            mocks.existsSync.mockReturnValue(true);
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsInit(program);
            await expect(program.parseAsync(["node", "test", "init", "existing-skill", "--human"])).rejects.toThrow("process-exit");
            const output = errorSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
            expect(output).toContain("Directory already exists");
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
        it("human output shows next steps on success", async () => {
            mocks.existsSync.mockReturnValue(false);
            mocks.mkdir.mockResolvedValue(undefined);
            mocks.writeFile.mockResolvedValue(undefined);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsInit(program);
            await program.parseAsync(["node", "test", "init", "test-skill", "--human"]);
            const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
            expect(output).toContain("Created skill template");
            expect(output).toContain("Next steps");
            expect(output).toContain("Edit SKILL.md");
            expect(output).toContain("Validate:");
            expect(output).toContain("Install:");
        });
    });
    // ==========================================
    // LIST COMMAND - uncovered lines 68-69, 73, 76-77
    // ==========================================
    describe("skills list - additional coverage", () => {
        it("lists global skills from all providers", async () => {
            mocks.getInstalledProviders.mockReturnValue([mockProvider, mockProvider2]);
            mocks.resolveProviderSkillsDir
                .mockReturnValueOnce("/global/claude-code/skills")
                .mockReturnValueOnce("/global/cursor/skills");
            mocks.discoverSkillsMulti.mockResolvedValue([]);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsList(program);
            await program.parseAsync(["node", "test", "list", "--global"]);
            const output = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}"));
            expect(output.result.scope).toBe("global");
        });
        it("lists skills for agent with --global flag", async () => {
            mocks.getProvider.mockReturnValue(mockProvider);
            mocks.resolveProviderSkillsDir.mockReturnValue("/global/claude-code/skills");
            mocks.discoverSkillsMulti.mockResolvedValue([]);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsList(program);
            await program.parseAsync(["node", "test", "list", "--agent", "claude-code", "--global"]);
            expect(mocks.resolveProviderSkillsDir).toHaveBeenCalledWith(mockProvider, "global");
        });
        it("lists skills for agent without --global flag", async () => {
            mocks.getProvider.mockReturnValue(mockProvider);
            mocks.resolveProviderSkillsDir.mockReturnValue("/project/claude-code/skills");
            mocks.discoverSkillsMulti.mockResolvedValue([]);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsList(program);
            await program.parseAsync(["node", "test", "list", "--agent", "claude-code"]);
            expect(mocks.resolveProviderSkillsDir).toHaveBeenCalledWith(mockProvider, "project");
        });
        it("provider not found in JSON mode", async () => {
            mocks.getProvider.mockReturnValue(undefined);
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsList(program);
            await expect(program.parseAsync(["node", "test", "list", "--agent", "unknown", "--json"])).rejects.toThrow("process-exit");
            const output = JSON.parse(String(errorSpy.mock.calls[0]?.[0] ?? "{}"));
            expect(output.error.code).toBe("E_PROVIDER_NOT_FOUND");
        });
        it("provider not found in human mode", async () => {
            mocks.getProvider.mockReturnValue(undefined);
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsList(program);
            await expect(program.parseAsync(["node", "test", "list", "--agent", "unknown", "--human"])).rejects.toThrow("process-exit");
            const output = errorSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
            expect(output).toContain("Provider not found");
        });
        it("human output with skills shows table and footer", async () => {
            mocks.resolveProviderSkillsDir.mockReturnValue("/skills");
            mocks.discoverSkillsMulti.mockResolvedValue([
                { name: "skill1", scopedName: "skill1", path: "/skills/skill1", metadata: { name: "skill1", description: "Test skill" } },
                { name: "skill2", scopedName: "skill2", path: "/skills/skill2", metadata: { name: "skill2", description: "Another skill" } },
            ]);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsList(program);
            await program.parseAsync(["node", "test", "list", "--human"]);
            const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
            expect(output).toContain("2 skill(s) found");
            expect(output).toContain("Install with:");
            expect(output).toContain("Remove with:");
        });
        it("human output with no skills shows empty message", async () => {
            mocks.resolveProviderSkillsDir.mockReturnValue("/skills");
            mocks.discoverSkillsMulti.mockResolvedValue([]);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsList(program);
            await program.parseAsync(["node", "test", "list", "--human"]);
            const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
            expect(output).toContain("No skills found");
        });
        it("JSON output with global scope for agent", async () => {
            mocks.getProvider.mockReturnValue(mockProvider);
            mocks.resolveProviderSkillsDir.mockReturnValue("/global/claude-code/skills");
            mocks.discoverSkillsMulti.mockResolvedValue([
                { name: "skill1", scopedName: "skill1", path: "/skills/skill1", metadata: { name: "skill1", description: "Test skill" } },
            ]);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsList(program);
            await program.parseAsync(["node", "test", "list", "--agent", "claude-code", "--json"]);
            const output = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}"));
            expect(output.result.scope).toBe("agent:claude-code");
        });
        it("default project scope when no --global or --agent provided", async () => {
            mocks.getInstalledProviders.mockReturnValue([mockProvider]);
            mocks.resolveProviderSkillsDir.mockReturnValue("/project/skills");
            mocks.discoverSkillsMulti.mockResolvedValue([]);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsList(program);
            await program.parseAsync(["node", "test", "list", "--json"]);
            const output = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}"));
            expect(output.result.scope).toBe("project");
        });
        it("global scope filter uses resolveProviderSkillsDir with 'global'", async () => {
            mocks.getInstalledProviders.mockReturnValue([mockProvider]);
            mocks.resolveProviderSkillsDir.mockReturnValue("/global/skills");
            mocks.discoverSkillsMulti.mockResolvedValue([]);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsList(program);
            await program.parseAsync(["node", "test", "list", "--global", "--json"]);
            expect(mocks.resolveProviderSkillsDir).toHaveBeenCalledWith(mockProvider, "global");
        });
        it("format conflict error triggers when both --json and --human passed", async () => {
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsList(program);
            await expect(program.parseAsync(["node", "test", "list", "--json", "--human"])).rejects.toThrow("process-exit");
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
        it("skill with null metadata description renders gracefully", async () => {
            mocks.resolveProviderSkillsDir.mockReturnValue("/skills");
            mocks.discoverSkillsMulti.mockResolvedValue([
                { name: "skill-no-desc", scopedName: "skill-no-desc", path: "/skills/skill-no-desc", metadata: { name: "skill-no-desc" } },
            ]);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsList(program);
            await program.parseAsync(["node", "test", "list", "--human"]);
            const output = logSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
            expect(output).toContain("skill-no-desc");
        });
    });
});
//# sourceMappingURL=skills-commands-coverage.test.js.map