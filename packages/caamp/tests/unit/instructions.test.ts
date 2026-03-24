import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkInjection,
  inject,
  removeInjection,
  checkAllInjections,
  injectAll,
} from "../../src/core/instructions/injector.js";
import {
  generateInjectionContent,
  generateSkillsSection,
  getInstructFile,
  groupByInstructFile,
} from "../../src/core/instructions/templates.js";
import type { Provider } from "../../src/types.js";

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `caamp-instr-test-${Date.now()}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true }).catch(() => {});
});

/** Helper to create a minimal Provider stub */
function makeProvider(overrides: Partial<Provider> & { id: string; instructFile: string }): Provider {
  return {
    toolName: overrides.id,
    vendor: "test",
    agentFlag: `--${overrides.id}`,
    aliases: [],
    pathGlobal: testDir,
    pathProject: ".",
    configKey: "mcpServers",
    configFormat: "json",
    configPathGlobal: join(testDir, "config.json"),
    configPathProject: null,
    pathSkills: join(testDir, "skills"),
    pathProjectSkills: ".skills",
    detection: { methods: ["binary"] },
    supportedTransports: ["stdio"],
    supportsHeaders: false,
    priority: "medium",
    status: "active",
    agentSkillsCompatible: true,
    ...overrides,
  } as Provider;
}

// ── Injector ────────────────────────────────────────────────────────

describe("inject()", () => {
  it("creates a new file with markers when file does not exist", async () => {
    const filePath = join(testDir, "NEW.md");
    const result = await inject(filePath, "Hello CAAMP");

    expect(result).toBe("created");
    const content = await readFile(filePath, "utf-8");
    expect(content).toContain("<!-- CAAMP:START -->");
    expect(content).toContain("<!-- CAAMP:END -->");
    expect(content).toContain("Hello CAAMP");
  });

  it("prepends block to existing file without markers", async () => {
    const filePath = join(testDir, "EXISTING.md");
    await writeFile(filePath, "# My Project\n\nSome existing content.\n");

    const result = await inject(filePath, "Injected content");

    expect(result).toBe("added");
    const content = await readFile(filePath, "utf-8");
    expect(content.indexOf("<!-- CAAMP:START -->")).toBe(0);
    expect(content).toContain("Injected content");
    expect(content).toContain("# My Project");
  });

  it("updates existing block when markers already present", async () => {
    const filePath = join(testDir, "UPDATE.md");
    await writeFile(
      filePath,
      "# Header\n<!-- CAAMP:START -->\nold content\n<!-- CAAMP:END -->\n# Footer\n",
    );

    const result = await inject(filePath, "new content");

    expect(result).toBe("updated");
    const content = await readFile(filePath, "utf-8");
    expect(content).toContain("new content");
    expect(content).not.toContain("old content");
    expect(content).toContain("# Header");
    expect(content).toContain("# Footer");
  });

  it("creates parent directories if they do not exist", async () => {
    const filePath = join(testDir, "deep", "nested", "dir", "FILE.md");
    const result = await inject(filePath, "deep content");

    expect(result).toBe("created");
    expect(existsSync(filePath)).toBe(true);
  });
});

describe("checkInjection()", () => {
  it("returns 'missing' when file does not exist", async () => {
    const status = await checkInjection(join(testDir, "nope.md"));
    expect(status).toBe("missing");
  });

  it("returns 'none' when file exists but has no markers", async () => {
    const filePath = join(testDir, "plain.md");
    await writeFile(filePath, "# Just a file\n");

    const status = await checkInjection(filePath);
    expect(status).toBe("none");
  });

  it("returns 'current' when markers present and no expected content given", async () => {
    const filePath = join(testDir, "has-markers.md");
    await writeFile(
      filePath,
      "<!-- CAAMP:START -->\nsome block\n<!-- CAAMP:END -->\n",
    );

    const status = await checkInjection(filePath);
    expect(status).toBe("current");
  });

  it("returns 'current' when marker content matches expected", async () => {
    const filePath = join(testDir, "current.md");
    await writeFile(
      filePath,
      "<!-- CAAMP:START -->\nexpected text\n<!-- CAAMP:END -->\n",
    );

    const status = await checkInjection(filePath, "expected text");
    expect(status).toBe("current");
  });

  it("returns 'outdated' when marker content does not match expected", async () => {
    const filePath = join(testDir, "outdated.md");
    await writeFile(
      filePath,
      "<!-- CAAMP:START -->\nold text\n<!-- CAAMP:END -->\n",
    );

    const status = await checkInjection(filePath, "new text");
    expect(status).toBe("outdated");
  });
});

describe("removeInjection()", () => {
  it("returns false when file does not exist", async () => {
    const result = await removeInjection(join(testDir, "nope.md"));
    expect(result).toBe(false);
  });

  it("returns false when file has no markers", async () => {
    const filePath = join(testDir, "no-markers.md");
    await writeFile(filePath, "# Clean file\n");

    const result = await removeInjection(filePath);
    expect(result).toBe(false);
  });

  it("removes marker block and keeps surrounding content", async () => {
    const filePath = join(testDir, "has-block.md");
    await writeFile(
      filePath,
      "# Header\n\n<!-- CAAMP:START -->\ninjected\n<!-- CAAMP:END -->\n\n# Footer\n",
    );

    const result = await removeInjection(filePath);
    expect(result).toBe(true);

    const content = await readFile(filePath, "utf-8");
    expect(content).not.toContain("CAAMP:START");
    expect(content).not.toContain("CAAMP:END");
    expect(content).toContain("# Header");
    expect(content).toContain("# Footer");
  });

  it("deletes file entirely if only marker content remains", async () => {
    const filePath = join(testDir, "only-block.md");
    await writeFile(
      filePath,
      "<!-- CAAMP:START -->\nonly this\n<!-- CAAMP:END -->",
    );

    const result = await removeInjection(filePath);
    expect(result).toBe(true);
    expect(existsSync(filePath)).toBe(false);
  });
});

describe("checkAllInjections()", () => {
  it("checks multiple providers and deduplicates by file path", async () => {
    const filePath = join(testDir, "CLAUDE.md");
    await writeFile(filePath, "<!-- CAAMP:START -->\nblock\n<!-- CAAMP:END -->\n");

    const providers = [
      makeProvider({ id: "p1", instructFile: "CLAUDE.md" }),
      makeProvider({ id: "p2", instructFile: "CLAUDE.md" }), // same file
    ];

    const results = await checkAllInjections(providers, testDir, "project");
    // Should deduplicate - only one result for CLAUDE.md
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("current");
    expect(results[0]?.fileExists).toBe(true);
  });

  it("returns results for different instruction files", async () => {
    await writeFile(join(testDir, "CLAUDE.md"), "<!-- CAAMP:START -->\nx\n<!-- CAAMP:END -->\n");
    // AGENTS.md does not exist

    const providers = [
      makeProvider({ id: "p1", instructFile: "CLAUDE.md" }),
      makeProvider({ id: "p2", instructFile: "AGENTS.md" }),
    ];

    const results = await checkAllInjections(providers, testDir, "project");
    expect(results).toHaveLength(2);

    const claudeResult = results.find((r) => r.file.includes("CLAUDE.md"));
    const agentsResult = results.find((r) => r.file.includes("AGENTS.md"));
    expect(claudeResult?.status).toBe("current");
    expect(agentsResult?.status).toBe("missing");
  });
});

describe("injectAll()", () => {
  it("injects into all unique instruction files", async () => {
    const providers = [
      makeProvider({ id: "p1", instructFile: "CLAUDE.md" }),
      makeProvider({ id: "p2", instructFile: "AGENTS.md" }),
      makeProvider({ id: "p3", instructFile: "CLAUDE.md" }), // duplicate
    ];

    const results = await injectAll(providers, testDir, "project", "test content");
    expect(results.size).toBe(2);

    const claudeContent = await readFile(join(testDir, "CLAUDE.md"), "utf-8");
    const agentsContent = await readFile(join(testDir, "AGENTS.md"), "utf-8");
    expect(claudeContent).toContain("test content");
    expect(agentsContent).toContain("test content");
  });
});

// ── Templates ───────────────────────────────────────────────────────

describe("generateInjectionContent()", () => {
  it("produces basic content with no options", () => {
    const content = generateInjectionContent();
    expect(content).toContain("CAAMP Managed Configuration");
    expect(content).toContain("Do not edit between the CAAMP markers manually.");
  });

  it("includes MCP server name when provided", () => {
    const content = generateInjectionContent({ mcpServerName: "my-server" });
    expect(content).toContain("### MCP Server: my-server");
    expect(content).toContain("caamp mcp install");
  });

  it("includes custom content when provided", () => {
    const content = generateInjectionContent({ customContent: "Extra info here" });
    expect(content).toContain("Extra info here");
  });

  it("includes both MCP server and custom content", () => {
    const content = generateInjectionContent({
      mcpServerName: "srv",
      customContent: "Custom block",
    });
    expect(content).toContain("### MCP Server: srv");
    expect(content).toContain("Custom block");
  });
});

describe("generateSkillsSection()", () => {
  it("returns empty string for empty skills array", () => {
    expect(generateSkillsSection([])).toBe("");
  });

  it("lists all skill names", () => {
    const section = generateSkillsSection(["alpha", "beta", "gamma"]);
    expect(section).toContain("### Installed Skills");
    expect(section).toContain("`alpha`");
    expect(section).toContain("`beta`");
    expect(section).toContain("`gamma`");
  });
});

describe("getInstructFile()", () => {
  it("returns the provider instruction file", () => {
    const provider = makeProvider({ id: "test", instructFile: "CLAUDE.md" });
    expect(getInstructFile(provider)).toBe("CLAUDE.md");
  });
});

describe("groupByInstructFile()", () => {
  it("groups providers by their instructFile field", () => {
    const providers = [
      makeProvider({ id: "a", instructFile: "CLAUDE.md" }),
      makeProvider({ id: "b", instructFile: "AGENTS.md" }),
      makeProvider({ id: "c", instructFile: "CLAUDE.md" }),
      makeProvider({ id: "d", instructFile: "GEMINI.md" }),
    ];

    const groups = groupByInstructFile(providers);
    expect(groups.size).toBe(3);
    expect(groups.get("CLAUDE.md")).toHaveLength(2);
    expect(groups.get("AGENTS.md")).toHaveLength(1);
    expect(groups.get("GEMINI.md")).toHaveLength(1);
  });

  it("returns empty map for empty array", () => {
    const groups = groupByInstructFile([]);
    expect(groups.size).toBe(0);
  });
});
