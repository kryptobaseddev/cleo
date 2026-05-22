/**
 * Read-only global-level health checks (check* functions) for the global
 * CLEO home, injection templates, and orchestrator identity.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir as getHomedir } from 'node:os';
import { join } from 'node:path';
import type { CheckResult } from '@cleocode/contracts/scaffold-diagnostics';
import { getCleoHome, getCleoTemplatesDir } from '../paths.js';
import { REQUIRED_GLOBAL_SUBDIRS } from './global-scaffold.js';

/**
 * Check that the global CLEOOS-IDENTITY.md file is present and non-empty.
 *
 * @returns Check result with status, path details, and self-heal command.
 */
export function checkGlobalIdentity(): CheckResult {
  const cleoHome = getCleoHome();
  const identityPath = join(cleoHome, 'CLEOOS-IDENTITY.md');

  if (!existsSync(identityPath)) {
    return {
      id: 'global_identity',
      category: 'global',
      status: 'failed',
      message: 'Global CLEOOS-IDENTITY.md not found — orchestrator persona missing',
      details: { path: identityPath, exists: false },
      fix: 'cleo upgrade (auto-deploys identity)',
    };
  }

  let size = 0;
  try {
    size = statSync(identityPath).size;
  } catch {
    /* ignore */
  }

  if (size === 0) {
    return {
      id: 'global_identity',
      category: 'global',
      status: 'failed',
      message: 'Global CLEOOS-IDENTITY.md exists but is empty',
      details: { path: identityPath, exists: true, size: 0 },
      fix: 'cleo upgrade --refresh-identity',
    };
  }

  return {
    id: 'global_identity',
    category: 'global',
    status: 'passed',
    message: 'Global CLEOOS-IDENTITY.md present',
    details: { path: identityPath, exists: true, size },
    fix: '',
  };
}

/**
 * Check that the global ~/.cleo/ home and its required subdirectories exist.
 *
 * @returns Check result with status and missing subdirectory details
 */
export function checkGlobalHome(): CheckResult {
  const cleoHome = getCleoHome();

  if (!existsSync(cleoHome)) {
    return {
      id: 'global_home',
      category: 'global',
      status: 'failed',
      message: 'Global ~/.cleo/ directory not found',
      details: { path: cleoHome, exists: false },
      fix: 'cleo init',
    };
  }

  const missingDirs = REQUIRED_GLOBAL_SUBDIRS.filter((dir) => !existsSync(join(cleoHome, dir)));

  if (missingDirs.length > 0) {
    return {
      id: 'global_home',
      category: 'global',
      status: 'warning',
      message: `Global home exists but missing subdirs: ${missingDirs.join(', ')}`,
      details: { path: cleoHome, exists: true, missingDirs },
      fix: 'cleo upgrade --include-global',
    };
  }

  return {
    id: 'global_home',
    category: 'global',
    status: 'passed',
    message: 'Global ~/.cleo/ home and subdirectories present',
    details: { path: cleoHome, exists: true, subdirs: REQUIRED_GLOBAL_SUBDIRS.length },
    fix: null,
  };
}

/**
 * Check that the global injection template is present and current.
 *
 * @returns Check result with template version and sync status
 */
export function checkGlobalTemplates(): CheckResult {
  const templatesDir = getCleoTemplatesDir();
  const injectionPath = join(templatesDir, 'CLEO-INJECTION.md');

  if (!existsSync(injectionPath)) {
    return {
      id: 'global_templates',
      category: 'global',
      status: 'failed',
      message: 'CLEO-INJECTION.md template not found in global templates',
      details: { path: injectionPath, exists: false },
      fix: 'cleo init',
    };
  }

  const xdgContent = readFileSync(injectionPath, 'utf-8');
  const xdgVersion = xdgContent.match(/^Version:\s*(.+)$/m)?.[1]?.trim();
  const home = getHomedir();
  const legacyPath = join(home, '.cleo', 'templates', 'CLEO-INJECTION.md');

  if (existsSync(legacyPath)) {
    const legacyContent = readFileSync(legacyPath, 'utf-8');
    const legacyVersion = legacyContent.match(/^Version:\s*(.+)$/m)?.[1]?.trim();
    if (legacyVersion && xdgVersion && legacyVersion !== xdgVersion) {
      return {
        id: 'global_templates',
        category: 'global',
        status: 'warning',
        message: `Legacy template version (${legacyVersion}) out of sync with XDG (${xdgVersion})`,
        details: { path: injectionPath, exists: true, xdgVersion, legacyVersion, legacyPath },
        fix: 'npm install -g @cleocode/cleo (reinstall syncs both paths)',
      };
    }
  }

  return {
    id: 'global_templates',
    category: 'global',
    status: 'passed',
    message: `Global injection template present (v${xdgVersion ?? 'unknown'})`,
    details: { path: injectionPath, exists: true, version: xdgVersion },
    fix: null,
  };
}
