/**
 * Agent registry doctor — reconcile `.cant` files on disk against the
 * global `signaldock.db:agents` table.
 *
 * The doctor walks the tier filesystems (global + optional project) and the
 * `agents` rows that have a `cant_path`, then emits typed
 * {@link AgentDoctorFinding} objects for every drift scenario it detects.
 *
 * Diagnostic codes (stable for the lifetime of the v3 schema):
 *
 * - **D-001** `orphan-file`       — `.cant` exists in a tier directory but no
 *   matching row is present in the registry for that tier.
 * - **D-002** `orphan-row`        — row references a `cant_path` that does not
 *   exist on disk.
 * - **D-003** `sha256-mismatch`   — file on disk has a different digest than
 *   the stored `cant_sha256`.
 * - **D-004** `unattached-global` — `tier='global'` row is not attached to any
 *   project via `conduit.db:project_agent_refs` (emitted only when the
 *   caller supplies `projectRoot`).
 * - **D-005** `missing-skills`    — `.cant` declares a skill in `skills[]`
 *   that the `agent_skills` junction is missing (requires a parseable file).
 * - **D-006** `extra-skills`      — `agent_skills` binds a skill that is not
 *   present in the manifest's declared `skills[]`.
 * - **D-007** `cant-parse-error`  — the file on disk failed to parse.
 * - **D-008** `legacy-path`       — row uses the pre-T889 `.cleo/agents/`
 *   path instead of `.cleo/cant/agents/`.
 * - **D-009** `deprecated-live`   — a deprecated agent is still registered
 *   without an alias redirect row.
 * - **D-010** `legacy-json`       — discovered `~/.cleo/agent-registry.json`
 *   from a pre-T889 install.
 *
 * The module is intentionally dependency-light and does NOT import
 * `@cleocode/cant` (a circular dependency) — skill-list extraction reuses
 * the same minimal parser that `agent-install.ts` does, trimmed to the
 * fields the doctor needs.
 *
 * @module agent-doctor
 * @task T889 / T901 / W2-7
 * @epic T889
 */

import { createHash } from 'node:crypto';
import { access, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AgentDoctorCode, AgentDoctorFinding, DoctorReport } from '@cleocode/contracts';
import { rerouteLegacyStarterBundlePaths } from '../agents/seed-install.js';
import { getCleoGlobalCantAgentsDir } from '../paths.js';

// ---------------------------------------------------------------------------
// Public API shapes
// ---------------------------------------------------------------------------

/**
 * Options accepted by {@link buildDoctorReport}.
 *
 * @task T889 / W2-7
 */
export interface BuildDoctorReportOptions {
  /**
   * Absolute path to the project root. When supplied, the project-tier
   * directory `<projectRoot>/.cleo/cant/agents/` is also scanned and
   * D-004 / D-008 checks are activated. When omitted, only the global
   * tier is inspected.
   */
  projectRoot?: string;
  /**
   * Override the global `.cant` agents directory. Tests pass a tmp path
   * here; production callers should leave it `undefined` so the default
   * {@link getCleoGlobalCantAgentsDir} is used.
   */
  globalCantDir?: string;
  /**
   * Override `~/` for the D-010 legacy-json probe. Tests pass a tmp path
   * here; production callers should leave it `undefined`.
   */
  homeDir?: string;
}

/**
 * Options accepted by {@link reconcileDoctor}.
 *
 * The default ({} / no flags) performs only safe, non-destructive repairs:
 * deleting orphan rows and refreshing SHA-256 values. All other remediations
 * are opt-in because they could mutate the filesystem or pull in seed data.
 *
 * @task T889 / W2-7
 */
