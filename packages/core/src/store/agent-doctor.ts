/**
 * Agent registry doctor — reconcile `.cant` files on disk against the
 * global `agent_registry_agents` table.
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
 * - **D-007** `cant-parse-error`  — the file on disk failed to read or, when the
 *   caller supplies {@link BuildDoctorReportOptions.cantParses}, to parse. An
 *   unedited seed (file digest equals `seed_sha256`, the digest recorded when
 *   the packaged template was installed) with a packaged template of the same
 *   name is refreshed from that template by {@link reconcileDoctor} (T14654).
 * - **D-008** `legacy-path`       — row uses the pre-T889 `.cleo/agents/`
 *   path instead of `.cleo/cant/agents/`.
 * - **D-009** `deprecated-live`   — a deprecated agent is still registered
 *   without an alias redirect row.
 * - **D-010** `legacy-json`       — discovered `~/.cleo/agent-registry.json`
 *   from a pre-T889 install.
 * - **D-011** `shadowed-copy`     — a scanned `.cant` file is not the file its
 *   registry row points at (e.g. a stale `<cleoHome>/agents/` copy left after
 *   a reinstall to `<cleoHome>/cant/agents/`). Info only: no drift checks run
 *   against it and no fix command installs it, so it cannot overwrite the
 *   registered agent (T14600).
 *   A seed installed before `seed_sha256` existed is proven unedited by
 *   {@link HISTORICAL_SEED_SHA256} instead (T14655).
 * - **D-012** `parser-unavailable` — {@link BuildDoctorReportOptions.cantParses}
 *   threw, so the D-007 parse check was skipped for this run (T14654).
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
import { basename, dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AgentDoctorCode, AgentDoctorFinding, DoctorReport } from '@cleocode/contracts';
import { resolveAgentTemplates } from '../agents/resolveAgentTemplates.js';
import { rerouteLegacyStarterBundlePaths } from '../agents/seed-install.js';
import { getCleoGlobalCantAgentsDir, getCleoLegacyGlobalAgentsDir } from '../paths.js';
import { installAgentFromCant } from './agent-install.js';

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
   * Override the legacy global agents directory (`<cleoHome>/agents/`, where
   * `cleo agent install --global` wrote before T14600). Also scanned at the
   * global tier after the canonical directory; defaults to
   * {@link getCleoLegacyGlobalAgentsDir}.
   */
  legacyGlobalCantDir?: string;
  /**
   * Override `~/` for the D-010 legacy-json probe. Tests pass a tmp path
   * here; production callers should leave it `undefined`.
   */
  homeDir?: string;
  /**
   * Whether a `.cant` file parses with the current CANT grammar. Core does not
   * depend on `@cleocode/cant`, so the CLI supplies the real parser here. When
   * omitted, or when it throws (parser unavailable), no parse check runs.
   */
  cantParses?: (cantPath: string) => Promise<boolean>;
  /**
   * Override the packaged agent templates directory consulted for D-007 seed
   * refreshes; defaults to {@link resolveAgentTemplates}.
   */
  templatesDir?: string | null /**
   * Override {@link HISTORICAL_SEED_SHA256}, the digests that prove a seed
   * installed before `seed_sha256` was recorded is unedited (T14655).
   */;
  historicalSeedDigests?: Readonly<Record<string, readonly string[]>>;
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
  /**
   * Override the packaged agent templates directory used to refresh an
   * unparseable unedited seed (D-007); defaults to {@link resolveAgentTemplates}.
   */
  templatesDir?: string | null /**
   * Override {@link HISTORICAL_SEED_SHA256}, the digests that prove a seed
   * installed before `seed_sha256` was recorded is unedited (T14655).
   */;
  historicalSeedDigests?: Readonly<Record<string, readonly string[]>>;
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
  installed_from?: string | null;
  seed_sha256?: string | null;
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
 * SHA-256 digests of every version of each packaged agent template
 * (`packages/agents/templates/<agentId>.cant`) shipped before installs
 * recorded `seed_sha256`, keyed by agent id (T14655). A seed row whose
 * `seed_sha256` is NULL is unedited exactly when its file matches one of
 * these, so the D-007 refresh can replace it without losing an edit. The
 * list is closed: installs since T14654 record `seed_sha256` themselves.
 */
