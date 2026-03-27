import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
    checkAllInjections: vi.fn(),
    injectAll: vi.fn(),
    generateInjectionContent: vi.fn(),
    groupByInstructFile: vi.fn(),
    getInstalledProviders: vi.fn(),
    getAllProviders: vi.fn(),
    getProvider: vi.fn(),
}));
vi.mock("../../src/core/instructions/injector.js", () => ({
    checkAllInjections: mocks.checkAllInjections,
    injectAll: mocks.injectAll,
}));
vi.mock("../../src/core/instructions/templates.js", () => ({
    generateInjectionContent: mocks.generateInjectionContent,
    groupByInstructFile: mocks.groupByInstructFile,
}));
vi.mock("../../src/core/registry/detection.js", () => ({
    getInstalledProviders: mocks.getInstalledProviders,
}));
vi.mock("../../src/core/registry/providers.js", () => ({
    getAllProviders: mocks.getAllProviders,
    getProvider: mocks.getProvider,
}));
import { registerInstructionsCheck } from "../../src/commands/instructions/check.js";
import { registerInstructionsCommands } from "../../src/commands/instructions/index.js";
import { registerInstructionsInject } from "../../src/commands/instructions/inject.js";
import { registerInstructionsUpdate } from "../../src/commands/instructions/update.js";
const providerA = { id: "claude-code", instructFile: "CLAUDE.md" };
const providerB = { id: "cursor", instructFile: "AGENTS.md" };
describe("integration: instructions command wrappers", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        mocks.checkAllInjections.mockReset();
        mocks.injectAll.mockReset();
        mocks.generateInjectionContent.mockReset();
        mocks.groupByInstructFile.mockReset();
        mocks.getInstalledProviders.mockReset();
        mocks.getAllProviders.mockReset();
        mocks.getProvider.mockReset();
        mocks.getInstalledProviders.mockReturnValue([providerA, providerB]);
        mocks.getAllProviders.mockReturnValue([providerA, providerB]);
        mocks.getProvider.mockImplementation((name) => {
            if (name === "claude-code")
                return providerA;
            if (name === "cursor")
                return providerB;
            return undefined;
        });
        mocks.generateInjectionContent.mockReturnValue("default injection content");
        mocks.groupByInstructFile.mockReturnValue(new Map([
            ["CLAUDE.md", [providerA]],
            ["AGENTS.md", [providerB]],
        ]));
    });
    it("prints check output as json for selected agents", async () => {
        mocks.checkAllInjections.mockResolvedValue([
            {
                provider: "claude-code",
                file: "CLAUDE.md",
                status: "current",
                fileExists: true,
            },
        ]);
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
        const program = new Command();
        registerInstructionsCheck(program);
        await program.parseAsync(["node", "test", "check", "--agent", "claude-code", "--json"]);
        expect(mocks.checkAllInjections).toHaveBeenCalledWith([providerA], process.cwd(), "project");
        const output = String(logSpy.mock.calls[0]?.[0] ?? "{}");
        const envelope = JSON.parse(output);
        expect(envelope.$schema).toBe("https://lafs.dev/schemas/v1/envelope.schema.json");
        expect(envelope._meta.operation).toBe("instructions.check");
        expect(envelope.success).toBe(true);
        expect(envelope.result.providers).toHaveLength(1);
        expect(envelope.result.providers[0]?.id).toBe("claude-code");
        expect(envelope.result.present).toBe(1);
        expect(envelope.result.missing).toBe(0);
    });
    it("prints human-readable check output for all providers", async () => {
        mocks.checkAllInjections.mockResolvedValue([
            {
                provider: "claude-code",
                file: "CLAUDE.md",
                status: "outdated",
                fileExists: true,
            },
        ]);
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
        const program = new Command();
        registerInstructionsCheck(program);
        await program.parseAsync(["node", "test", "check", "--all", "--global", "--human"]);
        expect(mocks.checkAllInjections).toHaveBeenCalledWith([providerA, providerB], process.cwd(), "global");
        const lines = logSpy.mock.calls.map((call) => String(call[0] ?? ""));
        expect(lines.some((line) => line.includes("Instruction file status (global):"))).toBe(true);
        expect(lines.some((line) => line.includes("CLAUDE.md") && line.includes("outdated"))).toBe(true);
    });
    it("supports dry-run inject path without writing files", async () => {
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
        const program = new Command();
        registerInstructionsInject(program);
        await program.parseAsync(["node", "test", "inject", "--all", "--dry-run", "--content", "custom content", "--human"]);
        expect(mocks.injectAll).not.toHaveBeenCalled();
        const lines = logSpy.mock.calls.map((call) => String(call[0] ?? ""));
        expect(lines.some((line) => line.includes("Dry run - would inject into:"))).toBe(true);
        expect(lines.some((line) => line.includes("Scope: project"))).toBe(true);
    });
    it("injects content for selected providers", async () => {
        mocks.injectAll.mockResolvedValue(new Map([["CLAUDE.md", "created"]]));
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
        const program = new Command();
        registerInstructionsInject(program);
        await program.parseAsync(["node", "test", "inject", "--agent", "claude-code", "--human"]);
        expect(mocks.injectAll).toHaveBeenCalledWith([providerA], process.cwd(), "project", "default injection content");
        const lines = logSpy.mock.calls.map((call) => String(call[0] ?? ""));
        expect(lines.some((line) => line.includes("CLAUDE.md") && line.includes("created"))).toBe(true);
        expect(lines.some((line) => line.includes("1 file(s) processed."))).toBe(true);
    });
    it("exits with error when inject has no resolved providers", async () => {
        mocks.getProvider.mockReturnValue(undefined);
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
        const exitSpy = vi
            .spyOn(process, "exit")
            .mockImplementation(((code) => {
            throw new Error(`exit:${String(code)}`);
        }));
        const program = new Command();
        registerInstructionsInject(program);
        await expect(program.parseAsync(["node", "test", "inject", "--agent", "unknown-agent"])).rejects.toThrow("exit:1");
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("No providers found."));
        expect(mocks.injectAll).not.toHaveBeenCalled();
        expect(exitSpy).toHaveBeenCalledWith(1);
    });
    it("reports update no-op when all files are current", async () => {
        mocks.checkAllInjections.mockResolvedValue([
            {
                provider: "claude-code",
                file: "CLAUDE.md",
                status: "current",
                fileExists: true,
            },
        ]);
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
        const program = new Command();
        registerInstructionsUpdate(program);
        await program.parseAsync(["node", "test", "update", "--human"]);
        expect(mocks.injectAll).not.toHaveBeenCalled();
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("All instruction files are up to date."));
    });
    it("updates only providers that need changes", async () => {
        mocks.checkAllInjections.mockResolvedValue([
            {
                provider: "claude-code",
                file: "CLAUDE.md",
                status: "outdated",
                fileExists: true,
            },
            {
                provider: "cursor",
                file: "AGENTS.md",
                status: "current",
                fileExists: true,
            },
        ]);
        mocks.injectAll.mockResolvedValue(new Map([["CLAUDE.md", "updated"]]));
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
        const program = new Command();
        registerInstructionsUpdate(program);
        await program.parseAsync(["node", "test", "update", "--global", "--human"]);
        expect(mocks.injectAll).toHaveBeenCalledWith([providerA], process.cwd(), "global", "default injection content");
        const lines = logSpy.mock.calls.map((call) => String(call[0] ?? ""));
        expect(lines.some((line) => line.includes("file(s) need updating"))).toBe(true);
        expect(lines.some((line) => line.includes("1 file(s) updated."))).toBe(true);
    });
    it("registers instructions command group with wrappers", () => {
        const program = new Command();
        registerInstructionsCommands(program);
        const instructions = program.commands.find((command) => command.name() === "instructions");
        expect(instructions).toBeDefined();
        expect(instructions?.commands.map((command) => command.name())).toEqual(["inject", "check", "update"]);
    });
});
//# sourceMappingURL=instructions-command-wrappers.test.js.map