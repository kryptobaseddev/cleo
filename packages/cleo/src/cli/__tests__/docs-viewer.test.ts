/**
 * T9646 — `cleo docs serve` local viewer tests (route + bundle coverage).
 *
 * Exercises the HTTP server and the bundled SPA in-process (no CLI
 * subprocess) so the suite runs cheaply in CI. Port-collision and pidfile
 * tests live in follow-up commits.
 *
 * @task T9646
 * @task T9720 — HTTP server with slug-based routing
 * @task T9723 — viewer SPA bundle
 * @epic T9631
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { type AddressInfo, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAttachmentStore } from '@cleocode/core/internal';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isProcessAlive,
  readViewerPidFile,
  removeViewerPidFile,
  writeViewerPidFile,
} from '../../viewer/pidfile.js';
import { tryListen } from '../../viewer/port-allocator.js';
import { startViewer } from '../../viewer/server.js';

let tmpProjectRoot: string;
let prevCleoHome: string | undefined;
let prevCwd: string;

/**
 * Allocate a temp dir for both:
 *   1. CLEO_HOME — so pidfile tests don't clobber the dev/user pidfile.
 *   2. Project root — set as cwd so getProjectRoot() picks it up.
 */
beforeEach(async () => {
  tmpProjectRoot = await mkdtemp(join(tmpdir(), 'cleo-viewer-test-'));
  prevCleoHome = process.env.CLEO_HOME;
  process.env.CLEO_HOME = join(tmpProjectRoot, 'cleo-home');
  prevCwd = process.cwd();
  // getProjectRoot() requires a `.cleo` dir with a SIBLING `.git` dir.
  await mkdir(join(tmpProjectRoot, '.cleo'), { recursive: true });
  await mkdir(join(tmpProjectRoot, '.git'), { recursive: true });
  process.chdir(tmpProjectRoot);
});

afterEach(async () => {
  process.chdir(prevCwd);
  if (prevCleoHome === undefined) delete process.env.CLEO_HOME;
  else process.env.CLEO_HOME = prevCleoHome;
  await rm(tmpProjectRoot, { recursive: true, force: true });
});

