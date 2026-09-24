/**
 * portable-bundle.ts — export side of the lossless machine-migration bundle
 * (manifest v2).
 *
 * Replaces the v1 pack path for `cleo backup export`. v1 snapshotted a fixed
 * list of pre-E6 filenames (`tasks.db`, `brain.db`, `nexus.db`, …); after the
 * E6 cutover (ADR-068) the live stores are the consolidated `cleo.db` files,
 * so v1 exported nothing of value and still reported success. v2:
 *
 * - snapshots the live primary store of every in-scope root with
 *   `VACUUM INTO` (read-only, consistent under WAL) and fails when a primary
 *   store is missing or unreadable;
 * - captures the rest of the root byte-for-byte, except an explicit denylist
 *   whose sizes are reported, and SQLite files, which are also snapshotted;
 * - includes secrets only in encrypted bundles, recording what was omitted
 *   and what the user must redo (each credential with its re-entry command);
 * - never carries the machine-key: encrypted bundles instead carry the
 *   credential VALUES sealed under the passphrase (`secrets/<section>.sealed`,
 *   T12326), which the importing device re-encrypts under its own key;
 * - records per-table row counts so import can prove the restore lossless.
 *
 * Archive layout:
 *   manifest.json                     FIRST entry
 *   checksums.sha256                  GNU sha256sum format over every other file
 *   global/home/<rel>                 <cleoHome> content
 *   global/config/<rel>               <configHome> content
 *   projects/<nnn>-<name>/cleo/<rel>  a project's .cleo/ content
 *   secrets/<section>.sealed          passphrase-sealed credentials (encrypted only)
 *
 * @task T12318
 * @epic T12317
 * @module store/portable-bundle
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import {
  type CredentialReentry,
  type CredentialStoreKind,
  ExitCode,
  type PortableBundleManifest,
  type PortableBundleScope,
  type PortableDatabaseEntry,
  type PortableExportResult,
  type PortableFileEntry,
  type PortableImportResult,
  type PortableProjectSection,
  type PortableSectionBase,
  type PortableSkippedProject,
  type PortableSkipReason,
  type PortableUnmigratedLegacyReport,
} from '@cleocode/contracts';
import { create as tarCreate } from 'tar';
import { getCleoConfigDir, getCleoHome } from '../paths.js';
import { getCleoVersion } from '../scaffold/ensure-config.js';
import { encryptFileStream } from './backup-crypto.js';
import {
  type CredentialSources,
  listCredentialsForReentry,
  sealCredentials,
} from './credential-transfer.js';
import { resolveDualScopeDbPath } from './dual-scope-db.js';
import {
  CONFIG_HOME_RULES,
  countRows,
  GLOBAL_HOME_RULES,
  LEGACY_STORE_BASENAMES,
  LEGACY_TABLE_MAP,
  MEMORY_TABLES,
  PRIMARY_STORE_BASENAME,
  PROJECT_SECTION_RULES,
  pickKeyCounts,
  redactCredentials,
  type SectionRules,
  scanSection,
  sha256File,
  vacuumSnapshot,
} from './portable-bundle-scan.js';

const _require = createRequire(import.meta.url);
type DatabaseSync = _DatabaseSyncType;
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => DatabaseSync;
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Symbolic error codes raised by the portable bundle export/import. */
export type PortableBundleErrorCode =
  | 'E_PRIMARY_STORE_MISSING'
  | 'E_PRIMARY_STORE_UNREADABLE'
  | 'E_NO_PROJECT'
  | 'E_REGISTRY_UNREADABLE'
  | 'E_PASSPHRASE_REQUIRED'
  | 'E_BUNDLE_DECRYPT'
  | 'E_BUNDLE_FORMAT'
  | 'E_BUNDLE_INTEGRITY'
  | 'E_DATA_EXISTS'
  | 'E_TARGET_AMBIGUOUS'
  | 'E_RESTORE_MISMATCH'
  | 'E_REDACTION_FAILED';

