/**
 * Tests for format resolution error branches in skills commands.
 * These exercise the catch blocks that handle resolveFormat/resolveOutputFormat throwing.
 */
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
// ================================================================
// Tests for commands using resolveFormat from ../../core/lafs.js
// (check, init, install, remove, update)
// ================================================================
const lafsFormatMocks = vi.hoisted(() => ({
    resolveFormat: vi.fn(),
    // Other lafs exports needed by the commands
    buildEnvelope: vi.fn(),
    ErrorCategories: {
        VALIDATION: "VALIDATION",
        NOT_FOUND: "NOT_FOUND",
        INTERNAL: "INTERNAL",
        CONFLICT: "CONFLICT",
        TRANSIENT: "TRANSIENT",
    },
    ErrorCodes: {
        FORMAT_CONFLICT: "E_FORMAT_CONFLICT",
        FILE_NOT_FOUND: "E_FILE_NOT_FOUND",
        INVALID_INPUT: "E_INVALID_INPUT",
        INVALID_FORMAT: "E_INVALID_FORMAT",
        INVALID_CONSTRAINT: "E_INVALID_CONSTRAINT",
        PROVIDER_NOT_FOUND: "E_PROVIDER_NOT_FOUND",
        NETWORK_ERROR: "E_NETWORK_ERROR",
        SKILL_NOT_FOUND: "E_SKILL_NOT_FOUND",
        INSTALL_FAILED: "E_INSTALL_FAILED",
        INTERNAL_ERROR: "E_INTERNAL_ERROR",
        AUDIT_FAILED: "E_AUDIT_FAILED",
    },
    emitJsonError: vi.fn(),
    emitError: vi.fn(),
    outputSuccess: vi.fn(),
}));
const commonMocks = vi.hoisted(() => ({
    getTrackedSkills: vi.fn(),
    checkSkillUpdate: vi.fn(),
    existsSync: vi.fn(),
    statSync: vi.fn(),
    removeSkill: vi.fn(),
    listCanonicalSkills: vi.fn(),
    removeSkillFromLock: vi.fn(),
    getInstalledProviders: vi.fn(),
    getProvider: vi.fn(),
    installSkill: vi.fn(),
    parseSource: vi.fn(),
    isMarketplaceScoped: vi.fn(),
    cloneRepo: vi.fn(),
    cloneGitLabRepo: vi.fn(),
    formatNetworkError: vi.fn(),
    recordSkillInstall: vi.fn(),
    mkdir: vi.fn(),
    writeFile: vi.fn(),
    isHuman: vi.fn(),
    marketplaceGetSkill: vi.fn(),
    isCatalogAvailable: vi.fn(),
    resolveProfile: vi.fn(),
    getSkillDir: vi.fn(),
    listProfiles: vi.fn(),
    getSkill: vi.fn(),
    listSkills: vi.fn(),
    discoverSkill: vi.fn(),
    scanFile: vi.fn(),
    scanDirectory: vi.fn(),
    toSarif: vi.fn(),
    validateSkill: vi.fn(),
    discoverSkillsMulti: vi.fn(),
    resolveProviderSkillsDir: vi.fn(),
    buildSkillSubPathCandidates: vi.fn(),
}));
vi.mock("../../src/core/lafs.js", () => ({
    resolveFormat: lafsFormatMocks.resolveFormat,
    buildEnvelope: lafsFormatMocks.buildEnvelope,
    ErrorCategories: lafsFormatMocks.ErrorCategories,
    ErrorCodes: lafsFormatMocks.ErrorCodes,
    emitJsonError: lafsFormatMocks.emitJsonError,
    emitError: lafsFormatMocks.emitError,
    outputSuccess: lafsFormatMocks.outputSuccess,
}));
vi.mock("../../src/core/logger.js", () => ({
    isHuman: commonMocks.isHuman,
}));
vi.mock("../../src/core/skills/lock.js", () => ({
    getTrackedSkills: commonMocks.getTrackedSkills,
    checkSkillUpdate: commonMocks.checkSkillUpdate,
    removeSkillFromLock: commonMocks.removeSkillFromLock,
    recordSkillInstall: commonMocks.recordSkillInstall,
}));
vi.mock("node:fs", () => ({
    existsSync: commonMocks.existsSync,
    statSync: commonMocks.statSync,
}));
vi.mock("node:fs/promises", () => ({
    mkdir: commonMocks.mkdir,
    writeFile: commonMocks.writeFile,
}));
vi.mock("../../src/core/skills/installer.js", () => ({
    removeSkill: commonMocks.removeSkill,
    listCanonicalSkills: commonMocks.listCanonicalSkills,
    installSkill: commonMocks.installSkill,
}));
vi.mock("../../src/core/registry/detection.js", () => ({
    getInstalledProviders: commonMocks.getInstalledProviders,
}));
vi.mock("../../src/core/registry/providers.js", () => ({
    getProvider: commonMocks.getProvider,
    getInstalledProviders: commonMocks.getInstalledProviders,
}));
vi.mock("../../src/core/sources/parser.js", () => ({
    parseSource: commonMocks.parseSource,
    isMarketplaceScoped: commonMocks.isMarketplaceScoped,
}));
vi.mock("../../src/core/sources/github.js", () => ({
    cloneRepo: commonMocks.cloneRepo,
}));
vi.mock("../../src/core/sources/gitlab.js", () => ({
    cloneGitLabRepo: commonMocks.cloneGitLabRepo,
}));
vi.mock("../../src/core/network/fetch.js", () => ({
    formatNetworkError: commonMocks.formatNetworkError,
}));
vi.mock("../../src/core/marketplace/client.js", () => ({
    MarketplaceClient: class {
        getSkill = commonMocks.marketplaceGetSkill;
    },
}));
vi.mock("../../src/core/skills/catalog.js", () => ({
    isCatalogAvailable: commonMocks.isCatalogAvailable,
    resolveProfile: commonMocks.resolveProfile,
    getSkillDir: commonMocks.getSkillDir,
    listProfiles: commonMocks.listProfiles,
    getSkill: commonMocks.getSkill,
    listSkills: commonMocks.listSkills,
}));
vi.mock("../../src/core/skills/discovery.js", () => ({
    discoverSkill: commonMocks.discoverSkill,
    discoverSkillsMulti: commonMocks.discoverSkillsMulti,
}));
vi.mock("../../src/core/skills/audit/scanner.js", () => ({
    scanFile: commonMocks.scanFile,
    scanDirectory: commonMocks.scanDirectory,
    toSarif: commonMocks.toSarif,
}));
vi.mock("../../src/core/skills/validator.js", () => ({
    validateSkill: commonMocks.validateSkill,
}));
vi.mock("../../src/core/paths/standard.js", () => ({
    resolveProviderSkillsDir: commonMocks.resolveProviderSkillsDir,
    buildSkillSubPathCandidates: commonMocks.buildSkillSubPathCandidates,
}));
import { registerSkillsCheck } from "../../src/commands/skills/check.js";
import { registerSkillsInit } from "../../src/commands/skills/init.js";
import { registerSkillsInstall } from "../../src/commands/skills/install.js";
import { registerSkillsRemove } from "../../src/commands/skills/remove.js";
import { registerSkillsUpdate } from "../../src/commands/skills/update.js";
import { registerSkillsAudit } from "../../src/commands/skills/audit.js";
describe("skills commands - format resolution error branches", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        Object.values(lafsFormatMocks).forEach((mock) => {
            if (typeof mock === "function" && mock.mockReset)
                mock.mockReset();
        });
        Object.values(commonMocks).forEach((mock) => mock?.mockReset?.());
        commonMocks.isHuman.mockReturnValue(false);
        commonMocks.existsSync.mockReturnValue(true);
        commonMocks.getInstalledProviders.mockReturnValue([{ id: "claude-code", toolName: "Claude Code" }]);
    });
    describe("check command - format error", () => {
        it("exits with error when resolveFormat throws", async () => {
            lafsFormatMocks.resolveFormat.mockImplementation(() => {
                throw new Error("Cannot specify both --json and --human");
            });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsCheck(program);
            await expect(program.parseAsync(["node", "test", "check"])).rejects.toThrow("process-exit");
            expect(lafsFormatMocks.emitJsonError).toHaveBeenCalledWith("skills.check", "standard", "E_FORMAT_CONFLICT", "Cannot specify both --json and --human", "VALIDATION");
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
    });
    describe("init command - format error", () => {
        it("exits with error when resolveFormat throws", async () => {
            lafsFormatMocks.resolveFormat.mockImplementation(() => {
                throw new Error("format conflict");
            });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsInit(program);
            await expect(program.parseAsync(["node", "test", "init", "my-skill"])).rejects.toThrow("process-exit");
            expect(lafsFormatMocks.emitJsonError).toHaveBeenCalledWith("skills.init", "standard", "E_FORMAT_CONFLICT", "format conflict", "VALIDATION");
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
    });
    describe("install command - format error", () => {
        it("exits with error when resolveFormat throws", async () => {
            lafsFormatMocks.resolveFormat.mockImplementation(() => {
                throw new Error("format conflict");
            });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsInstall(program);
            await expect(program.parseAsync(["node", "test", "install", "some-skill", "--all"])).rejects.toThrow("process-exit");
            expect(lafsFormatMocks.emitJsonError).toHaveBeenCalledWith("skills.install", "standard", "E_FORMAT_CONFLICT", "format conflict", "VALIDATION");
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
    });
    describe("remove command - format error", () => {
        it("exits with error when resolveFormat throws", async () => {
            lafsFormatMocks.resolveFormat.mockImplementation(() => {
                throw new Error("format conflict");
            });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsRemove(program);
            await expect(program.parseAsync(["node", "test", "remove", "my-skill"])).rejects.toThrow("process-exit");
            expect(lafsFormatMocks.emitJsonError).toHaveBeenCalledWith("skills.remove", "standard", "E_FORMAT_CONFLICT", "format conflict", "VALIDATION");
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
    });
    describe("update command - format error", () => {
        it("exits with error when resolveFormat throws", async () => {
            lafsFormatMocks.resolveFormat.mockImplementation(() => {
                throw new Error("format conflict");
            });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsUpdate(program);
            await expect(program.parseAsync(["node", "test", "update"])).rejects.toThrow("process-exit");
            expect(lafsFormatMocks.emitJsonError).toHaveBeenCalledWith("skills.update", "standard", "E_FORMAT_CONFLICT", "format conflict", "VALIDATION");
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
    });
    describe("audit command - format error (non-sarif path)", () => {
        it("exits with error when resolveFormat throws", async () => {
            lafsFormatMocks.resolveFormat.mockImplementation(() => {
                throw new Error("format conflict");
            });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerSkillsAudit(program);
            await expect(program.parseAsync(["node", "test", "audit", "/some/path"])).rejects.toThrow("process-exit");
            expect(lafsFormatMocks.emitJsonError).toHaveBeenCalledWith("skills.audit", "standard", "E_FORMAT_CONFLICT", "format conflict", "VALIDATION");
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
    });
});
//# sourceMappingURL=skills-format-errors.test.js.map