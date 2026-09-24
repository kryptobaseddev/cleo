/**
 * portable-bundle-import.ts — import side of the lossless machine-migration
 * bundle (manifest v2).
 *
 * Order of operations (nothing is placed until everything is verified):
 *   1. decrypt (streamed) and extract into a staging directory;
 *   2. verify the manifest self-hash, every file's size + SHA-256, and
 *      `PRAGMA integrity_check` on every database;
 *   3. resolve destinations (`--target` for a single project, `--map`
 *      prefix rewrites, else the original paths) and refuse to overwrite
 *      live data without `force`;
 *   4. relocate the STAGED copies (paths, registry rows) when a project
 *      moves;
 *   5. place files and databases (tmp + rename, stale WAL sidecars removed);
 *   6. re-count every table of every placed database and compare with the
 *      manifest — any mismatch fails the import.
 *
 * @task T12318
 * @epic T12317
 * @module store/portable-bundle-import
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import type {
  PortableBundleManifest,
  PortableImportResult,
  PortableImportSectionResult,
  PortableProjectSection,
  PortableRelocationReport,
  PortableSectionBase,
  PortableTableComparison,
} from '@cleocode/contracts';
import { extract as tarExtract, list as tarList } from 'tar';
import { generateProjectHash } from '../nexus/hash.js';
import { getCleoConfigDir, getCleoHome } from '../paths.js';
import {
  decryptFileStream,
  encryptedBundleVersion,
  STREAM_FORMAT_VERSION,
} from './backup-crypto.js';
import { allSections, computeManifestHash, PortableBundleError } from './portable-bundle.js';
import {
  isUnderRoot,
  relocateDatabase,
  relocatePath,
  relocateProjectFiles,
} from './portable-bundle-relocate.js';
import { countRows, integrityCheck, KEY_COUNT_TABLES, sha256File } from './portable-bundle-scan.js';

const _require = createRequire(import.meta.url);
type DatabaseSync = _DatabaseSyncType;
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => DatabaseSync;
};

/** One `--map <old>=<new>` prefix rewrite. */
export interface PathMapping {
  /** Old absolute prefix. */
  from: string;
  /** New absolute prefix. */
  to: string;
}

/** Input for {@link importPortableBundle}. */
export interface ImportPortableBundleInput {
  /** Bundle file. */
  bundlePath: string;
  /** Passphrase for encrypted bundles. */
  passphrase?: string;
  /** Destination project root for a single-project bundle. */
  target?: string;
  /** Prefix rewrites applied to project paths (longest match wins). */
  maps?: readonly PathMapping[];
  /** Destination global home (defaults to `getCleoHome()`). */
  cleoHome?: string;
  /** Destination config home (defaults to `getCleoConfigDir()`). */
  configHome?: string;
  /** Overwrite existing live data. */
  force?: boolean;
  /**
   * Throw `E_RESTORE_MISMATCH` (carrying the full report) when any restored
   * table count differs from the manifest, instead of returning `lossless: false`.
   */
  requireLossless?: boolean;
  /** Directory in which to create the staging directory (defaults to the parent of `cleoHome`). */
  stagingParent?: string;
  /**
   * Called after placement for projects whose global registry row could not be
   * rewritten in a bundled global store (project-only bundles). Receives the
   * projectId and new root; returns the registry outcome.
   */
  registerProject?: (
    projectId: string | null,
    newRoot: string,
  ) => Promise<NonNullable<PortableImportSectionResult['registry']>>;
}

/**
 * Parse `--map` values (`<old>=<new>`).
 *
 * @param values - Raw flag values.
 * @returns Parsed mappings with resolved absolute prefixes.
 * @throws {PortableBundleError} `E_BUNDLE_FORMAT` on a malformed value.
 */
export function parsePathMappings(values: readonly string[]): PathMapping[] {
  return values.map((raw) => {
    const eq = raw.indexOf('=');
    if (eq <= 0 || eq === raw.length - 1) {
      throw new PortableBundleError(
        'E_TARGET_AMBIGUOUS',
        `--map expects <oldPrefix>=<newPrefix>, got "${raw}"`,
      );
    }
    return { from: path.resolve(raw.slice(0, eq)), to: path.resolve(raw.slice(eq + 1)) };
  });
}

/**
 * Apply the longest matching prefix mapping to a path.
 *
 * @param original - Original absolute path.
 * @param maps - Mappings.
 * @returns The mapped path (unchanged when nothing matches).
 */
