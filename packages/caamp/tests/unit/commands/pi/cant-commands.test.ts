/**
 * Integration-style tests for the `caamp pi cant <verb>` commands.
 *
 * @remarks
 * Constructs Commander programs with just the `pi` command group
 * attached and drives the four cant verbs through `parseAsync`,
 * intercepting `process.exit`, `console.log`, and `console.error` so
 * each verb's LAFS envelope output is asserted against in isolation.
 * Mirrors the harness pattern established by `commands.test.ts` for
 * extensions/sessions/models/prompts/themes.
 *
 * Test fixtures use real seed-agent `.cant` files from
 * `packages/agents/seed-agents/` so the validator exercises the same
 * code path it will see in production.
 */

import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerPiCommands } from "../../../../src/commands/pi/index.js";
import { resetDetectionCache } from "../../../../src/core/registry/detection.js";
import { resetRegistry } from "../../../../src/core/registry/providers.js";

interface CapturedOutput {
  stdout: string[];
  stderr: string[];
  exitCode: number | null;
}

/**
 * Build a fresh Commander program with just the `pi` group attached,
 * swap stdout/stderr/process.exit with capture hooks, run the supplied
 * argv through `parseAsync`, and return the captured output.
 */
async function runPi(argv: string[]): Promise<CapturedOutput> {
  const captured: CapturedOutput = { stdout: [], stderr: [], exitCode: null };
  const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
    captured.stdout.push(
      args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "),
    );
  });
  const errSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
    captured.stderr.push(
      args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "),
    );
  });
  const exitSpy = vi
    .spyOn(process, "exit")
    .mockImplementation(((code?: number | string | null) => {
      captured.exitCode = typeof code === "number" ? code : code === undefined ? null : Number(code);
      throw new Error(`__caamp_test_exit_${captured.exitCode ?? "0"}`);
    }) as unknown as (code?: number | string | null) => never);

  const program = new Command();
  program.exitOverride();
  registerPiCommands(program);
  try {
    await program.parseAsync(["node", "caamp", ...argv]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.startsWith("__caamp_test_exit_")) {
      captured.stderr.push(message);
    }
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return captured;
}

function parseEnvelope(lines: string[]): unknown {
  const joined = lines.join("\n");
  try {
    return JSON.parse(joined);
  } catch {
    return null;
  }
}

let piRoot: string;
let cleoHomeRoot: string;
let projectRoot: string;
let uniqueRoot: string;
let savedPiDir: string | undefined;
let savedCleoHome: string | undefined;

/**
 * Locate the seed-agent fixtures directory at runtime so tests work
 * regardless of which working directory vitest was launched from.
 */
function seedAgentsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..", "..", "..", "agents", "seed-agents");
}

/**
 * Create `~/.pi/agent` if missing (so Pi's directory detection passes)
 * and return a cleanup that removes it only when it was created here
 * and only when it is still empty.
 */
async function ensurePiDetectable(): Promise<() => Promise<void>> {
  const piDir = join(homedir(), ".pi", "agent");
  let created = false;
  const fs = await import("node:fs");
  if (!fs.existsSync(piDir)) {
    await mkdir(piDir, { recursive: true });
    created = true;
  }
  return async () => {
    if (!created) return;
    try {
      const entries = fs.readdirSync(piDir);
      if (entries.length === 0) {
        await rm(piDir, { recursive: false, force: true });
      }
    } catch {
      // ignore
    }
  };
}

