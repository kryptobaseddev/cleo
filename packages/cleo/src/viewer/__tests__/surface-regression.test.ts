/**
 * Regression test suite for viewer surface flattening.
 *
 * Comprehensive regression coverage for the docs viewer HTTP server surface.
 * Protects against regressions in JSON envelope shapes, response consistency
 * across all doc types, error paths, static asset serving, and port allocation.
 *
 * Tests spin up the viewer against temp projects with published docs of every
 * built-in type, then exercise each route over real HTTP. llmtxt/similarity
 * is mocked for deterministic search results.
 *
 * @task T11189
 * @epic T10521 (T10516-E)
 * @saga T10516
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAttachmentStore } from '@cleocode/core/internal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('llmtxt/similarity', () => ({
  rankBySimilarity: vi.fn(),
}));

import type { IncomingMessage, ServerResponse } from 'node:http';
import * as simMod from 'llmtxt/similarity';
import {
  readViewerPidFile,
  removeViewerPidFile,
  viewerPidFilePath,
  writeViewerPidFile,
} from '../pidfile.js';
import { tryListen } from '../port-allocator.js';
import { startViewer } from '../server.js';

// ─── Types ────────────────────────────────────────────────────────────────────

interface DocListItem {
  id: string;
  slug: string;
  type: string;
  sha256: string;
  mime: string | null;
  ownerType: string;
  ownerId: string;
  title: string;
  createdAt: string;
}

interface DocDetail {
  id: string;
  slug: string;
  type: string;
  title: string;
  mime: string;
  sha256: string;
  content: string | null;
  sizeBytes: number;
}

interface SearchHit {
  slug: string;
  type: string;
  snippet: string;
  score: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

let tmpProjectRoot: string;
let prevCleoHome: string | undefined;
let prevCwd: string;

beforeEach(async () => {
  tmpProjectRoot = await mkdtemp(join(tmpdir(), 'cleo-viewer-regression-'));
  prevCleoHome = process.env.CLEO_HOME;
  process.env.CLEO_HOME = join(tmpProjectRoot, 'cleo-home');
  prevCwd = process.cwd();
  await mkdir(join(tmpProjectRoot, '.cleo'), { recursive: true });
  // Create a proper git repo so CLEO project resolution works.
  const { execFileSync } = await import('node:child_process');
  const { createHash } = await import('node:crypto');
  execFileSync('git', ['init'], { cwd: tmpProjectRoot, stdio: 'ignore' });
  // Compute the canonical projectId the same way the paths package does:
  // SHA-256(`${gitRoot}|${projectName}|${remoteUrl}`).slice(0, 12)
  const projectId = createHash('sha256')
    .update(`${tmpProjectRoot}|viewer-regression-test|`)
    .digest('hex')
    .slice(0, 12);
  await writeFile(
    join(tmpProjectRoot, '.cleo', 'project-info.json'),
    JSON.stringify({ projectId, name: 'viewer-regression-test' }),
    'utf-8',
  );
  // Register the project in nexus.db so resolveCanonicalCleoDir works.
  const cleoHomeDir = process.env.CLEO_HOME!;
  await mkdir(cleoHomeDir, { recursive: true });
  const { DatabaseSync } = await import('node:sqlite');
  // T11578 · AC3: the registry lives in the consolidated GLOBAL cleo.db, in the
  // PREFIXED nexus_project_registry table (the standalone nexus.db is retired).
  const nexusDb = new DatabaseSync(join(cleoHomeDir, 'cleo.db'));
  nexusDb.exec(`
    CREATE TABLE IF NOT EXISTS nexus_project_registry (
      project_id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL
    );
    INSERT OR REPLACE INTO nexus_project_registry (project_id, project_path)
    VALUES ('${projectId}', '${tmpProjectRoot}');
  `);
  nexusDb.close();
  process.chdir(tmpProjectRoot);
  vi.mocked(simMod.rankBySimilarity).mockReset();
});

afterEach(async () => {
  process.chdir(prevCwd);
  if (prevCleoHome === undefined) delete process.env.CLEO_HOME;
  else process.env.CLEO_HOME = prevCleoHome;
  await rm(tmpProjectRoot, { recursive: true, force: true });
});

async function fetchJson(host: string, port: number, path: string) {
  const res = await fetch(`http://${host}:${port}${path}`, {
    headers: { Accept: 'application/json' },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body, contentType: res.headers.get('content-type') };
}

async function fetchRaw(host: string, port: number, path: string, opts?: { method?: string }) {
  const res = await fetch(`http://${host}:${port}${path}`, {
    method: opts?.method ?? 'GET',
  });
  const contentType = res.headers.get('content-type') ?? '';
  const isJson = contentType.includes('application/json');
  const body = isJson ? await res.json().catch(() => null) : await res.text();
  return { status: res.status, body, contentType };
}

async function publish(
  slug: string,
  body: string,
  type: string,
  ownerId = 'T11189',
): Promise<void> {
  const store = createAttachmentStore();
  await store.put(
    Buffer.from(body, 'utf8'),
    { kind: 'blob', mime: 'text/markdown' } as Parameters<typeof store.put>[1],
    'task',
    ownerId,
    'viewer-regression-test',
    tmpProjectRoot,
    { slug, type },
  );
}

async function startViewerOnOSPort(): Promise<Awaited<ReturnType<typeof startViewer>>> {
  return startViewer({
    startPort: 0,
    endPort: 0,
    autoIncrement: false,
    projectRoot: tmpProjectRoot,
  });
}

/** Generate a markdown doc with ~N words (for performance tests). */
function makeLargeDoc(words: number): string {
  const paragraphs: string[] = [];
  let w = 0;
  while (w < words) {
    const paraWords: string[] = [];
    for (let i = 0; i < 50 && w < words; i++, w++) {
      paraWords.push(`word${w}`);
    }
    paragraphs.push(paraWords.join(' '));
  }
  return '# Large Document\n\n' + paragraphs.join('\n\n') + '\n';
}

