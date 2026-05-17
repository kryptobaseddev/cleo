/**
 * Anthropic OAuth token write-back — the canonical refresh-time persistence
 * path for the unified credential pool (E-CONFIG-AUTH-UNIFY E2a / T9411).
 *
 * On every successful OAuth refresh, CLEO ALWAYS writes the new tokens
 * to its own canonical file at `${getCleoHome()}/anthropic-oauth.json`.
 * When the operator has enabled cooperative write-back (default per OQ-1)
 * AND Claude Code's credential file either already exists OR the operator
 * has consented to Claude Code import, CLEO ALSO mirrors the refreshed
 * tokens into `~/.claude/.credentials.json`.
 *
 * ## Why cooperate
 *
 * Operators routinely run both CLEO and Claude Code from the same machine
 * against the same Anthropic account. Without cooperative write-back, the
 * first CLI to refresh wins and the other rejects subsequent requests with
 * `401 invalid_token` until the operator manually re-logs. The OQ-1
 * decision in `docs/plans/E-CONFIG-AUTH-UNIFY.md` resolves this by making
 * write-back ON by default — both CLIs see the freshest token at all
 * times — but never auto-creating Claude Code's file (consent-respecting).
 *
 * ## Atomicity + permissions
 *
 * Both writes use a temp-file-then-rename strategy with `mode: 0o600` set
 * at temp-file creation time so:
 *
 * 1. The post-rename file is born with the strict permission — there is
 *    no instant at which a 0o644 default file holds secrets on disk.
 * 2. A crash mid-write never leaves the live file truncated.
 *
 * After the rename succeeds, a defensive `chmod 0o600` is applied to the
 * live file. This is redundant on POSIX (the rename preserves the temp's
 * mode) but guards against Windows behavior where the open-mode flag on
 * `writeFileSync` is silently ignored.
 *
 * ## Scope preservation
 *
 * Claude Code >= 2.1.81 requires the `user:inference` scope on its OAuth
 * tokens; refreshes from the Anthropic API do NOT necessarily return the
 * scopes string, so this module MUST read the existing Claude Code file
 * (when present) and carry the scopes array forward verbatim. CLEO's own
 * file behaves the same way — if a `scopes` array is present we preserve
 * it; if the refresh provided new scopes those override.
 *
 * @module llm/credential-writeback
 * @task T9411
 * @epic E-CONFIG-AUTH-UNIFY (E2a)
 */

import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { parseClaudeCodeCredentials } from '@cleocode/contracts';
import { getConfigValue } from '../config.js';
import { getCleoHome } from '../paths.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Strict file mode for OAuth credential files (owner read/write only). */
const SECRET_FILE_MODE = 0o600;

/** Config flag controlling cooperative write-back to Claude Code's file. */
const COOPERATIVE_FLAG_KEY = 'auth.cooperativeWriteBack';

/** Config flag attesting that the operator consented to Claude Code import. */
const CONSENT_FLAG_KEY = 'auth.claudeCodeConsentGiven';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Refreshed OAuth token bundle handed to {@link writeBackAnthropicTokens}.
 *
 * `scopes` is optional — the Anthropic refresh endpoint does not always
 * return it. When omitted, the write-back handler reads the existing
 * on-disk file (CLEO's own and Claude Code's) and carries the previous
 * scopes forward so Claude Code's `user:inference` requirement is honored.
 */
export interface RefreshedAnthropicTokens {
  /** New short-lived bearer token returned by the refresh exchange. */
  accessToken: string;
  /** New refresh token to use for the next refresh. */
  refreshToken: string;
  /** Unix-millisecond expiry timestamp of the new access token. */
  expiresAt: number;
  /**
   * Optional scopes string array returned by the refresh exchange.
   *
   * When omitted, the write-back preserves whatever scopes were on disk.
   */
  scopes?: string[];
}

/**
 * Result of {@link writeBackAnthropicTokens}.
 *
 * `written` lists the absolute paths that were successfully written.
 * `skipped` lists paths that were intentionally NOT written, paired with
 * a human-readable reason (e.g. `"cooperativeWriteBack=false"`). Failed
 * writes throw — they never appear in either list.
 */
