/**
 * Read-only adapter source inventory with independent provider verification levels.
 * Source presence does not establish installed, delivery, workflow, or lifecycle support.
 * @packageDocumentation
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ProviderChannelVerification,
  ProviderSourceInspection,
} from '@cleocode/contracts/capabilities';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A provider declaration, source inspection, and separate live capability assessments. */
export interface ProviderMatrixRow {
  /** Canonical provider identifier (for example, "claude-code"). */
  providerId: string;
  /** Human-readable provider name. */
  displayName: string;
  /**
   * Whether the adapter source directory was observed.
   * @deprecated Use source.directoryPresent; this never proved installation.
   */
  installed: boolean;
  /**
   * Whether a regular spawn.ts source file was observed.
   * @deprecated Use source.spawnFilePresent; this never proved executable spawning.
   */
  spawnImplemented: boolean;
  /**
   * Number of canonical hook names mentioned in source text, including comments.
   * @deprecated Use source.hookNameMentions; this never proved hook support.
   */
  hookSupport: number;
  /** Declared adapter interface name, not a verified runtime implementation. */
  adapterClass: string;
  /** Source-only inventory and diagnostic failures. */
  source: ProviderSourceInspection;
  /** External provider CLI capabilities, independent of CleoOS adapter spawning. */
  externalCli: ProviderChannelVerification;
  /** CleoOS programmatic spawning capabilities, independent of external CLI use. */
  programmaticSpawn: ProviderChannelVerification;
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
 * counts name mentions, including comments, and cannot prove hook support.
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
  { id: 'openai-sdk', displayName: 'OpenAI SDK (Vercel AI SDK)' },
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
  // __dirname = .../packages/cleo-os/dist/registry/ — 4 levels below monorepo root.
  // dist/registry/ → dist/ → cleo-os/ → packages/ → monorepo root.
  const monorepoRoot = join(__dirname, '..', '..', '..', '..');
  return join(monorepoRoot, 'packages', 'adapters', 'src', 'providers');
}

/** Whether the filesystem reports a genuinely absent entry. */
function isMissing(error: object): boolean {
  return 'code' in error && error.code === 'ENOENT';
}

/** Distinguish absent entries from failed reads and wrong filesystem types. */
async function hasEntry(path: string, kind: 'directory' | 'file'): Promise<boolean> {
  try {
    const info = await stat(path);
    if (kind === 'directory' ? info.isDirectory() : info.isFile()) return true;
    throw new Error(`Expected ${kind} at ${path}`);
  } catch (error) {
    if (error instanceof Error && isMissing(error)) return false;
    throw error;
  }
}

/** Inspect source without converting unreadable or malformed paths into healthy absence. */
async function inspectSource(directory: string): Promise<ProviderSourceInspection> {
  const result: ProviderSourceInspection = {
    directory,
    status: 'missing',
    directoryPresent: false,
    spawnFilePresent: false,
    hookNameMentions: 0,
    diagnostics: [],
  };
  try {
    result.directoryPresent = await hasEntry(directory, 'directory');
    if (!result.directoryPresent) return result;
    result.status = 'present';
    result.spawnFilePresent = await hasEntry(join(directory, 'spawn.ts'), 'file');
    const hooksPath = join(directory, 'hooks.ts');
    if (await hasEntry(hooksPath, 'file')) {
      const source = await readFile(hooksPath, 'utf-8');
      result.hookNameMentions = CANONICAL_HOOK_EVENTS.filter((event) =>
        new RegExp(`\\b${event}\\b`).test(source),
      ).length;
    }
  } catch (error) {
    result.status = 'failed';
    result.diagnostics = [error instanceof Error ? error.message : String(error)];
  }
  return result;
}

/** Source discovery cannot supply an installed workflow's identities or receipts. */
function unverifiedChannel(
  channel: ProviderChannelVerification['channel'],
): ProviderChannelVerification {
  const pending = (reason: string) => ({ status: 'unverified' as const, reason, evidence: [] });
  return {
    channel,
    identity: null,
    levels: {
      declared: pending(
        'Registry presence is a source hint; channel capabilities were not inspected.',
      ),
      installed: pending('No executable or installed SDK identity was measured.'),
      delivery: pending('No instruction delivery was observed in an installed invocation.'),
      workflow: pending(
        'No installed repair scenario and independent receipt verification were run.',
      ),
      lifecycle: pending(
        'No installed cancellation, teardown, and descendant cleanup were observed.',
      ),
    },
    limitations: [
      'Source names, comments, version strings, and self-authored certificates do not certify live behavior.',
      'Permission policy and account/interface availability remain unverified; no bypass flags were used.',
    ],
  };
}

/** Build the existing matrix row with explicit source and verification boundaries. */
async function buildRow(
  providerId: string,
  displayName: string,
  providersDir: string,
): Promise<ProviderMatrixRow> {
  const source = await inspectSource(join(providersDir, providerId));
  return {
    providerId,
    displayName,
    installed: source.directoryPresent,
    spawnImplemented: source.spawnFilePresent,
    hookSupport: source.hookNameMentions,
    adapterClass: ADAPTER_CLASS,
    source,
    externalCli: unverifiedChannel('external-cli'),
    programmaticSpawn: unverifiedChannel('programmatic-spawn'),
  };
}

// ---------------------------------------------------------------------------
// ProviderMatrix
// ---------------------------------------------------------------------------

/**
 * Read-only source inventory of known adapters, with live capabilities left unverified.
 *
 * @example
 * ```ts
 * const rows = await new ProviderMatrix().getMatrix();
 * const sourceFailures = rows.filter((row) => row.source.status === 'failed');
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
    this.providersDir = resolve(providersDir ?? resolveProvidersDir());
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
   * @deprecated This lists source directories, not installed provider applications.
   * @returns Array of source directory names present on disk.
   * @throws Error when directory enumeration fails for a reason other than absence.
   */
  async listInstalledProviderIds(): Promise<string[]> {
    try {
      const entries = await readdir(this.providersDir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (error) {
      if (error instanceof Error && isMissing(error)) return [];
      throw error;
    }
  }
}
