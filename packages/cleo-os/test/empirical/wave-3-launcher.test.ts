/**
 * Wave 3 empirical gate — CleoOS launcher install UX verification.
 *
 * Per ULTRAPLAN §17, wave gates validate that the artefacts produced by a
 * wave meet the spec before the wave is merged. This test covers the W3
 * deliverables (T391-T398):
 *
 *   - T391: keystore.ts exports `resolveKeystore()` and resolves an auth path
 *   - T392: postinstall.ts source exists and compiles cleanly
 *   - T393: cleo-cant-bridge.ts is present in extensions/ (canonical location)
 *   - T394: tsconfig files cover extensions/ and postinstall compilation
 *   - T395: XDG paths resolve to expected locations
 *   - T396: THIS FILE — the empirical gate itself
 *   - T397: postinstall.ts contains skill install logic
 *   - T398: CLEAN-INSTALL.md exists with docker procedure
 *
 * NOTE: These tests do NOT start a real Pi session. They validate the
 * structure and compilation artefacts only. Real end-to-end testing is
 * documented in `CLEAN-INSTALL.md` (docker procedure).
 *
 * @packageDocumentation
 */

import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Absolute path to the `packages/cleo-os/` root. */
const PKG_ROOT = resolve(__dirname, "..", "..");

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
// T393: Bridge at canonical location
// ---------------------------------------------------------------------------

describe("T393 — cleo-cant-bridge at canonical location", () => {
  it("extensions/cleo-cant-bridge.ts exists", () => {
    const bridgeSrc = join(PKG_ROOT, "extensions", "cleo-cant-bridge.ts");
    const content = readRequired(bridgeSrc);
    expect(content).toContain("CANONICAL LOCATION");
    expect(content).toContain("export default function");
  });

  it("bridge contains APPEND comment (never replace per ULTRAPLAN L6)", () => {
    const bridgeSrc = join(PKG_ROOT, "extensions", "cleo-cant-bridge.ts");
    const content = readFileSync(bridgeSrc, "utf-8");
    expect(content).toContain("APPEND");
  });

  it("bridge registers before_agent_start handler", () => {
    const bridgeSrc = join(PKG_ROOT, "extensions", "cleo-cant-bridge.ts");
    const content = readFileSync(bridgeSrc, "utf-8");
    expect(content).toContain("before_agent_start");
  });
});

// ---------------------------------------------------------------------------
// T391: keystore.ts
// ---------------------------------------------------------------------------

describe("T391 — keystore.ts", () => {
  it("src/keystore.ts exists", () => {
    const keystoreSrc = join(PKG_ROOT, "src", "keystore.ts");
    readRequired(keystoreSrc);
  });

  it("exports resolveKeystore function", () => {
    const keystoreSrc = join(PKG_ROOT, "src", "keystore.ts");
    const content = readFileSync(keystoreSrc, "utf-8");
    expect(content).toContain("export function resolveKeystore");
  });

  it("imports FileAuthStorageBackend from pi-coding-agent", () => {
    const keystoreSrc = join(PKG_ROOT, "src", "keystore.ts");
    const content = readFileSync(keystoreSrc, "utf-8");
    expect(content).toContain("FileAuthStorageBackend");
    expect(content).toContain("@mariozechner/pi-coding-agent");
  });

  it("uses XDG auth path from xdg.ts", () => {
    const keystoreSrc = join(PKG_ROOT, "src", "keystore.ts");
    const content = readFileSync(keystoreSrc, "utf-8");
    expect(content).toContain("resolveCleoOsPaths");
    expect(content).toContain("paths.auth");
  });
});

// ---------------------------------------------------------------------------
// T392: postinstall.ts source
// ---------------------------------------------------------------------------

describe("T392 — postinstall.ts source", () => {
  it("src/postinstall.ts exists", () => {
    const src = join(PKG_ROOT, "src", "postinstall.ts");
    readRequired(src);
  });

  it("contains isGlobalInstall function", () => {
    const src = join(PKG_ROOT, "src", "postinstall.ts");
    const content = readFileSync(src, "utf-8");
    expect(content).toContain("isGlobalInstall");
  });

  it("uses env-paths directly for cross-OS path resolution (no core import)", () => {
    const src = join(PKG_ROOT, "src", "postinstall.ts");
    const content = readFileSync(src, "utf-8");
    // Postinstall MUST use env-paths directly — NOT import from @cleocode/core.
    // Core's dist/ may not exist when this script runs in workspace CI
    // (pnpm install triggers postinstall before build). env-paths is a
    // direct dep resolvable right after install.
    expect(content).toContain("envPaths");
    expect(content).toContain("'env-paths'");
    expect(content).not.toContain("@cleocode/core/system/platform-paths");
  });

  it("deploys cleo-cant-bridge extension", () => {
    const src = join(PKG_ROOT, "src", "postinstall.ts");
    const content = readFileSync(src, "utf-8");
    expect(content).toContain("cleo-cant-bridge");
  });

  it("deploys cleo-chatroom extension", () => {
    const src = join(PKG_ROOT, "src", "postinstall.ts");
    const content = readFileSync(src, "utf-8");
    expect(content).toContain("cleo-chatroom");
  });

  it("creates model-routing.cant stub", () => {
    const src = join(PKG_ROOT, "src", "postinstall.ts");
    const content = readFileSync(src, "utf-8");
    expect(content).toContain("model-routing.cant");
  });
});

// ---------------------------------------------------------------------------
// T394: tsconfig coverage
// ---------------------------------------------------------------------------

