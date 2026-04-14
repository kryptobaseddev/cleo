/**
 * Shared CANT context builder for all spawn providers.
 *
 * Extracts the Pi bridge's CANT discovery/compile/inject logic into a reusable
 * module that any spawn provider (Claude Code, OpenCode, Cursor, etc.) can call
 * to enrich agent prompts with:
 *
 * 1. Compiled CANT bundle (team topology, agent personas, tool ACLs)
 * 2. Memory bridge (recent decisions, handoff notes, key patterns)
 * 3. Mental model injection (validate-on-load agent-specific observations)
 *
 * All operations are best-effort: if any step fails (missing packages, empty
 * directories, compilation errors), the base prompt is returned unchanged.
 * This guarantees agents always spawn — CANT context is an enrichment, not a gate.
 *
 * Reference implementation: packages/cleo-os/extensions/cleo-cant-bridge.ts
 * (Pi-only; this module generalizes the same logic for all providers)
 *
 * @task T555
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-tier file counts for diagnostic reporting. */
export interface TierDiscoveryStats {
  global: number;
  user: number;
  project: number;
  overrides: number;
  merged: number;
}

/** Minimal observation shape returned by memoryFind / searchBrainCompact. */
export interface MentalModelObservation {
  id: string;
  type: string;
  title: string;
  date?: string;
}

