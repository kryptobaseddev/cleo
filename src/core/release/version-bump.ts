/**
 * Version bump - config-driven version bumping across project files.
 *
 * Reads release.versionBump from .cleo/config.json and updates all
 * configured files with the new version. Supports strategies:
 *   plain - Overwrite entire file (e.g., VERSION)
 *   json  - Update a JSON field (e.g., package.json .version)
 *   toml  - Update a TOML key (e.g., Cargo.toml)
 *   sed   - Custom regex substitution
 *
 * @task T4454
 * @epic T4454
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCleoDir, getProjectRoot } from '../paths.js';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';

/** Synchronous config value reader for version bump targets. */
function readConfigValueSync(path: string, defaultValue: unknown, cwd?: string): unknown {
  try {
    const configPath = join(getCleoDir(cwd), 'config.json');
    if (!existsSync(configPath)) return defaultValue;
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    const keys = path.split('.');
    let value: unknown = config;
    for (const key of keys) {
      if (value == null || typeof value !== 'object') return defaultValue;
      value = (value as Record<string, unknown>)[key];
    }
    return value ?? defaultValue;
  } catch {
    return defaultValue;
  }
}

/** Three-part version regex (X.Y.Z) - matches both semver and CalVer base format. */
const THREE_PART_VERSION_REGEX = /^\d+\.\d+\.\d+$/;

/** CalVer regex (YYYY.M.patch or YYYY.MM.patch, with optional pre-release suffix). */
const CALVER_REGEX = /^\d{4}\.\d{1,2}\.\d+$/;

/** Version with optional pre-release suffix (e.g., 2026.2.0-rc.1). */
const VERSION_WITH_PRERELEASE = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/;

/** Validate version format (semver X.Y.Z or CalVer YYYY.M.patch, with optional pre-release). */
export function validateVersionFormat(version: string): boolean {
  return VERSION_WITH_PRERELEASE.test(version);
}

/** Check if a version string is CalVer format. */
export function isCalVer(version: string): boolean {
  const base = version.replace(/-.*$/, '');
  return CALVER_REGEX.test(base) && parseInt(base.split('.')[0]!, 10) >= 2000;
}

/** Bump type for version calculation. */
export type BumpType = 'patch' | 'minor' | 'major';

/** Calculate new version from current + bump type. */
export function calculateNewVersion(current: string, bump: BumpType | string): string {
  // If bump is already a version, validate and return
  if (VERSION_WITH_PRERELEASE.test(bump)) return bump;

  // Strip pre-release suffix for base version parsing
  const base = current.replace(/-.*$/, '');

  if (!THREE_PART_VERSION_REGEX.test(base) && !CALVER_REGEX.test(base)) {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `Invalid current version: '${current}' (expected X.Y.Z or YYYY.M.patch)`,
    );
  }

  const parts = base.split('.').map(Number) as [number, number, number];

  if (isCalVer(current)) {
    // CalVer: YYYY.MM.patch
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;

    switch (bump) {
      case 'patch':
        // Same year+month: increment patch. Different: reset to 0.
        if (parts[0] === year && parts[1] === month) {
          parts[2]++;
        } else {
          return `${year}.${month}.0`;
        }
        break;
      case 'minor':
      case 'major':
        // CalVer doesn't have minor/major — just roll to current date
        return `${year}.${month}.0`;
      default:
        throw new CleoError(
          ExitCode.VALIDATION_ERROR,
          `Invalid bump type: '${bump}'. Expected: patch, minor, major, or a version string`,
        );
    }
  } else {
    // Semver: X.Y.Z
    switch (bump) {
      case 'patch':
        parts[2]++;
        break;
      case 'minor':
        parts[1]++;
        parts[2] = 0;
        break;
      case 'major':
        parts[0]++;
        parts[1] = 0;
        parts[2] = 0;
        break;
      default:
        throw new CleoError(
          ExitCode.VALIDATION_ERROR,
          `Invalid bump type: '${bump}'. Expected: patch, minor, major, or X.Y.Z`,
        );
    }
  }

  return parts.join('.');
}

/** Version bump target config from .cleo/config.json. */
export interface VersionBumpTarget {
  file: string;
  strategy: 'plain' | 'json' | 'toml' | 'sed';
  field?: string;       // For json strategy
  key?: string;         // For toml strategy
  section?: string;     // For toml strategy
  pattern?: string;     // For sed strategy (with {{VERSION}} placeholder)
}

/** Raw config entry shape from .cleo/config.json (uses path/jsonPath/sedPattern). */
interface RawVersionBumpEntry {
  path?: string;
  file?: string;
  strategy: 'plain' | 'json' | 'toml' | 'sed';
  jsonPath?: string;
  field?: string;
  key?: string;
  section?: string;
  sedPattern?: string;
  pattern?: string;
  optional?: boolean;
  description?: string;
}

