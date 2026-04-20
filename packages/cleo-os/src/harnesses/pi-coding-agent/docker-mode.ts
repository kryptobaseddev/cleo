/**
 * Docker sandbox mode for the Pi coding agent harness.
 *
 * When `CLEO_PI_SANDBOXED=1` is set (or `sandboxed: true` is passed to
 * {@link PiCodingAgentAdapter.spawn}), the adapter routes the Pi process
 * through a Docker container instead of running Pi host-native.
 *
 * @remarks
 * The sandbox container image mirrors the pattern established by the
 * `cleo-sandbox` project (`/mnt/projects/cleo-sandbox/harnesses/pi/`):
 *
 *   - Base: `cleo-sandbox/pi:local` (or the image named in
 *     `CLEO_PI_SANDBOX_IMAGE`). This image has `@mariozechner/pi-coding-agent`
 *     installed globally and a non-root `cleo` user.
 *   - The cleocode source tree is bind-mounted read-only at `/sandbox-src`.
 *   - An artifacts volume is bind-mounted at `/sandbox`.
 *   - API keys are passed via `-e` at container creation time — NEVER baked
 *     into the image.
 *
 * When Docker is not available or the image is not present, the adapter
 * falls back to host-native mode with a warning logged to stderr.
 *
 * Environment variable overrides (all optional):
 *   - `CLEO_PI_SANDBOXED`         — set to `1` to enable docker mode globally
 *   - `CLEO_PI_SANDBOX_IMAGE`     — Docker image name (default: `cleo-sandbox/pi:local`)
 *   - `CLEO_PI_SANDBOX_NETWORK`   — Docker network name (default: none)
 *   - `CLEO_PI_SANDBOX_WORKDIR`   — Container working directory (default: `/sandbox`)
 *   - `CLEO_PI_SANDBOX_SOURCE`    — Host path bind-mounted at `/sandbox-src`
 *   - `CLEO_PI_SANDBOX_ARTIFACTS` — Host path bind-mounted at `/sandbox`
 *
 * @see `/mnt/projects/cleo-sandbox/harnesses/pi/Dockerfile` — reference image
 * @see `/mnt/projects/openclaw/Dockerfile.sandbox-common` — OpenClaw sandbox pattern
 * @packageDocumentation
 */