export interface WriteBackResult {
  /** Absolute paths of files that were written. */
  written: string[];
  /** Absolute paths NOT written, paired with a `reason`. */
  skipped: Array<{ path: string; reason: string }>;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Persist refreshed Anthropic OAuth tokens to disk.
 *
 * Always writes to `${getCleoHome()}/anthropic-oauth.json`. Additionally
 * writes to `~/.claude/.credentials.json` IFF:
 *
 * 1. The config flag `auth.cooperativeWriteBack` is `true` (default), AND
 * 2. The Claude Code file already exists on disk OR the operator has set
 *    `auth.claudeCodeConsentGiven = true`.
 *
 * Both writes are atomic (temp file + rename) and mode 0o600. The
 * `claudeAiOauth.scopes` field is preserved verbatim across writes so
 * Claude Code >= 2.1.81 continues to accept the token.
 *
 * @param refreshed - Token bundle returned by the Anthropic refresh exchange.
 * @returns Lists of written + skipped paths with reasons.
 * @throws If a write fails after the gating checks pass — callers can
 *   surface the error to the operator (refresh succeeded but persistence
 *   failed; the in-memory tokens are still usable until process exit).
 *
 * @task T9411
 */
export async function writeBackAnthropicTokens(
  refreshed: RefreshedAnthropicTokens,
): Promise<WriteBackResult> {
  const written: string[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];

  // ---- 1. CLEO's own file (always written) -------------------------------
  const cleoPath = cleoPkceFilePath();
  const cleoPrev = readExistingClaudeAiOauth(cleoPath);
  const cleoScopes = pickScopes(refreshed.scopes, cleoPrev?.scopes);
  writeClaudeAiOauthFile(cleoPath, refreshed, cleoScopes);
  written.push(cleoPath);

  // ---- 2. Cooperative write to Claude Code's file (gated) ----------------
  const claudeCodePath = claudeCodeCredentialsPath();
  const cooperative = await resolveBooleanFlag(COOPERATIVE_FLAG_KEY);
  if (!cooperative) {
    skipped.push({
      path: claudeCodePath,
      reason: `${COOPERATIVE_FLAG_KEY}=false`,
    });
    return { written, skipped };
  }

  const claudeCodeExists = existsSync(claudeCodePath);
  if (!claudeCodeExists) {
    // Even with cooperative write-back ON, we never CREATE the Claude Code
    // file unless the operator explicitly consented (mirrors T9410's
    // consent gate semantics — fail closed).
    const consented = await resolveBooleanFlag(CONSENT_FLAG_KEY);
    if (!consented) {
      skipped.push({
        path: claudeCodePath,
        reason: `claude-code file absent and ${CONSENT_FLAG_KEY}=false`,
      });
      return { written, skipped };
    }
  }

  const claudeCodePrev = claudeCodeExists ? readExistingClaudeAiOauth(claudeCodePath) : null;
  const claudeScopes = pickScopes(refreshed.scopes, claudeCodePrev?.scopes);
  writeClaudeAiOauthFile(claudeCodePath, refreshed, claudeScopes);
  written.push(claudeCodePath);

  return { written, skipped };
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/** CLEO's canonical PKCE token file path. */
function cleoPkceFilePath(): string {
  return join(getCleoHome(), 'anthropic-oauth.json');
}

/** Claude Code's credential file path under the operator's home dir. */
function claudeCodeCredentialsPath(): string {
  return join(homedir(), '.claude', '.credentials.json');
}

// ---------------------------------------------------------------------------
// Read-side helpers
// ---------------------------------------------------------------------------

/**
 * Read the `claudeAiOauth` block from an existing credential file.
 *
 * Returns `null` when the file is absent, malformed, or missing the
 * `claudeAiOauth` block — callers treat any null as "no previous state".
 * Unlike `parseClaudeCodeCredentials`, this helper does NOT filter on
 * expiry: we want the scopes from the existing file even if its token
 * is stale (the whole point of write-back is to refresh that token).
 *
 * @internal
 */
function readExistingClaudeAiOauth(
  path: string,
): { accessToken?: string; scopes?: string[] } | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
  // First pass — try `parseClaudeCodeCredentials` (preserves scopes when
  // the token is not expired).
  const parsed = parseClaudeCodeCredentials(raw);
  if (parsed) {
    return { accessToken: parsed.accessToken, scopes: parsed.scopes };
  }
  // Second pass — token may be expired but we still want the scopes.
  try {
    const json = JSON.parse(raw) as Record<string, unknown>;
    const block = json['claudeAiOauth'];
    if (block && typeof block === 'object') {
      const rec = block as Record<string, unknown>;
      const scopes = rec['scopes'];
      if (Array.isArray(scopes) && scopes.every((s) => typeof s === 'string')) {
        return { scopes: scopes as string[] };
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Decide which scopes array to persist for this write.
 *
 * Priority order:
 *
 * 1. Scopes explicitly returned by the refresh exchange (`refreshed.scopes`).
 * 2. Scopes already on disk (preserve Claude Code's `user:inference`).
 * 3. `undefined` — omit the field entirely.
 *
 * @internal
 */
function pickScopes(
  refreshedScopes: string[] | undefined,
  diskScopes: string[] | undefined,
): string[] | undefined {
  if (refreshedScopes && refreshedScopes.length > 0) return refreshedScopes;
  if (diskScopes && diskScopes.length > 0) return diskScopes;
  return undefined;
}

// ---------------------------------------------------------------------------
// Write-side primitives
// ---------------------------------------------------------------------------

/**
 * Atomically write the `claudeAiOauth` envelope to `path`.
 *
 * Strategy:
 *
 * 1. Build the envelope object.
 * 2. Write to a sibling temp file (`.basename.<hex>.tmp`) created at mode
 *    `0o600` so the bytes never sit on disk under a looser permission.
 * 3. `rename` the temp into place — atomic on POSIX, near-atomic on
 *    Windows. After rename, `chmod 0o600` to belt-and-suspenders against
 *    Windows ignoring the temp's mode.
 * 4. On any error during steps 2-3, unlink the temp file (best-effort).
 *
 * Does NOT create the parent directory — for `~/.claude/.credentials.json`
 * we only co-write when the directory already exists (Claude Code created
 * it); for CLEO's own file the caller ensures `getCleoHome()` exists via
 * `bootstrap.ts`.
 *
 * @internal
 */
function writeClaudeAiOauthFile(
  path: string,
  refreshed: RefreshedAnthropicTokens,
  scopes: string[] | undefined,
): void {
  const envelope = {
    claudeAiOauth: {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: refreshed.expiresAt,
      ...(scopes !== undefined ? { scopes } : {}),
    },
  };
  const content = `${JSON.stringify(envelope, null, 2)}\n`;

  const dir = dirname(path);
  const tempPath = join(dir, `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);

  try {
    writeFileSync(tempPath, content, { encoding: 'utf-8', mode: SECRET_FILE_MODE });
  } catch (err) {
    // Cleanup any partially-written temp before re-throwing.
    try {
      unlinkSync(tempPath);
    } catch {
      /* non-fatal */
    }
    throw err;
  }

  try {
    renameSync(tempPath, path);
  } catch (err) {
    try {
      unlinkSync(tempPath);
    } catch {
      /* non-fatal */
    }
    throw err;
  }

  // Defensive — POSIX rename preserves mode but Windows may have ignored
  // the temp's mode flag. chmod is cheap and idempotent.
  try {
    chmodSync(path, SECRET_FILE_MODE);
  } catch {
    /* non-fatal (e.g. Windows ACLs, NFS without chmod) */
  }
}

// ---------------------------------------------------------------------------
// Config flag resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a `boolean | undefined` config flag through the cascade.
 *
 * Treats anything other than the boolean `true` as `false` — defensive
 * against stray strings or null values that may have crept into older
 * config files.
 *
 * @internal
 */
async function resolveBooleanFlag(key: string): Promise<boolean> {
  try {
    const resolved = await getConfigValue<boolean | undefined>(key);
    return resolved.value === true;
  } catch {
    return false;
  }
}
