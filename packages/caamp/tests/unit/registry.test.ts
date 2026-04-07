import { beforeEach, describe, expect, it } from "vitest";
import {
  buildSkillsMap,
  getAllProviders,
  getCommonHookEvents,
  getInstructionFiles,
  getProvider,
  getProviderCapabilities,
  getProviderCount,
  getProvidersByHookEvent,
  getProvidersByInstructFile,
  getProvidersByPriority,
  getProvidersBySkillsPrecedence,
  getProvidersBySpawnCapability,
  getProvidersByStatus,
  getRegistryVersion,
  getSpawnCapableProviders,
  providerSupports,
  providerSupportsById,
  resetRegistry,
  getEffectiveSkillsPaths,
  resolveAlias,
} from "../../src/core/registry/providers.js";

beforeEach(() => {
  resetRegistry();
});

describe("Provider Registry", () => {
  it("loads all providers from registry.json", () => {
    const providers = getAllProviders();
    expect(providers.length).toBeGreaterThanOrEqual(25);
  });

  it("returns correct provider count", () => {
    expect(getProviderCount()).toBeGreaterThanOrEqual(25);
  });

  it("returns registry version", () => {
    expect(getRegistryVersion()).toBe("2.0.0");
  });

  it("gets provider by ID", () => {
    const claude = getProvider("claude-code");
    expect(claude).toBeDefined();
    expect(claude?.toolName).toBe("Claude Code");
    expect(claude?.vendor).toBe("Anthropic");
    expect(claude?.instructFile).toBe("CLAUDE.md");
  });

  it("gets provider by alias", () => {
    const claude = getProvider("claude");
    expect(claude).toBeDefined();
    expect(claude?.id).toBe("claude-code");
  });

  it("resolves aliases", () => {
    expect(resolveAlias("claude")).toBe("claude-code");
    expect(resolveAlias("gemini")).toBe("gemini-cli");
    expect(resolveAlias("copilot")).toBe("github-copilot");
    expect(resolveAlias("unknown")).toBe("unknown");
  });

  it("returns undefined for unknown provider", () => {
    expect(getProvider("nonexistent")).toBeUndefined();
  });

  it("filters by priority", () => {
    const high = getProvidersByPriority("high");
    expect(high.length).toBeGreaterThanOrEqual(3);
    expect(high.every((p) => p.priority === "high")).toBe(true);
    expect(high.some((p) => p.id === "claude-code")).toBe(true);
    expect(high.some((p) => p.id === "cursor")).toBe(true);
    expect(high.some((p) => p.id === "windsurf")).toBe(true);
  });

  it("filters by status", () => {
    const active = getProvidersByStatus("active");
    expect(active.length).toBeGreaterThan(0);
    expect(active.every((p) => p.status === "active")).toBe(true);
  });

  it("filters by instruction file", () => {
    const claude = getProvidersByInstructFile("CLAUDE.md");
    expect(claude.some((p) => p.id === "claude-code")).toBe(true);

    const agents = getProvidersByInstructFile("AGENTS.md");
    expect(agents.length).toBeGreaterThan(5);
    expect(agents.some((p) => p.id === "cursor")).toBe(true);
    expect(agents.some((p) => p.id === "codex")).toBe(true);
    expect(agents.some((p) => p.id === "kimi")).toBe(true);

    const gemini = getProvidersByInstructFile("GEMINI.md");
    expect(gemini.some((p) => p.id === "gemini-cli")).toBe(true);
  });

  it("returns unique instruction files", () => {
    const files = getInstructionFiles();
    expect(files).toContain("CLAUDE.md");
    expect(files).toContain("AGENTS.md");
    expect(files).toContain("GEMINI.md");
    // No CODEX.md or KIMI.md - they use AGENTS.md
    expect(files).not.toContain("CODEX.md");
    expect(files).not.toContain("KIMI.md");
  });

  it("resolves platform-specific paths", () => {
    const claude = getProvider("claude-code");
    expect(claude).toBeDefined();
    expect(claude?.pathGlobal).not.toContain("$HOME");
    expect(claude?.capabilities.mcp?.configPathGlobal).not.toContain("$HOME");
    expect(claude?.pathSkills).not.toContain("$HOME");
  });

  it("has correct config keys per provider", () => {
    expect(getProvider("claude-code")?.capabilities.mcp?.configKey).toBe("mcpServers");
    expect(getProvider("codex")?.capabilities.mcp?.configKey).toBe("mcp_servers");
    expect(getProvider("goose")?.capabilities.mcp?.configKey).toBe("extensions");
    expect(getProvider("opencode")?.capabilities.mcp?.configKey).toBe("mcp");
    expect(getProvider("vscode")?.capabilities.mcp?.configKey).toBe("servers");
    expect(getProvider("zed")?.capabilities.mcp?.configKey).toBe("context_servers");
  });

  it("has correct config formats per provider", () => {
    expect(getProvider("claude-code")?.capabilities.mcp?.configFormat).toBe("json");
    expect(getProvider("goose")?.capabilities.mcp?.configFormat).toBe("yaml");
    expect(getProvider("codex")?.capabilities.mcp?.configFormat).toBe("toml");
    expect(getProvider("zed")?.capabilities.mcp?.configFormat).toBe("jsonc");
  });

  it("has no MCP capability block for Pi (extension-based harness)", () => {
    const pi = getProvider("pi");
    expect(pi).toBeDefined();
    expect(pi?.capabilities.mcp).toBeNull();
    expect(pi?.priority).toBe("primary");
    expect(pi?.capabilities.harness).not.toBeNull();
    expect(pi?.capabilities.harness?.kind).toBe("orchestrator");
  });

  describe("capabilities", () => {
    it("always defines capabilities on resolved providers", () => {
      const providers = getAllProviders();
      for (const p of providers) {
        expect(p.capabilities).toBeDefined();
        expect(p.capabilities.skills).toBeDefined();
        expect(p.capabilities.hooks).toBeDefined();
        expect(p.capabilities.spawn).toBeDefined();
      }
    });

    it("applies default skills capability when not specified in JSON", () => {
      // windsurf has no capabilities in registry.json yet
      const ws = getProvider("windsurf");
      expect(ws?.capabilities.skills.precedence).toBe("vendor-only");
      expect(ws?.capabilities.skills.agentsGlobalPath).toBeNull();
      expect(ws?.capabilities.skills.agentsProjectPath).toBeNull();
    });

    it("applies default hooks capability when not specified in JSON", () => {
      const ws = getProvider("windsurf");
      expect(ws?.capabilities.hooks.supported).toEqual([]);
      expect(ws?.capabilities.hooks.hookConfigPath).toBeNull();
      expect(ws?.capabilities.hooks.hookFormat).toBeNull();
    });

    it("applies default spawn capability when not specified in JSON", () => {
      const ws = getProvider("windsurf");
      expect(ws?.capabilities.spawn.supportsSubagents).toBe(false);
      expect(ws?.capabilities.spawn.supportsProgrammaticSpawn).toBe(false);
      expect(ws?.capabilities.spawn.supportsInterAgentComms).toBe(false);
      expect(ws?.capabilities.spawn.supportsParallelSpawn).toBe(false);
      expect(ws?.capabilities.spawn.spawnMechanism).toBeNull();
    });
  });

  describe("hooks query functions", () => {
    it("getProvidersByHookEvent includes claude-code for PreToolUse", () => {
      const providers = getProvidersByHookEvent("PreToolUse");
      expect(providers.some((p) => p.id === "claude-code")).toBe(true);
    });

    it("getProvidersByHookEvent does NOT include windsurf (no hooks)", () => {
      const providers = getProvidersByHookEvent("PreToolUse");
      expect(providers.some((p) => p.id === "windsurf")).toBe(false);
    });

    it("getCommonHookEvents returns empty array across all providers", () => {
      const common = getCommonHookEvents();
      expect(common).toEqual([]);
    });

    it("getCommonHookEvents for claude-code returns its 22 native events", () => {
      const common = getCommonHookEvents(["claude-code"]);
      expect(common).toHaveLength(22);
      expect(common).toContain("SessionStart");
      expect(common).toContain("SessionEnd");
      expect(common).toContain("PreToolUse");
      expect(common).toContain("PostToolUse");
      expect(common).toContain("UserPromptSubmit");
      expect(common).toContain("Stop");
    });
  });

  describe("spawn query functions", () => {
    it("getSpawnCapableProviders includes claude-code", () => {
      const providers = getSpawnCapableProviders();
      expect(providers.some((p) => p.id === "claude-code")).toBe(true);
    });

    it("getSpawnCapableProviders does NOT include windsurf", () => {
      const providers = getSpawnCapableProviders();
      expect(providers.some((p) => p.id === "windsurf")).toBe(false);
    });

    it("getProvidersBySpawnCapability supportsParallelSpawn includes claude-code and codex", () => {
      const providers = getProvidersBySpawnCapability("supportsParallelSpawn");
      expect(providers.some((p) => p.id === "claude-code")).toBe(true);
      expect(providers.some((p) => p.id === "codex")).toBe(true);
    });

    it("getProvidersBySpawnCapability supportsInterAgentComms includes claude-code but NOT codex", () => {
      const providers = getProvidersBySpawnCapability("supportsInterAgentComms");
      expect(providers.some((p) => p.id === "claude-code")).toBe(true);
      expect(providers.some((p) => p.id === "codex")).toBe(false);
    });
  });

  describe("skills query functions", () => {
    it("getProvidersBySkillsPrecedence vendor-only returns array with windsurf", () => {
      const providers = getProvidersBySkillsPrecedence("vendor-only");
      expect(providers.length).toBeGreaterThan(0);
      expect(providers.some((p) => p.id === "windsurf")).toBe(true);
    });

    it("getProvidersBySkillsPrecedence agents-canonical returns array with codex", () => {
      const providers = getProvidersBySkillsPrecedence("agents-canonical");
      expect(providers.length).toBeGreaterThan(0);
      expect(providers.some((p) => p.id === "codex")).toBe(true);
    });

    it("getProviderCapabilities returns defined capabilities for claude-code", () => {
      const caps = getProviderCapabilities("claude-code");
      expect(caps).toBeDefined();
      expect(caps?.skills).toBeDefined();
      expect(caps?.hooks).toBeDefined();
      expect(caps?.spawn).toBeDefined();
    });

    it("providerSupports returns true for claude-code spawn.supportsSubagents", () => {
      const claude = getProvider("claude-code")!;
      expect(providerSupports(claude, "spawn.supportsSubagents")).toBe(true);
    });

    it("providerSupportsById returns false for windsurf spawn.supportsSubagents", () => {
      expect(providerSupportsById("windsurf", "spawn.supportsSubagents")).toBe(false);
    });

    it("buildSkillsMap returns array with correct shape", () => {
      const map = buildSkillsMap();
      expect(map.length).toBeGreaterThan(0);
      const entry = map.find((e) => e.providerId === "claude-code");
      expect(entry).toBeDefined();
      expect(entry?.toolName).toBe("Claude Code");
      expect(entry?.precedence).toBeDefined();
      expect(entry?.paths).toHaveProperty("global");
      expect(entry?.paths).toHaveProperty("project");
    });
  });
});

