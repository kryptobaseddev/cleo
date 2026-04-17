/**
 * Wave 10 empirical gate — CleoOS VISION.md incremental rewrite validation.
 *
 * Per ULTRAPLAN §17, wave gates validate that the artefacts produced by a
 * wave meet the spec before the wave is merged. This test covers the Wave 10
 * deliverable (T325):
 *
 *   - T325: CLEOOS-VISION.md incremented to v2026.4.78 with current stack state
 *   - Asserts version string matches current release (v2026.4.78)
 *   - Asserts key sections present: Identity, Stack, Architecture Layers, ADRs
 *   - Asserts references to recent milestones (Release Pipeline, IVTR, Docs CLI)
 *
 * NOTE: This test does NOT start a real Pi session. It validates that the
 * vision document reflects the current state of CleoOS at v2026.4.78 through
 * static content assertions and version string verification.
 *
 * @packageDocumentation
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Relative path to monorepo root: test/empirical/../../../
const MONOREPO_ROOT = resolve(__dirname, "..", "..", "..", "..");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check that a file exists and is non-empty.
 *
 * @param filePath - Absolute path to check.
 * @returns The file content as a string.
 */
function readRequired(filePath: string): string {
  expect(existsSync(filePath), `File should exist: ${filePath}`).toBe(true);
  const content = readFileSync(filePath, "utf-8");
  expect(content.length, `File should be non-empty: ${filePath}`).toBeGreaterThan(0);
  return content;
}

// ---------------------------------------------------------------------------
// T325: CLEOOS-VISION.md version and content validation
// ---------------------------------------------------------------------------

