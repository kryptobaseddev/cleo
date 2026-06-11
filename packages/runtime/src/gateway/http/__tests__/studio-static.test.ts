/**
 * Tests for the Studio static file handler (T11979).
 *
 * Asserts the three key contract properties:
 *  1. Correct MIME types are inferred from file extensions.
 *  2. `isStudioPath` correctly identifies `/studio` prefix paths.
 *  3. `resolveStudioAssetPath` strips the prefix, normalises, and guards
 *     against path-traversal attacks.
 *  4. `serveStudioStatic` serves real files from a temp directory, falls back
 *     to `index.html` for non-existent sub-routes (SPA fallback), returns a
 *     clean 503 JSON envelope when `staticDir` is absent, and 405 for non-GET.
 *  5. `writeBundleAbsentError` writes the expected 503 JSON shape.
 *
 * No actual Studio build is required — the tests create a minimal fixture
 * directory in a temp location.
 *
 * @task T11979
 * @epic T11261
 */

import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isStudioPath,
  mimeType,
  resolveStudioAssetPath,
  type StudioStaticOptions,
  serveStudioStatic,
  writeBundleAbsentError,
} from '../studio-static.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Create a minimal fake Studio static directory with a few files. */
async function createFixtureDir(): Promise<string> {
  const dir = join(tmpdir(), `cleo-studio-static-test-${randomUUID()}`);
  await mkdir(join(dir, '_app', 'immutable'), { recursive: true });
  // Simulate the index.html SPA shell.
  await writeFile(join(dir, 'index.html'), '<html><body>CLEO Studio</body></html>');
  // A CSS file.
  await writeFile(join(dir, '_app', 'immutable', 'app.css'), 'body { margin: 0; }');
  // A JS chunk.
  await writeFile(join(dir, '_app', 'immutable', 'chunk.js'), 'export const x = 1;');
  // A favicon.
  await writeFile(join(dir, 'favicon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return dir;
}

/** Collect the full body of an HTTP response as a UTF-8 string. */
function collectBody(res: ServerResponse): Promise<string> {
  return new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    (res.socket as unknown as NodeJS.ReadableStream).on?.('data', (c: Buffer) => chunks.push(c));
    // For test environments we read from the response directly via a passthrough.
    resolve('');
  });
}

// ---------------------------------------------------------------------------
// Minimal fake request/response factory for unit tests
// ---------------------------------------------------------------------------

interface FakeResponse {
  statusCode: number | null;
  headers: Record<string, string>;
  body: Buffer;
  ended: boolean;
}

function fakeReqRes(
  method: string,
  url: string,
): { req: IncomingMessage; res: ServerResponse; result: FakeResponse } {
  const result: FakeResponse = {
    statusCode: null,
    headers: {},
    body: Buffer.alloc(0),
    ended: false,
  };

  // Build a minimal IncomingMessage-like object.
  const req = Object.assign(Object.create(null), {
    method,
    url,
    headers: {},
    once: (_event: string, _fn: () => void) => req,
    removeListener: () => req,
  }) as unknown as IncomingMessage;

  // Build a minimal ServerResponse-like object that records what was written.
  const chunks: Buffer[] = [];
  const res = Object.assign(Object.create(null), {
    headersSent: false,
    writableEnded: false,
    statusCode: 200,
    writeHead(status: number, hdrs?: Record<string, string>) {
      result.statusCode = status;
      if (hdrs) Object.assign(result.headers, hdrs);
      this.headersSent = true;
      return this;
    },
    write(chunk: Buffer | string) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    },
    end(chunk?: Buffer | string) {
      if (chunk !== undefined) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      result.body = Buffer.concat(chunks);
      result.ended = true;
      this.writableEnded = true;
    },
    on(_event: string, _fn: () => void) {
      return this;
    },
    once(_event: string, _fn: () => void) {
      return this;
    },
    pipe(dest: { write: (b: Buffer) => boolean; end: () => void }) {
      // For tests: the static handler uses createReadStream().pipe(res).
      // We cannot easily intercept that here, so we set ended = true
      // and trust the unit test of the handler to use real temp files.
      result.ended = true;
      this.writableEnded = true;
    },
  }) as unknown as ServerResponse;

  return { req, res, result };
}

