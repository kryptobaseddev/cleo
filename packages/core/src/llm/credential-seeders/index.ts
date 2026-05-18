/**
 * Credential seeder type-system foundation for the unified credential pool
 * (E-CONFIG-AUTH-UNIFY E2a / T9408).
 *
 * This module defines the contract every concrete credential seeder must
 * implement. A seeder is the architectural mirror of Hermes Agent's
 * `_seed_from_*` dispatch (see `agent/credential_pool.py:1169`): each seeder
 * pulls credentials from a single discrete source (environment variables,
 * `~/.claude/.credentials.json`, a CLEO-issued PKCE token, the GitHub CLI,
 * etc.) and returns one or more candidate `StoredCredential` entries that
 * the resolver can route into the pool.
 *
 * ## Scope of this task
 *
 * T9408 is **type-system only**. No concrete seeders are registered, no
 * production resolver path consumes a seeder, and `resolveCredentials()`
 * still walks the legacy 6-tier ladder. T9409 onward registers concrete
 * seeders into `BUILTIN_SEEDERS`; T9413 wires the pool into the async
 * resolve path.
 *
 * ## Canonical entry shape
 *
 * Seeders emit `StoredCredential` records minus the persistence-assigned
 * `priority` (which the store derives on upsert via `addCredential`). The
 * `SeederCredentialEntry` alias re-uses `addCredential`'s input shape so
 * there is exactly one canonical pre-persist credential definition across
 * the entire LLM layer — no inlined or mocked types.
 *
 * @module llm/credential-seeders
 * @task T9408
 * @epic E-CONFIG-AUTH-UNIFY (E2a)
 */

