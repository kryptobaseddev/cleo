/**
 * CleoOS CANT bridge — Wave 2 + Wave 5 Pi extension.
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
 * This bridge discovers `.cant` files across the 3-tier hierarchy at
 * session start, compiles them via `@cleocode/cant`'s `compileBundle()`,
 * and appends the compiled declarations to Pi's system prompt on
 * `before_agent_start`. This gives the LLM awareness of all declared
 * agents, teams, and tools without hand-authored protocol text.
 *
 * 3-tier resolution (T438, ULTRAPLAN Section 2.4):
 *   - Global:  `~/.local/share/cleo/cant/` (lowest precedence)
 *   - User:    `~/.config/cleo/cant/`
 *   - Project: `<cwd>/.cleo/cant/` (highest precedence)
 *   - Override semantics: project > user > global, matched by basename
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

import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
  accentPrimary,
  bold,
  textSecondary,
  BOX_HORIZONTAL,
  BOX_VERTICAL,
  BOX_TOP_LEFT,
  BOX_TOP_RIGHT,
  BOX_BOTTOM_LEFT,
  BOX_BOTTOM_RIGHT,
  BOX_LEFT_T,
  BOX_RIGHT_T,
  ICON_FORGE,
  ICON_DIAMOND,
  ICON_TRIANGLE,
  LINE_VERTICAL,
} from "./tui-theme.js";

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
// T424: Path-ACL helpers (pure, no external deps)
// ============================================================================

/**
 * Path-scoped file permissions shape expected in an agentDef at runtime.
 *
 * Mirrors `PathPermissions` from `@cleocode/cant` (T423).
 * Kept inline here to avoid a direct runtime import in the Pi extension context.
 *
 * @task T424
 */
interface AgentFilePermissions {
  /** Glob patterns the agent may write to. Empty array = no writes allowed. */
  write?: string[];
  /** Glob patterns the agent may read from. */
  read?: string[];
  /** Glob patterns the agent may delete. */
  delete?: string[];
}

/**
 * Convert a glob pattern to a RegExp for path matching.
 *
 * Supports the subset of glob syntax used in CANT file permissions:
 * - `**` matches any path segment sequence (including none)
 * - `*` matches any characters within a single path segment
 * - `?` matches a single character
 * - All other characters are treated as literals
 *
 * @param glob - The glob pattern string.
 * @returns A RegExp that tests absolute or relative file paths.
 */
function globToRegExp(glob: string): RegExp {
  // Escape special regex characters except our glob specials
  let regexStr = "";
  let i = 0;
  while (i < glob.length) {
    const char = glob[i];
    if (char === "*" && glob[i + 1] === "*") {
      // ** matches everything including path separators
      regexStr += ".*";
      i += 2;
      // Skip optional trailing slash after **
      if (glob[i] === "/") i++;
    } else if (char === "*") {
      // * matches anything except path separator
      regexStr += "[^/]*";
      i++;
    } else if (char === "?") {
      regexStr += "[^/]";
      i++;
    } else if (/[.+^${}()|[\]\\]/.test(char)) {
      regexStr += "\\" + char;
      i++;
    } else {
      regexStr += char;
      i++;
    }
  }
  return new RegExp("^" + regexStr + "$");
}

/**
 * Test whether a file path matches any of the provided glob patterns.
 *
 * Normalises the path to use forward slashes. Returns `false` immediately
 * when `globs` is an empty array (default-deny for empty write lists).
 *
 * @param filePath - The file path to test (absolute or relative).
 * @param globs - The glob patterns to test against.
 * @returns `true` if `filePath` matches at least one glob pattern.
 */
