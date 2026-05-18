/**
 * `@cleocode/core/status` — `CleoStatus` snapshot aggregator (T-E3-4).
 *
 * Implements the data layer for `cleo status`: aggregates identity,
 * credentials, config-tier state, session, harness, and sentient-daemon
 * state into a single typed envelope without performing any network calls
 * or credential seeding. Read-only; safe to invoke on every CLI tick.
 *
 * Spec: `docs/plans/E-CONFIG-AUTH-UNIFY.md` §3.3.6 (`CleoStatus` interface)
 * and §5.3 T-E3-4 (acceptance criteria).
 *
 * Performance contract: `getCleoStatus()` MUST complete in under 2 seconds
 * on a populated project. Each sub-block guards its dependency with a
 * try/catch fall-through so a misconfigured subsystem never blocks the
 * status surface — failures degrade to a sensible default instead.
 *
 * @epic T9402 (E-CONFIG-AUTH-UNIFY E3)
 * @task T9423 (T-E3-4)
 */

import { existsSync } from 'node:fs';
import { getCleoIdentityPath } from '../identity/cleo-identity.js';
import { getCredentialPool } from '../llm/credential-pool.js';
import type { SeederSourceId } from '../llm/credential-seeders/index.js';
import type { StoredAuthType, StoredCredential } from '../llm/credentials-store.js';
import type { ModelTransport } from '../llm/types-config.js';
import { getConfigPath, getGlobalConfigPath, getProjectRoot } from '../paths.js';
import { getDaemonStatus } from '../sentient/daemon-api.js';
import { sessionStatus } from '../sessions/index.js';
import { readJson } from '../store/json.js';

// ---------------------------------------------------------------------------
// Public interfaces (spec §3.3.6)
// ---------------------------------------------------------------------------

/**
 * Per-credential row in the {@link CleoStatus.credentials} array.
 *
 * Derived from `StoredCredential`: `source` is narrowed to the seeder-source
 * union (defaults to `'none'` when a credential pre-dates the seeder tagging
 * introduced in T9408); `isExpired` is computed against `expiresAt`.
 *
 * @task T9423
 */
export interface CredentialStatusEntry {
  /** LLM transport the credential authenticates. */
  provider: ModelTransport;
  /** Seeder source that produced the entry, or `'none'` when unknown. */
  source: SeederSourceId | 'none';
  /** Always `true` when emitted by {@link getCleoStatus} — kept for forward-compat with future "expected provider but no credential" rows. */
  hasCredential: boolean;
  /** Storage-level auth scheme. */
  authType?: StoredAuthType;
  /** Unix epoch ms expiry; `null` or `undefined` when not bound to a TTL. */
  expiresAt?: number | null;
  /** `true` when `expiresAt` is set and has elapsed at status-snapshot time. */
  isExpired?: boolean;
  /** Status of last request through this credential, when observed. */
  lastStatus?: 'ok' | 'exhausted' | 'invalid';
  /** Human-readable identifier; unique within `provider`. */
  label?: string;
}

/**
 * Full status envelope returned by {@link getCleoStatus}.
 *
 * @task T9423
 */
export interface CleoStatus {
  /** Agent-identity block — `agentId`/`identityFile` are `null` until the operator binds an identity. */
  identity: {
    agentId: string | null;
    loggedIn: boolean;
    identityFile: string | null;
  };
  /** Credential-pool snapshot — every entry currently persisted, regardless of provider. */
  credentials: CredentialStatusEntry[];
  /** Config-tier paths and footgun warnings (secrets-in-project-config). */
  config: {
    globalConfigPath: string;
    projectConfigPath: string | null;
    activeConfigPath: string;
    hasSecretsInProjectConfig: boolean;
    secretsWarnings: string[];
  };
  /** Active session, if any. */
  session: {
    active: boolean;
    sessionId: string | null;
    focusedTask: string | null;
  };
  /** Detected harness; `'unknown'` when `CLEO_HARNESS` is not set. */
  harness: {
    active: 'pi' | 'claude-code' | 'unknown';
    healthy: boolean;
    issues: string[];
  };
  /** Sentient-daemon snapshot. */
  daemon: {
    running: boolean;
    pid: number | null;
    lastTickAt: number | null;
    killSwitchActive: boolean;
  };
}

// ---------------------------------------------------------------------------
// Internal helpers — one per status block
// ---------------------------------------------------------------------------

/**
 * Whether the given seeder string is a known {@link SeederSourceId}.
 *
 * Used to narrow free-form `StoredCredential.source` values into the typed
 * union exposed on {@link CredentialStatusEntry.source}.
 *
 * @internal
 */
const KNOWN_SEEDER_SOURCES: readonly SeederSourceId[] = [
  'env',
  'claude-code',
  'cleo-pkce',
  'codex-cli',
  'gemini-cli',
  'gh-cli',
  'manual',
  'cli-input',
];