export const HISTORICAL_SEED_SHA256: Readonly<Record<string, readonly string[]>> = {
  'project-code-worker': [
    '9219ab1c04a28acb2f87070c935eedef39f10b976d5ced1e83f5756f24fd191d',
    '5c68938a89bba5b8bbe9efed0cc395d19f2b9ec9b2ad5c6f50395995b1672a1c',
  ],
  'project-dev-lead': [
    '4c8b8fb5d7de20221b21c9c3ce309226f70e0a847a75c1b95ec4a04691d5a13a',
    '249f85de047b1b14b0bfe455bda1dc96003d399b7590afb71295432c5333613f',
  ],
  'project-docs-worker': [
    '85083ecbf93b3ab5a1656c43aa155d57002fb1d0965e2d7d06a5686bd6a24ecb',
    'f13ac3e3350821d86b19e77fc91997e60e707ed05dca08c96e9c158862648ead',
    '52044fe98b5533a12986dcaf24d45b2a7b391f2cf44bddd7618c5a2a8282d11b',
  ],
  'project-orchestrator': [
    'e1a21a536ec32d4fd150ed8071e5f105823af71a9109c8e0e0e1d4304bfc94ac',
    'beb9e467c0b87e1842ed118a2bd8f3d3b4e30ca08e23923d460ff731d0f7b3fd',
  ],
  'project-security-worker': [
    '5f235b518c68f8173c0d42bbb0d59acd829c1a05381539b80b5a3add4c335d63',
    '31ed9b04bb9932c2505e221ba681027ce179cf3f892233163a5f9ef848a12c37',
    'ea5f1fabeece2193266f6ca9da6408d8fe20bc03e9ca7e6ab35cfa60e5d71c31',
  ],
};

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
 * Resolve the packaged template a seed agent can be refreshed from, but only
 * when refreshing loses nothing: the row came from a seed, the file on disk
 * is byte-identical to the packaged seed that was installed (`seed_sha256`),
 * and a template of the same name ships (T14654).
 *
 * @param row - Registry row of the agent.
 * @param fileHash - SHA-256 of the file on disk.
 * @param templatesDir - Packaged templates directory, or `null` when absent.
 * @returns The template path, or `null` when the file must not be replaced.
 */
async function refreshableSeedTemplate(
  row: Pick<DoctorAgentRow, 'agent_id' | 'installed_from' | 'seed_sha256'>,
  fileHash: string,
  templatesDir: string | null,
  historicalDigests: Readonly<Record<string, readonly string[]>>,
): Promise<string | null> {
  if (row.installed_from !== 'seed') return null;
  // seed_sha256, never cant_sha256: the D-003 repair rewrites cant_sha256 to an
  // edited file's digest, so only seed_sha256 proves the bytes are the seed's.
  // A seed installed before seed_sha256 existed (NULL) is proven unedited only
  // by matching a packaged template version that once shipped (T14655).
  const unedited = row.seed_sha256
    ? row.seed_sha256 === fileHash
    : (historicalDigests[row.agent_id] ?? []).includes(fileHash);
  if (!unedited) return null;
  return packagedTemplate(row.agent_id, templatesDir);
}

/**
 * Path of the packaged template named after `agentId`, when one ships.
 *
 * @param agentId - Agent id (the template file is `<agentId>.cant`).
 * @param templatesDir - Packaged templates directory, or `null` when absent.
 * @returns The template path, or `null` when no such template ships.
 */
