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
vi.mock("../../src/core/skills/discovery.js", () => ({
    discoverSkillsMulti: mocks.discoverSkillsMulti,
}));
vi.mock("../../src/core/paths/standard.js", () => ({
    resolveProviderSkillsDir: mocks.resolveProviderSkillsDir,
}));
vi.mock("../../src/core/skills/validator.js", () => ({
    validateSkill: mocks.validateSkill,
}));
// Import after mocks
import { registerSkillsAudit } from "../../src/commands/skills/audit.js";
import { registerSkillsCheck } from "../../src/commands/skills/check.js";
import { registerSkillsCommands } from "../../src/commands/skills/index.js";
import { registerSkillsInit } from "../../src/commands/skills/init.js";
import { registerSkillsList } from "../../src/commands/skills/list.js";
import { registerSkillsRemove } from "../../src/commands/skills/remove.js";
import { registerSkillsUpdate } from "../../src/commands/skills/update.js";
import { registerSkillsValidate } from "../../src/commands/skills/validate.js";
const mockProvider = {
    id: "claude-code",
    toolName: "Claude Code",
    pathGlobal: "/global",
    pathProject: "/project",
};
describe("integration: skills command wrappers", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        Object.values(mocks).forEach((mock) => mock?.mockReset?.());
        mocks.existsSync.mockReturnValue(true);
        mocks.getInstalledProviders.mockReturnValue([mockProvider]);
        mocks.getProvider.mockReturnValue(mockProvider);
        mocks.removeSkillFromLock.mockResolvedValue(true);
    });
    describe("skills audit", () => {
        it("scans a single file and outputs human-readable results", async () => {
            mocks.statSync.mockReturnValue({ isFile: () => true });
            mocks.scanFile.mockResolvedValue({
                file: "/path/to/SKILL.md",
                findings: [],
                score: 100,
                passed: true,
            });
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsAudit(program);
            await program.parseAsync(["node", "test", "audit", "/path/to/SKILL.md", "--human"]);
            expect(mocks.scanFile).toHaveBeenCalledWith("/path/to/SKILL.md");
            const output = logSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
            expect(output).toContain("file(s) scanned");
        });
        it("scans a directory for all SKILL.md files", async () => {
            mocks.statSync.mockReturnValue({ isFile: () => false });
            mocks.scanDirectory.mockResolvedValue([
                {
                    file: "/skills/skill1/SKILL.md",
                    findings: [{ rule: { id: "TEST", severity: "medium" }, line: 10, context: "test" }],
                    score: 92,
                    passed: true,
                },
            ]);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsAudit(program);
            await program.parseAsync(["node", "test", "audit", "/skills"]);
            expect(mocks.scanDirectory).toHaveBeenCalledWith("/skills");
            expect(logSpy).toHaveBeenCalled();
        });
        it("outputs SARIF format when --sarif flag is provided", async () => {
            const sarifOutput = { $schema: "https://sarif...", version: "2.1.0" };
            mocks.statSync.mockReturnValue({ isFile: () => true });
            mocks.scanFile.mockResolvedValue({ file: "test.md", findings: [], score: 100, passed: true });
            mocks.toSarif.mockReturnValue(sarifOutput);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsAudit(program);
            await program.parseAsync(["node", "test", "audit", "--sarif", "test.md"]);
            expect(mocks.toSarif).toHaveBeenCalled();
            const output = logSpy.mock.calls[0]?.[0];
            expect(JSON.parse(String(output))).toEqual(sarifOutput);
        });
        it("outputs JSON format when --json flag is provided", async () => {
            const result = { file: "test.md", findings: [], score: 100, passed: true };
            mocks.statSync.mockReturnValue({ isFile: () => true });
            mocks.scanFile.mockResolvedValue(result);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsAudit(program);
            await program.parseAsync(["node", "test", "audit", "--json", "test.md"]);
            const output = logSpy.mock.calls[0]?.[0];
            const envelope = JSON.parse(String(output));
            // Audit command outputs LAFS envelope with summary in result
            expect(envelope.$schema).toBe("https://lafs.dev/schemas/v1/envelope.schema.json");
            expect(envelope.success).toBe(true);
            expect(envelope.result.scanned).toBe(1);
            expect(envelope.result.findings).toBe(0);
            expect(envelope.result.files).toHaveLength(1);
            expect(envelope.result.files[0].path).toBe("test.md");
            expect(envelope.result.files[0].score).toBe(100);
        });
        it("exits with error when path does not exist", async () => {
            mocks.existsSync.mockReturnValue(false);
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsAudit(program);
            await expect(program.parseAsync(["node", "test", "audit", "/nonexistent"])).rejects.toThrow("process-exit");
            expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Path not found"));
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
        it("exits with error when audit fails (critical/high findings)", async () => {
            mocks.statSync.mockReturnValue({ isFile: () => true });
            mocks.scanFile.mockResolvedValue({
                file: "test.md",
                findings: [{ rule: { id: "CI001", severity: "critical" }, line: 1, context: "rm -rf /" }],
                score: 75,
                passed: false,
            });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => { }));
            const program = new Command();
            registerSkillsAudit(program);
            await program.parseAsync(["node", "test", "audit", "test.md"]);
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
        it("handles empty scan results gracefully", async () => {
            mocks.statSync.mockReturnValue({ isFile: () => false });
            mocks.scanDirectory.mockResolvedValue([]);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsAudit(program);
            await program.parseAsync(["node", "test", "audit", "/empty", "--human"]);
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("No SKILL.md files found"));
        });
    });
    describe("skills check", () => {
        it("checks for updates and outputs human-readable results", async () => {
            mocks.getTrackedSkills.mockResolvedValue({
                "my-skill": {
                    name: "my-skill",
                    scopedName: "my-skill",
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
            expect(mocks.checkSkillUpdate).toHaveBeenCalledWith("my-skill");
            const output = logSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
            expect(output).toContain("update available");
        });
        it("outputs JSON when --json flag is provided", async () => {
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
                currentVersion: "abc123",
                latestVersion: "abc123",
                status: "up-to-date",
            });
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsCheck(program);
            await program.parseAsync(["node", "test", "check", "--json"]);
            // In JSON mode, output is a LAFS envelope (no "Checking..." preamble)
            const output = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}"));
            expect(output.$schema).toBe("https://lafs.dev/schemas/v1/envelope.schema.json");
            expect(output.result.skills).toHaveLength(1);
            expect(output.result.skills[0]?.hasUpdate).toBe(false);
            expect(output.result.outdated).toBe(0);
        });
        it("handles no tracked skills gracefully", async () => {
            mocks.getTrackedSkills.mockResolvedValue({});
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsCheck(program);
            await program.parseAsync(["node", "test", "check", "--human"]);
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("No tracked skills"));
        });
        it("shows all skills up to date message when no updates available", async () => {
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
                status: "up-to-date",
            });
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsCheck(program);
            await program.parseAsync(["node", "test", "check", "--human"]);
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("All skills are up to date"));
        });
    });
    describe("skills init", () => {
        it("creates a new skill template with provided name", async () => {
            mocks.existsSync.mockReturnValue(false);
            mocks.mkdir.mockResolvedValue(undefined);
            mocks.writeFile.mockResolvedValue(undefined);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsInit(program);
            await program.parseAsync(["node", "test", "init", "my-awesome-skill", "--human"]);
            expect(mocks.mkdir).toHaveBeenCalledWith(expect.stringContaining("my-awesome-skill"), { recursive: true });
            expect(mocks.writeFile).toHaveBeenCalled();
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Created skill template"));
        });
        it("creates skill with default name when none provided", async () => {
            mocks.existsSync.mockReturnValue(false);
            mocks.mkdir.mockResolvedValue(undefined);
            mocks.writeFile.mockResolvedValue(undefined);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsInit(program);
            await program.parseAsync(["node", "test", "init"]);
            expect(mocks.mkdir).toHaveBeenCalledWith(expect.stringContaining("my-skill"), { recursive: true });
        });
        it("exits with error when directory already exists", async () => {
            mocks.existsSync.mockReturnValue(true);
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsInit(program);
            await expect(program.parseAsync(["node", "test", "init", "existing-skill"])).rejects.toThrow("process-exit");
            expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Directory already exists"));
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
        it.skip("uses custom directory with --dir option", async () => {
            mocks.existsSync.mockReturnValue(false);
            mocks.mkdir.mockResolvedValue(undefined);
            mocks.writeFile.mockResolvedValue(undefined);
            const program = new Command();
            registerSkillsInit(program);
            await program.parseAsync(["node", "test", "init", "test-skill", "--dir", "/custom/path"]);
            expect(mocks.mkdir).toHaveBeenCalledWith(expect.stringContaining("/custom/path"), { recursive: true });
        });
    });
    describe("skills list", () => {
        it("lists all installed skills in human-readable format", async () => {
            mocks.resolveProviderSkillsDir.mockReturnValue("/skills");
            mocks.discoverSkillsMulti.mockResolvedValue([
                { name: "skill1", scopedName: "skill1", path: "/skills/skill1", metadata: { name: "skill1", description: "Test skill" } },
                { name: "skill2", scopedName: "skill2", path: "/skills/skill2", metadata: { name: "skill2", description: "Another skill" } },
            ]);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsList(program);
            await program.parseAsync(["node", "test", "list", "--human"]);
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("2 skill(s) found"));
        });
        it("outputs JSON (LAFS envelope) by default", async () => {
            const skills = [
                { name: "skill1", scopedName: "skill1", path: "/path", metadata: { name: "skill1", description: "Test" } },
            ];
            mocks.resolveProviderSkillsDir.mockReturnValue("/skills");
            mocks.discoverSkillsMulti.mockResolvedValue(skills);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsList(program);
            await program.parseAsync(["node", "test", "list"]);
            const output = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}"));
            expect(output.$schema).toBe("https://lafs.dev/schemas/v1/envelope.schema.json");
            expect(output._meta.operation).toBe("skills.list");
            expect(output.result.skills).toEqual(skills);
            expect(output.result.count).toBe(1);
        });
        it.skip("lists global skills with --global flag", async () => {
            mocks.resolveProviderSkillsDir.mockReturnValue("/global/skills");
            mocks.discoverSkillsMulti.mockResolvedValue([]);
            const program = new Command();
            registerSkillsList(program);
            await program.parseAsync(["node", "test", "list", "--global"]);
            expect(mocks.resolveProviderSkillsDir).toHaveBeenCalledWith(mockProvider, "global");
        });
        it("lists skills for specific agent with --agent flag", async () => {
            mocks.resolveProviderSkillsDir.mockReturnValue("/agent/skills");
            mocks.discoverSkillsMulti.mockResolvedValue([]);
            const program = new Command();
            registerSkillsList(program);
            await program.parseAsync(["node", "test", "list", "--agent", "claude-code"]);
            expect(mocks.getProvider).toHaveBeenCalledWith("claude-code");
        });
        it("exits with error when provider not found", async () => {
            mocks.getProvider.mockReturnValue(undefined);
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsList(program);
            await expect(program.parseAsync(["node", "test", "list", "--agent", "unknown"])).rejects.toThrow("process-exit");
            expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Provider not found"));
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
        it("shows empty state in JSON by default when no skills found", async () => {
            mocks.resolveProviderSkillsDir.mockReturnValue("/skills");
            mocks.discoverSkillsMulti.mockResolvedValue([]);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsList(program);
            await program.parseAsync(["node", "test", "list"]);
            const output = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}"));
            expect(output.result.skills).toEqual([]);
            expect(output.result.count).toBe(0);
        });
        it("shows empty state in human format with --human flag", async () => {
            mocks.resolveProviderSkillsDir.mockReturnValue("/skills");
            mocks.discoverSkillsMulti.mockResolvedValue([]);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsList(program);
            await program.parseAsync(["node", "test", "list", "--human"]);
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("No skills found"));
        });
    });
    describe("skills remove", () => {
        it.skip("removes a skill by name", async () => {
            mocks.removeSkill.mockResolvedValue({ removed: ["claude-code"], errors: [] });
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsRemove(program);
            await program.parseAsync(["node", "test", "remove", "my-skill"]);
            expect(mocks.removeSkill).toHaveBeenCalledWith("my-skill", [mockProvider], false);
            expect(mocks.removeSkillFromLock).toHaveBeenCalledWith("my-skill");
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Removed"));
        });
        it("handles skill not found gracefully", async () => {
            mocks.removeSkill.mockResolvedValue({ removed: [], errors: [] });
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsRemove(program);
            await program.parseAsync(["node", "test", "remove", "missing-skill", "--human"]);
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("not found"));
        });
        it("displays errors when removal fails", async () => {
            mocks.removeSkill.mockResolvedValue({ removed: [], errors: ["Permission denied"] });
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsRemove(program);
            await program.parseAsync(["node", "test", "remove", "failing-skill"]);
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Permission denied"));
        });
        it("lists installed skills when no name provided", async () => {
            mocks.listCanonicalSkills.mockResolvedValue(["skill1", "skill2"]);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsRemove(program);
            await program.parseAsync(["node", "test", "remove", "--human"]);
            expect(mocks.listCanonicalSkills).toHaveBeenCalled();
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Installed skills"));
        });
        it("shows empty state when no skills installed", async () => {
            mocks.listCanonicalSkills.mockResolvedValue([]);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsRemove(program);
            await program.parseAsync(["node", "test", "remove", "--human"]);
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("No skills installed"));
        });
        it.skip("passes global flag to removeSkill", async () => {
            mocks.removeSkill.mockResolvedValue({ removed: ["claude-code"], errors: [] });
            const program = new Command();
            registerSkillsRemove(program);
            await program.parseAsync(["node", "test", "remove", "my-skill", "--global"]);
            expect(mocks.removeSkill).toHaveBeenCalledWith("my-skill", [mockProvider], true);
        });
    });
    describe("skills update", () => {
        it("checks for updates and shows available updates", async () => {
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
            mocks.checkSkillUpdate.mockResolvedValue({
                hasUpdate: true,
                currentVersion: "abc123",
                latestVersion: "def456",
                status: "update-available",
            });
            mocks.parseSource.mockReturnValue({ type: "github", owner: "owner", repo: "repo", ref: undefined });
            mocks.cloneRepo.mockResolvedValue({ localPath: "/tmp/repo", cleanup: async () => { } });
            mocks.installSkill.mockResolvedValue({ success: true, linkedAgents: ["claude-code"], errors: [], canonicalPath: "/new/path" });
            mocks.getProvider.mockReturnValue({ id: "claude-code", toolName: "Claude Code" });
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsUpdate(program);
            await program.parseAsync(["node", "test", "update", "--yes", "--human"]);
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("have updates available"));
        });
        it("shows up to date message when no updates", async () => {
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
            mocks.checkSkillUpdate.mockResolvedValue({
                hasUpdate: false,
                status: "up-to-date",
            });
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsUpdate(program);
            await program.parseAsync(["node", "test", "update", "--human"]);
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("All skills are up to date"));
        });
        it("handles no tracked skills", async () => {
            mocks.getTrackedSkills.mockResolvedValue({});
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsUpdate(program);
            await program.parseAsync(["node", "test", "update", "--human"]);
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("No tracked skills to update"));
        });
        it("skips confirmation with --yes flag", async () => {
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
                currentVersion: "abc123",
                latestVersion: "def456",
                status: "update-available",
            });
            mocks.parseSource.mockReturnValue({ type: "github", owner: "owner", repo: "repo", ref: undefined });
            mocks.cloneRepo.mockResolvedValue({ localPath: "/tmp/repo", cleanup: async () => { } });
            mocks.installSkill.mockResolvedValue({ success: true, linkedAgents: ["claude-code"], errors: [], canonicalPath: "/new/path" });
            const program = new Command();
            registerSkillsUpdate(program);
            await program.parseAsync(["node", "test", "update", "--yes"]);
            expect(mocks.cloneRepo).toHaveBeenCalled();
        });
        it("handles unsupported source types gracefully", async () => {
            mocks.getTrackedSkills.mockResolvedValue({
                local: {
                    name: "local",
                    scopedName: "local",
                    source: "/local/path",
                    sourceType: "local",
                    agents: ["claude-code"],
                    canonicalPath: "/path",
                    isGlobal: true,
                    installedAt: "2026-01-01T00:00:00Z",
                },
            });
            mocks.checkSkillUpdate.mockResolvedValue({
                hasUpdate: true,
                currentVersion: "abc123",
                latestVersion: "def456",
                status: "update-available",
            });
            mocks.parseSource.mockReturnValue({ type: "local", path: "/local/path" });
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsUpdate(program);
            await program.parseAsync(["node", "test", "update", "--yes", "--human"]);
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("does not support auto-update"));
        });
        it("handles update failures gracefully", async () => {
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
            mocks.checkSkillUpdate.mockResolvedValue({
                hasUpdate: true,
                currentVersion: "abc123",
                latestVersion: "def456",
                status: "update-available",
            });
            mocks.parseSource.mockReturnValue({ type: "github", owner: "owner", repo: "repo", ref: undefined });
            mocks.cloneRepo.mockRejectedValue(new Error("Network error"));
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsUpdate(program);
            await program.parseAsync(["node", "test", "update", "--yes", "--human"]);
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to update"));
        });
        it("supports GitLab repos for updates", async () => {
            mocks.getTrackedSkills.mockResolvedValue({
                gitlab: {
                    name: "gitlab",
                    scopedName: "gitlab",
                    source: "gitlab.com/owner/repo",
                    sourceType: "gitlab",
                    agents: ["claude-code"],
                    canonicalPath: "/path",
                    isGlobal: true,
                    installedAt: "2026-01-01T00:00:00Z",
                },
            });
            mocks.checkSkillUpdate.mockResolvedValue({
                hasUpdate: true,
                currentVersion: "abc123",
                latestVersion: "def456",
                status: "update-available",
            });
            mocks.parseSource.mockReturnValue({ type: "gitlab", owner: "owner", repo: "repo", ref: undefined });
            mocks.cloneGitLabRepo.mockResolvedValue({ localPath: "/tmp/repo", cleanup: async () => { } });
            mocks.installSkill.mockResolvedValue({ success: true, linkedAgents: ["claude-code"], errors: [], canonicalPath: "/new/path" });
            const program = new Command();
            registerSkillsUpdate(program);
            await program.parseAsync(["node", "test", "update", "--yes"]);
            expect(mocks.cloneGitLabRepo).toHaveBeenCalled();
        });
    });
    describe("skills validate", () => {
        it("validates a skill file and outputs success", async () => {
            mocks.validateSkill.mockResolvedValue({
                valid: true,
                issues: [],
                metadata: { name: "test", description: "Test skill" },
            });
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsValidate(program);
            await program.parseAsync(["node", "test", "validate", "/path/to/SKILL.md", "--human"]);
            expect(mocks.validateSkill).toHaveBeenCalledWith("/path/to/SKILL.md");
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("is valid"));
        });
        it("outputs validation errors and exits non-zero", async () => {
            mocks.validateSkill.mockResolvedValue({
                valid: false,
                issues: [
                    { level: "error", field: "name", message: "Missing required field" },
                ],
                metadata: {},
            });
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsValidate(program);
            await expect(program.parseAsync(["node", "test", "validate", "/path/to/SKILL.md", "--human"])).rejects.toThrow("process-exit");
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("validation errors"));
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
        it("outputs JSON when --json flag is provided", async () => {
            const result = { valid: true, issues: [], metadata: { name: "test" } };
            mocks.validateSkill.mockResolvedValue(result);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsValidate(program);
            await program.parseAsync(["node", "test", "validate", "--json", "/path/to/SKILL.md"]);
            const output = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}"));
            // Validate command outputs LAFS envelope wrapping the result
            expect(output.$schema).toBe("https://lafs.dev/schemas/v1/envelope.schema.json");
            expect(output.success).toBe(true);
            expect(output.result.valid).toBe(true);
            expect(output.result.file).toBe("/path/to/SKILL.md");
            expect(output.result.issues).toEqual([]);
        });
        it("uses default SKILL.md path when none provided", async () => {
            mocks.validateSkill.mockResolvedValue({
                valid: true,
                issues: [],
                metadata: {},
            });
            const program = new Command();
            registerSkillsValidate(program);
            await program.parseAsync(["node", "test", "validate"]);
            expect(mocks.validateSkill).toHaveBeenCalledWith("SKILL.md");
        });
        it("outputs warnings when present", async () => {
            mocks.validateSkill.mockResolvedValue({
                valid: true,
                issues: [
                    { level: "warning", field: "description", message: "Description is short" },
                ],
                metadata: {},
            });
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerSkillsValidate(program);
            await program.parseAsync(["node", "test", "validate", "/path/to/SKILL.md"]);
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Description is short"));
        });
    });
    describe("skills index (command registration)", () => {
        it("registers all skills subcommands", () => {
            const program = new Command();
            registerSkillsCommands(program);
            const commands = program.commands.map((cmd) => cmd.name());
            expect(commands).toContain("skills");
            const skillsCmd = program.commands.find((cmd) => cmd.name() === "skills");
            expect(skillsCmd).toBeDefined();
            const subcommands = skillsCmd?.commands.map((cmd) => cmd.name()) ?? [];
            expect(subcommands).toContain("install");
            expect(subcommands).toContain("remove");
            expect(subcommands).toContain("list");
            expect(subcommands).toContain("find");
            expect(subcommands).toContain("check");
            expect(subcommands).toContain("update");
            expect(subcommands).toContain("init");
            expect(subcommands).toContain("audit");
            expect(subcommands).toContain("validate");
        });
    });
});
//# sourceMappingURL=skills-commands.test.js.map