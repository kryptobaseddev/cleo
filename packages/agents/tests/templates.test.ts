/**
 * T1932 / ADR-068 — Agent templates canonical layout verification.
 *
 * Validates that the canonical templates/ directory in `@cleocode/agents`
 * (consolidated from seed-agents/ per ADR-068) satisfies:
 *   1. All 5 named templates exist with the correct project-<role> filenames.
 *   2. Filename basename equals the declared `agent <name>:` line (install-validator contract).
 *   3. Mustache `{{vars}}` are preserved (D033 lazy substitution — NOT resolved at install time).
 *   4. TEAM-002 constraint: lead/orchestrator agents do NOT hold Edit/Write/Bash in tools.core.
 *   5. Worker agents DO hold Edit/Write/Bash in tools.core.
 *   6. Orchestrator has tier: high.
 *   7. All templates have required blocks: role, tier, mental_model, permissions, tools.
 *
 * @packageDocumentation
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Absolute path to packages/agents/ root. */
const PKG_ROOT = resolve(__dirname, "..");

/** Absolute path to the canonical templates/ directory (ADR-068 Decision 2). */
const TEMPLATES_DIR = join(PKG_ROOT, "templates");

/**
 * The 5 canonical worker templates (filename basename = declared agent name per ADR-068 Decision 1).
 */
const EXPECTED_TEMPLATES = [
  "project-orchestrator.cant",
  "project-dev-lead.cant",
  "project-code-worker.cant",
  "project-docs-worker.cant",
  "project-security-worker.cant",
] as const;

/** Agents that are leads/orchestrators and MUST NOT hold Edit/Write/Bash (TEAM-002). */
const LEAD_AGENTS = ["project-orchestrator.cant", "project-dev-lead.cant"] as const;

/** Agents that are workers and MUST hold Edit/Write/Bash. */
const WORKER_AGENTS_WITH_WRITE = [
  "project-code-worker.cant",
  "project-docs-worker.cant",
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read a required file and return its content.
 *
 * @param filePath - Absolute path to the file.
 * @returns File content as a UTF-8 string.
 */
function readRequired(filePath: string): string {
  expect(existsSync(filePath), `File should exist: ${filePath}`).toBe(true);
  const content = readFileSync(filePath, "utf-8");
  expect(content.length, `File should be non-empty: ${filePath}`).toBeGreaterThan(0);
  return content;
}

/**
 * Extract the YAML frontmatter `kind` field from a .cant file.
 *
 * @param content - The full file content.
 * @returns The kind value, or null if not found.
 */
function extractFrontmatterKind(content: string): string | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;
  const kindMatch = match[1].match(/kind:\s*(\S+)/);
  return kindMatch ? kindMatch[1] : null;
}

/**
 * Extract the declared agent name from `agent <name>:` line.
 *
 * @param content - The full file content.
 * @returns The declared agent name, or null if not found.
 */
function extractDeclaredAgentName(content: string): string | null {
  const match = content.match(/^agent\s+(\S+):/m);
  return match ? match[1] : null;
}

/**
 * Check whether a .cant agent file contains a specific block.
 *
 * @param content - The full file content.
 * @param blockName - The block name to search for.
 * @returns True if the block is present.
 */
function hasBlock(content: string, blockName: string): boolean {
  return content.includes(blockName);
}

/**
 * Extract the tools.core list from a .cant file.
 *
 * Parses lines like `core: [Read, Edit, Write, Bash, Glob, Grep]`
 *
 * @param content - The full file content.
 * @returns Array of tool names, or null if not found.
 */
function extractToolsCore(content: string): string[] | null {
  const match = content.match(/core:\s*\[([^\]]+)\]/);
  if (!match) return null;
  return match[1].split(",").map((t) => t.trim());
}

// ---------------------------------------------------------------------------
// 1. Templates directory and file existence
// ---------------------------------------------------------------------------