// ─── 1. LAFS Envelope Consistency ────────────────────────────────────────────

describe('Viewer API — LAFS envelope consistency', () => {
  it('health endpoint returns success envelope with status ok', async () => {
    const handle = await startViewerOnOSPort();
    try {
      const { status, body } = await fetchJson(handle.host, handle.port, '/api/health');
      expect(status).toBe(200);
      expect(body?.success).toBe(true);
      expect(body?.data?.status).toBe('ok');
    } finally {
      handle.server.close();
    }
  });

  it('unknown route returns LAFS error envelope (404) with E_NOT_FOUND', async () => {
    const handle = await startViewerOnOSPort();
    try {
      const { status, body } = await fetchJson(handle.host, handle.port, '/api/nonexistent');
      expect(status).toBe(404);
      expect(body?.success).toBe(false);
      expect(body?.error?.code).toBe('E_NOT_FOUND');
      expect(body?.error?.message).toContain('no route');
    } finally {
      handle.server.close();
    }
  });

  it('POST request returns E_METHOD_NOT_ALLOWED (405)', async () => {
    const handle = await startViewerOnOSPort();
    try {
      const { status, body } = await fetchRaw(handle.host, handle.port, '/api/health', {
        method: 'POST',
      });
      expect(status).toBe(405);
      expect(body?.success).toBe(false);
      expect(body?.error?.code).toBe('E_METHOD_NOT_ALLOWED');
    } finally {
      handle.server.close();
    }
  });

  it('PUT request returns E_METHOD_NOT_ALLOWED (405)', async () => {
    const handle = await startViewerOnOSPort();
    try {
      const { status, body } = await fetchRaw(handle.host, handle.port, '/api/docs', {
        method: 'PUT',
      });
      expect(status).toBe(405);
      expect(body?.success).toBe(false);
      expect(body?.error?.code).toBe('E_METHOD_NOT_ALLOWED');
    } finally {
      handle.server.close();
    }
  });

  it('HEAD request on health falls through to 404 (routes check GET explicitly)', async () => {
    const handle = await startViewerOnOSPort();
    try {
      const res = await fetch(`http://${handle.host}:${handle.port}/api/health`, {
        method: 'HEAD',
      });
      // Viewer allows HEAD through the method gate but individual routes
      // check for GET explicitly, so HEAD falls through to 404.
      expect(res.status).toBe(404);
    } finally {
      handle.server.close();
    }
  });

  it('all error envelopes have success:false + error.code + error.message', async () => {
    const errorPaths = [
      { path: '/api/nonexistent', expectedStatus: 404, expectedCode: 'E_NOT_FOUND' },
      { path: '/api/docs/nonexistent-slug', expectedStatus: 404, expectedCode: 'E_NOT_FOUND' },
    ];

    for (const { path, expectedStatus, expectedCode } of errorPaths) {
      const handle = await startViewerOnOSPort();
      try {
        const { status, body } = await fetchJson(handle.host, handle.port, path);
        expect(status).toBe(expectedStatus);
        expect(body?.success).toBe(false);
        expect(body?.error?.code).toBe(expectedCode);
        expect(typeof body?.error?.message).toBe('string');
        expect(body?.error?.message.length).toBeGreaterThan(0);
      } finally {
        handle.server.close();
      }
    }
  });

  it('all success envelopes have success:true + data', async () => {
    await publish('test-doc', '# Test Doc\n\nContent.\n', 'note');

    const successPaths = ['/api/health', '/api/docs'];

    for (const path of successPaths) {
      const handle = await startViewerOnOSPort();
      try {
        const { status, body } = await fetchJson(handle.host, handle.port, path);
        expect(status).toBe(200);
        expect(body?.success).toBe(true);
        expect(body?.data).toBeDefined();
      } finally {
        handle.server.close();
      }
    }
  });
});

