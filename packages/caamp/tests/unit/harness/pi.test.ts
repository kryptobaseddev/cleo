import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getAllHarnesses,
  getHarnessFor,
  getPrimaryHarness,
  PiHarness,
} from "../../../src/core/harness/index.js";
import {
  resolveAllTiers,
  resolveTierDir,
  TIER_PRECEDENCE,
} from "../../../src/core/harness/scope.js";
import type { HarnessScope } from "../../../src/core/harness/types.js";
import { getProvider, resetRegistry } from "../../../src/core/registry/providers.js";
import type { Provider, ProviderSpawnCapability } from "../../../src/types.js";

let piRoot: string;
let projectDir: string;
let cleoHomeRoot: string;
let uniqueRoot: string;
let savedPiDir: string | undefined;
let savedCleoHome: string | undefined;

function makeHarness(): PiHarness {
  const provider = getProvider("pi");
  if (!provider) throw new Error("pi provider missing from registry");
  return new PiHarness(provider);
}

beforeEach(async () => {
  resetRegistry();
  // Unique tmpdir per test to avoid cross-pollution.
  const unique = `caamp-pi-harness-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  uniqueRoot = join(tmpdir(), unique);
  piRoot = join(uniqueRoot, "pi-agent");
  projectDir = join(uniqueRoot, "project");
  cleoHomeRoot = join(uniqueRoot, "cleo-home");
  await mkdir(piRoot, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  await mkdir(cleoHomeRoot, { recursive: true });

  savedPiDir = process.env["PI_CODING_AGENT_DIR"];
  savedCleoHome = process.env["CLEO_HOME"];
  process.env["PI_CODING_AGENT_DIR"] = piRoot;
  process.env["CLEO_HOME"] = cleoHomeRoot;
});

afterEach(async () => {
  if (savedPiDir === undefined) {
    delete process.env["PI_CODING_AGENT_DIR"];
  } else {
    process.env["PI_CODING_AGENT_DIR"] = savedPiDir;
  }
  if (savedCleoHome === undefined) {
    delete process.env["CLEO_HOME"];
  } else {
    process.env["CLEO_HOME"] = savedCleoHome;
  }
  await rm(uniqueRoot, {
    recursive: true,
    force: true,
  }).catch(() => {});
});

// ── Construction / dispatcher ────────────────────────────────────────

describe("harness dispatcher", () => {
  it("getHarnessFor returns PiHarness for pi provider", () => {
    const pi = getProvider("pi");
    expect(pi).toBeDefined();
    const harness = getHarnessFor(pi!);
    expect(harness).not.toBeNull();
    expect(harness?.id).toBe("pi");
    expect(harness).toBeInstanceOf(PiHarness);
  });

  it("getHarnessFor returns null for providers without a harness", () => {
    const claude = getProvider("claude-code");
    expect(claude).toBeDefined();
    expect(getHarnessFor(claude!)).toBeNull();
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
  const globalScope: HarnessScope = { kind: "global" };

  async function writeSourceSkill(): Promise<string> {
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
    const scope: HarnessScope = { kind: "project", projectDir };

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
  const globalScope: HarnessScope = { kind: "global" };

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
    await writeFile(
      filePath,
      "# Header\n\n<!-- CAAMP:START -->\nold\n<!-- CAAMP:END -->\n\n# Footer\n",
      "utf8",
    );

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
    await writeFile(
      filePath,
      "# Header\n\n<!-- CAAMP:START -->\nblock\n<!-- CAAMP:END -->\n\n# Footer\n",
      "utf8",
    );

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
    const scope: HarnessScope = { kind: "project", projectDir };

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
    const scope: HarnessScope = { kind: "global" };

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
    const scope: HarnessScope = { kind: "global" };

    await harness.writeSettings({ list: [1, 2, 3] }, scope);
    await harness.writeSettings({ list: [9] }, scope);

    const settings = (await harness.readSettings(scope)) as { list: number[] };
    expect(settings.list).toEqual([9]);
  });

  it("writeSettings persists to a project-scope settings file", async () => {
    const harness = makeHarness();
    const scope: HarnessScope = { kind: "project", projectDir };

    await harness.writeSettings({ theme: "light" }, scope);
    expect(existsSync(join(projectDir, ".pi", "settings.json"))).toBe(true);

    const settings = await harness.readSettings(scope);
    expect(settings).toEqual({ theme: "light" });
  });

  it("configureModels sets enabledModels without clobbering other settings", async () => {
    const harness = makeHarness();
    const scope: HarnessScope = { kind: "global" };

    await harness.writeSettings({ theme: "dark" }, scope);
    await harness.configureModels(["anthropic/*", "openai/gpt-*"], scope);

    const settings = (await harness.readSettings(scope)) as {
      theme: string;
      enabledModels: string[];
    };
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
    if (!base) throw new Error("pi provider missing");
    const spawnCap: ProviderSpawnCapability = {
      ...base.capabilities.spawn,
      spawnCommand: null,
    };
    const provider: Provider = {
      ...base,
      capabilities: {
        ...base.capabilities,
        spawn: spawnCap,
      },
    };
    const harness = new PiHarness(provider);
    await expect(
      harness.spawnSubagent({ targetProviderId: "claude-code", prompt: "hi" }),
    ).rejects.toThrow(/spawnCommand/);
  });

  it("throws when spawnCommand is an empty array", async () => {
    const base = getProvider("pi");
    if (!base) throw new Error("pi provider missing");
    const spawnCap: ProviderSpawnCapability = {
      ...base.capabilities.spawn,
      spawnCommand: [],
    };
    const provider: Provider = {
      ...base,
      capabilities: { ...base.capabilities, spawn: spawnCap },
    };
    const harness = new PiHarness(provider);
    await expect(
      harness.spawnSubagent({ targetProviderId: "claude-code", prompt: "hi" }),
    ).rejects.toThrow(/spawnCommand/);
  });

  it("throws when spawnCommand has an empty program", async () => {
    const base = getProvider("pi");
    if (!base) throw new Error("pi provider missing");
    const spawnCap: ProviderSpawnCapability = {
      ...base.capabilities.spawn,
      spawnCommand: ["", "--mode", "json"],
    };
    const provider: Provider = {
      ...base,
      capabilities: { ...base.capabilities, spawn: spawnCap },
    };
    const harness = new PiHarness(provider);
    await expect(
      harness.spawnSubagent({ targetProviderId: "claude-code", prompt: "hi" }),
    ).rejects.toThrow(/spawnCommand/);
  });

  it("reads spawnCommand from the provider and launches a child (using a safe stand-in)", async () => {
    // Replace the pi spawnCommand with a harmless `node -e ""` call so the
    // test does not depend on pi being installed on CI. We verify that the
    // harness produces a handle with a pid and an awaitable result.
    const base = getProvider("pi");
    if (!base) throw new Error("pi provider missing");
    const spawnCap: ProviderSpawnCapability = {
      ...base.capabilities.spawn,
      spawnCommand: [process.execPath, "-e", "process.stdout.write(process.argv[1] || '')"],
    };
    const provider: Provider = {
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

// ── Wave-1 — three-tier scope helper (ADR-035 §D1) ──────────────────

describe("three-tier scope helper", () => {
  it("TIER_PRECEDENCE orders project → user → global", () => {
    expect(TIER_PRECEDENCE).toEqual(["project", "user", "global"]);
  });

  it("resolveTierDir('project', 'extensions', projectDir) → <projectDir>/.pi/extensions", () => {
    const dir = resolveTierDir({
      tier: "project",
      kind: "extensions",
      projectDir,
    });
    expect(dir).toBe(join(projectDir, ".pi", "extensions"));
  });

  it("resolveTierDir('user', 'extensions') → <piRoot>/extensions (honours PI_CODING_AGENT_DIR)", () => {
    const dir = resolveTierDir({ tier: "user", kind: "extensions" });
    expect(dir).toBe(join(piRoot, "extensions"));
  });

  it("resolveTierDir('global', 'extensions') → <CLEO_HOME>/pi-extensions", () => {
    const dir = resolveTierDir({ tier: "global", kind: "extensions" });
    expect(dir).toBe(join(cleoHomeRoot, "pi-extensions"));
  });

  it("resolveTierDir('project') throws without projectDir", () => {
    expect(() => resolveTierDir({ tier: "project", kind: "extensions" })).toThrow(
      /projectDir/,
    );
    expect(() =>
      resolveTierDir({ tier: "project", kind: "extensions", projectDir: "" }),
    ).toThrow(/projectDir/);
  });

  it("resolveTierDir resolves prompts and themes to their own subpaths", () => {
    expect(resolveTierDir({ tier: "user", kind: "prompts" })).toBe(join(piRoot, "prompts"));
    expect(resolveTierDir({ tier: "user", kind: "themes" })).toBe(join(piRoot, "themes"));
    expect(resolveTierDir({ tier: "global", kind: "prompts" })).toBe(
      join(cleoHomeRoot, "pi-prompts"),
    );
    expect(resolveTierDir({ tier: "global", kind: "themes" })).toBe(
      join(cleoHomeRoot, "pi-themes"),
    );
  });

  it("resolveTierDir resolves sessions and cant kinds to the right buckets", () => {
    expect(resolveTierDir({ tier: "user", kind: "sessions" })).toBe(join(piRoot, "sessions"));
    expect(resolveTierDir({ tier: "user", kind: "cant" })).toBe(join(piRoot, "cant"));
    expect(resolveTierDir({ tier: "global", kind: "sessions" })).toBe(
      join(cleoHomeRoot, "pi-sessions"),
    );
    expect(resolveTierDir({ tier: "global", kind: "cant" })).toBe(
      join(cleoHomeRoot, "pi-cant"),
    );
    expect(resolveTierDir({ tier: "project", kind: "cant", projectDir })).toBe(
      join(projectDir, ".pi", "cant"),
    );
  });

  it("resolveAllTiers returns all three entries when projectDir is supplied", () => {
    const tiers = resolveAllTiers("extensions", projectDir);
    expect(tiers.map((t) => t.tier)).toEqual(["project", "user", "global"]);
    expect(tiers[0]?.dir).toBe(join(projectDir, ".pi", "extensions"));
    expect(tiers[1]?.dir).toBe(join(piRoot, "extensions"));
    expect(tiers[2]?.dir).toBe(join(cleoHomeRoot, "pi-extensions"));
  });

  it("resolveAllTiers skips the project tier when projectDir is omitted", () => {
    const tiers = resolveAllTiers("extensions");
    expect(tiers.map((t) => t.tier)).toEqual(["user", "global"]);
  });

  it("resolveTierDir honours $PI_CODING_AGENT_DIR expansion (~ and ~/subpath)", () => {
    // Test the home-relative resolution branches used by the scope
    // helper when users set PI_CODING_AGENT_DIR=~/custom.
    const original = process.env["PI_CODING_AGENT_DIR"];
    try {
      process.env["PI_CODING_AGENT_DIR"] = "~";
      const bare = resolveTierDir({ tier: "user", kind: "extensions" });
      expect(bare.endsWith("/extensions") || bare.endsWith("\\extensions")).toBe(true);

      process.env["PI_CODING_AGENT_DIR"] = "~/caamp-tier-test";
      const sub = resolveTierDir({ tier: "user", kind: "prompts" });
      expect(sub.includes("caamp-tier-test")).toBe(true);
      expect(sub.endsWith(join("caamp-tier-test", "prompts"))).toBe(true);
    } finally {
      if (original === undefined) {
        delete process.env["PI_CODING_AGENT_DIR"];
      } else {
        process.env["PI_CODING_AGENT_DIR"] = original;
      }
    }
  });

  it("resolveTierDir for user tier falls back to ~/.pi/agent when env is unset", () => {
    const original = process.env["PI_CODING_AGENT_DIR"];
    try {
      delete process.env["PI_CODING_AGENT_DIR"];
      const dir = resolveTierDir({ tier: "user", kind: "extensions" });
      expect(dir.endsWith(join(".pi", "agent", "extensions"))).toBe(true);
    } finally {
      if (original === undefined) {
        delete process.env["PI_CODING_AGENT_DIR"];
      } else {
        process.env["PI_CODING_AGENT_DIR"] = original;
      }
    }
  });

  it("resolveTierDir for global tier falls back to platform defaults when CLEO_HOME is unset", () => {
    const original = process.env["CLEO_HOME"];
    const originalXdg = process.env["XDG_DATA_HOME"];
    try {
      delete process.env["CLEO_HOME"];
      delete process.env["XDG_DATA_HOME"];
      const dir = resolveTierDir({ tier: "global", kind: "extensions" });
      // The fallback path is platform-specific; assert it ends with the
      // expected asset suffix so the test is portable.
      expect(dir.endsWith(join("pi-extensions"))).toBe(true);
      // And contains `cleo` somewhere in the path.
      expect(dir.includes("cleo")).toBe(true);
    } finally {
      if (original === undefined) {
        delete process.env["CLEO_HOME"];
      } else {
        process.env["CLEO_HOME"] = original;
      }
      if (originalXdg === undefined) {
        delete process.env["XDG_DATA_HOME"];
      } else {
        process.env["XDG_DATA_HOME"] = originalXdg;
      }
    }
  });

  it("resolveTierDir for global tier honours XDG_DATA_HOME on non-Windows/darwin", () => {
    // Skipped on Windows/darwin because the XDG branch is not reached
    // on those platforms by design.
    if (process.platform === "win32" || process.platform === "darwin") return;
    const original = process.env["CLEO_HOME"];
    const originalXdg = process.env["XDG_DATA_HOME"];
    try {
      delete process.env["CLEO_HOME"];
      process.env["XDG_DATA_HOME"] = "/tmp/caamp-xdg-test";
      const dir = resolveTierDir({ tier: "global", kind: "extensions" });
      expect(dir).toBe(join("/tmp/caamp-xdg-test", "cleo", "pi-extensions"));
    } finally {
      if (original === undefined) {
        delete process.env["CLEO_HOME"];
      } else {
        process.env["CLEO_HOME"] = original;
      }
      if (originalXdg === undefined) {
        delete process.env["XDG_DATA_HOME"];
      } else {
        process.env["XDG_DATA_HOME"] = originalXdg;
      }
    }
  });

  it("resolveTierDir for global tier treats whitespace-only CLEO_HOME as unset", () => {
    const original = process.env["CLEO_HOME"];
    try {
      process.env["CLEO_HOME"] = "   ";
      const dir = resolveTierDir({ tier: "global", kind: "extensions" });
      expect(dir.endsWith(join("pi-extensions"))).toBe(true);
      expect(dir).not.toContain("   ");
    } finally {
      if (original === undefined) {
        delete process.env["CLEO_HOME"];
      } else {
        process.env["CLEO_HOME"] = original;
      }
    }
  });

  it("resolveTierDir falls back to AppData when LOCALAPPDATA is unset on Windows", () => {
    // Stub process.platform through a property descriptor rewrite so
    // the scope helper's Windows branch is reachable on any host. We
    // restore the original descriptor in `finally` to keep downstream
    // tests isolated.
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    const originalCleoHome = process.env["CLEO_HOME"];
    const originalLocalAppData = process.env["LOCALAPPDATA"];
    try {
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });
      delete process.env["CLEO_HOME"];
      delete process.env["LOCALAPPDATA"];
      const dir = resolveTierDir({ tier: "global", kind: "extensions" });
      expect(dir.includes("AppData")).toBe(true);
      expect(dir.endsWith(join("cleo", "Data", "pi-extensions"))).toBe(true);

      // LOCALAPPDATA set branch.
      process.env["LOCALAPPDATA"] = "C:\\CustomAppData";
      const withLad = resolveTierDir({ tier: "global", kind: "extensions" });
      expect(withLad.startsWith("C:\\CustomAppData")).toBe(true);
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, "platform", originalPlatform);
      }
      if (originalCleoHome === undefined) {
        delete process.env["CLEO_HOME"];
      } else {
        process.env["CLEO_HOME"] = originalCleoHome;
      }
      if (originalLocalAppData === undefined) {
        delete process.env["LOCALAPPDATA"];
      } else {
        process.env["LOCALAPPDATA"] = originalLocalAppData;
      }
    }
  });

  it("resolveTierDir falls back to ~/Library/Application Support on darwin", () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    const originalCleoHome = process.env["CLEO_HOME"];
    try {
      Object.defineProperty(process, "platform", {
        value: "darwin",
        configurable: true,
      });
      delete process.env["CLEO_HOME"];
      const dir = resolveTierDir({ tier: "global", kind: "extensions" });
      expect(dir.includes(join("Library", "Application Support"))).toBe(true);
      expect(dir.endsWith("pi-extensions")).toBe(true);
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, "platform", originalPlatform);
      }
      if (originalCleoHome === undefined) {
        delete process.env["CLEO_HOME"];
      } else {
        process.env["CLEO_HOME"] = originalCleoHome;
      }
    }
  });
});

// ── Wave-1 — Extensions (ADR-035 §D1, T263) ─────────────────────────

describe("PiHarness extensions", () => {
  async function writeExtensionSource(name = "demo"): Promise<string> {
    const srcDir = join(uniqueRoot, `ext-src-${Math.random().toString(36).slice(2)}`);
    await mkdir(srcDir, { recursive: true });
    const srcPath = join(srcDir, `${name}.ts`);
    await writeFile(
      srcPath,
      `// Pi extension\nexport default function (_pi: unknown) { /* noop */ }\n`,
      "utf8",
    );
    return srcPath;
  }

  it("installExtension copies a .ts file into the project tier", async () => {
    const harness = makeHarness();
    const src = await writeExtensionSource();
    const result = await harness.installExtension(src, "demo", "project", projectDir);
    expect(result.tier).toBe("project");
    expect(result.targetPath).toBe(join(projectDir, ".pi", "extensions", "demo.ts"));
    expect(existsSync(result.targetPath)).toBe(true);
    const contents = await readFile(result.targetPath, "utf8");
    expect(contents).toContain("export default");
  });

  it("installExtension copies into the user tier (Pi-native global)", async () => {
    const harness = makeHarness();
    const src = await writeExtensionSource("uext");
    const result = await harness.installExtension(src, "uext", "user");
    expect(result.targetPath).toBe(join(piRoot, "extensions", "uext.ts"));
    expect(existsSync(result.targetPath)).toBe(true);
  });

  it("installExtension copies into the global tier (CleoOS hub)", async () => {
    const harness = makeHarness();
    const src = await writeExtensionSource("gext");
    const result = await harness.installExtension(src, "gext", "global");
    expect(result.targetPath).toBe(join(cleoHomeRoot, "pi-extensions", "gext.ts"));
    expect(existsSync(result.targetPath)).toBe(true);
  });

  it("installExtension errors by default on existing target", async () => {
    const harness = makeHarness();
    const src = await writeExtensionSource();
    await harness.installExtension(src, "demo", "user");
    await expect(harness.installExtension(src, "demo", "user")).rejects.toThrow(
      /already exists/,
    );
  });

  it("installExtension overwrites with { force: true }", async () => {
    const harness = makeHarness();
    const src = await writeExtensionSource();
    await harness.installExtension(src, "demo", "user");
    await expect(
      harness.installExtension(src, "demo", "user", undefined, { force: true }),
    ).resolves.toMatchObject({ tier: "user" });
  });

  it("installExtension rejects a non-existent source file", async () => {
    const harness = makeHarness();
    await expect(
      harness.installExtension(join(uniqueRoot, "missing.ts"), "demo", "user"),
    ).rejects.toThrow(/does not exist/);
  });

  it("installExtension rejects non-regular-file sources", async () => {
    const harness = makeHarness();
    const dir = join(uniqueRoot, "ext-dir");
    await mkdir(dir, { recursive: true });
    await expect(harness.installExtension(dir, "demo", "user")).rejects.toThrow(
      /not a regular file/,
    );
  });

  it("installExtension rejects non-TypeScript source files", async () => {
    const harness = makeHarness();
    const bad = join(uniqueRoot, "bad.js");
    await writeFile(bad, "export default function () {}\n", "utf8");
    await expect(harness.installExtension(bad, "bad", "user")).rejects.toThrow(
      /TypeScript/,
    );
  });

  it("installExtension rejects sources missing 'export default'", async () => {
    const harness = makeHarness();
    const bad = join(uniqueRoot, "bad.ts");
    await writeFile(bad, "// no default export here\n", "utf8");
    await expect(harness.installExtension(bad, "bad", "user")).rejects.toThrow(
      /export default/,
    );
  });

  it("removeExtension deletes an installed extension and returns true", async () => {
    const harness = makeHarness();
    const src = await writeExtensionSource();
    await harness.installExtension(src, "demo", "user");
    expect(await harness.removeExtension("demo", "user")).toBe(true);
    expect(existsSync(join(piRoot, "extensions", "demo.ts"))).toBe(false);
  });

  it("removeExtension returns false when the target does not exist", async () => {
    const harness = makeHarness();
    expect(await harness.removeExtension("nope", "user")).toBe(false);
  });

  it("listExtensions walks all three tiers and flags shadowed entries", async () => {
    const harness = makeHarness();
    const srcA = await writeExtensionSource("alpha");
    const srcB = await writeExtensionSource("beta");
    const srcC = await writeExtensionSource("gamma");

    // Project wins for `alpha` (also in user), user wins for `beta` (also in global).
    await harness.installExtension(srcA, "alpha", "project", projectDir);
    await harness.installExtension(srcA, "alpha", "user");
    await harness.installExtension(srcB, "beta", "user");
    await harness.installExtension(srcB, "beta", "global");
    await harness.installExtension(srcC, "gamma", "global");

    const listed = await harness.listExtensions(projectDir);
    const byName = new Map<string, typeof listed>();
    for (const entry of listed) {
      const existing = byName.get(entry.name) ?? [];
      existing.push(entry);
      byName.set(entry.name, existing);
    }

    // alpha: one project (non-shadowed) + one user (shadowed)
    const alphaEntries = byName.get("alpha") ?? [];
    expect(alphaEntries).toHaveLength(2);
    const alphaProject = alphaEntries.find((e) => e.tier === "project");
    const alphaUser = alphaEntries.find((e) => e.tier === "user");
    expect(alphaProject?.shadowed).toBe(false);
    expect(alphaUser?.shadowed).toBe(true);

    // beta: user (non-shadowed) + global (shadowed)
    const betaEntries = byName.get("beta") ?? [];
    expect(betaEntries).toHaveLength(2);
    expect(betaEntries.find((e) => e.tier === "user")?.shadowed).toBe(false);
    expect(betaEntries.find((e) => e.tier === "global")?.shadowed).toBe(true);

    // gamma: global only (non-shadowed)
    const gammaEntries = byName.get("gamma") ?? [];
    expect(gammaEntries).toHaveLength(1);
    expect(gammaEntries[0]?.shadowed).toBe(false);
  });

  it("listExtensions returns [] when no extension dirs exist", async () => {
    const harness = makeHarness();
    const listed = await harness.listExtensions(projectDir);
    expect(listed).toEqual([]);
  });

  it("listExtensions ignores non-.ts files inside the extensions dir", async () => {
    const harness = makeHarness();
    const src = await writeExtensionSource();
    await harness.installExtension(src, "keep", "user");
    await writeFile(join(piRoot, "extensions", "README.md"), "hi\n", "utf8");

    const listed = await harness.listExtensions();
    expect(listed.map((e) => e.name)).toEqual(["keep"]);
  });
});

