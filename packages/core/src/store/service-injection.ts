/**
 * Service-credential injection at the harness tool boundary (T11940 · M2-W3).
 *
 * EP-UNIVERSAL-SERVICE-VAULT (epic T11765 · saga SG-VAULT-CORE T10409). The second
 * half of the injection seam: given an outbound HTTP request a harness tool is about
 * to make, resolve the matching service connection, refresh it if expired, and apply
 * the declarative {@link InjectionRule} model — materializing the secret ONLY at the
 * wire inside the sealed handle's `fetch()`.
 *
 * ## NO MITM proxy (AC4)
 *
 * The seam is the IN-PROCESS tool boundary — {@link injectServiceCredentials} is a
 * pure function over a {@link OutboundRequest} descriptor. There is NO CONNECT proxy,
 * no man-in-the-middle process, no port to bind: the harness calls this immediately
 * before it builds its `fetch()`, gets back the mutated headers/URL, and makes the
 * call itself. The function neither performs nor intercepts any network I/O.
 *
 * ## Trust-gated, refresh-first (AC2)
 *
 * Credential resolution delegates to {@link selfHealConnection} (the store's
 * resolve-path): it runs the trust gate FIRST (a denied agent gets `null` with NO
 * decrypt) and transparently REFRESHES a past-expiry token before sealing. Only on a
 * passing gate is a {@link SealedCredential} returned.
 *
 * ## Decrypt-only-at-wire + redaction (AC3)
 *
 * The credential is a {@link SealedCredential}: its `fetch()` is the SOLE decrypt
 * point and is invoked HERE, exactly once, when an injection rule needs the token —
 * the materialized plaintext is consumed in-place to build the header/param value and
 * NEVER bound to a returned field, logged, or serialized. The only credential-derived
 * string that crosses the diagnostic boundary is the non-secret
 * {@link SealedCredential.tokenPreview} ({@link InjectionDiagnostic.tokenPreview}).
 *
 * @module store/service-injection
 * @task T11940
 * @epic T11765
 * @saga T10409
 * @see ./service-host-matcher.ts — host/path → provider resolution (AC1)
 * @see ./service-oauth.ts — `selfHealConnection` (trust-gated, refresh-first sealed resolve)
 * @see ../llm/sealed-credential.ts — `makeSealedCredential` (the shared egress handle)
 */

import type { HostAuthStrategy, InjectionRule, SealedCredential } from '@cleocode/contracts';
import { matchServiceUrl, type ServiceHostMatch } from './service-host-matcher.js';
import {
  type SelfHealOptions,
  type ServiceOAuthDeps,
  selfHealConnection,
} from './service-oauth.js';

/**
 * The mutable outbound-request descriptor the injector reads and rewrites. The
 * harness builds this from the request it is about to make; after injection it
 * uses the (possibly rewritten) `url` + `headers` to call `fetch()`.
 */
export interface OutboundRequest {
  /** The absolute request URL (host + path drive provider matching). */
  readonly url: string;
  /** The request headers (case-insensitive on the wire; stored case-preserving). */
  readonly headers: Readonly<Record<string, string>>;
}

/** The header/URL mutations an injection produced (the rewritten request). */
export interface InjectedRequest {
  /** The (possibly rewritten) request URL — `set-param` rules add query params. */
  readonly url: string;
  /** The rewritten request headers with the credential injected. */
  readonly headers: Record<string, string>;
}

/** A NON-SECRET diagnostic describing what an injection did (safe to log). */
export interface InjectionDiagnostic {
  /** The matched provider key (e.g. `github`), or `null` when no provider matched. */
  readonly provider: string | null;
  /** The connection label that was injected, or `null` when none. */
  readonly label: string | null;
  /** The injection strategy applied, or `null` when no provider matched. */
  readonly strategy: HostAuthStrategy | null;
  /**
   * The NON-SECRET redacted token preview ({@link SealedCredential.tokenPreview}) —
   * the ONLY credential-derived string permitted to cross a logging/diagnostic
   * boundary (≤ last 4 chars). `null` when no credential was injected.
   */
  readonly tokenPreview: string | null;
  /** Whether a transparent refresh fired before injection. */
  readonly refreshed: boolean;
}