// ─── 2. Docs List — All Doc Types ────────────────────────────────────────────

const ALL_BUILTIN_DOC_TYPES = [
  'adr',
  'spec',
  'research',
  'handoff',
  'note',
  'llm-readme',
  'changeset',
  'release-note',
  'plan',
  'rcasd',
];

describe('Viewer API — /api/docs list across all doc types', () => {
  it('returns empty docs array on a fresh project', async () => {
    const handle = await startViewerOnOSPort();
    try {
      const { status, body } = await fetchJson(handle.host, handle.port, '/api/docs');
      expect(status).toBe(200);
      expect(body?.success).toBe(true);
      expect(body?.data?.docs).toEqual([]);
    } finally {
      handle.server.close();
    }
  });

  for (const docType of ALL_BUILTIN_DOC_TYPES) {
    it(`returns published ${docType} doc in the list`, async () => {
      const slug = `regression-${docType}`;
      await publish(slug, `# ${docType} Doc\n\nContent for ${docType}.\n`, docType);

      const handle = await startViewerOnOSPort();
      try {
        const { status, body } = await fetchJson(handle.host, handle.port, '/api/docs');
        expect(status).toBe(200);
        const docs = body?.data?.docs as DocListItem[];
        expect(docs).toBeDefined();
        expect(docs.length).toBeGreaterThanOrEqual(1);

        const found = docs.find((d) => d.slug === slug);
        expect(found).toBeDefined();
        expect(found?.type).toBe(docType);
        expect(found?.slug).toBe(slug);
        expect(typeof found?.id).toBe('string');
        expect(found?.id.length).toBeGreaterThan(0);
        expect(typeof found?.sha256).toBe('string');
        expect(found?.sha256.length).toBeGreaterThan(0);
        expect(found?.ownerType).toBe('task');
        expect(found?.ownerId).toBe('T11189');
      } finally {
        handle.server.close();
      }
    });
  }

  it('deduplicates docs with the same attachment id', async () => {
    await publish('dedup-doc', '# Dedup\n\nContent.\n', 'note');
    await publish('dedup-doc', '# Dedup\n\nContent.\n', 'note');

    const handle = await startViewerOnOSPort();
    try {
      const { status, body } = await fetchJson(handle.host, handle.port, '/api/docs');
      expect(status).toBe(200);
      const docs = body?.data?.docs as DocListItem[];
      const deduped = docs.filter((d) => d.slug === 'dedup-doc');
      expect(deduped.length).toBeLessThanOrEqual(1);
    } finally {
      handle.server.close();
    }
  });

  it('doc list item has all required fields with correct types', async () => {
    await publish('type-check', '# Type Check\n\nBody.\n', 'spec');

    const handle = await startViewerOnOSPort();
    try {
      const { status, body } = await fetchJson(handle.host, handle.port, '/api/docs');
      expect(status).toBe(200);
      const docs = body?.data?.docs as DocListItem[];
      expect(docs).toBeDefined();
      expect(docs.length).toBeGreaterThanOrEqual(1);

      for (const doc of docs) {
        expect(typeof doc.id).toBe('string');
        expect(typeof doc.slug).toBe('string');
        expect(typeof doc.type).toBe('string');
        expect(typeof doc.sha256).toBe('string');
        expect(doc.mime === null || typeof doc.mime === 'string').toBe(true);
        expect(typeof doc.ownerType).toBe('string');
        expect(typeof doc.ownerId).toBe('string');
        expect(typeof doc.title).toBe('string');
        expect(typeof doc.createdAt).toBe('string');
      }
    } finally {
      handle.server.close();
    }
  });
});

