/**
 * Global (~/.cleo) home scaffolding: directory structure, stale-entry
 * cleanup, CleoOS hub template seeding, and the top-level
 * ensureGlobalScaffold orchestrator.
 */

import type { Dirent } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ScaffoldResult } from '@cleocode/contracts/scaffold-diagnostics';
import { pushWarning } from '../output.js';
import {
  getCleoCantWorkflowsDir,
  getCleoGlobalAgentsDir,
  getCleoGlobalRecipesDir,
  getCleoHome,
  getCleoPiExtensionsDir,
} from '../paths.js';
import { getPackageRoot } from './ensure-config.js';
import { ensureGlobalTemplates } from './ensure-templates.js';

/**
 * Required subdirectories under the global ~/.cleo/ home.
 */
export const REQUIRED_GLOBAL_SUBDIRS = [
  'logs',
  'templates',
  'global-recipes',
  'pi-extensions',
  'cant-workflows',
  'agents',
] as const;

/**
 * Stale entries that must NOT exist at the global ~/.cleo/ level.
 */
export const STALE_GLOBAL_ENTRIES = [
  'adrs',
  'rcasd',
  'agent-outputs',
  'backups',
  'sandbox',
  'tasks.db',
  'tasks.db-shm',
  'tasks.db-wal',
  'brain-worker.pid',
  'VERSION',
  'schemas',
  'bin',
  '.install-state',
  'templates/templates',
] as const;

/**
 * Result of scaffolding the CleoOS Hub.
 *
 * @task T1571
 */
export interface ScaffoldHubData {
  /** What action was taken on the hub. */
  action: 'created' | 'repaired' | 'skipped';
  /** Absolute path to the hub root. */
  path: string;
  /** Optional detail message. */
  details?: string;
}

/**
 * Recursively copy a template tree from srcDir into dstDir.
 *
 * Never overwrites existing files. Missing subdirectories are created on
 * demand. Symbolic links and special files are skipped silently.
 */