// ---------------------------------------------------------------------------
// Fixture lifecycle
// ---------------------------------------------------------------------------

let fixtureDir: string;

beforeAll(async () => {
  fixtureDir = await createFixtureDir();
});

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// mimeType
// ---------------------------------------------------------------------------

describe('mimeType', () => {
  it('returns text/html for .html', () => {
    expect(mimeType('index.html')).toBe('text/html; charset=utf-8');
  });

  it('returns application/javascript for .js', () => {
    expect(mimeType('chunk.js')).toBe('application/javascript; charset=utf-8');
  });

  it('returns text/css for .css', () => {
    expect(mimeType('app.css')).toBe('text/css; charset=utf-8');
  });

  it('returns image/png for .png', () => {
    expect(mimeType('favicon.png')).toBe('image/png');
  });

  it('returns font/woff2 for .woff2', () => {
    expect(mimeType('font.woff2')).toBe('font/woff2');
  });

  it('returns application/octet-stream for unknown extensions', () => {
    expect(mimeType('binary.bin')).toBe('application/octet-stream');
  });

  it('is case-insensitive', () => {
    expect(mimeType('IMAGE.PNG')).toBe('image/png');
  });
});

// ---------------------------------------------------------------------------
// isStudioPath
// ---------------------------------------------------------------------------

