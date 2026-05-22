/**
 * Global template scaffolding: injection template and orchestrator
 * identity file deployment under the global CLEO home.
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ScaffoldResult } from '@cleocode/contracts/scaffold-diagnostics';
import { getCleoHome, getCleoTemplatesDir } from '../paths.js';

/**
 * Resolve the source location of CLEOOS-IDENTITY.md from the installed package.
 *
 * Per ADR-068 (T1932) the starter-bundle has been deleted. T1935 will wire a
 * proper resolution path. Until then returns null.
 *
 * @returns Absolute path to the source identity file, or null if not found.
 * @internal Used by ensureGlobalIdentity.
 */
function resolveIdentitySourcePath(): string | null {
  return null;
}

/**
 * Ensure the global CLEO injection template is installed.
 *
 * Idempotent: skips if the template already exists with correct content.
 *
 * @returns Scaffold result indicating the action taken
 */
export async function ensureGlobalTemplates(): Promise<ScaffoldResult> {
  const { getInjectionTemplateContent } = await import('../injection.js');

  const templatesDir = getCleoTemplatesDir();
  const injectionPath = join(templatesDir, 'CLEO-INJECTION.md');

  await mkdir(templatesDir, { recursive: true });

  const templateContent = getInjectionTemplateContent();
  if (!templateContent) {
    return {
      action: 'skipped',
      path: injectionPath,
      details: 'Bundled injection template not found; skipped',
    };
  }

  if (existsSync(injectionPath)) {
    const existing = readFileSync(injectionPath, 'utf-8');
    if (existing === templateContent) {
      return { action: 'skipped', path: injectionPath, details: 'Template already current' };
    }
    await writeFile(injectionPath, templateContent, 'utf-8');
    return {
      action: 'repaired',
      path: injectionPath,
      details: 'Updated injection template to match bundled version',
    };
  }

  await writeFile(injectionPath, templateContent, 'utf-8');
  return { action: 'created', path: injectionPath };
}

/**
 * Ensure the Cleo Prime identity file is deployed to the global XDG path.
 *
 * SSoT architecture (T631): CLEOOS-IDENTITY.md lives ONCE at the global path.
 * Idempotent. Always overwrites if `forceRefresh` is true.
 *
 * @param forceRefresh - Overwrite even if the file exists. Default false.
 * @returns ScaffoldResult describing what happened.
 */
export async function ensureGlobalIdentity(forceRefresh = false): Promise<ScaffoldResult> {
  const sourcePath = resolveIdentitySourcePath();
  if (!sourcePath) {
    return {
      action: 'skipped',
      path: '',
      details: 'CLEOOS-IDENTITY.md source not found in monorepo or installed package',
    };
  }

  const cleoHome = getCleoHome();
  const dst = join(cleoHome, 'CLEOOS-IDENTITY.md');

  try {
    await mkdir(cleoHome, { recursive: true });
  } catch (err) {
    return {
      action: 'skipped',
      path: dst,
      details: `Failed to create global cleo home: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (existsSync(dst) && !forceRefresh) {
    return { action: 'skipped', path: dst, details: 'identity already present' };
  }

  const existedBefore = existsSync(dst);
  try {
    const content = readFileSync(sourcePath, 'utf-8');
    await writeFile(dst, content);
    return {
      action: existedBefore ? 'repaired' : 'created',
      path: dst,
      details: `from ${sourcePath}`,
    };
  } catch (err) {
    return {
      action: 'skipped',
      path: dst,
      details: `Failed to write identity: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
