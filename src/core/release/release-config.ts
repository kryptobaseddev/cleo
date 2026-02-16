/**
 * Release configuration loader and validator.
 *
 * Loads release configuration from .cleo/config.json, providing defaults
 * for versioning scheme, changelog format, artifact types, and gates.
 *
 * @task T4454
 * @epic T4454
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCleoDir } from '../paths.js';

/** Synchronous config value reader (avoids async config pipeline). */
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

/** Default configuration values. */
const DEFAULTS = {
  versioningScheme: 'calver',
  tagPrefix: 'v',
  changelogFormat: 'keepachangelog',
  changelogFile: 'CHANGELOG.md',
  artifactType: 'generic-tarball',
} as const;

/** Release configuration shape. */
export interface ReleaseConfig {
  versioningScheme: string;
  tagPrefix: string;
  changelogFormat: string;
  changelogFile: string;
  artifactType: string;
  gates: ReleaseGate[];
  versionBump: {
    files: Array<{
      file: string;
      strategy: string;
      field?: string;
    }>;
  };
  security: {
    enableProvenance: boolean;
    slsaLevel: number;
    requireSignedCommits: boolean;
  };
}

/** Release gate definition. */
export interface ReleaseGate {
  name: string;
  type: 'tests' | 'lint' | 'audit' | 'custom';
  command: string;
  required: boolean;
}

/** Load release configuration with defaults. */
export function loadReleaseConfig(cwd?: string): ReleaseConfig {
  return {
    versioningScheme: readConfigValueSync('release.versioning.scheme', DEFAULTS.versioningScheme, cwd) as string,
    tagPrefix: readConfigValueSync('release.versioning.tagPrefix', DEFAULTS.tagPrefix, cwd) as string,
    changelogFormat: readConfigValueSync('release.changelog.format', DEFAULTS.changelogFormat, cwd) as string,
    changelogFile: readConfigValueSync('release.changelog.file', DEFAULTS.changelogFile, cwd) as string,
    artifactType: readConfigValueSync('release.artifact.type', DEFAULTS.artifactType, cwd) as string,
    gates: readConfigValueSync('release.gates', [], cwd) as ReleaseGate[],
    versionBump: {
      files: readConfigValueSync('release.versionBump.files', [], cwd) as ReleaseConfig['versionBump']['files'],
    },
    security: {
      enableProvenance: readConfigValueSync('release.security.enableProvenance', false, cwd) as boolean,
      slsaLevel: readConfigValueSync('release.security.slsaLevel', 3, cwd) as number,
      requireSignedCommits: readConfigValueSync('release.security.requireSignedCommits', false, cwd) as boolean,
    },
  };
}

/** Validate release configuration. */
export function validateReleaseConfig(config: ReleaseConfig): {
  valid: boolean;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Validate versioning scheme
  const validSchemes = ['semver', 'calver', 'custom'];
  if (!validSchemes.includes(config.versioningScheme)) {
    errors.push(`Invalid versioning scheme: ${config.versioningScheme}`);
  }

  // Validate changelog format
  const validFormats = ['keepachangelog', 'conventional', 'custom'];
  if (!validFormats.includes(config.changelogFormat)) {
    warnings.push(`Unknown changelog format: ${config.changelogFormat}`);
  }

  // Validate gates
  for (const gate of config.gates) {
    if (!gate.name) errors.push('Gate missing name');
    if (!gate.command) errors.push(`Gate '${gate.name}' missing command`);
  }

  // Validate version bump targets
  for (const file of config.versionBump.files) {
    if (!file.file) errors.push('Version bump target missing file');
    const validStrategies = ['plain', 'json', 'toml', 'sed'];
    if (!validStrategies.includes(file.strategy)) {
      errors.push(`Invalid bump strategy for ${file.file}: ${file.strategy}`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/** Get artifact type from config. */
export function getArtifactType(cwd?: string): string {
  return loadReleaseConfig(cwd).artifactType;
}

/** Get release gates from config. */
export function getReleaseGates(cwd?: string): ReleaseGate[] {
  return loadReleaseConfig(cwd).gates;
}

/** Get changelog configuration. */
export function getChangelogConfig(cwd?: string): {
  format: string;
  file: string;
} {
  const config = loadReleaseConfig(cwd);
  return { format: config.changelogFormat, file: config.changelogFile };
}
