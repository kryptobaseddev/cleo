import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildLibraryFromFiles } from "../../src/core/skills/library-loader.js";
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
  it("throws when skills.json is missing", () => {
    const noSkillsDir = join(tmpdir(), `caamp-no-skills-${Date.now()}`);
    mkdirSync(noSkillsDir, { recursive: true });

    expect(() => buildLibraryFromFiles(noSkillsDir)).toThrow("No skills.json found");

    rmSync(noSkillsDir, { recursive: true, force: true });
  });
});
