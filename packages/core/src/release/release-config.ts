/**
 * Release configuration loader and validator.
 *
 * Loads release configuration from .cleo/release-config.json (T820) with
 * fallback to .cleo/config.json for legacy fields. Provides defaults for
 * versioning scheme, changelog format, artifact types, gates, git workflow,
 * registries, and security settings.
 *
 * Priority order:
 *   1. .cleo/release-config.json (T820 project-agnostic config)
 *   2. .cleo/config.json nested under release.* (legacy)
 *   3. DEFAULTS constants
 *
 * @task T820
 * @epic T820
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCleoDir } from '../paths.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Release gate definition. */
export interface ReleaseGate {
  name: string;
  type: 'tests' | 'lint' | 'audit' | 'custom';
  command: string;
  required: boolean;
}

/** GitFlow branch configuration. */
export interface GitFlowConfig {
  enabled: boolean;
  branches: {
    main: string;
    develop: string;
    featurePrefix: string;
    hotfixPrefix: string;
    releasePrefix: string;
  };
}

/** Channel-to-branch mapping for npm dist-tag resolution. */
export interface ChannelConfig {
  main: string;
  develop: string;
  feature: string;
  custom?: Record<string, string>;
}

/** Push mode: direct push vs PR creation vs auto-detect. */
export type PushMode = 'direct' | 'pr' | 'auto';

/** Known registry identifiers. */
export type RegistryId = 'npm' | 'crates' | 'docker' | 'pypi' | 'maven' | 'nuget' | 'ghcr';

/** Security / provenance settings. */
export interface SecurityConfig {
  enableProvenance: boolean;
  slsaLevel: number;
  requireSignedCommits: boolean;
}

