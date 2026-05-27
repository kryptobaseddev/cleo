/**
 * `claude-code` credential seeder — imports the Claude Code OAuth token
 * (`~/.claude/.credentials.json`) into the unified credential pool as an
 * `anthropic` entry.
 *
 * E-CONFIG-AUTH-UNIFY E2a §5.2 T-E2-3. Architectural mirror of Hermes
 * Agent's `_seed_from_singletons` dispatch (`agent/credential_pool.py`).
 *
 * ## Consent gate
 *
 * Reading the Claude Code credential file requires the operator to have
 * explicitly opted in via `auth.claudeCodeConsentGiven = true` in the
 * global config. This mirrors Hermes Agent's PR #4210 fix: without the
 * gate, auxiliary fallback chains could silently route requests through
 * a user's Claude Code OAuth token without consent. The default value is
 * `false`, so the seeder is a no-op on fresh installs.
 *
 * The gate is checked BEFORE any filesystem access: an unconsented seeder
 * never calls `readFileSync` on the credentials path. `isConsentEstablished`
 * reads the global config through `getConfigValue('auth.claudeCodeConsentGiven')`
 * so CLI/env overrides on the consent flag are respected uniformly.
 *
 * ## What the seeder emits
 *
 * One `SeederCredentialEntry` per call (or zero) with:
 *
 * - `provider: 'anthropic'`
 * - `label: 'claude-code'`
 * - `authType: 'oauth'`
 * - `source: 'claude-code'`
 * - `accessToken`, `refreshToken`, `expiresAt` extracted from
 *   `claudeAiOauth` via {@link parseClaudeCodeCredentials}.
 *
 * Zero-result paths (consent off, file missing, file unreadable, JSON
 * malformed, token expired) all return `{ entries: [] }` without
 * throwing. Parsing is delegated to `parseClaudeCodeCredentials` in
 * `@cleocode/contracts` so the JSON shape lives in exactly one place.
 *
 * @module llm/credential-seeders/claude-code-seeder
 * @task T9410
 * @epic E-CONFIG-AUTH-UNIFY (E2a)
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseClaudeCodeCredentials } from '@cleocode/contracts';
import { getConfigValue } from '../../config.js';
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
const SEEDER_LABEL = 'claude-code';

/** `(sourceId, provider)` pair this seeder owns inside the registry. */
const SOURCE_ID: SeederSourceId = 'claude-code';
const PROVIDER = 'anthropic';

/** Config key consulted by {@link isConsentEstablished}. */
const CONSENT_CONFIG_KEY = 'auth.claudeCodeConsentGiven';

// ---------------------------------------------------------------------------
// Seeder implementation
// ---------------------------------------------------------------------------

/**
 * Concrete `CredentialSeeder` for the `claude-code` source.
 *
 * Constructor-injectable filesystem hooks (`readCredentialFile`) keep tests
 * pure — they exercise the consent gate, expiry filter, and missing-file
 * path without touching the real `~/.claude/.credentials.json` and without
 * fs mocks at the module level. The default `readCredentialFile`
 * implementation calls `readFileSync` on `~/.claude/.credentials.json`.
 *
 * @task T9410
 */
export class ClaudeCodeSeeder implements CredentialSeeder {
  /** @inheritdoc */
  readonly sourceId: SeederSourceId = SOURCE_ID;
  /** @inheritdoc */
  readonly provider = PROVIDER;

  private readonly readCredentialFile: () => string | null;
  private readonly readConsentFlag: () => Promise<boolean>;

  /**
   * Construct a seeder.
   *
   * @param opts - Optional dependency-injection seams. `readCredentialFile`
   *   MUST return `null` when the file is missing or unreadable (it MUST
   *   NOT throw). `readConsentFlag` returns the resolved consent boolean
   *   from the config cascade.
   */
  constructor(opts?: {
    readCredentialFile?: () => string | null;
    readConsentFlag?: () => Promise<boolean>;
  }) {
    this.readCredentialFile = opts?.readCredentialFile ?? defaultReadCredentialFile;
    this.readConsentFlag = opts?.readConsentFlag ?? defaultReadConsentFlag;
  }

  /**
   * Resolve the consent flag from the canonical config cascade.
   *
   * Returns `true` only when `auth.claudeCodeConsentGiven` is explicitly
   * the boolean `true`. Any other value — `undefined`, `null`, `false`,
   * or a stray string — yields `false` so the gate fails closed.
   *
   * @param _provider - Provider id (ignored — this seeder is anthropic-only;
   *   the parameter is accepted to satisfy the `CredentialSeeder` contract).
   */
  async isConsentEstablished(_provider: string): Promise<boolean> {
    try {
      return await this.readConsentFlag();
    } catch {
      // Defensive: any failure resolving the flag → no consent.
      return false;
    }
  }

  /**
   * Read `~/.claude/.credentials.json` and emit a single pool entry.
   *
   * Short-circuits to `{ entries: [] }` when the consent gate is closed,
   * the file is absent, the JSON is malformed, the `claudeAiOauth` block
   * is missing, or the token has expired (per `parseClaudeCodeCredentials`).
   */
  async seed(): Promise<SeederResult> {
    // Consent gate — checked BEFORE any filesystem access so the absence
    // of consent is indistinguishable from the absence of the file from
    // the perspective of an observer.
    const consented = await this.isConsentEstablished(this.provider);
    if (!consented) {
      return { entries: [] };
    }

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
 * Returns the UTF-8 contents of `~/.claude/.credentials.json`, or `null`
 * when the file is absent or unreadable. NEVER throws — every error path
 * collapses to `null` so the seeder's "source absent" contract holds.
 *
 * @internal
 */
function defaultReadCredentialFile(): string | null {
  try {
    return readFileSync(join(homedir(), '.claude', '.credentials.json'), 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Default `readConsentFlag` implementation.
 *
 * Reads the consent boolean from the canonical config cascade (env >
 * project > global > defaults). The default value at the defaults tier
 * is `false`, so a fresh install with no overrides resolves to `false`.
 *
 * @internal
 */
async function defaultReadConsentFlag(): Promise<boolean> {
  const resolved = await getConfigValue<boolean | undefined>(CONSENT_CONFIG_KEY);
  return resolved.value === true;
}

/**
 * Factory for the singleton `ClaudeCodeSeeder` registered into
 * `BUILTIN_SEEDERS` from `index.ts`.
 *
 * Kept as a factory (not a module-level `const`) so the registry-side
 * import remains acyclic and tests can construct fresh instances with
 * injected dependencies.
 *
 * @task T9410
 */
export function createClaudeCodeSeeder(): ClaudeCodeSeeder {
  return new ClaudeCodeSeeder();
}