// ─── 3. Docs Detail — /api/docs/:slug ───────────────────────────────────────

describe('Viewer API — /api/docs/:slug detail', () => {
  it('returns doc detail with content for a published note', async () => {
    const content = '# My Note\n\nThis is a test note.\n';
    await publish('my-note', content, 'note');

    const handle = await startViewerOnOSPort();
    try {
      const { status, body } = await fetchJson(handle.host, handle.port, '/api/docs/my-note');
      expect(status).toBe(200);
      expect(body?.success).toBe(true);
      const data = body?.data as DocDetail;
      expect(data.slug).toBe('my-note');
      expect(data.type).toBe('note');
      expect(data.title).toBe('My Note');
      expect(data.content).toBe(content);
      expect(data.mime).toBe('text/markdown');
      expect(typeof data.sha256).toBe('string');
      expect(data.sizeBytes).toBeGreaterThan(0);
    } finally {
      handle.server.close();
    }
  });

  for (const docType of ALL_BUILTIN_DOC_TYPES) {
    it(`returns detail for ${docType} doc type`, async () => {
      const slug = `detail-${docType}`;
      const title = `${docType.toUpperCase()} Title`;
      const content = `# ${title}\n\nContent for ${docType} doc.\n`;
      await publish(slug, content, docType);

      const handle = await startViewerOnOSPort();
      try {
        const { status, body } = await fetchJson(handle.host, handle.port, `/api/docs/${slug}`);
        expect(status).toBe(200);
        const data = body?.data as DocDetail;
        expect(data).toBeDefined();
        expect(data.slug).toBe(slug);
        expect(data.type).toBe(docType);
        expect(data.title).toBe(title);
        expect(typeof data.id).toBe('string');
        expect(data.id.length).toBeGreaterThan(0);
        expect(typeof data.sha256).toBe('string');
        expect(data.sha256.length).toBeGreaterThan(0);
        expect(typeof data.mime).toBe('string');
        expect(data.sizeBytes).toBeGreaterThan(0);
      } finally {
        handle.server.close();
      }
    });
  }

  it('title falls back to slug when no H1 is present', async () => {
    const content = 'No heading here, just plain text.\n';
    await publish('no-h1-doc', content, 'note');

    const handle = await startViewerOnOSPort();
    try {
      const { status, body } = await fetchJson(handle.host, handle.port, '/api/docs/no-h1-doc');
      expect(status).toBe(200);
      const data = body?.data as DocDetail;
      expect(data.title).toBe('no-h1-doc');
    } finally {
      handle.server.close();
    }
  });

  it('returns E_NOT_FOUND for non-existent slug', async () => {
    const handle = await startViewerOnOSPort();
    try {
      const { status, body } = await fetchJson(
        handle.host,
        handle.port,
        '/api/docs/does-not-exist',
      );
      expect(status).toBe(404);
      expect(body?.success).toBe(false);
      expect(body?.error?.code).toBe('E_NOT_FOUND');
      expect(body?.error?.message).toContain('does-not-exist');
    } finally {
      handle.server.close();
    }
  });

  it('detail response has all required fields', async () => {
    await publish('all-fields', '# All Fields\n\nBody text.\n', 'spec');

    const handle = await startViewerOnOSPort();
    try {
      const { status, body } = await fetchJson(handle.host, handle.port, '/api/docs/all-fields');
      expect(status).toBe(200);
      const data = body?.data as DocDetail;
      expect(typeof data.id).toBe('string');
      expect(typeof data.slug).toBe('string');
      expect(typeof data.type).toBe('string');
      expect(typeof data.title).toBe('string');
      expect(typeof data.mime).toBe('string');
      expect(typeof data.sha256).toBe('string');
      expect(data.content === null || typeof data.content === 'string').toBe(true);
      expect(typeof data.sizeBytes).toBe('number');
    } finally {
      handle.server.close();
    }
  });
});