/** Options for the main enrichment function. */
export interface BuildCantEnrichedPromptOptions {
  /** Project root directory for .cleo/cant/ discovery and brain.db access. */
  projectDir: string;
  /** The raw prompt to enrich. Returned unchanged if no CANT context is available. */
  basePrompt: string;
  /** Agent name for mental model injection. Omit to skip mental model fetch. */
  agentName?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Preamble text injected when an agent has mental model observations.
 * The agent MUST re-evaluate each observation against current project state.
 */
const VALIDATE_ON_LOAD_PREAMBLE =
  '===== MENTAL MODEL (validate-on-load) =====\n' +
  'These are your prior observations, patterns, and learnings for this project.\n' +
  'Before acting, you MUST re-evaluate each entry against current project state.\n' +
  'If an entry is stale, note it and proceed with fresh understanding.';

// ---------------------------------------------------------------------------
// Discovery functions (ported from cleo-cant-bridge.ts lines 418-526)
// ---------------------------------------------------------------------------

/**
 * Recursively discover `.cant` files in a directory.
 *
 * @param dir - The directory to scan recursively.
 * @returns An array of absolute paths to `.cant` files found.
 */
export function discoverCantFiles(dir: string): string[] {
  try {
    const entries = readdirSync(dir, { recursive: true, withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.cant')) {
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
 * Resolve XDG-compliant paths for the 3-tier CANT hierarchy.
 *
 * Respects `XDG_DATA_HOME` and `XDG_CONFIG_HOME` environment variables.
 * Falls back to XDG defaults (`~/.local/share/` and `~/.config/`).
 *
 * @param projectDir - The project root directory (for the project tier).
 * @returns An object with `global`, `user`, and `project` CANT directory paths.
 */
export function resolveThreeTierPaths(projectDir: string): {
  global: string;
  user: string;
  project: string;
} {
  const home = homedir();
  const xdgData = process.env['XDG_DATA_HOME'] ?? join(home, '.local', 'share');
  const xdgConfig = process.env['XDG_CONFIG_HOME'] ?? join(home, '.config');

  return {
    global: join(xdgData, 'cleo', 'cant'),
    user: join(xdgConfig, 'cleo', 'cant'),
    project: join(projectDir, '.cleo', 'cant'),
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
export function discoverCantFilesMultiTier(projectDir: string): {
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

  for (const file of userFiles) {
    fileMap.set(basename(file), file);
  }

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

// ---------------------------------------------------------------------------
// Memory bridge (ported from cleo-cant-bridge.ts lines 376-404)
// ---------------------------------------------------------------------------

/**
 * Read the memory bridge file from a project's .cleo/ directory.
 *
 * @param projectDir - The project root directory.
 * @returns The memory bridge content, or null if not found or empty.
 */
export function readMemoryBridge(projectDir: string): string | null {
  try {
    const bridgePath = join(projectDir, '.cleo', 'memory-bridge.md');
    if (!existsSync(bridgePath)) return null;
    const content = readFileSync(bridgePath, 'utf-8');
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

/**
 * Build the memory-bridge system-prompt block appended to every agent.
 *
 * Wraps the raw memory-bridge.md content in a clearly labeled section
 * so the agent knows this is the CLEO project memory context.
 *
 * @param content - The raw memory-bridge.md content.
 * @returns The formatted memory-bridge block for system prompt injection.
 */
export function buildMemoryBridgeBlock(content: string): string {
  return (
    '\n\n===== CLEO MEMORY BRIDGE =====\n' +
    'This is your project memory context from .cleo/memory-bridge.md.\n' +
    'Use it to understand recent decisions, handoff notes, and key patterns.\n\n' +
    content.trim() +
    '\n===== END MEMORY BRIDGE ====='
  );
}

// ---------------------------------------------------------------------------
// Mental model injection (ported from cleo-cant-bridge.ts lines 113-135, 543-589)
// ---------------------------------------------------------------------------

/**
 * Build the validate-on-load mental-model injection string.
 *
 * Pure function — no I/O, safe to call in tests without a real DB.
 *
 * @param agentName - Name of the spawned agent (used in the header line).
 * @param observations - Prior mental-model observations to list.
 * @returns System-prompt block with preamble and numbered observations,
 *          or empty string when `observations` is empty.
 */
export function buildMentalModelInjection(
  agentName: string,
  observations: MentalModelObservation[],
): string {
  if (observations.length === 0) return '';

  const lines: string[] = ['', `// Agent: ${agentName}`, VALIDATE_ON_LOAD_PREAMBLE, ''];

  for (let i = 0; i < observations.length; i++) {
    const obs = observations[i];
    const datePart = obs.date ? ` [${obs.date}]` : '';
    lines.push(`${i + 1}. [${obs.id}] (${obs.type})${datePart}: ${obs.title}`);
  }

  lines.push('===== END MENTAL MODEL =====');
  return lines.join('\n');
}

/**
 * Fetch mental model observations for an agent from brain.db.
 *
 * Uses dynamic import of `@cleocode/core` to avoid circular dependencies.
 * Returns empty string on any failure (best-effort, never throws).
 *
 * @param agentName - The agent's name for scoped observation lookup.
 * @param projectRoot - Project root directory for brain.db access.
 * @returns The validate-on-load system-prompt block, or "" on failure/empty.
 */
async function fetchMentalModelInjection(agentName: string, projectRoot: string): Promise<string> {
  try {
    // Dynamic import — @cleocode/core is NOT a compile-time dependency of adapters.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const coreModule = (await import(/* webpackIgnore: true */ '@cleocode/core' as string)) as {
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

    if (typeof coreModule.memoryFind !== 'function') return '';

    const result = await coreModule.memoryFind(
      {
        query: agentName,
        agent: agentName,
        limit: 10,
        tables: ['observations'],
      },
      projectRoot,
    );

    if (!result.success || !result.data?.results?.length) return '';

    return buildMentalModelInjection(agentName, result.data.results);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Build an enriched prompt with CANT context, memory bridge, and mental model.
 *
 * This is the universal entry point for all spawn providers. It performs the
 * same operations as the Pi bridge (cleo-cant-bridge.ts) but returns a string
 * rather than hooking into Pi events:
 *
 * 1. Discovers `.cant` files across 3 tiers (global → user → project)
 * 2. Compiles the CANT bundle via `@cleocode/cant`'s `compileBundle()`
 * 3. Renders the compiled system prompt
 * 4. Reads the memory bridge from `.cleo/memory-bridge.md`
 * 5. Fetches mental model observations for the named agent
 * 6. Concatenates: basePrompt + CANT bundle + memory bridge + mental model
 *
 * All operations are best-effort. If any step fails, the base prompt is
 * returned unchanged. CANT context is an enrichment, not a gate — agents
 * always spawn regardless of CANT availability.
 *
 * @param options - Project dir, base prompt, and optional agent name.
 * @returns The enriched prompt string, or basePrompt unchanged on failure.
 */
export async function buildCantEnrichedPrompt(
  options: BuildCantEnrichedPromptOptions,
): Promise<string> {
  const { projectDir, basePrompt, agentName } = options;
  let appendix = '';

  // Step 1-3: Discover and compile CANT bundle
  try {
    const { files } = discoverCantFilesMultiTier(projectDir);

    if (files.length > 0) {
      // Dynamic import — @cleocode/cant is NOT a compile-time dependency of adapters.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const cantModule = (await import(/* webpackIgnore: true */ '@cleocode/cant' as string)) as {
        compileBundle?: (paths: string[]) => Promise<{
          renderSystemPrompt: () => string;
          valid: boolean;
          diagnostics: unknown[];
        }>;
      };

      if (typeof cantModule.compileBundle === 'function') {
        const bundle = await cantModule.compileBundle(files);
        if (bundle.valid) {
          const rendered = bundle.renderSystemPrompt();
          if (rendered) {
            appendix += `\n\n${rendered}`;
          }
        }
      }
    }
  } catch {
    // CANT compilation failure — continue without bundle context
  }

  // Step 4: Append memory bridge
  try {
    const bridge = readMemoryBridge(projectDir);
    if (bridge) {
      appendix += buildMemoryBridgeBlock(bridge);
    }
  } catch {
    // Memory bridge read failure — non-fatal
  }

  // Step 5: Append mental model for named agent
  if (agentName) {
    try {
      const mentalModel = await fetchMentalModelInjection(agentName, projectDir);
      if (mentalModel) {
        appendix += `\n\n${mentalModel}`;
      }
    } catch {
      // Mental model fetch failure — non-fatal
    }
  }

  // Step 6: Return enriched prompt (or unchanged basePrompt if no context found)
  return appendix ? basePrompt + appendix : basePrompt;
}
