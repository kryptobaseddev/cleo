/**
 * Agent install pipeline — business logic extracted from `cleo agent install`.
 *
 * Handles three input shapes (.cant file, .cantz archive, agent directory) and
 * delegates to the `installAgentFromCant` core function. The CLI handler calls
 * {@link resolveAgentCantPath} to normalize inputs, then passes the resolved
 * `.cant` path to the core installation function directly.
 *
 * @module agents/install-pipeline
 * @epic T9833
 * @task T10062
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Three input shapes accepted by the install command. */
export type AgentInstallInputKind = 'cant-file' | 'cantz-archive' | 'agent-directory';

/** Result of {@link resolveAgentCantPath}. */
export interface ResolvedCantPath {
  /** Absolute path to the canonical `.cant` file ready for the pipeline. */
  cantPath: string;
  /** Input shape that was resolved. */
  kind: AgentInstallInputKind;
  /**
   * Temp directory created during extraction (only set for `cantz-archive`
   * and `agent-directory` shapes). The caller is responsible for cleanup.
   */
  tempDir: string | null;
}

/** Options for {@link resolveAgentCantPath}. */
export interface ResolveAgentCantPathOptions {
  /** Absolute path to the input file or directory. */
  resolvedPath: string;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Normalize a user-supplied path into a canonical `.cant` file path.
 *
 * Three shapes are handled:
 * 1. `<id>.cant`          — used as-is.
 * 2. `<pkg>.cantz`        — extracted to a temp dir; `persona.cant` renamed to
 *                           `<agentId>.cant`.
 * 3. `<dir>/persona.cant` — copied from directory into a temp dir.
 *
 * @param opts - Resolution options
 * @returns The resolved `.cant` path and cleanup metadata
 * @throws {Error} When the path is not a valid input shape
 */
export function resolveAgentCantPath(opts: ResolveAgentCantPathOptions): ResolvedCantPath {
  const { resolvedPath } = opts;

  const stat = statSync(resolvedPath);
  const ext = extname(resolvedPath);

  if (stat.isFile() && ext === '.cant') {
    return { cantPath: resolvedPath, kind: 'cant-file', tempDir: null };
  }

  if (stat.isFile() && ext === '.cantz') {
    const tempDir = join(tmpdir(), `cleo-agent-install-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    execFileSync('unzip', ['-o', '-q', resolvedPath, '-d', tempDir], {
      encoding: 'utf-8',
      timeout: 30_000,
    });

    const topLevel = readdirSync(tempDir).filter((entry) =>
      statSync(join(tempDir, entry)).isDirectory(),
    );
    if (topLevel.length !== 1) {
      throw new Error(
        `Archive must contain exactly one top-level directory, found ${topLevel.length}`,
      );
    }

    const agentName = topLevel[0] as string;
    const personaPath = join(tempDir, agentName, 'persona.cant');
    if (!existsSync(personaPath)) {
      throw new Error(`Archive must contain persona.cant: ${personaPath}`);
    }

    const cantPath = join(tempDir, `${agentName}.cant`);
    copyFileSync(personaPath, cantPath);
    return { cantPath, kind: 'cantz-archive', tempDir };
  }

  if (stat.isDirectory()) {
    const agentName = basename(resolvedPath);
    const personaPath = join(resolvedPath, 'persona.cant');
    if (!existsSync(personaPath)) {
      throw new Error(`Agent directory must contain persona.cant: ${personaPath}`);
    }

    const tempDir = join(tmpdir(), `cleo-agent-install-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    const cantPath = join(tempDir, `${agentName}.cant`);
    copyFileSync(personaPath, cantPath);
    return { cantPath, kind: 'agent-directory', tempDir };
  }

  throw new Error(`Path must be a .cant, .cantz, or agent directory: ${resolvedPath}`);
}

// ---------------------------------------------------------------------------
// Cleanup helper
// ---------------------------------------------------------------------------

/**
 * Remove a temp directory created during install resolution.
 *
 * Best-effort — never throws. Should be called in a `finally` block after the
 * installation completes or fails.
 *
 * @param tempDir - Directory to remove (null is a no-op)
 */
export function cleanupInstallTempDir(tempDir: string | null): void {
  if (!tempDir) return;
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // best-effort — do not mask the primary error
  }
}