/** Fetch `path` from the running viewer and parse as JSON. */
async function fetchJson(host: string, port: number, path: string) {
  const res = await fetch(`http://${host}:${port}${path}`, {
    headers: { Accept: 'application/json' },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body, contentType: res.headers.get('content-type') };
}

/** Fetch `path` and return text + status. */
async function fetchText(host: string, port: number, path: string) {
  const res = await fetch(`http://${host}:${port}${path}`, { redirect: 'manual' });
  const text = await res.text();
  return { status: res.status, text, location: res.headers.get('location') };
}

describe('T9720 — HTTP server with slug-based routing', () => {
  it('serves the SPA index.html from /viewer/index.html and redirects /', async () => {
    const handle = await startViewer({ startPort: 0, endPort: 0, autoIncrement: false });
    try {
      const redirect = await fetchText(handle.host, handle.port, '/');
      expect(redirect.status).toBe(302);
      expect(redirect.location).toBe('/viewer/index.html');

      const index = await fetchText(handle.host, handle.port, '/viewer/index.html');
      expect(index.status).toBe(200);
      expect(index.text).toContain('CLEO Docs');
      expect(index.text).toContain('/viewer/viewer.js');

      const css = await fetchText(handle.host, handle.port, '/viewer/styles.css');
      expect(css.status).toBe(200);
      expect(css.text).toContain('--bg');

      const js = await fetchText(handle.host, handle.port, '/viewer/viewer.js');
      expect(js.status).toBe(200);
      expect(js.text).toContain('renderMarkdown');
    } finally {
      handle.server.close();
    }
  });

  it('/api/health returns a LAFS success envelope', async () => {
    const handle = await startViewer({ startPort: 0, endPort: 0, autoIncrement: false });
    try {
      const { status, body, contentType } = await fetchJson(
        handle.host,
        handle.port,
        '/api/health',
      );
      expect(status).toBe(200);
      expect(contentType).toContain('application/json');
      expect(body).toEqual({ success: true, data: { status: 'ok' } });
    } finally {
      handle.server.close();
    }
  });

  it('/api/docs returns LAFS success envelope with empty docs array on a fresh project', async () => {
    const handle = await startViewer({ startPort: 0, endPort: 0, autoIncrement: false });
    try {
      const { status, body } = await fetchJson(handle.host, handle.port, '/api/docs');
      expect(status).toBe(200);
      expect(body?.success).toBe(true);
      expect(body?.data?.docs).toEqual([]);
    } finally {
      handle.server.close();
    }
  });

  it('/api/docs/:slug returns LAFS error envelope for unknown slug', async () => {
    const handle = await startViewer({ startPort: 0, endPort: 0, autoIncrement: false });
    try {
      const { status, body, contentType } = await fetchJson(
        handle.host,
        handle.port,
        '/api/docs/does-not-exist',
      );
      expect(status).toBe(404);
      expect(contentType).toContain('application/json');
      expect(body?.success).toBe(false);
      expect(body?.error?.code).toBe('E_NOT_FOUND');
      expect(body?.error?.message).toContain('does-not-exist');
    } finally {
      handle.server.close();
    }
  });

  it('/docs/:slug renders the SPA shell so the client can route by pathname', async () => {
    const handle = await startViewer({ startPort: 0, endPort: 0, autoIncrement: false });
    try {
      const { status, text } = await fetchText(handle.host, handle.port, '/docs/some-slug');
      expect(status).toBe(200);
      expect(text).toContain('CLEO Docs');
      expect(text).toContain('/viewer/viewer.js');
    } finally {
      handle.server.close();
    }
  });

  it('unknown route returns LAFS error envelope (404 JSON)', async () => {
    const handle = await startViewer({ startPort: 0, endPort: 0, autoIncrement: false });
    try {
      const { status, body, contentType } = await fetchJson(
        handle.host,
        handle.port,
        '/no/such/route',
      );
      expect(status).toBe(404);
      expect(contentType).toContain('application/json');
      expect(body?.success).toBe(false);
      expect(body?.error?.code).toBe('E_NOT_FOUND');
    } finally {
      handle.server.close();
    }
  });

  it('rejects POST /api/docs with E_METHOD_NOT_ALLOWED', async () => {
    const handle = await startViewer({ startPort: 0, endPort: 0, autoIncrement: false });
    try {
      const res = await fetch(`http://${handle.host}:${handle.port}/api/docs`, {
        method: 'POST',
        body: '{}',
      });
      expect(res.status).toBe(405);
      const body = (await res.json()) as { success: boolean; error: { code: string } };
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('E_METHOD_NOT_ALLOWED');
    } finally {
      handle.server.close();
    }
  });

  it('static asset path-traversal is blocked', async () => {
    const handle = await startViewer({ startPort: 0, endPort: 0, autoIncrement: false });
    try {
      const res = await fetch(`http://${handle.host}:${handle.port}/viewer/..%2f..%2fpackage.json`);
      const body = await res.text();
      expect(body.includes('"name"') && body.includes('@cleocode/cleo')).toBe(false);
    } finally {
      handle.server.close();
    }
  });
});

describe('T9720 + T9723 — round-trip: published doc is reachable by slug', () => {
  it('puts a markdown blob with a slug, then fetches it via /api/docs + /api/docs/:slug', async () => {
    const store = createAttachmentStore();
    const markdown = '# Hello Viewer\n\nThis is a **test** doc.\n\n- item one\n- item two';
    const buf = Buffer.from(markdown, 'utf8');
    const slug = 'hello-viewer';
    await store.put(
      buf,
      { kind: 'blob', mime: 'text/markdown' } as Parameters<typeof store.put>[1],
      'task',
      'T9646',
      'docs-viewer-test',
      tmpProjectRoot,
      { slug, type: 'note' },
    );

    const handle = await startViewer({
      startPort: 0,
      endPort: 0,
      autoIncrement: false,
      projectRoot: tmpProjectRoot,
    });
    try {
      const listRes = await fetchJson(handle.host, handle.port, '/api/docs');
      expect(listRes.status).toBe(200);
      const docs = listRes.body?.data?.docs as Array<{ slug: string; title: string }>;
      expect(docs).toHaveLength(1);
      expect(docs[0]?.slug).toBe(slug);

      const oneRes = await fetchJson(handle.host, handle.port, `/api/docs/${slug}`);
      expect(oneRes.status).toBe(200);
      expect(oneRes.body?.success).toBe(true);
      expect(oneRes.body?.data?.slug).toBe(slug);
      expect(oneRes.body?.data?.title).toBe('Hello Viewer');
      expect(oneRes.body?.data?.content).toBe(markdown);
      expect(oneRes.body?.data?.mime).toBe('text/markdown');
    } finally {
      handle.server.close();
    }
  });
});

describe('T9722 — graceful port allocation', () => {
  let blockingServer: Server;
  let blockedPort: number;

  beforeEach(async () => {
    blockingServer = createServer();
    await new Promise<void>((res) => blockingServer.listen(0, '127.0.0.1', res));
    blockedPort = (blockingServer.address() as AddressInfo).port;
  });

  afterEach(() => {
    blockingServer.close();
  });

  it('auto-increments past a busy port', async () => {
    const handle = await tryListen(() => {}, {
      startPort: blockedPort,
      endPort: blockedPort + 20,
      host: '127.0.0.1',
      autoIncrement: true,
    });
    try {
      expect(handle.port).toBeGreaterThan(blockedPort);
      expect(handle.port).toBeLessThanOrEqual(blockedPort + 20);
    } finally {
      handle.server.close();
    }
  });

  it('throws EADDRINUSE when --no-auto-port is set and start port is busy', async () => {
    await expect(
      tryListen(() => {}, {
        startPort: blockedPort,
        endPort: blockedPort,
        host: '127.0.0.1',
        autoIncrement: false,
      }),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });

  it('throws E_NO_PORT when the whole range is busy', async () => {
    // Block a contiguous range of N ports, then attempt to bind across that
    // same range — every attempt should EADDRINUSE → E_NO_PORT.
    const blockers: Server[] = [];
    const ports: number[] = [];
    try {
      for (let i = 0; i < 4; i++) {
        const s = createServer();
        await new Promise<void>((res) => s.listen(0, '127.0.0.1', res));
        blockers.push(s);
        ports.push((s.address() as AddressInfo).port);
      }
      const min = Math.min(...ports);
      const max = Math.max(...ports);
      const contiguous = max - min + 1 === ports.length;
      const startPort = min;
      const endPort = contiguous ? max : min;
      await expect(
        tryListen(() => {}, {
          startPort,
          endPort,
          host: '127.0.0.1',
          autoIncrement: true,
        }),
      ).rejects.toMatchObject({ code: 'E_NO_PORT' });
    } finally {
      for (const s of blockers) s.close();
    }
  });
});

describe('T9723 — viewer SPA assets are bundled', () => {
  it('index.html, viewer.js, styles.css are reachable via the server', async () => {
    const handle = await startViewer({ startPort: 0, endPort: 0, autoIncrement: false });
    try {
      const idx = await fetchText(handle.host, handle.port, '/viewer/index.html');
      const js = await fetchText(handle.host, handle.port, '/viewer/viewer.js');
      const css = await fetchText(handle.host, handle.port, '/viewer/styles.css');
      expect(idx.status).toBe(200);
      expect(js.status).toBe(200);
      expect(css.status).toBe(200);
      expect(js.text).toContain('renderMarkdown');
      expect(js.text).toContain('/docs/');
    } finally {
      handle.server.close();
    }
  });
});

describe('T9721 — pidfile lifecycle', () => {
  it('writeViewerPidFile + readViewerPidFile roundtrip', async () => {
    await removeViewerPidFile();
    const record = {
      pid: 99999, // implausibly large pid that won't collide with real procs
      port: 7777,
      host: '127.0.0.1',
      projectRoot: tmpProjectRoot,
      startedAt: Date.now(),
    };
    const path = await writeViewerPidFile(record);
    expect(path).toContain('viewer.pid');
    const read = await readViewerPidFile();
    expect(read).toEqual(record);
    await removeViewerPidFile();
    expect(await readViewerPidFile()).toBeNull();
  });

  it('readViewerPidFile returns null on malformed JSON', async () => {
    await removeViewerPidFile();
    const path = `${process.env.CLEO_HOME}/viewer.pid`;
    const cleoHome = process.env.CLEO_HOME;
    if (!cleoHome) throw new Error('CLEO_HOME unset in test setup');
    await mkdir(cleoHome, { recursive: true });
    await writeFile(path, 'not json', 'utf8');
    const read = await readViewerPidFile();
    expect(read).toBeNull();
    await removeViewerPidFile();
  });

  it('isProcessAlive(process.pid) is true; isProcessAlive(impossible pid) is false', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    // Pids are 16-bit on POSIX by default, 22-bit on Linux. A pid like
    // 9_999_999 essentially never exists.
    expect(isProcessAlive(9_999_999)).toBe(false);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(Number.NaN)).toBe(false);
  });
});
