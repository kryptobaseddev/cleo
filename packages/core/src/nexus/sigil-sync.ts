/**
 * Sigil sync — populate the NEXUS `sigils` table from canonical CANT agents.
 *
 * Walks the bundled `@cleocode/agents` package and upserts one sigil per
 * canonical agent.  Canonical agents are the .cant personas that ship with
 * CLEO and become available globally after `cleo init` /
 * `installSeedAgentsGlobally`:
 *
 *   - `cleo-subagent`        — universal protocol base
 *   - `project-orchestrator` — high-tier coordinator (seed)
 *   - `project-dev-lead`     — mid-tier decomposer (seed)
 *   - `project-code-worker`  — mid-tier code executor (seed)
 *   - `project-docs-worker`  — mid-tier docs executor (seed)
 *   - `project-security-worker` — mid-tier security review (seed)
 *   - `agent-architect`      — meta-agent (synthesises agents)
 *   - `playbook-architect`   — meta-agent (synthesises .cantbook playbooks)
 *
 * Per ADR-055 D032, dogfood personas (cleo-prime, cleoos-opus-orchestrator,
 * etc.) are intentionally NOT included — they are not in `@cleocode/agents`.
 *
 * Sigil contents are extracted directly from each .cant file:
 *   - peerId             ← `agent <name>:` line
 *   - displayName        ← peerId
 *   - role               ← `role:` field
 *   - cantFile           ← absolute path to the .cant file
 *   - systemPromptFragment ← `prompt:` block when present, else `description:`
 *   - capabilityFlags    ← JSON-encoded {tier, parent, model, persist}
 *
 * Idempotent — running multiple times produces stable results.  Last-writer-
 * wins on every field except `peerId`.
 *
 * @task T1386
 * @epic T1148
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { getNexusDb, resetNexusDbState } from '../store/nexus-sqlite.js';
import { upsertSigil } from './sigil.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result of {@link syncCanonicalSigils}.
 */
export interface SigilSyncResult {
  /** Total number of sigils upserted (created + updated). */
  count: number;
  /** Peer IDs that were upserted, sorted alphabetically. */
  peerIds: string[];
  /** Absolute path to the seed-agents directory used for the sync. */
  seedAgentsDir: string | null;
  /** Absolute path to the cleo-subagent.cant file used for the sync. */
  cleoSubagentFile: string | null;
  /** Absolute path to the meta agents directory used for the sync. */
  metaDir: string | null;
  /** Warnings encountered during sync (missing files, parse failures). */
  warnings: string[];
}

/**
 * Internal record shape parsed from a single .cant file.
 */
interface ParsedSigil {
  peerId: string;
  role: string;
  description: string;
  parent: string | null;
  tier: string | null;
  model: string | null;
  persist: string | null;
  systemPromptFragment: string | null;
  cantFile: string;
}

// ---------------------------------------------------------------------------
// Canonical agent registry
// ---------------------------------------------------------------------------

/**
 * Filenames (under seed-agents/) that constitute the canonical seed roster.
 * Excludes `*-generic.cant` which are exact duplicates of the non-suffixed
 * variants kept for backwards-compat with older meta-agent prompts.
 */
const CANONICAL_SEED_FILES: readonly string[] = [
  'orchestrator.cant',
  'dev-lead.cant',
  'code-worker.cant',
  'docs-worker.cant',
  'security-worker.cant',
] as const;

/**
 * Filenames (under meta/) that constitute the canonical meta-agent roster.
 */
const CANONICAL_META_FILES: readonly string[] = [
  'agent-architect.cant',
  'playbook-architect.cant',
] as const;

// ---------------------------------------------------------------------------
// .cant parser (minimal — only the fields we need for sigils)
// ---------------------------------------------------------------------------

/**
 * Parse the minimum subset of CANT syntax needed to derive a sigil:
 *   - The `agent <name>:` declaration line yields the peerId.
 *   - Top-level scalar fields (role, description, parent, tier, model,
 *     persist) are read by their leading 2-space indent.
 *   - The `prompt:` block (single-line `"..."` or pipe block `|`) is read
 *     for use as the system-prompt fragment.
 *
 * This is intentionally a string scanner rather than a full CANT parser —
 * the canonical .cant files are stable, and depending on `@cleocode/cant`
 * here would create a runtime dependency cycle (cant → core → cant).
 *
 * @param cantFile - Absolute path to the .cant file.
 * @returns Parsed sigil fields, or `null` if the file lacks an
 *   `agent <name>:` declaration.
 */
