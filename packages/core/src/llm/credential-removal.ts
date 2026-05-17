/**
 * RemovalStep registry + per-source removal handlers for the unified
 * credential pool (E-CONFIG-AUTH-UNIFY E2a / T9415).
 *
 * Mirrors Hermes Agent's `agent/credential_sources.py` `RemovalStep`
 * pattern: every credential source (env var, `~/.claude/.credentials.json`,
 * `cleo llm login` PKCE token, third-party CLIs) registers a removal step
 * that `cleo auth remove <provider> <label>` invokes to (a) clean up
 * filesystem state owned by CLEO, (b) surface manual hints for state CLEO
 * does NOT own, and (c) record a suppression entry so the next pool load
 * does not re-seed the just-removed credential.
 *
 * ## Scope of this task
 *
 * T9415 is **removal-infrastructure only**. The `cleo auth remove` CLI
 * lands in T9416; this module exposes the registry + per-source handlers
 * + suppression-state persistence, all consumable by the future CLI.
 *
 * ## Suppression state
 *
 * Suppression is persisted to `${getCleoHome()}/auth-suppression.json`:
 *
 * ```json
 * {
 *   "version": 1,
 *   "entries": [
 *     { "provider": "anthropic", "sourceId": "claude-code", "suppressedAt": 1731000000000 }
 *   ]
 * }
 * ```
 *
 * Writes go through {@link writeJsonFileAtomic} (temp-file + rename) so
 * mid-update crashes never corrupt the file. The mutation flow is
 * read-full-state → mutate-in-memory → atomic-write so concurrent CLI
 * invocations cannot interleave partial writes.
 *
 * @module llm/credential-removal
 * @task T9415
 * @epic E-CONFIG-AUTH-UNIFY (E2a)
 */

import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getCleoHome } from '@cleocode/paths';
import { readJsonFile, writeJsonFileAtomic } from '../store/file-utils.js';
import type { SeederSourceId } from './credential-seeders/index.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Outcome of a {@link RemovalStep.remove} invocation.
 *
 * @task T9415
 */
export interface RemovalResult {
  /**
   * Absolute paths of filesystem entries that were actually mutated /
   * deleted by this removal step. Empty when CLEO does not own the
   * source's on-disk state (env vars, third-party CLI tokens, etc.).
   */
  cleaned: string[];
  /**
   * Human-readable hints surfaced to the operator after removal — what
   * they may still need to do manually (e.g. "unset $ANTHROPIC_API_KEY",
   * "do NOT delete ~/.claude/.credentials.json").
   */
  hints: string[];
  /**
   * Whether the unified pool should add `(provider, sourceId)` to the
   * suppression list so the next seed pass skips this source.
   *
   * `false` for the `'manual'` source — entries the operator added via
   * `cleo llm add` are removed directly from `llm-credentials.json` and
   * there is nothing to suppress on the next seed pass.
   */
  suppress: boolean;
}

/**
 * A single removal handler in the {@link RemovalRegistry}.
 *
 * @task T9415
 */
export interface RemovalStep {
  /** Source id this step removes — pairs 1:1 with a {@link SeederSourceId}. */
  readonly sourceId: SeederSourceId;
  /** Short human-readable description shown in `cleo auth remove --dry-run`. */
  readonly description: string;
  /**
   * Execute the removal for a `(provider, label)` pair.
   *
   * MUST be idempotent — re-invoking with the same args after a successful
   * run MUST NOT raise. Filesystem cleanup absence is treated as success
   * (the desired post-state was already in place).
   *
   * @param args - Provider/label being removed.
   * @returns Cleanup summary + hints + suppression directive.
   */
  remove(args: { provider: string; label: string }): Promise<RemovalResult>;
}

/**
 * One entry in the suppression list persisted to `auth-suppression.json`.
 *
 * @task T9415
 */
export interface SuppressionEntry {
  /** Provider id (e.g. `'anthropic'`). */
  provider: string;
  /** Source id whose seeder should be skipped for this provider. */
  sourceId: SeederSourceId;
  /** Epoch milliseconds the suppression was recorded — for diagnostics. */
  suppressedAt: number;
}

