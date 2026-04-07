/**
 * Integration-style tests for the `caamp pi <verb>` commands.
 *
 * @remarks
 * These tests construct Commander programs with just the `pi`
 * command group attached and drive the verbs through `parseAsync`,
 * intercepting `process.exit`, `console.log`, and `console.error` so
 * that each verb's LAFS envelope output is asserted against in
 * isolation. This exercises the command-layer code paths that the
 * PiHarness unit tests cannot reach (option parsing, action bodies,
 * LAFS envelope wiring, Pi-absent fallback, etc.).
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
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
 * swap out stdout/stderr/process.exit with capture hooks, run the
 * supplied argv through `parseAsync`, and return the captured output.
 */
async function runPi(argv: string[]): Promise<CapturedOutput> {
  const captured: CapturedOutput = { stdout: [], stderr: [], exitCode: null };
  const logSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
    captured.stdout.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  });
  const errSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
    captured.stderr.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
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
    // Swallow any exit or Commander error; parseAsync throws when the
    // exit override fires or when our mocked process.exit throws.
    const message = err instanceof Error ? err.message : String(err);
    if (!message.startsWith("__caamp_test_exit_")) {
      // Non-exit error — forward to stderr for the assertion.
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
let uniqueRoot: string;
let savedPiDir: string | undefined;
let savedCleoHome: string | undefined;

/**
 * Create `~/.pi/agent` if missing (so Pi's directory detection passes)
 * and return a cleanup that removes it only when it was created here
 * and only when it is still empty — never nukes a real Pi install.
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
  const unique = `caamp-pi-cmd-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  uniqueRoot = join(tmpdir(), unique);
  piRoot = join(uniqueRoot, "pi-agent");
  cleoHomeRoot = join(uniqueRoot, "cleo-home");
  await mkdir(piRoot, { recursive: true });
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
  await rm(uniqueRoot, { recursive: true, force: true }).catch(() => {});
  resetRegistry();
  resetDetectionCache();
});

describe("caamp pi extensions commands", () => {
  it("list emits an empty array when no extensions exist", async () => {
    const cleanup = await ensurePiDetectable();
    try {
      resetDetectionCache();
      const out = await runPi(["pi", "extensions", "list"]);
      const envelope = parseEnvelope(out.stdout);
      expect(envelope).not.toBeNull();
      const env = envelope as { success: boolean; result: { count: number; extensions: unknown[] } };
      expect(env.success).toBe(true);
      expect(env.result.count).toBe(0);
      expect(env.result.extensions).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it("install copies a local .ts file into the user tier", async () => {
    const cleanup = await ensurePiDetectable();
    try {
      const src = join(uniqueRoot, "my-ext.ts");
      await writeFile(src, "export default function (_pi: unknown) {}\n", "utf8");
      resetDetectionCache();
      const out = await runPi([
        "pi",
        "extensions",
        "install",
        src,
        "--scope",
        "user",
      ]);
      const envelope = parseEnvelope(out.stdout);
      expect(envelope).not.toBeNull();
      const env = envelope as {
        success: boolean;
        result: { installed: { name: string; tier: string; targetPath: string } };
      };
      expect(env.success).toBe(true);
      expect(env.result.installed.tier).toBe("user");
      expect(env.result.installed.name).toBe("my-ext");
      expect(existsSync(env.result.installed.targetPath)).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("install supports --force overwrite on existing target", async () => {
    const cleanup = await ensurePiDetectable();
    try {
      const src = join(uniqueRoot, "force-ext.ts");
      await writeFile(src, "export default function () {}\n", "utf8");
      resetDetectionCache();
      await runPi(["pi", "extensions", "install", src, "--scope", "user"]);
      // Re-install without force → should error (non-zero exit).
      const out1 = await runPi(["pi", "extensions", "install", src, "--scope", "user"]);
      expect(out1.exitCode).toBe(1);
      const errEnv = parseEnvelope(out1.stderr);
      const err = errEnv as { success: boolean; error: { code: string } };
      expect(err.success).toBe(false);
      // Re-install WITH force → should succeed.
      const out2 = await runPi([
        "pi",
        "extensions",
        "install",
        src,
        "--scope",
        "user",
        "--force",
      ]);
      const okEnv = parseEnvelope(out2.stdout);
      expect((okEnv as { success: boolean }).success).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("install rejects an unknown --scope value", async () => {
    const cleanup = await ensurePiDetectable();
    try {
      const src = join(uniqueRoot, "bad-scope.ts");
      await writeFile(src, "export default function () {}\n", "utf8");
      resetDetectionCache();
      const out = await runPi([
        "pi",
        "extensions",
        "install",
        src,
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

  it("install rejects a non-existent local source", async () => {
    const cleanup = await ensurePiDetectable();
    try {
      resetDetectionCache();
      const out = await runPi([
        "pi",
        "extensions",
        "install",
        "/definitely/not/here.ts",
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

  it("remove deletes an installed extension and reports removed=true", async () => {
    const cleanup = await ensurePiDetectable();
    try {
      const src = join(uniqueRoot, "rm-ext.ts");
      await writeFile(src, "export default function () {}\n", "utf8");
      resetDetectionCache();
      await runPi(["pi", "extensions", "install", src, "--scope", "user"]);
      const out = await runPi(["pi", "extensions", "remove", "rm-ext", "--scope", "user"]);
      const env = parseEnvelope(out.stdout) as {
        success: boolean;
        result: { removed: boolean; name: string };
      };
      expect(env.success).toBe(true);
      expect(env.result.removed).toBe(true);
      expect(env.result.name).toBe("rm-ext");
    } finally {
      await cleanup();
    }
  });

  it("remove reports removed=false when the target is missing", async () => {
    const cleanup = await ensurePiDetectable();
    try {
      resetDetectionCache();
      const out = await runPi(["pi", "extensions", "remove", "ghost", "--scope", "user"]);
      const env = parseEnvelope(out.stdout) as { result: { removed: boolean } };
      expect(env.result.removed).toBe(false);
    } finally {
      await cleanup();
    }
  });
});

describe("caamp pi sessions commands", () => {
  async function seedSession(id: string): Promise<string> {
    const sessionsDir = join(piRoot, "sessions");
    await mkdir(sessionsDir, { recursive: true });
    const filePath = join(sessionsDir, `${id}.jsonl`);
    const header = JSON.stringify({
      type: "session",
      version: 3,
      id,
      timestamp: "2026-04-07T00:00:00.000Z",
      cwd: "/home/alice/work",
    });
    const body = [
      header,
      JSON.stringify({ type: "message", role: "user", content: "hi" }),
      JSON.stringify({ type: "message", role: "assistant", content: "hello" }),
      "",
    ].join("\n");
    await writeFile(filePath, body, "utf8");
    return filePath;
  }

  it("list emits sorted session summaries", async () => {
    const cleanup = await ensurePiDetectable();
    try {
      await seedSession("sess-a");
      await seedSession("sess-b");
      resetDetectionCache();
      const out = await runPi(["pi", "sessions", "list"]);
      const env = parseEnvelope(out.stdout) as {
        success: boolean;
        result: { count: number; sessions: Array<{ id: string }> };
      };
      expect(env.success).toBe(true);
      expect(env.result.count).toBe(2);
      expect(env.result.sessions.map((s) => s.id).sort()).toEqual(["sess-a", "sess-b"]);
    } finally {
      await cleanup();
    }
  });

  it("show returns full entries for a known session", async () => {
    const cleanup = await ensurePiDetectable();
    try {
      await seedSession("sess-show");
      resetDetectionCache();
      const out = await runPi(["pi", "sessions", "show", "sess-show"]);
      const env = parseEnvelope(out.stdout) as {
        success: boolean;
        result: { entries: string[]; entryCount: number };
      };
      expect(env.success).toBe(true);
      expect(env.result.entryCount).toBe(2);
      expect(env.result.entries.length).toBe(2);
    } finally {
      await cleanup();
    }
  });

  it("show errors with E_NOT_FOUND for unknown ids", async () => {
    const cleanup = await ensurePiDetectable();
    try {
      resetDetectionCache();
      const out = await runPi(["pi", "sessions", "show", "ghost"]);
      expect(out.exitCode).toBe(1);
      expect(out.stderr.join("\n")).toMatch(/ghost/);
    } finally {
      await cleanup();
    }
  });

  it("export --jsonl writes the raw body to an output file", async () => {
    const cleanup = await ensurePiDetectable();
    try {
      await seedSession("sess-export");
      const outPath = join(uniqueRoot, "out.jsonl");
      resetDetectionCache();
      const out = await runPi([
        "pi",
        "sessions",
        "export",
        "sess-export",
        "--jsonl",
        "--output",
        outPath,
      ]);
      const env = parseEnvelope(out.stdout) as {
        success: boolean;
        result: { format: string; entriesEmitted: number };
      };
      expect(env.success).toBe(true);
      expect(env.result.format).toBe("jsonl");
      expect(env.result.entriesEmitted).toBeGreaterThan(0);
      expect(existsSync(outPath)).toBe(true);
      const contents = await readFile(outPath, "utf8");
      expect(contents).toContain("sess-export");
    } finally {
      await cleanup();
    }
  });

  it("export --md writes a Markdown transcription to an output file", async () => {
    const cleanup = await ensurePiDetectable();
    try {
      await seedSession("sess-md");
      const outPath = join(uniqueRoot, "out.md");
      resetDetectionCache();
      const out = await runPi([
        "pi",
        "sessions",
        "export",
        "sess-md",
        "--md",
        "--output",
        outPath,
      ]);
      const env = parseEnvelope(out.stdout) as { result: { format: string } };
      expect(env.result.format).toBe("md");
      const contents = await readFile(outPath, "utf8");
      expect(contents).toContain("# Session sess-md");
      expect(contents).toContain("## User");
      expect(contents).toContain("## Assistant");
    } finally {
      await cleanup();
    }
  });

  it("export rejects --jsonl and --md simultaneously", async () => {
    const cleanup = await ensurePiDetectable();
    try {
      await seedSession("sess-both");
      resetDetectionCache();
      const out = await runPi([
        "pi",
        "sessions",
        "export",
        "sess-both",
        "--jsonl",
        "--md",
      ]);
      expect(out.exitCode).toBe(1);
      const err = parseEnvelope(out.stderr) as { error: { code: string } };
      expect(err.error.code).toBe("E_VALIDATION_SCHEMA");
    } finally {
      await cleanup();
    }
  });

  it("export errors with E_NOT_FOUND for unknown ids", async () => {
    const cleanup = await ensurePiDetectable();
    try {
      resetDetectionCache();
      const out = await runPi(["pi", "sessions", "export", "ghost", "--jsonl"]);
      expect(out.exitCode).toBe(1);
      const err = parseEnvelope(out.stderr) as { error: { code: string } };
      expect(err.error.code).toBe("E_NOT_FOUND_RESOURCE");
    } finally {
      await cleanup();
    }
  });
});

describe("caamp pi models commands", () => {
  it("list emits a union of custom and enabled models", async () => {
    const cleanup = await ensurePiDetectable();
    try {
      // Seed models.json + settings.json directly so we don't depend
      // on the add/enable verbs.
      await writeFile(
        join(piRoot, "models.json"),
        JSON.stringify({
          providers: {
            anthropic: {
              models: [{ id: "claude-opus-4", name: "Opus 4" }],
            },
          },
        }),
        "utf8",
      );
      await writeFile(
        join(piRoot, "settings.json"),
        JSON.stringify({
          enabledModels: ["anthropic:claude-opus-4"],
          defaultProvider: "anthropic",
          defaultModel: "claude-opus-4",
        }),
        "utf8",
      );
      resetDetectionCache();
      const out = await runPi(["pi", "models", "list"]);
      const env = parseEnvelope(out.stdout) as {
        success: boolean;
        result: {
          count: number;
          activeCount: number;
          default: { id: string } | null;
          models: Array<{ id: string; enabled: boolean; isDefault: boolean }>;
        };
      };
      expect(env.success).toBe(true);
      expect(env.result.count).toBe(1);
      expect(env.result.activeCount).toBe(1);
      expect(env.result.default?.id).toBe("claude-opus-4");
      expect(env.result.models[0]?.isDefault).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("add writes a custom model definition to models.json", async () => {
    const cleanup = await ensurePiDetectable();
    try {
      resetDetectionCache();
      const out = await runPi([
        "pi",
        "models",
        "add",
        "openai:gpt-5",
        "--display-name",
        "GPT-5",
        "--context-window",
        "200000",
        "--max-tokens",
        "8192",
        "--reasoning",
      ]);
      const env = parseEnvelope(out.stdout) as {
        success: boolean;
        result: { added: { provider: string; id: string }; replaced: boolean };
      };
      expect(env.success).toBe(true);
      expect(env.result.added.provider).toBe("openai");
      expect(env.result.added.id).toBe("gpt-5");
      expect(env.result.replaced).toBe(false);
      const modelsJson = JSON.parse(
        await readFile(join(piRoot, "models.json"), "utf8"),
      ) as { providers: Record<string, { models: Array<{ id: string; contextWindow: number }> }> };
      expect(modelsJson.providers["openai"]?.models[0]?.id).toBe("gpt-5");
      expect(modelsJson.providers["openai"]?.models[0]?.contextWindow).toBe(200000);
    } finally {
      await cleanup();
    }
  });

  it("add rejects a malformed --context-window value", async () => {
    const cleanup = await ensurePiDetectable();
    try {
      resetDetectionCache();
      const out = await runPi([
        "pi",
        "models",
        "add",
        "openai:bad",
        "--context-window",
        "not-a-number",
      ]);
      expect(out.exitCode).toBe(1);
      const err = parseEnvelope(out.stderr) as { error: { code: string } };
      expect(err.error.code).toBe("E_VALIDATION_SCHEMA");
    } finally {
      await cleanup();
    }
  });

  it("add rejects an invalid model specifier", async () => {
    const cleanup = await ensurePiDetectable();
    try {
      resetDetectionCache();
      const out = await runPi(["pi", "models", "add", "no-separator"]);
      expect(out.exitCode).toBe(1);
      const err = parseEnvelope(out.stderr) as { error: { code: string } };
      expect(err.error.code).toBe("E_VALIDATION_SCHEMA");
    } finally {
      await cleanup();
    }
  });

  it("remove returns removed=false when the provider is missing", async () => {
    const cleanup = await ensurePiDetectable();
    try {
      resetDetectionCache();
      const out = await runPi(["pi", "models", "remove", "noprov:nom"]);
      const env = parseEnvelope(out.stdout) as {
        result: { removed: boolean; reason: string };
      };
      expect(env.result.removed).toBe(false);
      expect(env.result.reason).toBe("provider-not-found");
    } finally {
      await cleanup();
    }
  });

  it("remove deletes a known model and collapses empty providers", async () => {
    const cleanup = await ensurePiDetectable();
    try {
      resetDetectionCache();
      await runPi(["pi", "models", "add", "acme:m1"]);
      const out = await runPi(["pi", "models", "remove", "acme:m1"]);
      const env = parseEnvelope(out.stdout) as {
        result: { removed: boolean };
      };
      expect(env.result.removed).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("remove returns removed=false when the model id is missing in a known provider", async () => {
    const cleanup = await ensurePiDetectable();
    try {
      resetDetectionCache();
      await runPi(["pi", "models", "add", "acme:keep"]);
      const out = await runPi(["pi", "models", "remove", "acme:ghost"]);
      const env = parseEnvelope(out.stdout) as {
        result: { removed: boolean; reason: string };
      };
      expect(env.result.removed).toBe(false);
      expect(env.result.reason).toBe("model-not-found");
    } finally {
      await cleanup();
    }
  });

  it("enable appends to settings.json:enabledModels", async () => {
    const cleanup = await ensurePiDetectable();
    try {
      resetDetectionCache();
      const out1 = await runPi(["pi", "models", "enable", "anthropic:claude-opus-4"]);
      const env1 = parseEnvelope(out1.stdout) as { result: { enabled: boolean } };
      expect(env1.result.enabled).toBe(true);
      // Second call → idempotent, returns enabled=false with reason.
      const out2 = await runPi(["pi", "models", "enable", "anthropic:claude-opus-4"]);
      const env2 = parseEnvelope(out2.stdout) as {
        result: { enabled: boolean; reason: string };
      };
      expect(env2.result.enabled).toBe(false);
      expect(env2.result.reason).toBe("already-enabled");
    } finally {
      await cleanup();
    }
  });

  it("disable removes from settings.json:enabledModels", async () => {
    const cleanup = await ensurePiDetectable();
    try {
      resetDetectionCache();
      await runPi(["pi", "models", "enable", "anthropic:claude-opus-4"]);
      const out = await runPi(["pi", "models", "disable", "anthropic:claude-opus-4"]);
      const env = parseEnvelope(out.stdout) as { result: { disabled: boolean } };
      expect(env.result.disabled).toBe(true);
      // Idempotent: removing an unknown spec returns disabled=false.
      const out2 = await runPi(["pi", "models", "disable", "anthropic:claude-opus-4"]);
      const env2 = parseEnvelope(out2.stdout) as {
        result: { disabled: boolean; reason: string };
      };
      expect(env2.result.disabled).toBe(false);
      expect(env2.result.reason).toBe("not-enabled");
    } finally {
      await cleanup();
    }
  });

  it("default writes defaultProvider + defaultModel to settings.json", async () => {
    const cleanup = await ensurePiDetectable();
    try {
      resetDetectionCache();
      const out = await runPi([
        "pi",
        "models",
        "default",
        "anthropic:claude-sonnet-4",
      ]);
      const env = parseEnvelope(out.stdout) as {
        success: boolean;
        result: { set: boolean; provider: string; id: string; knownInModelsJson: boolean };
      };
      expect(env.success).toBe(true);
      expect(env.result.set).toBe(true);
      expect(env.result.provider).toBe("anthropic");
      expect(env.result.id).toBe("claude-sonnet-4");
      expect(env.result.knownInModelsJson).toBe(false);
      const settings = JSON.parse(await readFile(join(piRoot, "settings.json"), "utf8")) as {
        defaultProvider: string;
        defaultModel: string;
      };
      expect(settings.defaultProvider).toBe("anthropic");
      expect(settings.defaultModel).toBe("claude-sonnet-4");
    } finally {
      await cleanup();
    }
  });
});

describe("caamp pi prompts commands", () => {
  async function writePromptSource(name = "demo"): Promise<string> {
    const dir = join(uniqueRoot, `prompt-${name}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "prompt.md"), `# ${name}\n`, "utf8");
    return dir;
  }

  it("list emits an empty array by default", async () => {
    const cleanup = await ensurePiDetectable();
    try {
      resetDetectionCache();
      const out = await runPi(["pi", "prompts", "list"]);
      const env = parseEnvelope(out.stdout) as {
        success: boolean;
        result: { count: number };
      };
      expect(env.success).toBe(true);
      expect(env.result.count).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it("install copies a prompt directory into the user tier", async () => {
    const cleanup = await ensurePiDetectable();
    try {
      const src = await writePromptSource();
      resetDetectionCache();
      const out = await runPi([
        "pi",
        "prompts",
        "install",
        src,
        "--scope",
        "user",
      ]);
      const env = parseEnvelope(out.stdout) as {
        success: boolean;
        result: { installed: { name: string; tier: string; targetPath: string } };
      };
      expect(env.success).toBe(true);
      expect(env.result.installed.tier).toBe("user");
      expect(existsSync(env.result.installed.targetPath)).toBe(true);
      expect(existsSync(join(env.result.installed.targetPath, "prompt.md"))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("install rejects a missing source directory", async () => {
    const cleanup = await ensurePiDetectable();
    try {
      resetDetectionCache();
      const out = await runPi([
        "pi",
        "prompts",
        "install",
        join(uniqueRoot, "missing"),
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

  it("install rejects a source directory without prompt.md", async () => {
    const cleanup = await ensurePiDetectable();
    try {
      const src = join(uniqueRoot, "no-md");
      await mkdir(src, { recursive: true });
      resetDetectionCache();
      const out = await runPi([
        "pi",
        "prompts",
        "install",
        src,
        "--scope",
        "user",
      ]);
      expect(out.exitCode).toBe(1);
      const err = parseEnvelope(out.stderr) as { error: { code: string } };
      expect(err.error.code).toBe("E_VALIDATION_SCHEMA");
    } finally {
      await cleanup();
    }
  });

  it("remove deletes a prompt directory", async () => {
    const cleanup = await ensurePiDetectable();
    try {
      const src = await writePromptSource("to-delete");
      resetDetectionCache();
      await runPi([
        "pi",
        "prompts",
        "install",
        src,
        "--scope",
        "user",
        "--name",
        "to-delete",
      ]);
      const out = await runPi(["pi", "prompts", "remove", "to-delete", "--scope", "user"]);
      const env = parseEnvelope(out.stdout) as { result: { removed: boolean } };
      expect(env.result.removed).toBe(true);
    } finally {
      await cleanup();
    }
  });
});

describe("caamp pi themes commands", () => {
  async function writeThemeSource(name = "neon", ext = ".ts"): Promise<string> {
    const src = join(uniqueRoot, `${name}${ext}`);
    if (ext === ".json") {
      await writeFile(src, JSON.stringify({ name, vars: {}, colors: {} }), "utf8");
    } else {
      await writeFile(src, `export default { name: "${name}", vars: {}, colors: {} };\n`, "utf8");
    }
    return src;
  }

  it("list emits an empty array by default", async () => {
    const cleanup = await ensurePiDetectable();
    try {
      resetDetectionCache();
      const out = await runPi(["pi", "themes", "list"]);
      const env = parseEnvelope(out.stdout) as {
        success: boolean;
        result: { count: number };
      };
      expect(env.success).toBe(true);
      expect(env.result.count).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it("install copies a .ts theme into the user tier", async () => {
    const cleanup = await ensurePiDetectable();
    try {
      const src = await writeThemeSource("neon", ".ts");
      resetDetectionCache();
      const out = await runPi(["pi", "themes", "install", src, "--scope", "user"]);
      const env = parseEnvelope(out.stdout) as {
        success: boolean;
        result: { installed: { name: string; tier: string; targetPath: string } };
      };
      expect(env.success).toBe(true);
      expect(env.result.installed.tier).toBe("user");
      expect(env.result.installed.name).toBe("neon");
      expect(existsSync(env.result.installed.targetPath)).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("install copies a .json theme into the user tier", async () => {
    const cleanup = await ensurePiDetectable();
    try {
      const src = await writeThemeSource("solar", ".json");
      resetDetectionCache();
      const out = await runPi(["pi", "themes", "install", src, "--scope", "user"]);
      const env = parseEnvelope(out.stdout) as {
        result: { installed: { targetPath: string } };
      };
      expect(env.result.installed.targetPath.endsWith("solar.json")).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("install rejects a missing source file", async () => {
    const cleanup = await ensurePiDetectable();
    try {
      resetDetectionCache();
      const out = await runPi([
        "pi",
        "themes",
        "install",
        join(uniqueRoot, "missing.ts"),
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

  it("install rejects a non-file source (directory)", async () => {
    const cleanup = await ensurePiDetectable();
    try {
      const dir = join(uniqueRoot, "dir-theme");
      await mkdir(dir, { recursive: true });
      resetDetectionCache();
      const out = await runPi(["pi", "themes", "install", dir, "--scope", "user"]);
      expect(out.exitCode).toBe(1);
      const err = parseEnvelope(out.stderr) as { error: { code: string } };
      expect(err.error.code).toBe("E_VALIDATION_SCHEMA");
    } finally {
      await cleanup();
    }
  });

  it("remove deletes a theme file", async () => {
    const cleanup = await ensurePiDetectable();
    try {
      const src = await writeThemeSource("go-away");
      resetDetectionCache();
      await runPi(["pi", "themes", "install", src, "--scope", "user"]);
      const out = await runPi(["pi", "themes", "remove", "go-away", "--scope", "user"]);
      const env = parseEnvelope(out.stdout) as { result: { removed: boolean } };
      expect(env.result.removed).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
