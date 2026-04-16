/**
 * CleoOS Provider Matrix — read-only health view of the 9 provider adapters.
 *
 * Scans `packages/adapters/src/providers/` at runtime to determine which
 * providers are installed, whether they expose a spawn implementation, and
 * how many hooks they declare. No CLI surface is added in this skeleton;
 * the matrix is consumed programmatically by orchestrators or a future
 * `cleo-os doctor` command (deferred per ADR-050).
 *
 * @remarks
 * The `adapterClass` field is always `"CLEOProviderAdapter"` — the shared
 * interface from `@cleocode/contracts` that every provider adapter implements.
 * It is included in `ProviderMatrixRow` to make the interface name self-documenting
 * for tooling that reflects on the matrix output.
 *
 * @see ADR-050 — CleoOS Sovereign Harness: Distribution Binding Charter
 * @see packages/contracts/src/adapter.ts — CLEOProviderAdapter interface
 * @task T640
 * @epic T636
 * @packageDocumentation
 */

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single row in the CleoOS provider matrix.
 *
 * Each row represents one of the 9 known CLEO provider adapters and summarises
 * its installation state and feature completeness as determined by filesystem
 * inspection.
 */
export interface ProviderMatrixRow {
  /** Canonical provider identifier (e.g. `"claude-code"`, `"opencode"`). */
  providerId: string;
  /** Human-readable display name for the provider. */
  displayName: string;
  /**
   * Whether the provider directory exists under
   * `packages/adapters/src/providers/<providerId>/`.
   */
  installed: boolean;
  /**
   * Whether `spawn.ts` exists in the provider's directory.
   *
   * A spawn implementation is required for the provider to launch sub-agents.
   */
  spawnImplemented: boolean;
  /**
   * Count of canonical CAAMP hook event names declared in `hooks.ts`.
   *
   * Computed by scanning for known event name identifiers. Returns `0` when
   * `hooks.ts` is absent or contains no recognised declarations.
   */
  hookSupport: number;
  /**
   * Name of the shared adapter interface that this provider implements.
   *
   * Always `"CLEOProviderAdapter"` (from `packages/contracts/src/adapter.ts`).
   * Included for tooling that reflects on matrix rows to identify the contract.
   */
  adapterClass: string;
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/**
 * The shared adapter interface name — every provider adapter implements this.
 *
 * @see packages/contracts/src/adapter.ts
 */
const ADAPTER_CLASS = 'CLEOProviderAdapter' as const;

/**
 * Canonical CAAMP hook event names used to count hook support in `hooks.ts`.
 *
 * Derived from the 16-event CAAMP taxonomy. Scanning for these identifiers
 * gives a conservative lower-bound count of declared hooks.
 */
const CANONICAL_HOOK_EVENTS: ReadonlyArray<string> = [
  'PreToolUse',
  'PostToolUse',
  'SubagentStart',
  'SubagentEnd',
  'PreModel',
  'PostModel',
  'SessionStart',
  'SessionEnd',
  'Notification',
  'Stop',
  'UserPrompt',
  'AssistantMessage',
  'ToolResult',
  'Error',
  'PreCompact',
  'PostCompact',
];

/**
 * Known provider IDs paired with their display names.
 *
 * Order matches the canonical 9-provider list. `"shared"` is excluded — it is
 * an internal utilities directory, not a provider adapter.
 */
const KNOWN_PROVIDERS: ReadonlyArray<{ id: string; displayName: string }> = [
  { id: 'claude-code', displayName: 'Claude Code' },
  { id: 'claude-sdk', displayName: 'Claude SDK' },
  { id: 'codex', displayName: 'OpenAI Codex' },
  { id: 'cursor', displayName: 'Cursor' },
  { id: 'gemini-cli', displayName: 'Gemini CLI' },
  { id: 'kimi', displayName: 'Kimi' },
  { id: 'openai-sdk', displayName: 'OpenAI Agents SDK' },
  { id: 'opencode', displayName: 'OpenCode' },
  { id: 'pi', displayName: 'Pi Coding Agent' },
];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to `packages/adapters/src/providers/`.
 *
 * Navigates from the compiled output directory (`dist/registry/`) up through
 * the monorepo to reach the adapters package source.
 *
 * @returns Absolute path to the providers directory.
 */
function resolveProvidersDir(): string {
  // dist/registry/ → dist/ → packages/cleo-os/ → packages/ → monorepo root
  const monorepoRoot = join(__dirname, '..', '..', '..', '..', '..');
  return join(monorepoRoot, 'packages', 'adapters', 'src', 'providers');
}

/**
 * Count canonical hook event names declared in a `hooks.ts` file.
 *
 * Reads the file as text and scans for occurrences of known CAAMP event name
 * identifiers. The count is a lower-bound estimate — it does not parse the
 * TypeScript AST.
 *
 * @param hooksPath - Absolute path to `hooks.ts`.
 * @returns Count of recognised hook event names (0 if file unreadable).
 */
async function countHookDeclarations(hooksPath: string): Promise<number> {
  try {
    const source = await readFile(hooksPath, 'utf-8');
    let count = 0;
    for (const event of CANONICAL_HOOK_EVENTS) {
      // Match the event name as a standalone word to avoid false positives
      // e.g. "Stop" should not match "StopEvent"
      const pattern = new RegExp(`\\b${event}\\b`);
      if (pattern.test(source)) {
        count++;
      }
    }
    return count;
  } catch {
    return 0;
  }
}

/**
 * Build a single `ProviderMatrixRow` by inspecting the provider's directory.
 *
 * @param providerId - Canonical provider ID (e.g. `"claude-code"`).
 * @param displayName - Human-readable display name.
 * @param providersDir - Absolute path to `packages/adapters/src/providers/`.
 * @returns Populated matrix row.
 */
async function buildRow(
  providerId: string,
  displayName: string,
  providersDir: string,
): Promise<ProviderMatrixRow> {
  const providerDir = join(providersDir, providerId);
  const installed = existsSync(providerDir);

  if (!installed) {
    return {
      providerId,
      displayName,
      installed: false,
      spawnImplemented: false,
      hookSupport: 0,
      adapterClass: ADAPTER_CLASS,
    };
  }

  const spawnPath = join(providerDir, 'spawn.ts');
  const hooksPath = join(providerDir, 'hooks.ts');

  const spawnImplemented = existsSync(spawnPath);
  const hookSupport = existsSync(hooksPath) ? await countHookDeclarations(hooksPath) : 0;

  return {
    providerId,
    displayName,
    installed: true,
    spawnImplemented,
    hookSupport,
    adapterClass: ADAPTER_CLASS,
  };
}

// ---------------------------------------------------------------------------
// ProviderMatrix
// ---------------------------------------------------------------------------

/**
 * Read-only health view of all 9 CLEO provider adapters.
 *
 * Inspects the `packages/adapters/src/providers/` directory tree to produce
 * a structured matrix of adapter installation state and feature completeness.
 * All operations are read-only; no files are created or modified.
 *
 * @example
 * ```ts
 * const matrix = new ProviderMatrix();
 * const rows = await matrix.getMatrix();
 * const ready = rows.filter((r) => r.installed && r.spawnImplemented);
 * console.log(ready.length, 'providers ready to spawn agents');
 * ```
 */
export class ProviderMatrix {
  private readonly providersDir: string;