/**
 * Numeric exit codes for {@link PortableBundleErrorCode}. Decrypt / format /
 * integrity / data-exists keep the v1 bundle codes (ADR-038 §4.3) so scripts
 * written against v1 keep working; the rest reuse the shared `ExitCode` enum.
 */
export const PORTABLE_BUNDLE_EXIT_CODES: Readonly<Record<PortableBundleErrorCode, number>> = {
  E_PRIMARY_STORE_MISSING: ExitCode.NOT_FOUND,
  E_PRIMARY_STORE_UNREADABLE: ExitCode.FILE_ERROR,
  E_NO_PROJECT: ExitCode.NOT_FOUND,
  E_REGISTRY_UNREADABLE: ExitCode.FILE_ERROR,
  E_PASSPHRASE_REQUIRED: ExitCode.INVALID_INPUT,
  E_BUNDLE_DECRYPT: 70,
  E_BUNDLE_FORMAT: 71,
  E_BUNDLE_INTEGRITY: 72,
  E_DATA_EXISTS: 78,
  E_TARGET_AMBIGUOUS: ExitCode.INVALID_INPUT,
  E_RESTORE_MISMATCH: ExitCode.CHECKSUM_MISMATCH,
  E_REDACTION_FAILED: ExitCode.GENERAL_ERROR,
};

/**
 * Error raised by the portable bundle export/import. Carries a symbolic code
 * and an exit code so the CLI can emit a LAFS error envelope.
 */
export class PortableBundleError extends Error {
  /** Numeric process exit code. */
  public readonly exitCode: number;