// ── Wave-1 — Sessions (ADR-035 §D2, T264) ───────────────────────────

describe("PiHarness sessions", () => {
  async function seedSession(
    id: string,
    version = 3,
    extra: Record<string, unknown> = {},
    subdir?: string,
  ): Promise<string> {
    const baseDir = subdir !== undefined ? join(piRoot, "sessions", subdir) : join(piRoot, "sessions");
    await mkdir(baseDir, { recursive: true });
    const filePath = join(baseDir, `${id}.jsonl`);
    const header = JSON.stringify({
      type: "session",
      version,
      id,
      timestamp: "2026-04-07T00:00:00.000Z",
      cwd: "/home/alice/work",
      ...extra,
    });
    const body = [
      header,
      JSON.stringify({ type: "message", role: "user", content: "hello" }),
      JSON.stringify({ type: "message", role: "assistant", content: "world" }),
      "",
    ].join("\n");
    await writeFile(filePath, body, "utf8");
    return filePath;
  }

  it("listSessions reads only line 1 of each JSONL file and sorts by mtime desc", async () => {
    const harness = makeHarness();
    await seedSession("sess-a");
    // Force a slight mtime gap without relying on fs precision.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await seedSession("sess-b");

    const listed = await harness.listSessions();
    expect(listed).toHaveLength(2);
    expect(listed[0]?.id).toBe("sess-b");
    expect(listed[1]?.id).toBe("sess-a");
    expect(listed[0]?.version).toBe(3);
    expect(listed[0]?.cwd).toBe("/home/alice/work");
  });

  it("listSessions returns [] when the sessions dir is missing", async () => {
    const harness = makeHarness();
    expect(await harness.listSessions()).toEqual([]);
  });

  it("listSessions tolerates malformed headers by falling back to file stem", async () => {
    const harness = makeHarness();
    await mkdir(join(piRoot, "sessions"), { recursive: true });
    // Write a file whose first line has no id field.
    await writeFile(
      join(piRoot, "sessions", "orphan.jsonl"),
      `${JSON.stringify({ type: "session", version: 3 })}\n`,
      "utf8",
    );
    const listed = await harness.listSessions();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe("orphan");
  });

  it("listSessions tolerates an unparseable first line and drops the file", async () => {
    const harness = makeHarness();
    await mkdir(join(piRoot, "sessions"), { recursive: true });
    await writeFile(join(piRoot, "sessions", "bogus.jsonl"), "not json\n", "utf8");
    const listed = await harness.listSessions();
    expect(listed).toHaveLength(0);
  });

  it("listSessions includes the subagents/ subdir by default", async () => {
    const harness = makeHarness();
    await seedSession("sess-parent");
    await seedSession("sess-child", 3, { parentSession: "sess-parent" }, "subagents");
    const listed = await harness.listSessions();
    const ids = listed.map((s) => s.id).sort();
    expect(ids).toEqual(["sess-child", "sess-parent"]);
    expect(listed.find((s) => s.id === "sess-child")?.parentSession).toBe("sess-parent");
  });

  it("listSessions skips the subagents/ subdir when includeSubagents is false", async () => {
    const harness = makeHarness();
    await seedSession("sess-parent");
    await seedSession("sess-child", 3, { parentSession: "sess-parent" }, "subagents");
    const listed = await harness.listSessions({ includeSubagents: false });
    expect(listed.map((s) => s.id)).toEqual(["sess-parent"]);
  });

  it("showSession loads the full body and returns entries minus the header", async () => {
    const harness = makeHarness();
    await seedSession("sess-a");
    const doc = await harness.showSession("sess-a");
    expect(doc.summary.id).toBe("sess-a");
    expect(doc.entries).toHaveLength(2);
    expect(doc.entries[0]).toContain('"role":"user"');
    expect(doc.entries[1]).toContain('"role":"assistant"');
  });

  it("showSession throws with a clear error for unknown ids", async () => {
    const harness = makeHarness();
    await expect(harness.showSession("missing")).rejects.toThrow(/missing/);
  });
});