/** The result of {@link injectServiceCredentials}. */
export interface InjectionResult {
  /**
   * Whether a credential was injected. `false` when no provider claims the host, or
   * the agent's trust gate denied / the connection is missing-or-uncredentialed —
   * in which case `request` is the ORIGINAL request, untouched.
   */
  readonly injected: boolean;
  /** The (possibly rewritten) request — mutated only when {@link injected}. */
  readonly request: InjectedRequest;
  /** A non-secret diagnostic (safe to log). */
  readonly diagnostic: InjectionDiagnostic;
}

/** Parameters for {@link injectServiceCredentials}. */
export interface InjectServiceCredentialsParams {
  /** The agent making the outbound request (trust-gated). */
  readonly agentId: string;
  /** The outbound request descriptor to inject into. */
  readonly request: OutboundRequest;
  /**
   * The connection label to use for the matched provider (defaults to `'default'`).
   * A provider can have several labelled connections; the caller selects which.
   */
  readonly label?: string;
  /** Out-of-band manual-approval flag forwarded to the trust gate. */
  readonly approved?: boolean;
  /**
   * Seconds of pre-expiry headroom at which to refresh (forwarded to
   * {@link selfHealConnection}). Defaults to 0 (refresh only once past expiry).
   */
  readonly skewSeconds?: number;
}

/** The default connection label when the caller does not specify one. */
const DEFAULT_LABEL = 'default';

/**
 * Translate a host rule's {@link HostAuthStrategy} into the concrete
 * {@link InjectionRule} list applied for a matched request.
 *
 * This is the SSoT mapping strategy → injection actions:
 *  - `bearer` — `Authorization: Bearer <token>` (overwrite any existing auth).
 *  - `basic-x-access-token` — `Authorization: Basic base64("x-access-token:<token>")`
 *    (GitHub git-over-HTTPS).
 *  - `header` — the token goes via a named header rather than `Authorization`; the
 *    concrete header is provider-declared (`credentialHeaders`), so here we still
 *    set `Authorization: Bearer` as the safe default and let a provider that needs a
 *    custom header carry it via its `credentialHeaders` (a later breadth task wires
 *    those). All three strategies first strip a stale `Authorization` the tool may
 *    have emitted (`remove-header`) so the vault credential is authoritative.
 *
 * @param strategy - The matched host rule's injection strategy.
 * @returns The ordered injection actions.
 */
export function injectionRulesForStrategy(strategy: HostAuthStrategy): readonly InjectionRule[] {
  // Always strip any stale Authorization the tool emitted, then set the vault one.
  return [
    { kind: 'remove-header', name: 'Authorization' },
    { kind: 'set-header', name: 'Authorization', valueSource: 'token', framing: strategy },
  ];
}

/** Build the framed `Authorization` value for a token under a host strategy. */
function frameToken(token: string, framing: HostAuthStrategy | undefined): string {
  switch (framing) {
    case 'basic-x-access-token': {
      const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
      return `Basic ${basic}`;
    }
    default:
      // `bearer`, `header` (default), and an absent framing all bearer-frame.
      return `Bearer ${token}`;
  }
}

/** Find a header key case-insensitively; returns the existing key or `undefined`. */
function findHeaderKey(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return key;
  }
  return undefined;
}

/**
 * Apply one injection rule to a header bag + URL, materializing the token from the
 * sealed handle ONLY when a value-bearing rule needs it.
 *
 * The plaintext token (when materialized) lives ONLY as the local `token` binding
 * for the duration of this call and is consumed in-place into the header/param —
 * it is never returned, logged, or stored.
 */
function applyRule(
  rule: InjectionRule,
  headers: Record<string, string>,
  url: URL,
  token: string,
): void {
  switch (rule.kind) {
    case 'remove-header': {
      const existing = findHeaderKey(headers, rule.name);
      if (existing !== undefined) delete headers[existing];
      return;
    }
    case 'set-header': {
      const existing = findHeaderKey(headers, rule.name);
      const value = rule.valueSource === 'token' ? frameToken(token, rule.framing) : token;
      if (existing !== undefined) delete headers[existing];
      headers[rule.name] = value;
      return;
    }
    case 'replace-header': {
      const existing = findHeaderKey(headers, rule.name);
      if (existing === undefined) return; // only replace a present header
      headers[existing] = rule.valueSource === 'token' ? frameToken(token, rule.framing) : token;
      return;
    }
    case 'set-param': {
      url.searchParams.set(rule.name, token);
      return;
    }
  }
}

