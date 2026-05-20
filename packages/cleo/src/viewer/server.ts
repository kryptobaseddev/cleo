/**
 * Local docs viewer HTTP server.
 *
 * Serves a minimal SPA + LAFS-shaped JSON API for browsing published docs in
 * the current CLEO project. Uses only `node:http` (zero external server
 * deps).
 *
 * Routes:
 *   GET /                  → redirect to /viewer/index.html
 *   GET /viewer/*          → static assets (index.html, viewer.js, styles.css)
 *   GET /api/docs          → list of published docs (LAFS envelope)
 *   GET /api/docs/:slug    → single doc with content (LAFS envelope)
 *   GET /docs/:slug        → SPA index.html (client routes by pathname)
 *   *                      → LAFS error envelope (404)
 *
 * Port allocation (T9722): start at 7777, auto-increment to 7800. Configurable
 * via {@link StartViewerOptions.startPort} / `endPort`.
 *
 * @epic T9631
 * @task T9646 — `cleo docs serve` local viewer
 * @task T9720 — HTTP server with slug-based routing
 * @task T9722 — graceful port allocation
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAttachmentStore,
  getProjectRoot,
  type LocalFileAttachment,
} from '@cleocode/core/internal';
import { type BoundServer, tryListen } from './port-allocator.js';

// Re-export for callers that consumed these from the server module directly.
export { tryListen } from './port-allocator.js';

/** Result of a successful viewer-server bind. */
export type ViewerServerHandle = BoundServer;

/** Options controlling viewer-server startup. */
export interface StartViewerOptions {
  /** First port to attempt. Default: 7777. */
  startPort?: number;
  /** Last port to attempt (inclusive). Default: 7800. */
  endPort?: number;
  /** When true (default), auto-increment on `EADDRINUSE`. */
  autoIncrement?: boolean;
  /** Override bind host. Default: 127.0.0.1. */
  host?: string;
  /** Override project root (default: derived via `getProjectRoot()`). */
  projectRoot?: string;
}

/**
 * Resolve the on-disk path to the bundled viewer SPA assets.
 *
 * In development this points into the source tree (`packages/cleo/assets/viewer`).
 * In the published npm package the same path resolves because `assets/` is
 * included in `package.json#files`.
 */
export function getViewerAssetsDir(): string {
  // dist/viewer/server.js → ../../assets/viewer (npm install)
  // src/viewer/server.ts (via tsx/test) → ../../assets/viewer
  const thisFile = fileURLToPath(import.meta.url);
  return resolve(dirname(thisFile), '..', '..', 'assets', 'viewer');
}

/** Map of supported static asset extensions → MIME types. */
const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function extOf(p: string): string {
  const i = p.lastIndexOf('.');
  return i < 0 ? '' : p.slice(i).toLowerCase();
}

function lafsErrorJson(code: string, message: string, fix?: string): string {
  const env: { success: false; error: { code: string; message: string; fix?: string } } = {
    success: false,
    error: { code, message },
  };
  if (fix !== undefined) env.error.fix = fix;
  return JSON.stringify(env);
}

function lafsSuccessJson<T>(data: T): string {
  return JSON.stringify({ success: true, data });
}

function send(res: ServerResponse, status: number, contentType: string, body: string | Buffer) {
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  res.end(body);
}

/**
 * Read the title from the first markdown H1 (`# heading`) of a doc, falling
 * back to the slug. Strips leading `#` characters + whitespace.
 */
function inferTitle(markdown: string, fallback: string): string {
  for (const line of markdown.split('\n', 50)) {
    const m = line.match(/^\s*#\s+(.+?)\s*$/);
    if (m) return m[1];
  }
  return fallback;
}

/**
 * Serve a single static file out of the bundled assets directory. Performs a
 * path containment check so request paths like `/viewer/../../etc/passwd`
 * never escape the assets dir.
 */
async function serveStatic(res: ServerResponse, assetsDir: string, relPath: string) {
  // normalize() collapses `..` segments; then containment-check by string prefix.
  const safeRel = normalize(relPath).replace(/^[\\/]+/, '');
  const absPath = join(assetsDir, safeRel);
  const resolvedAssets = resolve(assetsDir) + '/';
  const resolvedAbs = resolve(absPath);
  if (`${resolvedAbs}/`.indexOf(resolvedAssets) !== 0 && resolvedAbs !== resolve(assetsDir)) {
    send(res, 404, 'application/json', lafsErrorJson('E_NOT_FOUND', `not found: ${relPath}`));
    return;
  }
  try {
    const s = await stat(absPath);
    if (!s.isFile()) {
      send(res, 404, 'application/json', lafsErrorJson('E_NOT_FOUND', `not found: ${relPath}`));
      return;
    }
    const mime = STATIC_MIME[extOf(absPath)] ?? 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': String(s.size),
      'Cache-Control': 'no-store',
    });
    createReadStream(absPath).pipe(res);
  } catch {
    send(res, 404, 'application/json', lafsErrorJson('E_NOT_FOUND', `not found: ${relPath}`));
  }
}

/**
 * Build the `requestHandler` closure. The viewer is read-only — it never
 * mutates the docs DB.
 */
