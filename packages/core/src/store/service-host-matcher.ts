/**
 * Service host/path → provider matcher (T11940 · M2-W3 · AC1).
 *
 * EP-UNIVERSAL-SERVICE-VAULT (epic T11765 · saga SG-VAULT-CORE T10409). The first
 * half of the injection-at-tool-boundary seam: given the host (and optional path)
 * of an outbound request a harness tool is about to make, resolve which
 * {@link ServiceProviderDef} (and therefore which `service_connections` provider)
 * the request's host belongs to, plus the matching {@link ServiceHostRule} that
 * declares HOW the credential is injected (the {@link HostAuthStrategy}).
 *
 * Pure, side-effect-free, decrypt-free: it consults ONLY the declarative
 * {@link SERVICE_PROVIDERS} registry (frozen DATA in `@cleocode/contracts`). It
 * never opens a DB, never decrypts, never touches the network — so it is NOT a DB
 * chokepoint concern (Gate 3) and carries no credential material.
 *
 * ## Matching model (mirrors onecli `apps.rs::match_host`)
 *
 * `host` matches EXACTLY against `ServiceHostRule.host`, with one well-defined
 * suffix case: a rule host beginning with `.` (or a registry host that is a bare
 * apex like `amazonaws.com`) matches any sub-domain suffix — used for wildcard
 * families like AWS. `pathPrefix`, when present on a rule, further narrows the
 * match to requests whose path starts with it (e.g. the legacy
 * `www.googleapis.com/gmail/` endpoints). When multiple rules match, the MOST
 * SPECIFIC wins: a `pathPrefix` rule beats a host-only rule, and a longer
 * `pathPrefix` beats a shorter one.
 *
 * @module store/service-host-matcher
 * @task T11940
 * @epic T11765
 * @saga T10409
 * @see @cleocode/contracts/vault/service-provider — SERVICE_PROVIDERS + ServiceHostRule
 * @see ./service-injection.ts — the injector that consumes a match to mutate a request
 */

import {
  type HostAuthStrategy,
  SERVICE_PROVIDERS,
  type ServiceHostRule,
  type ServiceProviderDef,
} from '@cleocode/contracts';

/** The result of resolving an outbound request's host/path to a service provider. */
export interface ServiceHostMatch {
  /** The matched provider definition. */
  readonly provider: ServiceProviderDef;
  /** The specific host rule that matched (declares the injection strategy). */
  readonly rule: ServiceHostRule;
  /** Convenience: the injection strategy from {@link rule}. */
  readonly strategy: HostAuthStrategy;
}

/**
 * Normalize a host: lowercase, strip a trailing dot, strip a `:port` suffix.
 *
 * @param host - The raw host (may carry a port / trailing dot / mixed case).
 * @returns The normalized host for exact / suffix comparison.
 */
function normalizeHost(host: string): string {
  const lower = host.trim().toLowerCase().replace(/\.$/, '');
  const colon = lower.indexOf(':');
  return colon === -1 ? lower : lower.slice(0, colon);
}

/**
 * Does `requestHost` match a rule's `ruleHost`?
 *
 * Exact match, OR a suffix match when the rule host is an apex domain (no
 * sub-domain label of its own, e.g. `amazonaws.com`) — then any `*.amazonaws.com`
 * host matches. An exact-equality rule host with sub-domain labels
 * (e.g. `api.github.com`) matches ONLY that host.
 */
function hostMatches(requestHost: string, ruleHost: string): boolean {
  if (requestHost === ruleHost) return true;
  // Apex-domain suffix match: a two-label rule host (`amazonaws.com`) matches any
  // deeper sub-domain (`s3.us-east-1.amazonaws.com`). A rule host with three or
  // more labels (`api.github.com`) is treated as exact-only.
  const ruleLabels = ruleHost.split('.');
  if (ruleLabels.length === 2 && requestHost.endsWith(`.${ruleHost}`)) {
    return true;
  }
  return false;
}

/** Does a rule's optional `pathPrefix` admit `requestPath`? (absent prefix ⇒ yes) */
function pathMatches(requestPath: string, rule: ServiceHostRule): boolean {
  if (rule.pathPrefix === undefined) return true;
  return requestPath.startsWith(rule.pathPrefix);
}

/**
 * Resolve an outbound request's host (+ optional path) to the matching service
 * provider + host rule, or `null` when no provider claims the host (T11940 AC1).
 *
 * When several rules match (e.g. a host-only rule and a `pathPrefix` rule on the
 * same host), the MOST SPECIFIC wins: a rule with a `pathPrefix` beats one without,
 * and a longer `pathPrefix` beats a shorter one. Among equally-specific matches the
 * first registry entry wins (stable iteration order of {@link SERVICE_PROVIDERS}).
 *
 * @param host - The request host (e.g. `api.github.com`; a `:port` / trailing dot
 *   is tolerated).
 * @param path - The request path (defaults to `/`); narrows `pathPrefix` rules.
 * @returns The {@link ServiceHostMatch}, or `null` when no provider matches.
 * @task T11940
 */
export function matchServiceHost(host: string, path = '/'): ServiceHostMatch | null {
  const reqHost = normalizeHost(host);
  const reqPath = path.startsWith('/') ? path : `/${path}`;
  let best: ServiceHostMatch | null = null;
  let bestScore = -1;

  for (const provider of Object.values(SERVICE_PROVIDERS)) {
    for (const rule of provider.hostRules) {
      if (!hostMatches(reqHost, rule.host)) continue;
      if (!pathMatches(reqPath, rule)) continue;
      // Specificity score: path-prefixed rules outrank host-only; longer prefix wins.
      const score = rule.pathPrefix === undefined ? 0 : rule.pathPrefix.length;
      if (score > bestScore) {
        bestScore = score;
        best = { provider, rule, strategy: rule.strategy };
      }
    }
  }
  return best;
}

/**
 * Resolve the matching provider for a full URL string (convenience over
 * {@link matchServiceHost} that parses the URL's host + path).
 *
 * @param url - The absolute request URL (e.g. `https://api.github.com/user`).
 * @returns The {@link ServiceHostMatch}, or `null` when the URL is unparseable or
 *   no provider matches.
 * @task T11940
 */
export function matchServiceUrl(url: string): ServiceHostMatch | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return matchServiceHost(parsed.host, parsed.pathname);
}
