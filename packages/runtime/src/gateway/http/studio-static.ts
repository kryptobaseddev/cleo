/**
 * Static file serving for the bundled CLEO Web Studio assets.
 *
 * The gateway HTTP server calls {@link serveStudioStatic} for any request whose
 * path starts with the `/studio` prefix. The handler:
 *
 *  1. Strips the `/studio` prefix and resolves the remainder against the
 *     `studioStaticDir` (the `build/client/` output of the Studio
 *     `adapter-node` build bundled inside `@cleocode/cleo`).
 *  2. Serves the matched file with the correct MIME type (inferred from the
 *     extension via the built-in {@link MIME_TYPES} map).
 *  3. Returns `index.html` for any path that does not resolve to a static file
 *     — the SPA fallback that lets the SvelteKit client-side router handle
 *     sub-routes.
 *  4. Returns a clean JSON error envelope (not a stack trace) when
 *     `studioStaticDir` is absent (dev checkout without a Studio build, or an
 *     npm install where the postbuild copy was skipped).
 *
 * The handler deliberately has NO `process.exit`, NO drizzle, NO
 * `@cleocode/cleo` dependency — it is a pure file-system responder that can be
 * embedded in any `node:http` server (the gateway daemon, a test harness).
 *
 * The `build/client/` static tree is served under `/studio/` so all of its
 * relative asset references (`/_app/immutable/...`) resolve correctly. The root
 * `/studio` (no trailing slash) redirects to `/studio/` to keep the base URL
 * consistent with the SvelteKit assets.
 *
 * @packageDocumentation
 * @module @cleocode/runtime/gateway/http
 *
 * @task T11979
 * @epic T11261
 */

import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, resolve } from 'node:path';

// Minimal logger shim — avoids importing @cleocode/core so this module stays
// side-effect-free and testable without a core build. The gateway listen.ts
// already owns a full pino logger; we only need debug/warn here.
const log = {
  info: (obj: Record<string, unknown>, msg: string) => {
    // Intentionally quiet in production; structured logs route through gateway logger.
    if (process.env['CLEO_DEBUG_STUDIO']) console.info('[studio-static]', msg, obj);
  },
  warn: (obj: Record<string, unknown>, msg: string) => {
    if (process.env['NODE_ENV'] !== 'test') {
      console.warn('[studio-static]', msg, obj);
    }
  },
  debug: (_obj: Record<string, unknown>, _msg: string) => {
    // debug suppressed unless explicit env var
    if (process.env['CLEO_DEBUG_STUDIO']) console.debug('[studio-static]', _msg, _obj);
  },
};

// ---------------------------------------------------------------------------
// MIME type map
// ---------------------------------------------------------------------------

/** MIME types for static file extensions served by the Studio bundle. */
const MIME_TYPES: ReadonlyMap<string, string> = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.mjs', 'application/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.map', 'application/json; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
]);

/** Default MIME type for unknown extensions. */
const MIME_FALLBACK = 'application/octet-stream';

/** The URL prefix the Studio static handler claims. */
export const STUDIO_PREFIX = '/studio';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Options for the Studio static handler, injected at server startup.
 *
 * The caller resolves the absolute path to the static asset directory and
 * passes it here — the handler never reads environment variables or resolves
 * paths itself, keeping concerns separated and the handler testable.
 */
export interface StudioStaticOptions {
  /**
   * Absolute path to the Studio static asset directory. This is the
   * `build/client/` subdirectory from an `adapter-node` Studio build, bundled
   * inside `@cleocode/cleo` at `studio-dist/client/`.
   *
   * When `undefined` or the path does not exist on disk, every request under
   * `/studio` returns a clean JSON 503 "bundle absent" envelope.
   */
  staticDir: string | undefined;
}

/**
 * Determine whether a request path falls under the Studio prefix and should be
 * handled by the static asset handler rather than the API gateway.
 *
 * @param pathname - The URL pathname (without query string).
 * @returns `true` when the path is `/studio`, `/studio/`, or any
 *   `/studio/<subpath>`.
 */
export function isStudioPath(pathname: string): boolean {
  return pathname === STUDIO_PREFIX || pathname.startsWith(`${STUDIO_PREFIX}/`);
}