function narrowSeederSource(raw: string | undefined): SeederSourceId | 'none' {
  if (raw === undefined) return 'none';
  return KNOWN_SEEDER_SOURCES.includes(raw as SeederSourceId) ? (raw as SeederSourceId) : 'none';
}

/**
 * Recursively walk a project-config tree looking for any
 * `llm.providers.<name>.apiKey` leaf with a non-empty string value.
 *
 * Returns one warning per offending provider; an empty array when the
 * config is clean or absent.
 *
 * @internal
 */
function scanForProjectSecrets(projectConfig: unknown): string[] {
  const warnings: string[] = [];
  if (typeof projectConfig !== 'object' || projectConfig === null) return warnings;

  const llm = (projectConfig as Record<string, unknown>)['llm'];
  if (typeof llm !== 'object' || llm === null) return warnings;

  const providers = (llm as Record<string, unknown>)['providers'];
  if (typeof providers !== 'object' || providers === null) return warnings;

  for (const [provider, value] of Object.entries(providers as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const apiKey = (value as Record<string, unknown>)['apiKey'];
    if (typeof apiKey === 'string' && apiKey.length > 0) {
      warnings.push(
        `llm.providers.${provider}.apiKey is set in project config — move it to the credential pool with \`cleo auth migrate-project-secrets\`.`,
      );
    }
  }

  return warnings;
}

/**
 * Detect the active harness from the `CLEO_HARNESS` env var.
 *
 * Accepts `'pi'` and `'claude-code'`; anything else (including unset) resolves
 * to `'unknown'`. Harness health is reported as `true` with no issues — the
 * deep harness probe lives in `cleoos doctor` and is intentionally out of
 * scope for the status surface.
 *
 * @internal
 */
function detectHarness(): CleoStatus['harness'] {
  const raw = process.env['CLEO_HARNESS'];
  const active: CleoStatus['harness']['active'] =
    raw === 'pi' || raw === 'claude-code' ? raw : 'unknown';
  return { active, healthy: true, issues: [] };
}

/**
 * Map an ISO-8601 timestamp string to epoch ms; `null` on absent/invalid.
 *
 * @internal
 */
function isoToEpoch(iso: string | null): number | null {
  if (iso === null) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * Build the {@link CleoStatus.identity} block.
 *
 * Resolution order:
 *
 * 1. `agentId` is read from the global config — looks for a top-level
 *    `agentId` string or a nested `identity.agentId` string.
 * 2. `identityFile` resolves to {@link getCleoIdentityPath} only when the
 *    file exists on disk — the path is `null` otherwise so callers do not
 *    surface a phantom-binding hint.
 * 3. `loggedIn` is `true` when EITHER `agentId` OR `identityFile` is non-null.
 *
 * @internal
 */
async function buildIdentityBlock(projectRoot: string): Promise<CleoStatus['identity']> {
  let agentId: string | null = null;
  try {
    const global = await readJson<Record<string, unknown>>(getGlobalConfigPath());
    if (global !== null) {
      const top = global['agentId'];
      if (typeof top === 'string' && top.length > 0) {
        agentId = top;
      } else {
        const identity = global['identity'];
        if (typeof identity === 'object' && identity !== null) {
          const nested = (identity as Record<string, unknown>)['agentId'];
          if (typeof nested === 'string' && nested.length > 0) {
            agentId = nested;
          }
        }
      }
    }
  } catch {
    // Best-effort: a corrupt global config must not break `cleo status`.
  }

  let identityFile: string | null = null;
  try {
    const path = getCleoIdentityPath(projectRoot);
    if (existsSync(path)) identityFile = path;
  } catch {
    /* identity path resolution never throws in practice; defensive */
  }

  return {
    agentId,
    loggedIn: agentId !== null || identityFile !== null,
    identityFile,
  };
}

/**
 * Map a {@link StoredCredential} to its {@link CredentialStatusEntry}.
 *
 * @internal
 */
function mapCredentialEntry(c: StoredCredential, now: number): CredentialStatusEntry {
  const entry: CredentialStatusEntry = {
    provider: c.provider,
    source: narrowSeederSource(c.source),
    hasCredential: true,
    authType: c.authType,
    label: c.label,
  };
  if (c.expiresAt !== undefined) {
    entry.expiresAt = c.expiresAt;
    entry.isExpired = typeof c.expiresAt === 'number' && c.expiresAt > 0 && c.expiresAt <= now;
  }
  if (c.lastStatus !== undefined) {
    entry.lastStatus = c.lastStatus;
  }
  return entry;
}

/**
 * Build the {@link CleoStatus.credentials} block by reading the unified
 * credential pool. Uses `list()` (NOT `pick()`) so no seeding side-effects
 * fire — the status surface is pure-read by contract.
 *
 * Returns an empty array if the pool throws (e.g. permissions-denied on the
 * store file) so a broken store never blocks the rest of the snapshot.
 *
 * @internal
 */
async function buildCredentialsBlock(): Promise<CredentialStatusEntry[]> {
  try {
    const entries = await getCredentialPool().list();
    const now = Date.now();
    return entries.map((c) => mapCredentialEntry(c, now));
  } catch {
    return [];
  }
}

/**
 * Build the {@link CleoStatus.config} block.
 *
 * `globalConfigPath` is always reported (whether the file exists or not).
 * `projectConfigPath` is `null` when no project-tier file is present.
 * `activeConfigPath` mirrors the resolution priority used by `loadConfig`:
 * project config wins when present, otherwise global.
 *
 * `hasSecretsInProjectConfig` and `secretsWarnings` are computed by scanning
 * the project config (if any) for `llm.providers.*.apiKey` leaves —
 * surfacing the Phase 2 footgun even before the user runs `cleo auth
 * migrate-project-secrets`.
 *
 * @internal
 */
async function buildConfigBlock(projectRoot: string): Promise<CleoStatus['config']> {
  const globalConfigPath = getGlobalConfigPath();
  const projectPath = getConfigPath(projectRoot);
  const projectConfigPath = existsSync(projectPath) ? projectPath : null;
  const activeConfigPath = projectConfigPath ?? globalConfigPath;

  let secretsWarnings: string[] = [];
  if (projectConfigPath !== null) {
    try {
      const projectConfig = await readJson<Record<string, unknown>>(projectConfigPath);
      secretsWarnings = scanForProjectSecrets(projectConfig);
    } catch {
      /* Unparseable project config is the project-config-validator's problem. */
    }
  }

  return {
    globalConfigPath,
    projectConfigPath,
    activeConfigPath,
    hasSecretsInProjectConfig: secretsWarnings.length > 0,
    secretsWarnings,
  };
}

/**
 * Build the {@link CleoStatus.session} block from the existing session
 * subsystem. Returns an inactive snapshot when no active session is on file
 * or the session store cannot be opened.
 *
 * @internal
 */
async function buildSessionBlock(projectRoot: string): Promise<CleoStatus['session']> {
  try {
    const active = await sessionStatus(projectRoot, {});
    if (active === null) {
      return { active: false, sessionId: null, focusedTask: null };
    }
    return {
      active: true,
      sessionId: active.id,
      focusedTask: active.taskWork?.taskId ?? null,
    };
  } catch {
    return { active: false, sessionId: null, focusedTask: null };
  }
}

/**
 * Build the {@link CleoStatus.daemon} block from the sentient daemon API.
 * `lastTickAt` is normalised from the daemon's ISO-8601 timestamp to epoch
 * ms per the spec interface (§3.3.6). `killSwitchActive` reflects the
 * persisted kill-switch state — independent of whether a process is alive.
 *
 * @internal
 */
async function buildDaemonBlock(projectRoot: string): Promise<CleoStatus['daemon']> {
  try {
    const status = await getDaemonStatus(projectRoot);
    return {
      running: status.running,
      pid: status.pid,
      lastTickAt: isoToEpoch(status.sentient.lastTickAt),
      killSwitchActive: status.sentient.killSwitch === true,
    };
  } catch {
    return { running: false, pid: null, lastTickAt: null, killSwitchActive: false };
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Aggregate the full {@link CleoStatus} snapshot.
 *
 * Reads identity, credentials, config-tier state, session, harness, and
 * sentient-daemon state in parallel and folds them into one envelope. No
 * network calls; no credential seeding (the pool's `list()` is pure-read).
 * Sub-blocks degrade independently — a broken session store does not
 * suppress the credentials block, etc.
 *
 * Performance contract (T-E3-4): completes in under 2 seconds on a
 * populated project.
 *
 * @example
 * ```ts
 * import { getCleoStatus } from '@cleocode/core/status';
 *
 * const snapshot = await getCleoStatus();
 * if (!snapshot.identity.loggedIn) {
 *   console.warn('No CLEO identity bound — run `cleo setup`.');
 * }
 * if (snapshot.config.hasSecretsInProjectConfig) {
 *   for (const w of snapshot.config.secretsWarnings) console.warn(w);
 * }
 * ```
 *
 * @returns Fully-populated {@link CleoStatus} envelope.
 *
 * @task T9423
 */
export async function getCleoStatus(): Promise<CleoStatus> {
  const projectRoot = getProjectRoot();

  const [identity, credentials, config, session, daemon] = await Promise.all([
    buildIdentityBlock(projectRoot),
    buildCredentialsBlock(),
    buildConfigBlock(projectRoot),
    buildSessionBlock(projectRoot),
    buildDaemonBlock(projectRoot),
  ]);

  return {
    identity,
    credentials,
    config,
    session,
    harness: detectHarness(),
    daemon,
  };
}
