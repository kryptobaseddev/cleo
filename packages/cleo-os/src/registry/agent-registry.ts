/**
 * CleoOS Agent Registry — catalog of installed agents across all provider adapters.
 *
 * Discovers agents from two sources:
 *   1. **Seed agents** — bundled with CleoOS in `packages/cleo-os/seed-agents/`.
 *   2. **User agents** — installed by individual provider adapters into their
 *      provider-specific agent directories (e.g. `~/.claude/agents/`).
 *
 * This module is read-only. It does not install, remove, or modify agents.
 * Provider adapter logic stays in `packages/adapters/`. CleoOS consumes the
 * filesystem artifacts that adapters produce.
 *
 * @remarks
 * Long-term: `loadUserAgents()` should call `adapter.paths?.getAgentInstallDir()`
 * dynamically once T639 exposes the provider-folder contract. For now the 9 paths
 * are hard-coded from each provider's `AdapterPathProvider` defaults.
 *
 * @see ADR-050 — CleoOS Sovereign Harness: Distribution Binding Charter
 * @task T640
 * @epic T636
 * @packageDocumentation
 */

import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single agent known to the CleoOS agent catalog.
 *
 * Agents are discovered at runtime from seed directories and provider-specific
 * agent installation folders. The `source` discriminant distinguishes bundled
 * agents from user-installed ones.
 */