  /**
   * @param code - Symbolic error code.
   * @param message - Human-readable description.
   * @param details - Structured context (e.g. the full import report on a mismatch).
   */
  constructor(
    public readonly code: PortableBundleErrorCode,
    message: string,
    public readonly details?: PortableImportResult,
  ) {
    super(message);
    this.name = 'PortableBundleError';
    this.exitCode = PORTABLE_BUNDLE_EXIT_CODES[code];
  }
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** Input for {@link exportPortableBundle}. */
export interface ExportPortableBundleInput {
  /** Export scope. */
  scope: PortableBundleScope;
  /** Project root (required for `project` / `all`). */
  projectRoot?: string;
  /** Output bundle path. */
  outputPath: string;
  /** Advisory label recorded in the manifest. */
  label: string;
  /** Encrypt the bundle (and include secrets). */
  encrypt?: boolean;
  /** Passphrase, required when `encrypt` is true. */
  passphrase?: string;
  /** Global CLEO home (defaults to `getCleoHome()`). */
  cleoHome?: string;
  /** Config home (defaults to `getCleoConfigDir()`). */
  configHome?: string;
  /** Machine scope: predicate for temp/fixture paths (defaults to {@link isTempProjectPath}). */
  isTempPath?: (absPath: string) => boolean;
}

// ---------------------------------------------------------------------------
// Machine-scope project selection
// ---------------------------------------------------------------------------

/** A registered project row read from the global registry snapshot. */
interface RegistryRow {
  projectId: string;
  path: string;
}

/**
 * True when a path is a temp or test-fixture directory that must never be
 * exported as a project (the registry accumulates these from test runs).
 *
 * @param absPath - Resolved project path.
 * @returns Whether the path is temp/fixture material.
 */
export function isTempProjectPath(absPath: string): boolean {
  const home = os.homedir();
  const tempRoots = [os.tmpdir(), '/tmp', '/var/tmp', path.join(home, '.temp')].map((p) =>
    path.resolve(p),
  );
  const resolved = path.resolve(absPath);
  if (tempRoots.some((r) => resolved === r || resolved.startsWith(`${r}${path.sep}`))) return true;
  return /(^|[/\\._-])(vitest|regression|fixtures?)([/\\._-]|$)/i.test(resolved);
}

function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Choose which registered projects `machine` scope exports.
 *
 * @param rows - Registry rows.
 * @param cleoHome - Global home (a project whose `.cleo/` IS the home is skipped).
 * @param isTempPath - Temp/fixture predicate.
 * @returns Included project roots and skipped rows with reasons.
 */
export function selectMachineProjects(
  rows: readonly RegistryRow[],
  cleoHome: string,
  isTempPath: (absPath: string) => boolean = isTempProjectPath,
): { included: RegistryRow[]; skipped: PortableSkippedProject[] } {
  const included: RegistryRow[] = [];
  const skipped: PortableSkippedProject[] = [];
  const seen = new Set<string>();
  const homeReal = realpathOrNull(cleoHome) ?? path.resolve(cleoHome);
  const skip = (row: RegistryRow, reason: PortableSkipReason): void => {
    skipped.push({ path: row.path, projectId: row.projectId, reason });
  };
  for (const row of [...rows].sort((a, b) => a.path.localeCompare(b.path))) {
    if (isTempPath(row.path)) {
      skip(row, 'temp-path');
      continue;
    }
    const real = realpathOrNull(row.path);
    if (real === null || !fs.statSync(real).isDirectory()) {
      skip(row, 'path-missing');
      continue;
    }
    if (isTempPath(real)) {
      skip(row, 'temp-path');
      continue;
    }
    const cleoDirReal = realpathOrNull(path.join(real, '.cleo'));
    if (cleoDirReal !== null && cleoDirReal === homeReal) {
      skip(row, 'is-global-home');
      continue;
    }
    const storeNames = [PRIMARY_STORE_BASENAME, ...LEGACY_STORE_BASENAMES.project];
    if (!storeNames.some((n) => fs.existsSync(path.join(real, '.cleo', n)))) {
      skip(row, 'no-live-store');
      continue;
    }
    if (seen.has(real)) {
      skip(row, 'duplicate-path');
      continue;
    }
    seen.add(real);
    included.push({ projectId: row.projectId, path: real });
  }
  return { included, skipped };
}

/**
 * Read the project registry out of a global-store snapshot.
 *
 * @param snapshotPath - VACUUM snapshot of the global primary store.
 * @returns Registry rows.
 * @throws {PortableBundleError} `E_REGISTRY_UNREADABLE` when the table cannot be read.
 */
function readRegistrySnapshot(snapshotPath: string): RegistryRow[] {
  const db = new DatabaseSync(snapshotPath, { readOnly: true });
  try {
    return (
      db
        .prepare('SELECT project_id AS projectId, project_path AS path FROM nexus_project_registry')
        .all() as Array<{ projectId: string | null; path: string | null }>
    )
      .filter((r): r is { projectId: string | null; path: string } => typeof r.path === 'string')
      .map((r) => ({ projectId: r.projectId ?? '', path: r.path }));
  } catch (err) {
    throw new PortableBundleError(
      'E_REGISTRY_UNREADABLE',
      `Cannot read the project registry from the global store: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Section staging
// ---------------------------------------------------------------------------

/** Mutable accumulator for staged archive paths. */
interface StagingState {
  stagingDir: string;
  archivePaths: string[];
  skipAbsolute: Set<string>;
  includeSecrets: boolean;
  /** Bundle passphrase (encrypted bundles only) — also seals the credentials. */
  passphrase: string | null;
  /** Source CLEO home, whose machine-key decrypts the credentials being sealed. */
  cleoHome: string;
}

/** Credential tables whose rows {@link listCredentialsForReentry} enumerates, by store. */
const CREDENTIAL_STORE_BY_TABLE: Readonly<Record<string, CredentialStoreKind>> = {
  tasks_agent_credentials: 'project-agent',
  service_connections: 'service-connection',
  agent_registry_agents: 'agent-registry',
};

/** The LLM pool file in the global home. */
const LLM_POOL_RELPATH = 'llm-credentials.json';

/**
 * Seal a section's credentials under the bundle passphrase (encrypted bundles
 * only) and stage the payload at `secrets/<key>.sealed`. The payload carries
 * credential values — never the machine-key — so the importing device can
 * re-encrypt them under its own key (T12326).
 *
 * @param state - Staging accumulator.
 * @param section - Section to annotate.
 * @param key - Unique payload name within the bundle.
 * @param sources - Staged snapshot paths (+ project identity) to read.
 */
async function sealSectionCredentials(
  state: StagingState,
  section: PortableSectionBase,
  key: string,
  sources: CredentialSources,
): Promise<void> {
  if (state.passphrase === null) return;
  const sealed = await sealCredentials({ ...sources, cleoHome: state.cleoHome }, state.passphrase);
  if (sealed.sealedCredentials.length === 0 && sealed.reentry.length === 0) return;
  const archivePath = `secrets/${key}.sealed`;
  const staged = path.join(state.stagingDir, archivePath);
  fs.mkdirSync(path.dirname(staged), { recursive: true });
  fs.writeFileSync(staged, sealed.sealed, { mode: 0o600 });
  section.sealedCredentials = {
    bundlePath: archivePath,
    size: fs.statSync(staged).size,
    sha256: await sha256File(staged),
    credentials: [...sealed.sealedCredentials],
    reentry: [...sealed.reentry],
  };
  state.archivePaths.push(archivePath);
}

function toArchive(prefix: string, relPath: string): string {
  return `${prefix}/${relPath}`;
}

/**
 * Stage one root into the archive staging directory.
 *
 * @param state - Staging accumulator.
 * @param root - Absolute root.
 * @param prefix - Archive prefix for this section.
 * @param rules - Walk rules.
 * @param tier - Which legacy-name set applies.
 * @param primaryRelPath - Relative path of the primary store (null when the section has none).
 * @returns The populated section.
 */
async function stageSection(
  state: StagingState,
  root: string,
  prefix: string,
  rules: SectionRules,
  tier: 'project' | 'global' | 'config',
  primaryRelPath: string | null,
): Promise<PortableSectionBase> {
  const scan = scanSection(root, rules, state.skipAbsolute);
  const section: PortableSectionBase = {
    originalRoot: root,
    bundlePrefix: prefix,
    databases: [],
    files: [],
    symlinks: scan.symlinks,
    excluded: scan.excluded,
    requiresReentry: [],
  };

  const legacy = tier === 'config' ? new Set<string>() : LEGACY_STORE_BASENAMES[tier];
  // A missing primary is fatal only when no legacy store could hold the data:
  // some projects were never migrated and their ONLY copy is in tasks.db/brain.db.
  const hasLegacyStore = scan.sqlite.some((rel) => legacy.has(rel));
  const primaryAbs = primaryRelPath === null ? null : path.join(root, primaryRelPath);
  const primaryUnreadable = primaryAbs !== null && fs.existsSync(primaryAbs);
  if (
    primaryRelPath !== null &&
    !scan.sqlite.includes(primaryRelPath) &&
    (primaryUnreadable || !hasLegacyStore)
  ) {
    const abs = path.join(root, primaryRelPath);
    throw new PortableBundleError(
      fs.existsSync(abs) ? 'E_PRIMARY_STORE_UNREADABLE' : 'E_PRIMARY_STORE_MISSING',
      fs.existsSync(abs)
        ? `Primary store is not a readable SQLite database: ${abs}`
        : `Primary store is missing: ${abs}`,
    );
  }

  for (const relPath of scan.sqlite) {
    const archivePath = toArchive(prefix, relPath);
    const staged = path.join(state.stagingDir, archivePath);
    const isPrimary = relPath === primaryRelPath;
    try {
      vacuumSnapshot(path.join(root, relPath), staged);
    } catch (err) {
      if (isPrimary) {
        throw new PortableBundleError(
          'E_PRIMARY_STORE_UNREADABLE',
          `Cannot snapshot primary store ${path.join(root, relPath)}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      fs.rmSync(staged, { force: true });
      if (state.includeSecrets) {
        // Encrypted bundle: capture the unreadable file byte-for-byte so nothing is lost.
        scan.files.push(relPath);
      } else {
        // Unencrypted: a raw copy could carry credential columns that cannot be cleared.
        section.excluded.push({
          relPath,
          reason: `SQLite file could not be opened for a snapshot (${err instanceof Error ? err.message : String(err)}); not copied raw into an unencrypted bundle because its credential columns cannot be cleared — re-export with --encrypt to carry it`,
          bytes: fs.statSync(path.join(root, relPath)).size,
          fileCount: 1,
          sizeComplete: true,
        });
      }
      continue;
    }
    if (!state.includeSecrets) {
      try {
        // Enumerate BEFORE clearing: afterwards the rows no longer say which
        // credentials they held.
        const enumerable: CredentialReentry[] =
          tier === 'project'
            ? listCredentialsForReentry({ projectDbPath: staged })
            : tier === 'global'
              ? listCredentialsForReentry({ globalDbPath: staged })
              : [];
        for (const r of redactCredentials(staged)) {
          const credentials = enumerable.filter(
            (c) => CREDENTIAL_STORE_BY_TABLE[r.table] === c.store,
          );
          section.requiresReentry.push({
            relPath,
            table: r.table,
            columns: r.columns,
            rows: r.rows,
            remedy: r.remedy,
            ...(credentials.length > 0 ? { credentials } : {}),
          });
        }
      } catch (err) {
        throw new PortableBundleError(
          'E_REDACTION_FAILED',
          `Cannot clear credential columns in the snapshot of ${path.join(root, relPath)}; refusing to write an unencrypted bundle that could carry them (use --encrypt): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const counts = countRows(staged);
    const entry: PortableDatabaseEntry = {
      relPath,
      bundlePath: archivePath,
      role: isPrimary ? 'primary' : legacy.has(relPath) ? 'legacy' : 'auxiliary',
      size: fs.statSync(staged).size,
      sha256: await sha256File(staged),
      rowCounts: counts.rowCounts,
      uncountedTables: counts.uncountedTables,
    };
    section.databases.push(entry);
    state.archivePaths.push(archivePath);
  }

  const copyFile = async (relPath: string, secret: boolean): Promise<void> => {
    const src = path.join(root, relPath);
    const archivePath = toArchive(prefix, relPath);
    const staged = path.join(state.stagingDir, archivePath);
    fs.mkdirSync(path.dirname(staged), { recursive: true });
    fs.copyFileSync(src, staged);
    fs.chmodSync(staged, fs.statSync(src).mode & 0o777);
    const entry: PortableFileEntry = {
      relPath,
      bundlePath: archivePath,
      size: fs.statSync(staged).size,
      sha256: await sha256File(staged),
      secret,
    };
    section.files.push(entry);
    state.archivePaths.push(archivePath);
  };

  for (const relPath of scan.files.sort()) await copyFile(relPath, false);
  for (const s of scan.secrets) {
    if (state.includeSecrets) {
      await copyFile(s.relPath, true);
      continue;
    }
    const credentials =
      tier === 'global' && s.relPath === LLM_POOL_RELPATH
        ? listCredentialsForReentry({ llmStorePath: path.join(root, s.relPath) })
        : [];
    section.requiresReentry.push({
      relPath: s.relPath,
      remedy: s.remedy,
      ...(credentials.length > 0 ? { credentials } : {}),
    });
  }
  return section;
}

/**
 * Compare legacy per-domain tables with their consolidated counterparts.
 *
 * @param databases - Snapshotted databases of one root.
 * @returns Report; `detected` when any legacy table holds more rows than the primary.
 */
export function detectUnmigratedLegacy(
  databases: readonly PortableDatabaseEntry[],
): PortableUnmigratedLegacyReport {
  const primary = databases.find((d) => d.role === 'primary');
  const evidence: PortableUnmigratedLegacyReport['evidence'] = [];
  for (const db of databases.filter((d) => d.role === 'legacy')) {
    for (const [table, primaryTable] of Object.entries(LEGACY_TABLE_MAP)) {
      const legacyRows = db.rowCounts[table];
      if (legacyRows === undefined || legacyRows === 0) continue;
      const primaryRows = primary?.rowCounts[primaryTable] ?? 0;
      if (legacyRows > primaryRows) {
        const unprefixed = table === primaryTable ? undefined : primary?.rowCounts[table];
        evidence.push({
          database: db.relPath,
          table,
          legacyRows,
          primaryTable,
          primaryRows,
          ...(unprefixed !== undefined ? { primaryUnprefixedRows: unprefixed } : {}),
        });
      }
    }
  }
  return { detected: evidence.length > 0, evidence };
}

function readProjectInfo(cleoDir: string): { projectId: string | null; name: string | null } {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(cleoDir, 'project-info.json'), 'utf-8')) as {
      projectId?: unknown;
      name?: unknown;
    };
    return {
      projectId: typeof raw.projectId === 'string' ? raw.projectId : null,
      name: typeof raw.name === 'string' ? raw.name : null,
    };
  } catch {
    return { projectId: null, name: null };
  }
}

async function stageProject(
  state: StagingState,
  projectRoot: string,
  index: number,
  registryProjectId?: string,
): Promise<PortableProjectSection> {
  const cleoDir = path.join(projectRoot, '.cleo');
  if (!fs.existsSync(cleoDir)) {
    throw new PortableBundleError('E_NO_PROJECT', `No .cleo directory at ${projectRoot}`);
  }
  const info = readProjectInfo(cleoDir);
  const name = info.name ?? path.basename(projectRoot);
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || 'project';
  const prefix = `projects/${String(index).padStart(3, '0')}-${safe}/cleo`;
  const base = await stageSection(
    state,
    cleoDir,
    prefix,
    PROJECT_SECTION_RULES,
    'project',
    PRIMARY_STORE_BASENAME,
  );
  const primary = base.databases.find((d) => d.role === 'primary');
  const projectId = info.projectId ?? (registryProjectId || null);
  if (primary) {
    await sealSectionCredentials(state, base, `project-${String(index).padStart(3, '0')}`, {
      projectDbPath: path.join(state.stagingDir, primary.bundlePath),
      ...(projectId !== null ? { projectId } : {}),
      legacyProjectPaths: [projectRoot],
    });
  }
  return {
    ...base,
    originalPath: projectRoot,
    projectId,
    name,
    keyCounts: primary ? pickKeyCounts(primary.rowCounts) : {},
    unmigratedLegacyData: detectUnmigratedLegacy(base.databases),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the manifest self-hash (SHA-256 of the compact JSON with
 * `integrity.manifestHash` set to "").
 *
 * @param manifest - Manifest to hash.
 * @returns Lowercase hex digest.
 */
export function computeManifestHash(manifest: PortableBundleManifest): string {
  const placeholder: PortableBundleManifest = {
    ...manifest,
    integrity: { ...manifest.integrity, manifestHash: '' },
  };
  return crypto.createHash('sha256').update(JSON.stringify(placeholder), 'utf-8').digest('hex');
}

/**
 * Export a portable (manifest v2) bundle.
 *
 * Reads only: every database is snapshotted over a read-only connection and
 * nothing is written outside the output path's directory (staging lives
 * beside the output and is removed on success or failure).
 *
 * @param input - Export options.
 * @returns Export summary.
 * @throws {PortableBundleError} When a primary store is missing/unreadable, the
 *   registry cannot be read (machine scope), or encryption lacks a passphrase.
 *
 * @example
 * ```ts
 * const r = await exportPortableBundle({ scope: 'project', projectRoot: '/p', outputPath: '/b/p.cleobundle.tar.gz', label: 'p' });
 * ```
 */
export async function exportPortableBundle(
  input: ExportPortableBundleInput,
): Promise<PortableExportResult> {
  const encrypt = input.encrypt === true;
  if (encrypt && !input.passphrase) {
    throw new PortableBundleError('E_PASSPHRASE_REQUIRED', '--encrypt requires a passphrase');
  }
  const scope = input.scope;
  const withProject = scope === 'project' || scope === 'all';
  const withGlobal = scope !== 'project';
  if (withProject && !input.projectRoot) {
    throw new PortableBundleError('E_NO_PROJECT', `scope "${scope}" requires a project root`);
  }
  const cleoHome = path.resolve(input.cleoHome ?? getCleoHome());
  const configHome = path.resolve(input.configHome ?? getCleoConfigDir());
  const outputPath = path.resolve(input.outputPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const stagingDir = fs.mkdtempSync(path.join(path.dirname(outputPath), '.cleo-export-'));
  const partialPath = `${outputPath}.partial`;
  const tarPath = encrypt ? `${outputPath}.partial-tar` : partialPath;
  const state: StagingState = {
    stagingDir,
    archivePaths: [],
    skipAbsolute: new Set([stagingDir, partialPath, tarPath, outputPath]),
    includeSecrets: encrypt,
    passphrase: encrypt && input.passphrase ? input.passphrase : null,
    cleoHome,
  };

  try {
    let global: PortableBundleManifest['global'] = null;
    const projects: PortableProjectSection[] = [];
    let skippedProjects: PortableSkippedProject[] = [];
    let registeredCount = 0;

    if (withGlobal) {
      const primaryAbs = resolveDualScopeDbPath('global', undefined, cleoHome);
      const primaryRel = path.relative(cleoHome, primaryAbs).split(path.sep).join('/');
      if (!fs.existsSync(cleoHome)) {
        throw new PortableBundleError(
          'E_PRIMARY_STORE_MISSING',
          `Global CLEO home does not exist: ${cleoHome}`,
        );
      }
      const home = await stageSection(
        state,
        cleoHome,
        'global/home',
        GLOBAL_HOME_RULES,
        'global',
        primaryRel,
      );
      const config = fs.existsSync(configHome)
        ? await stageSection(state, configHome, 'global/config', CONFIG_HOME_RULES, 'config', null)
        : null;
      const primary = home.databases.find((d) => d.role === 'primary');
      if (primary) {
        await sealSectionCredentials(state, home, 'global-home', {
          globalDbPath: path.join(stagingDir, primary.bundlePath),
        });
      }
      global = {
        home,
        config,
        keyCounts: primary ? pickKeyCounts(primary.rowCounts) : {},
        unmigratedLegacyData: detectUnmigratedLegacy(home.databases),
      };

      if (scope === 'machine' && primary) {
        const rows = readRegistrySnapshot(path.join(stagingDir, primary.bundlePath));
        registeredCount = rows.length;
        const selection = selectMachineProjects(rows, cleoHome, input.isTempPath);
        skippedProjects = selection.skipped;
        for (const row of selection.included) {
          projects.push(await stageProject(state, row.path, projects.length, row.projectId));
        }
      }
    }

    if (withProject && input.projectRoot) {
      projects.push(await stageProject(state, path.resolve(input.projectRoot), projects.length));
    }

    const manifest: PortableBundleManifest = {
      format: 'cleo-portable-bundle',
      manifestVersion: '2.0.0',
      backup: {
        createdAt: new Date().toISOString(),
        cleoVersion: getCleoVersion(),
        scope,
        label: input.label,
        sourceHost: os.hostname(),
        encrypted: encrypt,
        secretsIncluded: encrypt,
        memoriesIncluded: true,
      },
      global,
      projects,
      skippedProjects,
      integrity: { algorithm: 'sha256', manifestHash: '' },
    };
    manifest.integrity.manifestHash = computeManifestHash(manifest);
    fs.writeFileSync(path.join(stagingDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    const checksumLines: string[] = [];
    for (const section of allSections(manifest)) {
      for (const d of section.databases) checksumLines.push(`${d.sha256}  ${d.bundlePath}`);
      for (const f of section.files) checksumLines.push(`${f.sha256}  ${f.bundlePath}`);
      const sealed = section.sealedCredentials;
      if (sealed) checksumLines.push(`${sealed.sha256}  ${sealed.bundlePath}`);
    }
    fs.writeFileSync(path.join(stagingDir, 'checksums.sha256'), `${checksumLines.join('\n')}\n`);

    await tarCreate({ gzip: true, file: tarPath, cwd: stagingDir }, [
      'manifest.json',
      'checksums.sha256',
      ...state.archivePaths,
    ]);
    if (encrypt && input.passphrase) {
      await encryptFileStream(tarPath, partialPath, input.passphrase);
      fs.rmSync(tarPath, { force: true });
    }
    fs.renameSync(partialPath, outputPath);

    const skippedByReason: Partial<Record<PortableSkipReason, number>> = {};
    for (const s of skippedProjects) {
      skippedByReason[s.reason] = (skippedByReason[s.reason] ?? 0) + 1;
    }
    return {
      bundlePath: outputPath,
      size: fs.statSync(outputPath).size,
      scope,
      encrypted: encrypt,
      secretsIncluded: encrypt,
      memory: memoryDisclosure(manifest, encrypt),
      sections: [
        ...(global
          ? [
              {
                ...summarise('global-home', global.home, global.keyCounts),
                unmigratedLegacyData: global.unmigratedLegacyData,
              },
              ...(global.config ? [summarise('global-config', global.config)] : []),
            ]
          : []),
        ...projects.map((p) => ({
          ...summarise('project', p, p.keyCounts),
          name: p.name,
          unmigratedLegacyData: p.unmigratedLegacyData,
        })),
      ],
      ...(scope === 'machine'
        ? {
            machine: {
              registered: registeredCount,
              included: projects.length,
              skippedByReason,
            },
          }
        : {}),
    };
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.rmSync(partialPath, { force: true });
    fs.rmSync(tarPath, { force: true });
  }
}

/**
 * Build the ADR-093 memory disclosure: memories always travel, and the result
 * says whether bundle encryption protects them.
 *
 * @param manifest - Written manifest.
 * @param encrypted - Whether the bundle is encrypted.
 * @returns Disclosure block for the export result.
 */
function memoryDisclosure(
  manifest: PortableBundleManifest,
  encrypted: boolean,
): PortableExportResult['memory'] {
  const counts: Record<string, number> = {};
  for (const section of allSections(manifest)) {
    // Live and legacy stores only; auxiliary `.bak` snapshots would double-count.
    for (const db of section.databases.filter((d) => d.role !== 'auxiliary')) {
      for (const table of MEMORY_TABLES) {
        const n = db.rowCounts[table];
        if (n !== undefined) counts[table] = (counts[table] ?? 0) + n;
      }
    }
  }
  return {
    included: true,
    encrypted,
    counts,
    notice: encrypted
      ? 'Memories (brain observations, decisions, learnings, patterns) are included and protected by bundle encryption.'
      : 'Memories (brain observations, decisions, learnings, patterns) are included in PLAIN TEXT in this unencrypted bundle (ADR-093). Re-export with --encrypt to protect them.',
  };
}

function summarise(
  kind: PortableExportResult['sections'][number]['kind'],
  section: PortableSectionBase,
  keyCounts?: Record<string, number>,
): PortableExportResult['sections'][number] {
  return {
    kind,
    root: section.originalRoot,
    databases: section.databases.length,
    files: section.files.length,
    ...(keyCounts ? { keyCounts } : {}),
    excluded: section.excluded,
    requiresReentry: section.requiresReentry,
  };
}

/**
 * Every section of a manifest, in archive order.
 *
 * @param manifest - Portable manifest.
 * @returns Sections (global home, global config, projects).
 */
export function allSections(manifest: PortableBundleManifest): PortableSectionBase[] {
  const out: PortableSectionBase[] = [];
  if (manifest.global) {
    out.push(manifest.global.home);
    if (manifest.global.config) out.push(manifest.global.config);
  }
  out.push(...manifest.projects);
  return out;
}