// ── Wave-1 — Models (ADR-035 §D3, T265) ─────────────────────────────

describe("PiHarness models", () => {
  const globalScope: HarnessScope = { kind: "global" };

  it("readModelsConfig returns empty providers when models.json is missing", async () => {
    const harness = makeHarness();
    const config = await harness.readModelsConfig(globalScope);
    expect(config).toEqual({ providers: {} });
  });

  it("readModelsConfig returns empty providers when models.json is malformed", async () => {
    const harness = makeHarness();
    await writeFile(join(piRoot, "models.json"), "not json", "utf8");
    expect(await harness.readModelsConfig(globalScope)).toEqual({ providers: {} });
  });

  it("readModelsConfig ignores non-object providers entries", async () => {
    const harness = makeHarness();
    await writeFile(
      join(piRoot, "models.json"),
      JSON.stringify({
        providers: {
          anthropic: { models: [{ id: "claude-opus", name: "Opus" }] },
          bogus: "not-an-object",
        },
      }),
      "utf8",
    );
    const config = await harness.readModelsConfig(globalScope);
    expect(Object.keys(config.providers)).toEqual(["anthropic"]);
  });

  it("writeModelsConfig persists atomically and round-trips", async () => {
    const harness = makeHarness();
    await harness.writeModelsConfig(
      {
        providers: {
          anthropic: {
            models: [{ id: "claude-opus-4", name: "Opus 4", reasoning: true }],
          },
        },
      },
      globalScope,
    );
    const raw = await readFile(join(piRoot, "models.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.providers.anthropic.models[0].id).toBe("claude-opus-4");
    expect(parsed.providers.anthropic.models[0].reasoning).toBe(true);

    // Round-trip through readModelsConfig.
    const roundtrip = await harness.readModelsConfig(globalScope);
    expect(roundtrip.providers["anthropic"]?.models?.[0]?.id).toBe("claude-opus-4");
  });

  it("listModels unions custom models with enabledModels and defaults", async () => {
    const harness = makeHarness();
    await harness.writeModelsConfig(
      {
        providers: {
          anthropic: {
            models: [
              { id: "claude-opus-4", name: "Opus 4" },
              { id: "claude-sonnet-4", name: "Sonnet 4" },
            ],
          },
        },
      },
      globalScope,
    );
    await harness.writeSettings(
      {
        enabledModels: ["anthropic:claude-opus-4", "openai:gpt-5"],
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet-4",
      },
      globalScope,
    );

    const listed = await harness.listModels(globalScope);
    const byKey = new Map(listed.map((e) => [`${e.provider}:${e.id}`, e]));

    const opus = byKey.get("anthropic:claude-opus-4");
    expect(opus).toBeDefined();
    expect(opus?.enabled).toBe(true);
    expect(opus?.isDefault).toBe(false);
    expect(opus?.custom).toBe(true);

    const sonnet = byKey.get("anthropic:claude-sonnet-4");
    expect(sonnet?.isDefault).toBe(true);
    expect(sonnet?.custom).toBe(true);

    const gpt = byKey.get("openai:gpt-5");
    expect(gpt).toBeDefined();
    expect(gpt?.custom).toBe(false);
    expect(gpt?.enabled).toBe(true);
  });

  it("listModels surfaces a defaultModel even when it is not in enabledModels or models.json", async () => {
    const harness = makeHarness();
    await harness.writeSettings(
      { defaultProvider: "anthropic", defaultModel: "claude-haiku-4" },
      globalScope,
    );
    const listed = await harness.listModels(globalScope);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.provider).toBe("anthropic");
    expect(listed[0]?.id).toBe("claude-haiku-4");
    expect(listed[0]?.isDefault).toBe(true);
    expect(listed[0]?.enabled).toBe(false);
    expect(listed[0]?.custom).toBe(false);
  });

  it("listModels treats provider/* globs as matching all ids in that provider", async () => {
    const harness = makeHarness();
    await harness.writeModelsConfig(
      {
        providers: {
          anthropic: { models: [{ id: "claude-opus-4", name: "Opus 4" }] },
        },
      },
      globalScope,
    );
    await harness.writeSettings({ enabledModels: ["anthropic/*"] }, globalScope);

    const listed = await harness.listModels(globalScope);
    const opus = listed.find((e) => e.id === "claude-opus-4");
    expect(opus?.enabled).toBe(true);
  });

  it("listModels skips glob-only enabledModels selections", async () => {
    const harness = makeHarness();
    await harness.writeSettings({ enabledModels: ["anthropic/*"] }, globalScope);
    const listed = await harness.listModels(globalScope);
    expect(listed).toEqual([]);
  });
});

// ── Wave-1 — Prompts (ADR-035 §D1, T266) ────────────────────────────

describe("PiHarness prompts", () => {
  async function writePromptSource(name = "demo-prompt"): Promise<string> {
    const srcDir = join(uniqueRoot, `prompt-src-${name}`);
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(srcDir, "prompt.md"), `# ${name}\n\nBody.\n`, "utf8");
    await writeFile(join(srcDir, "meta.json"), `{"version":"1"}\n`, "utf8");
    return srcDir;
  }

  it("installPrompt copies the full prompt directory into the tier", async () => {
    const harness = makeHarness();
    const src = await writePromptSource();
    const result = await harness.installPrompt(src, "demo-prompt", "user");
    expect(result.targetPath).toBe(join(piRoot, "prompts", "demo-prompt"));
    expect(existsSync(join(result.targetPath, "prompt.md"))).toBe(true);
    expect(existsSync(join(result.targetPath, "meta.json"))).toBe(true);
  });

  it("installPrompt rejects a source that is not a directory", async () => {
    const harness = makeHarness();
    const file = join(uniqueRoot, "not-a-dir.md");
    await writeFile(file, "hi", "utf8");
    await expect(harness.installPrompt(file, "x", "user")).rejects.toThrow(/not a directory/);
  });

  it("installPrompt rejects a source directory without prompt.md", async () => {
    const harness = makeHarness();
    const dir = join(uniqueRoot, "empty-prompt");
    await mkdir(dir, { recursive: true });
    await expect(harness.installPrompt(dir, "x", "user")).rejects.toThrow(/prompt\.md/);
  });

  it("installPrompt rejects a missing source directory", async () => {
    const harness = makeHarness();
    await expect(
      harness.installPrompt(join(uniqueRoot, "nope"), "x", "user"),
    ).rejects.toThrow(/does not exist/);
  });

  it("installPrompt errors on existing target unless --force is set", async () => {
    const harness = makeHarness();
    const src = await writePromptSource();
    await harness.installPrompt(src, "dup", "user");
    await expect(harness.installPrompt(src, "dup", "user")).rejects.toThrow(/already exists/);
    await expect(
      harness.installPrompt(src, "dup", "user", undefined, { force: true }),
    ).resolves.toMatchObject({ tier: "user" });
  });

  it("listPrompts walks tiers and surfaces shadow flags for name collisions", async () => {
    const harness = makeHarness();
    const src = await writePromptSource("dup");
    const src2 = await writePromptSource("only-global");
    await harness.installPrompt(src, "dup", "project", projectDir);
    await harness.installPrompt(src, "dup", "user");
    await harness.installPrompt(src2, "only-global", "global");

    const listed = await harness.listPrompts(projectDir);
    const dupEntries = listed.filter((e) => e.name === "dup");
    expect(dupEntries).toHaveLength(2);
    expect(dupEntries.find((e) => e.tier === "project")?.shadowed).toBe(false);
    expect(dupEntries.find((e) => e.tier === "user")?.shadowed).toBe(true);
    const only = listed.find((e) => e.name === "only-global");
    expect(only?.tier).toBe("global");
    expect(only?.shadowed).toBe(false);
  });

  it("listPrompts returns [] when no prompts exist in any tier", async () => {
    const harness = makeHarness();
    expect(await harness.listPrompts(projectDir)).toEqual([]);
  });

  it("listPrompts ignores regular files in the prompts dir", async () => {
    const harness = makeHarness();
    await mkdir(join(piRoot, "prompts"), { recursive: true });
    await writeFile(join(piRoot, "prompts", "README.md"), "readme", "utf8");
    expect(await harness.listPrompts(projectDir)).toEqual([]);
  });

  it("removePrompt deletes a prompt directory and returns true", async () => {
    const harness = makeHarness();
    const src = await writePromptSource();
    await harness.installPrompt(src, "demo-prompt", "user");
    expect(await harness.removePrompt("demo-prompt", "user")).toBe(true);
    expect(existsSync(join(piRoot, "prompts", "demo-prompt"))).toBe(false);
  });

  it("removePrompt returns false when the target is missing", async () => {
    const harness = makeHarness();
    expect(await harness.removePrompt("nope", "user")).toBe(false);
  });
});

