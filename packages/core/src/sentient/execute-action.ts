/**
 * Sentient Tier-2 proposal `fixAction` executor (T9898 · Epic T9861 · Saga T9855).
 *
 * Provides the pure, testable execution surface used by the CLI handler
 * `cleo sentient propose accept <id>`. Decouples the safety guard, argv
 * parsing, child-process spawn, and audit-log append from the CLI layer
 * so each can be unit-tested in isolation and reused if Tier-3
 * auto-execution lands later.
 *
 * Safety model:
 *   - `fixAction` MUST start with one of the safe prefixes (`cleo`, `pnpm`).
 *   - `fixAction` MUST match a conservative character allowlist — no
 *     shell metacharacters (`& | ; $ ` ` ( ) < > \\ "` `'`, backticks,
 *     newlines, etc.).
 *   - Execution uses `child_process.spawn(cmd, argv, { shell: false })`.
 *     The string is NEVER passed through a shell.
 *
 * Rollback note: the only fixAction kinds wired today (`cleo templates
 * upgrade <id>`, `cleo init --refresh-context`, `cleo config validate`)
 * are either idempotent reads or have their own rollback via `git
 * checkout` of the affected files. The audit log at
 * `.cleo/audit/sentient-execute.jsonl` records every execution so an
 * owner can trace and revert with `git revert` / `git checkout` on the
 * paths the executed verb touched.
 *
 * @see packages/cleo/src/cli/commands/sentient.ts (CLI integration)
 * @see packages/core/src/sentient/detectors/template-drift.ts (fixAction producer)
 * @task T9898
 * @epic T9861
 */

import { spawn } from 'node:child_process';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Safe argv-zero prefixes accepted by {@link parseFixAction}. */
export const SAFE_FIX_ACTION_PREFIXES = ['cleo', 'pnpm'] as const;

/** Allowed characters in a fixAction string. */
const FIX_ACTION_ALLOWED = /^[A-Za-z0-9_\-./= \t]+$/;

/** Default audit log location relative to projectRoot. */
export const SENTIENT_EXECUTE_AUDIT_PATH = '.cleo/audit/sentient-execute.jsonl';

/**
 * Parsed result of safety-validating + tokenising a fixAction string.
 *
 * `ok=false` carries the rejection `code` and human-readable `reason`
 * so the CLI can emit an envelope with the canonical
 * `E_SENTIENT_UNSAFE_ACTION` failure code.
 */
export type ParsedFixAction =
  | {
      readonly ok: true;
      readonly cmd: string;
      readonly argv: readonly string[];
    }
  | {
      readonly ok: false;
      readonly code: 'E_SENTIENT_UNSAFE_ACTION';
      readonly reason: string;
    };

/**
 * Validate + tokenise a fixAction string into an argv array safe for
 * `spawn(cmd, argv, { shell: false })`.
 *
 * Rejects any input that:
 *   - is empty / whitespace-only
 *   - contains shell metacharacters (anything outside the conservative
 *     `[A-Za-z0-9_\-./= \t]` allowlist)
 *   - does not begin with one of {@link SAFE_FIX_ACTION_PREFIXES}
 *
 * @param fixAction - Raw fixAction string from a Tier-2 proposal.
 * @returns A {@link ParsedFixAction} discriminated by `ok`.
 */
export function parseFixAction(fixAction: string): ParsedFixAction {
  const trimmed = fixAction.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      code: 'E_SENTIENT_UNSAFE_ACTION',
      reason: 'fixAction is empty',
    };
  }
  if (!FIX_ACTION_ALLOWED.test(trimmed)) {
    return {
      ok: false,
      code: 'E_SENTIENT_UNSAFE_ACTION',
      reason: 'fixAction contains disallowed characters (shell metacharacters)',
    };
  }
  const tokens = trimmed.split(/[ \t]+/).filter((t) => t.length > 0);
  const cmd = tokens[0];
  if (!cmd) {
    return {
      ok: false,
      code: 'E_SENTIENT_UNSAFE_ACTION',
      reason: 'fixAction has no command token',
    };
  }
  if (!(SAFE_FIX_ACTION_PREFIXES as readonly string[]).includes(cmd)) {
    return {
      ok: false,
      code: 'E_SENTIENT_UNSAFE_ACTION',
      reason: `fixAction must start with one of: ${SAFE_FIX_ACTION_PREFIXES.join(', ')}`,
    };
  }
  return { ok: true, cmd, argv: tokens.slice(1) };
}

/** Successful execution outcome reported by {@link executeFixAction}. */
export interface ExecuteFixActionResult {
  readonly executed: true;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly stderrSnippet: string;
}