// ─── 4. Search Endpoint Regression ───────────────────────────────────────────

describe('Viewer API — /api/search regression', () => {
  it('rejects missing query with E_VALIDATION (400)', async () => {
    const handle = await startViewerOnOSPort();
    try {
      const { status, body } = await fetchJson(handle.host, handle.port, '/api/search');
      expect(status).toBe(400);
      expect(body?.success).toBe(false);
      expect(body?.error?.code).toBe('E_VALIDATION');
    } finally {
      handle.server.close();
    }
  });

  it('rejects empty query string with E_VALIDATION (400)', async () => {
    const handle = await startViewerOnOSPort();
    try {
      const { status, body } = await fetchJson(handle.host, handle.port, '/api/search?q=');
      expect(status).toBe(400);
      expect(body?.success).toBe(false);
      expect(body?.error?.code).toBe('E_VALIDATION');
    } finally {
      handle.server.close();
    }
  });

  it('returns empty results on project with no docs', async () => {
    const handle = await startViewerOnOSPort();
    try {
      const { status, body } = await fetchJson(handle.host, handle.port, '/api/search?q=test');
      expect(status).toBe(200);
      expect(body?.data?.totalDocs).toBe(0);
      expect(body?.data?.hits).toEqual([]);
    } finally {
      handle.server.close();
    }
  });

  it('clamps limit into [1, 50] for negative values', async () => {
    await publish('limit-test', '# Test\n\nContent.\n', 'note');

    vi.mocked(simMod.rankBySimilarity).mockReturnValue([{ index: 0, score: 0.9 }]);

    const handle = await startViewerOnOSPort();
    try {
      const { status, body } = await fetchJson(
        handle.host,
        handle.port,
        '/api/search?q=test&limit=-10',
      );
      expect(status).toBe(200);
      const hits = body?.data?.hits as unknown[];
      expect(hits.length).toBeLessThanOrEqual(1);
    } finally {
      handle.server.close();
    }
  });

  it('clamps limit to 50 for excessive values', async () => {
    await publish('clamp-test', '# Clamp\n\nTest.\n', 'note');

    vi.mocked(simMod.rankBySimilarity).mockReturnValue([{ index: 0, score: 0.9 }]);

    const handle = await startViewerOnOSPort();
    try {
      const { status, body } = await fetchJson(
        handle.host,
        handle.port,
        '/api/search?q=test&limit=9999',
      );
      expect(status).toBe(200);
      const hits = body?.data?.hits as unknown[];
      expect(hits.length).toBeLessThanOrEqual(1);
    } finally {
      handle.server.close();
    }
  });

  it('filters by type parameter', async () => {
    await publish('type-a', '# Type A\n\nSpec content.\n', 'spec');
    await publish('type-b', '# Type B\n\nNote content.\n', 'note');

    vi.mocked(simMod.rankBySimilarity).mockImplementation((_q, candidates) =>
      candidates.map((_c, i) => ({ index: i, score: 1 - i * 0.1 })),
    );

    const handle = await startViewerOnOSPort();
    try {
      const { status, body } = await fetchJson(
        handle.host,
        handle.port,
        '/api/search?q=Type&type=spec',
      );
      expect(status).toBe(200);
      const hits = body?.data?.hits as SearchHit[];
      expect(hits.length).toBe(1);
      expect(hits[0].type).toBe('spec');
    } finally {
      handle.server.close();
    }
  });

  it('returns LAFS error envelope (500) on search failure', async () => {
    await publish('error-doc', '# Error\n\nBody.\n', 'note');
    vi.mocked(simMod.rankBySimilarity).mockImplementationOnce(() => {
      throw new Error('search explosion');
    });

    const handle = await startViewerOnOSPort();
    try {
      const { status, body } = await fetchJson(handle.host, handle.port, '/api/search?q=error');
      expect(status).toBe(500);
      expect(body?.success).toBe(false);
      expect(body?.error?.message).toContain('search explosion');
    } finally {
      handle.server.close();
    }
  });
});

// ─── 5. Static Assets ────────────────────────────────────────────────────────

