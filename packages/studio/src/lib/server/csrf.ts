/**
 * CSRF token helpers for CLEO Studio mutation endpoints.
 *
 * Wave 1E minimum defense (T990 · audit follow-up):
 *   1. Studio binds to loopback (HOST=127.0.0.1), so the absolute threat
 *      model is a local-origin attacker or a malicious page opened in
 *      the same browser.
 *   2. `hooks.server.ts` applies a same-origin guard on every
 *      /api/project/** POST/DELETE — requests without a matching
 *      `Origin` / `Referer` header are rejected.
 *   3. As groundwork for future full CSRF, this module issues a
 *      deterministic token bound to the active-project cookie. The
 *      token is surfaced to the client via a `cleo_csrf` cookie (read
 *      by the modals, re-sent in the `X-CSRF` request header). Today
 *      the server does **not** validate the header — it only needs the
 *      cookie machinery to exist so the eventual validator can land
 *      without touching every caller.
 *
 * @task T990
 * @wave 1E
 */

import { createHash } from 'node:crypto';
import type { Cookies } from '@sveltejs/kit';
import { PROJECT_COOKIE } from './project-context.js';

/** Cookie the client reads to attach `X-CSRF` headers on mutations. */
export const CSRF_COOKIE = 'cleo_csrf';

/** Server-side salt — regenerated per process start. */
const SALT = createHash('sha256').update(`${process.pid}:${Date.now()}`).digest('hex').slice(0, 16);

/**
 * Derive a deterministic CSRF token from the supplied project id.
 *
 * Pure hash of `SALT + projectId`. Same id always produces the same
 * token for the process lifetime, but the salt rotates on restart so
 * stale session tokens invalidate.
 */
export function deriveCsrfToken(projectId: string | null): string {
  const input = `${SALT}:${projectId ?? 'anon'}`;
  return createHash('sha256').update(input).digest('hex').slice(0, 24);
}

/**
 * Read the CSRF token out of the request cookies. Returns null when the
 * cookie is absent (new session / first request).
 */
export function getCsrfToken(cookies: Cookies): string | null {
  return cookies.get(CSRF_COOKIE) ?? null;
}

/**
 * Re-derive + set the CSRF cookie so every request receives a fresh
 * token bound to the active project. Called by the server hook on
 * every response path so the cookie stays in sync with the project
 * context.
 */
export function refreshCsrfToken(cookies: Cookies): string {
  const projectId = cookies.get(PROJECT_COOKIE) ?? null;
  const token = deriveCsrfToken(projectId);
  cookies.set(CSRF_COOKIE, token, {
    path: '/',
    httpOnly: false, // Must be readable by client JS (modals attach it).
    sameSite: 'lax',
    maxAge: 60 * 60 * 24,
  });
  return token;
}

/**
 * Same-origin guard. Returns `true` when the request either:
 *   - is a GET / HEAD / OPTIONS (no guard needed), or
 *   - has an `Origin` / `Referer` header that matches the server's own URL.
 *
 * Rejects requests whose Origin is a remote site — even if Studio is
 * accidentally bound to 0.0.0.0 in the future.
 */
export function isSameOriginRequest(request: Request): boolean {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return true;
  }

  const url = new URL(request.url);
  const selfHost = url.host;

  const origin = request.headers.get('origin');
  if (origin) {
    try {
      return new URL(origin).host === selfHost;
    } catch {
      return false;
    }
  }

  const referer = request.headers.get('referer');
  if (referer) {
    try {
      return new URL(referer).host === selfHost;
    } catch {
      return false;
    }
  }

  /**
   * No Origin / Referer headers — treat as cross-site (defensive
   * default). Browsers always set at least one of these on `fetch` /
   * form POST calls, so the only requests hitting this branch are
   * hand-rolled curls which already have full local access.
   */
  return false;
}
