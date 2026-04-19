/**
 * Release configuration loader and validator.
 *
 * Loads release configuration with the following precedence (highest wins):
 *   1. .cleo/release-config.json  (project-specific, T820 RELEASE-01)
 *   2. .cleo/config.json release section
 *   3. Built-in defaults
 *
 * This enables downstream CLEO-using projects to configure their own release
 * pipeline without touching the parent config.json.
 *
 * @task T4454
 * @task T820
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

/**
 * Load `.cleo/release-config.json` if it exists.
 *
 * This file is the project-agnostic override for release configuration.
 * It takes precedence over config.json release section values.
 * Returns an empty object if the file does not exist or cannot be parsed.
 *
 * @task T820 RELEASE-01
 */
function loadReleaseConfigJson(cwd?: string): Partial<ProjectReleaseConfig> {
  try {
    const configPath = join(getCleoDir(cwd), 'release-config.json');
    if (!existsSync(configPath)) return {};
    const raw = readFileSync(configPath, 'utf-8');
    return JSON.parse(raw) as Partial<ProjectReleaseConfig>;
  } catch {
    return {};
  }
}

/**
 * Flat project-level release config shape as read from `.cleo/release-config.json`.
 *
 * Schema is deliberately flat to keep the file readable and diff-friendly.
 * All fields are optional — only override what differs from the defaults.
 *
 * @task T820 RELEASE-01
 */
export interface ProjectReleaseConfig {
  /** Versioning scheme: 'calver' | 'semver' | 'custom'. Default: 'calver'. */
  versionScheme?: string;
  /** Git tag prefix. Default: 'v'. */
  tagPrefix?: string;
  /**
   * Git workflow mode.
   * - 'direct': push commit+tag directly to remote (default)
   * - 'pr':     open a draft PR, await review, merge, then tag
   */
  gitWorkflow?: 'direct' | 'pr';
  /** Registries to publish to: 'npm' | 'crates' | 'docker' | 'none'. Default: []. */
  registries?: Array<'npm' | 'crates' | 'docker' | 'none'>;
  /** Pre-release channel suffix (e.g. 'alpha', 'beta', 'rc'). */
  prereleaseChannel?: string;
  /** Changelog file path relative to project root. Default: 'CHANGELOG.md'. */
  changelogFile?: string;
  /** Changelog format: 'keepachangelog' | 'conventional' | 'custom'. Default: 'keepachangelog'. */
  changelogFormat?: string;
  /** Artifact type for composition chain. Default: 'generic-tarball'. */
  artifactType?: string;
  /**
   * Paths to check for build artifacts, relative to project root.
   * If empty, defaults to ['dist', 'build', 'out'].
   * Set to [] to skip the build artifact gate entirely.
   */
  buildArtifactPaths?: string[];
  /** Whether to skip the build artifact gate. Default: false. */
  skipBuildArtifactGate?: boolean;
  /** Extra release gates to run as shell commands. */
  gates?: Array<{
    name: string;
    command: string;
    required?: boolean;
  }>;
  /** Version bump file targets. */
  versionBump?: {
    files: Array<{
      file: string;
      strategy: 'plain' | 'json' | 'toml' | 'sed';
      field?: string;
    }>;
  };
  /** Security settings. */
  security?: {
    enableProvenance?: boolean;
    slsaLevel?: number;
    requireSignedCommits?: boolean;
  };
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
  /**
   * Git workflow mode — project-agnostic override from release-config.json.
   * 'direct' | 'pr'. Mirrors ProjectReleaseConfig.gitWorkflow.
   * @task T820 RELEASE-01
   */
  gitWorkflow?: 'direct' | 'pr';
  /**
   * Registries to publish to after tagging.
   * @task T820 RELEASE-01
   */
  registries?: Array<'npm' | 'crates' | 'docker' | 'none'>;
  /**
   * Pre-release channel suffix.
   * @task T820 RELEASE-01
   */
  prereleaseChannel?: string;
  /**
   * Paths to check for build artifacts, relative to project root.
   * Empty array means use defaults (['dist', 'build', 'out']).
   * @task T820 RELEASE-01
   */
  buildArtifactPaths?: string[];
  /**
   * Skip the build artifact gate entirely.
   * Useful for source-only or documentation releases.
   * @task T820 RELEASE-01
   */
  skipBuildArtifactGate?: boolean;
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
  gitflow?: GitFlowConfig;
  channels?: ChannelConfig;
  push?: {
    mode?: PushMode;
  };
}