function matchesAnyGlob(filePath: string, globs: string[]): boolean {
  if (globs.length === 0) return false;
  // Normalise separators; strip leading slash for relative matching
  const normalized = filePath.replace(/\\/g, "/").replace(/^\//, "");
  for (const glob of globs) {
    if (globToRegExp(glob).test(normalized)) return true;
  }
  return false;
}

/**
 * Attempt to extract the target file path from a Pi tool_call event.
 *
 * Handles the three writable tool shapes:
 * - `Edit`: `{ input: { file_path: string } }` or `{ filePath: string }`
 * - `Write`: `{ input: { file_path: string } }` or `{ filePath: string }`
 * - `Bash`: best-effort scan of the command string for write destinations
 *
 * Returns `null` when the path cannot be determined (allow-by-default for Bash
 * when the destination is ambiguous).
 *
 * @param toolName - The tool being invoked ("Edit", "Write", or "Bash").
 * @param toolInput - The raw tool input object.
 * @returns The extracted file path, or `null` if not determinable.
 */
function extractTargetPath(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
): string | null {
  if (!toolInput) return null;

  if (toolName === "Edit" || toolName === "Write") {
    // Pi uses snake_case in the actual tool call input
    if (typeof toolInput["file_path"] === "string") return toolInput["file_path"];
    // camelCase fallback (bridge convention)
    if (typeof toolInput["filePath"] === "string") return toolInput["filePath"];
    // path fallback
    if (typeof toolInput["path"] === "string") return toolInput["path"];
    return null;
  }

  if (toolName === "Bash") {
    const cmd = typeof toolInput["command"] === "string" ? toolInput["command"] : null;
    if (!cmd) return null;

    // Detect common write patterns: redirection, tee, cp/mv destination
    // Best-effort: return the first detected destination path.
    // If ambiguous, return null (allow-by-default for Bash).
    const redirectMatch = cmd.match(/>\s*["']?([^\s"';&|]+)/);
    if (redirectMatch?.[1]) return redirectMatch[1];

    const teeMatch = cmd.match(/\btee\s+(?:-a\s+)?["']?([^\s"';&|]+)/);
    if (teeMatch?.[1]) return teeMatch[1];

    // cp/mv destination is the last argument — very heuristic
    const cpMvMatch = cmd.match(/\b(?:cp|mv)\s+\S+\s+["']?([^\s"';&|]+)/);
    if (cpMvMatch?.[1]) return cpMvMatch[1];

    return null; // Cannot determine — allow (workers self-report)
  }

  return null;
}

// ============================================================================
// T442: ANSI color helpers — imported from shared tui-theme.ts
// ============================================================================
// All color constants and styling functions are imported from tui-theme.ts
// at the top of this file. The design tokens map to:
//   accentPrimary  → #a855f7 (ANSI 135) — banner chrome, headers
//   textSecondary  → #94a3b8 (ANSI 245) — dim/muted text
//   bold           → ANSI bold escape    — headings, emphasis

// ============================================================================
// T442: Session banner rendering
// ============================================================================

/**
 * Cached bundle counts from the last session_start compilation.
 * Used by the banner and status bar entries.
 */
export interface BundleCounts {
  /** Number of agents declared in the CANT bundle. */
  agents: number;
  /** Number of teams declared in the CANT bundle. */
  teams: number;
  /** Number of tools declared in the CANT bundle. */
  tools: number;
  /** Name of the first team in the bundle, or "none" if no teams. */
  teamName: string;
}

/** Cached bundle counts, set during session_start. */
let lastBundleCounts: BundleCounts | null = null;

/**
 * Build the CleoOS branded session banner lines.
 *
 * Renders a box-drawing banner with the forge aesthetic using purple
 * ANSI accents and the compiled CANT bundle counts.
 *
 * @param counts - Agent, team, and tool counts from the CANT bundle.
 * @param sessionId - The current session ID, if available.
 * @returns An array of pre-formatted ANSI lines for the widget.
 */
export function buildSessionBanner(
  counts: BundleCounts,
  sessionId: string,
): string[] {
  const WIDTH = 44;
  const hBar = BOX_HORIZONTAL.repeat(WIDTH);

  // Build the content strings (plain, without ANSI, for padding calculation)
  const titleText = `        ${ICON_FORGE}  C L E O O S  ${ICON_FORGE}`;
  const subtitleText = "     The Agentic Development Forge";
  const statsText =
    `  Agents: ${counts.agents}  ${LINE_VERTICAL}  Teams: ${counts.teams}  ${LINE_VERTICAL}  Tools: ${counts.tools}`;
  const sessionText = `  Session: ${sessionId.length > 20 ? sessionId.slice(0, 20) + "..." : sessionId}`;

  /**
   * Pad content to fill the banner width.
   *
   * @param content - The visible content string.
   * @param styledContent - The ANSI-styled version of the content.
   * @returns The padded line with box-drawing border characters.
   */
  function padLine(content: string, styledContent: string): string {
    const pad = Math.max(0, WIDTH - content.length);
    return accentPrimary(`  ${BOX_VERTICAL}`) + styledContent + " ".repeat(pad) + accentPrimary(BOX_VERTICAL);
  }

  return [
    accentPrimary(`  ${BOX_TOP_LEFT}${hBar}${BOX_TOP_RIGHT}`),
    padLine(titleText, bold(accentPrimary(titleText))),
    padLine(subtitleText, textSecondary(subtitleText)),
    accentPrimary(`  ${BOX_LEFT_T}${hBar}${BOX_RIGHT_T}`),
    padLine(statsText, textSecondary(statsText)),
    padLine(sessionText, textSecondary(sessionText)),
    accentPrimary(`  ${BOX_BOTTOM_LEFT}${hBar}${BOX_BOTTOM_RIGHT}`),
  ];
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
// T438: 3-tier CANT discovery (global > user > project, project wins)
// ============================================================================

/** Per-tier file counts for diagnostic reporting. */
interface TierDiscoveryStats {
  global: number;
  user: number;
  project: number;
  overrides: number;
  merged: number;
}

/**
 * Resolve XDG-compliant paths for the 3-tier CANT hierarchy.
 *
 * Respects `XDG_DATA_HOME` and `XDG_CONFIG_HOME` environment variables.
 * Falls back to XDG defaults (`~/.local/share/` and `~/.config/`).
 *
 * @param projectDir - The project root directory (for the project tier).
 * @returns An object with `global`, `user`, and `project` CANT directory paths.
 */
function resolveThreeTierPaths(projectDir: string): {
  global: string;
  user: string;
  project: string;
} {
  const home = homedir();
  const xdgData =
    process.env["XDG_DATA_HOME"] ?? join(home, ".local", "share");
  const xdgConfig = process.env["XDG_CONFIG_HOME"] ?? join(home, ".config");

  return {
    global: join(xdgData, "cleo", "cant"),
    user: join(xdgConfig, "cleo", "cant"),
    project: join(projectDir, ".cleo", "cant"),
  };
}

/**
 * Discover `.cant` files across all three tiers with override semantics.
 *
 * Scans global, user, and project tiers. Files in higher-precedence tiers
 * override files in lower-precedence tiers that share the same basename.
 * The precedence order is: project > user > global.
 *
 * @param projectDir - The project root directory.
 * @returns An object containing the merged file list and per-tier statistics.
 */
function discoverCantFilesMultiTier(projectDir: string): {
  files: string[];
  stats: TierDiscoveryStats;
} {
  const paths = resolveThreeTierPaths(projectDir);

  const globalFiles = discoverCantFiles(paths.global);
  const userFiles = discoverCantFiles(paths.user);
  const projectFiles = discoverCantFiles(paths.project);

  // Build basename-keyed map; lowest precedence first so higher tiers override
  const fileMap = new Map<string, string>();

  for (const file of globalFiles) {
    fileMap.set(basename(file), file);
  }

  const afterGlobal = fileMap.size;

  for (const file of userFiles) {
    fileMap.set(basename(file), file);
  }

  const afterUser = fileMap.size;

  for (const file of projectFiles) {
    fileMap.set(basename(file), file);
  }

  const totalUniqueInputs = globalFiles.length + userFiles.length + projectFiles.length;
  const overrides = totalUniqueInputs - fileMap.size;

  return {
    files: Array.from(fileMap.values()),
    stats: {
      global: globalFiles.length,
      user: userFiles.length,
      project: projectFiles.length,
      overrides,
      merged: fileMap.size,
    },
  };
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
  // session_start: discover and compile .cant files from all 3 tiers
  // T438: 3-tier resolution — global, user, project (project wins)
  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    bundlePrompt = null;
    lastDiagnosticSummary = null;
    lastBundleCounts = null;

    try {
      const { files, stats } = discoverCantFilesMultiTier(ctx.cwd);
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

      // T442: Cache bundle counts for banner and status bar
      const teamName = bundle.teams.length > 0
        ? bundle.teams[0].name
        : "none";
      lastBundleCounts = {
        agents: bundle.agents.length,
        teams: bundle.teams.length,
        tools: bundle.tools.length,
        teamName,
      };

      // Build diagnostic summary with per-tier counts
      const errorDiags = bundle.diagnostics.filter((d) => d.severity === "error");
      const warnDiags = bundle.diagnostics.filter((d) => d.severity === "warning");
      lastDiagnosticSummary = [
        `Files: ${files.length} (global: ${stats.global}, user: ${stats.user}, project: ${stats.project})`,
        `Overrides: ${stats.overrides}`,
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
          `CleoOS CANT bridge: ${errorDiags.length} validation error(s) in CANT files`,
          "warning",
        );
      }

      // T442: Render branded session banner and status bar entries
      if (ctx.hasUI) {
        // Derive a session ID from the session manager or use a fallback
        const sessionId = ctx.sessionManager?.getSessionId?.()
          ?? `ses_${new Date().toISOString().replace(/[:.T-]/g, "").slice(0, 14)}`;

        // Render the CleoOS banner widget above the editor
        const bannerLines = buildSessionBanner(lastBundleCounts, sessionId);
        ctx.ui.setWidget("cleo-banner", bannerLines, { placement: "aboveEditor" });

        // Set persistent status bar entries using design system icons
        ctx.ui.setStatus("cleo-agents", `${ICON_FORGE} ${bundle.agents.length} agents`);
        ctx.ui.setStatus("cleo-team", `${ICON_DIAMOND} ${teamName}`);
        ctx.ui.setStatus("cleo-tier", `${ICON_TRIANGLE} high`);

        // Keep the existing CANT bridge status
        ctx.ui.setStatus(
          "cleo-cant-bridge",
          `CANT: ${bundle.agents.length} agent(s), ${files.length} file(s) [G:${stats.global} U:${stats.user} P:${stats.project}]`,
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

  // tool_call: ULTRAPLAN §10.3 — Lead agents MUST NOT execute Edit/Write/Bash.
  // T424: Worker agents with declared file permissions are restricted to their
  //        declared write globs. Leads dispatch; workers execute within scope.
  // Fires on every Pi tool_call event.
  // The before_agent_start handler (T420 validate-on-load) is NOT touched here.
  pi.on(
    "tool_call",
    async (event: {
      /** CANT agent definition resolved by Pi at spawn time, if available. */
      agentDef?: {
        /** Tier role declared in the .cant file (e.g. "lead", "worker", "orchestrator"). */
        role?: string;
        /** Path-scoped file permissions declared in the .cant file (T423). */
        filePermissions?: AgentFilePermissions;
        /** Agent name for diagnostic messages. */
        name?: string;
      };
      /** The tool name being invoked (e.g. "Edit", "Write", "Bash"). */
      toolName?: string;
      /** The raw tool input object (contains file_path for Edit/Write, command for Bash). */
      toolInput?: Record<string, unknown>;
    }) => {
      const agentDef = event.agentDef;
      // No agentDef = no restrictions (hook is a no-op).
      if (!agentDef) return {};

      const toolName = event.toolName ?? "";
      const BLOCKED_TOOLS = ["Edit", "Write", "Bash"];

      // ── W7b: Lead blocking ─────────────────────────────────────────────
      // Only restrict agents whose CANT role is explicitly "lead".
      // Non-lead roles (worker, orchestrator, undefined) pass this gate.
      if (agentDef.role !== "lead") {
        // Fall through to the T424 worker path ACL check below.
      } else {
        // Lead role: block Edit/Write/Bash entirely.
        if (!BLOCKED_TOOLS.includes(toolName)) return {};

        // Reject the tool call with a LAFS error envelope.
        return {
          rejected: true,
          error: {
            code: 70,
            codeName: "E_LEAD_TOOL_BLOCKED",
            message: `Lead agents cannot execute ${toolName} — dispatch to a worker instead`,
            fix: "Use the delegate tool to spawn a worker agent for this work",
          },
        };
      }

      // ── T424: Worker path ACL ──────────────────────────────────────────
      // Workers with declared file permissions can only write inside their
      // declared globs. Applies to Edit, Write, and Bash (best-effort).
      if (
        agentDef.role === "worker" &&
        agentDef.filePermissions !== undefined &&
        BLOCKED_TOOLS.includes(toolName)
      ) {
        const writeGlobs = agentDef.filePermissions.write;
        // `undefined` write field = no declared write ACL = allow through.
        // Empty array [] = explicit no-writes = default-deny.
        if (writeGlobs !== undefined) {
          const targetPath = extractTargetPath(toolName, event.toolInput);
          if (targetPath !== null && !matchesAnyGlob(targetPath, writeGlobs)) {
            const agentName = agentDef.name ?? "worker";
            const scopeList =
              writeGlobs.length > 0 ? writeGlobs.join(", ") : "(none — this worker is read-only)";
            return {
              rejected: true,
              error: {
                code: 71,
                codeName: "E_WORKER_PATH_ACL_VIOLATION",
                message: `Worker ${agentName} is not allowed to write to ${targetPath}`,
                fix:
                  `This worker can only write inside: ${scopeList}. ` +
                  "Either update the worker's permissions.files.write glob in " +
                  ".cleo/teams.cant, or dispatch to a different worker with matching scope.",
              },
            };
          }
        }
      }

      return {};
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
    lastBundleCounts = null;
  });
}