// ── Wave-1 — Themes (ADR-035 §D1, T267) ─────────────────────────────

describe("PiHarness themes", () => {
  async function writeThemeTs(name = "neon"): Promise<string> {
    const srcPath = join(uniqueRoot, `${name}.ts`);
    await writeFile(
      srcPath,
      `export default { name: "${name}", vars: {}, colors: {} };\n`,
      "utf8",
    );
    return srcPath;
  }

  async function writeThemeJson(name = "neon-json"): Promise<string> {
    const srcPath = join(uniqueRoot, `${name}.json`);
    await writeFile(
      srcPath,
      JSON.stringify({ name, vars: {}, colors: {} }, null, 2),
      "utf8",
    );
    return srcPath;
  }

  it("installTheme copies a .ts theme into the user tier", async () => {
    const harness = makeHarness();
    const src = await writeThemeTs();
    const result = await harness.installTheme(src, "neon", "user");
    expect(result.targetPath).toBe(join(piRoot, "themes", "neon.ts"));
    expect(existsSync(result.targetPath)).toBe(true);
  });

  it("installTheme copies a .json theme into the user tier", async () => {
    const harness = makeHarness();
    const src = await writeThemeJson();
    const result = await harness.installTheme(src, "neon-json", "user");
    expect(result.targetPath).toBe(join(piRoot, "themes", "neon-json.json"));
    expect(existsSync(result.targetPath)).toBe(true);
  });

  it("installTheme rejects non-theme file extensions", async () => {
    const harness = makeHarness();
    const src = join(uniqueRoot, "bad.yaml");
    await writeFile(src, "name: bad\n", "utf8");
    await expect(harness.installTheme(src, "bad", "user")).rejects.toThrow(/expected a theme file/);
  });

  it("installTheme rejects a missing source", async () => {
    const harness = makeHarness();
    await expect(
      harness.installTheme(join(uniqueRoot, "nope.ts"), "x", "user"),
    ).rejects.toThrow(/does not exist/);
  });

  it("installTheme rejects a non-file source", async () => {
    const harness = makeHarness();
    const dir = join(uniqueRoot, "dir-theme");
    await mkdir(dir, { recursive: true });
    await expect(harness.installTheme(dir, "x", "user")).rejects.toThrow(/not a regular file/);
  });

  it("installTheme errors on existing target unless --force", async () => {
    const harness = makeHarness();
    const src = await writeThemeTs();
    await harness.installTheme(src, "neon", "user");
    await expect(harness.installTheme(src, "neon", "user")).rejects.toThrow(/already exists/);
    await expect(
      harness.installTheme(src, "neon", "user", undefined, { force: true }),
    ).resolves.toMatchObject({ tier: "user" });
  });

  it("installTheme blocks cross-extension collisions (.ts vs .json) without --force", async () => {
    const harness = makeHarness();
    const tsSrc = await writeThemeTs("collide");
    const jsonSrc = await writeThemeJson("collide");
    await harness.installTheme(tsSrc, "collide", "user");
    await expect(harness.installTheme(jsonSrc, "collide", "user")).rejects.toThrow(
      /conflicting theme/,
    );
    // With --force the conflicting .ts should be removed.
    await harness.installTheme(jsonSrc, "collide", "user", undefined, { force: true });
    expect(existsSync(join(piRoot, "themes", "collide.json"))).toBe(true);
    expect(existsSync(join(piRoot, "themes", "collide.ts"))).toBe(false);
  });

  it("listThemes walks tiers and reports fileExt per entry", async () => {
    const harness = makeHarness();
    const tsSrc = await writeThemeTs("alpha");
    const jsonSrc = await writeThemeJson("beta");
    await harness.installTheme(tsSrc, "alpha", "project", projectDir);
    await harness.installTheme(jsonSrc, "beta", "user");

    const listed = await harness.listThemes(projectDir);
    const alpha = listed.find((t) => t.name === "alpha");
    const beta = listed.find((t) => t.name === "beta");
    expect(alpha?.fileExt).toBe(".ts");
    expect(alpha?.tier).toBe("project");
    expect(beta?.fileExt).toBe(".json");
    expect(beta?.tier).toBe("user");
  });

  it("listThemes flags shadowed entries across tiers", async () => {
    const harness = makeHarness();
    const src = await writeThemeTs("dup");
    await harness.installTheme(src, "dup", "project", projectDir);
    await harness.installTheme(src, "dup", "user");
    const listed = await harness.listThemes(projectDir);
    const dupEntries = listed.filter((e) => e.name === "dup");
    expect(dupEntries.find((e) => e.tier === "project")?.shadowed).toBe(false);
    expect(dupEntries.find((e) => e.tier === "user")?.shadowed).toBe(true);
  });

  it("listThemes ignores unrecognised file extensions", async () => {
    const harness = makeHarness();
    await mkdir(join(piRoot, "themes"), { recursive: true });
    await writeFile(join(piRoot, "themes", "notes.md"), "# notes\n", "utf8");
    expect(await harness.listThemes(projectDir)).toEqual([]);
  });

  it("removeTheme deletes both .ts and .json variants and returns true when any existed", async () => {
    const harness = makeHarness();
    const src = await writeThemeTs("doomed");
    await harness.installTheme(src, "doomed", "user");
    expect(await harness.removeTheme("doomed", "user")).toBe(true);
    expect(existsSync(join(piRoot, "themes", "doomed.ts"))).toBe(false);
  });

  it("removeTheme returns false when the target is missing", async () => {
    const harness = makeHarness();
    expect(await harness.removeTheme("ghost", "user")).toBe(false);
  });
});