/** Injectable spawn surface used by tests to bypass real child processes. */
export interface SpawnInjector {
  spawn?: (cmd: string, argv: readonly string[]) => Promise<{ exitCode: number; stderr: string }>;
}

/** Options accepted by {@link executeFixAction}. */
export interface ExecuteFixActionOptions extends SpawnInjector {
  /** Working directory for the spawned process. */
  readonly cwd: string;
  /** Maximum stderr bytes captured in the snippet (default 1024). */
  readonly stderrSnippetLimit?: number;
}

/**
 * Default spawn shim — wraps `child_process.spawn` and resolves with the
 * exit code + captured stderr. Stderr is buffered as UTF-8.
 *
 * @internal
 */
function defaultSpawn(
  cmd: string,
  argv: readonly string[],
  cwd: string,
): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, [...argv], {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    // Drain stdout so the pipe doesn't fill and block.
    child.stdout.on('data', () => {});
    child.on('error', (err) => {
      resolve({ exitCode: 1, stderr: `${stderr}\n${err.message}` });
    });
    child.on('exit', (code) => {
      resolve({ exitCode: code ?? 1, stderr });
    });
  });
}

/**
 * Execute a parsed fixAction via `child_process.spawn` (NEVER through a
 * shell) and return the exit code + a bounded stderr snippet.
 *
 * @param parsed  - Validated tokens from {@link parseFixAction}.
 * @param options - cwd + optional spawn injection.
 * @returns {@link ExecuteFixActionResult} on completion (including non-zero exit).
 */
export async function executeFixAction(
  parsed: Extract<ParsedFixAction, { ok: true }>,
  options: ExecuteFixActionOptions,
): Promise<ExecuteFixActionResult> {
  const startedAt = Date.now();
  const spawnImpl = options.spawn ?? ((c, a) => defaultSpawn(c, a, options.cwd));
  const { exitCode, stderr } = await spawnImpl(parsed.cmd, parsed.argv);
  const limit = options.stderrSnippetLimit ?? 1024;
  const snippet = stderr.length > limit ? `${stderr.slice(0, limit)}…` : stderr;
  return {
    executed: true,
    exitCode,
    durationMs: Date.now() - startedAt,
    stderrSnippet: snippet,
  };
}

/** Audit log entry written to `.cleo/audit/sentient-execute.jsonl`. */
export interface SentientExecuteAuditEntry {
  readonly proposalId: string;
  readonly fixAction: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly timestamp: string;
}

/**
 * Append one structured JSON line to `.cleo/audit/sentient-execute.jsonl`.
 *
 * Creates the directory if missing. Failures are non-fatal — the caller
 * decides how to surface them; this returns `false` on append failure
 * so the CLI can emit a warning rather than aborting the success
 * envelope.
 *
 * @param projectRoot - Absolute project root (contains `.cleo/`).
 * @param entry       - Audit entry payload.
 * @returns `true` on successful append, `false` on IO failure.
 */
export async function appendSentientExecuteAudit(
  projectRoot: string,
  entry: SentientExecuteAuditEntry,
): Promise<boolean> {
  const path = join(projectRoot, SENTIENT_EXECUTE_AUDIT_PATH);
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract a fixAction string from a task row's `notes_json` column.
 *
 * Proposals persisted by the propose-tick pipeline embed a
 * `proposal-meta` envelope as the first JSON-stringified entry of
 * `notes_json`. When detectors include a `fixAction`, it lands on that
 * envelope and this helper surfaces it for the accept handler.
 *
 * Returns `null` when:
 *   - `notesJson` is null/empty/malformed
 *   - the proposal-meta envelope is absent
 *   - `fixAction` is missing or non-string
 *
 * @param notesJson - Raw `notes_json` column value (an array of JSON strings).
 */
export function extractFixActionFromNotesJson(notesJson: string | null): string | null {
  if (!notesJson) return null;
  let outer: unknown;
  try {
    outer = JSON.parse(notesJson);
  } catch {
    return null;
  }
  if (!Array.isArray(outer)) return null;
  for (const entry of outer) {
    if (typeof entry !== 'string') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(entry);
    } catch {
      continue;
    }
    if (
      parsed &&
      typeof parsed === 'object' &&
      'kind' in parsed &&
      (parsed as { kind: unknown }).kind === 'proposal-meta' &&
      'fixAction' in parsed &&
      typeof (parsed as { fixAction: unknown }).fixAction === 'string'
    ) {
      const fixAction = (parsed as { fixAction: string }).fixAction;
      return fixAction.length > 0 ? fixAction : null;
    }
  }
  return null;
}
