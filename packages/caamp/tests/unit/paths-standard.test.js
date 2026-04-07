import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import envPaths from "env-paths";
import { buildSkillSubPathCandidates, getAgentsConfigPath, getAgentsHome, getAgentsInstructFile, getAgentsLinksDir, getAgentsMcpDir, getAgentsMcpServersPath, getAgentsSpecDir, getAgentsWikiDir, getCanonicalSkillsDir, getLockFilePath, normalizeSkillSubPath, resolveProviderConfigPath, resolveProviderSkillsDir, resolveProviderSkillsDirs, resolveRegistryTemplatePath, } from "../../src/core/paths/standard.js";
const originalAgentsHome = process.env["AGENTS_HOME"];
describe("paths standard", () => {
    afterEach(() => {
        if (originalAgentsHome === undefined) {
            delete process.env["AGENTS_HOME"];
        }
        else {
            process.env["AGENTS_HOME"] = originalAgentsHome;
        }
    });
    it("respects AGENTS_HOME override for canonical paths", () => {
        process.env["AGENTS_HOME"] = "~/custom-agents";
        expect(getAgentsHome()).toContain("custom-agents");
        expect(getCanonicalSkillsDir()).toContain("custom-agents");
        expect(getLockFilePath()).toContain("custom-agents");
    });
    it("resolves registry template variables", () => {
        process.env["AGENTS_HOME"] = "~/agents-override";
        const resolved = resolveRegistryTemplatePath("$AGENTS_HOME/skills");
        expect(resolved).toContain("agents-override");
        expect(resolved).not.toContain("$AGENTS_HOME");
    });
    describe(".agents/ standard paths", () => {
        it("returns global MCP dir under AGENTS_HOME", () => {
            process.env["AGENTS_HOME"] = "/test/agents";
            const result = getAgentsMcpDir("global");
            expect(result).toContain("test");
            expect(result).toContain("agents");
            expect(result).toMatch(/mcp$/);
        });
        it("returns project MCP dir under project root", () => {
            const result = getAgentsMcpDir("project", "/my/project");
            expect(result).toContain(".agents");
            expect(result).toMatch(/mcp$/);
        });
        it("returns global servers.json path", () => {
            process.env["AGENTS_HOME"] = "/test/agents";
            const result = getAgentsMcpServersPath("global");
            expect(result).toContain("mcp");
            expect(result).toMatch(/servers\.json$/);
        });
        it("returns project servers.json path", () => {
            const result = getAgentsMcpServersPath("project", "/my/project");
            expect(result).toContain(".agents");
            expect(result).toMatch(/servers\.json$/);
        });
        it("returns global AGENTS.md path", () => {
            process.env["AGENTS_HOME"] = "/test/agents";
            const result = getAgentsInstructFile("global");
            expect(result).toMatch(/AGENTS\.md$/);
        });
        it("returns project AGENTS.md path", () => {
            const result = getAgentsInstructFile("project", "/my/project");
            expect(result).toContain(".agents");
            expect(result).toMatch(/AGENTS\.md$/);
        });
        it("returns global config.toml path", () => {
            process.env["AGENTS_HOME"] = "/test/agents";
            const result = getAgentsConfigPath("global");
            expect(result).toMatch(/config\.toml$/);
        });
        it("returns standard directory paths", () => {
            process.env["AGENTS_HOME"] = "/test/agents";
            expect(getAgentsWikiDir("global")).toMatch(/wiki$/);
            expect(getAgentsSpecDir("global")).toMatch(/spec$/);
            expect(getAgentsLinksDir("global")).toMatch(/links$/);
        });
        it("returns project-scoped directory paths", () => {
            expect(getAgentsWikiDir("project", "/proj")).toMatch(/wiki$/);
            expect(getAgentsSpecDir("project", "/proj")).toMatch(/spec$/);
            expect(getAgentsLinksDir("project", "/proj")).toMatch(/links$/);
        });
    });
    describe("normalizeHomeOverride (via getAgentsHome)", () => {
        it("resolves exact '~' to homedir", () => {
            process.env["AGENTS_HOME"] = "~";
            expect(getAgentsHome()).toBe(homedir());
        });
        it("resolves '~/...' to homedir-prefixed path", () => {
            process.env["AGENTS_HOME"] = "~/my-agents";
            const result = getAgentsHome();
            expect(result).toContain(homedir());
            expect(result).toContain("my-agents");
        });
        it("resolves absolute path as-is", () => {
            process.env["AGENTS_HOME"] = "/custom/path";
            const result = getAgentsHome();
            expect(result).toContain("custom");
            expect(result).toContain("path");
        });
        it("resolves relative path against homedir", () => {
            process.env["AGENTS_HOME"] = "relative-agents";
            const result = getAgentsHome();
            expect(result).toContain("relative-agents");
            // Relative paths are resolved via resolve(homedir(), value)
            expect(result).not.toBe("relative-agents");
        });
    });
    describe("getAgentsHome default behavior", () => {
        it("returns OS-appropriate data dir when AGENTS_HOME is unset", () => {
            delete process.env["AGENTS_HOME"];
            const result = getAgentsHome();
            const expectedDefault = envPaths("agents", { suffix: "" }).data;
            expect(result).toBe(expectedDefault);
        });
        it("returns OS-appropriate data dir when AGENTS_HOME is empty string", () => {
            process.env["AGENTS_HOME"] = "";
            const result = getAgentsHome();
            const expectedDefault = envPaths("agents", { suffix: "" }).data;
            expect(result).toBe(expectedDefault);
        });
        it("returns OS-appropriate data dir when AGENTS_HOME is whitespace only", () => {
            process.env["AGENTS_HOME"] = "   ";
            const result = getAgentsHome();
            const expectedDefault = envPaths("agents", { suffix: "" }).data;
            expect(result).toBe(expectedDefault);
        });
    });
    describe("resolveProviderSkillsDir", () => {
        const mockProvider = {
            pathSkills: "/home/user/.claude/skills",
            pathProjectSkills: ".claude/skills",
        };
        it("returns global skills dir from provider", () => {
            const result = resolveProviderSkillsDir(mockProvider, "global");
            expect(result).toBe("/home/user/.claude/skills");
        });
        it("returns project-scoped skills dir under project root", () => {
            const result = resolveProviderSkillsDir(mockProvider, "project", "/proj");
            expect(result).toContain(".claude");
            expect(result).toContain("skills");
        });
    });
    describe("resolveProviderConfigPath", () => {
        const buildMcpProvider = (configPathGlobal, configPathProject) => ({
            capabilities: {
                mcp: {
                    configKey: "mcpServers",
                    configFormat: "json",
                    configPathGlobal,
                    configPathProject,
                    supportedTransports: ["stdio"],
                    supportsHeaders: false,
                },
                harness: null,
                skills: { precedence: "vendor-only", agentsGlobalPath: null, agentsProjectPath: null },
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
            },
        });
        it("returns global config path from provider", () => {
            const mockProvider = buildMcpProvider("/home/user/.claude/config.json", ".claude/config.json");
            const result = resolveProviderConfigPath(mockProvider, "global");
            expect(result).toBe("/home/user/.claude/config.json");
        });
        it("returns project config path resolved under project root", () => {
            const mockProvider = buildMcpProvider("/home/user/.claude/config.json", ".claude/config.json");
            const result = resolveProviderConfigPath(mockProvider, "project", "/proj");
            expect(result).toContain(".claude");
            expect(result).toContain("config.json");
        });
        it("returns null for project scope when provider has no project config", () => {
            const mockProvider = buildMcpProvider("/home/user/.windsurf/config.json", null);
            const result = resolveProviderConfigPath(mockProvider, "project", "/proj");
            expect(result).toBeNull();
        });
        it("returns null when provider has no MCP integration at all", () => {
            const mockProvider = {
                capabilities: {
                    mcp: null,
                    harness: null,
                    skills: { precedence: "vendor-only", agentsGlobalPath: null, agentsProjectPath: null },
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
                },
            };
            expect(resolveProviderConfigPath(mockProvider, "global")).toBeNull();
            expect(resolveProviderConfigPath(mockProvider, "project", "/proj")).toBeNull();
        });
    });
    describe("buildSkillSubPathCandidates", () => {
        it("expands skills/ path with .agents/ and .claude/ prefixes", () => {
            const candidates = buildSkillSubPathCandidates("skills/my-skill", undefined);
            expect(candidates).toContain("skills/my-skill");
            expect(candidates).toContain(".agents/skills/my-skill");
            expect(candidates).toContain(".claude/skills/my-skill");
        });
        it("does not expand paths that do not start with skills/", () => {
            const candidates = buildSkillSubPathCandidates("custom/path", undefined);
            expect(candidates).toContain("custom/path");
            expect(candidates).not.toContain(".agents/custom/path");
            expect(candidates).not.toContain(".claude/custom/path");
        });
        it("includes both marketplace and parsed paths", () => {
            const candidates = buildSkillSubPathCandidates("skills/alpha", "skills/beta");
            expect(candidates).toContain("skills/alpha");
            expect(candidates).toContain("skills/beta");
            expect(candidates).toContain(".agents/skills/alpha");
            expect(candidates).toContain(".claude/skills/alpha");
            expect(candidates).toContain(".agents/skills/beta");
            expect(candidates).toContain(".claude/skills/beta");
        });
        it("deduplicates identical candidates", () => {
            const candidates = buildSkillSubPathCandidates("skills/same", "skills/same");
            const unique = new Set(candidates);
            expect(candidates.length).toBe(unique.size);
        });
        it("returns [undefined] when both inputs are undefined", () => {
            const candidates = buildSkillSubPathCandidates(undefined, undefined);
            expect(candidates).toEqual([undefined]);
        });
        it("strips SKILL.md suffix via normalizeSkillSubPath", () => {
            const candidates = buildSkillSubPathCandidates("skills/my-skill/SKILL.md", undefined);
            expect(candidates).toContain("skills/my-skill");
            expect(candidates).not.toContain("skills/my-skill/SKILL.md");
        });
    });
    describe("normalizeSkillSubPath", () => {
        it("returns undefined for empty string", () => {
            expect(normalizeSkillSubPath("")).toBeUndefined();
        });
        it("returns undefined for undefined", () => {
            expect(normalizeSkillSubPath(undefined)).toBeUndefined();
        });
        it("strips leading slashes", () => {
            expect(normalizeSkillSubPath("///skills/foo")).toBe("skills/foo");
        });
        it("strips trailing /SKILL.md", () => {
            expect(normalizeSkillSubPath("skills/foo/SKILL.md")).toBe("skills/foo");
        });
        it("normalizes backslashes to forward slashes", () => {
            expect(normalizeSkillSubPath("skills\\foo\\bar")).toBe("skills/foo/bar");
        });
    });
    describe("resolveProviderSkillsDirs", () => {
        function makeCapabilities(precedence, agentsGlobalPath = null, agentsProjectPath = null) {
            return {
                mcp: null,
                harness: null,
                skills: {
                    precedence: precedence,
                    agentsGlobalPath,
                    agentsProjectPath,
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
            };
        }
        const baseProvider = {
            pathSkills: "/home/user/.claude/skills",
            pathProjectSkills: ".claude/skills",
        };
        it("vendor-only returns 1 path (vendor)", () => {
            const provider = {
                ...baseProvider,
                capabilities: makeCapabilities("vendor-only"),
            };
            const result = resolveProviderSkillsDirs(provider, "global");
            expect(result).toHaveLength(1);
            expect(result[0]).toBe("/home/user/.claude/skills");
        });
        it("agents-canonical returns 1 path (agents) when agents path exists", () => {
            const provider = {
                ...baseProvider,
                capabilities: makeCapabilities("agents-canonical", "/home/user/.agents/skills", ".agents/skills"),
            };
            const result = resolveProviderSkillsDirs(provider, "global");
            expect(result).toHaveLength(1);
            expect(result[0]).toBe("/home/user/.agents/skills");
        });
        it("agents-canonical falls back to vendor when agents path is null", () => {
            const provider = {
                ...baseProvider,
                capabilities: makeCapabilities("agents-canonical", null, null),
            };
            const result = resolveProviderSkillsDirs(provider, "global");
            expect(result).toHaveLength(1);
            expect(result[0]).toBe("/home/user/.claude/skills");
        });
        it("agents-first returns 2 paths (agents, vendor) when agents path exists", () => {
            const provider = {
                ...baseProvider,
                capabilities: makeCapabilities("agents-first", "/home/user/.agents/skills", ".agents/skills"),
            };
            const result = resolveProviderSkillsDirs(provider, "global");
            expect(result).toHaveLength(2);
            expect(result[0]).toBe("/home/user/.agents/skills");
            expect(result[1]).toBe("/home/user/.claude/skills");
        });
        it("agents-first returns 1 path (vendor) when agents path is null", () => {
            const provider = {
                ...baseProvider,
                capabilities: makeCapabilities("agents-first", null),
            };
            const result = resolveProviderSkillsDirs(provider, "global");
            expect(result).toHaveLength(1);
            expect(result[0]).toBe("/home/user/.claude/skills");
        });
        it("agents-supported returns 2 paths (vendor, agents) when agents path exists", () => {
            const provider = {
                ...baseProvider,
                capabilities: makeCapabilities("agents-supported", "/home/user/.agents/skills"),
            };
            const result = resolveProviderSkillsDirs(provider, "global");
            expect(result).toHaveLength(2);
            expect(result[0]).toBe("/home/user/.claude/skills");
            expect(result[1]).toBe("/home/user/.agents/skills");
        });
        it("vendor-global-agents-project with global scope returns 1 path (vendor)", () => {
            const provider = {
                ...baseProvider,
                capabilities: makeCapabilities("vendor-global-agents-project", "/home/user/.agents/skills", ".agents/skills"),
            };
            const result = resolveProviderSkillsDirs(provider, "global");
            expect(result).toHaveLength(1);
            expect(result[0]).toBe("/home/user/.claude/skills");
        });
        it("vendor-global-agents-project with project scope returns 2 paths (agents, vendor)", () => {
            const provider = {
                ...baseProvider,
                capabilities: makeCapabilities("vendor-global-agents-project", "/home/user/.agents/skills", ".agents/skills"),
            };
            const result = resolveProviderSkillsDirs(provider, "project", "/my/project");
            expect(result).toHaveLength(2);
            expect(result[0]).toContain(join(".agents", "skills"));
            expect(result[1]).toContain(join(".claude", "skills"));
        });
        it("project scope resolves agentsProjectPath relative to projectDir", () => {
            const provider = {
                ...baseProvider,
                capabilities: makeCapabilities("agents-canonical", "/home/user/.agents/skills", ".agents/skills"),
            };
            const result = resolveProviderSkillsDirs(provider, "project", "/my/project");
            expect(result).toHaveLength(1);
            expect(result[0]).toBe(join("/my/project", ".agents", "skills"));
        });
        it("falls back to vendor-only when capabilities are undefined", () => {
            const provider = { ...baseProvider };
            const result = resolveProviderSkillsDirs(provider, "global");
            expect(result).toHaveLength(1);
            expect(result[0]).toBe("/home/user/.claude/skills");
        });
    });
});
//# sourceMappingURL=paths-standard.test.js.map