export function applyPathMappings(original: string, maps: readonly PathMapping[]): string {
  let best: PathMapping | null = null;
  for (const m of maps) {
    if (isUnderRoot(original, m.from) && (best === null || m.from.length > best.from.length)) {
      best = m;
    }
  }
  return best ? relocatePath(original, best.from, best.to) : original;
}

/**
 * Peek at a bundle and report whether it is a portable (manifest v2) bundle.
 *
 * Encrypted bundles are identified by their format version byte; unencrypted
 * ones by the `format` field of their first entry, `manifest.json`.
 *
 * @param bundlePath - Bundle file.
 * @returns `v2`, `v1`, or `unknown`.
 */
export async function detectBundleFormat(bundlePath: string): Promise<'v1' | 'v2' | 'unknown'> {
  const header = Buffer.alloc(9);
  const fd = fs.openSync(bundlePath, 'r');
  try {
    fs.readSync(fd, header, 0, 9, 0);
  } finally {
    fs.closeSync(fd);
  }
  const version = encryptedBundleVersion(header);
  if (version !== null) return version === STREAM_FORMAT_VERSION ? 'v2' : 'v1';
  const found: { text: string | null } = { text: null };
  try {
    await tarList({
      file: bundlePath,
      filter: (p) => p === 'manifest.json',
      onReadEntry: (entry) => {
        const chunks: Buffer[] = [];
        entry.on('data', (c: Buffer) => chunks.push(c));
        entry.on('end', () => {
          found.text = Buffer.concat(chunks).toString('utf-8');
        });
      },
    });
  } catch {
    return 'unknown';
  }
  if (found.text === null) return 'unknown';
  try {
    const parsed = JSON.parse(found.text) as { format?: unknown; manifestVersion?: unknown };
    if (parsed.format === 'cleo-portable-bundle') return 'v2';
    if (typeof parsed.manifestVersion === 'string' && parsed.manifestVersion.startsWith('1.')) {
      return 'v1';
    }
  } catch {
    return 'unknown';
  }
  return 'unknown';
}

