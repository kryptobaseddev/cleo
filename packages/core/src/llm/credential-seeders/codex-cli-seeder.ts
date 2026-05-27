/**
 * Credential seeder for the OpenAI Codex CLI
 * (E-CONFIG-AUTH-UNIFY E2a / T9418).
 *
 * Implements the "delegate-to-partner-CLI" pattern: instead of CLEO running
 * its own OAuth flow against OpenAI, this seeder reads the token file the
 * Codex CLI already writes when the user runs `codex login`. The seeder is
 * read-only — it never writes back to Codex's auth.json, so the two CLIs
 * remain decoupled.
 *
 * ## File path
 *
 * `${CODEX_HOME:-~/.codex}/auth.json` per Hermes Agent's
 * `hermes_cli/codex_models.py:175`. The `CODEX_HOME` env var is honoured
 * exactly as Codex itself does (empty/whitespace falls back to `~/.codex`).
 *
 * ## File shape
 *
 * Codex `auth.json` carries either an API key, OAuth tokens, or both:
 *
 * ```json
 * {
 *   "OPENAI_API_KEY": "sk-...",          // optional — when user logged in via API key
 *   "tokens": {
 *     "access_token": "...",             // optional — when user logged in via OAuth
 *     "refresh_token": "...",
 *     "id_token": "...",
 *     "account_id": "..."
 *   }
 * }
 * ```
 *
 * This seeder reports both forms when present (one entry per source). Empty
 * tokens are skipped so a partially-written file does not seed a broken
 * credential into the pool.
 *
 * @module llm/credential-seeders/codex-cli-seeder
 * @task T9418
 * @epic E-CONFIG-AUTH-UNIFY (E2a)
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CredentialSeeder, SeederResult } from './index.js';

/**
 * Resolve the Codex CLI auth file path.
 *
 * Mirrors Codex's own logic: `CODEX_HOME` env var when set (trimmed),
 * falling back to `~/.codex/auth.json`. Exposed for tests so they can pin
 * the path to a temp dir without touching the real `~/.codex` directory.
 *
 * @internal
 * @task T9418
 */
export function getCodexAuthPath(): string {
  const codexHome = (process.env['CODEX_HOME'] ?? '').trim();
  const root = codexHome || join(homedir(), '.codex');
  return join(root, 'auth.json');
}

/**
 * Credential seeder for OpenAI Codex CLI.
 *
 * Returns one entry per credential present in `auth.json` (the API key and
 * the OAuth access token are reported separately so the resolver can rank
 * them via priority). Missing file or unreadable JSON → `{ entries: [] }`
 * with no error surfaced; the caller treats absence as "not on this
 * machine".
 *
 * @task T9418
 */
export class CodexCliSeeder implements CredentialSeeder {
  readonly sourceId = 'codex-cli' as const;
  readonly provider = 'openai';

  /**
   * Read and parse Codex's `auth.json`, returning the discovered entries.
   *
   * Never throws — every failure path resolves to `{ entries: [], warnings? }`.
   *
   * @returns Discovered credential entries plus optional diagnostics.
   * @task T9418
   */
  async seed(): Promise<SeederResult> {
    const authPath = getCodexAuthPath();
    if (!existsSync(authPath)) {
      return { entries: [] };
    }

    let raw: string;
    try {
      raw = readFileSync(authPath, 'utf-8');
    } catch (err) {
      return {
        entries: [],
        warnings: [`codex-cli: failed to read ${authPath}: ${(err as Error).message}`],
      };
    }

    let parsed: Record<string, unknown>;
    try {
      const json = JSON.parse(raw) as unknown;
      if (!json || typeof json !== 'object' || Array.isArray(json)) {
        return {
          entries: [],
          warnings: [`codex-cli: ${authPath} is not a JSON object`],
        };
      }
      parsed = json as Record<string, unknown>;
    } catch (err) {
      return {
        entries: [],
        warnings: [`codex-cli: ${authPath} is not valid JSON: ${(err as Error).message}`],
      };
    }

    const result: SeederResult = { entries: [] };

    // OAuth access token — reported FIRST so OAuth-preferring resolution
    // policies pick it ahead of a co-resident API key. The Codex CLI itself
    // prefers OAuth when both are present.
    const tokens = parsed['tokens'];
    if (tokens && typeof tokens === 'object' && !Array.isArray(tokens)) {
      const accessToken = (tokens as Record<string, unknown>)['access_token'];
      const refreshToken = (tokens as Record<string, unknown>)['refresh_token'];
      if (typeof accessToken === 'string' && accessToken.trim()) {
        result.entries.push({
          provider: 'openai',
          label: 'codex-cli',
          authType: 'oauth',
          accessToken: accessToken.trim(),
          source: 'codex-cli',
          ...(typeof refreshToken === 'string' && refreshToken.trim()
            ? { refreshToken: refreshToken.trim() }
            : {}),
        });
      }
    }

    // API key fallback path. Codex writes the key flat (not under `tokens`)
    // when the user provisioned via API key rather than OAuth.
    const apiKey = parsed['OPENAI_API_KEY'];
    if (typeof apiKey === 'string' && apiKey.trim()) {
      result.entries.push({
        provider: 'openai',
        label: 'codex-cli-api-key',
        authType: 'api_key',
        accessToken: apiKey.trim(),
        source: 'codex-cli',
      });
    }

    return result;
  }
}

/**
 * Module-level singleton. Registered into `BUILTIN_SEEDERS` from
 * `credential-seeders/index.ts` to keep the registration site DRY.
 *
 * @task T9418
 */
export const codexCliSeeder: CredentialSeeder = new CodexCliSeeder();