export function parseSigilFromCant(cantFile: string): ParsedSigil | null {
  const content = readFileSync(cantFile, 'utf8');
  const lines = content.split('\n');

  let peerId: string | null = null;
  let role = '';
  let description = '';
  let parent: string | null = null;
  let tier: string | null = null;
  let model: string | null = null;
  let persist: string | null = null;
  let systemPromptFragment: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();

    // Skip blank, comment, and frontmatter lines
    if (trimmed.length === 0 || trimmed.startsWith('#') || trimmed.startsWith('---')) {
      continue;
    }

    // Top-level: agent <name>:
    if (peerId === null && /^agent\s+([A-Za-z0-9-]+):/.test(trimmed)) {
      const match = trimmed.match(/^agent\s+([A-Za-z0-9-]+):/);
      if (match) peerId = match[1] ?? null;
      continue;
    }

    // Scalar fields are at 2-space indent
    if (line.startsWith('  ') && !line.startsWith('    ')) {
      const fieldMatch = trimmed.match(/^([a-z_-]+):\s*(.*)$/);
      if (!fieldMatch) continue;
      const [, key, rawValue] = fieldMatch;
      const value = stripQuotes(rawValue ?? '').trim();

      switch (key) {
        case 'role':
          role = value;
          break;
        case 'description':
          description = value;
          break;
        case 'parent':
          parent = value || null;
          break;
        case 'tier':
          tier = value || null;
          break;
        case 'model':
          model = value || null;
          break;
        case 'persist':
          persist = value || null;
          break;
        case 'prompt':
          systemPromptFragment = parsePromptValue(value, lines, i + 1);
          break;
      }
    }
  }

  if (peerId === null) return null;

  // If no explicit prompt block, fall back to the description so sigils
  // always carry a non-trivial systemPromptFragment for spawn enrichment.
  if (systemPromptFragment === null && description.length > 0) {
    systemPromptFragment = description;
  }

  return {
    peerId,
    role,
    description,
    parent,
    tier,
    model,
    persist,
    systemPromptFragment,
    cantFile,
  };
}

/**
 * Strip surrounding double or single quotes from a value.  Used for the
 * single-line `prompt:` and `description:` fields.
 *
 * @param value - Raw value with optional surrounding quotes.
 * @returns The value with one layer of surrounding quotes removed.
 */
function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Parse a CANT `prompt:` field which can take three shapes:
 *   1. Inline string:   `prompt: "..."`
 *   2. Pipe block:      `prompt: |` followed by 4-space indented lines
 *   3. Empty:           `prompt:` (returns null)
 *
 * @param firstLineValue - The raw value text on the same line as `prompt:`.
 * @param allLines       - All lines from the .cant file.
 * @param startIndex     - Line index to begin scanning for a pipe block body.
 * @returns The parsed prompt string, or `null` when no prompt is present.
 */
function parsePromptValue(
  firstLineValue: string,
  allLines: readonly string[],
  startIndex: number,
): string | null {
  // Pipe-block: `prompt: |`
  if (firstLineValue.trim() === '|') {
    const blockLines: string[] = [];
    for (let j = startIndex; j < allLines.length; j++) {
      const blockLine = allLines[j] ?? '';
      // Block ends at first line that isn't 4+ space indented and isn't blank
      if (blockLine.length > 0 && !blockLine.startsWith('    ')) break;
      // Strip the 4-space indent
      blockLines.push(blockLine.startsWith('    ') ? blockLine.slice(4) : blockLine);
    }
    // Drop trailing blank lines
    while (blockLines.length > 0 && blockLines[blockLines.length - 1]?.trim() === '') {
      blockLines.pop();
    }
    return blockLines.length > 0 ? blockLines.join('\n') : null;
  }

  // Inline string
  const inline = stripQuotes(firstLineValue.trim()).trim();
  return inline.length > 0 ? inline : null;
}

// ---------------------------------------------------------------------------
// Resolve canonical .cant files
// ---------------------------------------------------------------------------

/**
 * Result of {@link resolveCanonicalCantFiles}.
 */
export interface CanonicalCantFiles {
  /** Absolute path to the seed-agents directory, or `null` if not found. */
  seedAgentsDir: string | null;
  /** Absolute path to cleo-subagent.cant, or `null` if not found. */
  cleoSubagentFile: string | null;
  /** Absolute path to the meta-agent directory, or `null` if not found. */
  metaDir: string | null;
  /** Absolute paths of every canonical .cant file located on disk. */
  files: string[];
}

/**
 * Resolve the absolute paths to all canonical .cant files inside the
 * `@cleocode/agents` package.
 *
 * Mirrors the multi-candidate resolution used by `resolveSeedAgentsDir` in
 * `packages/core/src/init.ts` so the same code path works across npm install,
 * workspace dev, and bundled CLI layouts.
 *
 * @returns Object containing the resolved directories plus the flat list of
 *   .cant files that exist on disk.  Missing files are silently skipped —
 *   callers receive a reduced list rather than an error.
 */
