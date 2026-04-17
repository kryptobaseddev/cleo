/**
 * Atomic agent install pipeline.
 *
 * Validates a `.cant` source, computes its SHA-256, copies it to the target
 * tier directory, and writes an `agents` row + `agent_skills` junctions in
 * ONE SQLite transaction. On any failure the transaction is rolled back and
 * the filesystem is rewound to its pre-call state (newly-copied file is
 * removed if we own it), leaving DB + FS unchanged.
 *
 * The install function takes an already-open handle to the GLOBAL
 * `signaldock.db` (i.e. the target of `openGlobalDb()` in
 * `agent-registry-accessor.ts`) rather than opening its own, so composite
 * workflows (seed-install, `cleo agent attach`) can batch multiple installs
 * under a single DB handle. Project attachment (`conduit.db:project_agent_refs`)
 * is orthogonal and is not performed here — callers that want to attach a
 * just-installed agent to the current project should follow up with
 * `attachAgentToProject(projectRoot, agentId)` from
 * `agent-registry-accessor.ts`.
 *
 * A minimal local `.cant` field-extractor is used instead of depending on
 * `@cleocode/cant`, which would introduce a circular package dependency
 * (`@cleocode/cant` already depends on `@cleocode/core`). The extractor
 * recognises the top-level `agent <name>:` header, the trailing key/value
 * block, and the specific fields (`role`, `parent`, `skills`) that drive the
 * v3 registry columns. Anything more elaborate is intentionally out of
 * scope; downstream validation remains the responsibility of the CANT
 * linter and the `cleo agent doctor` walk.
 *
 * @module agent-install
 * @task T889 / W2-3
 * @epic T889
 */

import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AgentRegistryExtendedFields, AgentSkillSource, AgentTier } from '@cleocode/contracts';
import { getCleoGlobalAgentsDir } from '../paths.js';

// ---------------------------------------------------------------------------
// Public API shapes
// ---------------------------------------------------------------------------

/**
 * Input to {@link installAgentFromCant}.
 *
 * @task T889 / W2-3
 */
export interface InstallAgentFromCantInput {
  /** Absolute path to the source `.cant` file to install. */
  cantSource: string;
  /** Target tier: `'global'` writes to {@link getCleoGlobalAgentsDir}; `'project'` writes to `<projectRoot>/.cleo/cant/agents/`. */
  targetTier: Extract<AgentTier, 'global' | 'project'>;
  /** Provenance tag written to `agents.installed_from`. */
  installedFrom: 'seed' | 'user' | 'manual';
  /** Absolute path to the project root (required when `targetTier === 'project'`). */
  projectRoot?: string;
  /** Override the destination directory for `'global'` installs (defaults to {@link getCleoGlobalAgentsDir}). */
  globalCantDir?: string;
  /** When `true`, overwrite an existing row/file instead of throwing. */
  force?: boolean;
}

/**
 * Result returned from {@link installAgentFromCant} on success.
 *
 * @task T889 / W2-3
 */