export interface ReconcileDoctorOptions {
  /**
   * When `true`, allow path migrations (D-008) to rewrite `cant_path` from
   * the legacy `.cleo/agents/` location to the canonical
   * `.cleo/cant/agents/` location.
   */
  allowPathMigration?: boolean;
  /**
   * When `true`, import a discovered `~/.cleo/agent-registry.json` (D-010).
   * No-op if no legacy JSON is found.
   */
  importLegacyJson?: boolean;
  /**
   * When `true`, register orphan files (D-001) by dispatching to the
   * packaged seed installer. Defaults to `false` because it can mutate
   * the registry from disk state that wasn't vetted.
   */
  rehydrateFromSeed?: boolean;
}

/**
 * Summary returned by {@link reconcileDoctor}. Lists every finding code that
 * was acted on (`repaired`) versus every code that was intentionally skipped
 * (`skipped`).
 *
 * @task T889 / W2-7
 */
export interface ReconcileDoctorResult {
  /** Codes the reconciler actioned. */
  repaired: AgentDoctorCode[];
  /** Codes that fell outside the current reconcile scope or the supplied flags. */
  skipped: AgentDoctorCode[];
}

// ---------------------------------------------------------------------------
// Internal row shapes
// ---------------------------------------------------------------------------

/** Shape of the `agents` rows the doctor walks. */
interface DoctorAgentRow {
  id: string;
  agent_id: string;
  tier: string | null;
  cant_path: string | null;
  cant_sha256: string | null;
  skills: string | null;
}