// ── ADR-035 §D6 — spawnSubagent upgrade (T277) ──────────────────────

/**
 * Helper: build a Pi provider whose spawnCommand executes a `node -e`
 * snippet so subagent tests do not depend on a real `pi` binary being
 * installed on the host. The snippet receives the task prompt as its
 * trailing positional argument (`process.argv[1]`) so each test can
 * shape its own mock subagent behaviour.
 */
function makeMockPiHarness(snippet: string): PiHarness {
  const base = getProvider("pi");
  if (!base) throw new Error("pi provider missing");
  const spawnCap: ProviderSpawnCapability = {
    ...base.capabilities.spawn,
    spawnCommand: [process.execPath, "-e", snippet],
  };
  const provider: Provider = {
    ...base,
    capabilities: { ...base.capabilities, spawn: spawnCap },
  };
  return new PiHarness(provider);
}

describe("PiHarness spawnSubagent — streaming", () => {
  it("forwards parsed JSON stdout lines as message events with line numbers", async () => {
    const snippet = [
      "process.stdout.write(JSON.stringify({type:'message',content:'one'})+'\\n');",
      "process.stdout.write(JSON.stringify({type:'message',content:'two'})+'\\n');",
      "process.stdout.write(JSON.stringify({type:'message_end'})+'\\n');",
    ].join("");
    const harness = makeMockPiHarness(snippet);

    const events: Array<{ kind: string; lineNumber?: number; payload: unknown }> = [];
    const handle = await harness.spawnSubagent(
      {
        targetProviderId: "claude-code",
        taskId: "stream-test",
        parentSessionId: "parent-1",
        prompt: "noop",
      },
      {
        onStream: (event) => {
          events.push({
            kind: event.kind,
            lineNumber: event.lineNumber,
            payload: event.payload,
          });
        },
      },
    );
    const exit = await handle.exitPromise;
    expect(exit.code).toBe(0);

    const messageEvents = events.filter((e) => e.kind === "message");
    expect(messageEvents).toHaveLength(3);
    expect(messageEvents[0]?.lineNumber).toBe(1);
    expect(messageEvents[1]?.lineNumber).toBe(2);
    expect(messageEvents[2]?.lineNumber).toBe(3);
    const firstPayload = messageEvents[0]?.payload as { content: string };
    expect(firstPayload.content).toBe("one");

    // Exit event also fires once.
    const exitEvents = events.filter((e) => e.kind === "exit");
    expect(exitEvents).toHaveLength(1);
  });

  it("non-JSON stdout lines do not crash the streamer and are not forwarded as messages", async () => {
    const snippet = [
      "process.stdout.write('not-json line\\n');",
      "process.stdout.write(JSON.stringify({type:'message',content:'real'})+'\\n');",
    ].join("");
    const harness = makeMockPiHarness(snippet);

    const messages: unknown[] = [];
    const handle = await harness.spawnSubagent(
      {
        targetProviderId: "claude-code",
        taskId: "non-json",
        parentSessionId: "parent-2",
        prompt: "noop",
      },
      {
        onStream: (event) => {
          if (event.kind === "message") messages.push(event.payload);
        },
      },
    );
    await handle.exitPromise;
    expect(messages).toHaveLength(1);
    const only = messages[0] as { content: string };
    expect(only.content).toBe("real");
  });
});

