/**
 * `cleo-pkce` credential seeder — reads CLEO's own PKCE-issued Anthropic
 * OAuth token at `${getCleoHome()}/anthropic-oauth.json` and emits it as a
 * single `anthropic` entry in the unified credential pool.
 *
 * E-CONFIG-AUTH-UNIFY E2a §5.2 T-E2-4. Architectural mirror of Hermes
 * Agent's `_seed_from_cleo_pkce` dispatch.
 *
 * ## File shape
 *
 * The CLEO-owned PKCE file uses Claude Code's `claudeAiOauth` envelope
 * shape so the two CLIs can cooperatively share credentials via the
 * write-back handler (`credential-writeback.ts`):
 *
 * ```json
 * {
 *   "claudeAiOauth": {
 *     "accessToken": "sk-ant-oat-...",
 *     "refreshToken": "sk-ant-ort-...",
 *     "expiresAt": 1700000000000,
 *     "scopes": ["user:inference"]
 *   }
 * }
 * ```
 *
 * Parsing is delegated to `parseClaudeCodeCredentials()` in
 * `@cleocode/contracts` so the on-disk format lives in exactly one place.
 *
 * ## Consent gate
 *
 * Unlike the `claude-code` seeder, the PKCE seeder reads a CLEO-owned
 * file: the operator implicitly consented by running `cleo llm login`,
 * so no consent flag is consulted. `isConsentEstablished` is therefore
 * omitted (`undefined` is treated as "always consented" by the contract).
 *
 * ## Zero-result paths
 *
 * Missing file, malformed JSON, missing `claudeAiOauth` block, and
 * expired token all collapse to `{ entries: [] }` without throwing —
 * the seeder contract MUST NOT signal "source absent" via exceptions.
 *
 * @module llm/credential-seeders/cleo-pkce-seeder
 * @task T9411
 * @epic E-CONFIG-AUTH-UNIFY (E2a)
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseClaudeCodeCredentials } from '@cleocode/contracts';
import { getCleoHome } from '../../paths.js';
import type {
  CredentialSeeder,
  SeederCredentialEntry,
  SeederResult,
  SeederSourceId,
} from './index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Stable label written into the pool entry's `label` field. */
const SEEDER_LABEL = 'cleo-pkce';

/** `(sourceId, provider)` pair this seeder owns inside the registry. */
const SOURCE_ID: SeederSourceId = 'cleo-pkce';
const PROVIDER = 'anthropic';

/**
 * Default on-disk path for CLEO's PKCE token cache.
 *
 * Computed at call-time (not module-load) so test runners that swap
 * `CLEO_DATA_DIR` between cases observe the change.
 */
function defaultCleoPkcePath(): string {
  return join(getCleoHome(), 'anthropic-oauth.json');
}

// ---------------------------------------------------------------------------
// Seeder implementation
// ---------------------------------------------------------------------------

/**
 * Concrete `CredentialSeeder` for the `cleo-pkce` source.
 *
 * Constructor-injectable filesystem hook (`readCredentialFile`) keeps tests
 * pure — they exercise the expiry, missing-file, and malformed-JSON paths
 * without touching the real CLEO data directory and without module-level
 * fs mocks. The default `readCredentialFile` implementation calls
 * `readFileSync` on `${getCleoHome()}/anthropic-oauth.json`.
 *
 * @task T9411
 */
export class CleoPkceSeeder implements CredentialSeeder {
  /** @inheritdoc */
  readonly sourceId: SeederSourceId = SOURCE_ID;
  /** @inheritdoc */
  readonly provider = PROVIDER;

  private readonly readCredentialFile: () => string | null;

  /**
   * Construct a seeder.
   *
   * @param opts - Optional dependency-injection seams. `readCredentialFile`
   *   MUST return `null` when the file is missing or unreadable (it MUST
   *   NOT throw). The default implementation reads
   *   `${getCleoHome()}/anthropic-oauth.json` and collapses every error
   *   path to `null`.
   */
  constructor(opts?: { readCredentialFile?: () => string | null }) {
    this.readCredentialFile = opts?.readCredentialFile ?? defaultReadCredentialFile;
  }

  /**
   * Read the CLEO PKCE OAuth file and emit a single anthropic pool entry.
   *
   * Short-circuits to `{ entries: [] }` when the file is absent, the JSON
   * is malformed, the `claudeAiOauth` block is missing, or the token has
   * expired (per `parseClaudeCodeCredentials`). Never throws.
   */
  async seed(): Promise<SeederResult> {
    const raw = this.readCredentialFile();
    if (raw === null) {
      return { entries: [] };
    }

    const parsed = parseClaudeCodeCredentials(raw);
    if (parsed === null) {
      // Malformed JSON, missing oauth block, or expired token.
      return { entries: [] };
    }

    const entry: SeederCredentialEntry = {
      provider: 'anthropic',
      label: SEEDER_LABEL,
      authType: 'oauth',
      accessToken: parsed.accessToken,
      source: SEEDER_LABEL,
      ...(parsed.expiresAt !== undefined ? { expiresAt: parsed.expiresAt } : {}),
      ...(parsed.refreshToken !== undefined ? { refreshToken: parsed.refreshToken } : {}),
    };

    return { entries: [entry] };
  }
}

// ---------------------------------------------------------------------------
// Default dependency-injection implementations
// ---------------------------------------------------------------------------

/**
 * Default `readCredentialFile` implementation.
 *
 * Returns the UTF-8 contents of `${getCleoHome()}/anthropic-oauth.json`,
 * or `null` when the file is absent or unreadable. NEVER throws — every
 * error path collapses to `null` so the seeder's "source absent" contract
 * holds.
 *
 * @internal
 */
function defaultReadCredentialFile(): string | null {
  try {
    return readFileSync(defaultCleoPkcePath(), 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Factory for the singleton `CleoPkceSeeder` registered into
 * `BUILTIN_SEEDERS` from `index.ts`.
 *
 * Kept as a factory (not a module-level `const`) so the registry-side
 * import remains acyclic and tests can construct fresh instances with
 * injected dependencies.
 *
 * @task T9411
 */
export function createCleoPkceSeeder(): CleoPkceSeeder {
  return new CleoPkceSeeder();
}