/** Whether the rule set contains any value-bearing rule (needs a materialized token). */
function needsToken(rules: readonly InjectionRule[]): boolean {
  return rules.some((r) => r.kind !== 'remove-header');
}

/**
 * Resolve + inject a service credential into an outbound request at the tool
 * boundary (T11940 · AC1–AC4).
 *
 * Flow:
 *  1. Match the request URL's host/path to a provider ({@link matchServiceUrl}).
 *     No match → return the original request untouched (`injected: false`).
 *  2. Resolve the connection via {@link selfHealConnection} — trust-gated +
 *     refresh-first. Denied / missing / uncredentialed → original request untouched.
 *  3. Materialize the token ONCE at the wire (`sealed.fetch()`) and apply the
 *     {@link injectionRulesForStrategy} rule list to a COPY of the headers + a
 *     parsed URL. The plaintext is consumed in-place; only the non-secret
 *     {@link SealedCredential.tokenPreview} reaches the diagnostic.
 *
 * @param params - The agent, request, label, and refresh knobs.
 * @param deps - Injectable OAuth/clock/vault deps (test seam; a fake vault proves
 *   injection + redaction without a real `cleo.db` or network).
 * @returns The {@link InjectionResult} — the (possibly rewritten) request + a
 *   non-secret diagnostic.
 * @task T11940
 */
export async function injectServiceCredentials(
  params: InjectServiceCredentialsParams,
  deps: ServiceOAuthDeps = {},
): Promise<InjectionResult> {
  const label = params.label ?? DEFAULT_LABEL;
  const originalRequest: InjectedRequest = {
    url: params.request.url,
    headers: { ...params.request.headers },
  };

  // 1. Match the host/path to a provider.
  const match: ServiceHostMatch | null = matchServiceUrl(params.request.url);
  if (match === null) {
    return {
      injected: false,
      request: originalRequest,
      diagnostic: {
        provider: null,
        label: null,
        strategy: null,
        tokenPreview: null,
        refreshed: false,
      },
    };
  }

  // 2. Resolve the connection — trust-gated + refresh-first (sealed on allow).
  const healOptions: SelfHealOptions = {
    agentId: params.agentId,
    provider: match.provider.provider,
    label,
    ...(params.approved !== undefined ? { approved: params.approved } : {}),
    ...(params.skewSeconds !== undefined ? { skewSeconds: params.skewSeconds } : {}),
  };
  const heal = await selfHealConnection(healOptions, deps);
  const sealed: SealedCredential | null = heal.sealed;
  if (sealed === null) {
    // Denied / missing / uncredentialed — leave the request untouched.
    return {
      injected: false,
      request: originalRequest,
      diagnostic: {
        provider: match.provider.provider,
        label,
        strategy: match.strategy,
        tokenPreview: null,
        refreshed: heal.refreshed,
      },
    };
  }

  // 3. Apply the strategy's injection rules. Materialize the token at the wire ONCE
  //    (the SOLE decrypt point) and consume it in-place; it never escapes this scope.
  const rules = injectionRulesForStrategy(match.strategy);
  const headers = { ...params.request.headers };
  const url = new URL(params.request.url);
  let token = '';
  if (needsToken(rules)) {
    const decrypted = await sealed.fetch();
    token = decrypted.value;
  }
  for (const rule of rules) {
    applyRule(rule, headers, url, token);
  }
  // The local `token` goes out of scope here — never returned or logged.

  return {
    injected: true,
    request: { url: url.toString(), headers },
    diagnostic: {
      provider: match.provider.provider,
      label,
      strategy: match.strategy,
      tokenPreview: sealed.tokenPreview,
      refreshed: heal.refreshed,
    },
  };
}