export async function resolveCanonicalCantFiles(): Promise<CanonicalCantFiles> {
  const agentsRoot = await resolveAgentsPackageRoot();

  if (agentsRoot === null) {
    return {
      seedAgentsDir: null,
      cleoSubagentFile: null,
      metaDir: null,
      files: [],
    };
  }

  const seedAgentsDir = join(agentsRoot, 'seed-agents');
  const metaDir = join(agentsRoot, 'meta');
  const cleoSubagentFile = join(agentsRoot, 'cleo-subagent.cant');

  const files: string[] = [];

  if (existsSync(cleoSubagentFile)) {
    files.push(cleoSubagentFile);
  }

  if (existsSync(seedAgentsDir) && statSync(seedAgentsDir).isDirectory()) {
    for (const f of CANONICAL_SEED_FILES) {
      const candidate = join(seedAgentsDir, f);
      if (existsSync(candidate)) files.push(candidate);
    }
  }

  if (existsSync(metaDir) && statSync(metaDir).isDirectory()) {
    for (const f of CANONICAL_META_FILES) {
      const candidate = join(metaDir, f);
      if (existsSync(candidate)) files.push(candidate);
    }
  }

  return {
    seedAgentsDir: existsSync(seedAgentsDir) ? seedAgentsDir : null,
    metaDir: existsSync(metaDir) ? metaDir : null,
    cleoSubagentFile: existsSync(cleoSubagentFile) ? cleoSubagentFile : null,
    files,
  };
}

/**
 * Locate the `@cleocode/agents` package root via `require.resolve` first, and
 * fall back to walking the workspace layout (mirroring
 * `resolveSeedAgentsDir`).
 *
 * @returns Absolute path to the agents package root, or `null` if no
 *   candidate exists on disk.
 */
async function resolveAgentsPackageRoot(): Promise<string | null> {
  // Primary: resolve via Node module resolution
  try {
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const agentsPkgMain = req.resolve('@cleocode/agents/package.json');
    const { dirname } = await import('node:path');
    const candidate = dirname(agentsPkgMain);
    if (existsSync(candidate)) {
      // Sanity check — the package root should contain seed-agents or
      // cleo-subagent.cant.
      if (
        existsSync(join(candidate, 'seed-agents')) ||
        existsSync(join(candidate, 'cleo-subagent.cant'))
      ) {
        return candidate;
      }
    }
  } catch {
    // Fall through to workspace fallback.
  }

  // Workspace fallback — re-use the same candidate ladder as
  // resolveSeedAgentsDir but walk one level higher because we want the
  // package root, not the seed-agents subdir.
  const { getPackageRoot } = await import('../scaffold.js');
  const packageRoot = getPackageRoot();
  const candidates = [
    join(packageRoot, 'agents'),
    join(packageRoot, '..', 'agents'),
    join(packageRoot, '..', '..', 'agents'),
    join(packageRoot, '..', '..', 'packages', 'agents'),
    join(packageRoot, '..', '..', '..', 'packages', 'agents'),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

// ---------------------------------------------------------------------------
// Public entry point — sync canonical sigils
// ---------------------------------------------------------------------------

/**
 * Populate the `sigils` table with one row per canonical CANT agent.
 *
 * Idempotent — re-running upserts the same rows in place. Returns a summary
 * of what was synced so callers (init flow, CLI command) can report progress.
 *
 * @returns A {@link SigilSyncResult} summarising the upserts and any
 *   warnings (e.g. missing files).
 */
export async function syncCanonicalSigils(): Promise<SigilSyncResult> {
  const warnings: string[] = [];
  const resolved = await resolveCanonicalCantFiles();

  if (resolved.files.length === 0) {
    warnings.push('@cleocode/agents package root not resolvable; no sigils synced');
    return {
      count: 0,
      peerIds: [],
      seedAgentsDir: resolved.seedAgentsDir,
      cleoSubagentFile: resolved.cleoSubagentFile,
      metaDir: resolved.metaDir,
      warnings,
    };
  }

  const nexusDb = await getNexusDb();
  const peerIds: string[] = [];

  for (const cantFile of resolved.files) {
    let parsed: ParsedSigil | null;
    try {
      parsed = parseSigilFromCant(cantFile);
    } catch (err) {
      warnings.push(
        `failed to parse ${cantFile}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    if (parsed === null) {
      warnings.push(`no agent declaration found in ${cantFile}`);
      continue;
    }

    const capabilityFlags = JSON.stringify({
      tier: parsed.tier,
      parent: parsed.parent,
      model: parsed.model,
      persist: parsed.persist,
    });

    await upsertSigil(nexusDb, {
      peerId: parsed.peerId,
      cantFile: parsed.cantFile,
      displayName: parsed.peerId,
      role: parsed.role,
      systemPromptFragment: parsed.systemPromptFragment,
      capabilityFlags,
    });

    peerIds.push(parsed.peerId);
  }

  peerIds.sort((a, b) => a.localeCompare(b));

  return {
    count: peerIds.length,
    peerIds,
    seedAgentsDir: resolved.seedAgentsDir,
    cleoSubagentFile: resolved.cleoSubagentFile,
    metaDir: resolved.metaDir,
    warnings,
  };
}

/**
 * Reset the nexus DB singleton — re-exported so callers (notably tests) can
 * isolate state without reaching into another module.  This is a thin
 * passthrough; the actual implementation lives in
 * `packages/core/src/store/nexus-sqlite.ts`.
 */
export { resetNexusDbState };

// SSoT-EXEMPT:engine-migration-T1569
export async function nexusSigilSync(): Promise<EngineResult<SigilSyncResult>> {
  try {
    const result = await syncCanonicalSigils();
    return engineSuccess(result);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}