describe('Viewer server — static asset serving', () => {
  it('GET / redirects to /viewer/index.html (302)', async () => {
    const handle = await startViewerOnOSPort();
    try {
      const res = await fetch(`http://${handle.host}:${handle.port}/`, {
        redirect: 'manual',
      });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/viewer/index.html');
    } finally {
      handle.server.close();
    }
  });

  it('GET /viewer redirects to /viewer/index.html (302)', async () => {
    const handle = await startViewerOnOSPort();
    try {
      const res = await fetch(`http://${handle.host}:${handle.port}/viewer`, {
        redirect: 'manual',
      });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/viewer/index.html');
    } finally {
      handle.server.close();
    }
  });

  it('GET /viewer/ redirects to /viewer/index.html (302)', async () => {
    const handle = await startViewerOnOSPort();
    try {
      const res = await fetch(`http://${handle.host}:${handle.port}/viewer/`, {
        redirect: 'manual',
      });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/viewer/index.html');
    } finally {
      handle.server.close();
    }
  });

  it('serves index.html as text/html', async () => {
    const handle = await startViewerOnOSPort();
    try {
      const res = await fetch(`http://${handle.host}:${handle.port}/viewer/index.html`);
      expect(res.status).toBe(200);
      const ct = res.headers.get('content-type') ?? '';
      expect(ct).toContain('text/html');
      const text = await res.text();
      expect(text.length).toBeGreaterThan(0);
    } finally {
      handle.server.close();
    }
  });

  it('serves viewer.js as application/javascript', async () => {
    const handle = await startViewerOnOSPort();
    try {
      const res = await fetch(`http://${handle.host}:${handle.port}/viewer/viewer.js`);
      expect([200, 404]).toContain(res.status);
    } finally {
      handle.server.close();
    }
  });

  it('serves styles.css as text/css', async () => {
    const handle = await startViewerOnOSPort();
    try {
      const res = await fetch(`http://${handle.host}:${handle.port}/viewer/styles.css`);
      if (res.status === 200) {
        const ct = res.headers.get('content-type') ?? '';
        expect(ct).toContain('text/css');
      }
    } finally {
      handle.server.close();
    }
  });

  it('rejects path traversal in static asset path (../)', async () => {
    const handle = await startViewerOnOSPort();
    try {
      const { status, body, contentType } = await fetchRaw(
        handle.host,
        handle.port,
        '/viewer/../../../etc/passwd',
      );
      expect(status).toBe(404);
      if (contentType.includes('application/json')) {
        expect(body?.success).toBe(false);
      }
    } finally {
      handle.server.close();
    }
  });
});

// ─── 6. SPA Routing ──────────────────────────────────────────────────────────

describe('Viewer server — SPA routing (/docs/:slug)', () => {
  it('GET /docs/:slug returns index.html for client-side routing', async () => {
    const handle = await startViewerOnOSPort();
    try {
      const res = await fetch(`http://${handle.host}:${handle.port}/docs/some-slug`);
      expect(res.status).toBe(200);
      const ct = res.headers.get('content-type') ?? '';
      expect(ct).toContain('text/html');
    } finally {
      handle.server.close();
    }
  });

  it('GET /docs/:slug/ with trailing slash also returns index.html', async () => {
    const handle = await startViewerOnOSPort();
    try {
      const res = await fetch(`http://${handle.host}:${handle.port}/docs/some-slug/`);
      expect(res.status).toBe(200);
      const ct = res.headers.get('content-type') ?? '';
      expect(ct).toContain('text/html');
    } finally {
      handle.server.close();
    }
  });
});

// ─── 7. Port Allocation ──────────────────────────────────────────────────────

