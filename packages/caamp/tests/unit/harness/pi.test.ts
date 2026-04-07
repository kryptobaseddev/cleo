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

// ── CANT profile methods (T276) ───────────────────────────────────────

describe("PiHarness cant profile methods", () => {
  /**
   * Resolve the seed-agent fixtures directory using import.meta.url so
   * the path stays valid regardless of vitest's working directory.
   */
  function seedAgentsDir(): string {
    const here = new URL(".", import.meta.url).pathname;
    // tests/unit/harness → ../../../.. = repo root packages/caamp/
    // then → ../agents/seed-agents
    return join(here, "..", "..", "..", "..", "agents", "seed-agents");
  }

  /** Path to the canonical valid seed-agent fixture. */
  function validSeedAgent(): string {
    return join(seedAgentsDir(), "cleo-dev.cant");
  }

  /** Path to a second seed-agent fixture used for cross-tier tests. */
  function secondSeedAgent(): string {
    return join(seedAgentsDir(), "cleo-historian.cant");
  }

  /**
   * Write an intentionally broken `.cant` file under the test tmpdir
   * and return its path. Used to drive the validation-failure paths.
   */
  async function writeBrokenCant(name = "broken"): Promise<string> {
    const file = join(uniqueRoot, `${name}.cant`);
    await writeFile(file, "this is not valid cant\n: missing colons\n", "utf8");
    return file;
  }

  describe("validateCantProfile", () => {
    it("returns valid=true with non-zero counts for a known-good seed-agent", async () => {
      const harness = makeHarness();
      const result = await harness.validateCantProfile(validSeedAgent());
      expect(result.valid).toBe(true);
      expect(result.errors.filter((e) => e.severity === "error")).toEqual([]);
      expect(result.counts.agentCount).toBe(1);
      expect(result.counts.hookCount).toBeGreaterThan(0);
    });

    it("returns valid=false with diagnostics for a broken file", async () => {
      const harness = makeHarness();
      const broken = await writeBrokenCant();
      const result = await harness.validateCantProfile(broken);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      // cant-core surfaces parse failures with ruleId === "PARSE".
      expect(result.errors[0]?.ruleId).toBe("PARSE");
      expect(result.errors[0]?.severity).toBe("error");
    });

    it("throws when the source file does not exist", async () => {
      const harness = makeHarness();
      await expect(harness.validateCantProfile(join(uniqueRoot, "nope.cant"))).rejects.toThrow(
        /does not exist/,
      );
    });

    it("throws when the source path is a directory", async () => {
      const harness = makeHarness();
      const dir = join(uniqueRoot, "dir.cant");
      await mkdir(dir, { recursive: true });
      await expect(harness.validateCantProfile(dir)).rejects.toThrow(/not a regular file/);
    });

    it("normalises severity strings to the typed union", async () => {
      const harness = makeHarness();
      const broken = await writeBrokenCant();
      const result = await harness.validateCantProfile(broken);
      for (const diag of result.errors) {
        expect(["error", "warning", "info", "hint"]).toContain(diag.severity);
      }
    });
  });

  describe("installCantProfile", () => {
    it("copies a valid seed-agent into the user tier with parsed counts", async () => {
      const harness = makeHarness();
      const result = await harness.installCantProfile(validSeedAgent(), "cleo-dev", "user");
      expect(result.tier).toBe("user");
      expect(result.targetPath).toBe(join(piRoot, "cant", "cleo-dev.cant"));
      expect(existsSync(result.targetPath)).toBe(true);
      expect(result.counts.agentCount).toBe(1);
      expect(result.counts.hookCount).toBeGreaterThan(0);
      // Roundtrip: the installed file body must equal the source body.
      const written = await readFile(result.targetPath, "utf8");
      const original = await readFile(validSeedAgent(), "utf8");
      expect(written).toBe(original);
    });

    it("copies a valid seed-agent into the project tier", async () => {
      const harness = makeHarness();
      const result = await harness.installCantProfile(
        validSeedAgent(),
        "cleo-dev",
        "project",
        projectDir,
      );
      expect(result.tier).toBe("project");
      expect(result.targetPath).toBe(join(projectDir, ".pi", "cant", "cleo-dev.cant"));
      expect(existsSync(result.targetPath)).toBe(true);
    });

    it("copies a valid seed-agent into the global (CleoOS hub) tier", async () => {
      const harness = makeHarness();
      const result = await harness.installCantProfile(validSeedAgent(), "cleo-dev", "global");
      expect(result.tier).toBe("global");
      expect(result.targetPath).toBe(join(cleoHomeRoot, "pi-cant", "cleo-dev.cant"));
      expect(existsSync(result.targetPath)).toBe(true);
    });

    it("rejects an invalid .cant file before copying", async () => {
      const harness = makeHarness();
      const broken = await writeBrokenCant();
      await expect(harness.installCantProfile(broken, "broken", "user")).rejects.toThrow(
        /failed cant-core validation/,
      );
      expect(existsSync(join(piRoot, "cant", "broken.cant"))).toBe(false);
    });

    it("rejects a non-.cant source extension", async () => {
      const harness = makeHarness();
      const wrongExt = join(uniqueRoot, "wrong.txt");
      await writeFile(wrongExt, "agent foo:\n", "utf8");
      await expect(harness.installCantProfile(wrongExt, "wrong", "user")).rejects.toThrow(
        /expected a CANT source file/,
      );
    });

    it("errors on existing target unless force=true", async () => {
      const harness = makeHarness();
      await harness.installCantProfile(validSeedAgent(), "cleo-dev", "user");
      await expect(
        harness.installCantProfile(validSeedAgent(), "cleo-dev", "user"),
      ).rejects.toThrow(/already exists/);
      // With --force the install must succeed.
      const result = await harness.installCantProfile(
        validSeedAgent(),
        "cleo-dev",
        "user",
        undefined,
        { force: true },
      );
      expect(result.tier).toBe("user");
    });

    it("rejects a missing source path", async () => {
      const harness = makeHarness();
      await expect(
        harness.installCantProfile(join(uniqueRoot, "ghost.cant"), "ghost", "user"),
      ).rejects.toThrow(/does not exist/);
    });

    it("rejects a directory source path", async () => {
      const harness = makeHarness();
      const dir = join(uniqueRoot, "dir.cant");
      await mkdir(dir, { recursive: true });
      await expect(harness.installCantProfile(dir, "dir", "user")).rejects.toThrow(
        /not a regular file/,
      );
    });
  });

  describe("removeCantProfile", () => {
    it("returns true and deletes the file when present", async () => {
      const harness = makeHarness();
      await harness.installCantProfile(validSeedAgent(), "cleo-dev", "user");
      const removed = await harness.removeCantProfile("cleo-dev", "user");
      expect(removed).toBe(true);
      expect(existsSync(join(piRoot, "cant", "cleo-dev.cant"))).toBe(false);
    });

    it("returns false (idempotent) when the target is missing", async () => {
      const harness = makeHarness();
      expect(await harness.removeCantProfile("ghost", "user")).toBe(false);
    });

    it("removes from the project tier without affecting other tiers", async () => {
      const harness = makeHarness();
      await harness.installCantProfile(validSeedAgent(), "cleo-dev", "user");
      await harness.installCantProfile(validSeedAgent(), "cleo-dev", "project", projectDir);
      const removed = await harness.removeCantProfile("cleo-dev", "project", projectDir);
      expect(removed).toBe(true);
      expect(existsSync(join(projectDir, ".pi", "cant", "cleo-dev.cant"))).toBe(false);
      // The user-tier copy must survive.
      expect(existsSync(join(piRoot, "cant", "cleo-dev.cant"))).toBe(true);
    });
  });

  describe("listCantProfiles", () => {
    it("returns an empty array when nothing is installed", async () => {
      const harness = makeHarness();
      const entries = await harness.listCantProfiles(projectDir);
      expect(entries).toEqual([]);
    });

    it("walks all three tiers in precedence order", async () => {
      const harness = makeHarness();
      await harness.installCantProfile(validSeedAgent(), "in-project", "project", projectDir);
      await harness.installCantProfile(validSeedAgent(), "in-user", "user");
      await harness.installCantProfile(validSeedAgent(), "in-global", "global");
      const entries = await harness.listCantProfiles(projectDir);
      const tiers = entries.map((e) => e.tier);
      // Project entries must precede user entries, which must precede global.
      expect(tiers.indexOf("project")).toBeLessThan(tiers.indexOf("user"));
      expect(tiers.indexOf("user")).toBeLessThan(tiers.indexOf("global"));
      expect(entries.find((e) => e.name === "in-project")?.tier).toBe("project");
      expect(entries.find((e) => e.name === "in-user")?.tier).toBe("user");
      expect(entries.find((e) => e.name === "in-global")?.tier).toBe("global");
    });

    it("flags shadowed entries when the same name appears at multiple tiers", async () => {
      const harness = makeHarness();
      await harness.installCantProfile(validSeedAgent(), "shared", "project", projectDir);
      await harness.installCantProfile(validSeedAgent(), "shared", "user");
      await harness.installCantProfile(validSeedAgent(), "shared", "global");
      const entries = await harness.listCantProfiles(projectDir);
      const shared = entries.filter((e) => e.name === "shared");
      expect(shared).toHaveLength(3);
      // Project tier wins; user/global are shadowed.
      expect(shared.find((e) => e.tier === "project")?.shadowedByHigherTier).toBeUndefined();
      expect(shared.find((e) => e.tier === "user")?.shadowedByHigherTier).toBe(true);
      expect(shared.find((e) => e.tier === "global")?.shadowedByHigherTier).toBe(true);
    });

    it("populates per-entry counts from cant-core parsing", async () => {
      const harness = makeHarness();
      await harness.installCantProfile(validSeedAgent(), "cleo-dev", "user");
      await harness.installCantProfile(secondSeedAgent(), "cleo-historian", "user");
      const entries = await harness.listCantProfiles(projectDir);
      const dev = entries.find((e) => e.name === "cleo-dev");
      const historian = entries.find((e) => e.name === "cleo-historian");
      expect(dev?.counts.agentCount).toBe(1);
      expect(dev?.counts.hookCount).toBeGreaterThan(0);
      expect(historian?.counts.agentCount).toBeGreaterThanOrEqual(1);
    });

    it("ignores files without a .cant extension", async () => {
      const harness = makeHarness();
      const dir = join(piRoot, "cant");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "notes.md"), "# notes\n", "utf8");
      const entries = await harness.listCantProfiles(projectDir);
      expect(entries).toEqual([]);
    });

    it("skips the project tier when projectDir is undefined", async () => {
      const harness = makeHarness();
      await harness.installCantProfile(validSeedAgent(), "in-user", "user");
      const entries = await harness.listCantProfiles();
      // Only the user-tier entry should be visible.
      expect(entries.every((e) => e.tier !== "project")).toBe(true);
      expect(entries.find((e) => e.name === "in-user")).toBeDefined();
    });
  });

  describe("counts extraction", () => {
    it("extracts a positive skillCount when an agent declares skills", async () => {
      const harness = makeHarness();
      // cleo-dev.cant declares skills: ["ct-cleo", "ct-task-executor", ...]
      const result = await harness.validateCantProfile(validSeedAgent());
      expect(result.counts.skillCount).toBeGreaterThanOrEqual(1);
    });

    it("returns zero counts for a parse-failed file", async () => {
      const harness = makeHarness();
      const broken = await writeBrokenCant("zero-counts");
      const result = await harness.validateCantProfile(broken);
      expect(result.counts.agentCount).toBe(0);
      expect(result.counts.workflowCount).toBe(0);
      expect(result.counts.pipelineCount).toBe(0);
      expect(result.counts.hookCount).toBe(0);
      expect(result.counts.skillCount).toBe(0);
    });
  });
});
