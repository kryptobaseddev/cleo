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
 * Wave 2 scope:
 *   - Scans project tier only: `<cwd>/.cleo/cant/` (recursive)
 *   - Three-tier resolution (global, user, project) is Wave 5
 *   - Prompt strategy: APPEND (per ULTRAPLAN L6, never replace)
 *
 * Wave 8 additions (T420):
 *   - validate-on-load mental-model injection
 *   - When the spawned agent's CANT definition has a `mentalModel` block,
 *     fetches prior mental-model observations via memoryFind and injects
 *     them into the Pi system prompt with VALIDATE_ON_LOAD_PREAMBLE.
 *   - Exports `VALIDATE_ON_LOAD_PREAMBLE` and `buildMentalModelInjection`
 *     for testability (T421).
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

// ============================================================================
// T420: validate-on-load constants and pure helpers
// ============================================================================

/**
 * Preamble text injected into the Pi system prompt when an agent has a
 * `mental_model:` CANT block. The agent MUST re-evaluate each observation
 * against the current project state before acting.
 *
 * Exported so empirical tests (T421) can assert on its presence.
 */
export const VALIDATE_ON_LOAD_PREAMBLE =
  "===== MENTAL MODEL (validate-on-load) =====\n" +
  "These are your prior observations, patterns, and learnings for this project.\n" +
  "Before acting, you MUST re-evaluate each entry against current project state.\n" +
  "If an entry is stale, note it and proceed with fresh understanding.";

/** Minimal observation shape returned by memoryFind / searchBrainCompact. */
export interface MentalModelObservation {
  id: string;
  type: string;
  title: string;
  date?: string;
}

/**
 * Build the validate-on-load mental-model injection string.
 *
 * Pure function — no I/O, safe to call in tests without a real DB.
 *
 * @param agentName - Name of the spawned agent (used in the header line).
 * @param observations - Prior mental-model observations to list.
 * @returns System-prompt block containing the preamble and numbered observations,
 *          or an empty string when `observations` is empty.
 */
export function buildMentalModelInjection(
  agentName: string,
  observations: MentalModelObservation[],
): string {
  if (observations.length === 0) return "";

  const lines: string[] = [
    "",
    `// Agent: ${agentName}`,
    VALIDATE_ON_LOAD_PREAMBLE,
    "",
  ];

  for (let i = 0; i < observations.length; i++) {
    const obs = observations[i];
    const datePart = obs.date ? ` [${obs.date}]` : "";
    lines.push(`${i + 1}. [${obs.id}] (${obs.type})${datePart}: ${obs.title}`);
  }

  lines.push("===== END MENTAL MODEL =====");

  return lines.join("\n");
}

// ============================================================================
// Internal state
// ============================================================================

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

// ============================================================================
// T420: mental-model injection helper (async, calls memoryFind)
// ============================================================================

/**
 * Fetch prior mental-model observations for an agent and build the
 * validate-on-load injection block.
 *
 * Called in `before_agent_start` when the agent has a `mentalModel` CANT block.
 * Best-effort: returns empty string on any failure so Pi is never blocked.
 *
 * @param agentName - Name of the spawned agent.
 * @param projectRoot - Project root directory for brain.db access.
 * @returns The validate-on-load system-prompt block, or "" on failure/empty.
 */
async function fetchMentalModelInjection(
  agentName: string,
  projectRoot: string,
): Promise<string> {
  try {
    // Lazy import: @cleocode/core may not be present in all environments.
    // memoryFind is the engine-compat wrapper (T418) that accepts `agent`.
    const coreModule = (await import("@cleocode/core")) as {
      memoryFind?: (
        params: {
          query: string;
          agent?: string;
          limit?: number;
          tables?: string[];
        },
        projectRoot?: string,
      ) => Promise<{
        success: boolean;
        data?: {
          results?: MentalModelObservation[];
        };
      }>;
    };

    if (typeof coreModule.memoryFind !== "function") return "";

    // Fetch the 10 most recent mental-model observations for this agent.
    // Use tables filter to avoid decisions/patterns/learnings which are
    // not agent-scoped in the current schema.
    const result = await coreModule.memoryFind(
      {
        query: agentName,
        agent: agentName,
        limit: 10,
        tables: ["observations"],
      },
      projectRoot,
    );

    if (!result.success || !result.data?.results?.length) return "";

    return buildMentalModelInjection(agentName, result.data.results);
  } catch {
    // Best-effort — never crash Pi
    return "";
  }
}

// ============================================================================
// Pi extension factory
// ============================================================================

/**
 * Pi extension factory for the CleoOS CANT bridge.
 *
 * Registers event handlers for `session_start` (compile `.cant` files)
 * and `before_agent_start` (append compiled bundle + mental-model injection
 * to system prompt). Also registers a `/cant:bundle-info` command for
 * introspection.
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
      const cantModule = (await import("@cleocode/cant")) as {
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

  // before_agent_start: APPEND compiled bundle prompt + mental-model injection
  // to system prompt (per ULTRAPLAN L6, never replace)
  pi.on(
    "before_agent_start",
    async (
      event: {
        systemPrompt?: string;
        agentName?: string;
        /** T420: agent CANT definition, if resolved by Pi runtime. */
        agentDef?: {
          /** mentalModel block presence signals validate-on-load injection. */
          mentalModel?: unknown;
        };
        /** Project root injected by Pi when available. */
        projectRoot?: string;
      },
      ctx?: ExtensionContext,
    ) => {
      const existingPrompt = event.systemPrompt ?? "";
      let appendix = "";

      // APPEND CANT bundle prompt
      if (bundlePrompt) {
        appendix += "\n\n" + bundlePrompt;
      }

      // T420: validate-on-load mental-model injection.
      // Inject when the agent has a `mentalModel` CANT block.
      const agentName = event.agentName;
      const hasMentalModel =
        agentName !== undefined &&
        agentName !== "" &&
        event.agentDef?.mentalModel !== undefined;

      if (hasMentalModel && agentName) {
        // Resolve project root: prefer explicit field, fall back to ctx.cwd
        const projectRoot = event.projectRoot ?? ctx?.cwd ?? "";
        if (projectRoot) {
          const mentalModelBlock = await fetchMentalModelInjection(agentName, projectRoot);
          if (mentalModelBlock) {
            appendix += mentalModelBlock;
          }
        }
      }

      if (!appendix) return {};

      return {
        systemPrompt: existingPrompt + appendix,
      };
    },
  );

  // /cant:bundle-info — introspection command
  pi.registerCommand("cant:bundle-info", {
    description: "Show the state of the CANT bundle compiled at session start",
    handler: async (
      _args: string,
      ctx: ExtensionContext & { hasUI: boolean; signal?: AbortSignal },
    ) => {
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