describe("getEffectiveSkillsPaths", () => {
  it("vendor-only returns single vendor entry for global scope", () => {
    const provider = getProvider("claude-code")!;
    const paths = getEffectiveSkillsPaths(provider, "global");
    expect(paths).toHaveLength(1);
    expect(paths[0]?.source).toBe("vendor");
    expect(paths[0]?.scope).toBe("global");
  });

  it("vendor-only returns single vendor entry for project scope", () => {
    const provider = getProvider("claude-code")!;
    const paths = getEffectiveSkillsPaths(provider, "project", "/my/project");
    expect(paths).toHaveLength(1);
    expect(paths[0]?.source).toBe("vendor");
    expect(paths[0]?.scope).toBe("project");
  });

  it("returns agents entry when precedence is agents-canonical and agentsGlobalPath set", () => {
    const provider = getProvider("claude-code")!;
    const modified = {
      ...provider,
      capabilities: {
        ...provider.capabilities,
        skills: {
          ...provider.capabilities.skills,
          precedence: "agents-canonical" as const,
          agentsGlobalPath: "/home/user/.agents/skills",
          agentsProjectPath: ".agents/skills",
        },
      },
    };
    const paths = getEffectiveSkillsPaths(modified, "global");
    expect(paths).toHaveLength(1);
    expect(paths[0]?.source).toBe("agents");
    expect(paths[0]?.path).toBe("/home/user/.agents/skills");
  });

  it("agents-canonical returns empty array when agentsGlobalPath is null", () => {
    const provider = getProvider("claude-code")!;
    const modified = {
      ...provider,
      capabilities: {
        ...provider.capabilities,
        skills: {
          ...provider.capabilities.skills,
          precedence: "agents-canonical" as const,
          agentsGlobalPath: null,
          agentsProjectPath: null,
        },
      },
    };
    const paths = getEffectiveSkillsPaths(modified, "global");
    expect(paths).toHaveLength(0);
  });

  it("agents-first returns agents then vendor when agentsGlobalPath set", () => {
    const provider = getProvider("claude-code")!;
    const modified = {
      ...provider,
      capabilities: {
        ...provider.capabilities,
        skills: {
          ...provider.capabilities.skills,
          precedence: "agents-first" as const,
          agentsGlobalPath: "/home/user/.agents/skills",
          agentsProjectPath: null,
        },
      },
    };
    const paths = getEffectiveSkillsPaths(modified, "global");
    expect(paths).toHaveLength(2);
    expect(paths[0]?.source).toBe("agents");
    expect(paths[1]?.source).toBe("vendor");
  });

  it("agents-first returns only vendor when agentsGlobalPath is null", () => {
    const provider = getProvider("claude-code")!;
    const modified = {
      ...provider,
      capabilities: {
        ...provider.capabilities,
        skills: {
          ...provider.capabilities.skills,
          precedence: "agents-first" as const,
          agentsGlobalPath: null,
          agentsProjectPath: null,
        },
      },
    };
    const paths = getEffectiveSkillsPaths(modified, "global");
    expect(paths).toHaveLength(1);
    expect(paths[0]?.source).toBe("vendor");
  });

  it("agents-supported returns vendor then agents when agentsGlobalPath set", () => {
    const provider = getProvider("claude-code")!;
    const modified = {
      ...provider,
      capabilities: {
        ...provider.capabilities,
        skills: {
          ...provider.capabilities.skills,
          precedence: "agents-supported" as const,
          agentsGlobalPath: "/home/user/.agents/skills",
          agentsProjectPath: null,
        },
      },
    };
    const paths = getEffectiveSkillsPaths(modified, "global");
    expect(paths).toHaveLength(2);
    expect(paths[0]?.source).toBe("vendor");
    expect(paths[1]?.source).toBe("agents");
  });

  it("vendor-global-agents-project returns only vendor for global scope", () => {
    const provider = getProvider("claude-code")!;
    const modified = {
      ...provider,
      capabilities: {
        ...provider.capabilities,
        skills: {
          ...provider.capabilities.skills,
          precedence: "vendor-global-agents-project" as const,
          agentsGlobalPath: "/home/user/.agents/skills",
          agentsProjectPath: ".agents/skills",
        },
      },
    };
    const paths = getEffectiveSkillsPaths(modified, "global");
    expect(paths).toHaveLength(1);
    expect(paths[0]?.source).toBe("vendor");
    expect(paths[0]?.scope).toBe("global");
  });

  it("vendor-global-agents-project returns agents+vendor for project scope", () => {
    const provider = getProvider("claude-code")!;
    const modified = {
      ...provider,
      capabilities: {
        ...provider.capabilities,
        skills: {
          ...provider.capabilities.skills,
          precedence: "vendor-global-agents-project" as const,
          agentsGlobalPath: null,
          agentsProjectPath: ".agents/skills",
        },
      },
    };
    const paths = getEffectiveSkillsPaths(modified, "project", "/my/project");
    expect(paths).toHaveLength(2);
    expect(paths[0]?.source).toBe("agents");
    expect(paths[0]?.scope).toBe("project");
    expect(paths[1]?.source).toBe("vendor");
    expect(paths[1]?.scope).toBe("project");
  });

  it("vendor-global-agents-project returns only vendor for project scope when agentsProjectPath is null", () => {
    const provider = getProvider("claude-code")!;
    const modified = {
      ...provider,
      capabilities: {
        ...provider.capabilities,
        skills: {
          ...provider.capabilities.skills,
          precedence: "vendor-global-agents-project" as const,
          agentsGlobalPath: null,
          agentsProjectPath: null,
        },
      },
    };
    const paths = getEffectiveSkillsPaths(modified, "project", "/my/project");
    expect(paths).toHaveLength(1);
    expect(paths[0]?.source).toBe("vendor");
  });

  it("falls back to vendor-only for unknown precedence", () => {
    const provider = getProvider("claude-code")!;
    const modified = {
      ...provider,
      capabilities: {
        ...provider.capabilities,
        skills: {
          ...provider.capabilities.skills,
          precedence: "unknown-precedence" as "vendor-only",
          agentsGlobalPath: null,
          agentsProjectPath: null,
        },
      },
    };
    const paths = getEffectiveSkillsPaths(modified, "global");
    expect(paths).toHaveLength(1);
    expect(paths[0]?.source).toBe("vendor");
  });
});
