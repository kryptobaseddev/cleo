/**
 * Harness hint resolver — determines whether the calling harness already has
 * CLEO-INJECTION.md loaded (so tier-1 prompt can skip the ~9KB embed).
 *
 * Resolution cascade (highest priority first):
 *   1. Explicit function-call option: `options.explicit`
 *   2. Env var: `CLEO_HARNESS=<claude-code|generic|bare>`
 *      (CLI flag wrappers SHOULD set this env var so the cascade sees it.)
 *   3. Persisted: `<projectRoot>/.cleo/harness-profile.json`
 *   4. Auto-detect: both `CLAUDECODE=1` AND `CLAUDE_CODE_ENTRYPOINT` set → `claude-code`
 *   5. Default: `generic`
 *
 * The dedup budget is the ~9KB tier-1 CLEO-INJECTION.md embed. Harnesses that
 * already inject the protocol (e.g. Claude Code via `AGENTS.md`) can safely
 * skip the embed and save the tokens. Non-injecting harnesses (generic,
 * bare) must receive the full embed so the subagent sees the protocol at
 * least once per prompt.
 *
 * @task T889 Orchestration Coherence v3
 * @task T893 Harness-aware dedup (W3-2)
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// ============================================================================
// Types
// ============================================================================

/**
 * Identifiers for the harness context the spawn prompt is being built for.
 *
 * - `claude-code` — the Claude Code CLI (auto-injects `AGENTS.md`, so the
 *   tier-1 CLEO-INJECTION embed is redundant).
 * - `generic`     — any non-Claude-Code agent runtime (OpenAI Agents SDK,
 *   LangGraph, Gemini, hand-rolled wrappers). Default. MUST receive the
 *   embed so the protocol reaches the subagent.
 * - `bare`        — no harness whatsoever (raw API call). Treated like
 *   `generic` for embed purposes but reserved for future behaviour
 *   divergence (e.g. skipping session commands the runtime can't exec).
 */
export type HarnessHint = 'claude-code' | 'generic' | 'bare';

/**
 * Approximate byte size of the tier-1 `CLEO-INJECTION.md` embed that gets
 * deduplicated when a harness already has the protocol loaded.
 *
 * Used only for diagnostic accounting — the actual embed skip is binary
 * (present or absent), and the real byte count depends on the current
 * template. 9000 chars is a conservative upper bound matching the current
 * template size as of 2026-04-17.
 */
export const DEDUP_EMBED_CHARS = 9000;

/**
 * Allowed literal values for the `CLEO_HARNESS` env var. Kept as a closed set
 * to make typos fail loudly instead of silently falling through to `default`.
 */
const HARNESS_HINT_VALUES: ReadonlySet<HarnessHint> = new Set<HarnessHint>([
  'claude-code',
  'generic',
  'bare',
]);

/**
 * Input shape for {@link resolveHarnessHint}.
 */