/** Verify the staged bundle; throws on any integrity failure. */
async function verifyStaged(stagingDir: string): Promise<PortableBundleManifest> {
  const manifestPath = path.join(stagingDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new PortableBundleError('E_BUNDLE_FORMAT', 'manifest.json is missing from the bundle');
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as PortableBundleManifest;
  if (manifest.format !== 'cleo-portable-bundle' || !manifest.manifestVersion?.startsWith('2.')) {
    throw new PortableBundleError(
      'E_BUNDLE_FORMAT',
      'Not a portable (manifest v2) bundle — use the legacy import path for v1 bundles',
    );
  }
  if (computeManifestHash(manifest) !== manifest.integrity.manifestHash) {
    throw new PortableBundleError(
      'E_BUNDLE_INTEGRITY',
      'Manifest self-hash mismatch — the manifest was modified after export',
    );
  }
  for (const section of allSections(manifest)) {
    for (const entry of [...section.databases, ...section.files]) {
      const abs = path.join(stagingDir, entry.bundlePath);
      if (!abs.startsWith(`${stagingDir}${path.sep}`) || !fs.existsSync(abs)) {
        throw new PortableBundleError(
          'E_BUNDLE_INTEGRITY',
          `Bundle entry missing or outside the archive root: ${entry.bundlePath}`,
        );
      }
      if (fs.statSync(abs).size !== entry.size || (await sha256File(abs)) !== entry.sha256) {
        throw new PortableBundleError(
          'E_BUNDLE_INTEGRITY',
          `Size/SHA-256 mismatch: ${entry.bundlePath}`,
        );
      }
    }
    for (const db of section.databases) {
      const result = integrityCheck(path.join(stagingDir, db.bundlePath));
      if (result !== 'ok') {
        throw new PortableBundleError(
          'E_BUNDLE_INTEGRITY',
          `PRAGMA integrity_check failed for ${db.bundlePath}: ${result}`,
        );
      }
    }
  }
  return manifest;
}

/** Destination plan for one section. */
interface Placement {
  kind: PortableImportSectionResult['kind'];
  section: PortableSectionBase;
  /** Directory the section's relative paths are written under. */
  destDir: string;
  /** Project only. */
  project?: PortableProjectSection;
  /** Project only: new project root. */
  destRoot?: string;
}

function planPlacements(
  manifest: PortableBundleManifest,
  input: ImportPortableBundleInput,
  cleoHome: string,
  configHome: string,
): Placement[] {
  const plans: Placement[] = [];
  if (manifest.global) {
    plans.push({ kind: 'global-home', section: manifest.global.home, destDir: cleoHome });
    if (manifest.global.config) {
      plans.push({ kind: 'global-config', section: manifest.global.config, destDir: configHome });
    }
  }
  if (input.target !== undefined && manifest.projects.length !== 1) {
    throw new PortableBundleError(
      'E_TARGET_AMBIGUOUS',
      `--target applies to a single-project bundle; this bundle holds ${manifest.projects.length} projects (use --map)`,
    );
  }
  const maps = input.maps ?? [];
  const seen = new Map<string, string>();
  for (const project of manifest.projects) {
    const destRoot =
      input.target !== undefined
        ? path.resolve(input.target)
        : applyPathMappings(project.originalPath, maps);
    const prior = seen.get(destRoot);
    if (prior !== undefined) {
      throw new PortableBundleError(
        'E_TARGET_AMBIGUOUS',
        `Two projects map to the same destination ${destRoot}: ${prior} and ${project.originalPath}`,
      );
    }
    seen.set(destRoot, project.originalPath);
    plans.push({
      kind: 'project',
      section: project,
      destDir: path.join(destRoot, '.cleo'),
      project,
      destRoot,
    });
  }
  return plans;
}

function assertNoLiveData(plans: readonly Placement[]): void {
  const existing: string[] = [];
  for (const plan of plans) {
    for (const db of plan.section.databases) {
      if (db.role !== 'primary') continue;
      const abs = path.join(plan.destDir, db.relPath);
      if (fs.existsSync(abs)) existing.push(abs);
    }
  }
  if (existing.length > 0) {
    throw new PortableBundleError(
      'E_DATA_EXISTS',
      `Target already has live data: ${existing.join(', ')}. Re-run with --force to overwrite.`,
    );
  }
}

/** Rewrite registry rows in a STAGED global store for projects that moved. */
function relocateRegistryRows(
  stagedGlobalDb: string,
  moves: ReadonlyArray<{ projectId: string | null; from: string; to: string }>,
): Map<string, NonNullable<PortableImportSectionResult['registry']>> {
  const outcomes = new Map<string, NonNullable<PortableImportSectionResult['registry']>>();
  const db = new DatabaseSync(stagedGlobalDb);
  try {
    for (const move of moves) {
      if (move.from === move.to) {
        outcomes.set(move.from, { status: 'unchanged', detail: 'project path unchanged' });
        continue;
      }
      // Mirrors nexusMoveProject's column set; done on the staged file so the
      // live registry is never half-updated.
      let changes = 0;
      try {
        changes = Number(
          db
            .prepare(
              'UPDATE nexus_project_registry SET project_path = ?, project_hash = ?, brain_db_path = ?, tasks_db_path = ?, last_seen = ? WHERE project_path = ? OR (? IS NOT NULL AND project_id = ?)',
            )
            .run(
              move.to,
              generateProjectHash(move.to),
              path.join(move.to, '.cleo', 'brain.db'),
              path.join(move.to, '.cleo', 'tasks.db'),
              new Date().toISOString(),
              move.from,
              move.projectId,
              move.projectId,
            ).changes,
        );
      } catch (err) {
        // e.g. another (stale) registry row already owns the new path.
        outcomes.set(move.from, {
          status: 'failed',
          detail: `${err instanceof Error ? err.message : String(err)} — resolve with \`cleo nexus projects list\` then \`cleo nexus projects register ${move.to}\``,
        });
        continue;
      }
      outcomes.set(
        move.from,
        changes > 0
          ? { status: 'updated', detail: `registry row for ${move.from} -> ${move.to}` }
          : {
              status: 'not-in-registry',
              detail: `neither ${move.from} nor projectId ${move.projectId ?? '(none)'} is in the bundled registry; run \`cleo nexus projects register ${move.to}\``,
            },
      );
    }
  } finally {
    db.close();
  }
  return outcomes;
}

function placeSection(stagingDir: string, plan: Placement): { files: number; dbs: number } {
  fs.mkdirSync(plan.destDir, { recursive: true });
  for (const f of plan.section.files) {
    const src = path.join(stagingDir, f.bundlePath);
    const dst = path.join(plan.destDir, f.relPath);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, fs.statSync(src).mode & 0o777);
  }
  for (const d of plan.section.databases) {
    const src = path.join(stagingDir, d.bundlePath);
    const dst = path.join(plan.destDir, d.relPath);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const tmp = `${dst}.import-tmp-${process.pid}`;
    fs.copyFileSync(src, tmp);
    for (const sidecar of [`${dst}-wal`, `${dst}-shm`, `${dst}-journal`]) {
      fs.rmSync(sidecar, { force: true });
    }
    fs.renameSync(tmp, dst);
  }
  for (const link of plan.section.symlinks ?? []) {
    const dst = path.join(plan.destDir, link.relPath);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.rmSync(dst, { force: true });
    fs.symlinkSync(link.target, dst);
  }
  return { files: plan.section.files.length, dbs: plan.section.databases.length };
}