beforeEach(async () => {
  resetRegistry();
  resetDetectionCache();
  const unique = `caamp-pi-cant-cmd-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  uniqueRoot = join(tmpdir(), unique);
  piRoot = join(uniqueRoot, "pi-agent");
  cleoHomeRoot = join(uniqueRoot, "cleo-home");
  projectRoot = join(uniqueRoot, "project");
  await mkdir(piRoot, { recursive: true });
  await mkdir(cleoHomeRoot, { recursive: true });
  await mkdir(projectRoot, { recursive: true });

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
  await rm(uniqueRoot, { recursive: true, force: true }).catch(() => {});
  resetRegistry();
  resetDetectionCache();
});

describe("caamp pi cant commands", () => {
  describe("list", () => {
    it("emits an empty array when no profiles exist", async () => {
      const cleanup = await ensurePiDetectable();
      try {
        resetDetectionCache();
        const out = await runPi(["pi", "cant", "list", "--project-dir", projectRoot]);
        const envelope = parseEnvelope(out.stdout);
        expect(envelope).not.toBeNull();
        const env = envelope as {
          success: boolean;
          result: { count: number; entries: unknown[] };
        };
        expect(env.success).toBe(true);
        expect(env.result.count).toBe(0);
        expect(env.result.entries).toEqual([]);
      } finally {
        await cleanup();
      }
    });

    it("filters by --scope when supplied", async () => {
      const cleanup = await ensurePiDetectable();
      try {
        const seedSrc = join(seedAgentsDir(), "cleo-dev.cant");
        resetDetectionCache();
        // Install at user tier.
        await runPi(["pi", "cant", "install", seedSrc, "--scope", "user"]);
        // Install at project tier.
        await runPi([
          "pi",
          "cant",
          "install",
          seedSrc,
          "--scope",
          "project",
          "--project-dir",
          projectRoot,
          "--name",
          "cleo-dev-project",
        ]);
        // List with --scope user should only show the user tier.
        const out = await runPi([
          "pi",
          "cant",
          "list",
          "--scope",
          "user",
          "--project-dir",
          projectRoot,
        ]);
        const env = parseEnvelope(out.stdout) as {
          success: boolean;
          result: {
            count: number;
            entries: Array<{ name: string; tier: string }>;
          };
        };
        expect(env.success).toBe(true);
        expect(env.result.entries.every((e) => e.tier === "user")).toBe(true);
        expect(env.result.entries.find((e) => e.name === "cleo-dev")).toBeDefined();
      } finally {
        await cleanup();
      }
    });
  });

  describe("install", () => {
    it("copies a real seed-agent .cant file into the user tier", async () => {
      const cleanup = await ensurePiDetectable();
      try {
        const seedSrc = join(seedAgentsDir(), "cleo-dev.cant");
        resetDetectionCache();
        const out = await runPi(["pi", "cant", "install", seedSrc, "--scope", "user"]);
        const envelope = parseEnvelope(out.stdout);
        expect(envelope).not.toBeNull();
        const env = envelope as {
          success: boolean;
          result: {
            installed: {
              name: string;
              tier: string;
              targetPath: string;
              counts: { agentCount: number; hookCount: number };
            };
          };
        };
        expect(env.success).toBe(true);
        expect(env.result.installed.tier).toBe("user");
        expect(env.result.installed.name).toBe("cleo-dev");
        expect(existsSync(env.result.installed.targetPath)).toBe(true);
        expect(env.result.installed.counts.agentCount).toBe(1);
        expect(env.result.installed.counts.hookCount).toBeGreaterThan(0);
      } finally {
        await cleanup();
      }
    });

    it("supports --force overwrite on existing target", async () => {
      const cleanup = await ensurePiDetectable();
      try {
        const seedSrc = join(seedAgentsDir(), "cleo-dev.cant");
        resetDetectionCache();
        await runPi(["pi", "cant", "install", seedSrc, "--scope", "user"]);
        // Re-install without force → should fail with E_CONFLICT_VERSION.
        const out1 = await runPi(["pi", "cant", "install", seedSrc, "--scope", "user"]);
        expect(out1.exitCode).toBe(1);
        const errEnv = parseEnvelope(out1.stderr) as {
          success: boolean;
          error: { code: string };
        };
        expect(errEnv.success).toBe(false);
        expect(errEnv.error.code).toBe("E_CONFLICT_VERSION");
        // Re-install with --force → should succeed.
        const out2 = await runPi([
          "pi",
          "cant",
          "install",
          seedSrc,
          "--scope",
          "user",
          "--force",
        ]);
        const okEnv = parseEnvelope(out2.stdout) as { success: boolean };
        expect(okEnv.success).toBe(true);
      } finally {
        await cleanup();
      }
    });

    it("rejects an invalid .cant file with E_VALIDATION_SCHEMA", async () => {
      const cleanup = await ensurePiDetectable();
      try {
        const badSrc = join(uniqueRoot, "broken.cant");
        await writeFile(badSrc, "this is not valid cant syntax\n: nope\n", "utf8");
        resetDetectionCache();
        const out = await runPi(["pi", "cant", "install", badSrc, "--scope", "user"]);
        expect(out.exitCode).toBe(1);
        const err = parseEnvelope(out.stderr) as { error: { code: string } };
        expect(err.error.code).toBe("E_VALIDATION_SCHEMA");
      } finally {
        await cleanup();
      }
    });

    it("rejects a non-existent local source with E_NOT_FOUND_RESOURCE", async () => {
      const cleanup = await ensurePiDetectable();
      try {
        resetDetectionCache();
        const out = await runPi([
          "pi",
          "cant",
          "install",
          "/definitely/not/here.cant",
          "--scope",
          "user",
        ]);
        expect(out.exitCode).toBe(1);
        const err = parseEnvelope(out.stderr) as { error: { code: string } };
        expect(err.error.code).toBe("E_NOT_FOUND_RESOURCE");
      } finally {
        await cleanup();
      }
    });

    it("rejects a non-.cant source extension with E_VALIDATION_SCHEMA", async () => {
      const cleanup = await ensurePiDetectable();
      try {
        const badExt = join(uniqueRoot, "wrong.txt");
        await writeFile(badExt, "agent foo:\n", "utf8");
        resetDetectionCache();
        const out = await runPi(["pi", "cant", "install", badExt, "--scope", "user"]);
        expect(out.exitCode).toBe(1);
        const err = parseEnvelope(out.stderr) as { error: { code: string } };
        expect(err.error.code).toBe("E_VALIDATION_SCHEMA");
      } finally {
        await cleanup();
      }
    });

    it("rejects an unknown --scope value", async () => {
      const cleanup = await ensurePiDetectable();
      try {
        const seedSrc = join(seedAgentsDir(), "cleo-dev.cant");
        resetDetectionCache();
        const out = await runPi([
          "pi",
          "cant",
          "install",
          seedSrc,
          "--scope",
          "nonsense",
        ]);
        expect(out.exitCode).toBe(1);
        const err = parseEnvelope(out.stderr) as { error: { code: string } };
        expect(err.error.code).toBe("E_VALIDATION_SCHEMA");
      } finally {
        await cleanup();
      }
    });

    it("supports --name override", async () => {
      const cleanup = await ensurePiDetectable();
      try {
        const seedSrc = join(seedAgentsDir(), "cleo-dev.cant");
        resetDetectionCache();
        const out = await runPi([
          "pi",
          "cant",
          "install",
          seedSrc,
          "--scope",
          "user",
          "--name",
          "custom-name",
        ]);
        const env = parseEnvelope(out.stdout) as {
          result: { installed: { name: string; targetPath: string } };
        };
        expect(env.result.installed.name).toBe("custom-name");
        expect(env.result.installed.targetPath).toMatch(/custom-name\.cant$/);
      } finally {
        await cleanup();
      }
    });
  });

  describe("remove", () => {
    it("deletes an installed profile and reports removed=true", async () => {
      const cleanup = await ensurePiDetectable();
      try {
        const seedSrc = join(seedAgentsDir(), "cleo-dev.cant");
        resetDetectionCache();
        await runPi(["pi", "cant", "install", seedSrc, "--scope", "user"]);
        const out = await runPi(["pi", "cant", "remove", "cleo-dev", "--scope", "user"]);
        const env = parseEnvelope(out.stdout) as {
          success: boolean;
          result: { removed: boolean; name: string; tier: string };
        };
        expect(env.success).toBe(true);
        expect(env.result.removed).toBe(true);
        expect(env.result.name).toBe("cleo-dev");
        expect(env.result.tier).toBe("user");
      } finally {
        await cleanup();
      }
    });

    it("reports removed=false when the target is missing (idempotent)", async () => {
      const cleanup = await ensurePiDetectable();
      try {
        resetDetectionCache();
        const out = await runPi(["pi", "cant", "remove", "ghost", "--scope", "user"]);
        const env = parseEnvelope(out.stdout) as {
          success: boolean;
          result: { removed: boolean };
        };
        expect(env.success).toBe(true);
        expect(env.result.removed).toBe(false);
      } finally {
        await cleanup();
      }
    });
  });

  describe("validate", () => {
    it("returns valid=true with counts for a known-good seed-agent file", async () => {
      const cleanup = await ensurePiDetectable();
      try {
        const seedSrc = join(seedAgentsDir(), "cleo-dev.cant");
        resetDetectionCache();
        const out = await runPi(["pi", "cant", "validate", seedSrc]);
        const env = parseEnvelope(out.stdout) as {
          success: boolean;
          result: {
            valid: boolean;
            counts: { agentCount: number };
            errors: unknown[];
          };
        };
        expect(env.success).toBe(true);
        expect(env.result.valid).toBe(true);
        expect(env.result.counts.agentCount).toBe(1);
      } finally {
        await cleanup();
      }
    });

    it("returns exit code 1 with diagnostics for an invalid file", async () => {
      const cleanup = await ensurePiDetectable();
      try {
        const badSrc = join(uniqueRoot, "broken.cant");
        await writeFile(badSrc, "this is not valid cant syntax\n: nope\n", "utf8");
        resetDetectionCache();
        const out = await runPi(["pi", "cant", "validate", badSrc]);
        expect(out.exitCode).toBe(1);
        const err = parseEnvelope(out.stderr) as {
          success: boolean;
          error: {
            code: string;
            details: {
              payload: {
                valid: boolean;
                errors: Array<{ ruleId: string; severity: string }>;
              };
            };
          };
        };
        expect(err.success).toBe(false);
        expect(err.error.code).toBe("E_VALIDATION_SCHEMA");
        expect(err.error.details.payload.valid).toBe(false);
        expect(err.error.details.payload.errors.length).toBeGreaterThan(0);
        expect(err.error.details.payload.errors[0]?.ruleId).toBe("PARSE");
      } finally {
        await cleanup();
      }
    });

    it("returns E_NOT_FOUND_RESOURCE for a missing path", async () => {
      const cleanup = await ensurePiDetectable();
      try {
        resetDetectionCache();
        const out = await runPi(["pi", "cant", "validate", "/missing/path.cant"]);
        expect(out.exitCode).toBe(1);
        const err = parseEnvelope(out.stderr) as { error: { code: string } };
        expect(err.error.code).toBe("E_NOT_FOUND_RESOURCE");
      } finally {
        await cleanup();
      }
    });

    it("validates a file successfully when not installed (pure helper)", async () => {
      const cleanup = await ensurePiDetectable();
      try {
        // Pick a different seed-agent and validate it without installing.
        const seedSrc = join(seedAgentsDir(), "cleo-historian.cant");
        resetDetectionCache();
        const out = await runPi(["pi", "cant", "validate", seedSrc]);
        const env = parseEnvelope(out.stdout) as {
          result: { valid: boolean; counts: { agentCount: number; hookCount: number } };
        };
        expect(env.result.valid).toBe(true);
        expect(env.result.counts.agentCount).toBeGreaterThanOrEqual(1);
      } finally {
        await cleanup();
      }
    });
  });

  describe("Pi-absent fallback", () => {
    it("returns E_NOT_FOUND_RESOURCE when Pi is not installed", async () => {
      // No ensurePiDetectable here — Pi is genuinely absent.
      // First we have to remove any existing ~/.pi/agent that might already
      // exist on this dev machine, then restore it. To stay safe in shared
      // environments we instead skip the test if Pi happens to be installed.
      const fs = await import("node:fs");
      const piHome = join(homedir(), ".pi", "agent");
      if (fs.existsSync(piHome)) {
        // Real Pi install present — skip this scenario rather than mutating
        // the developer's machine.
        return;
      }
      resetDetectionCache();
      const out = await runPi([
        "pi",
        "cant",
        "list",
        "--project-dir",
        projectRoot,
      ]);
      expect(out.exitCode).toBe(1);
      const err = parseEnvelope(out.stderr) as { error: { code: string } };
      expect(err.error.code).toBe("E_NOT_FOUND_RESOURCE");
    });
  });
});