export interface ResolveHarnessHintOptions {
  /**
   * Explicit override — wins over env, profile, and auto-detect.
   *
   * CLI callers translating a `--harness-hint` flag SHOULD pass the parsed
   * value here rather than mutating `process.env`.
   */
  explicit?: HarnessHint;
  /**
   * Absolute path to the project root. When supplied, the resolver reads
   * `<projectRoot>/.cleo/harness-profile.json` as the third cascade step.
   * When omitted, the profile lookup is skipped.
   */
  projectRoot?: string;
  /**
   * Env source for deterministic testing. Defaults to `process.env`.
   */
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolution result from {@link resolveHarnessHint}.
 */
export interface HarnessHintResult {
  /** Resolved harness hint. */
  hint: HarnessHint;
  /**
   * Which cascade step produced the hint. Useful for diagnostics and for
   * tests that want to assert the precedence order.
   */
  source: 'option' | 'env' | 'profile' | 'auto-detect' | 'default';
  /**
   * Estimated characters saved by skipping the tier-1 CLEO-INJECTION embed.
   * `DEDUP_EMBED_CHARS` for `claude-code`, `0` for every other hint.
   */
  dedupSavedChars: number;
}

/**
 * On-disk profile shape written by {@link persistHarnessProfile}.
 */
export interface HarnessProfile {
  /** Detected or persisted harness hint. */
  harness: HarnessHint;
  /** ISO 8601 timestamp when the profile was written. */
  detectedAt: string;
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Narrow an arbitrary string to {@link HarnessHint} when it matches one of the
 * three allowed values. Returns `undefined` for unknown strings so callers can
 * fall through to the next cascade step instead of blindly trusting the input.
 */
function coerceHarnessHint(value: string | undefined): HarnessHint | undefined {
  if (!value) return undefined;
  return HARNESS_HINT_VALUES.has(value as HarnessHint) ? (value as HarnessHint) : undefined;
}

/**
 * Compute `dedupSavedChars` for a resolved hint.
 *
 * Only `claude-code` currently triggers the dedup budget because it is the
 * only harness known to auto-load `CLEO-INJECTION.md` via `AGENTS.md`. Every
 * other hint pays the full embed cost so the subagent sees the protocol.
 */
function computeDedupSaved(hint: HarnessHint): number {
  return hint === 'claude-code' ? DEDUP_EMBED_CHARS : 0;
}

/**
 * Absolute path to the persisted harness profile under a project root.
 */
function harnessProfilePath(projectRoot: string): string {
  return join(projectRoot, '.cleo', 'harness-profile.json');
}

/**
 * Attempt to read `<projectRoot>/.cleo/harness-profile.json` synchronously.
 *
 * Returns `undefined` on missing file, malformed JSON, or unrecognised
 * harness value. The async {@link loadHarnessProfile} is available for
 * callers that want the full profile envelope back.
 */
function readPersistedHint(projectRoot: string): HarnessHint | undefined {
  const path = harnessProfilePath(projectRoot);
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<HarnessProfile>;
    return coerceHarnessHint(parsed.harness);
  } catch {
    return undefined;
  }
}

/**
 * Auto-detect the `claude-code` harness by checking BOTH marker env vars.
 *
 * Requiring two signals keeps accidental inheritance (e.g. a nested shell
 * that re-exported `CLAUDECODE=1` but cleared `CLAUDE_CODE_ENTRYPOINT`)
 * from falsely claiming a Claude Code session. Only when the actual binary
 * is running will both vars be populated.
 */
function autoDetectClaudeCode(env: NodeJS.ProcessEnv): HarnessHint | undefined {
  const hasMarker = env['CLAUDECODE'] === '1';
  const hasEntrypoint =
    typeof env['CLAUDE_CODE_ENTRYPOINT'] === 'string' && env['CLAUDE_CODE_ENTRYPOINT'].length > 0;
  return hasMarker && hasEntrypoint ? 'claude-code' : undefined;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Resolve the active harness hint using the documented cascade.
 *
 * @param options - See {@link ResolveHarnessHintOptions}. Empty by default.
 * @returns Resolution envelope identifying the hint, the cascade step, and
 *          the dedup budget.
 *
 * @example
 * ```typescript
 * // From the CLI, honouring a `--harness-hint` flag:
 * const { hint, source } = resolveHarnessHint({
 *   explicit: flagValue,
 *   projectRoot,
 * });
 *
 * // From the test suite, pinning the env:
 * const result = resolveHarnessHint({
 *   env: { CLEO_HARNESS: 'claude-code' },
 * });
 * ```
 *
 * @task T889 / T893 / W3-2
 */
export function resolveHarnessHint(options: ResolveHarnessHintOptions = {}): HarnessHintResult {
  const env = options.env ?? process.env;

  // 1. Explicit option wins unconditionally.
  if (options.explicit !== undefined) {
    return {
      hint: options.explicit,
      source: 'option',
      dedupSavedChars: computeDedupSaved(options.explicit),
    };
  }

  // 2. CLEO_HARNESS env var (CLI flag wrappers lift their flag into this).
  const envHint = coerceHarnessHint(env['CLEO_HARNESS']);
  if (envHint) {
    return { hint: envHint, source: 'env', dedupSavedChars: computeDedupSaved(envHint) };
  }

  // 3. Persisted profile at <projectRoot>/.cleo/harness-profile.json.
  if (options.projectRoot) {
    const persisted = readPersistedHint(options.projectRoot);
    if (persisted) {
      return { hint: persisted, source: 'profile', dedupSavedChars: computeDedupSaved(persisted) };
    }
  }

  // 4. Auto-detect Claude Code via both marker env vars.
  const autoDetected = autoDetectClaudeCode(env);
  if (autoDetected) {
    return {
      hint: autoDetected,
      source: 'auto-detect',
      dedupSavedChars: computeDedupSaved(autoDetected),
    };
  }

  // 5. Default — `generic`.
  return { hint: 'generic', source: 'default', dedupSavedChars: computeDedupSaved('generic') };
}

/**
 * Persist a harness hint to `<projectRoot>/.cleo/harness-profile.json` using
 * an atomic `.tmp` write + rename so readers never observe a half-written
 * file.
 *
 * The `.cleo/` directory is created if it does not yet exist — callers do
 * NOT need to pre-create it. The written profile carries the ISO timestamp
 * at which persistence occurred, which makes the profile self-describing for
 * the `cleo agent doctor` walk.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param hint        - Harness hint to persist.
 *
 * @throws {Error} Surface I/O errors verbatim. Callers that want best-effort
 *                 persistence should wrap the call in try/catch — this
 *                 function does not swallow filesystem failures.
 *
 * @task T889 / T893 / W3-2
 */
export async function persistHarnessProfile(projectRoot: string, hint: HarnessHint): Promise<void> {
  const finalPath = harnessProfilePath(projectRoot);
  const cleoDir = dirname(finalPath);
  if (!existsSync(cleoDir)) {
    mkdirSync(cleoDir, { recursive: true });
  }
  const profile: HarnessProfile = {
    harness: hint,
    detectedAt: new Date().toISOString(),
  };
  const tmpPath = `${finalPath}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(profile, null, 2)}\n`, { encoding: 'utf-8' });
  renameSync(tmpPath, finalPath);
}

/**
 * Load the persisted harness profile from
 * `<projectRoot>/.cleo/harness-profile.json`, or `null` when absent or
 * malformed.
 *
 * This is the async counterpart to the synchronous profile read used by
 * {@link resolveHarnessHint}. Prefer this entry point for tooling that wants
 * the full envelope (including `detectedAt`) and treats missing profiles as
 * a non-error.
 *
 * @param projectRoot - Absolute path to the project root.
 * @returns The parsed profile, or `null` when the file is missing,
 *          unreadable, or carries an unknown `harness` value.
 *
 * @task T889 / T893 / W3-2
 */
export async function loadHarnessProfile(projectRoot: string): Promise<HarnessProfile | null> {
  const path = harnessProfilePath(projectRoot);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<HarnessProfile>;
    const hint = coerceHarnessHint(parsed.harness);
    if (!hint) return null;
    const detectedAt = typeof parsed.detectedAt === 'string' ? parsed.detectedAt : '';
    return { harness: hint, detectedAt };
  } catch {
    return null;
  }
}