/** Release gate definition. */
export interface ReleaseGate {
  name: string;
  type: 'tests' | 'lint' | 'audit' | 'custom';
  command: string;
  required: boolean;
}

/**
 * Load release configuration with defaults.
 *
 * Merges configuration from three sources (highest precedence first):
 *   1. `.cleo/release-config.json` — project-specific override (T820 RELEASE-01)
 *   2. `.cleo/config.json` release section — legacy config location
 *   3. Built-in defaults
 *
 * @task T820 RELEASE-01
 */
export function loadReleaseConfig(cwd?: string): ReleaseConfig {
  // Load the project-specific override (highest precedence)
  const projectConfig = loadReleaseConfigJson(cwd);

  // Resolve each field: projectConfig wins over config.json wins over DEFAULTS
  const versioningScheme =
    projectConfig.versionScheme ??
    (readConfigValueSync('release.versioning.scheme', DEFAULTS.versioningScheme, cwd) as string);

  const tagPrefix =
    projectConfig.tagPrefix ??
    (readConfigValueSync('release.versioning.tagPrefix', DEFAULTS.tagPrefix, cwd) as string);

  const changelogFormat =
    projectConfig.changelogFormat ??
    (readConfigValueSync('release.changelog.format', DEFAULTS.changelogFormat, cwd) as string);

  const changelogFile =
    projectConfig.changelogFile ??
    (readConfigValueSync('release.changelog.file', DEFAULTS.changelogFile, cwd) as string);

  const artifactType =
    projectConfig.artifactType ??
    (readConfigValueSync('release.artifact.type', DEFAULTS.artifactType, cwd) as string);

  const gates = (projectConfig.gates ??
    readConfigValueSync('release.gates', [], cwd)) as ReleaseGate[];

  const versionBumpFiles = (projectConfig.versionBump?.files ??
    readConfigValueSync(
      'release.versionBump.files',
      [],
      cwd,
    )) as ReleaseConfig['versionBump']['files'];

  const security = {
    enableProvenance:
      projectConfig.security?.enableProvenance ??
      (readConfigValueSync('release.security.enableProvenance', false, cwd) as boolean),
    slsaLevel:
      projectConfig.security?.slsaLevel ??
      (readConfigValueSync('release.security.slsaLevel', 3, cwd) as number),
    requireSignedCommits:
      projectConfig.security?.requireSignedCommits ??
      (readConfigValueSync('release.security.requireSignedCommits', false, cwd) as boolean),
  };

  return {
    versioningScheme,
    tagPrefix,
    changelogFormat,
    changelogFile,
    artifactType,
    // Project-agnostic fields from release-config.json (T820)
    gitWorkflow: projectConfig.gitWorkflow,
    registries: projectConfig.registries,
    prereleaseChannel: projectConfig.prereleaseChannel,
    buildArtifactPaths: projectConfig.buildArtifactPaths,
    skipBuildArtifactGate: projectConfig.skipBuildArtifactGate,
    gates,
    versionBump: { files: versionBumpFiles },
    security,
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

  // Validate gitWorkflow field (T820 RELEASE-01)
  if (config.gitWorkflow != null) {
    const validWorkflows = ['direct', 'pr'];
    if (!validWorkflows.includes(config.gitWorkflow)) {
      errors.push(`Invalid gitWorkflow: '${config.gitWorkflow}' (expected: direct | pr)`);
    }
  }

  // Validate registries (T820 RELEASE-01)
  if (config.registries != null) {
    const validRegistries = ['npm', 'crates', 'docker', 'none'];
    for (const registry of config.registries) {
      if (!validRegistries.includes(registry)) {
        warnings.push(`Unknown registry: '${registry}'`);
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
// GitFlow, channel, and push-mode types + helpers (T5586)
// ---------------------------------------------------------------------------

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
 * Return the configured push mode, defaulting to 'auto'.
 *
 * Precedence:
 *   1. release-config.json gitWorkflow ('direct' → 'direct', 'pr' → 'pr')
 *   2. config.json release.push.mode
 *   3. 'auto' (detect from branch protection)
 *
 * @task T820 RELEASE-01
 */
export function getPushMode(config: ReleaseConfig): PushMode {
  // gitWorkflow from release-config.json takes highest precedence
  if (config.gitWorkflow === 'pr') return 'pr';
  if (config.gitWorkflow === 'direct') return 'direct';
  return config.push?.mode ?? 'auto';
}