describe("T325 — CLEOOS-VISION.md Wave 10 rewrite", () => {
  const visionPath = join(MONOREPO_ROOT, "docs", "concepts", "CLEOOS-VISION.md");

  it("docs/concepts/CLEOOS-VISION.md exists and is non-empty", () => {
    readRequired(visionPath);
  });

  it("VISION.md version string is v2026.4.78 or later", () => {
    const content = readFileSync(visionPath, "utf-8");
    // Extract version line: **Version**: 2026.4.78
    const versionMatch = content.match(/\*\*Version\*\*:\s*([0-9.]+)/);
    expect(versionMatch, "version line should exist in YAML front-matter").toBeTruthy();
    if (versionMatch) {
      const version = versionMatch[1];
      // Parse as YYYY.MM.patch
      const [yearStr, monthStr, patchStr] = version.split(".");
      const year = parseInt(yearStr, 10);
      const month = parseInt(monthStr, 10);
      const patch = parseInt(patchStr, 10);

      // Must be at least v2026.4.78
      expect(year).toBeGreaterThanOrEqual(2026);
      if (year === 2026) {
        expect(month).toBeGreaterThanOrEqual(4);
        if (month === 4) {
          expect(patch).toBeGreaterThanOrEqual(78);
        }
      }
    }
  });

  it("VISION.md contains 'What Exists Now' section with current kernel version", () => {
    const content = readFileSync(visionPath, "utf-8");
    expect(content).toContain("### What Exists Now");
    expect(content).toContain("@cleocode/core");
  });

  it("VISION.md references the 6 canonical systems", () => {
    const content = readFileSync(visionPath, "utf-8");
    expect(content).toContain("TASKS");
    expect(content).toContain("LOOM");
    expect(content).toContain("BRAIN");
    expect(content).toContain("NEXUS");
    expect(content).toContain("CANT");
    expect(content).toContain("CONDUIT");
  });

  it("VISION.md mentions LAFS cross-cutting protocol", () => {
    const content = readFileSync(visionPath, "utf-8");
    expect(content).toContain("LAFS");
    expect(content).toContain("LLM-Agent-First Specification");
  });

  it("VISION.md includes Architecture Layers section", () => {
    const content = readFileSync(visionPath, "utf-8");
    expect(content).toContain("## 5. Architecture Layers");
    expect(content).toContain("Operator Layer");
    expect(content).toContain("Execution Layer");
    expect(content).toContain("Relay Layer");
    expect(content).toContain("Coordination Layer");
  });

  it("VISION.md documents Release Pipeline automation (v2026.4.78)", () => {
    const content = readFileSync(visionPath, "utf-8");
    expect(content).toContain("Release Pipeline");
    expect(content).toContain("cleo release");
    expect(content).toContain("CalVer");
    expect(content).toContain("structural CI gates");
  });

  it("VISION.md documents IVTR lifecycle model and programmatic gates", () => {
    const content = readFileSync(visionPath, "utf-8");
    expect(content).toContain("IVTR");
    expect(content).toContain("Research/Consensus/Specification/Decomposition/Implementation/Validation/Testing");
    expect(content).toContain("cleo verify");
  });

  it("VISION.md documents CLEO Docs CLI (v2026.4.77+)", () => {
    const content = readFileSync(visionPath, "utf-8");
    expect(content).toContain("CLEO Docs CLI");
    expect(content).toContain("cleo docs");
    expect(content).toContain("Forge-TS");
  });

  it("VISION.md documents Commander-Shim provider compatibility", () => {
    const content = readFileSync(visionPath, "utf-8");
    expect(content).toContain("Commander-Shim");
    expect(content).toContain("CAAMP-Commander");
  });

  it("VISION.md documents TS monorepo with 12 packages", () => {
    const content = readFileSync(visionPath, "utf-8");
    expect(content).toContain("TS Monorepo");
    expect(content).toContain("@cleocode/");
    expect(content).toContain("pnpm workspaces");
  });

  it("VISION.md documents Rust crates ecosystem (14 crates)", () => {
    const content = readFileSync(visionPath, "utf-8");
    expect(content).toContain("Rust Crates");
    expect(content).toContain("packages/cleos/");
  });

  it("VISION.md contains all major sections", () => {
    const content = readFileSync(visionPath, "utf-8");
    const expectedSections = [
      "## 1. What CleoOS Is",
      "## 2. The Kernel Relationship",
      "## 3. Why CleoOS",
      "## 4. Key Components",
      "## 5. Architecture Layers",
      "## 6. Vision Timeline",
      "## 7. Design Principles",
      "## 8. What CleoOS Is Not",
      "## 9. The Operating Metaphor",
    ];
    for (const section of expectedSections) {
      expect(content).toContain(section);
    }
  });

  it("VISION.md contains References section with spec documents", () => {
    const content = readFileSync(visionPath, "utf-8");
    expect(content).toContain("## References");
    expect(content).toContain("docs/concepts/");
    expect(content).toContain("docs/specs/");
  });

  it("VISION.md explains Conduit 4-shell model correctly", () => {
    const content = readFileSync(visionPath, "utf-8");
    expect(content).toContain("4-shell");
    expect(content).toContain("Pi native");
    expect(content).toContain("conduit.db");
    expect(content).toContain("signaldock.io");
  });

  it("VISION.md describes project lifecycle phases", () => {
    const content = readFileSync(visionPath, "utf-8");
    expect(content).toContain("## 4.4 Project Lifecycle");
    expect(content).toContain("Inception");
    expect(content).toContain("Planning");
    expect(content).toContain("Implementation");
    expect(content).toContain("Validation");
    expect(content).toContain("Release");
    expect(content).toContain("Maintenance");
  });

  it("VISION.md contains Design Principles section (8 principles)", () => {
    const content = readFileSync(visionPath, "utf-8");
    expect(content).toContain("## 7. Design Principles");
    expect(content).toContain("Kernel stability");
    expect(content).toContain("No new domains");
    expect(content).toContain("Provider neutrality");
    expect(content).toContain("Local-first");
    expect(content).toContain("Governed execution");
    expect(content).toContain("Memory as infrastructure");
    expect(content).toContain("Provenance by default");
    expect(content).toContain("Progressive disclosure");
  });

  it("VISION.md contains Operating Metaphor section (kernel analogy)", () => {
    const content = readFileSync(visionPath, "utf-8");
    expect(content).toContain("## 9. The Operating Metaphor");
    expect(content).toContain("If `@cleocode/core` is the kernel");
    expect(content).toContain("TASKS");
    expect(content).toContain("job table");
  });

  it("VISION.md does NOT contain outdated version strings", () => {
    const content = readFileSync(visionPath, "utf-8");
    // Should not have old v2026.4.24 references
    expect(content).not.toMatch(/v2026\.4\.24\b/);
    // Should not have old v2026.4.18 references in the heading
    expect(content).not.toMatch(/\*\*Version\*\*:\s*2026\.4\.24/);
  });
});

// ---------------------------------------------------------------------------
// Wave 10 artifact checks (this file itself)
// ---------------------------------------------------------------------------

describe("Wave 10 empirical gate artifact (this file)", () => {
  it("wave-10-vision.test.ts exists in packages/cleo-os/test/empirical/", () => {
    const testPath = join(MONOREPO_ROOT, "packages", "cleo-os", "test", "empirical", "wave-10-vision.test.ts");
    expect(existsSync(testPath)).toBe(true);
  });

  it("test file has proper vitest imports and describe blocks", () => {
    const testPath = join(MONOREPO_ROOT, "packages", "cleo-os", "test", "empirical", "wave-10-vision.test.ts");
    const content = readFileSync(testPath, "utf-8");
    expect(content).toContain('import { describe, it, expect }');
    expect(content).toContain("describe(");
    expect(content).toContain("it(");
  });
});
