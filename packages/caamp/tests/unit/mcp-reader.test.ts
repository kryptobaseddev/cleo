import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfigPath, listMcpServers, listAllMcpServers, removeMcpServer } from "../../src/core/mcp/reader.js";
import type { Provider } from "../../src/types.js";

let testDir: string;

/** Create a minimal provider for testing */
function makeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: "test-agent",
    toolName: "Test Agent",
    vendor: "test",
    agentFlag: "test",
    aliases: [],
    pathGlobal: "/tmp/test-global",
    pathProject: ".test",
    instructFile: "TEST.md",
    configKey: "mcpServers",
    configFormat: "json",
    configPathGlobal: join(testDir, "global-config.json"),
    configPathProject: ".test/config.json",
    pathSkills: "/tmp/test-skills",
    pathProjectSkills: ".test/skills",
    detection: { methods: ["binary"], binary: "test" },
    supportedTransports: ["stdio"],
    supportsHeaders: false,
    priority: "medium",
    status: "active",
    agentSkillsCompatible: false,
    ...overrides,
  };
}

beforeEach(async () => {
  testDir = join(tmpdir(), `caamp-reader-test-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true }).catch(() => {});
});

describe("resolveConfigPath", () => {
  it("returns global path for global scope", () => {
    const provider = makeProvider();
    const result = resolveConfigPath(provider, "global");
    expect(result).toBe(provider.configPathGlobal);
  });

  it("returns project path joined with projectDir", () => {
    const provider = makeProvider();
    const result = resolveConfigPath(provider, "project", testDir);
    expect(result).toBe(join(testDir, ".test/config.json"));
  });

  it("returns null for project scope when provider has no project config", () => {
    const provider = makeProvider({ configPathProject: null });
    const result = resolveConfigPath(provider, "project", testDir);
    expect(result).toBeNull();
  });

  it("uses cwd when no projectDir specified for project scope", () => {
    const provider = makeProvider();
    const result = resolveConfigPath(provider, "project");
    expect(result).toBe(join(process.cwd(), ".test/config.json"));
  });
});

describe("listMcpServers", () => {
  it("returns empty array when config file does not exist", async () => {
    const provider = makeProvider();
    const result = await listMcpServers(provider, "global");
    expect(result).toEqual([]);
  });

  it("returns empty array when provider has no project config path", async () => {
    const provider = makeProvider({ configPathProject: null });
    const result = await listMcpServers(provider, "project", testDir);
    expect(result).toEqual([]);
  });

  it("lists servers from a JSON config file", async () => {
    const configPath = join(testDir, "global-config.json");
    await writeFile(configPath, JSON.stringify({
      mcpServers: {
        "server-a": { command: "npx", args: ["-y", "server-a"] },
        "server-b": { url: "https://example.com/sse", type: "sse" },
      },
    }, null, 2));

    const provider = makeProvider({ configPathGlobal: configPath });
    const result = await listMcpServers(provider, "global");

    expect(result).toHaveLength(2);
    expect(result[0]?.name).toBe("server-a");
    expect(result[0]?.providerId).toBe("test-agent");
    expect(result[0]?.providerName).toBe("Test Agent");
    expect(result[0]?.scope).toBe("global");
    expect(result[0]?.configPath).toBe(configPath);
    expect(result[0]?.config).toEqual({ command: "npx", args: ["-y", "server-a"] });
    expect(result[1]?.name).toBe("server-b");
  });

  it("returns empty array when config key has no servers", async () => {
    const configPath = join(testDir, "global-config.json");
    await writeFile(configPath, JSON.stringify({ mcpServers: {} }, null, 2));

    const provider = makeProvider({ configPathGlobal: configPath });
    const result = await listMcpServers(provider, "global");
    expect(result).toEqual([]);
  });

  it("returns empty array when config key is missing", async () => {
    const configPath = join(testDir, "global-config.json");
    await writeFile(configPath, JSON.stringify({ otherKey: {} }, null, 2));

    const provider = makeProvider({ configPathGlobal: configPath });
    const result = await listMcpServers(provider, "global");
    expect(result).toEqual([]);
  });

  it("handles nested config keys", async () => {
    const configPath = join(testDir, "global-config.json");
    await writeFile(configPath, JSON.stringify({
      context_servers: {
        "my-server": { command: "test" },
      },
    }, null, 2));

    const provider = makeProvider({
      configPathGlobal: configPath,
      configKey: "context_servers",
    });
    const result = await listMcpServers(provider, "global");

    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("my-server");
  });

  it("handles malformed config files gracefully", async () => {
    const configPath = join(testDir, "global-config.json");
    await writeFile(configPath, "not valid json {{{");

    const provider = makeProvider({ configPathGlobal: configPath });
    const result = await listMcpServers(provider, "global");
    expect(result).toEqual([]);
  });
});

describe("listAllMcpServers", () => {
  it("lists servers across multiple providers", async () => {
    const configA = join(testDir, "config-a.json");
    const configB = join(testDir, "config-b.json");

    await writeFile(configA, JSON.stringify({
      mcpServers: { "server-1": { command: "a" } },
    }, null, 2));
    await writeFile(configB, JSON.stringify({
      mcpServers: { "server-2": { command: "b" } },
    }, null, 2));

    const providerA = makeProvider({ id: "agent-a", configPathGlobal: configA });
    const providerB = makeProvider({ id: "agent-b", configPathGlobal: configB });

    const result = await listAllMcpServers([providerA, providerB], "global");
    expect(result).toHaveLength(2);
    expect(result[0]?.providerId).toBe("agent-a");
    expect(result[1]?.providerId).toBe("agent-b");
  });

  it("deduplicates by config path", async () => {
    const sharedConfig = join(testDir, "shared-config.json");
    await writeFile(sharedConfig, JSON.stringify({
      mcpServers: { "server-x": { command: "x" } },
    }, null, 2));

    const providerA = makeProvider({ id: "agent-a", configPathGlobal: sharedConfig });
    const providerB = makeProvider({ id: "agent-b", configPathGlobal: sharedConfig });

    const result = await listAllMcpServers([providerA, providerB], "global");
    // Should only include entries from the first provider that claimed this config path
    expect(result).toHaveLength(1);
    expect(result[0]?.providerId).toBe("agent-a");
  });

  it("returns empty array when no providers given", async () => {
    const result = await listAllMcpServers([], "global");
    expect(result).toEqual([]);
  });
});

describe("removeMcpServer", () => {
  it("removes a server from a JSON config", async () => {
    const configPath = join(testDir, "config.json");
    await writeFile(configPath, JSON.stringify({
      mcpServers: {
        "keep": { command: "keep" },
        "remove-me": { command: "gone" },
      },
    }, null, 2));

    const provider = makeProvider({ configPathGlobal: configPath });
    const result = await removeMcpServer(provider, "remove-me", "global");
    expect(result).toBe(true);

    // Verify the server was removed
    const remaining = await listMcpServers(provider, "global");
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.name).toBe("keep");
  });

  it("returns false when server does not exist", async () => {
    const configPath = join(testDir, "config.json");
    await writeFile(configPath, JSON.stringify({
      mcpServers: { "other": { command: "x" } },
    }, null, 2));

    const provider = makeProvider({ configPathGlobal: configPath });
    const result = await removeMcpServer(provider, "nonexistent", "global");
    expect(result).toBe(false);
  });

  it("returns false when config file does not exist", async () => {
    const provider = makeProvider({
      configPathGlobal: join(testDir, "nonexistent.json"),
    });
    const result = await removeMcpServer(provider, "test", "global");
    expect(result).toBe(false);
  });

  it("returns false when provider has no project config path", async () => {
    const provider = makeProvider({ configPathProject: null });
    const result = await removeMcpServer(provider, "test", "project", testDir);
    expect(result).toBe(false);
  });
});