/** Release configuration shape (T820 extended). */
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
  security: SecurityConfig;
  /** Git workflow mode: 'direct' push or PR-first. */
  gitWorkflow?: PushMode;
  /** Registries to publish to (e.g. ['npm', 'docker']). */
  registries?: string[];
  /** Artifact output paths for gate checks. */
  buildArtifactPaths?: string[];
  /** Skip build artifact presence gate (useful for source-only projects). */
  skipBuildArtifactGate?: boolean;
  /** Pre-release distribution channel (e.g. 'beta', 'alpha'). */
  prereleaseChannel?: string;
  /** GitFlow branch configuration. */
  gitflow?: GitFlowConfig;
  /** Channel-to-dist-tag mapping. */
  channels?: ChannelConfig;
  /** Legacy push config — prefer gitWorkflow. */
  push?: {
    mode?: PushMode;
  };
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default configuration values. */
const DEFAULTS = {
  versioningScheme: 'calver',
  tagPrefix: 'v',
  changelogFormat: 'keepachangelog',
  changelogFile: 'CHANGELOG.md',
  artifactType: 'generic-tarball',
} as const;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Read a flat release-config.json file; returns parsed object or null. */
function readReleaseConfigJson(cwd?: string): Record<string, unknown> | null {
  try {
    const configPath = join(getCleoDir(cwd), 'release-config.json');
    if (!existsSync(configPath)) return null;
    return JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Read a value from legacy .cleo/config.json using dotted path notation. */
function readLegacyConfigValue(path: string, defaultValue: unknown, cwd?: string): unknown {
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

/** Coerce a value to a typed result, falling back to the default if undefined/null. */
function coerce<T>(value: unknown, defaultValue: T): T {
  if (value === undefined || value === null) return defaultValue;
  return value as T;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load release configuration with defaults.
 *
 * Reads from .cleo/release-config.json first (T820 flat format), then falls
 * back to .cleo/config.json nested keys for legacy compatibility.
 */
export function loadReleaseConfig(cwd?: string): ReleaseConfig {
  const rc = readReleaseConfigJson(cwd);

  // Helper to pull from release-config.json flat key, then legacy dotted path,
  // then the compiled default.
  function get<T>(rcKey: string, legacyPath: string, defaultValue: T): T {
    if (rc !== null && rc[rcKey] !== undefined && rc[rcKey] !== null) {
      return rc[rcKey] as T;
    }
    return readLegacyConfigValue(legacyPath, defaultValue, cwd) as T;
  }

  const versioningScheme = get<string>(
    'versionScheme',
    'release.versioning.scheme',
    DEFAULTS.versioningScheme,
  );
  const tagPrefix = get<string>('tagPrefix', 'release.versioning.tagPrefix', DEFAULTS.tagPrefix);
  const changelogFormat = get<string>(
    'changelogFormat',
    'release.changelog.format',
    DEFAULTS.changelogFormat,
  );
  const changelogFile = get<string>(
    'changelogFile',
    'release.changelog.file',
    DEFAULTS.changelogFile,
  );
  const artifactType = get<string>('artifactType', 'release.artifact.type', DEFAULTS.artifactType);

  const gates = get<ReleaseGate[]>('gates', 'release.gates', []);
  const versionBumpFiles = get<ReleaseConfig['versionBump']['files']>(
    'versionBumpFiles',
    'release.versionBump.files',
    [],
  );

  // Security block — merge from rc.security if present
  const securityRc = rc?.security as Partial<SecurityConfig> | undefined;
  const security: SecurityConfig = {
    enableProvenance: coerce(
      securityRc?.enableProvenance,
      readLegacyConfigValue('release.security.enableProvenance', false, cwd) as boolean,
    ),
    slsaLevel: coerce(
      securityRc?.slsaLevel,
      readLegacyConfigValue('release.security.slsaLevel', 3, cwd) as number,
    ),
    requireSignedCommits: coerce(
      securityRc?.requireSignedCommits,
      readLegacyConfigValue('release.security.requireSignedCommits', false, cwd) as boolean,
    ),
  };

  // T820 new fields — only read from release-config.json (no legacy mapping)
  const gitWorkflow = rc?.gitWorkflow as PushMode | undefined;
  const registries = rc?.registries as string[] | undefined;
  const buildArtifactPaths = rc?.buildArtifactPaths as string[] | undefined;
  const skipBuildArtifactGate = rc?.skipBuildArtifactGate as boolean | undefined;
  const prereleaseChannel = rc?.prereleaseChannel as string | undefined;
  const gitflow = rc?.gitflow as GitFlowConfig | undefined;
  const channels = rc?.channels as ChannelConfig | undefined;
  const push = rc?.push as ReleaseConfig['push'] | undefined;

  const config: ReleaseConfig = {
    versioningScheme,
    tagPrefix,
    changelogFormat,
    changelogFile,
    artifactType,
    gates,
    versionBump: { files: versionBumpFiles },
    security,
  };

  // Only assign optional fields when they are explicitly set
  if (gitWorkflow !== undefined) config.gitWorkflow = gitWorkflow;
  if (registries !== undefined) config.registries = registries;
  if (buildArtifactPaths !== undefined) config.buildArtifactPaths = buildArtifactPaths;
  if (skipBuildArtifactGate !== undefined) config.skipBuildArtifactGate = skipBuildArtifactGate;
  if (prereleaseChannel !== undefined) config.prereleaseChannel = prereleaseChannel;
  if (gitflow !== undefined) config.gitflow = gitflow;
  if (channels !== undefined) config.channels = channels;
  if (push !== undefined) config.push = push;

  return config;
}

/** Known valid registries (others produce a warning, not an error). */
const KNOWN_REGISTRIES: string[] = ['npm', 'crates', 'docker', 'pypi', 'maven', 'nuget', 'ghcr'];

/** Valid git workflow values. */
const VALID_GIT_WORKFLOWS: PushMode[] = ['direct', 'pr', 'auto'];

/**
 * Validate release configuration.
 *
 * Returns `valid: true` when there are no errors. Warnings do not block release.
 */
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

  // Validate gitWorkflow (T820 RELEASE-01)
  if (config.gitWorkflow !== undefined && !VALID_GIT_WORKFLOWS.includes(config.gitWorkflow)) {
    errors.push(
      `Invalid gitWorkflow: '${config.gitWorkflow}'. Must be one of: ${VALID_GIT_WORKFLOWS.join(', ')}`,
    );
  }

  // Warn on unknown registries (T820 RELEASE-01)
  if (config.registries !== undefined) {
    for (const registry of config.registries) {
      if (!KNOWN_REGISTRIES.includes(registry)) {
        warnings.push(
          `Unknown registry: '${registry}'. Known registries: ${KNOWN_REGISTRIES.join(', ')}`,
        );
      }
    }
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

// ---------------------------------------------------------------------------
// GitFlow helpers
// ---------------------------------------------------------------------------

/** Return the default GitFlow branch configuration. */
export function getDefaultGitFlowConfig(): GitFlowConfig {
  return {
    enabled: true,
    branches: {
      main: 'main',
      develop: 'develop',
      featurePrefix: 'feature/',
      hotfixPrefix: 'hotfix/',
      releasePrefix: 'release/',
    },
  };
}

/** Merge caller-supplied GitFlow config with defaults. */
export function getGitFlowConfig(config: ReleaseConfig): GitFlowConfig {
  const defaults = getDefaultGitFlowConfig();
  if (!config.gitflow) return defaults;
  return {
    enabled: config.gitflow.enabled ?? defaults.enabled,
    branches: {
      main: config.gitflow.branches?.main ?? defaults.branches.main,
      develop: config.gitflow.branches?.develop ?? defaults.branches.develop,
      featurePrefix: config.gitflow.branches?.featurePrefix ?? defaults.branches.featurePrefix,
      hotfixPrefix: config.gitflow.branches?.hotfixPrefix ?? defaults.branches.hotfixPrefix,
      releasePrefix: config.gitflow.branches?.releasePrefix ?? defaults.branches.releasePrefix,
    },
  };
}

/** Return the default channel configuration. */
export function getDefaultChannelConfig(): ChannelConfig {
  return {
    main: 'latest',
    develop: 'beta',
    feature: 'alpha',
  };
}

/** Merge caller-supplied channel config with defaults. */
export function getChannelConfig(config: ReleaseConfig): ChannelConfig {
  const defaults = getDefaultChannelConfig();
  if (!config.channels) return defaults;
  return {
    main: config.channels.main ?? defaults.main,
    develop: config.channels.develop ?? defaults.develop,
    feature: config.channels.feature ?? defaults.feature,
    custom: config.channels.custom,
  };
}

/**
 * Return the effective push mode.
 *
 * Priority: config.gitWorkflow (T820) > config.push.mode (legacy) > 'auto'
 */
export function getPushMode(config: ReleaseConfig): PushMode {
  if (config.gitWorkflow !== undefined) return config.gitWorkflow;
  return config.push?.mode ?? 'auto';
}