/** Get version bump configuration, mapping config field names to VersionBumpTarget. */
export function getVersionBumpConfig(cwd?: string): VersionBumpTarget[] {
  try {
    const raw = readConfigValueSync('release.versionBump.files', [], cwd) as RawVersionBumpEntry[];
    return raw.map(entry => ({
      file: entry.path ?? entry.file ?? '',
      strategy: entry.strategy,
      field: entry.jsonPath?.replace(/^\./, '') ?? entry.field,
      key: entry.key,
      section: entry.section,
      pattern: entry.sedPattern ?? entry.pattern,
    })).filter(t => t.file !== '');
  } catch {
    return [];
  }
}

/** Check if version bump is configured. */
export function isVersionBumpConfigured(cwd?: string): boolean {
  return getVersionBumpConfig(cwd).length > 0;
}

/** Bump result for a single file. */
export interface BumpResult {
  file: string;
  strategy: string;
  success: boolean;
  previousVersion?: string;
  newVersion?: string;
  error?: string;
}

/** Apply version bump to a single target file. */
function bumpFile(
  target: VersionBumpTarget,
  newVersion: string,
  projectRoot: string,
): BumpResult {
  const filePath = join(projectRoot, target.file);

  if (!existsSync(filePath)) {
    return {
      file: target.file,
      strategy: target.strategy,
      success: false,
      error: `File not found: ${target.file}`,
    };
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    let previousVersion: string | undefined;
    let newContent: string;

    switch (target.strategy) {
      case 'plain': {
        previousVersion = content.trim();
        newContent = newVersion + '\n';
        break;
      }

      case 'json': {
        const field = target.field ?? 'version';
        const json = JSON.parse(content);
        previousVersion = getNestedField(json, field) as string;
        setNestedField(json, field, newVersion);
        newContent = JSON.stringify(json, null, 2) + '\n';
        break;
      }

      case 'toml': {
        const key = target.key ?? 'version';
        const versionRegex = new RegExp(`^(${key}\\s*=\\s*")([^"]+)(")`, 'm');
        const match = content.match(versionRegex);
        previousVersion = match?.[2];
        newContent = content.replace(versionRegex, `$1${newVersion}$3`);
        break;
      }

      case 'sed': {
        const pattern = target.pattern ?? '';
        if (!pattern.includes('{{VERSION}}')) {
          return {
            file: target.file,
            strategy: target.strategy,
            success: false,
            error: 'sed strategy requires {{VERSION}} placeholder in pattern',
          };
        }
        const regex = new RegExp(pattern.replace('{{VERSION}}', '([\\d.]+)'));
        const match = content.match(regex);
        previousVersion = match?.[1];
        newContent = content.replace(
          regex,
          pattern.replace('{{VERSION}}', newVersion),
        );
        break;
      }

      default:
        return {
          file: target.file,
          strategy: target.strategy,
          success: false,
          error: `Unknown strategy: ${target.strategy}`,
        };
    }

    writeFileSync(filePath, newContent, 'utf-8');
    return {
      file: target.file,
      strategy: target.strategy,
      success: true,
      previousVersion,
      newVersion,
    };
  } catch (err) {
    return {
      file: target.file,
      strategy: target.strategy,
      success: false,
      error: String(err),
    };
  }
}

/** Bump version in all configured files. */
export function bumpVersionFromConfig(
  newVersion: string,
  options: { dryRun?: boolean } = {},
  cwd?: string,
): { results: BumpResult[]; allSuccess: boolean } {
  if (!validateVersionFormat(newVersion)) {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `Invalid version: '${newVersion}' (expected X.Y.Z or YYYY.M.patch)`,
    );
  }

  const targets = getVersionBumpConfig(cwd);
  if (targets.length === 0) {
    throw new CleoError(
      ExitCode.GENERAL_ERROR,
      'No version bump targets configured. Add release.versionBump.files to .cleo/config.json',
    );
  }

  const projectRoot = getProjectRoot(cwd);
  const results: BumpResult[] = [];

  if (options.dryRun) {
    for (const target of targets) {
      results.push({
        file: target.file,
        strategy: target.strategy,
        success: true,
        newVersion,
      });
    }
    return { results, allSuccess: true };
  }

  for (const target of targets) {
    results.push(bumpFile(target, newVersion, projectRoot));
  }

  const allSuccess = results.every(r => r.success);
  return { results, allSuccess };
}

// Nested field helpers
function getNestedField(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => (acc as Record<string, unknown>)?.[key], obj);
}

function setNestedField(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof current[parts[i]!] !== 'object') current[parts[i]!] = {};
    current = current[parts[i]!] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
}