import { exec, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

/** Default Docker image for the Pi sandbox container. */
const DEFAULT_SANDBOX_IMAGE = 'cleo-sandbox/pi:local';

/** Default working directory inside the sandbox container. */
const DEFAULT_CONTAINER_WORKDIR = '/sandbox';

// ---------------------------------------------------------------------------
// Configuration helpers
// ---------------------------------------------------------------------------

/**
 * Return `true` when docker sandbox mode is globally enabled via env var.
 *
 * @public
 */
export function isSandboxedGlobally(): boolean {
  return process.env['CLEO_PI_SANDBOXED'] === '1';
}

/**
 * Return the Docker image name to use for the Pi sandbox container.
 *
 * Reads `CLEO_PI_SANDBOX_IMAGE` from the environment; falls back to
 * {@link DEFAULT_SANDBOX_IMAGE}.
 *
 * @public
 */
export function getSandboxImage(): string {
  return process.env['CLEO_PI_SANDBOX_IMAGE'] ?? DEFAULT_SANDBOX_IMAGE;
}

/**
 * Return the working directory path to use inside the container.
 *
 * Reads `CLEO_PI_SANDBOX_WORKDIR`; falls back to {@link DEFAULT_CONTAINER_WORKDIR}.
 *
 * @public
 */
export function getContainerWorkdir(): string {
  return process.env['CLEO_PI_SANDBOX_WORKDIR'] ?? DEFAULT_CONTAINER_WORKDIR;
}

// ---------------------------------------------------------------------------
// Docker availability probe
// ---------------------------------------------------------------------------

/**
 * Check whether the Docker CLI is available and the daemon is reachable.
 *
 * Runs `docker info` with a short timeout. Returns `false` when Docker is
 * not installed or the daemon is not running so the adapter can fall back
 * gracefully to host-native mode.
 *
 * @returns `true` when Docker is usable, `false` otherwise.
 *
 * @public
 */
export async function isDockerAvailable(): Promise<boolean> {
  try {
    await execAsync('docker info --format "{{.ServerVersion}}"', { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether the Pi sandbox Docker image exists locally.
 *
 * @param image - Image name to probe (defaults to {@link getSandboxImage}).
 * @returns `true` when the image is present, `false` otherwise.
 *
 * @public
 */
export async function isSandboxImagePresent(image?: string): Promise<boolean> {
  const tag = image ?? getSandboxImage();
  try {
    const { stdout } = await execAsync(`docker image inspect "${tag}" --format "{{.Id}}"`, {
      timeout: 5000,
    });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Docker argument builder
// ---------------------------------------------------------------------------

/**
 * Options for constructing a `docker run` invocation.
 *
 * @public
 */
export interface DockerRunOptions {
  /** Prompt text to pass to Pi inside the container. */
  prompt: string;
  /**
   * Host working directory.
   *
   * When set, mounted read-write at {@link getContainerWorkdir} inside the
   * container so Pi can write output artifacts.
   *
   * @defaultValue undefined
   */
  cwd?: string;
  /**
   * Extra environment variable overrides injected via `-e` flags.
   *
   * @defaultValue undefined
   */
  env?: Record<string, string>;
  /**
   * Path to the temporary prompt file already written by the caller.
   *
   * The adapter writes the prompt to a host-side temp file and bind-mounts it
   * into the container at `/tmp/pi-prompt.txt`. Pi reads this file as its
   * prompt argument (`pi /tmp/pi-prompt.txt`).
   *
   * @defaultValue undefined
   */
  promptFilePath?: string;
  /**
   * Docker image override for this invocation.
   *
   * @defaultValue `getSandboxImage()`
   */
  image?: string;
}

/**
 * Build the `docker run` argument array for a sandboxed Pi invocation.
 *
 * The resulting array is suitable as the second argument to Node's
 * `child_process.spawn('docker', args)` call.
 *
 * @remarks
 * Key design choices (mirroring OpenClaw's sandbox pattern):
 * - `--rm` — container is removed on exit; no persistent container state.
 * - Read-only source mount (`/sandbox-src:ro`) — prevents agent from
 *   modifying the cleocode source tree.
 * - Read-write artifacts mount (`/sandbox`) — agent output lands here.
 * - API keys forwarded from the host environment when present.
 * - `PI_TELEMETRY=0` always injected to suppress telemetry.
 * - No ports exposed — sandbox containers are ephemeral CLI workers.
 *
 * @param opts - Options controlling the container configuration.
 * @returns Array of arguments for `docker run`.
 *
 * @public
 */
export function buildDockerRunArgs(opts: DockerRunOptions): string[] {
  const image = opts.image ?? getSandboxImage();
  const containerWorkdir = getContainerWorkdir();
  const network = process.env['CLEO_PI_SANDBOX_NETWORK'];
  const sourceMount = process.env['CLEO_PI_SANDBOX_SOURCE'];
  const artifactsMount = opts.cwd ?? process.env['CLEO_PI_SANDBOX_ARTIFACTS'];

  const args: string[] = ['run', '--rm', '--init'];

  // Network isolation (optional).
  if (network !== undefined && network.length > 0) {
    args.push('--network', network);
  }

  // Working directory inside the container.
  args.push('-w', containerWorkdir);

  // Read-only source mount (cleocode source tree).
  if (sourceMount !== undefined && sourceMount.length > 0) {
    args.push('-v', `${sourceMount}:/sandbox-src:ro`);
  }

  // Read-write artifacts mount.
  if (artifactsMount !== undefined && artifactsMount.length > 0) {
    args.push('-v', `${artifactsMount}:${containerWorkdir}`);
  }

  // Bind-mount the prompt file into the container.
  if (opts.promptFilePath !== undefined) {
    args.push('-v', `${opts.promptFilePath}:/tmp/pi-prompt.txt:ro`);
  }

  // Core environment variables.
  args.push('-e', 'PI_TELEMETRY=0');

  // Forward API keys from the host environment.
  for (const key of [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'GOOGLE_API_KEY',
    'OPENROUTER_API_KEY',
  ]) {
    const val = process.env[key];
    if (val !== undefined && val.length > 0) {
      args.push('-e', `${key}=${val}`);
    }
  }

  // Caller-supplied environment overrides.
  if (opts.env !== undefined) {
    for (const [k, v] of Object.entries(opts.env)) {
      args.push('-e', `${k}=${v}`);
    }
  }

  // Image and command: `pi /tmp/pi-prompt.txt`
  args.push(image, 'pi', '/tmp/pi-prompt.txt');

  return args;
}

// ---------------------------------------------------------------------------
// DockerModeAdapter
// ---------------------------------------------------------------------------

/**
 * Supplemental adapter that wraps Pi runs inside a Docker sandbox container.
 *
 * Used by {@link PiCodingAgentAdapter} when sandbox mode is enabled.
 * Callers should first call {@link checkDockerReadiness} to verify that
 * Docker is available and the sandbox image is present.
 *
 * @public
 */
export class DockerModeAdapter {
  /**
   * Verify that Docker is available and the sandbox image is present.
   *
   * @param image - Image to check (defaults to {@link getSandboxImage}).
   * @returns Object describing readiness and any issue encountered.
   *
   * @public
   */
  async checkReadiness(image?: string): Promise<{ ready: boolean; reason?: string }> {
    if (!(await isDockerAvailable())) {
      return { ready: false, reason: 'Docker daemon not available' };
    }
    const tag = image ?? getSandboxImage();
    if (!(await isSandboxImagePresent(tag))) {
      return {
        ready: false,
        reason: `Sandbox image "${tag}" not found. Build it with: cd /mnt/projects/cleo-sandbox && docker build -f harnesses/pi/Dockerfile -t ${tag} .`,
      };
    }
    return { ready: true };
  }

  /**
   * Spawn Pi inside a Docker sandbox container.
   *
   * Builds the `docker run` argument list via {@link buildDockerRunArgs} and
   * delegates to Node's `child_process.spawn`. The returned `ChildProcess` is
   * wired identically to the host-native path in {@link PiWrapper.start} so
   * the adapter can use the same output buffering and cleanup logic.
   *
   * @param opts - Docker run options.
   * @returns A spawned `ChildProcess` handle.
   *
   * @public
   */
  spawnInDocker(opts: DockerRunOptions): ReturnType<typeof spawn> {
    const args = buildDockerRunArgs(opts);
    return spawn('docker', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
}