export interface AgentDefinition {
  /** Stable unique identifier for this agent (derived from file name sans extension). */
  id: string;
  /** Human-readable display name (defaults to `id` when no metadata is available). */
  name: string;
  /**
   * Provider that manages this agent's execution context.
   *
   * One of the 9 known CLEO provider IDs: `"claude-code"`, `"claude-sdk"`,
   * `"codex"`, `"cursor"`, `"gemini-cli"`, `"kimi"`, `"openai-sdk"`,
   * `"opencode"`, `"pi"`. Seed agents use `"cleo-os"`.
   */
  provider: string;
  /** Absolute path to the agent definition file on disk. */
  path: string;
  /**
   * Free-form capability tags describing what this agent can do.
   *
   * Common values: `"spawn"`, `"orchestrate"`, `"memory"`, `"review"`, `"test"`.
   * May be empty when no metadata file is available.
   */
  capabilities: string[];
  /**
   * Origin of this agent definition.
   *
   * - `"seed"` — bundled with CleoOS under `packages/cleo-os/seed-agents/`
   * - `"user"` — installed by a provider adapter into its agent directory
   */
  source: 'seed' | 'user';
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Absolute path to the CleoOS seed-agents directory.
 *
 * Located at `packages/cleo-os/seed-agents/` relative to this source file's
 * compiled output (`dist/registry/`), so we go up two levels from `__dirname`.
 */
const SEED_AGENTS_DIR = join(__dirname, '..', '..', 'seed-agents');

/**
 * Known provider IDs and their default agent installation directories.
 *
 * Derived from each provider's `AdapterPathProvider.getAgentInstallDir()` defaults.
 * Update here when a provider changes its agent directory structure.
 *
 * @remarks
 * Long-term replacement: call `adapter.paths?.getAgentInstallDir()` once T639
 * exposes the provider-folder contract via a dynamic registry surface.
 */
const PROVIDER_AGENT_DIRS: ReadonlyArray<{ providerId: string; dir: string }> = [
  { providerId: 'claude-code', dir: join(homedir(), '.claude', 'agents') },
  { providerId: 'claude-sdk', dir: join(homedir(), '.claude', 'agents') },
  { providerId: 'codex', dir: join(homedir(), '.codex', 'agents') },
  { providerId: 'cursor', dir: join(homedir(), '.cursor', 'agents') },
  { providerId: 'gemini-cli', dir: join(homedir(), '.gemini', 'agents') },
  { providerId: 'kimi', dir: join(homedir(), '.kimi', 'agents') },
  { providerId: 'openai-sdk', dir: join(homedir(), '.openai', 'agents') },
  { providerId: 'opencode', dir: join(homedir(), '.opencode', 'agents') },
  { providerId: 'pi', dir: join(homedir(), '.pi', 'agents') },
];

/**
 * File extensions recognised as agent definition files.
 *
 * Excludes README.md and other documentation files in seed-agents/.
 */
const AGENT_EXTENSIONS = new Set(['.md', '.json', '.yaml', '.yml', '.ts', '.js']);

/**
 * Derive a stable agent `id` from a file name by stripping the extension.
 *
 * @param fileName - Base file name (e.g. `"cleo-prime.md"`).
 * @returns ID string (e.g. `"cleo-prime"`).
 */
function idFromFileName(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

/**
 * Read agent file names from a directory, returning an empty array when the
 * directory does not exist or cannot be read.
 *
 * Filters to known agent file extensions and skips `README` files.
 *
 * @param dir - Absolute path to the directory to scan.
 * @returns Array of base file names matching the agent extension filter.
 */
async function readAgentFileNames(dir: string): Promise<string[]> {
  if (!existsSync(dir)) {
    return [];
  }
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .filter((name) => {
        const dot = name.lastIndexOf('.');
        if (dot < 0) return false;
        const ext = name.slice(dot);
        return AGENT_EXTENSIONS.has(ext) && !name.toLowerCase().startsWith('readme');
      });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// AgentRegistry
// ---------------------------------------------------------------------------

/**
 * Read-only catalog of CleoOS agents discovered across all provider adapters.
 *
 * Combines seed agents (bundled with CleoOS) with user-installed agents from
 * each of the 9 provider adapter directories. Results are deduplicated by
 * `path` — a path present in both sources appears once as `"seed"`.
 *
 * @example
 * ```ts
 * const registry = new AgentRegistry();
 * const all = await registry.listAll();
 * console.log(all.length, 'agents discovered');
 * ```
 */
export class AgentRegistry {
  /**
   * Load seed agents bundled with CleoOS.
   *
   * Reads `packages/cleo-os/seed-agents/` and returns one `AgentDefinition`
   * per agent file found. Returns an empty array when the directory is absent
   * or empty (the directory is created during T640 but initially unpopulated).
   *
   * @returns Array of seed agent definitions; empty if none are installed.
   */
  async loadSeedAgents(): Promise<AgentDefinition[]> {
    const fileNames = await readAgentFileNames(SEED_AGENTS_DIR);
    return fileNames.map((fileName): AgentDefinition => {
      const id = idFromFileName(fileName);
      return {
        id,
        name: id,
        provider: 'cleo-os',
        path: join(SEED_AGENTS_DIR, fileName),
        capabilities: [],
        source: 'seed',
      };
    });
  }

  /**
   * Load user-installed agents from all known provider agent directories.
   *
   * Iterates the 9 provider adapter directories and returns one
   * `AgentDefinition` per agent file found. Directories that do not exist
   * or are unreadable are silently skipped.
   *
   * @returns Array of user agent definitions across all providers.
   */
  async loadUserAgents(): Promise<AgentDefinition[]> {
    const results: AgentDefinition[] = [];

    for (const { providerId, dir } of PROVIDER_AGENT_DIRS) {
      const fileNames = await readAgentFileNames(dir);
      for (const fileName of fileNames) {
        const id = idFromFileName(fileName);
        results.push({
          id,
          name: id,
          provider: providerId,
          path: join(dir, fileName),
          capabilities: [],
          source: 'user',
        });
      }
    }

    return results;
  }

  /**
   * Return all known agents — seed agents followed by user-installed agents.
   *
   * Seed agents take precedence: if the same absolute path appears in both
   * sources (uncommon but possible in development), the seed entry wins and
   * the user entry is omitted.
   *
   * @returns Deduplicated array of all discovered agent definitions.
   */
  async listAll(): Promise<AgentDefinition[]> {
    const [seed, user] = await Promise.all([this.loadSeedAgents(), this.loadUserAgents()]);

    const seenPaths = new Set<string>(seed.map((a) => a.path));
    const deduped = user.filter((a) => {
      if (seenPaths.has(a.path)) return false;
      seenPaths.add(a.path);
      return true;
    });

    return [...seed, ...deduped];
  }
}