export function buildViewerHandler(
  opts: { projectRoot?: string } = {},
): (req: IncomingMessage, res: ServerResponse) => void {
  const projectRoot = opts.projectRoot ?? getProjectRoot();
  const assetsDir = getViewerAssetsDir();
  const store = createAttachmentStore();

  return async (req, res) => {
    try {
      const method = (req.method ?? 'GET').toUpperCase();
      const pathname = (req.url ?? '/').split('?')[0] ?? '/';

      // Health probe — useful for tests + CLI status command.
      if (method === 'GET' && pathname === '/api/health') {
        send(res, 200, 'application/json', lafsSuccessJson({ status: 'ok' }));
        return;
      }

      if (method !== 'GET' && method !== 'HEAD') {
        send(
          res,
          405,
          'application/json',
          lafsErrorJson('E_METHOD_NOT_ALLOWED', `method ${method} not allowed`),
        );
        return;
      }

      // GET / → redirect to viewer SPA index
      if (pathname === '/' || pathname === '/viewer' || pathname === '/viewer/') {
        res.writeHead(302, { Location: '/viewer/index.html' });
        res.end();
        return;
      }

      // GET /viewer/* — static assets
      if (pathname.startsWith('/viewer/')) {
        const rel = pathname.slice('/viewer/'.length);
        await serveStatic(res, assetsDir, rel || 'index.html');
        return;
      }

      // GET /api/docs — list published docs in this project
      if (pathname === '/api/docs') {
        const rows = await store.listAllInProject(projectRoot);
        // Dedupe by attachment id (one blob can be referenced by multiple owners).
        const seen = new Map<string, (typeof rows)[number]>();
        for (const r of rows) {
          if (!seen.has(r.metadata.id)) seen.set(r.metadata.id, r);
        }
        const docs = Array.from(seen.values()).map((r) => ({
          id: r.metadata.id,
          slug: r.slug,
          type: r.type,
          sha256: r.metadata.sha256,
          mime: r.metadata.attachment.kind === 'blob' ? r.metadata.attachment.mime : null,
          ownerType: r.ownerType,
          ownerId: r.ownerId,
          title: r.slug ?? r.metadata.id,
          createdAt: r.metadata.createdAt,
        }));
        send(res, 200, 'application/json', lafsSuccessJson({ docs }));
        return;
      }

      // GET /api/docs/:slug — single doc with content
      const apiDocMatch = pathname.match(/^\/api\/docs\/([^/]+)$/);
      if (apiDocMatch) {
        const slug = decodeURIComponent(apiDocMatch[1]);
        const bySlug = await store.findBySlug(slug, projectRoot);
        if (!bySlug) {
          send(
            res,
            404,
            'application/json',
            lafsErrorJson('E_NOT_FOUND', `no published doc with slug '${slug}'`),
          );
          return;
        }
        const fetched = await store.get(bySlug.metadata.sha256, projectRoot);
        if (!fetched) {
          send(
            res,
            404,
            'application/json',
            lafsErrorJson(
              'E_NOT_FOUND',
              `doc '${slug}' metadata present but blob bytes missing on disk`,
            ),
          );
          return;
        }
        const mime =
          fetched.metadata.attachment.kind === 'blob'
            ? fetched.metadata.attachment.mime
            : fetched.metadata.attachment.kind === 'local-file'
              ? ((fetched.metadata.attachment as LocalFileAttachment).mime ?? 'text/plain')
              : 'application/octet-stream';
        const isText = mime.startsWith('text/') || mime === 'application/json';
        const content = isText ? fetched.bytes.toString('utf8') : null;
        const title = content ? inferTitle(content, slug) : slug;
        send(
          res,
          200,
          'application/json',
          lafsSuccessJson({
            id: fetched.metadata.id,
            slug: bySlug.slug,
            type: bySlug.type,
            title,
            mime,
            sha256: fetched.metadata.sha256,
            content,
            sizeBytes: fetched.bytes.length,
          }),
        );
        return;
      }

      // GET /docs/:slug — SPA shell (client routes by location.pathname)
      if (/^\/docs\/[^/]+\/?$/.test(pathname)) {
        await serveStatic(res, assetsDir, 'index.html');
        return;
      }

      // Fallthrough → 404 JSON envelope
      send(
        res,
        404,
        'application/json',
        lafsErrorJson('E_NOT_FOUND', `no route for ${method} ${pathname}`),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      send(res, 500, 'application/json', lafsErrorJson('E_INTERNAL', msg));
    }
  };
}

/**
 * Start the viewer server. Returns a handle once the socket is bound.
 *
 * Caller is responsible for keeping the process alive (e.g. by not returning
 * from the CLI handler) and for invoking `server.close()` on shutdown.
 */
export async function startViewer(opts: StartViewerOptions = {}): Promise<ViewerServerHandle> {
  const handler = buildViewerHandler({ projectRoot: opts.projectRoot });
  return tryListen(handler, {
    startPort: opts.startPort,
    endPort: opts.endPort,
    host: opts.host,
    autoIncrement: opts.autoIncrement,
  });
}
