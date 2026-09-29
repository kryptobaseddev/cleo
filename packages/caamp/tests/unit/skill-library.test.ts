import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildLibraryFromFiles, catalogEntryFromManifest } from "../../src/core/skills/library-loader.js";
import type { SkillLibrary } from "../../src/core/skills/skill-library.js";

describe("SkillLibrary via buildLibraryFromFiles", () => {
  let fixtureRoot: string;
  let library: SkillLibrary;

  beforeEach(() => {
    // Create a fixture skill library on disk
    fixtureRoot = join(tmpdir(), `caamp-test-lib-${Date.now()}`);
    mkdirSync(fixtureRoot, { recursive: true });

    // skills.json catalog
    writeFileSync(
      join(fixtureRoot, "skills.json"),
      JSON.stringify({
        version: "1.0.0",
        skills: [
          {
            name: "test-skill",
            description: "A test skill",
            version: "1.0.0",
            path: "skills/test-skill/SKILL.md",
            references: [],
            core: true,
            category: "core",
            tier: 0,
            protocol: null,
            dependencies: [],
            sharedResources: [],
            compatibility: ["claude-code"],
            license: "MIT",
            metadata: {},
          },
          {
            name: "dep-skill",
            description: "A skill with dependencies",
            version: "1.0.0",
            path: "skills/dep-skill/SKILL.md",
            references: [],
            core: false,
            category: "recommended",
            tier: 1,
            protocol: "research",
            dependencies: ["test-skill"],
            sharedResources: ["helper"],
            compatibility: ["claude-code"],
            license: "MIT",
            metadata: {},
          },
        ],
      }),
    );

    // Create skill directories
    mkdirSync(join(fixtureRoot, "skills", "test-skill"), { recursive: true });
    writeFileSync(
      join(fixtureRoot, "skills", "test-skill", "SKILL.md"),
      "# Test Skill\nThis is a test skill.",
    );

    mkdirSync(join(fixtureRoot, "skills", "dep-skill"), { recursive: true });
    writeFileSync(
      join(fixtureRoot, "skills", "dep-skill", "SKILL.md"),
      "# Dep Skill\nThis skill depends on test-skill.",
    );

    // Manifest
    mkdirSync(join(fixtureRoot, "skills"), { recursive: true });
    writeFileSync(
      join(fixtureRoot, "skills", "manifest.json"),
      JSON.stringify({
        $schema: "",
        _meta: {},
        dispatch_matrix: {
          by_task_type: { implementation: "test-skill" },
          by_keyword: { research: "dep-skill" },
          by_protocol: { research: "dep-skill" },
        },
        skills: [],
      }),
    );

    // Shared resources
    mkdirSync(join(fixtureRoot, "skills", "_shared"), { recursive: true });
    writeFileSync(
      join(fixtureRoot, "skills", "_shared", "helper.md"),
      "# Helper\nShared resource content.",
    );

    // Protocols
    mkdirSync(join(fixtureRoot, "skills", "protocols"), { recursive: true });
    writeFileSync(
      join(fixtureRoot, "skills", "protocols", "research.md"),
      "# Research Protocol\nProtocol content.",
    );

    // Profiles
    mkdirSync(join(fixtureRoot, "profiles"), { recursive: true });
    writeFileSync(
      join(fixtureRoot, "profiles", "minimal.json"),
      JSON.stringify({
        name: "minimal",
        description: "Minimal profile",
        skills: ["test-skill"],
        includeProtocols: [],
      }),
    );
    writeFileSync(
      join(fixtureRoot, "profiles", "full.json"),
      JSON.stringify({
        name: "full",
        description: "Full profile",
        extends: "minimal",
        skills: ["dep-skill"],
        includeProtocols: ["research"],
      }),
    );

    library = buildLibraryFromFiles(fixtureRoot);
  });

  afterEach(() => {
    if (existsSync(fixtureRoot)) {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  // ── Properties ──────────────────────────────────────────────────

  it("has correct version", () => {
    expect(library.version).toBe("1.0.0");
  });

  it("has correct libraryRoot", () => {
    expect(library.libraryRoot).toBe(fixtureRoot);
  });

  it("has skills array", () => {
    expect(library.skills).toHaveLength(2);
  });

  it("has manifest with dispatch_matrix", () => {
    expect(library.manifest).toBeDefined();
    expect(library.manifest.dispatch_matrix).toBeDefined();
  });

  // ── Skill lookup ────────────────────────────────────────────────

  it("listSkills returns skill names", () => {
    const names = library.listSkills();
    expect(names).toContain("test-skill");
    expect(names).toContain("dep-skill");
  });

  it("getSkill returns entry for existing skill", () => {
    const skill = library.getSkill("test-skill");
    expect(skill).toBeDefined();
    expect(skill!.name).toBe("test-skill");
    expect(skill!.core).toBe(true);
  });

  it("getSkill returns undefined for nonexistent skill", () => {
    expect(library.getSkill("nonexistent")).toBeUndefined();
  });

  it("getSkillPath returns path ending in SKILL.md", () => {
    const path = library.getSkillPath("test-skill");
    expect(path).toMatch(/SKILL\.md$/);
    expect(existsSync(path)).toBe(true);
  });

  it("getSkillDir returns the skill directory", () => {
    const dir = library.getSkillDir("test-skill");
    expect(dir).toContain("test-skill");
    expect(existsSync(dir)).toBe(true);
  });

  it("readSkillContent returns SKILL.md content", () => {
    const content = library.readSkillContent("test-skill");
    expect(content).toContain("# Test Skill");
  });

  // ── Category & dependency ───────────────────────────────────────

  it("getCoreSkills returns only core skills", () => {
    const core = library.getCoreSkills();
    expect(core).toHaveLength(1);
    expect(core[0]!.name).toBe("test-skill");
  });

  it("getSkillsByCategory filters correctly", () => {
    const recommended = library.getSkillsByCategory("recommended");
    expect(recommended).toHaveLength(1);
    expect(recommended[0]!.name).toBe("dep-skill");
  });

  it("getSkillDependencies returns direct deps", () => {
    const deps = library.getSkillDependencies("dep-skill");
    expect(deps).toEqual(["test-skill"]);
  });

  it("getSkillDependencies returns empty for no deps", () => {
    const deps = library.getSkillDependencies("test-skill");
    expect(deps).toEqual([]);
  });

  it("resolveDependencyTree includes transitive deps", () => {
    const resolved = library.resolveDependencyTree(["dep-skill"]);
    expect(resolved).toContain("test-skill");
    expect(resolved).toContain("dep-skill");
    // test-skill should come before dep-skill (dependency first)
    expect(resolved.indexOf("test-skill")).toBeLessThan(resolved.indexOf("dep-skill"));
  });

  // ── Profiles ────────────────────────────────────────────────────

  it("listProfiles returns profile names", () => {
    const profiles = library.listProfiles();
    expect(profiles).toContain("minimal");
    expect(profiles).toContain("full");
  });

  it("getProfile returns profile definition", () => {
    const profile = library.getProfile("minimal");
    expect(profile).toBeDefined();
    expect(profile!.name).toBe("minimal");
    expect(profile!.skills).toContain("test-skill");
  });

  it("getProfile returns undefined for nonexistent", () => {
    expect(library.getProfile("nonexistent")).toBeUndefined();
  });

  it("resolveProfile resolves with extends", () => {
    const skills = library.resolveProfile("full");
    expect(skills).toContain("test-skill");
    expect(skills).toContain("dep-skill");
  });

  // ── Shared resources ────────────────────────────────────────────

  it("listSharedResources returns resource names", () => {
    const resources = library.listSharedResources();
    expect(resources).toContain("helper");
  });

  it("getSharedResourcePath returns path for existing resource", () => {
    const path = library.getSharedResourcePath("helper");
    expect(path).toBeDefined();
    expect(existsSync(path!)).toBe(true);
  });

  it("getSharedResourcePath returns undefined for nonexistent", () => {
    expect(library.getSharedResourcePath("nonexistent")).toBeUndefined();
  });

  it("readSharedResource returns content", () => {
    const content = library.readSharedResource("helper");
    expect(content).toContain("# Helper");
  });

  // ── Protocols ───────────────────────────────────────────────────

  it("listProtocols returns protocol names", () => {
    const protocols = library.listProtocols();
    expect(protocols).toContain("research");
  });

  it("getProtocolPath returns path for existing protocol", () => {
    const path = library.getProtocolPath("research");
    expect(path).toBeDefined();
    expect(existsSync(path!)).toBe(true);
  });

  it("readProtocol returns content", () => {
    const content = library.readProtocol("research");
    expect(content).toContain("# Research Protocol");
  });

  // ── Validation ──────────────────────────────────────────────────

  it("validateSkillFrontmatter returns valid for good skill", () => {
    const result = library.validateSkillFrontmatter("test-skill");
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("validateSkillFrontmatter returns invalid for nonexistent skill", () => {
    const result = library.validateSkillFrontmatter("nonexistent");
    expect(result.valid).toBe(false);
  });

  it("validateAll returns map for all skills", () => {
    const results = library.validateAll();
    expect(results.size).toBe(2);
    expect(results.has("test-skill")).toBe(true);
    expect(results.has("dep-skill")).toBe(true);
  });

  // ── Dispatch ────────────────────────────────────────────────────

  it("getDispatchMatrix returns the matrix", () => {
    const matrix = library.getDispatchMatrix();
    expect(matrix.by_task_type).toHaveProperty("implementation", "test-skill");
    expect(matrix.by_keyword).toHaveProperty("research", "dep-skill");
  });
});

describe("SkillLibrary protocol path discovery", () => {
  let fixtureRoot: string;

  afterEach(() => {
    if (existsSync(fixtureRoot)) {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("discovers protocols at root protocols/ directory", () => {
    fixtureRoot = join(tmpdir(), `caamp-test-root-protocols-${Date.now()}`);
    mkdirSync(fixtureRoot, { recursive: true });

    // Minimal skills.json
    writeFileSync(
      join(fixtureRoot, "skills.json"),
      JSON.stringify({ version: "1.0.0", skills: [] }),
    );

    // Protocols at root level (root-level layout)
    mkdirSync(join(fixtureRoot, "protocols"), { recursive: true });
    writeFileSync(
      join(fixtureRoot, "protocols", "research.md"),
      "# Research Protocol",
    );
    writeFileSync(
      join(fixtureRoot, "protocols", "implementation.md"),
      "# Implementation Protocol",
    );

    const library = buildLibraryFromFiles(fixtureRoot);

    const protocols = library.listProtocols();
    expect(protocols).toContain("research");
    expect(protocols).toContain("implementation");
    expect(protocols).toHaveLength(2);

    const path = library.getProtocolPath("research");
    expect(path).toBeDefined();
    expect(path).toContain(join("protocols", "research.md"));
    expect(existsSync(path!)).toBe(true);

    const content = library.readProtocol("research");
    expect(content).toContain("# Research Protocol");
  });

  it("falls back to skills/protocols/ when root protocols/ is absent", () => {
    fixtureRoot = join(tmpdir(), `caamp-test-fallback-protocols-${Date.now()}`);
    mkdirSync(fixtureRoot, { recursive: true });

    writeFileSync(
      join(fixtureRoot, "skills.json"),
      JSON.stringify({ version: "1.0.0", skills: [] }),
    );

    // Protocols under skills/ (legacy layout)
    mkdirSync(join(fixtureRoot, "skills", "protocols"), { recursive: true });
    writeFileSync(
      join(fixtureRoot, "skills", "protocols", "consensus.md"),
      "# Consensus Protocol",
    );

    const library = buildLibraryFromFiles(fixtureRoot);

    const protocols = library.listProtocols();
    expect(protocols).toContain("consensus");
    expect(protocols).toHaveLength(1);

    const path = library.getProtocolPath("consensus");
    expect(path).toBeDefined();
    expect(path).toContain(join("skills", "protocols", "consensus.md"));
  });

  it("prefers root protocols/ over skills/protocols/ when both exist", () => {
    fixtureRoot = join(tmpdir(), `caamp-test-prefer-root-${Date.now()}`);
    mkdirSync(fixtureRoot, { recursive: true });

    writeFileSync(
      join(fixtureRoot, "skills.json"),
      JSON.stringify({ version: "1.0.0", skills: [] }),
    );

    // Both locations exist
    mkdirSync(join(fixtureRoot, "protocols"), { recursive: true });
    writeFileSync(join(fixtureRoot, "protocols", "research.md"), "# Root Research");

    mkdirSync(join(fixtureRoot, "skills", "protocols"), { recursive: true });
    writeFileSync(join(fixtureRoot, "skills", "protocols", "research.md"), "# Skills Research");

    const library = buildLibraryFromFiles(fixtureRoot);

    // listProtocols should return from root
    const protocols = library.listProtocols();
    expect(protocols).toContain("research");

    // getProtocolPath should prefer root
    const path = library.getProtocolPath("research");
    expect(path).toContain(join(fixtureRoot, "protocols", "research.md"));

    // Content should be from root
    const content = library.readProtocol("research");
    expect(content).toContain("# Root Research");
  });
});

describe("buildLibraryFromFiles error cases", () => {
  it("throws when neither skills.json nor skills/manifest.json exists", () => {
    const noSkillsDir = join(tmpdir(), `caamp-no-skills-${Date.now()}`);
    mkdirSync(noSkillsDir, { recursive: true });

    expect(() => buildLibraryFromFiles(noSkillsDir)).toThrow(
      "No skills.json or skills/manifest.json found",
    );

    rmSync(noSkillsDir, { recursive: true, force: true });
  });
});

// T12653: @cleocode/skills ships no skills.json — the catalog is derived from
// the generated skills/manifest.json.
describe("buildLibraryFromFiles with a manifest-only library", () => {
  let root: string;

  beforeEach(() => {
    root = join(tmpdir(), `caamp-manifest-only-${Date.now()}`);
    mkdirSync(join(root, "skills", "ct-core"), { recursive: true });
    mkdirSync(join(root, "skills", "ct-extra"), { recursive: true });
    writeFileSync(join(root, "skills", "ct-core", "SKILL.md"), "---\nname: ct-core\n---\n# Core\n");
    writeFileSync(join(root, "skills", "ct-extra", "SKILL.md"), "---\nname: ct-extra\n---\n# Extra\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "2026.9.1" }));
    writeFileSync(
      join(root, "skills", "manifest.json"),
      JSON.stringify({
        $schema: "",
        _meta: {},
        dispatch_matrix: { by_task_type: {}, by_keyword: {}, by_protocol: {} },
        skills: [
          {
            name: "ct-core",
            version: "1.2.0",
            description: "Core skill",
            path: "skills/ct-core",
            tier: 0,
            deliveryTier: "core",
            install: "harness",
            core: true,
            category: "core",
            dependencies: ["ct-extra"],
            sharedResources: ["task-system-integration"],
            compatibility: ["claude-code"],
            license: "MIT",
          },
          {
            name: "ct-extra",
            version: "1.0.0",
            description: "Extra skill with an older manifest shape",
            path: "skills/ct-extra",
            tier: 1,
            deliveryTier: "on-demand",
          },
        ],
      }),
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("derives catalog entries from the manifest", () => {
    const library = buildLibraryFromFiles(root);
    expect(library.version).toBe("2026.9.1");
    expect(library.listSkills()).toEqual(["ct-core", "ct-extra"]);
    expect(library.getCoreSkills().map((s) => s.name)).toEqual(["ct-core"]);
    expect(library.getSkillDependencies("ct-core")).toEqual(["ct-extra"]);
    expect(library.resolveDependencyTree(["ct-core"])).toEqual(["ct-extra", "ct-core"]);
    expect(library.readSkillContent("ct-core")).toContain("# Core");
    expect(library.getSkillDir("ct-extra")).toBe(join(root, "skills", "ct-extra"));
  });

  it("fills catalog defaults for an entry without catalog fields", () => {
    const library = buildLibraryFromFiles(root);
    expect(library.getSkill("ct-extra")).toEqual({
      name: "ct-extra",
      description: "Extra skill with an older manifest shape",
      version: "1.0.0",
      path: "skills/ct-extra/SKILL.md",
      references: [],
      core: false,
      category: "recommended",
      tier: 1,
      protocol: null,
      dependencies: [],
      sharedResources: [],
      compatibility: [],
      license: "MIT",
      metadata: { deliveryTier: "on-demand" },
    });
  });

  it("keeps skills.json authoritative when a library ships one", () => {
    writeFileSync(
      join(root, "skills.json"),
      JSON.stringify({ version: "9.9.9", skills: [] }),
    );
    const library = buildLibraryFromFiles(root);
    expect(library.version).toBe("9.9.9");
    expect(library.listSkills()).toEqual([]);
  });

  it("maps a SKILL.md path unchanged and an unknown category to recommended", () => {
    const entry = catalogEntryFromManifest({
      name: "x",
      version: "1.0.0",
      description: "d",
      path: "skills/x/SKILL.md",
      tags: [],
      status: "active",
      tier: 1,
      token_budget: 0,
      references: [],
      capabilities: {
        inputs: [],
        outputs: [],
        dependencies: [],
        dispatch_triggers: [],
        compatible_subagent_types: [],
        chains_to: [],
        dispatch_keywords: { primary: [], secondary: [] },
      },
      constraints: { max_context_tokens: 0, requires_session: false, requires_epic: false },
    });
    expect(entry.path).toBe("skills/x/SKILL.md");
    expect(entry.category).toBe("recommended");
  });
});