async function copyTemplateTree(
  srcDir: string,
  dstDir: string,
): Promise<{ copied: number; kept: number }> {
  if (!existsSync(srcDir)) {
    return { copied: 0, kept: 0 };
  }

  await mkdir(dstDir, { recursive: true });

  let copied = 0;
  let kept = 0;

  let entries: Dirent[];
  try {
    entries = await readdir(srcDir, { withFileTypes: true });
  } catch (err) {
    pushWarning({
      code: 'W_SCAFFOLD_PARTIAL',
      message: `Could not read template dir ${srcDir}: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { copied: 0, kept: 0 };
  }

  for (const entry of entries) {
    const srcPath = join(srcDir, entry.name);
    const dstPath = join(dstDir, entry.name);

    if (entry.isDirectory()) {
      const sub = await copyTemplateTree(srcPath, dstPath);
      copied += sub.copied;
      kept += sub.kept;
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (existsSync(dstPath)) {
      kept += 1;
      continue;
    }

    try {
      await copyFile(srcPath, dstPath);
      copied += 1;
    } catch (err) {
      pushWarning({
        code: 'W_SCAFFOLD_PARTIAL',
        message: `Could not copy template file ${srcPath} -> ${dstPath}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return { copied, kept };
}

/**
 * Resolve the absolute root directory of the bundled CleoOS hub templates.
 *
 * @returns Absolute path to the existing template root, or `null` if none found
 */
function resolveCleoOsHubTemplateRoot(): string | null {
  const packageRoot = getPackageRoot();
  const candidates = [
    join(packageRoot, '..', 'templates', 'cleoos-hub'),
    join(packageRoot, '..', 'cleo', 'templates', 'cleoos-hub'),
    join(packageRoot, '..', '..', 'packages', 'cleo', 'templates', 'cleoos-hub'),
    join(packageRoot, 'templates', 'cleoos-hub'),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/**
 * Ensure the global ~/.cleo/ home directory and its required
 * subdirectories exist. Idempotent.
 *
 * @returns Scaffold result indicating the action taken
 */
export async function ensureGlobalHome(): Promise<ScaffoldResult> {
  const cleoHome = getCleoHome();
  const alreadyExists = existsSync(cleoHome);

  await mkdir(cleoHome, { recursive: true });

  for (const subdir of REQUIRED_GLOBAL_SUBDIRS) {
    await mkdir(join(cleoHome, subdir), { recursive: true });
  }

  const globalConfigPath = join(cleoHome, 'config.json');
  if (!existsSync(globalConfigPath)) {
    const templatePath = join(getPackageRoot(), 'templates', 'global-config.template.json');
    if (existsSync(templatePath)) {
      const template = readFileSync(templatePath, 'utf-8');
      const resolved = template.replace('{{SCHEMA_VERSION_GLOBAL_CONFIG}}', '1.0.0');
      await writeFile(globalConfigPath, resolved);
    }
  }

  const homedir = (await import('node:os')).homedir();
  const legacyCleoHome = join(homedir, '.cleo');
  const cleanupPaths = [cleoHome];
  if (legacyCleoHome !== cleoHome && existsSync(legacyCleoHome)) {
    cleanupPaths.push(legacyCleoHome);
  }

  for (const homeDir of cleanupPaths) {
    for (const stale of STALE_GLOBAL_ENTRIES) {
      const stalePath = join(homeDir, stale);
      if (existsSync(stalePath)) {
        try {
          await rm(stalePath, { recursive: true, force: true });
          pushWarning({
            code: 'W_SCAFFOLD_PARTIAL',
            message: `Removed stale global entry: ${stalePath}`,
          });
        } catch (err) {
          pushWarning({
            code: 'W_SCAFFOLD_PARTIAL',
            message: `Could not remove stale global entry ${stalePath}: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    }
  }

  return {
    action: alreadyExists ? 'skipped' : 'created',
    path: cleoHome,
    details: alreadyExists
      ? 'Global home already existed, ensured subdirs'
      : `Created ~/.cleo/ with ${REQUIRED_GLOBAL_SUBDIRS.length} subdirectories`,
  };
}

/**
 * Ensure the CleoOS Hub subdirectories exist under the global CLEO home
 * and seed all bundled hub templates if they are not already present.
 *
 * Idempotent: re-running is safe and will never overwrite a file that
 * already exists.
 *
 * @returns Scaffold result for the CleoOS hub root
 */
// SSoT-EXEMPT:engine-migration-T1571
export async function ensureCleoOsHub(): Promise<ScaffoldResult> {
  const recipesDir = getCleoGlobalRecipesDir();
  const piExtDir = getCleoPiExtensionsDir();
  const cantWorkflowsDir = getCleoCantWorkflowsDir();
  const agentsDir = getCleoGlobalAgentsDir();

  try {
    await mkdir(recipesDir, { recursive: true });
    await mkdir(piExtDir, { recursive: true });
    await mkdir(cantWorkflowsDir, { recursive: true });
    await mkdir(agentsDir, { recursive: true });
  } catch (err) {
    return {
      action: 'skipped',
      path: recipesDir,
      details: `Failed to create CleoOS hub directories: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const templateRoot = resolveCleoOsHubTemplateRoot();
  if (!templateRoot) {
    return {
      action: 'skipped',
      path: recipesDir,
      details: 'CleoOS hub template directory not found in any expected location',
    };
  }

  let piResult: { copied: number; kept: number };
  let recipesResult: { copied: number; kept: number };
  try {
    piResult = await copyTemplateTree(join(templateRoot, 'pi-extensions'), piExtDir);
    recipesResult = await copyTemplateTree(join(templateRoot, 'global-recipes'), recipesDir);
  } catch (err) {
    return {
      action: 'skipped',
      path: recipesDir,
      details: `Failed to seed CleoOS hub templates: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const totalCopied = piResult.copied + recipesResult.copied;
  return {
    action: totalCopied > 0 ? 'created' : 'skipped',
    path: recipesDir,
    details: `pi-extensions: ${piResult.copied} created/${piResult.kept} kept, global-recipes: ${recipesResult.copied} created/${recipesResult.kept} kept`,
  };
}

/**
 * Perform a complete global scaffold operation: home + templates + CleoOS hub.
 *
 * @returns Combined scaffold results
 */
export async function ensureGlobalScaffold(): Promise<{
  home: ScaffoldResult;
  templates: ScaffoldResult;
  cleoosHub: ScaffoldResult;
}> {
  const home = await ensureGlobalHome();
  const templates = await ensureGlobalTemplates();
  const cleoosHub = await ensureCleoOsHub();

  return { home, templates, cleoosHub };
}
