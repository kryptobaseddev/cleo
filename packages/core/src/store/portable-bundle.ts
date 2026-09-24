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
 *   and what the user must redo;
 * - records per-table row counts so import can prove the restore lossless.
 *
 * Archive layout:
 *   manifest.json                     FIRST entry
 *   checksums.sha256                  GNU sha256sum format over every other file
 *   global/home/<rel>                 <cleoHome> content
 *   global/config/<rel>               <configHome> content
 *   projects/<nnn>-<name>/cleo/<rel>  a project's .cleo/ content
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
} from '@cleocode/contracts';
import { create as tarCreate } from 'tar';
import { getCleoConfigDir, getCleoHome } from '../paths.js';
import { getCleoVersion } from '../scaffold/ensure-config.js';
import { encryptFileStream } from './backup-crypto.js';
import { resolveDualScopeDbPath } from './dual-scope-db.js';
import {
  CONFIG_HOME_RULES,
  countRows,
  GLOBAL_HOME_RULES,
  LEGACY_STORE_BASENAMES,
  PRIMARY_STORE_BASENAME,
  PROJECT_SECTION_RULES,
  pickKeyCounts,
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
  | 'E_RESTORE_MISMATCH';

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
    if (!fs.existsSync(path.join(real, '.cleo', PRIMARY_STORE_BASENAME))) {
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
    omittedSecrets: [],
  };

  if (primaryRelPath !== null && !scan.sqlite.includes(primaryRelPath)) {
    const abs = path.join(root, primaryRelPath);
    throw new PortableBundleError(
      fs.existsSync(abs) ? 'E_PRIMARY_STORE_UNREADABLE' : 'E_PRIMARY_STORE_MISSING',
      fs.existsSync(abs)
        ? `Primary store is not a readable SQLite database: ${abs}`
        : `Primary store is missing: ${abs}`,
    );
  }

  const legacy = tier === 'config' ? new Set<string>() : LEGACY_STORE_BASENAMES[tier];
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
      // A non-primary SQLite file that cannot be opened is still captured
      // byte-for-byte so nothing is lost; it is reported as a plain file.
      fs.rmSync(staged, { force: true });
      scan.files.push(relPath);
      continue;
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
    if (state.includeSecrets) await copyFile(s.relPath, true);
    else section.omittedSecrets.push({ relPath: s.relPath, remedy: s.remedy });
  }
  return section;
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
  return {
    ...base,
    originalPath: projectRoot,
    projectId: info.projectId,
    name,
    keyCounts: primary ? pickKeyCounts(primary.rowCounts) : {},
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
      global = { home, config, keyCounts: primary ? pickKeyCounts(primary.rowCounts) : {} };

      if (scope === 'machine' && primary) {
        const rows = readRegistrySnapshot(path.join(stagingDir, primary.bundlePath));
        registeredCount = rows.length;
        const selection = selectMachineProjects(rows, cleoHome, input.isTempPath);
        skippedProjects = selection.skipped;
        for (const row of selection.included) {
          projects.push(await stageProject(state, row.path, projects.length));
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
      sections: [
        ...(global
          ? [
              summarise('global-home', global.home, global.keyCounts),
              ...(global.config ? [summarise('global-config', global.config)] : []),
            ]
          : []),
        ...projects.map((p) => ({ ...summarise('project', p, p.keyCounts), name: p.name })),
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
    omittedSecrets: section.omittedSecrets,
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