/**
 * Resolve the file-system path for a Studio request within `staticDir`.
 *
 * Strips the `/studio` prefix and normalises the remainder; guards against
 * path-traversal (a normalised path that escapes `staticDir` is rejected).
 *
 * @param staticDir - Absolute path to the Studio static asset directory.
 * @param pathname - The request path (already verified to start with `/studio`).
 * @returns The absolute candidate path, or `undefined` when path traversal is
 *   detected.
 */
export function resolveStudioAssetPath(staticDir: string, pathname: string): string | undefined {
  const base = resolve(staticDir);

  // Strip the /studio prefix; the remainder is the asset subpath.
  const stripped = pathname.slice(STUDIO_PREFIX.length) || '/';

  // Join the base with the stripped path. resolve() normalises `..` sequences
  // and always returns an absolute path rooted at base (since we join two
  // absolute paths, the second one wins when it is also absolute — but because
  // `stripped` is NOT an absolute path from the filesystem root, we must
  // remove the leading slash before joining to make it relative).
  const relative = stripped.replace(/^[\\/]+/, '') || '.';
  const candidate = resolve(base, relative);

  // Guard: the resolved candidate must remain under staticDir to prevent
  // path traversal. Adding a trailing separator to the base ensures that
  // /srv/studio-dist/client-extra is NOT mistaken for a child of
  // /srv/studio-dist/client.
  const safeBase = base.endsWith('/') ? base : `${base}/`;
  if (candidate !== base && !candidate.startsWith(safeBase)) {
    return undefined; // path traversal — reject
  }
  return candidate;
}

/**
 * Infer the MIME type for a file from its extension.
 *
 * @param filePath - The file path (only the extension is used).
 * @returns The appropriate `Content-Type` header value.
 */
export function mimeType(filePath: string): string {
  return MIME_TYPES.get(extname(filePath).toLowerCase()) ?? MIME_FALLBACK;
}

/**
 * Write the "bundle absent" JSON error envelope and close the response.
 *
 * Used when `staticDir` is `undefined` or does not exist on disk — the Studio
 * build was not found. The response is a `503 Service Unavailable` with a clean
 * LAFS-flavoured JSON body so clients can detect the condition programmatically.
 *
 * @param res - The server response to write to.
 * @param hint - Optional developer hint (e.g. the expected bundle path).
 */