/**
 * On-disk shape of `auth-suppression.json`.
 *
 * @internal — exposed for tests; CLI callers go through the helpers below.
 */
export interface SuppressionFile {
  /** Schema version; bump on any breaking layout change. */
  version: 1;
  /** Active suppression entries. */
  entries: SuppressionEntry[];
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * In-process registry mapping {@link SeederSourceId} → {@link RemovalStep}.
 *
 * Uniqueness rule: each `sourceId` MUST appear at most once. A duplicate
 * `register()` call throws synchronously — silent overwrites would let two
 * steps fight over the same source, which is a programmer error in test or
 * extension code.
 *
 * Tests construct a fresh `RemovalRegistry()` for isolation; production
 * code uses the {@link REMOVAL_REGISTRY} singleton populated at module load
 * (see bottom of this file).
 *
 * @task T9415
 */
export class RemovalRegistry {
  private readonly steps = new Map<SeederSourceId, RemovalStep>();

  /**
   * Register a removal step.
   *
   * @param step - Removal step instance to add.
   * @throws {Error} `E_REMOVAL_DUPLICATE` when `step.sourceId` is already
   *   registered.
   */
  register(step: RemovalStep): void {
    if (this.steps.has(step.sourceId)) {
      throw new Error(
        `E_REMOVAL_DUPLICATE: a removal step is already registered for sourceId='${step.sourceId}'`,
      );
    }
    this.steps.set(step.sourceId, step);
  }

  /**
   * Look up the step for a source id.
   *
   * @param sourceId - Source id to dispatch on.
   * @returns The registered step, or `undefined` if none is registered.
   */
  find(sourceId: SeederSourceId): RemovalStep | undefined {
    return this.steps.get(sourceId);
  }