describe("PiHarness spawnSubagent — session attribution", () => {
  it("creates the child session JSONL at the canonical subagents/ path", async () => {
    const harness = makeMockPiHarness(
      "process.stdout.write(JSON.stringify({type:'message',content:'hi'})+'\\n');",
    );
    const handle = await harness.spawnSubagent({
      targetProviderId: "claude-code",
      taskId: "attrib-1",
      parentSessionId: "parent-attrib",
      prompt: "noop",
    });
    await handle.exitPromise;

    const expected = join(
      piRoot,
      "sessions",
      "subagents",
      "subagent-parent-attrib-attrib-1.jsonl",
    );
    expect(handle.childSessionPath).toBe(expected);
    expect(existsSync(expected)).toBe(true);
    const body = await readFile(expected, "utf8");
    const lines = body.split("\n").filter((l) => l.length > 0);
    // Header line + at least one custom_message + subagent_exit.
    expect(lines.length).toBeGreaterThanOrEqual(3);
    const header = JSON.parse(lines[0] ?? "{}");
    expect(header.type).toBe("session");
    expect(header.id).toBe(handle.subagentId);
    expect(header.taskId).toBe("attrib-1");
    expect(header.parentSession).toBe("parent-attrib");
  });

  it("appends a subagent_link entry to the parent session file when parentSessionPath is supplied", async () => {
    const harness = makeMockPiHarness(
      "process.stdout.write(JSON.stringify({type:'message',content:'hi'})+'\\n');",
    );

    // Seed a parent session file so the link append has something to grow.
    const parentDir = join(piRoot, "sessions");
    await mkdir(parentDir, { recursive: true });
    const parentPath = join(parentDir, "parent-link.jsonl");
    await writeFile(
      parentPath,
      `${JSON.stringify({ type: "session", version: 3, id: "parent-link", timestamp: "2026-04-07T00:00:00Z" })}\n`,
      "utf8",
    );

    const linkEvents: unknown[] = [];
    const handle = await harness.spawnSubagent(
      {
        targetProviderId: "claude-code",
        taskId: "link-1",
        parentSessionId: "parent-link",
        parentSessionPath: parentPath,
        prompt: "noop",
      },
      {
        onStream: (event) => {
          if (event.kind === "link") linkEvents.push(event.payload);
        },
      },
    );
    await handle.exitPromise;

    // Parent session file now contains the link record.
    const parentBody = await readFile(parentPath, "utf8");
    const lines = parentBody.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    const linkLine = JSON.parse(lines[1] ?? "{}");
    expect(linkLine.type).toBe("custom");
    expect(linkLine.subtype).toBe("subagent_link");
    expect(linkLine.subagentId).toBe(handle.subagentId);
    expect(linkLine.taskId).toBe("link-1");
    expect(linkLine.childSessionPath).toBe(handle.childSessionPath);

    // The link stream event also fired exactly once.
    expect(linkEvents).toHaveLength(1);
  });

  it("survives a missing parent session path without aborting the spawn", async () => {
    const harness = makeMockPiHarness(
      "process.stdout.write(JSON.stringify({type:'message',content:'hi'})+'\\n');",
    );
    // Pass a parentSessionPath whose parent directory cannot be created
    // (an existing file blocks `mkdir -p` from creating a child dir).
    const blockerFile = join(uniqueRoot, "blocker.txt");
    await writeFile(blockerFile, "hi", "utf8");
    const badParent = join(blockerFile, "child-session.jsonl");

    const handle = await harness.spawnSubagent({
      targetProviderId: "claude-code",
      taskId: "miss-1",
      parentSessionId: "p",
      parentSessionPath: badParent,
      prompt: "noop",
    });
    const exit = await handle.exitPromise;
    expect(exit.code).toBe(0);
    // Failure surfaced through recentStderr rather than throwing.
    const recent = handle.recentStderr();
    expect(recent.some((line) => line.includes("[link]"))).toBe(true);
  });
});

