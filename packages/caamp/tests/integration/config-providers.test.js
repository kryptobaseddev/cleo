import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
    getProvider: vi.fn(),
    getAllProviders: vi.fn(),
    getProviderCount: vi.fn(),
    getRegistryVersion: vi.fn(),
    getProvidersByPriority: vi.fn(),
    detectAllProviders: vi.fn(),
    detectProjectProviders: vi.fn(),
    resolveProviderConfigPath: vi.fn(),
    readConfig: vi.fn(),
    existsSync: vi.fn(),
}));
vi.mock("../../src/core/registry/providers.js", () => ({
    getProvider: mocks.getProvider,
    getAllProviders: mocks.getAllProviders,
    getProviderCount: mocks.getProviderCount,
    getRegistryVersion: mocks.getRegistryVersion,
    getProvidersByPriority: mocks.getProvidersByPriority,
}));
vi.mock("../../src/core/registry/detection.js", () => ({
    detectAllProviders: mocks.detectAllProviders,
    detectProjectProviders: mocks.detectProjectProviders,
}));
vi.mock("../../src/core/paths/standard.js", () => ({
    resolveProviderConfigPath: mocks.resolveProviderConfigPath,
}));
vi.mock("../../src/core/formats/index.js", () => ({
    readConfig: mocks.readConfig,
}));
vi.mock("node:fs", () => ({
    existsSync: mocks.existsSync,
}));
import { registerConfigCommand } from "../../src/commands/config.js";
import { registerProvidersCommand } from "../../src/commands/providers.js";
const mockProvider = (overrides = {}) => {
    const { configPathProject, capabilities: capOverride, ...rest } = overrides;
    const mcp = {
        configKey: "mcpServers",
        configFormat: "json",
        configPathGlobal: "/global/claude.json",
        configPathProject: configPathProject === undefined ? ".claude/settings.json" : configPathProject,
        supportedTransports: ["stdio", "sse"],
        supportsHeaders: true,
    };
    return {
        id: "claude-code",
        toolName: "Claude Code",
        vendor: "Anthropic",
        agentFlag: "claude",
        aliases: ["claude"],
        pathGlobal: "/global",
        pathProject: ".claude",
        instructFile: "CLAUDE.md",
        pathSkills: "/global/skills",
        pathProjectSkills: ".claude/skills",
        detection: { methods: ["binary"], binary: "claude" },
        priority: "high",
        status: "active",
        agentSkillsCompatible: true,
        capabilities: {
            mcp,
            harness: null,
            skills: {
                agentsGlobalPath: null,
                agentsProjectPath: null,
                precedence: "vendor-only",
            },
            hooks: {
                supported: [],
                hookConfigPath: null,
                hookConfigPathProject: null,
                hookFormat: null,
                nativeEventCatalog: "canonical",
                canInjectSystemPrompt: false,
                canBlockTools: false,
            },
            spawn: {
                supportsSubagents: false,
                supportsProgrammaticSpawn: false,
                supportsInterAgentComms: false,
                supportsParallelSpawn: false,
                spawnMechanism: null,
                spawnCommand: null,
            },
            ...capOverride,
        },
        ...rest,
    };
};
describe("integration: config and providers commands", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        Object.values(mocks).forEach((mock) => mock?.mockReset?.());
    });
    describe("config show", () => {
        it("shows provider config in human-readable format", async () => {
            const provider = mockProvider();
            mocks.getProvider.mockReturnValue(provider);
            mocks.resolveProviderConfigPath.mockReturnValue("/config/settings.json");
            mocks.existsSync.mockReturnValue(true);
            mocks.readConfig.mockResolvedValue({ mcpServers: { filesystem: { command: "npx" } } });
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerConfigCommand(program);
            await program.parseAsync(["node", "test", "config", "show", "claude-code", "--human"]);
            expect(mocks.getProvider).toHaveBeenCalledWith("claude-code");
            expect(mocks.readConfig).toHaveBeenCalledWith("/config/settings.json", "json");
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Claude Code config"));
        });
        it("outputs JSON when --json flag is provided", async () => {
            const config = { mcpServers: { test: { command: "echo" } } };
            mocks.getProvider.mockReturnValue(mockProvider());
            mocks.resolveProviderConfigPath.mockReturnValue("/config.json");
            mocks.existsSync.mockReturnValue(true);
            mocks.readConfig.mockResolvedValue(config);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerConfigCommand(program);
            await program.parseAsync(["node", "test", "config", "show", "claude-code", "--json"]);
            const envelope = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}"));
            expect(envelope.$schema).toBe("https://lafs.dev/schemas/v1/envelope.schema.json");
            expect(envelope._meta.operation).toBe("config.show");
            expect(envelope.success).toBe(true);
            expect(envelope.result.config).toEqual(config);
        });
        it("shows global config with --global flag", async () => {
            mocks.getProvider.mockReturnValue(mockProvider());
            mocks.resolveProviderConfigPath.mockReturnValue("/global/config.json");
            mocks.existsSync.mockReturnValue(true);
            mocks.readConfig.mockResolvedValue({});
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerConfigCommand(program);
            await program.parseAsync(["node", "test", "config", "show", "claude-code", "--global"]);
            expect(mocks.resolveProviderConfigPath).toHaveBeenCalledWith(expect.anything(), "global");
        });
        it("exits with error when provider not found", async () => {
            mocks.getProvider.mockReturnValue(undefined);
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerConfigCommand(program);
            await expect(program.parseAsync(["node", "test", "config", "show", "unknown"])).rejects.toThrow("process-exit");
            expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Provider not found"));
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
        it("shows message when config file does not exist", async () => {
            mocks.getProvider.mockReturnValue(mockProvider());
            mocks.resolveProviderConfigPath.mockReturnValue("/nonexistent.json");
            mocks.existsSync.mockReturnValue(false);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerConfigCommand(program);
            await expect(program.parseAsync(["node", "test", "config", "show", "claude-code", "--human"])).rejects.toThrow("process-exit");
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("No config file at"));
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
        it("exits with error when config read fails", async () => {
            mocks.getProvider.mockReturnValue(mockProvider());
            mocks.resolveProviderConfigPath.mockReturnValue("/broken.json");
            mocks.existsSync.mockReturnValue(true);
            mocks.readConfig.mockRejectedValue(new Error("Parse error"));
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerConfigCommand(program);
            await expect(program.parseAsync(["node", "test", "config", "show", "claude-code"])).rejects.toThrow("process-exit");
            expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Error reading config"));
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
    });
    describe("config path", () => {
        it("outputs project config path by default", async () => {
            mocks.getProvider.mockReturnValue(mockProvider());
            mocks.resolveProviderConfigPath.mockReturnValue("/project/.claude/settings.json");
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerConfigCommand(program);
            await program.parseAsync(["node", "test", "config", "path", "claude-code"]);
            expect(logSpy).toHaveBeenCalledWith("/project/.claude/settings.json");
        });
        it("outputs global config path when scope is global", async () => {
            mocks.getProvider.mockReturnValue(mockProvider());
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerConfigCommand(program);
            await program.parseAsync(["node", "test", "config", "path", "claude-code", "global"]);
            expect(logSpy).toHaveBeenCalledWith("/global/claude.json");
        });
        it("falls back to global path when no project config", async () => {
            mocks.getProvider.mockReturnValue(mockProvider({ configPathProject: null }));
            mocks.resolveProviderConfigPath.mockReturnValue(null);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerConfigCommand(program);
            await program.parseAsync(["node", "test", "config", "path", "claude-code"]);
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("has no project-level config"));
            expect(logSpy).toHaveBeenCalledWith("/global/claude.json");
        });
        it("exits with error when provider not found", async () => {
            mocks.getProvider.mockReturnValue(undefined);
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerConfigCommand(program);
            await expect(program.parseAsync(["node", "test", "config", "path", "unknown"])).rejects.toThrow("process-exit");
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
    });
    describe("providers list", () => {
        it("lists all providers in human-readable format", async () => {
            const providers = [
                mockProvider({ id: "claude-code", priority: "high", status: "active" }),
                mockProvider({ id: "cursor", priority: "high", status: "beta", toolName: "Cursor" }),
                mockProvider({ id: "windsurf", priority: "medium", status: "active", toolName: "Windsurf" }),
            ];
            mocks.getAllProviders.mockReturnValue(providers);
            mocks.getProviderCount.mockReturnValue(44);
            mocks.getRegistryVersion.mockReturnValue("1.0.0");
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerProvidersCommand(program);
            await program.parseAsync(["node", "test", "providers", "list", "--human"]);
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Provider Registry"));
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("44 providers"));
        });
        it("outputs JSON when --json flag is provided", async () => {
            const providers = [mockProvider()];
            mocks.getAllProviders.mockReturnValue(providers);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerProvidersCommand(program);
            await program.parseAsync(["node", "test", "providers", "list", "--json"]);
            const envelope = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}"));
            expect(envelope.$schema).toBe("https://lafs.dev/schemas/v1/envelope.schema.json");
            expect(envelope._meta.operation).toBe("providers.list");
            expect(envelope.success).toBe(true);
            expect(envelope.result.providers).toEqual(providers);
        });
        it("filters by priority tier", async () => {
            const highPriority = [mockProvider({ priority: "high" })];
            mocks.getProvidersByPriority.mockReturnValue(highPriority);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerProvidersCommand(program);
            await program.parseAsync(["node", "test", "providers", "list", "--tier", "high"]);
            expect(mocks.getProvidersByPriority).toHaveBeenCalledWith("high");
        });
        it("groups providers by priority in output", async () => {
            const providers = [
                mockProvider({ id: "high1", priority: "high", toolName: "High1" }),
                mockProvider({ id: "high2", priority: "high", toolName: "High2" }),
                mockProvider({ id: "med1", priority: "medium", toolName: "Med1" }),
                mockProvider({ id: "low1", priority: "low", toolName: "Low1" }),
            ];
            mocks.getAllProviders.mockReturnValue(providers);
            mocks.getProviderCount.mockReturnValue(4);
            mocks.getRegistryVersion.mockReturnValue("1.0.0");
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerProvidersCommand(program);
            await program.parseAsync(["node", "test", "providers", "list", "--human"]);
            const output = logSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
            expect(output).toContain("HIGH");
            expect(output).toContain("MEDIUM");
            expect(output).toContain("LOW");
        });
        it("shows status indicators for each provider", async () => {
            const providers = [
                mockProvider({ id: "active", status: "active" }),
                mockProvider({ id: "beta", status: "beta" }),
                mockProvider({ id: "deprecated", status: "deprecated" }),
            ];
            mocks.getAllProviders.mockReturnValue(providers);
            mocks.getProviderCount.mockReturnValue(3);
            mocks.getRegistryVersion.mockReturnValue("1.0.0");
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerProvidersCommand(program);
            await program.parseAsync(["node", "test", "providers", "list", "--human"]);
            const output = logSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
            expect(output).toContain("active");
            expect(output).toContain("beta");
            expect(output).toContain("deprecated");
        });
    });
    describe("providers detect", () => {
        it("detects installed providers", async () => {
            mocks.detectAllProviders.mockReturnValue([
                { provider: mockProvider(), installed: true, methods: ["binary"], projectDetected: false },
            ]);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerProvidersCommand(program);
            await program.parseAsync(["node", "test", "providers", "detect", "--human"]);
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Detected"));
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Claude Code"));
        });
        it("outputs JSON when --json flag is provided", async () => {
            mocks.detectAllProviders.mockReturnValue([
                {
                    provider: mockProvider(),
                    installed: true,
                    methods: ["binary"],
                    projectDetected: true,
                },
            ]);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerProvidersCommand(program);
            await program.parseAsync(["node", "test", "providers", "detect", "--json"]);
            const envelope = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}"));
            expect(envelope.$schema).toBe("https://lafs.dev/schemas/v1/envelope.schema.json");
            expect(envelope._meta.operation).toBe("providers.detect");
            expect(envelope.success).toBe(true);
            expect(envelope.result.installed).toHaveLength(1);
            expect(envelope.result.installed[0]?.id).toBe("claude-code");
        });
        it("includes project detection with --project flag", async () => {
            mocks.detectProjectProviders.mockReturnValue([
                { provider: mockProvider(), installed: true, methods: ["binary"], projectDetected: true },
            ]);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerProvidersCommand(program);
            await program.parseAsync(["node", "test", "providers", "detect", "--project"]);
            expect(mocks.detectProjectProviders).toHaveBeenCalled();
        });
        it("shows count of not detected providers", async () => {
            mocks.detectAllProviders.mockReturnValue([
                { provider: mockProvider(), installed: true, methods: ["binary"], projectDetected: false },
                { provider: mockProvider({ id: "missing" }), installed: false, methods: [], projectDetected: false },
            ]);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerProvidersCommand(program);
            await program.parseAsync(["node", "test", "providers", "detect", "--human"]);
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("1 providers not detected"));
        });
        it("shows not installed when no providers found", async () => {
            mocks.detectAllProviders.mockReturnValue([
                { provider: mockProvider(), installed: false, methods: [], projectDetected: false },
            ]);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerProvidersCommand(program);
            await program.parseAsync(["node", "test", "providers", "detect", "--human"]);
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Detected 0 installed providers"));
        });
    });
    describe("providers show", () => {
        it("shows provider details in human-readable format", async () => {
            mocks.getProvider.mockReturnValue(mockProvider());
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerProvidersCommand(program);
            await program.parseAsync(["node", "test", "providers", "show", "claude-code", "--human"]);
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Claude Code"));
            expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("by Anthropic"));
        });
        it("outputs JSON when --json flag is provided", async () => {
            const provider = mockProvider();
            mocks.getProvider.mockReturnValue(provider);
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerProvidersCommand(program);
            await program.parseAsync(["node", "test", "providers", "show", "claude-code", "--json"]);
            const envelope = JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? "{}"));
            expect(envelope.$schema).toBe("https://lafs.dev/schemas/v1/envelope.schema.json");
            expect(envelope._meta.operation).toBe("providers.show");
            expect(envelope.success).toBe(true);
            expect(envelope.result.provider).toEqual(provider);
        });
        it("exits with error when provider not found", async () => {
            mocks.getProvider.mockReturnValue(undefined);
            const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
            const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
                throw new Error("process-exit");
            }));
            const program = new Command();
            registerProvidersCommand(program);
            await expect(program.parseAsync(["node", "test", "providers", "show", "unknown"])).rejects.toThrow("process-exit");
            expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Provider not found"));
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
        it("shows all provider fields", async () => {
            mocks.getProvider.mockReturnValue(mockProvider({
                aliases: ["claude", "anthropic"],
                pathProject: ".claude",
                configPathProject: ".claude/settings.json",
                pathProjectSkills: ".claude/skills",
            }));
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerProvidersCommand(program);
            await program.parseAsync(["node", "test", "providers", "show", "claude-code", "--human"]);
            const output = logSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
            expect(output).toContain("Aliases");
            expect(output).toContain("claude");
            expect(output).toContain("anthropic");
            expect(output).toContain("Project dir");
            expect(output).toContain("Project config");
            expect(output).toContain("Project skills");
        });
        it("handles provider with no project paths", async () => {
            mocks.getProvider.mockReturnValue(mockProvider({
                pathProject: null,
                configPathProject: null,
                pathProjectSkills: null,
                aliases: [],
            }));
            const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
            const program = new Command();
            registerProvidersCommand(program);
            await program.parseAsync(["node", "test", "providers", "show", "claude-code", "--human"]);
            const output = logSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
            expect(output).toContain("(none)");
        });
    });
});
//# sourceMappingURL=config-providers.test.js.map