import type { StoredCredential } from '../credentials-store.js';
import { createClaudeCodeSeeder } from './claude-code-seeder.js';
import { createCleoPkceSeeder } from './cleo-pkce-seeder.js';
import { codexCliSeeder } from './codex-cli-seeder.js';
import { geminiCliSeeder } from './gemini-cli-seeder.js';
// ghCliSeeder is NOT imported here for registration (T9594 — removed from BUILTIN_SEEDERS);
// it is still re-exported below for consumers that want to construct it directly.

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Stable identifier tagging the upstream source a seeder represents.
 *
 * Each value names exactly one discovery path. Resolver telemetry, dedup
 * keys, and warnings all reference this id, so it MUST remain stable across
 * releases — adding a new source requires extending this union (and the
 * resolver's dispatch table downstream).
 *
 * - `env`         — `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/etc. environment vars.
 * - `claude-code` — `~/.claude/.credentials.json` consented import.
 * - `cleo-pkce`   — credential issued by `cleo llm login` (PKCE flow).
 * - `codex-cli`   — OpenAI Codex CLI session token.
 * - `gemini-cli`  — Google Gemini CLI application default credentials.
 * - `gh-cli`      — GitHub CLI token (for `github-models` provider).
 * - `manual`      — operator-added entry via `cleo llm add` or store edit.
 *
 * @task T9408
 */
export type SeederSourceId =
  | 'env'
  | 'claude-code'
  | 'cleo-pkce'
  | 'codex-cli'
  | 'gemini-cli'
  | 'gh-cli'
  | 'manual';

/**
 * Canonical pre-persist credential entry shape emitted by seeders.
 *
 * Identical to `addCredential`'s input contract: every field of
 * `StoredCredential` except `priority`, which is assigned by the store on
 * upsert. Seeders MAY supply a `priority` hint; if absent, the store's
 * `max + 10` rule applies.
 *
 * This alias intentionally pulls from `credentials-store.ts` so seeders and
 * the persisted store share one type. Do NOT redeclare credential fields in
 * seeder code.
 *
 * @task T9408
 */
export type SeederCredentialEntry = Omit<StoredCredential, 'priority'> & {
  priority?: number;
};

/**
 * Return value from `CredentialSeeder.seed()`.
 *
 * A seeder MAY produce zero entries (e.g. when the upstream source is
 * absent on this machine) without raising — empty `entries` is the normal
 * "nothing to seed" signal. `warnings` carries human-readable diagnostics
 * the resolver surfaces in `--verbose` mode (e.g. "claude-code consent file
 * exists but is unreadable").
 *
 * @task T9408
 */
export interface SeederResult {
  /** Zero or more candidate credential entries discovered by the seeder. */
  entries: SeederCredentialEntry[];
  /** Optional non-fatal diagnostics shown to operators in verbose flows. */
  warnings?: string[];
}

/**
 * Contract every concrete credential seeder implements.
 *
 * One seeder instance handles exactly one `(sourceId, provider)` pair —
 * e.g. the env seeder for `'anthropic'` is a different instance than the
 * env seeder for `'openai'`. This keeps `seed()` focused and lets the
 * registry's `getByProvider` filter cleanly.
 *
 * ## Consent gate
 *
 * Seeders that import credentials from third-party tooling (e.g. the
 * `'claude-code'` seeder reading `~/.claude/.credentials.json`) MUST gate
 * their `seed()` behind `isConsentEstablished()`. The resolver checks the
 * gate before invoking `seed()`; an unconsented seeder returns
 * `{ entries: [] }` without surfacing the source's secret state.
 *
 * Seeders that read first-party files (env, cleo-pkce, manual) MAY omit
 * the consent gate — the constructor-implied consent applies.
 *
 * @task T9408
 */
export interface CredentialSeeder {
  /** Tag identifying the upstream source this seeder represents. */
  readonly sourceId: SeederSourceId;
  /** Provider this seeder produces credentials for (e.g. `'anthropic'`). */
  readonly provider: string;
  /**
   * Discover credentials from the upstream source.
   *
   * MUST NOT mutate the credential store; the resolver is responsible for
   * persisting the returned entries. MUST NOT throw on "source absent" —
   * return `{ entries: [] }` instead. MAY throw on programmer-error
   * conditions (e.g. mis-configured constructor argument).
   *
   * @returns Discovered entries plus optional warnings.
   */
  seed(): Promise<SeederResult>;
  /**
   * Optional consent gate for third-party sources.
   *
   * Returning `false` (or a `Promise<false>`) instructs the resolver to
   * skip `seed()` entirely. Omitting the method is equivalent to always
   * returning `true`.
   *
   * @param provider - Provider the resolver is currently resolving for;
   *   passed so a single seeder implementation can gate per-provider when
   *   needed (the `'claude-code'` seeder, for example, may be consented
   *   for `'anthropic'` but not for other transports).
   */
  isConsentEstablished?(provider: string): boolean | Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * In-process registry of `CredentialSeeder` instances.
 *
 * Uniqueness rule: the `(sourceId, provider)` pair MUST be unique within a
 * single registry. A duplicate `register()` call throws synchronously —
 * silent overwrites would mask programmer-error and let two seeders fight
 * over the same source.
 *
 * The registry intentionally provides no removal primitive: the
 * `BUILTIN_SEEDERS` singleton is populated at module load by future tasks
 * (T9409+) and is not meant to mutate during a CLI run. Tests construct a
 * fresh `SeederRegistry()` to exercise registration semantics in isolation.
 *
 * @task T9408
 */
export class SeederRegistry {
  /**
   * Map keyed on `${sourceId}::${provider}` for O(1) duplicate detection.
   * Values are the registered seeder instances; iteration order is
   * insertion order (`Map` semantics) so `getAll()` is stable.
   */
  private readonly entries = new Map<string, CredentialSeeder>();

  /**
   * Register a seeder.
   *
   * @param seeder - Seeder instance to add.
   * @throws {Error} `E_SEEDER_DUPLICATE` when the `(sourceId, provider)`
   *   pair is already registered.
   *
   * @task T9408
   */
  register(seeder: CredentialSeeder): void {
    const key = SeederRegistry.makeKey(seeder.sourceId, seeder.provider);
    if (this.entries.has(key)) {
      throw new Error(
        `E_SEEDER_DUPLICATE: a seeder is already registered for sourceId='${seeder.sourceId}' provider='${seeder.provider}'`,
      );
    }
    this.entries.set(key, seeder);
  }

  /**
   * Return every registered seeder in insertion order.
   *
   * @returns Read-only view of the registry's seeders.
   *
   * @task T9408
   */
  getAll(): readonly CredentialSeeder[] {
    return Array.from(this.entries.values());
  }

  /**
   * Return every seeder whose `provider` matches the argument.
   *
   * Order matches `getAll()` (insertion order). Returns an empty array when
   * no seeder is registered for the provider.
   *
   * @param provider - Provider id to filter by (e.g. `'anthropic'`).
   * @returns Read-only filtered array.
   *
   * @task T9408
   */
  getByProvider(provider: string): readonly CredentialSeeder[] {
    return this.getAll().filter((s) => s.provider === provider);
  }

  /**
   * Compose the internal uniqueness key for a `(sourceId, provider)` pair.
   *
   * Exposed as `static` so tests and (future) resolver code can assert
   * collision behaviour without coupling to the literal separator.
   *
   * @internal
   */
  static makeKey(sourceId: SeederSourceId, provider: string): string {
    return `${sourceId}::${provider}`;
  }
}

// ---------------------------------------------------------------------------
// Module-state singleton
// ---------------------------------------------------------------------------

/**
 * Process-wide singleton registry used by the resolver.
 *
 * Concrete seeder instances are auto-registered into this registry at
 * module load via the registration block below + the `./register.ts`
 * barrel which aggregates side-effect imports (T9409+). As of this merge
 * the registry contains:
 *
 * - env seeders for every provider in ENV_VARS (T9409)
 * - `claude-code` × `anthropic` (T9410)
 * - `cleo-pkce` × `anthropic` (T9411)
 * - `codex-cli`, `gemini-cli` external seeders (T9418)
 * - `gh-cli` seeder is present but NOT registered (T9594 — GitHub PAT cannot auth OpenAI)
 *
 * The singleton is a module-scoped constant (`export const`) rather than a
 * class static so re-importing this module from different entry points
 * yields the same instance under Node ESM's module cache. Tests that need
 * isolation MUST construct a fresh `new SeederRegistry()` instead of
 * mutating `BUILTIN_SEEDERS`.
 *
 * @task T9408 (foundation)
 * @task T9410 (claude-code seeder)
 * @task T9411 (cleo-pkce seeder)
 * @task T9418 (codex-cli, gemini-cli, gh-cli)
 */
export const BUILTIN_SEEDERS: SeederRegistry = new SeederRegistry();

// ---------------------------------------------------------------------------
// Auto-registration of concrete seeders (T9410, T9418)
// ---------------------------------------------------------------------------
//
// Concrete seeders import `CredentialSeeder` as a TYPE only from this
// module, so the value-level import here does not create a runtime cycle.
// Registration happens AFTER `BUILTIN_SEEDERS` is declared above so the
// registry is fully initialized when `register()` is called.
//
// To disable a built-in seeder during tests, do NOT mutate this list —
// construct a fresh `new SeederRegistry()` instead (the contract documented
// on `BUILTIN_SEEDERS`).

export { ClaudeCodeSeeder, createClaudeCodeSeeder } from './claude-code-seeder.js';
export { CleoPkceSeeder, createCleoPkceSeeder } from './cleo-pkce-seeder.js';
export { codexCliSeeder } from './codex-cli-seeder.js';
export { geminiCliSeeder } from './gemini-cli-seeder.js';
export { ghCliSeeder } from './gh-cli-seeder.js';

BUILTIN_SEEDERS.register(createClaudeCodeSeeder());
BUILTIN_SEEDERS.register(createCleoPkceSeeder());
BUILTIN_SEEDERS.register(codexCliSeeder);
BUILTIN_SEEDERS.register(geminiCliSeeder);
// gh-cli seeder is intentionally NOT registered here (T9594).
// `gh auth token` returns a GitHub PAT (ghp_*/gho_*) that cannot authenticate
// against api.openai.com.  The seeder is kept in tree for the future
// github-models provider — re-enable once that transport exists.
// See: packages/core/src/llm/credential-seeders/gh-cli-seeder.ts