describe("PiHarness spawnSubagent — exit propagation", () => {
  it("non-zero exit resolves exitPromise (never rejects) with the captured code", async () => {
    const harness = makeMockPiHarness("process.exit(7);");
    const handle = await harness.spawnSubagent({
      targetProviderId: "claude-code",
      taskId: "exit-7",
      parentSessionId: "p",
      prompt: "noop",
    });
    // Use a try/catch to assert no rejection.
    let rejected = false;
    let exit: Awaited<typeof handle.exitPromise> | null = null;
    try {
      exit = await handle.exitPromise;
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(false);
    expect(exit?.code).toBe(7);
    expect(exit?.signal).toBeNull();
    expect(exit?.childSessionPath).toBe(handle.childSessionPath);
    expect(typeof exit?.durationMs).toBe("number");
  });

  it("legacy result promise still resolves with stdout/stderr/parsed for back-compat", async () => {
    const harness = makeMockPiHarness(
      "process.stdout.write(JSON.stringify({hello:'world'}));",
    );
    const handle = await harness.spawnSubagent({
      targetProviderId: "claude-code",
      taskId: "legacy",
      parentSessionId: "p",
      prompt: "noop",
    });
    const result = await handle.result;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello");
    const parsed = result.parsed as { hello: string };
    expect(parsed.hello).toBe("world");
  });
});

describe("PiHarness spawnSubagent — cleanup SIGTERM+SIGKILL", () => {
  it("terminate() escalates from SIGTERM to SIGKILL when grace expires", async () => {
    // The mock subagent installs a SIGTERM handler that ignores the
    // signal so the harness must escalate to SIGKILL to actually kill
    // the process. The script also writes a single JSON line so the
    // streamer gets exercised end-to-end.
    const snippet = [
      "process.on('SIGTERM',()=>{});",
      "process.stdout.write(JSON.stringify({type:'ready'})+'\\n');",
      "setInterval(()=>{},1000);",
    ].join("");
    const harness = makeMockPiHarness(snippet);

    const handle = await harness.spawnSubagent(
      {
        targetProviderId: "claude-code",
        taskId: "kill-1",
        parentSessionId: "p",
        prompt: "noop",
      },
      { terminateGraceMs: 50 },
    );

    // Give the child a moment to install the SIGTERM handler.
    await new Promise((resolve) => setTimeout(resolve, 30));
    await handle.terminate();
    const exit = await handle.exitPromise;
    // SIGKILL exit on POSIX surfaces as signal 'SIGKILL' (or null code).
    expect(exit.signal === "SIGKILL" || exit.code !== 0).toBe(true);
  });

  it("terminate() is idempotent — calling twice returns the same resolved promise", async () => {
    const snippet = [
      "process.on('SIGTERM',()=>{});",
      "setInterval(()=>{},1000);",
    ].join("");
    const harness = makeMockPiHarness(snippet);
    const handle = await harness.spawnSubagent(
      {
        targetProviderId: "claude-code",
        taskId: "kill-2",
        parentSessionId: "p",
        prompt: "noop",
      },
      { terminateGraceMs: 30 },
    );
    const first = handle.terminate();
    const second = handle.terminate();
    expect(first).toBe(second);
    await first;
    await handle.exitPromise;
  });

  it("legacy abort() reuses the cleanup sequence", async () => {
    const snippet = [
      "process.on('SIGTERM',()=>{});",
      "setInterval(()=>{},1000);",
    ].join("");
    const harness = makeMockPiHarness(snippet);
    const handle = await harness.spawnSubagent(
      {
        targetProviderId: "claude-code",
        taskId: "kill-3",
        parentSessionId: "p",
        prompt: "noop",
      },
      { terminateGraceMs: 30 },
    );
    handle.abort();
    const exit = await handle.exitPromise;
    expect(exit.signal !== null || exit.code !== 0).toBe(true);
  });

  it("reads grace window from settings.json when not overridden per call", async () => {
    const snippet = [
      "process.on('SIGTERM',()=>{});",
      "setInterval(()=>{},1000);",
    ].join("");
    const harness = makeMockPiHarness(snippet);
    // Set a tiny grace window via settings so the test still terminates quickly.
    await harness.writeSettings(
      { pi: { subagent: { terminateGraceMs: 25 } } },
      { kind: "global" },
    );

    const handle = await harness.spawnSubagent({
      targetProviderId: "claude-code",
      taskId: "settings-grace",
      parentSessionId: "p",
      prompt: "noop",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await handle.terminate();
    const exit = await handle.exitPromise;
    expect(exit.signal !== null || exit.code !== 0).toBe(true);
  });
});

describe("PiHarness spawnSubagent — stderr buffering", () => {
  it("captures stderr lines into recentStderr without injecting them as message events", async () => {
    const snippet = [
      "process.stderr.write('warn line one\\n');",
      "process.stderr.write('warn line two\\n');",
      "process.stdout.write(JSON.stringify({type:'message',content:'real'})+'\\n');",
    ].join("");
    const harness = makeMockPiHarness(snippet);

    const events: Array<{ kind: string; payload: unknown }> = [];
    const handle = await harness.spawnSubagent(
      {
        targetProviderId: "claude-code",
        taskId: "stderr-1",
        parentSessionId: "p",
        prompt: "noop",
      },
      {
        onStream: (event) => {
          events.push({ kind: event.kind, payload: event.payload });
        },
      },
    );
    await handle.exitPromise;

    const stderrLines = handle.recentStderr();
    expect(stderrLines).toContain("warn line one");
    expect(stderrLines).toContain("warn line two");

    // stderr fired as 'stderr' events, not 'message' events.
    const stderrEvents = events.filter((e) => e.kind === "stderr");
    expect(stderrEvents).toHaveLength(2);
    const messageEvents = events.filter((e) => e.kind === "message");
    expect(messageEvents).toHaveLength(1);
  });

  it("recentStderr is bounded to the last 100 lines", async () => {
    // Emit 120 stderr lines so the ring buffer must drop the oldest 20.
    const snippet = [
      "for(let i=0;i<120;i++){process.stderr.write('line-'+i+'\\n');}",
    ].join("");
    const harness = makeMockPiHarness(snippet);

    const handle = await harness.spawnSubagent({
      targetProviderId: "claude-code",
      taskId: "stderr-ring",
      parentSessionId: "p",
      prompt: "noop",
    });
    await handle.exitPromise;
    const recent = handle.recentStderr();
    expect(recent).toHaveLength(100);
    expect(recent[0]).toBe("line-20");
    expect(recent[recent.length - 1]).toBe("line-119");
  });
});

describe("PiHarness concurrency helpers", () => {
  it("raceSubagents resolves with the fastest exit and terminates losers", async () => {
    // Three children with staggered exit delays. The fastest exits in
    // 30ms; the slower ones would idle for 1s if not cleaned up.
    const fast = makeMockPiHarness("setTimeout(()=>process.exit(0),30);");
    const slowA = makeMockPiHarness(
      "process.on('SIGTERM',()=>process.exit(143));setTimeout(()=>{},1000);",
    );
    const slowB = makeMockPiHarness(
      "process.on('SIGTERM',()=>process.exit(143));setTimeout(()=>{},1000);",
    );

    const fastHandle = await fast.spawnSubagent({
      targetProviderId: "claude-code",
      taskId: "fast",
      parentSessionId: "p",
      prompt: "noop",
    });
    const slowHandleA = await slowA.spawnSubagent(
      {
        targetProviderId: "claude-code",
        taskId: "slowA",
        parentSessionId: "p",
        prompt: "noop",
      },
      { terminateGraceMs: 50 },
    );
    const slowHandleB = await slowB.spawnSubagent(
      {
        targetProviderId: "claude-code",
        taskId: "slowB",
        parentSessionId: "p",
        prompt: "noop",
      },
      { terminateGraceMs: 50 },
    );

    const winner = await PiHarness.raceSubagents([slowHandleA, fastHandle, slowHandleB]);
    expect(winner.code).toBe(0);

    // Losers must have been terminated.
    const losers = await Promise.all([slowHandleA.exitPromise, slowHandleB.exitPromise]);
    for (const loser of losers) {
      expect(loser.code !== 0 || loser.signal !== null).toBe(true);
    }
  });

  it("raceSubagents throws on an empty handle list", async () => {
    await expect(PiHarness.raceSubagents([])).rejects.toThrow(/empty/);
  });

  it("settleAllSubagents resolves with one entry per handle", async () => {
    const a = makeMockPiHarness("process.exit(0);");
    const b = makeMockPiHarness("process.exit(2);");

    const ha = await a.spawnSubagent({
      targetProviderId: "claude-code",
      taskId: "settle-a",
      parentSessionId: "p",
      prompt: "noop",
    });
    const hb = await b.spawnSubagent({
      targetProviderId: "claude-code",
      taskId: "settle-b",
      parentSessionId: "p",
      prompt: "noop",
    });

    const settled = await PiHarness.settleAllSubagents([ha, hb]);
    expect(settled).toHaveLength(2);
    expect(settled[0]?.status).toBe("fulfilled");
    expect(settled[1]?.status).toBe("fulfilled");
    if (settled[0]?.status === "fulfilled") expect(settled[0].value.code).toBe(0);
    if (settled[1]?.status === "fulfilled") expect(settled[1].value.code).toBe(2);
  });
});