export function writeBundleAbsentError(res: ServerResponse, hint?: string): void {
  const body = JSON.stringify({
    success: false,
    error: {
      code: 'E_STUDIO_BUNDLE_ABSENT',
      message:
        'CLEO Studio assets are not available. ' +
        'Run `pnpm --filter @cleocode/studio run build` to build them, ' +
        'or install from npm (npm i -g @cleocode/cleo) for a batteries-included release.',
      hint: hint ?? null,
    },
  });
  res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

/**
 * Handle a single HTTP request whose path falls under `/studio`.
 *
 * Routing logic:
 *  - `GET /studio` → 302 redirect to `/studio/` (keep asset refs consistent)
 *  - `GET /studio/<static-asset>` → serve the file from `staticDir`
 *  - `GET /studio/*` (no matching file) → serve `index.html` (SPA fallback)
 *  - Any request when `staticDir` is absent → 503 JSON envelope
 *  - Non-GET method → 405 JSON envelope (Studio is read-only from the gateway)
 *
 * @param req - The inbound HTTP request.
 * @param res - The outbound HTTP response.
 * @param opts - Static handler options (resolved at server startup).
 * @returns A promise that resolves once the response has been written.
 */
export async function serveStudioStatic(
  req: IncomingMessage,
  res: ServerResponse,
  opts: StudioStaticOptions,
): Promise<void> {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;

  // Only GET and HEAD are sensible for static assets.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, {
      'Content-Type': 'application/json; charset=utf-8',
      Allow: 'GET, HEAD',
    });
    res.end(
      JSON.stringify({
        success: false,
        error: {
          code: 'E_METHOD_NOT_ALLOWED',
          message: `Method ${req.method ?? '<none>'} not allowed for /studio routes`,
        },
      }),
    );
    return;
  }

  // Redirect /studio → /studio/ so relative asset imports resolve correctly.
  if (pathname === STUDIO_PREFIX) {
    res.writeHead(302, { Location: `${STUDIO_PREFIX}/` });
    res.end();
    return;
  }

  // Bundle-absent guard — return a helpful error instead of a stack trace.
  const staticDir = opts.staticDir;
  if (staticDir === undefined || !existsSync(staticDir)) {
    log.warn({ staticDir }, 'studio static dir absent');
    writeBundleAbsentError(res, staticDir);
    return;
  }

  // Resolve the asset path, guarding against path traversal.
  const assetPath = resolveStudioAssetPath(staticDir, pathname);
  if (assetPath === undefined) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        success: false,
        error: { code: 'E_BAD_REQUEST', message: 'Invalid path' },
      }),
    );
    return;
  }

  // Try to serve the file; fall back to index.html for SPA routing.
  let targetPath = assetPath;
  let isSpaFallback = false;
  try {
    const st = await stat(targetPath);
    if (st.isDirectory()) {
      // Treat directory requests as index.html within the dir.
      const dirIndex = join(targetPath, 'index.html');
      if (existsSync(dirIndex)) {
        targetPath = dirIndex;
      } else {
        // SPA fallback — root index.html.
        targetPath = join(staticDir, 'index.html');
        isSpaFallback = true;
      }
    }
  } catch {
    // File not found — SPA fallback.
    targetPath = join(staticDir, 'index.html');
    isSpaFallback = true;
  }

  if (!existsSync(targetPath)) {
    // Even the fallback index.html is missing — the bundle is corrupted.
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        success: false,
        error: {
          code: 'E_STUDIO_BUNDLE_CORRUPT',
          message: 'Studio index.html not found in the static bundle.',
        },
      }),
    );
    return;
  }

  const ct = mimeType(targetPath);

  // For HEAD requests, report headers without the body.
  if (req.method === 'HEAD') {
    try {
      const st = await stat(targetPath);
      res.writeHead(200, {
        'Content-Type': ct,
        'Content-Length': String(st.size),
        ...(isSpaFallback ? {} : { 'Cache-Control': 'public, max-age=31536000, immutable' }),
      });
      res.end();
    } catch {
      res.writeHead(404);
      res.end();
    }
    return;
  }

  // Stream the file.
  try {
    const st = await stat(targetPath);
    res.writeHead(200, {
      'Content-Type': ct,
      'Content-Length': String(st.size),
      // Immutable cache for fingerprinted assets; no cache for SPA fallback.
      ...(isSpaFallback
        ? { 'Cache-Control': 'no-cache' }
        : {
            'Cache-Control': 'public, max-age=31536000, immutable',
          }),
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = createReadStream(targetPath);
    stream.on('error', (err: Error) => {
      log.warn({ err, targetPath }, 'studio static read error');
      if (!res.writableEnded) res.end();
    });
    stream.pipe(res);
    log.debug({ pathname, targetPath, isSpaFallback, ct }, 'studio static served');
  } catch (err) {
    log.warn({ err, targetPath }, 'studio static stat error');
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          success: false,
          error: { code: 'E_INTERNAL', message: 'Failed to read Studio asset' },
        }),
      );
    } else if (!res.writableEnded) {
      res.end();
    }
  }
}

/**
 * Resolve the bundled Studio static directory from the `@cleocode/cleo` package
 * location.
 *
 * When running from an npm install, the Studio build is bundled at
 * `<cleo-package-root>/studio-dist/client/`. When running from a monorepo dev
 * checkout, the directory may not exist (developers must run
 * `pnpm --filter @cleocode/studio run build` manually) — `undefined` is
 * returned in that case, and the gateway handler will serve the bundle-absent
 * error instead of crashing.
 *
 * @param cleoPackageDir - Absolute path to the `@cleocode/cleo` package root.
 *   Typically derived from `import.meta.url` at the call site.
 * @returns The absolute path to `studio-dist/client/`, or `undefined` if the
 *   directory does not exist.
 */
export function resolveStudioStaticDir(cleoPackageDir: string): string | undefined {
  const candidate = join(cleoPackageDir, 'studio-dist', 'client');
  return existsSync(candidate) ? candidate : undefined;
}