  /**
   * Return every registered step (insertion order).
   *
   * Used by `cleo auth remove --all` and diagnostic listing.
   */
  getAll(): readonly RemovalStep[] {
    return Array.from(this.steps.values());
  }
}

// ---------------------------------------------------------------------------
// Suppression-state persistence
// ---------------------------------------------------------------------------

/**
 * Filename for the persisted suppression list under `getCleoHome()`.
 *
 * @internal
 */
const SUPPRESSION_FILENAME = 'auth-suppression.json';

/**
 * Absolute path to the suppression-state file.
 *
 * Resolved at call time (NOT cached at module load) so test harnesses can
 * override `CLEO_HOME` between runs and see the change reflected.
 *
 * @returns `${getCleoHome()}/auth-suppression.json`.
 *
 * @task T9415
 */
export function suppressionStatePath(): string {
  return join(getCleoHome(), SUPPRESSION_FILENAME);
}

/**
 * Read the suppression file, returning a fresh empty document when the
 * file does not yet exist.
 *
 * @returns Parsed suppression document.
 *
 * @task T9415
 */
export function readSuppressionFile(): SuppressionFile {
  const data = readJsonFile<SuppressionFile>(suppressionStatePath());
  if (data && data.version === 1 && Array.isArray(data.entries)) {
    return data;
  }
  return { version: 1, entries: [] };
}

/**
 * Atomically persist the suppression file to disk.
 *
 * Goes through {@link writeJsonFileAtomic} (temp + rename); the parent
 * directory (`getCleoHome()`) is created upstream by `@cleocode/paths` so
 * we do not need to `mkdir` here. The atomic helper itself creates the
 * temp file inside the target's parent directory, so a missing parent
 * surfaces as the original error rather than corrupting state.
 *
 * @param next - New file contents.
 *
 * @task T9415
 */
export function writeSuppressionFile(next: SuppressionFile): void {
  writeJsonFileAtomic(suppressionStatePath(), next);
}

/**
 * Add `(provider, sourceId)` to the suppression list.
 *
 * Idempotent — a `(provider, sourceId)` pair already present is left
 * untouched (its original `suppressedAt` is preserved so diagnostics can
 * surface the first removal). Reads full state, mutates in-memory, writes
 * atomically — concurrent CLI invocations cannot interleave partial
 * writes.
 *
 * @param provider - Provider id whose seeder should be suppressed.
 * @param sourceId - Source id of the seeder to suppress.
 *
 * @task T9415
 */
export function addSuppression(provider: string, sourceId: SeederSourceId): void {
  const current = readSuppressionFile();
  const exists = current.entries.some((e) => e.provider === provider && e.sourceId === sourceId);
  if (exists) return;
  const next: SuppressionFile = {
    version: 1,
    entries: [...current.entries, { provider, sourceId, suppressedAt: Date.now() }],
  };
  writeSuppressionFile(next);
}

/**
 * Remove `(provider, sourceId)` from the suppression list.
 *
 * Idempotent — removing an entry that does not exist is a no-op. Intended
 * for the future `cleo auth unsuppress` CLI surface (T9416+).
 *
 * @param provider - Provider id to un-suppress.
 * @param sourceId - Source id to un-suppress.
 * @returns `true` if an entry was removed, `false` if none matched.
 *
 * @task T9415
 */
export function removeSuppression(provider: string, sourceId: SeederSourceId): boolean {
  const current = readSuppressionFile();
  const before = current.entries.length;
  const filtered = current.entries.filter(
    (e) => !(e.provider === provider && e.sourceId === sourceId),
  );
  if (filtered.length === before) return false;
  writeSuppressionFile({ version: 1, entries: filtered });
  return true;
}

/**
 * Test whether a `(provider, sourceId)` pair is currently suppressed.
 *
 * @param provider - Provider id.
 * @param sourceId - Source id.
 * @returns `true` if suppression is active.
 *
 * @task T9415
 */
export function isSuppressed(provider: string, sourceId: SeederSourceId): boolean {
  const current = readSuppressionFile();
  return current.entries.some((e) => e.provider === provider && e.sourceId === sourceId);
}

// ---------------------------------------------------------------------------
// Concrete RemovalStep implementations
// ---------------------------------------------------------------------------

/**
 * `'manual'` — entry the operator added with `cleo llm add`.
 *
 * The actual `llm-credentials.json` mutation is performed by the future
 * `cleo auth remove` CLI (T9416) which calls the credential store
 * directly; this step does NOT touch filesystem state itself. Suppression
 * is `false` because `'manual'` has no seeder pass to skip.
 *
 * @task T9415
 */
export const MANUAL_REMOVAL_STEP: RemovalStep = {
  sourceId: 'manual',
  description: 'Operator-added entry; removed directly from llm-credentials.json',
  async remove() {
    return {
      cleaned: [],
      hints: ['entry removed from llm-credentials.json'],
      suppress: false,
    };
  },
};

/**
 * `'env'` — environment-variable seed.
 *
 * CLEO cannot unset another shell's exported variable, so cleanup is empty
 * and the hint instructs the operator. Suppression is `true` so the next
 * seed pass skips the env source even if the variable is still set
 * (otherwise the just-removed credential would silently re-appear).
 *
 * @task T9415
 */
export const ENV_REMOVAL_STEP: RemovalStep = {
  sourceId: 'env',
  description: 'Environment variable; cannot be unset by CLEO',
  async remove() {
    return {
      cleaned: [],
      hints: ['Unset $VARNAME in your shell to prevent re-seeding'],
      suppress: true,
    };
  },
};

/**
 * `'claude-code'` — `~/.claude/.credentials.json` consented import.
 *
 * Hard rule: CLEO MUST NOT delete `~/.claude/.credentials.json` — Claude
 * Code itself depends on the file. The correct cleanup is suppression of
 * the seeder so the next pool load does not re-import the credential.
 *
 * @task T9415
 */
export const CLAUDE_CODE_REMOVAL_STEP: RemovalStep = {
  sourceId: 'claude-code',
  description: 'Suppress claude-code re-seed; leave ~/.claude/.credentials.json untouched',
  async remove() {
    return {
      cleaned: [],
      hints: [
        'Do NOT delete ~/.claude/.credentials.json — Claude Code uses it. Re-seeding is suppressed instead.',
      ],
      suppress: true,
    };
  },
};

/**
 * `'cleo-pkce'` — credential issued by `cleo llm login` (PKCE flow).
 *
 * Owned end-to-end by CLEO: the token cache file at
 * `${getCleoHome()}/anthropic-oauth.json` is deleted unconditionally
 * (ENOENT is silently ignored — idempotency requirement). Suppression is
 * `true` so a residual seeder pass does not re-seed a deleted token.
 *
 * @task T9415
 */
export const CLEO_PKCE_REMOVAL_STEP: RemovalStep = {
  sourceId: 'cleo-pkce',
  description: 'Delete CLEO-issued PKCE token at <CLEO_HOME>/anthropic-oauth.json',
  async remove() {
    const path = join(getCleoHome(), 'anthropic-oauth.json');
    const cleaned: string[] = [];
    try {
      unlinkSync(path);
      cleaned.push(path);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw err;
    }
    return {
      cleaned,
      hints: [],
      suppress: true,
    };
  },
};

/**
 * `'codex-cli'` — OpenAI Codex CLI session token.
 *
 * CLEO does not own the Codex CLI's on-disk state. The hint points the
 * operator at the Codex tooling; suppression is `true`.
 *
 * @task T9415
 */
export const CODEX_CLI_REMOVAL_STEP: RemovalStep = {
  sourceId: 'codex-cli',
  description: 'Suppress codex-cli re-seed; revoke via the Codex CLI itself',
  async remove() {
    return {
      cleaned: [],
      hints: [
        'Run `codex logout` (or remove ~/.codex/auth.json) in the Codex CLI to revoke the underlying token.',
      ],
      suppress: true,
    };
  },
};

/**
 * `'gemini-cli'` — Google Gemini CLI application default credentials.
 *
 * Same pattern as `'codex-cli'`: CLEO does not own the Gemini CLI's state.
 *
 * @task T9415
 */
export const GEMINI_CLI_REMOVAL_STEP: RemovalStep = {
  sourceId: 'gemini-cli',
  description: 'Suppress gemini-cli re-seed; revoke via the Gemini CLI itself',
  async remove() {
    return {
      cleaned: [],
      hints: [
        'Run `gcloud auth application-default revoke` (or `gemini auth logout`) to revoke the underlying token.',
      ],
      suppress: true,
    };
  },
};

/**
 * `'gh-cli'` — GitHub CLI token (for the `github-models` provider).
 *
 * Same pattern: CLEO does not own `gh`'s keyring.
 *
 * @task T9415
 */
export const GH_CLI_REMOVAL_STEP: RemovalStep = {
  sourceId: 'gh-cli',
  description: 'Suppress gh-cli re-seed; revoke via `gh auth logout`',
  async remove() {
    return {
      cleaned: [],
      hints: ['Run `gh auth logout` to revoke the underlying GitHub token.'],
      suppress: true,
    };
  },
};

// ---------------------------------------------------------------------------
// Module-state singleton
// ---------------------------------------------------------------------------

/**
 * Build a fresh registry pre-populated with every built-in step.
 *
 * Exposed so tests can construct an isolated registry mirroring production
 * state without mutating the {@link REMOVAL_REGISTRY} singleton.
 *
 * @returns A fully populated `RemovalRegistry`.
 *
 * @task T9415
 */
export function buildBuiltinRemovalRegistry(): RemovalRegistry {
  const registry = new RemovalRegistry();
  registry.register(MANUAL_REMOVAL_STEP);
  registry.register(ENV_REMOVAL_STEP);
  registry.register(CLAUDE_CODE_REMOVAL_STEP);
  registry.register(CLEO_PKCE_REMOVAL_STEP);
  registry.register(CODEX_CLI_REMOVAL_STEP);
  registry.register(GEMINI_CLI_REMOVAL_STEP);
  registry.register(GH_CLI_REMOVAL_STEP);
  return registry;
}

/**
 * Process-wide singleton used by the future `cleo auth remove` CLI.
 *
 * Populated at module load with every built-in step. Tests requiring
 * isolation MUST construct a fresh registry via
 * {@link buildBuiltinRemovalRegistry} (or `new RemovalRegistry()`) instead
 * of mutating this instance.
 *
 * @task T9415
 */
export const REMOVAL_REGISTRY: RemovalRegistry = buildBuiltinRemovalRegistry();