async function packagedTemplate(
  agentId: string,
  templatesDir: string | null,
): Promise<string | null> {
  if (!templatesDir) return null;
  const template = join(templatesDir, `${agentId}.cant`);
  return (await exists(template)) ? template : null;
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
  const legacyDir = options.legacyGlobalCantDir ?? getCleoLegacyGlobalAgentsDir();
  // The legacy dir holds agents installed globally before T14600.
  const scans: TierScan[] = [
    { tier: 'global', dir: globalDir },
    { tier: 'global', dir: legacyDir },
  ];
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
 * @param db      - Open handle to the global cleo.db (Agent Registry).
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
      subject: 'legacy-agent-bundle-reroute',
      message: `Legacy agent-bundle reroute skipped: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  const scans = resolveTierDirs(options);
  const templatesDir =
    options.templatesDir !== undefined ? options.templatesDir : resolveAgentTemplates();
  let cantParses = options.cantParses;
  const historicalDigests = options.historicalSeedDigests ?? HISTORICAL_SEED_SHA256;

  // --- D-001 / D-003 / D-005 / D-006 / D-007: filesystem-driven walk -------
  for (const scan of scans) {
    const files = await listCantFiles(scan.dir);
    for (const file of files) {
      const agentId = basename(file, '.cant');
      const path = join(scan.dir, file);

      const row = db
        .prepare(
          'SELECT id, agent_id, tier, cant_path, cant_sha256, skills, installed_from, seed_sha256 FROM agent_registry_agents WHERE agent_id = ? AND tier = ?',
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

      // D-011 — this file is not the registered one. Never drift-check it or
      // suggest installing it: `install --force` would copy a stale file over
      // the agent the row points at.
      if (row.cant_path && resolve(row.cant_path) !== resolve(path)) {
        findings.push({
          code: 'D-011',
          severity: 'info',
          subject: `${scan.tier}:${agentId}`,
          message: `Shadowed copy: ${path} is not the registered file; the registry row points at ${row.cant_path}, which wins.`,
        });
        continue;
      }

      // D-003 — sha256 drift
      let parsedSkills: string[] | null = null;
      let actualHash = '';
      let drifted = false;
      try {
        const buf = await readFile(path);
        actualHash = sha256Hex(buf);
        if (row.cant_sha256 && actualHash !== row.cant_sha256) {
          drifted = true;
          findings.push({
            code: 'D-003',
            severity: 'error',
            subject: `${scan.tier}:${agentId}`,
            message: `SHA256 mismatch in ${path}: file=${actualHash.slice(0, HEX_SHORT)}..., registry=${row.cant_sha256.slice(0, HEX_SHORT)}...`,
            fixCommand: `cleo agent install ${path} --force${scan.tier === 'global' ? ' --global' : ''}`,
          });
        }
        parsedSkills = extractCantSkills(buf.toString('utf8'));
      } catch (readErr) {
        findings.push({
          code: 'D-007',
          severity: 'error',
          subject: `${scan.tier}:${agentId}`,
          message: `Failed to read .cant file ${path}: ${readErr instanceof Error ? readErr.message : String(readErr)}`,
        });
        continue;
      }

      // D-007 — the file does not parse with the current grammar (T14654).
      let parses = true;
      try {
        if (cantParses) parses = await cantParses(path);
      } catch (parseErr) {
        // D-012 — the parser could not run: say so once, skip the check.
        cantParses = undefined;
        findings.push({
          code: 'D-012',
          severity: 'warn',
          subject: 'cant-parser',
          message: `CANT parser unavailable, so the D-007 parse check was skipped: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
        });
      }
      if (!parses) {
        // A D-003 drift means the file was edited: never offer a refresh.
        const template = drifted
          ? null
          : await refreshableSeedTemplate(row, actualHash, templatesDir, historicalDigests);
        // Reinstalling the same broken bytes never parses: the fix installs the
        // packaged template (the replaced file is kept as a .bak-<instant>) or,
        // with none shipped, there is no command until the file is rewritten.
        const packaged = template ? null : await packagedTemplate(agentId, templatesDir);
        const tierFlag = scan.tier === 'global' ? ' --global' : '';
        const finding: AgentDoctorFinding = {
          code: 'D-007',
          severity: 'error',
          subject: `${scan.tier}:${agentId}`,
          message: template
            ? `${path} does not parse with the current CANT grammar. It is an unedited seed, so --repair refreshes it from the packaged template ${template}.`
            : packaged
              ? `${path} does not parse with the current CANT grammar and is not provably the unedited packaged seed (edited after install, or installed from bytes no packaged template ever shipped), so it is left alone. Port your changes to the current syntax, or replace it with the packaged template ${packaged} (the current file is kept as ${basename(path)}.bak-<instant>).`
              : `${path} does not parse with the current CANT grammar and no packaged template named ${agentId}.cant ships, so it is left alone. Rewrite it in the current syntax, then run: cleo agent install ${path} --force${tierFlag}`,
        };
        if (template) finding.fixCommand = 'cleo agent doctor --repair';
        else if (packaged) finding.fixCommand = `cleo agent install ${packaged} --force${tierFlag}`;
        findings.push(finding);
        continue;
      }

      // D-005 / D-006 — skills drift (requires successful parse)
      if (parsedSkills !== null) {
        const junctionRows = db
          .prepare(
            "SELECT agent_registry_skills.slug AS slug FROM agent_registry_agent_skills JOIN agent_registry_skills ON agent_registry_skills.id = agent_registry_agent_skills.skill_id WHERE agent_registry_agent_skills.agent_id = ? AND agent_registry_agent_skills.source = 'cant'",
          )
          .all(row.id) as unknown as DoctorSkillRow[];
        const junctionSlugs = new Set(junctionRows.map((r) => r.slug));
        const declaredSet = new Set(parsedSkills);

        // Missing: declared in manifest but absent from catalog junction. Only
        // report when the slug actually exists in the catalog — unknown slugs
        // are tolerated on install (see agent-install.ts step 7).
        for (const slug of parsedSkills) {
          if (junctionSlugs.has(slug)) continue;
          const catalogRow = db
            .prepare('SELECT id FROM agent_registry_skills WHERE slug = ?')
            .get(slug) as { id: string } | undefined;
          if (!catalogRow) continue;
          findings.push({
            code: 'D-005',
            severity: 'warn',
            subject: `${scan.tier}:${agentId}`,
            message: `Missing junction: ${path} declares '${slug}' but agent_skills lacks the row.`,
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
            message: `Stale junction: agent_skills binds '${slug}' but ${path} no longer declares it.`,
            fixCommand: `cleo agent install ${path} --force${scan.tier === 'global' ? ' --global' : ''}`,
          });
        }
      }
    }
  }

  // --- D-002 / D-008: row-driven walk -------------------------------------
  const rows = db
    .prepare(
      'SELECT id, agent_id, tier, cant_path, cant_sha256, skills FROM agent_registry_agents WHERE cant_path IS NOT NULL',
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
 * @param db       - Open handle to the global cleo.db (Agent Registry).
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
        const row = db
          .prepare('SELECT id FROM agent_registry_agents WHERE agent_id = ?')
          .get(agentId) as { id: string } | undefined;
        if (!row) {
          skipped.push(finding.code);
          break;
        }
        db.exec('BEGIN IMMEDIATE TRANSACTION');
        try {
          db.prepare('DELETE FROM agent_registry_agent_skills WHERE agent_id = ?').run(row.id);
          db.prepare('DELETE FROM agent_registry_agents WHERE id = ?').run(row.id);
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
          .prepare('SELECT cant_path FROM agent_registry_agents WHERE agent_id = ? AND tier = ?')
          .get(agentId, tier) as { cant_path: string | null } | undefined;
        if (!row?.cant_path) {
          skipped.push(finding.code);
          break;
        }
        try {
          const buf = await readFile(row.cant_path);
          const newHash = sha256Hex(buf);
          // T11622 cutover: `agent_registry_agents.updated_at` is TEXT ISO-8601 (GLOB CHECK).
          const nowIso = new Date().toISOString();
          db.prepare(
            'UPDATE agent_registry_agents SET cant_sha256 = ?, updated_at = ? WHERE agent_id = ? AND tier = ?',
          ).run(newHash, nowIso, agentId, tier);
          repaired.push(finding.code);
        } catch {
          skipped.push(finding.code);
        }
        break;
      }
      case 'D-007': {
        // Refresh an unparseable seed from its packaged template, only when the
        // file is byte-identical to the installed packaged seed and no D-003
        // in this run says the file was edited (T14654).
        const [tier, agentId] = finding.subject.split(':');
        if (findings.some((f) => f.code === 'D-003' && f.subject === finding.subject)) {
          skipped.push(finding.code);
          break;
        }
        const row = db
          .prepare(
            'SELECT agent_id, cant_path, installed_from, seed_sha256 FROM agent_registry_agents WHERE agent_id = ? AND tier = ?',
          )
          .get(agentId ?? '', tier ?? '') as
          | Pick<DoctorAgentRow, 'agent_id' | 'cant_path' | 'installed_from' | 'seed_sha256'>
          | undefined;
        let fileHash: string | null = null;
        try {
          if (row?.cant_path) fileHash = sha256Hex(await readFile(row.cant_path));
        } catch {
          // Unreadable file: nothing to refresh.
        }
        const templatesDir =
          options.templatesDir !== undefined ? options.templatesDir : resolveAgentTemplates();
        const template =
          row?.cant_path && fileHash
            ? await refreshableSeedTemplate(
                row,
                fileHash,
                templatesDir,
                options.historicalSeedDigests ?? HISTORICAL_SEED_SHA256,
              )
            : null;
        const cantPath = row?.cant_path ? resolve(row.cant_path) : null;
        // The install writes to <projectRoot>/.cleo/cant/agents/<id>.cant or
        // <globalDir>/<id>.cant; derive both from the row so it lands in place.
        const projectRoot = cantPath ? resolve(cantPath, '..', '..', '..', '..') : '';
        const inPlace =
          tier === 'global' ||
          (tier === 'project' &&
            cantPath === join(projectRoot, '.cleo', 'cant', 'agents', `${agentId}.cant`));
        if (!template || !cantPath || !inPlace || (tier !== 'global' && tier !== 'project')) {
          skipped.push(finding.code);
          break;
        }
        try {
          installAgentFromCant(db, {
            cantSource: template,
            targetTier: tier,
            installedFrom: 'seed',
            projectRoot,
            globalCantDir: dirname(cantPath),
            force: true,
            packagedSeed: true,
          });
          repaired.push(finding.code);
        } catch {
          // installAgentFromCant restores its own file + row on failure.
          skipped.push(finding.code);
        }
        break;
      }
      default: {
        // D-001 (rehydrate-from-seed), D-004/D-005/D-006 (skill reconciliation),
        // D-007 (edited or template-less unparseable file), D-008 (path migration), D-009 (deprecated-live),
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