  /**
   * Construct a `ProviderMatrix`.
   *
   * @param providersDir - Override the resolved providers directory path.
   *   Primarily for testing. Defaults to the monorepo-relative path.
   */
  constructor(providersDir?: string) {
    this.providersDir = providersDir ?? resolveProvidersDir();
  }

  /**
   * Scan all known providers and return their matrix rows.
   *
   * Results are returned in the canonical provider order defined by
   * `KNOWN_PROVIDERS`. Rows are computed concurrently for performance.
   *
   * @returns Array of {@link ProviderMatrixRow} — one per known provider.
   */
  async getMatrix(): Promise<ProviderMatrixRow[]> {
    const rows = await Promise.all(
      KNOWN_PROVIDERS.map(({ id, displayName }) => buildRow(id, displayName, this.providersDir)),
    );
    return rows;
  }

  /**
   * List provider IDs discovered under the providers directory.
   *
   * Returns all subdirectory names found at `packages/adapters/src/providers/`,
   * including any that are not in the canonical `KNOWN_PROVIDERS` list. Useful
   * for detecting community-contributed or experimental adapters.
   *
   * @returns Array of directory names (provider IDs) present on disk.
   */
  async listInstalledProviderIds(): Promise<string[]> {
    if (!existsSync(this.providersDir)) {
      return [];
    }
    try {
      const entries = await readdir(this.providersDir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  }
}