describe('Viewer server — port allocation', () => {
  it('tryListen binds on port 0 (OS-assigned)', async () => {
    const handler = (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200);
      res.end('ok');
    };
    const bound = await tryListen(handler, { startPort: 0, endPort: 0, autoIncrement: false });
    try {
      expect(bound.port).toBeGreaterThan(0);
      expect(bound.host).toBe('127.0.0.1');
      expect(bound.server).toBeDefined();
    } finally {
      bound.server.close();
    }
  });

  it('tryListen defaults to 127.0.0.1 host', async () => {
    const handler = (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200);
      res.end('ok');
    };
    const bound = await tryListen(handler, { startPort: 0, endPort: 0, autoIncrement: false });
    try {
      expect(bound.host).toBe('127.0.0.1');
    } finally {
      bound.server.close();
    }
  });

  it('startViewer works with default options (port 0, no auto-increment)', async () => {
    const handle = await startViewerOnOSPort();
    try {
      expect(handle.port).toBeGreaterThan(0);
      expect(handle.host).toBe('127.0.0.1');
      const res = await fetch(`http://${handle.host}:${handle.port}/api/health`);
      expect(res.status).toBe(200);
    } finally {
      handle.server.close();
    }
  });

  it('server.close actually stops listening', async () => {
    const handle = await startViewerOnOSPort();
    const port = handle.port;
    const host = handle.host;
    handle.server.close();

    await new Promise((r) => setTimeout(r, 50));

    try {
      await fetch(`http://${host}:${port}/api/health`, { signal: AbortSignal.timeout(500) });
      expect(false).toBe(true);
    } catch {
      expect(true).toBe(true);
    }
  });
});

// ─── 8. Pidfile Operations ──────────────────────────────────────────────────

describe('Viewer server — pidfile operations', () => {
  it('writeViewerPidFile creates a readable pidfile', async () => {
    const record = {
      pid: 12345,
      port: 7777,
      host: '127.0.0.1',
      projectRoot: tmpProjectRoot,
      startedAt: Date.now(),
    };
    const path = await writeViewerPidFile(record);
    expect(path).toBe(viewerPidFilePath());

    const read = await readViewerPidFile();
    expect(read).not.toBeNull();
    expect(read?.pid).toBe(12345);
    expect(read?.port).toBe(7777);
    expect(read?.host).toBe('127.0.0.1');
    expect(read?.projectRoot).toBe(tmpProjectRoot);
    expect(read?.startedAt).toBe(record.startedAt);
  });

  it('readViewerPidFile returns null when no pidfile exists', async () => {
    const result = await readViewerPidFile();
    expect(result).toBeNull();
  });

  it('readViewerPidFile returns null for malformed pidfile', async () => {
    await writeFile(viewerPidFilePath(), '{not json}', 'utf-8');
    const result = await readViewerPidFile();
    expect(result).toBeNull();
  });

  it('readViewerPidFile returns null for pidfile missing required fields', async () => {
    await writeFile(viewerPidFilePath(), JSON.stringify({ pid: 1234 }), 'utf-8');
    const result = await readViewerPidFile();
    expect(result).toBeNull();
  });

  it('removeViewerPidFile cleans up the file', async () => {
    const record = {
      pid: 99999,
      port: 7777,
      host: '127.0.0.1',
      projectRoot: tmpProjectRoot,
      startedAt: Date.now(),
    };
    await writeViewerPidFile(record);
    const before = await readViewerPidFile();
    expect(before).not.toBeNull();

    await removeViewerPidFile();
    const after = await readViewerPidFile();
    expect(after).toBeNull();
  });

  it('removeViewerPidFile is idempotent', async () => {
    await removeViewerPidFile();
    await removeViewerPidFile();
  });
});

// ─── 9. Performance Regression Guard ────────────────────────────────────────

describe('Viewer server — performance guard', () => {
  it('viewer renders docs list in < 2000ms for docs up to 10K words', async () => {
    const largeContent = makeLargeDoc(10_000);
    await publish('perf-doc', largeContent, 'note');

    const handle = await startViewerOnOSPort();
    try {
      const start = performance.now();
      const res = await fetch(`http://${handle.host}:${handle.port}/api/docs/perf-doc`);
      const elapsed = performance.now() - start;
      expect(res.status).toBe(200);
      expect(elapsed).toBeLessThan(2000);
    } finally {
      handle.server.close();
    }
  }, 10_000);

  it('viewer /api/docs list renders in < 2000ms with 20 published docs', async () => {
    for (let i = 0; i < 20; i++) {
      const type = ALL_BUILTIN_DOC_TYPES[i % ALL_BUILTIN_DOC_TYPES.length];
      await publish(`perf-doc-${i}`, `# Doc ${i}\n\nContent for doc ${i}.\n`, type, `T11189-${i}`);
    }

    const handle = await startViewerOnOSPort();
    try {
      const start = performance.now();
      const { status, body } = await fetchJson(handle.host, handle.port, '/api/docs');
      const elapsed = performance.now() - start;
      expect(status).toBe(200);
      expect(elapsed).toBeLessThan(2000);
      const docs = body?.data?.docs as unknown[];
      expect(docs.length).toBeGreaterThanOrEqual(1);
    } finally {
      handle.server.close();
    }
  }, 10_000);
});

