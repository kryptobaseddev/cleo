/**
 * Release artifact management - pluggable artifact handlers.
 * Ported from lib/release/release-artifacts.sh
 *
 * Provides a registry of artifact type handlers for build, validate,
 * and publish operations across multiple package ecosystems.
 *
 * @task T4552
 * @epic T4545
 */

import { existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Supported artifact types. */
export type ArtifactType =
  | 'npm-package'
  | 'python-wheel'
  | 'python-sdist'
  | 'go-module'
  | 'cargo-crate'
  | 'ruby-gem'
  | 'docker-image'
  | 'github-release'
  | 'generic-tarball';

/** Artifact configuration from release config. */
export interface ArtifactConfig {
  type: ArtifactType;
  buildCommand?: string;
  publishCommand?: string;
  package?: string;
  registry?: string;
  options?: {
    provenance?: boolean;
    access?: string;
    tag?: string;
    attestations?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** Result of an artifact operation. */
export interface ArtifactResult {
  success: boolean;
  output: string;
  dryRun: boolean;
}

/** Artifact handler interface. */
export interface ArtifactHandler {
  build(config: ArtifactConfig, dryRun?: boolean): Promise<ArtifactResult>;
  validate(config: ArtifactConfig): Promise<ArtifactResult>;
  publish(config: ArtifactConfig, dryRun?: boolean): Promise<ArtifactResult>;
}

/**
 * Check if a command exists on the system.
 * @task T4552
 */
async function commandExists(cmd: string): Promise<boolean> {
  try {
    await execFileAsync('which', [cmd]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Execute a shell command and return the result.
 * @task T4552
 */
async function execCommand(
  command: string,
  dryRun: boolean,
): Promise<ArtifactResult> {
  if (dryRun) {
    return { success: true, output: `[DRY RUN] Would execute: ${command}`, dryRun: true };
  }

  try {
    const { stdout, stderr } = await execFileAsync('sh', ['-c', command], {
      timeout: 300_000,
    });
    return { success: true, output: (stdout + stderr).trim(), dryRun: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, output: message, dryRun: false };
  }
}

// ============================================================================
// HANDLER: generic-tarball
// ============================================================================

/** @task T4552 */
const genericTarballHandler: ArtifactHandler = {
  async build(config, dryRun = false) {
    const buildCommand =
      config.buildCommand ??
      `tar czf release-${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz --exclude=.git --exclude=.cleo --exclude=node_modules .`;
    return execCommand(buildCommand, dryRun);
  },

  async validate(config) {
    if (config.buildCommand) {
      // Just check syntax validity
      try {
        await execFileAsync('sh', ['-n', '-c', config.buildCommand]);
        return { success: true, output: 'Build command syntax valid', dryRun: false };
      } catch {
        return { success: false, output: 'Invalid build command syntax', dryRun: false };
      }
    }
    return { success: true, output: 'No build command to validate', dryRun: false };
  },

  async publish(config, dryRun = false) {
    if (!config.publishCommand) {
      return { success: true, output: 'No publish command specified. Skipping publish.', dryRun: false };
    }
    return execCommand(config.publishCommand, dryRun);
  },
};

// ============================================================================
// HANDLER: npm-package
// ============================================================================

/** @task T4552 */
const npmPackageHandler: ArtifactHandler = {
  async build(config, dryRun = false) {
    if (!config.buildCommand) {
      return { success: true, output: 'No build command specified. Skipping build step.', dryRun: false };
    }
    return execCommand(config.buildCommand, dryRun);
  },

  async validate(config) {
    const packageFile = config.package ?? 'package.json';
    if (!existsSync(packageFile)) {
      return { success: false, output: `package.json not found: ${packageFile}`, dryRun: false };
    }

    try {
      const content = JSON.parse(readFileSync(packageFile, 'utf-8')) as Record<string, unknown>;
      const requiredFields = ['name', 'version', 'description', 'license'];
      const missing = requiredFields.filter((f) => !content[f]);

      if (missing.length > 0) {
        return {
          success: false,
          output: `package.json missing required fields: ${missing.join(', ')}`,
          dryRun: false,
        };
      }

      // Validate package name format
      const packageName = content.name as string;
      if (!/^(@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/.test(packageName)) {
        return {
          success: false,
          output: `Invalid npm package name: ${packageName}`,
          dryRun: false,
        };
      }

      return { success: true, output: 'npm package validation passed', dryRun: false };
    } catch {
      return { success: false, output: `Failed to parse ${packageFile}`, dryRun: false };
    }
  },

  async publish(config, dryRun = false) {
    let publishCommand = config.publishCommand ?? 'npm publish';

    if (config.options?.provenance) {
      publishCommand += ' --provenance';
    }
    if (config.options?.access) {
      publishCommand += ` --access ${config.options.access}`;
    }
    if (config.options?.tag) {
      publishCommand += ` --tag ${config.options.tag}`;
    }

    return execCommand(publishCommand, dryRun);
  },
};

// ============================================================================
// HANDLER: python-wheel
// ============================================================================

/** @task T4552 */
const pythonWheelHandler: ArtifactHandler = {
  async build(config, dryRun = false) {
    const buildCommand = config.buildCommand ?? 'python -m build';
    return execCommand(buildCommand, dryRun);
  },

  async validate(config) {
    const packageFile = config.package ?? 'pyproject.toml';
    if (!existsSync(packageFile) && !existsSync('setup.py')) {
      return { success: false, output: 'Neither pyproject.toml nor setup.py found', dryRun: false };
    }

    if (!(await commandExists('python'))) {
      return { success: false, output: 'python command not found', dryRun: false };
    }

    return { success: true, output: 'Python wheel validation passed', dryRun: false };
  },

  async publish(config, dryRun = false) {
    let publishCommand = config.publishCommand ?? 'twine upload dist/*';
    if (config.options?.attestations) {
      publishCommand += ' --attestations';
    }
    return execCommand(publishCommand, dryRun);
  },
};

// ============================================================================
// HANDLER: python-sdist
// ============================================================================

/** @task T4552 */
const pythonSdistHandler: ArtifactHandler = {
  async build(config, dryRun = false) {
    const buildCommand = config.buildCommand ?? 'python -m build --sdist';
    return execCommand(buildCommand, dryRun);
  },

  validate: pythonWheelHandler.validate,
  publish: pythonWheelHandler.publish,
};

// ============================================================================
// HANDLER: go-module
// ============================================================================

/** @task T4552 */
const goModuleHandler: ArtifactHandler = {
  async build(config, dryRun = false) {
    const buildCommand = config.buildCommand ?? 'go mod tidy';
    return execCommand(buildCommand, dryRun);
  },

  async validate(config) {
    const packageFile = config.package ?? 'go.mod';
    if (!existsSync(packageFile)) {
      return { success: false, output: `go.mod not found: ${packageFile}`, dryRun: false };
    }

    if (!(await commandExists('go'))) {
      return { success: false, output: 'go command not found', dryRun: false };
    }

    const content = readFileSync(packageFile, 'utf-8');
    const moduleMatch = content.match(/^module\s+(\S+)/m);
    if (!moduleMatch) {
      return { success: false, output: 'Module path not found in go.mod', dryRun: false };
    }

    return { success: true, output: 'Go module validation passed', dryRun: false };
  },

  async publish(config, dryRun = false) {
    if (!config.publishCommand) {
      return {
        success: true,
        output: 'Go modules are published via Git tags. Create a tag with: git tag v<version> && git push --tags',
        dryRun: false,
      };
    }
    return execCommand(config.publishCommand, dryRun);
  },
};

// ============================================================================
// HANDLER: cargo-crate
// ============================================================================

/** @task T4552 */
const cargoCrateHandler: ArtifactHandler = {
  async build(config, dryRun = false) {
    const buildCommand = config.buildCommand ?? 'cargo build --release';
    return execCommand(buildCommand, dryRun);
  },

  async validate(config) {
    const packageFile = config.package ?? 'Cargo.toml';
    if (!existsSync(packageFile)) {
      return { success: false, output: `Cargo.toml not found: ${packageFile}`, dryRun: false };
    }

    if (!(await commandExists('cargo'))) {
      return { success: false, output: 'cargo command not found', dryRun: false };
    }

    const content = readFileSync(packageFile, 'utf-8');
    if (!content.includes('[package]')) {
      return { success: false, output: '[package] section not found in Cargo.toml', dryRun: false };
    }

    const requiredFields = ['name', 'version', 'authors', 'edition'];
    const missing = requiredFields.filter((f) => !new RegExp(`^${f}\\s*=`, 'm').test(content));
    if (missing.length > 0) {
      return {
        success: false,
        output: `Cargo.toml missing required fields: ${missing.join(', ')}`,
        dryRun: false,
      };
    }

    return { success: true, output: 'Cargo crate validation passed', dryRun: false };
  },

  async publish(config, dryRun = false) {
    let publishCommand = config.publishCommand ?? 'cargo publish';
    if (dryRun) {
      publishCommand += ' --dry-run';
    }
    return execCommand(publishCommand, false); // cargo has built-in dry-run
  },
};

// ============================================================================
// HANDLER: ruby-gem
// ============================================================================

/** @task T4552 */
const rubyGemHandler: ArtifactHandler = {
  async build(config, dryRun = false) {
    let packageFile = config.package ?? '*.gemspec';

    if (packageFile === '*.gemspec') {
      // Find gemspec via glob would be ideal, but we check common patterns
      const candidates = ['*.gemspec'];
      // Simple check - in a real scenario we'd glob
      packageFile = candidates[0]!;
    }

    const buildCommand = config.buildCommand ?? `gem build ${packageFile}`;
    return execCommand(buildCommand, dryRun);
  },

  async validate(_config) {
    if (!(await commandExists('gem'))) {
      return { success: false, output: 'gem command not found', dryRun: false };
    }
    return { success: true, output: 'Ruby gem validation passed', dryRun: false };
  },

  async publish(config, dryRun = false) {
    const publishCommand = config.publishCommand ?? 'gem push';
    return execCommand(publishCommand, dryRun);
  },
};

// ============================================================================
// HANDLER: docker-image
// ============================================================================

/** @task T4552 */
const dockerImageHandler: ArtifactHandler = {
  async build(config, dryRun = false) {
    const buildCommand =
      config.buildCommand ??
      `docker build -t ${config.registry ?? 'localhost'}:latest .`;
    return execCommand(buildCommand, dryRun);
  },

  async validate(_config) {
    if (!existsSync('Dockerfile') && !existsSync('dockerfile')) {
      return { success: false, output: 'Dockerfile not found', dryRun: false };
    }

    if (!(await commandExists('docker'))) {
      return { success: false, output: 'docker command not found', dryRun: false };
    }

    return { success: true, output: 'Docker image validation passed', dryRun: false };
  },

  async publish(config, dryRun = false) {
    if (!config.publishCommand && !config.registry) {
      return { success: false, output: 'Docker registry not specified', dryRun: false };
    }
    const publishCommand =
      config.publishCommand ?? `docker push ${config.registry}:latest`;
    return execCommand(publishCommand, dryRun);
  },
};

// ============================================================================
// HANDLER: github-release
// ============================================================================

/** @task T4552 */
const githubReleaseHandler: ArtifactHandler = {
  async build(config, dryRun = false) {
    if (!config.buildCommand) {
      return { success: true, output: 'No build command for GitHub release. Skipping.', dryRun: false };
    }
    return execCommand(config.buildCommand, dryRun);
  },

  async validate(_config) {
    if (!(await commandExists('gh'))) {
      return { success: false, output: 'gh (GitHub CLI) command not found', dryRun: false };
    }

    try {
      await execFileAsync('git', ['rev-parse', '--git-dir']);
    } catch {
      return { success: false, output: 'Not in a git repository', dryRun: false };
    }

    return { success: true, output: 'GitHub release validation passed', dryRun: false };
  },

  async publish(config, dryRun = false) {
    if (!config.publishCommand) {
      return { success: false, output: 'GitHub release publish command not specified', dryRun: false };
    }
    return execCommand(config.publishCommand, dryRun);
  },
};

// ============================================================================
// HANDLER REGISTRY
// ============================================================================

/** Built-in artifact handlers. */
const HANDLERS: Record<ArtifactType, ArtifactHandler> = {
  'generic-tarball': genericTarballHandler,
  'npm-package': npmPackageHandler,
  'python-wheel': pythonWheelHandler,
  'python-sdist': pythonSdistHandler,
  'go-module': goModuleHandler,
  'cargo-crate': cargoCrateHandler,
  'ruby-gem': rubyGemHandler,
  'docker-image': dockerImageHandler,
  'github-release': githubReleaseHandler,
};

/**
 * Get handler for an artifact type.
 * @task T4552
 */
export function getArtifactHandler(artifactType: ArtifactType): ArtifactHandler | null {
  return HANDLERS[artifactType] ?? null;
}

/**
 * Check if a handler is registered for an artifact type.
 * @task T4552
 */
export function hasArtifactHandler(artifactType: string): artifactType is ArtifactType {
  return artifactType in HANDLERS;
}

/**
 * Build an artifact using the appropriate handler.
 * @task T4552
 */
export async function buildArtifact(
  config: ArtifactConfig,
  dryRun = false,
): Promise<ArtifactResult> {
  const handler = getArtifactHandler(config.type);
  if (!handler) {
    return {
      success: false,
      output: `No handler registered for artifact type: ${config.type}`,
      dryRun: false,
    };
  }
  return handler.build(config, dryRun);
}

/**
 * Validate an artifact using the appropriate handler.
 * @task T4552
 */
export async function validateArtifact(
  config: ArtifactConfig,
): Promise<ArtifactResult> {
  const handler = getArtifactHandler(config.type);
  if (!handler) {
    return {
      success: false,
      output: `No handler registered for artifact type: ${config.type}`,
      dryRun: false,
    };
  }
  return handler.validate(config);
}

/**
 * Publish an artifact using the appropriate handler.
 * @task T4552
 */
export async function publishArtifact(
  config: ArtifactConfig,
  dryRun = false,
): Promise<ArtifactResult> {
  const handler = getArtifactHandler(config.type);
  if (!handler) {
    return {
      success: false,
      output: `No handler registered for artifact type: ${config.type}`,
      dryRun: false,
    };
  }
  return handler.publish(config, dryRun);
}

/**
 * Get all supported artifact types.
 * @task T4552
 */
export function getSupportedArtifactTypes(): ArtifactType[] {
  return Object.keys(HANDLERS) as ArtifactType[];
}