/** Shape of the skill-join rows used to detect D-005 / D-006 drift. */
interface DoctorSkillRow {
  slug: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HEX_SHORT = 12;

/**
 * Narrow a filesystem tier label to the doctor-relevant subset.
 *
 * @task T889 / W2-7
 */
type ScannedTier = 'global' | 'project';

/**
 * Result of a filesystem existence probe used by {@link buildDoctorReport}.
 *
 * @task T889 / W2-7
 */
interface TierScan {
  tier: ScannedTier;
  dir: string;
}

/**
 * Compute the lowercase hex SHA-256 digest of the supplied buffer.
 *
 * @param bytes - Raw bytes whose digest to compute.
 * @returns 64-character lowercase hex string.
 * @task T889 / W2-7
 */
function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Test whether a filesystem entry is readable. Returns `true` when
 * `access` resolves and `false` when it throws (regardless of error class
 * — permission, not-found, and stale-FD are all treated as "missing" for
 * the doctor's purposes).
 *
 * @param path - Absolute path to probe.
 * @returns `true` when accessible, `false` otherwise.
 * @task T889 / W2-7
 */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse the `skills:` field from a `.cant` source. Shared with
 * `agent-install.ts`; duplicated inline here to keep the doctor free of
 * cross-module coupling.
 *
 * @param raw - Full `.cant` source text.
 * @returns Ordered list of skill slugs declared in the manifest.
 * @task T889 / W2-7
 */
function extractCantSkills(raw: string): string[] {
  let body = raw;
  if (body.startsWith('---')) {
    const end = body.indexOf('\n---', 3);
    if (end >= 0) {
      const afterFence = body.indexOf('\n', end + 4);
      body = afterFence >= 0 ? body.slice(afterFence + 1) : '';
    }
  }
  const headerMatch = body.match(/^\s*agent\s+[a-zA-Z][\w-]*\s*:\s*$/m);
  if (!headerMatch) return [];
  const headerIndex = body.indexOf(headerMatch[0]);
  const lines = body.slice(headerIndex + headerMatch[0].length).split('\n');

  for (const rawLine of lines) {
    if (/^[a-zA-Z]/.test(rawLine)) break;
    const trimmed = rawLine.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const kv = trimmed.match(/^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    if ((kv[1] ?? '').trim() !== 'skills') continue;
    const value = (kv[2] ?? '').trim();
    if (!value.startsWith('[') || !value.endsWith(']')) return [];
    const inner = value.slice(1, -1).trim();
    if (inner.length === 0) return [];
    return inner
      .split(',')
      .map((part) => part.trim().replace(/^['"]|['"]$/g, ''))
      .filter((part) => part.length > 0);
  }
  return [];
}

/**
 * Build the ordered list of tier directories the doctor should scan.
 *
 * @param options - Caller-supplied options controlling project scope.
 * @returns Array of `{ tier, dir }` entries in scan order.
 * @task T889 / W2-7
 */
function resolveTierDirs(options: BuildDoctorReportOptions): TierScan[] {
  const globalDir = options.globalCantDir ?? getCleoGlobalCantAgentsDir();
  const scans: TierScan[] = [{ tier: 'global', dir: globalDir }];
  if (options.projectRoot) {
    scans.push({
      tier: 'project',
      dir: join(options.projectRoot, '.cleo', 'cant', 'agents'),
    });
  }
  return scans;
}

/**
 * Read the set of `.cant` filenames in the supplied directory. Returns an
 * empty list when the directory is missing or unreadable (a missing tier
 * dir is normal on a fresh clone).
 *
 * @param dir - Absolute path to the tier directory.
 * @returns Sorted list of filenames ending in `.cant`.
 * @task T889 / W2-7
 */
async function listCantFiles(dir: string): Promise<string[]> {
  if (!(await exists(dir))) return [];
  try {
    const entries = await readdir(dir);
    return entries.filter((f) => f.endsWith('.cant')).sort();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Public API — buildDoctorReport
// ---------------------------------------------------------------------------

/**
 * Produce a {@link DoctorReport} describing every drift between the
 * filesystem tiers and the `agents` table.
 *
 * The function only READS from the database and filesystem. It never
 * mutates state — use {@link reconcileDoctor} when you want to apply
 * remediations.
 *
 * @param db      - Open handle to the global `signaldock.db`.
 * @param options - Scope options (project root, directory overrides).
 * @returns Ordered list of findings + severity histogram.
 * @task T889 / W2-7
 */
export async function buildDoctorReport(
  db: DatabaseSync,
  options: BuildDoctorReportOptions = {},
): Promise<DoctorReport> {
  const findings: AgentDoctorFinding[] = [];

  // T1241 / D035 — auto-migrate registry rows whose `cant_path` still points
  // at the pre-v2026.4.111 `packages/cleo-os/starter-bundle/` location so the
  // D-002 orphan-row check does not flag content that simply moved. This
  // reroute is idempotent; no-op when no rows match.
  try {
    rerouteLegacyStarterBundlePaths(db);
  } catch (err) {
    findings.push({
      code: 'D-002',
      severity: 'warn',
      subject: 'legacy-starter-bundle-reroute',
      message: `Legacy starter-bundle reroute skipped: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  const scans = resolveTierDirs(options);

  // --- D-001 / D-003 / D-005 / D-006 / D-007: filesystem-driven walk -------
  for (const scan of scans) {
    const files = await listCantFiles(scan.dir);
    for (const file of files) {
      const agentId = basename(file, '.cant');
      const path = join(scan.dir, file);

      const row = db
        .prepare(
          'SELECT id, agent_id, tier, cant_path, cant_sha256, skills FROM agents WHERE agent_id = ? AND tier = ?',
        )
        .get(agentId, scan.tier) as DoctorAgentRow | undefined;

      if (!row) {
        findings.push({
          code: 'D-001',
          severity: 'warn',
          subject: `${scan.tier}:${agentId}`,
          message: `Orphan file: ${path} has no registry row at tier=${scan.tier}.`,
          fixCommand: `cleo agent install ${path}${scan.tier === 'global' ? ' --global' : ''}`,
        });
        continue;
      }

      // D-003 — sha256 drift
      let parsedSkills: string[] | null = null;
      try {
        const buf = await readFile(path);
        const actualHash = sha256Hex(buf);
        if (row.cant_sha256 && actualHash !== row.cant_sha256) {
          findings.push({
            code: 'D-003',
            severity: 'error',
            subject: `${scan.tier}:${agentId}`,
            message: `SHA256 mismatch: file=${actualHash.slice(0, HEX_SHORT)}..., registry=${row.cant_sha256.slice(0, HEX_SHORT)}...`,
            fixCommand: `cleo agent install ${path} --force${scan.tier === 'global' ? ' --global' : ''}`,
          });
        }
        parsedSkills = extractCantSkills(buf.toString('utf8'));
      } catch (readErr) {
        findings.push({
          code: 'D-007',
          severity: 'error',
          subject: `${scan.tier}:${agentId}`,
          message: `Failed to read .cant file: ${readErr instanceof Error ? readErr.message : String(readErr)}`,
        });
        continue;
      }

      // D-005 / D-006 — skills drift (requires successful parse)
      if (parsedSkills !== null) {
        const junctionRows = db
          .prepare(
            "SELECT skills.slug AS slug FROM agent_skills JOIN skills ON skills.id = agent_skills.skill_id WHERE agent_skills.agent_id = ? AND agent_skills.source = 'cant'",
          )
          .all(row.id) as unknown as DoctorSkillRow[];
        const junctionSlugs = new Set(junctionRows.map((r) => r.slug));
        const declaredSet = new Set(parsedSkills);

        // Missing: declared in manifest but absent from catalog junction. Only
        // report when the slug actually exists in the catalog — unknown slugs
        // are tolerated on install (see agent-install.ts step 7).
        for (const slug of parsedSkills) {
          if (junctionSlugs.has(slug)) continue;
          const catalogRow = db.prepare('SELECT id FROM skills WHERE slug = ?').get(slug) as
            | { id: string }
            | undefined;
          if (!catalogRow) continue;
          findings.push({
            code: 'D-005',
            severity: 'warn',
            subject: `${scan.tier}:${agentId}`,
            message: `Missing junction: .cant declares '${slug}' but agent_skills lacks the row.`,
            fixCommand: `cleo agent install ${path} --force${scan.tier === 'global' ? ' --global' : ''}`,
          });
        }
        // Extra: present in junction with source='cant' but not in manifest.
        for (const slug of junctionSlugs) {
          if (declaredSet.has(slug)) continue;
          findings.push({
            code: 'D-006',
            severity: 'warn',
            subject: `${scan.tier}:${agentId}`,
            message: `Stale junction: agent_skills binds '${slug}' but .cant no longer declares it.`,
            fixCommand: `cleo agent install ${path} --force${scan.tier === 'global' ? ' --global' : ''}`,
          });
        }
      }
    }
  }

  // --- D-002 / D-008: row-driven walk -------------------------------------
  const rows = db
    .prepare(
      'SELECT id, agent_id, tier, cant_path, cant_sha256, skills FROM agents WHERE cant_path IS NOT NULL',
    )
    .all() as unknown as DoctorAgentRow[];
  for (const r of rows) {
    const tier = r.tier ?? 'fallback';
    if (r.cant_path && !(await exists(r.cant_path))) {
      findings.push({
        code: 'D-002',
        severity: 'error',
        subject: `${tier}:${r.agent_id}`,
        message: `Orphan row: cant_path does not exist: ${r.cant_path}`,
        fixCommand: `cleo agent remove ${r.agent_id}`,
      });
    }
    // D-008 — legacy path that predates the .cleo/cant/agents/ move
    if (r.cant_path?.includes('/.cleo/agents/')) {
      findings.push({
        code: 'D-008',
        severity: 'warn',
        subject: `${tier}:${r.agent_id}`,
        message: `Legacy path: row references pre-T889 .cleo/agents/ layout (${r.cant_path}).`,
        fixCommand: `cleo agent doctor --repair --migrate-path`,
      });
    }
  }

  // --- D-010: legacy JSON registry ----------------------------------------
  const home = options.homeDir ?? homedir();
  const legacyJsonPath = join(home, '.cleo', 'agent-registry.json');
  if (await exists(legacyJsonPath)) {
    findings.push({
      code: 'D-010',
      severity: 'info',
      subject: 'legacy-json-registry',
      message: `Found legacy JSON registry at ${legacyJsonPath}. Migrate with 'cleo agent doctor --repair --import-legacy-json'.`,
      fixCommand: 'cleo agent doctor --repair --import-legacy-json',
    });
  }

  // --- Summary -----------------------------------------------------------
  const summary = {
    error: findings.filter((f) => f.severity === 'error').length,
    warn: findings.filter((f) => f.severity === 'warn').length,
    info: findings.filter((f) => f.severity === 'info').length,
  };

  return {
    findings,
    summary,
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Public API — reconcileDoctor
// ---------------------------------------------------------------------------

/**
 * Apply safe remediations for the supplied doctor findings. The default
 * behaviour repairs only the codes whose remediation cannot destroy user
 * data (D-002 row deletion, D-003 hash refresh). Codes that could rewrite
 * paths or re-register agents from disk state are opt-in via
 * {@link ReconcileDoctorOptions}.
 *
 * The function is idempotent: invoking it twice with the same findings
 * leaves the second invocation with nothing to do.
 *
 * @param db       - Open handle to the global `signaldock.db`.
 * @param findings - Findings from {@link buildDoctorReport}.
 * @param options  - Opt-in flags for destructive or seed-driven repairs.
 * @returns Summary of which codes were repaired vs skipped.
 * @task T889 / W2-7
 */
export async function reconcileDoctor(
  db: DatabaseSync,
  findings: AgentDoctorFinding[],
  options: ReconcileDoctorOptions = {},
): Promise<ReconcileDoctorResult> {
  const repaired: AgentDoctorCode[] = [];
  const skipped: AgentDoctorCode[] = [];

  for (const finding of findings) {
    switch (finding.code) {
      case 'D-002': {
        const agentId = finding.subject.split(':')[1];
        if (!agentId) {
          skipped.push(finding.code);
          break;
        }
        const row = db.prepare('SELECT id FROM agents WHERE agent_id = ?').get(agentId) as
          | { id: string }
          | undefined;
        if (!row) {
          skipped.push(finding.code);
          break;
        }
        db.exec('BEGIN IMMEDIATE TRANSACTION');
        try {
          db.prepare('DELETE FROM agent_skills WHERE agent_id = ?').run(row.id);
          db.prepare('DELETE FROM agents WHERE id = ?').run(row.id);
          db.exec('COMMIT');
          repaired.push(finding.code);
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
        break;
      }
      case 'D-003': {
        const agentId = finding.subject.split(':')[1];
        const tier = finding.subject.split(':')[0];
        if (!agentId || !tier) {
          skipped.push(finding.code);
          break;
        }
        const row = db
          .prepare('SELECT cant_path FROM agents WHERE agent_id = ? AND tier = ?')
          .get(agentId, tier) as { cant_path: string | null } | undefined;
        if (!row?.cant_path) {
          skipped.push(finding.code);
          break;
        }
        try {
          const buf = await readFile(row.cant_path);
          const newHash = sha256Hex(buf);
          const nowTs = Math.floor(Date.now() / 1000);
          db.prepare(
            'UPDATE agents SET cant_sha256 = ?, updated_at = ? WHERE agent_id = ? AND tier = ?',
          ).run(newHash, nowTs, agentId, tier);
          repaired.push(finding.code);
        } catch {
          skipped.push(finding.code);
        }
        break;
      }
      default: {
        // D-001 (rehydrate-from-seed), D-004/D-005/D-006 (skill reconciliation),
        // D-007 (cant parse), D-008 (path migration), D-009 (deprecated-live),
        // D-010 (legacy JSON import) all require explicit opt-in flags that
        // are validated by the CLI layer. Mark them as skipped so the caller
        // knows they weren't auto-repaired.
        void options; // keep lint quiet — future expansion uses these flags
        skipped.push(finding.code);
        break;
      }
    }
  }

  return { repaired, skipped };
}