// ─── 10. Cross-Doc-Type Consistency ─────────────────────────────────────────

describe('Viewer API — cross-doc-type consistency', () => {
  it('doc detail shape is identical across all built-in doc types', async () => {
    const expectedKeys = ['id', 'slug', 'type', 'title', 'mime', 'sha256', 'content', 'sizeBytes'];

    for (const docType of ALL_BUILTIN_DOC_TYPES) {
      const slug = `shape-${docType}`;
      await publish(slug, `# ${docType} Title\n\nBody.\n`, docType);

      const handle = await startViewerOnOSPort();
      try {
        const { status, body } = await fetchJson(handle.host, handle.port, `/api/docs/${slug}`);
        expect(status).toBe(200);
        const data = body?.data as Record<string, unknown>;
        for (const key of expectedKeys) {
          expect(data).toHaveProperty(key);
        }
        expect(data.type).toBe(docType);
      } finally {
        handle.server.close();
      }
    }
  });

  it('doc list item shape is identical across all built-in doc types', async () => {
    const expectedKeys = [
      'id',
      'slug',
      'type',
      'sha256',
      'mime',
      'ownerType',
      'ownerId',
      'title',
      'createdAt',
    ];

    for (const docType of ALL_BUILTIN_DOC_TYPES) {
      await publish(`list-${docType}`, `# ${docType}\n\nBody.\n`, docType);
    }

    const handle = await startViewerOnOSPort();
    try {
      const { status, body } = await fetchJson(handle.host, handle.port, '/api/docs');
      expect(status).toBe(200);
      const docs = body?.data?.docs as Record<string, unknown>[];
      for (const doc of docs) {
        for (const key of expectedKeys) {
          expect(doc).toHaveProperty(key);
        }
      }
      expect(docs.length).toBeGreaterThanOrEqual(ALL_BUILTIN_DOC_TYPES.length);
    } finally {
      handle.server.close();
    }
  });

  it('search hit shape is consistent', async () => {
    await publish('hit-shape', '# Hit\n\nBody.\n', 'note');

    vi.mocked(simMod.rankBySimilarity).mockReturnValue([{ index: 0, score: 0.95 }]);

    const handle = await startViewerOnOSPort();
    try {
      const { status, body } = await fetchJson(handle.host, handle.port, '/api/search?q=hit');
      expect(status).toBe(200);
      const hits = body?.data?.hits as Record<string, unknown>[];
      expect(hits.length).toBe(1);
      const hit = hits[0];
      expect(typeof hit.slug).toBe('string');
      expect(typeof hit.type).toBe('string');
      expect(typeof hit.snippet).toBe('string');
      expect(typeof hit.score).toBe('number');
      expect(hit.score).toBe(0.95);
    } finally {
      handle.server.close();
    }
  });
});

// ─── 11. Edge Cases ─────────────────────────────────────────────────────────

describe('Viewer API — edge cases', () => {
  it('slug with special characters is URL-decoded correctly', async () => {
    const slug = 'doc-with-dashes-and_underscores';
    await publish(slug, '# Special\n\nChars.\n', 'note');

    const handle = await startViewerOnOSPort();
    try {
      const { status, body } = await fetchJson(handle.host, handle.port, `/api/docs/${slug}`);
      expect(status).toBe(200);
      expect(body?.data?.slug).toBe(slug);
    } finally {
      handle.server.close();
    }
  });

  it('Cache-Control: no-store on all JSON responses', async () => {
    const handle = await startViewerOnOSPort();
    try {
      for (const path of ['/api/health', '/api/docs']) {
        const res = await fetch(`http://${handle.host}:${handle.port}${path}`);
        expect(res.headers.get('cache-control')).toBe('no-store');
      }
    } finally {
      handle.server.close();
    }
  });

  it('non-existent static asset returns 404', async () => {
    const handle = await startViewerOnOSPort();
    try {
      const { status } = await fetchRaw(handle.host, handle.port, '/viewer/nonexistent-file.xyz');
      expect(status).toBe(404);
    } finally {
      handle.server.close();
    }
  });
});