export interface InstallAgentFromCantResult {
  /** Business identifier (`agents.agent_id`) of the installed agent. */
  agentId: string;
  /** Absolute destination path after the copy. */
  cantPath: string;
  /** SHA-256 checksum of the copied `.cant` bytes (hex-encoded). */
  cantSha256: string;
  /** Tier the row was installed at. */
  tier: AgentTier;
  /** `true` when this call INSERTED a new row, `false` when it UPDATED an existing row. */
  inserted: boolean;
  /** Skill slugs resolved from the agent's `skills` field. */
  skillsAttached: string[];
  /** Non-fatal warnings (e.g. unknown skill slugs). */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Parsed `.cant` shape (minimal, purpose-built for install)
// ---------------------------------------------------------------------------

/**
 * The subset of a `.cant` agent declaration that the installer needs. Any
 * additional fields on the source manifest are tolerated and ignored.
 *
 * @task T889 / W2-3
 */
interface ParsedCantAgent {
  name: string;
  role: string | null;
  parent: string | null;
  skills: string[];
}

// ---------------------------------------------------------------------------
// Helpers — kebab-case validation, SHA-256, role → orch_level/can_spawn
// ---------------------------------------------------------------------------

const KEBAB_CASE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * Compute the hex-encoded SHA-256 checksum of the supplied bytes.
 *
 * @param bytes - Raw buffer whose digest to compute.
 * @returns 64-character lowercase hex string.
 * @task T889 / W2-3
 */
function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Derive `can_spawn` + `orch_level` from a `.cant` `role` value.
 *
 * Role aliases recognised:
 * - `'orchestrator'` → level 0, may spawn
 * - `'lead'`, `'supervisor'` → level 1, may spawn
 * - any other string (or `null`) → level 2, terminal worker
 *
 * @param role - Role field from the parsed `.cant` manifest.
 * @returns Spawn capability and orchestration level.
 * @task T889 / W2-3
 */
function deriveSpawnFromRole(role: string | null): { canSpawn: boolean; orchLevel: number } {
  if (role === 'orchestrator') return { canSpawn: true, orchLevel: 0 };
  if (role === 'lead' || role === 'supervisor') return { canSpawn: true, orchLevel: 1 };
  return { canSpawn: false, orchLevel: 2 };
}

/**
 * Extract the `agent <name>:` header from a `.cant` source and read the
 * indented key/value block that follows. Only the fields the installer
 * requires are lifted; the rest are ignored. Returns `null` when no
 * recognisable agent section is present.
 *
 * The parser is deliberately conservative:
 * - frontmatter (`--- ... ---`) is stripped before scanning
 * - string values wrapped in `"..."` are unquoted
 * - JSON-style arrays (`skills: ["a", "b"]`) are parsed directly
 * - YAML-style arrays (`skills: [a, b]` without quotes) are tolerated
 *
 * @param source - Raw `.cant` file contents.
 * @returns Parsed agent fields or `null` when no agent section is found.
 * @task T889 / W2-3
 */
function parseCantAgent(source: string): ParsedCantAgent | null {
  // Strip frontmatter so line-based indent detection is predictable.
  let body = source;
  if (body.startsWith('---')) {
    const end = body.indexOf('\n---', 3);
    if (end >= 0) {
      const afterFence = body.indexOf('\n', end + 4);
      body = afterFence >= 0 ? body.slice(afterFence + 1) : '';
    }
  }

  const headerMatch = body.match(/^\s*agent\s+([a-zA-Z][\w-]*)\s*:\s*$/m);
  if (!headerMatch) return null;
  const name = headerMatch[1] ?? '';
  if (!name) return null;

  const headerIndex = body.indexOf(headerMatch[0]);
  const lines = body.slice(headerIndex + headerMatch[0].length).split('\n');

  let role: string | null = null;
  let parent: string | null = null;
  let skills: string[] = [];

  for (const rawLine of lines) {
    // Stop at the next top-level declaration (no leading whitespace + colon)
    if (/^[a-zA-Z]/.test(rawLine)) break;
    const trimmed = rawLine.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const kv = trimmed.match(/^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = (kv[1] ?? '').trim();
    const value = (kv[2] ?? '').trim();
    if (key === 'role') {
      role = unquote(value) || null;
    } else if (key === 'parent') {
      parent = unquote(value) || null;
    } else if (key === 'skills') {
      skills = parseSkillsValue(value);
    }
  }

  return { name, role, parent, skills };
}

/**
 * Strip matching leading/trailing `"` or `'` from a scalar value.
 *
 * @param raw - Raw scalar text as lifted from the `.cant` source.
 * @returns Unquoted value.
 * @task T889 / W2-3
 */
function unquote(raw: string): string {
  if (raw.length >= 2) {
    const first = raw.charAt(0);
    const last = raw.charAt(raw.length - 1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return raw.slice(1, -1);
    }
  }
  return raw;
}

/**
 * Parse the right-hand side of `skills: ...` into a list of slugs. Accepts
 * JSON array literals (`["a","b"]`), bare YAML-ish lists (`[a, b]`), and
 * the empty form (`[]`).
 *
 * @param raw - Trimmed scalar following `skills:`.
 * @returns List of skill slugs (may be empty).
 * @task T889 / W2-3
 */
function parseSkillsValue(raw: string): string[] {
  if (!raw.startsWith('[') || !raw.endsWith(']')) return [];
  const inner = raw.slice(1, -1).trim();
  if (inner.length === 0) return [];
  return inner
    .split(',')
    .map((part) => unquote(part.trim()))
    .filter((part) => part.length > 0);
}

// ---------------------------------------------------------------------------
// Destination path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute destination path for an install.
 *
 * @param input   - Caller-supplied install options.
 * @param agentId - Business identifier of the agent being installed.
 * @returns Absolute path to the target `.cant` file.
 * @task T889 / W2-3
 */
function resolveDestinationPath(input: InstallAgentFromCantInput, agentId: string): string {
  if (input.targetTier === 'global') {
    const dir = input.globalCantDir ?? getCleoGlobalAgentsDir();
    return join(dir, `${agentId}.cant`);
  }
  if (!input.projectRoot) {
    throw new Error("installAgentFromCant: 'projectRoot' is required when targetTier='project'");
  }
  return join(input.projectRoot, '.cleo', 'cant', 'agents', `${agentId}.cant`);
}

// ---------------------------------------------------------------------------
// Atomic install pipeline
// ---------------------------------------------------------------------------

/**
 * Install an agent from a `.cant` source file: parse the manifest, copy the
 * file to the tier-appropriate location, and write the `agents` row +
 * `agent_skills` junctions in a single transaction.
 *
 * Safety properties:
 * - On parse / validation failure the transaction has not yet begun; the
 *   filesystem is untouched.
 * - On DB failure inside the transaction, the transaction is rolled back
 *   AND the destination file is removed if this call created it, restoring
 *   the pre-call state.
 * - `force: false` + an existing row throws `E_AGENT_ALREADY_INSTALLED`
 *   before any file I/O.
 *
 * The caller owns the `db` handle lifecycle; this function never calls
 * `db.close()`.
 *
 * @param db    - Open handle to global `signaldock.db`.
 * @param input - Install options (source path, tier, provenance, flags).
 * @returns Install result with the persisted agentId, digest, and tier.
 * @throws When the source is invalid, a duplicate row exists without
 *   `force`, or the DB/filesystem operation fails.
 * @task T889 / W2-3
 */
export function installAgentFromCant(
  db: DatabaseSync,
  input: InstallAgentFromCantInput,
): InstallAgentFromCantResult {
  // 1. Validate source file exists + is a .cant
  if (!existsSync(input.cantSource)) {
    throw new Error(`installAgentFromCant: source not found: ${input.cantSource}`);
  }
  if (extname(input.cantSource) !== '.cant') {
    throw new Error(`installAgentFromCant: source must be a .cant file: ${input.cantSource}`);
  }

  // 2. Read + compute SHA-256
  const sourceBytes = readFileSync(input.cantSource);
  const cantSha256 = sha256Hex(sourceBytes);
  const sourceText = sourceBytes.toString('utf8');

  // 3. Parse agent fields
  const parsed = parseCantAgent(sourceText);
  if (!parsed) {
    throw new Error(
      `installAgentFromCant: no agent section found in ${input.cantSource}. ` +
        `The file must contain a top-level 'agent <id>:' declaration.`,
    );
  }

  // 4. Validate agentId matches filename base + is kebab-case
  const agentId = parsed.name;
  const expectedBase = basename(input.cantSource, '.cant');
  if (agentId !== expectedBase) {
    throw new Error(
      `installAgentFromCant: agent name '${agentId}' must match the filename base '${expectedBase}'`,
    );
  }
  if (!KEBAB_CASE.test(agentId)) {
    throw new Error(
      `installAgentFromCant: agent name '${agentId}' must be kebab-case ([a-z][a-z0-9-]*)`,
    );
  }

  // 5. Resolve destination
  const destinationPath = resolveDestinationPath(input, agentId);
  const destinationDir = join(destinationPath, '..');

  // 6. Check existing row
  const existingRow = db.prepare('SELECT id FROM agents WHERE agent_id = ?').get(agentId) as
    | { id: string }
    | undefined;
  if (existingRow && !input.force) {
    throw new Error(
      `E_AGENT_ALREADY_INSTALLED: agent '${agentId}' is already registered. Pass force: true to overwrite.`,
    );
  }

  // 7. Soft-warn on unknown skill slugs + collect resolved skills
  const warnings: string[] = [];
  const skillRows = new Map<string, string>(); // slug → skill id
  for (const slug of parsed.skills) {
    const row = db.prepare('SELECT id FROM skills WHERE slug = ?').get(slug) as
      | { id: string }
      | undefined;
    if (row) {
      skillRows.set(slug, row.id);
    } else {
      warnings.push(`skill '${slug}' not found in local catalog — junction will be skipped`);
    }
  }

  // 8. Determine orchestration fields
  const { canSpawn, orchLevel } = deriveSpawnFromRole(parsed.role);
  const nowTs = Math.floor(Date.now() / 1000);
  const nowIso = new Date(nowTs * 1000).toISOString();

  // 9. Atomic transaction: copy file, INSERT/UPDATE agents, sync agent_skills.
  //    On ANY failure roll back the DB AND (if we own the destination file)
  //    unlink it, restoring pre-call state.
  const destinationExistedBefore = existsSync(destinationPath);
  let didCopyFile = false;
  db.exec('BEGIN IMMEDIATE TRANSACTION');
  try {
    if (!existsSync(destinationDir)) {
      mkdirSync(destinationDir, { recursive: true });
    }
    copyFileSync(input.cantSource, destinationPath);
    didCopyFile = true;

    const agentUuid = existingRow?.id ?? randomUUID();
    const inserted = !existingRow;

    if (inserted) {
      db.prepare(
        `INSERT INTO agents (
          id, agent_id, name, class, privacy_tier, capabilities, skills,
          transport_type, api_base_url, transport_config, is_active,
          status, created_at, updated_at, requires_reauth,
          tier, can_spawn, orch_level, reports_to,
          cant_path, cant_sha256, installed_from, installed_at
        ) VALUES (?, ?, ?, 'custom', 'public', '[]', ?, 'http',
          'https://api.signaldock.io', '{}', 1,
          'online', ?, ?, 0,
          ?, ?, ?, ?,
          ?, ?, ?, ?)`,
      ).run(
        agentUuid,
        agentId,
        agentId,
        JSON.stringify(parsed.skills),
        nowTs,
        nowTs,
        input.targetTier,
        canSpawn ? 1 : 0,
        orchLevel,
        parsed.parent,
        destinationPath,
        cantSha256,
        input.installedFrom,
        nowIso,
      );
    } else {
      db.prepare(
        `UPDATE agents SET
           skills = ?, updated_at = ?,
           tier = ?, can_spawn = ?, orch_level = ?, reports_to = ?,
           cant_path = ?, cant_sha256 = ?, installed_from = ?, installed_at = ?
         WHERE agent_id = ?`,
      ).run(
        JSON.stringify(parsed.skills),
        nowTs,
        input.targetTier,
        canSpawn ? 1 : 0,
        orchLevel,
        parsed.parent,
        destinationPath,
        cantSha256,
        input.installedFrom,
        nowIso,
        agentId,
      );
    }

    // Refresh agent_skills junctions with source='cant'.
    const cantSource: AgentSkillSource = 'cant';
    db.prepare('DELETE FROM agent_skills WHERE agent_id = ? AND source = ?').run(
      agentUuid,
      cantSource,
    );
    for (const [, skillId] of skillRows) {
      db.prepare(
        `INSERT OR IGNORE INTO agent_skills (agent_id, skill_id, source, attached_at)
         VALUES (?, ?, ?, ?)`,
      ).run(agentUuid, skillId, cantSource, nowIso);
    }

    db.exec('COMMIT');

    // Populate an AgentRegistryExtendedFields-shaped view for observability
    // (currently consumed only by callers that log install events).
    const extended: AgentRegistryExtendedFields = {
      tier: input.targetTier,
      canSpawn,
      orchLevel,
      reportsTo: parsed.parent,
      cantPath: destinationPath,
      cantSha256,
      installedFrom: input.installedFrom,
      installedAt: nowIso,
    };
    void extended;

    return {
      agentId,
      cantPath: destinationPath,
      cantSha256,
      tier: input.targetTier,
      inserted,
      skillsAttached: Array.from(skillRows.keys()),
      warnings,
    };
  } catch (err) {
    db.exec('ROLLBACK');
    if (didCopyFile && !destinationExistedBefore) {
      try {
        unlinkSync(destinationPath);
      } catch {
        // best-effort cleanup; do not mask the original error
      }
    }
    throw err;
  }
}
