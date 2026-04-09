/**
 * CleoOS CANT bridge — Wave 2 Pi extension.
 *
 * CANONICAL LOCATION: `packages/cleo-os/extensions/cleo-cant-bridge.ts`
 *
 * This file was copied from
 * `packages/cleo/templates/cleoos-hub/pi-extensions/cleo-cant-bridge.ts`
 * (T393). The template path is kept for reference but this file is the
 * authoritative source. A future cleanup wave (post-T381) should remove
 * the template copy once all consumers have migrated.
 *
 * Installed to: $XDG_DATA_HOME/cleo/extensions/cleo-cant-bridge.js
 * Loaded by:    Pi via `--extension <path>` injected by CleoOS cli.ts
 *
 * This bridge discovers `.cant` files in the project's `.cleo/cant/`
 * directory at session start, compiles them via `@cleocode/cant`'s
 * `compileBundle()`, and appends the compiled declarations to Pi's
 * system prompt on `before_agent_start`. This gives the LLM awareness
 * of all declared agents, teams, and tools without hand-authored
 * protocol text.
 *
 * MVP scope (Wave 2):
 *   - Scans project tier only: `<cwd>/.cleo/cant/` (recursive)
 *   - Three-tier resolution (global, user, project) is Wave 5
 *   - Prompt strategy: APPEND (per ULTRAPLAN L6, never replace)
 *
 * Requirements:
 *   - `@cleocode/cant` must be installed (provides `compileBundle`)
 *   - Pi coding agent runtime (`@mariozechner/pi-coding-agent`)
 *
 * Guardrails:
 *   - Best-effort: if `@cleocode/cant` is not installed or `.cleo/cant`
 *     does not exist, the bridge is a no-op. NEVER crash Pi.
 *   - NO top-level await; all work happens inside event handlers.
 *   - APPEND to system prompt, never replace.
 *
 * @packageDocumentation
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

/** Cached system prompt addendum from the last session_start compilation. */
let bundlePrompt: string | null = null;

/** Diagnostic summary cached for /cant:bundle-info. */
let lastDiagnosticSummary: string | null = null;

/**
 * Recursively discover `.cant` files in a directory.
 *
 * @param dir - The directory to scan recursively.
 * @returns An array of absolute paths to `.cant` files found.
 */
function discoverCantFiles(dir: string): string[] {
  try {
    const entries = readdirSync(dir, { recursive: true, withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".cant")) {
        // Node 24+ recursive readdir returns entries with parentPath
        const parent = (entry as unknown as { parentPath?: string }).parentPath ?? dir;
        files.push(join(parent, entry.name));
      }
    }
    return files;
  } catch {
    return [];
  }
}

/**
 * Pi extension factory for the CleoOS CANT bridge.
 *
 * Registers event handlers for `session_start` (compile `.cant` files)
 * and `before_agent_start` (append compiled bundle to system prompt).
 * Also registers a `/cant:bundle-info` command for introspection.
 *
 * @param pi - The Pi extension API instance.
 */
export default function (pi: ExtensionAPI): void {
  // session_start: discover and compile .cant files from the project tier
  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    bundlePrompt = null;
    lastDiagnosticSummary = null;

    try {
      const cantDir = join(ctx.cwd, ".cleo", "cant");
      if (!existsSync(cantDir)) return;

      const files = discoverCantFiles(cantDir);
      if (files.length === 0) return;

      // Dynamic import: @cleocode/cant may not be installed in all environments
      const cantModule = await import("@cleocode/cant") as {
        compileBundle: (paths: string[]) => Promise<{
          renderSystemPrompt: () => string;
          diagnostics: Array<{ severity: string; message: string; sourcePath: string }>;
          agents: Array<{ name: string }>;
          teams: Array<{ name: string }>;
          tools: Array<{ name: string }>;
          valid: boolean;
        }>;
      };

      const bundle = await cantModule.compileBundle(files);
      const prompt = bundle.renderSystemPrompt();

      if (prompt.length > 0) {
        bundlePrompt = prompt;
      }

      // Build diagnostic summary
      const errorDiags = bundle.diagnostics.filter((d) => d.severity === "error");
      const warnDiags = bundle.diagnostics.filter((d) => d.severity === "warning");
      lastDiagnosticSummary = [
        `Files: ${files.length}`,
        `Agents: ${bundle.agents.length}`,
        `Teams: ${bundle.teams.length}`,
        `Tools: ${bundle.tools.length}`,
        `Valid: ${bundle.valid}`,
        `Errors: ${errorDiags.length}`,
        `Warnings: ${warnDiags.length}`,
      ].join(", ");

      // Notify on errors
      if (errorDiags.length > 0 && ctx.hasUI) {
        ctx.ui.notify(
          `CleoOS CANT bridge: ${errorDiags.length} validation error(s) in .cleo/cant/`,
          "warning",
        );
      }

      // Success notification
      if (ctx.hasUI) {
        ctx.ui.setStatus(
          "cleo-cant-bridge",
          `CANT: ${bundle.agents.length} agent(s), ${files.length} file(s)`,
        );
      }
    } catch (err: unknown) {
      // Best-effort: never crash Pi
      const message = err instanceof Error ? err.message : String(err);
      if (ctx.hasUI) {
        ctx.ui.notify(`CleoOS CANT bridge: ${message}`, "warning");
      }
    }
  });

  // before_agent_start: APPEND compiled bundle prompt to system prompt
  pi.on("before_agent_start", async (event: { systemPrompt?: string }) => {
    if (!bundlePrompt) return {};

    // APPEND — never replace (per ULTRAPLAN L6)
    const existingPrompt = event.systemPrompt ?? "";
    return {
      systemPrompt: existingPrompt + "\n\n" + bundlePrompt,
    };
  });

  // /cant:bundle-info — introspection command
  pi.registerCommand("cant:bundle-info", {
    description: "Show the state of the CANT bundle compiled at session start",
    handler: async (_args: string, ctx: ExtensionContext & { hasUI: boolean; signal?: AbortSignal }) => {
      const content = lastDiagnosticSummary
        ? `CANT Bundle: ${lastDiagnosticSummary}`
        : "CANT Bundle: no .cant files compiled (check .cleo/cant/ directory)";
      pi.sendMessage(
        { customType: "cleo-cant-bundle-info", content, display: true },
        { triggerTurn: false },
      );
      if (ctx.hasUI) {
        ctx.ui.notify(
          lastDiagnosticSummary ? "CANT bundle loaded" : "No CANT bundle",
          "info",
        );
      }
    },
  });

  // session_shutdown: clear cached state
  pi.on("session_shutdown", async () => {
    bundlePrompt = null;
    lastDiagnosticSummary = null;
  });
}