function compareCounts(plan: Placement): {
  tablesCompared: number;
  mismatches: PortableImportSectionResult['mismatches'];
  keyCounts: PortableTableComparison[];
} {
  let tablesCompared = 0;
  const mismatches: PortableImportSectionResult['mismatches'] = [];
  const keyCounts: PortableTableComparison[] = [];
  for (const d of plan.section.databases) {
    const placed = path.join(plan.destDir, d.relPath);
    const actual = countRows(placed).rowCounts;
    for (const [table, expected] of Object.entries(d.rowCounts)) {
      tablesCompared += 1;
      const got = actual[table] ?? null;
      if (got !== expected) mismatches.push({ database: d.relPath, table, expected, actual: got });
      if (d.role === 'primary' && KEY_COUNT_TABLES.includes(table)) {
        keyCounts.push({ table, expected, actual: got });
      }
    }
  }
  return { tablesCompared, mismatches, keyCounts };
}

/**
 * Import a portable (manifest v2) bundle.
 *
 * @param input - Import options.
 * @returns Per-section outcomes; `lossless` is true only when every table of
 *   every placed database re-counts to the manifest value.
 * @throws {PortableBundleError} On decrypt/format/integrity failure, existing
 *   live data without `force`, or an ambiguous destination.
 *
 * @example
 * ```ts
 * const r = await importPortableBundle({ bundlePath: '/b/p.cleobundle.tar.gz', target: '/new/p' });
 * if (!r.lossless) throw new Error('restore is not lossless');
 * ```
 */
