import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAllHarnesses, getHarnessFor, getPrimaryHarness, PiHarness, } from "../../../src/core/harness/index.js";
import { getProvider, resetRegistry } from "../../../src/core/registry/providers.js";
let piRoot;
let projectDir;
let savedPiDir;
function makeHarness() {
    const provider = getProvider("pi");
    if (!provider)
        throw new Error("pi provider missing from registry");
    return new PiHarness(provider);
}
beforeEach(async () => {
    resetRegistry();
    // Unique tmpdir per test to avoid cross-pollution.
    const unique = `caamp-pi-harness-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    piRoot = join(tmpdir(), unique, "pi-agent");
    projectDir = join(tmpdir(), unique, "project");
    await mkdir(piRoot, { recursive: true });
    await mkdir(projectDir, { recursive: true });
    savedPiDir = process.env["PI_CODING_AGENT_DIR"];
    process.env["PI_CODING_AGENT_DIR"] = piRoot;
});
afterEach(async () => {
    if (savedPiDir === undefined) {
        delete process.env["PI_CODING_AGENT_DIR"];
    }
    else {
        process.env["PI_CODING_AGENT_DIR"] = savedPiDir;
    }
    await rm(join(tmpdir(), piRoot.split("/").slice(-2, -1)[0] ?? ""), {
        recursive: true,
        force: true,
    }).catch(() => { });
});
// ── Construction / dispatcher ────────────────────────────────────────
describe("harness dispatcher", () => {
    it("getHarnessFor returns PiHarness for pi provider", () => {
        const pi = getProvider("pi");
        expect(pi).toBeDefined();
        const harness = getHarnessFor(pi);
        expect(harness).not.toBeNull();
        expect(harness?.id).toBe("pi");
        expect(harness).toBeInstanceOf(PiHarness);
    });
    it("getHarnessFor returns null for providers without a harness", () => {
        const claude = getProvider("claude-code");
        expect(claude).toBeDefined();
        expect(getHarnessFor(claude)).toBeNull();
    });
    it("getPrimaryHarness returns the pi harness", () => {
        const primary = getPrimaryHarness();
        expect(primary).not.toBeNull();
        expect(primary?.id).toBe("pi");
    });
    it("getAllHarnesses returns at least the pi harness", () => {
        const all = getAllHarnesses();
        expect(all.length).toBeGreaterThanOrEqual(1);
        expect(all.some((h) => h.id === "pi")).toBe(true);
    });
    it("PiHarness exposes its provider and id", () => {
        const harness = makeHarness();
        expect(harness.id).toBe("pi");
        expect(harness.provider.id).toBe("pi");
        expect(harness.provider.toolName).toBe("Pi Coding Agent");
    });
});
// ── Skills ──────────────────────────────────────────────────────────
describe("PiHarness skills (global)", () => {
    const globalScope = { kind: "global" };
    async function writeSourceSkill() {
        const src = join(tmpdir(), `caamp-pi-src-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        await mkdir(src, { recursive: true });
        await writeFile(join(src, "SKILL.md"), "---\nname: demo\n---\nhello\n", "utf8");
        await mkdir(join(src, "sub"), { recursive: true });
        await writeFile(join(src, "sub", "helper.md"), "helper\n", "utf8");
        return src;
    }
    it("installSkill copies skill directory recursively into $PI/skills/<name>", async () => {
        const harness = makeHarness();
        const src = await writeSourceSkill();
        await harness.installSkill(src, "demo", globalScope);
        const target = join(piRoot, "skills", "demo");
        expect(existsSync(target)).toBe(true);
        const skillMd = await readFile(join(target, "SKILL.md"), "utf8");
        expect(skillMd).toContain("name: demo");
        const helper = await readFile(join(target, "sub", "helper.md"), "utf8");
        expect(helper).toBe("helper\n");
    });
    it("installSkill is idempotent and overwrites cleanly on re-install", async () => {
        const harness = makeHarness();
        const src = await writeSourceSkill();
        await harness.installSkill(src, "demo", globalScope);
        // Mutate the target to simulate stale content.
        const target = join(piRoot, "skills", "demo");
        await writeFile(join(target, "stale.txt"), "stale\n", "utf8");
        expect(existsSync(join(target, "stale.txt"))).toBe(true);
        await harness.installSkill(src, "demo", globalScope);
        expect(existsSync(join(target, "stale.txt"))).toBe(false);
        expect(existsSync(join(target, "SKILL.md"))).toBe(true);
    });
    it("removeSkill deletes the skill directory", async () => {
        const harness = makeHarness();
        const src = await writeSourceSkill();
        await harness.installSkill(src, "demo", globalScope);
        const target = join(piRoot, "skills", "demo");
        expect(existsSync(target)).toBe(true);
        await harness.removeSkill("demo", globalScope);
        expect(existsSync(target)).toBe(false);
    });
    it("removeSkill tolerates missing skill", async () => {
        const harness = makeHarness();
        await expect(harness.removeSkill("not-here", globalScope)).resolves.toBeUndefined();
    });
    it("listSkills returns [] when the skills directory is missing", async () => {
        const harness = makeHarness();
        expect(await harness.listSkills(globalScope)).toEqual([]);
    });
    it("listSkills returns only directories, sorted or unsorted", async () => {
        const harness = makeHarness();
        const src = await writeSourceSkill();
        await harness.installSkill(src, "alpha", globalScope);
        await harness.installSkill(src, "beta", globalScope);
        // Drop a file next to the dirs — it should be excluded.
        await writeFile(join(piRoot, "skills", "stray.txt"), "ignored\n", "utf8");
        const listed = await harness.listSkills(globalScope);
        expect(listed).toHaveLength(2);
        expect(new Set(listed)).toEqual(new Set(["alpha", "beta"]));
    });
});
describe("PiHarness skills (project)", () => {
    it("installSkill copies into <projectDir>/.pi/skills/<name>", async () => {
        const harness = makeHarness();
        const scope = { kind: "project", projectDir };
        const src = join(tmpdir(), `caamp-pi-src-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        await mkdir(src, { recursive: true });
        await writeFile(join(src, "SKILL.md"), "project-skill\n", "utf8");
        await harness.installSkill(src, "project-skill", scope);
        const target = join(projectDir, ".pi", "skills", "project-skill");
        expect(existsSync(target)).toBe(true);
        expect(await readFile(join(target, "SKILL.md"), "utf8")).toBe("project-skill\n");
        expect(await harness.listSkills(scope)).toEqual(["project-skill"]);
        await harness.removeSkill("project-skill", scope);
        expect(existsSync(target)).toBe(false);
    });
});
// ── Instructions ────────────────────────────────────────────────────
describe("PiHarness instructions (global)", () => {
    const globalScope = { kind: "global" };
    it("injectInstructions creates AGENTS.md with just the marker block when file is missing", async () => {
        const harness = makeHarness();
        await harness.injectInstructions("hello world", globalScope);
        const content = await readFile(join(piRoot, "AGENTS.md"), "utf8");
        expect(content).toContain("<!-- CAAMP:START -->");
        expect(content).toContain("<!-- CAAMP:END -->");
        expect(content).toContain("hello world");
    });
    it("injectInstructions is idempotent when called twice with the same content", async () => {
        const harness = makeHarness();
        await harness.injectInstructions("same", globalScope);
        await harness.injectInstructions("same", globalScope);
        const content = await readFile(join(piRoot, "AGENTS.md"), "utf8");
        const starts = content.match(/<!-- CAAMP:START -->/g)?.length ?? 0;
        const ends = content.match(/<!-- CAAMP:END -->/g)?.length ?? 0;
        expect(starts).toBe(1);
        expect(ends).toBe(1);
    });
    it("injectInstructions replaces the block when content changes", async () => {
        const harness = makeHarness();
        await harness.injectInstructions("v1", globalScope);
        await harness.injectInstructions("v2", globalScope);
        const content = await readFile(join(piRoot, "AGENTS.md"), "utf8");
        expect(content).toContain("v2");
        expect(content).not.toContain("v1");
    });
    it("injectInstructions preserves surrounding content when appending to an existing file", async () => {
        const harness = makeHarness();
        const filePath = join(piRoot, "AGENTS.md");
        await writeFile(filePath, "# Pre-existing\n\nUser content.\n", "utf8");
        await harness.injectInstructions("caamp block", globalScope);
        const content = await readFile(filePath, "utf8");
        expect(content).toContain("# Pre-existing");
        expect(content).toContain("User content.");
        expect(content).toContain("caamp block");
        expect(content.indexOf("User content")).toBeLessThan(content.indexOf("caamp block"));
    });
    it("injectInstructions preserves surrounding content when updating an existing block", async () => {
        const harness = makeHarness();
        const filePath = join(piRoot, "AGENTS.md");
        await writeFile(filePath, "# Header\n\n<!-- CAAMP:START -->\nold\n<!-- CAAMP:END -->\n\n# Footer\n", "utf8");
        await harness.injectInstructions("new", globalScope);
        const content = await readFile(filePath, "utf8");
        expect(content).toContain("# Header");
        expect(content).toContain("# Footer");
        expect(content).toContain("new");
        expect(content).not.toContain("old");
    });
    it("injectInstructions handles files that do not end with a newline", async () => {
        const harness = makeHarness();
        const filePath = join(piRoot, "AGENTS.md");
        await writeFile(filePath, "no trailing newline", "utf8");
        await harness.injectInstructions("block", globalScope);
        const content = await readFile(filePath, "utf8");
        expect(content).toContain("no trailing newline");
        expect(content).toContain("block");
    });
    it("removeInstructions strips the block but preserves surrounding content", async () => {
        const harness = makeHarness();
        const filePath = join(piRoot, "AGENTS.md");
        await writeFile(filePath, "# Header\n\n<!-- CAAMP:START -->\nblock\n<!-- CAAMP:END -->\n\n# Footer\n", "utf8");
        await harness.removeInstructions(globalScope);
        const content = await readFile(filePath, "utf8");
        expect(content).not.toContain("<!-- CAAMP:START -->");
        expect(content).not.toContain("<!-- CAAMP:END -->");
        expect(content).not.toContain("block");
        expect(content).toContain("# Header");
        expect(content).toContain("# Footer");
    });
    it("removeInstructions tolerates a missing instruction file", async () => {
        const harness = makeHarness();
        await expect(harness.removeInstructions(globalScope)).resolves.toBeUndefined();
    });
    it("removeInstructions is a no-op when the marker block is absent", async () => {
        const harness = makeHarness();
        const filePath = join(piRoot, "AGENTS.md");
        await writeFile(filePath, "just user content\n", "utf8");
        await harness.removeInstructions(globalScope);
        const content = await readFile(filePath, "utf8");
        expect(content).toBe("just user content\n");
    });
    it("removeInstructions handles a file that contained only the block", async () => {
        const harness = makeHarness();
        await harness.injectInstructions("only", globalScope);
        await harness.removeInstructions(globalScope);
        const content = await readFile(join(piRoot, "AGENTS.md"), "utf8");
        expect(content).not.toContain("<!-- CAAMP:START -->");
        expect(content).not.toContain("only");
    });
});
describe("PiHarness instructions (project)", () => {
    it("writes AGENTS.md at the project root, not under .pi/", async () => {
        const harness = makeHarness();
        const scope = { kind: "project", projectDir };
        await harness.injectInstructions("project block", scope);
        expect(existsSync(join(projectDir, "AGENTS.md"))).toBe(true);
        expect(existsSync(join(projectDir, ".pi", "AGENTS.md"))).toBe(false);
        const content = await readFile(join(projectDir, "AGENTS.md"), "utf8");
        expect(content).toContain("project block");
        await harness.removeInstructions(scope);
        const after = await readFile(join(projectDir, "AGENTS.md"), "utf8");
        expect(after).not.toContain("project block");
    });
});
// ── MCP-as-extension scaffold ───────────────────────────────────────
describe("PiHarness installMcpAsExtension", () => {
    it("writes a Pi extension scaffold under extensions/ (global)", async () => {
        const harness = makeHarness();
        await harness.installMcpAsExtension({
            name: "filesystem",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
            env: { FOO: "bar" },
        }, { kind: "global" });
        const filePath = join(piRoot, "extensions", "mcp-filesystem.ts");
        expect(existsSync(filePath)).toBe(true);
        const src = await readFile(filePath, "utf8");
        expect(src).toContain("AUTO-GENERATED");
        expect(src).toContain("export default");
        expect(src).toContain("registerTool");
        expect(src).toContain("mcp_filesystem");
        expect(src).toContain('"@modelcontextprotocol/server-filesystem"');
        expect(src).toContain('"FOO": "bar"');
    });
    it("supports remote MCP servers with url + headers (project scope)", async () => {
        const harness = makeHarness();
        const scope = { kind: "project", projectDir };
        await harness.installMcpAsExtension({
            name: "remote-svc",
            url: "https://example.com/mcp",
            headers: { "X-Key": "secret" },
        }, scope);
        const filePath = join(projectDir, ".pi", "extensions", "mcp-remote-svc.ts");
        expect(existsSync(filePath)).toBe(true);
        const src = await readFile(filePath, "utf8");
        expect(src).toContain("https://example.com/mcp");
        expect(src).toContain("X-Key");
    });
    it("overwrites the scaffold on re-install", async () => {
        const harness = makeHarness();
        const scope = { kind: "global" };
        await harness.installMcpAsExtension({ name: "svc", command: "old" }, scope);
        await harness.installMcpAsExtension({ name: "svc", command: "new" }, scope);
        const src = await readFile(join(piRoot, "extensions", "mcp-svc.ts"), "utf8");
        expect(src).toContain('"command": "new"');
        expect(src).not.toContain('"command": "old"');
    });
});
// ── Settings ────────────────────────────────────────────────────────
describe("PiHarness settings", () => {
    it("readSettings returns {} when settings.json is missing", async () => {
        const harness = makeHarness();
        const settings = await harness.readSettings({ kind: "global" });
        expect(settings).toEqual({});
    });
    it("readSettings returns {} for malformed JSON", async () => {
        const harness = makeHarness();
        await mkdir(piRoot, { recursive: true });
        await writeFile(join(piRoot, "settings.json"), "{ not: valid json", "utf8");
        const settings = await harness.readSettings({ kind: "global" });
        expect(settings).toEqual({});
    });
    it("writeSettings merges rather than replacing", async () => {
        const harness = makeHarness();
        const scope = { kind: "global" };
        await harness.writeSettings({ theme: "dark", picker: { model: "claude" } }, scope);
        await harness.writeSettings({ picker: { scroll: true } }, scope);
        const settings = await harness.readSettings(scope);
        expect(settings).toEqual({
            theme: "dark",
            picker: { model: "claude", scroll: true },
        });
    });
    it("writeSettings replaces arrays wholesale (no array merging)", async () => {
        const harness = makeHarness();
        const scope = { kind: "global" };
        await harness.writeSettings({ list: [1, 2, 3] }, scope);
        await harness.writeSettings({ list: [9] }, scope);
        const settings = (await harness.readSettings(scope));
        expect(settings.list).toEqual([9]);
    });
    it("writeSettings persists to a project-scope settings file", async () => {
        const harness = makeHarness();
        const scope = { kind: "project", projectDir };
        await harness.writeSettings({ theme: "light" }, scope);
        expect(existsSync(join(projectDir, ".pi", "settings.json"))).toBe(true);
        const settings = await harness.readSettings(scope);
        expect(settings).toEqual({ theme: "light" });
    });
    it("configureModels sets enabledModels without clobbering other settings", async () => {
        const harness = makeHarness();
        const scope = { kind: "global" };
        await harness.writeSettings({ theme: "dark" }, scope);
        await harness.configureModels(["anthropic/*", "openai/gpt-*"], scope);
        const settings = (await harness.readSettings(scope));
        expect(settings.theme).toBe("dark");
        expect(settings.enabledModels).toEqual(["anthropic/*", "openai/gpt-*"]);
    });
    it("writeSettings recovers from a settings.json that parses to a non-object", async () => {
        const harness = makeHarness();
        await mkdir(piRoot, { recursive: true });
        await writeFile(join(piRoot, "settings.json"), "[1,2,3]", "utf8");
        // readSettings will return [1,2,3] (valid JSON), writeSettings should
        // treat the non-object as empty for merge purposes.
        await harness.writeSettings({ replacement: true }, { kind: "global" });
        const settings = await harness.readSettings({ kind: "global" });
        expect(settings).toEqual({ replacement: true });
    });
});
// ── Subagent spawn (verification only — no actual `pi` invocation) ──
describe("PiHarness spawnSubagent", () => {
    it("throws a clear error when the provider is missing a spawnCommand", async () => {
        const base = getProvider("pi");
        if (!base)
            throw new Error("pi provider missing");
        const spawnCap = {
            ...base.capabilities.spawn,
            spawnCommand: null,
        };
        const provider = {
            ...base,
            capabilities: {
                ...base.capabilities,
                spawn: spawnCap,
            },
        };
        const harness = new PiHarness(provider);
        await expect(harness.spawnSubagent({ targetProviderId: "claude-code", prompt: "hi" })).rejects.toThrow(/spawnCommand/);
    });
    it("throws when spawnCommand is an empty array", async () => {
        const base = getProvider("pi");
        if (!base)
            throw new Error("pi provider missing");
        const spawnCap = {
            ...base.capabilities.spawn,
            spawnCommand: [],
        };
        const provider = {
            ...base,
            capabilities: { ...base.capabilities, spawn: spawnCap },
        };
        const harness = new PiHarness(provider);
        await expect(harness.spawnSubagent({ targetProviderId: "claude-code", prompt: "hi" })).rejects.toThrow(/spawnCommand/);
    });
    it("throws when spawnCommand has an empty program", async () => {
        const base = getProvider("pi");
        if (!base)
            throw new Error("pi provider missing");
        const spawnCap = {
            ...base.capabilities.spawn,
            spawnCommand: ["", "--mode", "json"],
        };
        const provider = {
            ...base,
            capabilities: { ...base.capabilities, spawn: spawnCap },
        };
        const harness = new PiHarness(provider);
        await expect(harness.spawnSubagent({ targetProviderId: "claude-code", prompt: "hi" })).rejects.toThrow(/spawnCommand/);
    });
    it("reads spawnCommand from the provider and launches a child (using a safe stand-in)", async () => {
        // Replace the pi spawnCommand with a harmless `node -e ""` call so the
        // test does not depend on pi being installed on CI. We verify that the
        // harness produces a handle with a pid and an awaitable result.
        const base = getProvider("pi");
        if (!base)
            throw new Error("pi provider missing");
        const spawnCap = {
            ...base.capabilities.spawn,
            spawnCommand: [process.execPath, "-e", "process.stdout.write(process.argv[1] || '')"],
        };
        const provider = {
            ...base,
            capabilities: { ...base.capabilities, spawn: spawnCap },
        };
        const harness = new PiHarness(provider);
        const handle = await harness.spawnSubagent({
            targetProviderId: "claude-code",
            prompt: "PROMPT-MARKER",
        });
        expect(typeof handle.pid === "number" || handle.pid === null).toBe(true);
        const result = await handle.result;
        expect(result.exitCode).toBe(0);
    });
});
//# sourceMappingURL=pi.test.js.map