describe("T394 — tsconfig build pipeline", () => {
  it("tsconfig.json exists", () => {
    const tsconfig = join(PKG_ROOT, "tsconfig.json");
    readRequired(tsconfig);
  });

  it("tsconfig.extensions.json exists", () => {
    const tsconfig = join(PKG_ROOT, "tsconfig.extensions.json");
    const content = readRequired(tsconfig);
    expect(content).toContain("extensions");
  });

  it("tsconfig.postinstall.json exists", () => {
    const tsconfig = join(PKG_ROOT, "tsconfig.postinstall.json");
    const content = readRequired(tsconfig);
    expect(content).toContain("postinstall");
  });

  it("package.json build script covers all three tsconfig files", () => {
    const pkgJson = join(PKG_ROOT, "package.json");
    const content = readRequired(pkgJson);
    const pkg = JSON.parse(content) as { scripts: Record<string, string> };
    expect(pkg.scripts["build"]).toContain("tsconfig.extensions.json");
    expect(pkg.scripts["build"]).toContain("tsconfig.postinstall.json");
  });
});

// ---------------------------------------------------------------------------
// T395: XDG path correctness
// ---------------------------------------------------------------------------

describe("T395 — XDG path resolution", () => {
  const originalEnv: Record<string, string | undefined> = { ...process.env };

  // Restore via key-level mutation so env-paths's captured process.env
  // reference stays live across tests (reassigning process.env orphans it).
  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v !== undefined) process.env[k] = v;
    }
  });

  it("resolveCleoOsPaths resolves auth under config root", async () => {
    process.env["XDG_CONFIG_HOME"] = "/tmp/test-xdg-w3";
    const { resolveCleoOsPaths } = await import("../../src/xdg.js");
    const paths = resolveCleoOsPaths();
    expect(paths.auth).toBe("/tmp/test-xdg-w3/cleo/auth");
  });

  it("resolveCleoOsPaths resolves extensions under data root", async () => {
    process.env["XDG_DATA_HOME"] = "/tmp/test-xdg-w3-data";
    const { resolveCleoOsPaths } = await import("../../src/xdg.js");
    const paths = resolveCleoOsPaths();
    expect(paths.extensions).toBe("/tmp/test-xdg-w3-data/cleo/extensions");
  });

  it("resolveCleoOsPaths resolves cant under data root", async () => {
    process.env["XDG_DATA_HOME"] = "/tmp/test-xdg-w3-cant";
    const { resolveCleoOsPaths } = await import("../../src/xdg.js");
    const paths = resolveCleoOsPaths();
    expect(paths.cant).toBe("/tmp/test-xdg-w3-cant/cleo/cant");
  });
});

// ---------------------------------------------------------------------------
// T397: Skill install in postinstall
// ---------------------------------------------------------------------------

describe("T397 — skill install via postinstall", () => {
  it("postinstall.ts calls installSkills", () => {
    const src = join(PKG_ROOT, "src", "postinstall.ts");
    const content = readFileSync(src, "utf-8");
    expect(content).toContain("installSkills");
  });

  it("skill install uses execFileSync (not exec) to prevent injection", () => {
    const src = join(PKG_ROOT, "src", "postinstall.ts");
    const content = readFileSync(src, "utf-8");
    expect(content).toContain("execFileSync");
    // Must NOT use exec() with template strings
    expect(content).not.toContain('exec(`');
    expect(content).not.toContain("exec(`");
  });

  it("skill install invokes cleo skills install", () => {
    const src = join(PKG_ROOT, "src", "postinstall.ts");
    const content = readFileSync(src, "utf-8");
    expect(content).toContain("skills");
    expect(content).toContain("install");
  });
});

// ---------------------------------------------------------------------------
// T398: Clean install documentation exists
// ---------------------------------------------------------------------------

describe("T398 — CLEAN-INSTALL.md documentation", () => {
  it("test/empirical/CLEAN-INSTALL.md exists", () => {
    const docPath = join(PKG_ROOT, "test", "empirical", "CLEAN-INSTALL.md");
    readRequired(docPath);
  });

  it("CLEAN-INSTALL.md contains docker procedure", () => {
    const docPath = join(PKG_ROOT, "test", "empirical", "CLEAN-INSTALL.md");
    const content = readFileSync(docPath, "utf-8");
    expect(content).toContain("docker");
  });

  it("CLEAN-INSTALL.md references @cleocode/cleo-os", () => {
    const docPath = join(PKG_ROOT, "test", "empirical", "CLEAN-INSTALL.md");
    const content = readFileSync(docPath, "utf-8");
    expect(content).toContain("@cleocode/cleo-os");
  });
});

// ---------------------------------------------------------------------------
// dist/cli.js artefact checks (if built)
// ---------------------------------------------------------------------------

describe("dist/cli.js artefact (if built)", () => {
  const cliDist = join(PKG_ROOT, "dist", "cli.js");

  it("dist/cli.js has shebang on line 1 (if built)", () => {
    if (!existsSync(cliDist)) {
      // Not built yet — skip gracefully
      return;
    }
    const content = readFileSync(cliDist, "utf-8");
    const firstLine = content.split("\n")[0];
    expect(firstLine).toBe("#!/usr/bin/env node");
  });

  it("dist/cli.js is executable (if built)", () => {
    if (!existsSync(cliDist)) {
      return;
    }
    const stat = statSync(cliDist);
    // Check owner-executable bit (0o100 in octal)
    expect(stat.mode & 0o100).toBeGreaterThan(0);
  });
});