describe('isStudioPath', () => {
  it('matches /studio exactly', () => {
    expect(isStudioPath('/studio')).toBe(true);
  });

  it('matches /studio/ (trailing slash)', () => {
    expect(isStudioPath('/studio/')).toBe(true);
  });

  it('matches /studio/subpath', () => {
    expect(isStudioPath('/studio/settings/profile')).toBe(true);
  });

  it('matches /studio/_app/immutable/chunk.js', () => {
    expect(isStudioPath('/studio/_app/immutable/chunk.js')).toBe(true);
  });

  it('does NOT match /studios (prefix collision)', () => {
    expect(isStudioPath('/studios')).toBe(false);
  });

  it('does NOT match /v1/tasks/show', () => {
    expect(isStudioPath('/v1/tasks/show')).toBe(false);
  });

  it('does NOT match /', () => {
    expect(isStudioPath('/')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveStudioAssetPath
// ---------------------------------------------------------------------------

describe('resolveStudioAssetPath', () => {
  const base = '/srv/studio-dist/client';

  it('maps /studio/ to the base dir', () => {
    const result = resolveStudioAssetPath(base, '/studio/');
    // resolve() normalises '/srv/studio-dist/client/.' to '/srv/studio-dist/client'
    expect(result).toBe(base);
  });

  it('maps /studio/index.html to base/index.html', () => {
    const result = resolveStudioAssetPath(base, '/studio/index.html');
    expect(result).toBe(`${base}/index.html`);
  });

  it('maps /studio/_app/immutable/chunk.js correctly', () => {
    const result = resolveStudioAssetPath(base, '/studio/_app/immutable/chunk.js');
    expect(result).toBe(`${base}/_app/immutable/chunk.js`);
  });

  it('returns undefined for path traversal (../../etc/passwd)', () => {
    const result = resolveStudioAssetPath(base, '/studio/../../etc/passwd');
    expect(result).toBeUndefined();
  });

  it('returns undefined for path traversal through relative segments', () => {
    // Simulate a path that, after stripping /studio, tries to escape staticDir.
    // Note: the URL parser in the handler normalizes /studio/../../../etc to /etc
    // before isStudioPath is checked, so the handler never sees this. But the
    // unit function itself must still guard against it.
    const result = resolveStudioAssetPath(base, '/studio/../../../etc');
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// writeBundleAbsentError
// ---------------------------------------------------------------------------

describe('writeBundleAbsentError', () => {
  it('writes a 503 with E_STUDIO_BUNDLE_ABSENT code', () => {
    const { req: _req, res, result } = fakeReqRes('GET', '/studio/');
    writeBundleAbsentError(res, '/path/to/studio-dist');
    expect(result.statusCode).toBe(503);
    const body = JSON.parse(result.body.toString('utf8'));
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('E_STUDIO_BUNDLE_ABSENT');
    expect(body.error.hint).toBe('/path/to/studio-dist');
  });
});

// ---------------------------------------------------------------------------
// serveStudioStatic — unit-level handler tests
// ---------------------------------------------------------------------------

describe('serveStudioStatic', () => {
  it('returns 503 when staticDir is undefined', async () => {
    const { req, res, result } = fakeReqRes('GET', '/studio/');
    const opts: StudioStaticOptions = { staticDir: undefined };
    await serveStudioStatic(req, res, opts);
    expect(result.statusCode).toBe(503);
    const body = JSON.parse(result.body.toString('utf8'));
    expect(body.error.code).toBe('E_STUDIO_BUNDLE_ABSENT');
  });

  it('returns 503 when staticDir does not exist on disk', async () => {
    const { req, res, result } = fakeReqRes('GET', '/studio/');
    const opts: StudioStaticOptions = { staticDir: '/nonexistent/path/that/does/not/exist' };
    await serveStudioStatic(req, res, opts);
    expect(result.statusCode).toBe(503);
  });

  it('returns 405 for non-GET/HEAD methods', async () => {
    const { req, res, result } = fakeReqRes('POST', '/studio/');
    const opts: StudioStaticOptions = { staticDir: fixtureDir };
    await serveStudioStatic(req, res, opts);
    expect(result.statusCode).toBe(405);
    const body = JSON.parse(result.body.toString('utf8'));
    expect(body.error.code).toBe('E_METHOD_NOT_ALLOWED');
  });

  it('redirects /studio (no slash) to /studio/', async () => {
    const { req, res, result } = fakeReqRes('GET', '/studio');
    const opts: StudioStaticOptions = { staticDir: fixtureDir };
    await serveStudioStatic(req, res, opts);
    expect(result.statusCode).toBe(302);
    expect(result.headers['Location']).toBe('/studio/');
  });

  it('serves index.html for /studio/ root', async () => {
    const { req, res, result } = fakeReqRes('GET', '/studio/');
    const opts: StudioStaticOptions = { staticDir: fixtureDir };
    await serveStudioStatic(req, res, opts);
    // The static handler pipes the file — result.ended will be true.
    expect(result.ended).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.headers['Content-Type']).toMatch('text/html');
  });

  it('serves SPA fallback (index.html) for unknown sub-routes', async () => {
    const { req, res, result } = fakeReqRes('GET', '/studio/tasks/T1234');
    const opts: StudioStaticOptions = { staticDir: fixtureDir };
    await serveStudioStatic(req, res, opts);
    expect(result.ended).toBe(true);
    expect(result.statusCode).toBe(200);
    // SPA fallback sends index.html with no-cache
    expect(result.headers['Cache-Control']).toBe('no-cache');
    expect(result.headers['Content-Type']).toMatch('text/html');
  });

  it('serves a CSS file with correct MIME type', async () => {
    const { req, res, result } = fakeReqRes('GET', '/studio/_app/immutable/app.css');
    const opts: StudioStaticOptions = { staticDir: fixtureDir };
    await serveStudioStatic(req, res, opts);
    expect(result.ended).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.headers['Content-Type']).toBe('text/css; charset=utf-8');
  });

  it('serves a JS file with immutable cache headers', async () => {
    const { req, res, result } = fakeReqRes('GET', '/studio/_app/immutable/chunk.js');
    const opts: StudioStaticOptions = { staticDir: fixtureDir };
    await serveStudioStatic(req, res, opts);
    expect(result.ended).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.headers['Content-Type']).toBe('application/javascript; charset=utf-8');
    expect(result.headers['Cache-Control']).toContain('immutable');
  });

  it('does NOT receive traversal paths — URL normalization prevents them', () => {
    // URL: /studio/../../etc/passwd — the URL parser normalizes this to /etc/passwd.
    // isStudioPath('/etc/passwd') returns false, so serveStudioStatic is never
    // invoked by the gateway's handleHttpRequest. This test documents that behaviour.
    const pathname = new URL('/studio/../../etc/passwd', 'http://localhost').pathname;
    expect(pathname).toBe('/etc/passwd');
    // Since isStudioPath('/etc/passwd') is false, the handler is not called
    // for traversal URLs that escape the /studio prefix.
    expect(isStudioPath(pathname)).toBe(false);
  });
});