describe("ADR-068 — templates/ directory structure", () => {
  it("templates/ directory exists", () => {
    expect(existsSync(TEMPLATES_DIR)).toBe(true);
  });

  for (const templateFile of EXPECTED_TEMPLATES) {
    it(`${templateFile} exists in templates/`, () => {
      readRequired(join(TEMPLATES_DIR, templateFile));
    });

    it(`${templateFile} has kind: agent frontmatter`, () => {
      const content = readRequired(join(TEMPLATES_DIR, templateFile));
      const kind = extractFrontmatterKind(content);
      expect(kind).toBe("agent");
    });
  }

  it("no starter-bundle/ directory exists (deleted per ADR-068)", () => {
    expect(existsSync(join(PKG_ROOT, "starter-bundle"))).toBe(false);
  });

  it("no seed-agents/ directory exists (renamed to templates/ per ADR-068)", () => {
    expect(existsSync(join(PKG_ROOT, "seed-agents"))).toBe(false);
  });

  it("no *-generic.cant files exist in templates/ (deleted per ADR-068 Bug 1 fix)", () => {
    const genericFiles = EXPECTED_TEMPLATES.filter((f) =>
      f.includes("-generic"),
    );
    expect(genericFiles.length).toBe(0);
    // Also check disk directly
    for (const role of ["orchestrator", "dev-lead", "code-worker", "docs-worker"]) {
      expect(
        existsSync(join(TEMPLATES_DIR, `${role}-generic.cant`)),
        `${role}-generic.cant should not exist`,
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Install-validator contract: filename basename MUST equal declared name
//    (ADR-068 Decision 1 — resolves Bug 4)
// ---------------------------------------------------------------------------

describe("ADR-068 — filename basename equals declared agent name (install-validator contract)", () => {
  for (const templateFile of EXPECTED_TEMPLATES) {
    it(`${templateFile}: filename basename equals 'agent <name>:' declaration`, () => {
      const content = readRequired(join(TEMPLATES_DIR, templateFile));
      const declared = extractDeclaredAgentName(content);
      expect(
        declared,
        `${templateFile} must declare 'agent <name>:'`,
      ).not.toBeNull();
      const fileBasename = basename(templateFile, ".cant");
      expect(
        declared,
        `filename basename '${fileBasename}' must equal declared name '${declared}'`,
      ).toBe(fileBasename);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. Mustache {{vars}} preserved (D033 — lazy substitution at spawn time)
// ---------------------------------------------------------------------------

describe("ADR-068 D033 — Mustache {{vars}} preserved in templates (lazy substitution)", () => {
  it("all 5 templates contain at least one {{var}} placeholder", () => {
    for (const templateFile of EXPECTED_TEMPLATES) {
      const content = readRequired(join(TEMPLATES_DIR, templateFile));
      expect(
        content.includes("{{"),
        `${templateFile} must contain Mustache {{vars}} (D033 lazy substitution preserved)`,
      ).toBe(true);
    }
  });

  it("project-orchestrator.cant has {{tech_stack}} and {{project_domain}}", () => {
    const content = readRequired(join(TEMPLATES_DIR, "project-orchestrator.cant"));
    expect(content).toContain("{{tech_stack}}");
    expect(content).toContain("{{project_domain}}");
  });

  it("project-code-worker.cant has {{test_command}} and {{build_command}}", () => {
    const content = readRequired(join(TEMPLATES_DIR, "project-code-worker.cant"));
    expect(content).toContain("{{test_command}}");
    expect(content).toContain("{{build_command}}");
  });

  it("project-dev-lead.cant has {{tech_stack}} and {{project_domain}}", () => {
    const content = readRequired(join(TEMPLATES_DIR, "project-dev-lead.cant"));
    expect(content).toContain("{{tech_stack}}");
    expect(content).toContain("{{project_domain}}");
  });

  it("project-docs-worker.cant has {{tech_stack}} and {{project_domain}}", () => {
    const content = readRequired(join(TEMPLATES_DIR, "project-docs-worker.cant"));
    expect(content).toContain("{{tech_stack}}");
    expect(content).toContain("{{project_domain}}");
  });

  it("project-security-worker.cant has {{tech_stack}} and {{project_domain}}", () => {
    const content = readRequired(join(TEMPLATES_DIR, "project-security-worker.cant"));
    expect(content).toContain("{{tech_stack}}");
    expect(content).toContain("{{project_domain}}");
  });
});

// ---------------------------------------------------------------------------
// 4. Required blocks present in all templates
// ---------------------------------------------------------------------------

describe("ADR-068 — Required CANT blocks present", () => {
  const requiredBlocks = ["role:", "tier:", "mental_model:", "permissions:", "tools:"];

  for (const templateFile of EXPECTED_TEMPLATES) {
    describe(templateFile, () => {
      for (const block of requiredBlocks) {
        it(`has ${block} block`, () => {
          const content = readRequired(join(TEMPLATES_DIR, templateFile));
          expect(
            hasBlock(content, block),
            `${templateFile} is missing ${block}`,
          ).toBe(true);
        });
      }

      it("has tools.core: list", () => {
        const content = readRequired(join(TEMPLATES_DIR, templateFile));
        const tools = extractToolsCore(content);
        expect(tools, `${templateFile} is missing tools.core: [...]`).not.toBeNull();
        expect(tools!.length).toBeGreaterThan(0);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// 5. TEAM-002: Leads/orchestrators do NOT hold Edit/Write/Bash
// ---------------------------------------------------------------------------

describe("ADR-068 TEAM-002 — Lead/orchestrator agents must not have Edit/Write/Bash", () => {
  const BLOCKED_LEAD_TOOLS = ["Edit", "Write", "Bash"];

  for (const templateFile of LEAD_AGENTS) {
    it(`${templateFile} tools.core does not include Edit/Write/Bash`, () => {
      const content = readRequired(join(TEMPLATES_DIR, templateFile));
      const tools = extractToolsCore(content);
      expect(tools, `${templateFile} must have tools.core list`).not.toBeNull();
      for (const blocked of BLOCKED_LEAD_TOOLS) {
        expect(
          tools!.includes(blocked),
          `${templateFile} MUST NOT have ${blocked} in tools.core (TEAM-002)`,
        ).toBe(false);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 6. Workers DO hold Edit/Write/Bash
// ---------------------------------------------------------------------------

describe("ADR-068 — Worker agents must have Edit/Write/Bash", () => {
  const WORKER_TOOLS = ["Edit", "Write", "Bash"];

  for (const templateFile of WORKER_AGENTS_WITH_WRITE) {
    it(`${templateFile} tools.core includes Edit/Write/Bash`, () => {
      const content = readRequired(join(TEMPLATES_DIR, templateFile));
      const tools = extractToolsCore(content);
      expect(tools, `${templateFile} must have tools.core list`).not.toBeNull();
      for (const tool of WORKER_TOOLS) {
        expect(
          tools!.includes(tool),
          `${templateFile} MUST have ${tool} in tools.core`,
        ).toBe(true);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 7. Orchestrator tier
// ---------------------------------------------------------------------------

describe("ADR-068 — Orchestrator tier", () => {
  it("project-orchestrator has tier: high", () => {
    const content = readRequired(join(TEMPLATES_DIR, "project-orchestrator.cant"));
    expect(content).toContain("tier: high");
  });

  it("project-dev-lead has tier: mid", () => {
    const content = readRequired(join(TEMPLATES_DIR, "project-dev-lead.cant"));
    expect(content).toContain("tier: mid");
    expect(content).not.toContain("tier: high");
  });

  it("project-code-worker has tier: mid", () => {
    const content = readRequired(join(TEMPLATES_DIR, "project-code-worker.cant"));
    expect(content).toContain("tier: mid");
  });
});

// ---------------------------------------------------------------------------
// 8. Parent references use canonical project-orchestrator name (pre-condition 1)
// ---------------------------------------------------------------------------

describe("ADR-068 — Canonical parent references", () => {
  it("project-dev-lead has parent: project-orchestrator", () => {
    const content = readRequired(join(TEMPLATES_DIR, "project-dev-lead.cant"));
    expect(content).toContain("parent: project-orchestrator");
    expect(content).not.toContain("parent: cleo-orchestrator");
  });

  it("project-code-worker has parent: project-dev-lead", () => {
    const content = readRequired(join(TEMPLATES_DIR, "project-code-worker.cant"));
    expect(content).toContain("parent: project-dev-lead");
  });

  it("project-docs-worker has parent: project-dev-lead", () => {
    const content = readRequired(join(TEMPLATES_DIR, "project-docs-worker.cant"));
    expect(content).toContain("parent: project-dev-lead");
  });

  it("project-security-worker has parent: project-dev-lead", () => {
    const content = readRequired(join(TEMPLATES_DIR, "project-security-worker.cant"));
    expect(content).toContain("parent: project-dev-lead");
  });
});
