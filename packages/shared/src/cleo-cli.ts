/**
 * CLEO CLI wrapper for adapter use.
 * Provides a typed interface around the cleo binary for common operations
 * that adapters need: observing memories, querying session status, and
 * searching brain entries.
 *
 * @task T5240
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Options for constructing a CleoCli wrapper. */
export interface CleoCliOptions {
  /** Path to the cleo binary. Defaults to ~/.cleo/bin/cleo. */
  binPath?: string;
  /** Working directory for cleo commands. Defaults to process.cwd(). */
  projectDir?: string;
  /** Timeout in milliseconds for each command. Defaults to 10000. */
  timeout?: number;
}

/** Result of a cleo CLI invocation. */
export interface CleoCliResult {
  success: boolean;
  output?: string;
  error?: string;
}

/** Parsed session status from `cleo session status --json`. */
export interface SessionStatus {
  scope?: string;
  currentTask?: string;
  [key: string]: unknown;
}

/** A brain search hit from `cleo memory find`. */
export interface BrainSearchHit {
  id: string;
  type?: string;
  title?: string;
  date?: string;
  [key: string]: unknown;
}

/**
 * Typed wrapper around the cleo CLI binary.
 * All methods are synchronous and never throw -- they return success/failure results.
 */
export class CleoCli {
  private readonly binPath: string;
  private readonly projectDir: string;
  private readonly timeout: number;

  constructor(options?: CleoCliOptions) {
    this.binPath = options?.binPath ?? join(homedir(), '.cleo', 'bin', 'cleo');
    this.projectDir = options?.projectDir ?? process.cwd();
    this.timeout = options?.timeout ?? 10000;
  }

  /** Check whether the cleo binary exists at the configured path. */
  isAvailable(): boolean {
    return existsSync(this.binPath);
  }

  /** Run a raw cleo command and return the output. */
  run(args: string[]): CleoCliResult {
    try {
      const output = execFileSync(this.binPath, args, {
        timeout: this.timeout,
        encoding: 'utf8',
        cwd: this.projectDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { success: true, output: output.trim() };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Run a cleo command and parse JSON output. */
  runJson<T = unknown>(args: string[]): { success: boolean; data?: T; error?: string } {
    const result = this.run([...args, '--json']);
    if (!result.success || !result.output) {
      return { success: false, error: result.error ?? 'No output' };
    }
    try {
      const data = JSON.parse(result.output) as T;
      return { success: true, data };
    } catch {
      return { success: false, error: 'Failed to parse JSON output' };
    }
  }

  /** Store an observation in brain.db via `cleo memory observe`. */
  observe(text: string, title?: string): boolean {
    const args = ['memory', 'observe', text];
    if (title) {
      args.push('--title', title);
    }
    try {
      execFileSync(this.binPath, args, {
        timeout: this.timeout,
        stdio: 'ignore',
        cwd: this.projectDir,
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Get current session status. */
  sessionStatus(): SessionStatus | null {
    const result = this.runJson<{ result?: { session?: SessionStatus }; session?: SessionStatus }>(
      ['session', 'status'],
    );
    if (!result.success || !result.data) return null;
    return result.data.result?.session ?? result.data.session ?? null;
  }

  /** Search brain entries via `cleo memory find`. */
  brainSearch(query: string, limit = 20): BrainSearchHit[] {
    const result = this.runJson<{ result?: { results?: BrainSearchHit[] } }>(
      ['memory', 'find', query, '--limit', String(limit)],
    );
    if (!result.success || !result.data) return [];
    return result.data.result?.results ?? [];
  }
}