export async function importPortableBundle(
  input: ImportPortableBundleInput,
): Promise<PortableImportResult> {
  const cleoHome = path.resolve(input.cleoHome ?? getCleoHome());
  const configHome = path.resolve(input.configHome ?? getCleoConfigDir());
  const stagingParent = path.resolve(input.stagingParent ?? path.dirname(cleoHome));
  fs.mkdirSync(stagingParent, { recursive: true });
  const stagingDir = fs.mkdtempSync(path.join(stagingParent, '.cleo-import-'));
  const extractDir = path.join(stagingDir, 'bundle');
  fs.mkdirSync(extractDir);

  try {
    // ----- 1. decrypt + extract ------------------------------------------
    const format = await detectBundleFormat(input.bundlePath);
    if (format !== 'v2') {
      throw new PortableBundleError(
        'E_BUNDLE_FORMAT',
        format === 'v1'
          ? 'This is a v1 .cleobundle; it is handled by the legacy import path'
          : 'Unrecognised bundle format',
      );
    }
    let tarPath = input.bundlePath;
    const header = Buffer.alloc(9);
    const fd = fs.openSync(input.bundlePath, 'r');
    fs.readSync(fd, header, 0, 9, 0);
    fs.closeSync(fd);
    if (encryptedBundleVersion(header) !== null) {
      if (!input.passphrase) {
        throw new PortableBundleError(
          'E_PASSPHRASE_REQUIRED',
          'Bundle is encrypted; set CLEO_BACKUP_PASSPHRASE or run on a TTY',
        );
      }
      tarPath = path.join(stagingDir, 'bundle.tar.gz');
      try {
        await decryptFileStream(input.bundlePath, tarPath, input.passphrase);
      } catch (err) {
        throw new PortableBundleError(
          'E_BUNDLE_DECRYPT',
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    await tarExtract({ file: tarPath, cwd: extractDir });
    if (tarPath !== input.bundlePath) fs.rmSync(tarPath, { force: true });

    // ----- 2. verify ------------------------------------------------------
    const manifest = await verifyStaged(extractDir);

    // ----- 3. plan + pre-check -------------------------------------------
    const plans = planPlacements(manifest, input, cleoHome, configHome);
    if (input.force !== true) assertNoLiveData(plans);

    // ----- 4. relocate staged copies -------------------------------------
    const relocations = new Map<Placement, PortableRelocationReport>();
    for (const plan of plans) {
      if (plan.kind !== 'project' || !plan.project || !plan.destRoot) continue;
      const from = plan.project.originalPath;
      const to = plan.destRoot;
      if (from === to) continue;
      const report: PortableRelocationReport = {
        fromRoot: from,
        toRoot: to,
        rewritten: [],
        leftUnderOldRoot: [],
        leftOutsideRoot: [],
        rewrittenTargetMissing: [],
      };
      // Only the live store is relocated. Legacy files, archives and `.bak`
      // snapshots are historical copies and are restored byte-identical.
      for (const d of plan.section.databases.filter((db) => db.role === 'primary')) {
        relocateDatabase(path.join(extractDir, d.bundlePath), d.relPath, from, to, report);
      }
      relocateProjectFiles(
        path.join(extractDir, plan.section.bundlePrefix),
        plan.section.files.map((f) => f.relPath),
        from,
        to,
        report,
      );
      relocations.set(plan, report);
    }
    const globalPrimary = manifest.global?.home.databases.find((d) => d.role === 'primary');
    const registryOutcomes = globalPrimary
      ? relocateRegistryRows(
          path.join(extractDir, globalPrimary.bundlePath),
          plans
            .filter((p) => p.kind === 'project' && p.project && p.destRoot)
            .map((p) => ({
              projectId: p.project?.projectId ?? null,
              from: p.project?.originalPath ?? '',
              to: p.destRoot ?? '',
            })),
        )
      : new Map<string, NonNullable<PortableImportSectionResult['registry']>>();

    // ----- 5. place + 6. verify counts ------------------------------------
    const sections: PortableImportSectionResult[] = [];
    for (const plan of plans) {
      const written = placeSection(extractDir, plan);
      const counts = compareCounts(plan);
      const result: PortableImportSectionResult = {
        kind: plan.kind,
        originalRoot: plan.section.originalRoot,
        destinationRoot: plan.destRoot ?? plan.destDir,
        filesWritten: written.files,
        databasesWritten: written.dbs,
        tablesCompared: counts.tablesCompared,
        mismatches: counts.mismatches,
        keyCounts: counts.keyCounts,
      };
      if (plan.project && plan.destRoot) {
        result.name = plan.project.name;
        result.projectId = plan.project.projectId;
        const relocation = relocations.get(plan);
        if (relocation) result.relocation = relocation;
        const fromBundle = registryOutcomes.get(plan.project.originalPath);
        if (fromBundle) {
          result.registry = fromBundle;
        } else if (input.registerProject) {
          try {
            result.registry = await input.registerProject(plan.project.projectId, plan.destRoot);
          } catch (err) {
            result.registry = {
              status: 'failed',
              detail: `${err instanceof Error ? err.message : String(err)} — run \`cleo nexus projects register ${plan.destRoot}\``,
            };
          }
        } else {
          result.registry = {
            status: 'skipped',
            detail: `no global store in this bundle; run \`cleo nexus projects register ${plan.destRoot}\``,
          };
        }
      }
      sections.push(result);
    }

    const omittedSecrets: PortableImportResult['omittedSecrets'] = [];
    for (const plan of plans) {
      for (const s of plan.section.omittedSecrets) {
        omittedSecrets.push({ ...s, section: plan.destDir });
      }
    }
    const result: PortableImportResult = {
      bundlePath: path.resolve(input.bundlePath),
      scope: manifest.backup.scope,
      sections,
      lossless: sections.every((s) => s.mismatches.length === 0),
      secretsIncluded: manifest.backup.secretsIncluded,
      omittedSecrets,
    };
    if (input.requireLossless === true && !result.lossless) {
      throw new PortableBundleError(
        'E_RESTORE_MISMATCH',
        'Restored row counts differ from the bundle manifest (see details.sections[].mismatches)',
        result,
      );
    }
    return result;
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

/**
 * Point the ambient global registry at a relocated project: move the existing
 * row (keyed by projectId) or register the project when it is absent.
 *
 * Uses the canonical nexus registry API against the CURRENT `getCleoHome()`,
 * so callers must run it with the destination home active.
 *
 * @param projectId - Stable projectId from project-info.json (null when absent).
 * @param newRoot - New project root.
 * @returns Registry outcome.
 */
export async function registerRelocatedProject(
  projectId: string | null,
  newRoot: string,
): Promise<NonNullable<PortableImportSectionResult['registry']>> {
  const registry = await import('../nexus/registry.js');
  if (projectId) {
    const rows = await registry.nexusList();
    const existing = rows.find((r) => r.projectId === projectId);
    if (existing) {
      if (existing.path === newRoot) {
        return { status: 'unchanged', detail: `already registered at ${newRoot}` };
      }
      await registry.nexusMoveProject(projectId, newRoot);
      return {
        status: 'updated',
        detail: `registry row ${projectId}: ${existing.path} -> ${newRoot}`,
      };
    }
  }
  await registry.nexusRegister(newRoot, { path: newRoot });
  return { status: 'registered', detail: `registered ${newRoot}` };
}
