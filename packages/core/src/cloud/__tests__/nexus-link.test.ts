/**
 * `cleo project link` engine (T12712): registers the project with Nexus by id
 * and name label only, never a path, idempotently, and binds the remote
 * project id to the local one in `.cleo/nexus-link.json`.
 *
 * @task T12712
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileNexusTokenStore } from '../nexus-credentials.js';
import {
  linkProjectToNexus,
  nexusLinkPath,
  readNexusProjectLink,
  validateNexusProjectLabel,
} from '../nexus-link.js';

const API = 'https://api.nexus.test';
const TOKEN = 'tok_SECRET_link_token_0123456789abcdef';
const PROJECT_ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const ORG_ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';

let projectRoot: string;
let store: FileNexusTokenStore;
let savedCleoDir: string | undefined;

/** A mock `/v1/projects` that behaves like the server: 201 on create, 200 on update. */
function mockProjects(opts: { status?: number } = {}) {
  const bodies: Array<Record<string, unknown>> = [];
  const registered = new Set<string>();
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    bodies.push(body);
    if (opts.status === 401) {
      return new Response(
        JSON.stringify({
          success: false,
          error: { code: 'E_UNAUTHENTICATED', message: 'sign in required', requestId: 'r' },
        }),
        { status: 401 },
      );
    }
    if (opts.status === 409) {
      return new Response(
        JSON.stringify({
          success: false,
          error: {
            code: 'E_CONFLICT',
            message: 'this project id is registered to another account',
            requestId: 'r',
            details: { remedy: 'ask the owner to share the project' },
          },
        }),
        { status: 409 },
      );
    }
    expect(new URL(url).pathname).toBe('/v1/projects');
    const created = !registered.has(String(body['projectId']));
    registered.add(String(body['projectId']));
    return new Response(
      JSON.stringify({
        success: true,
        data: {
          project: {
            projectId: body['projectId'],
            label: body['label'] ?? null,
            encryptedName: null,
            remoteUrl: null,
            organizationId: ORG_ID,
            createdByUserId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d',
            createdAt: '2026-09-28T00:00:00.000Z',
          },
          streamId: `project:${body['projectId']}`,
        },
        meta: { requestId: 'r' },
      }),
      { status: created ? 201 : 200 },
    );
  });
  return { fetchImpl, bodies };
}

beforeEach(async () => {
  const base = mkdtempSync(join(tmpdir(), 'nexus-link-'));
  projectRoot = join(base, 'my-project');
  mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
  writeFileSync(
    join(projectRoot, '.cleo', 'project-info.json'),
    JSON.stringify({ projectId: PROJECT_ID, projectHash: 'abcdef012345' }),
  );
  // vitest.setup pins CLEO_DIR to a per-fork project; point it at this fixture.
  savedCleoDir = process.env['CLEO_DIR'];
  process.env['CLEO_DIR'] = join(projectRoot, '.cleo');
  store = new FileNexusTokenStore(join(base, 'nexus-credentials.json'));
  await store.put(API, {
    token: TOKEN,
    tokenType: 'Bearer',
    expiresAt: null,
    user: null,
    organization: null,
  });
});

afterEach(() => {
  if (savedCleoDir === undefined) delete process.env['CLEO_DIR'];
  else process.env['CLEO_DIR'] = savedCleoDir;
});

describe('linkProjectToNexus', () => {
  it('sends the project id and a name label only — never a path', async () => {
    const { fetchImpl, bodies } = mockProjects();
    const result = await linkProjectToNexus({ apiUrl: API, store, projectRoot, fetch: fetchImpl });

    expect(bodies).toEqual([{ projectId: PROJECT_ID, label: 'my-project' }]);
    const wire = JSON.stringify(bodies);
    expect(wire).not.toContain(projectRoot);
    expect(wire).not.toContain(tmpdir());
    expect(wire).not.toMatch(/[/\\]/);
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
    });

    expect(result.link).toMatchObject({
      apiUrl: API,
      localProjectId: PROJECT_ID,
      remoteProjectId: PROJECT_ID,
      organizationId: ORG_ID,
      label: 'my-project',
      streamId: `project:${PROJECT_ID}`,
    });
    expect(result.alreadyLinked).toBe(false);
    expect(result.linkPath).toBe(nexusLinkPath(projectRoot));
    expect(readNexusProjectLink(projectRoot, API)?.remoteProjectId).toBe(PROJECT_ID);
    expect(readFileSync(result.linkPath, 'utf-8')).not.toContain(TOKEN);
  });

  it('is idempotent: a second link re-registers the same id and reports alreadyLinked', async () => {
    const { fetchImpl, bodies } = mockProjects();
    await linkProjectToNexus({ apiUrl: API, store, projectRoot, fetch: fetchImpl });
    const again = await linkProjectToNexus({ apiUrl: API, store, projectRoot, fetch: fetchImpl });

    expect(again.alreadyLinked).toBe(true);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual(bodies[1]);
    const file = JSON.parse(readFileSync(again.linkPath, 'utf-8')) as {
      links: Record<string, unknown>;
    };
    expect(Object.keys(file.links)).toEqual([API]);
  });

  it('uses --name as the label and refuses path-like labels', async () => {
    const { fetchImpl, bodies } = mockProjects();
    await linkProjectToNexus({
      apiUrl: API,
      store,
      projectRoot,
      name: 'Team Board',
      fetch: fetchImpl,
    });
    expect(bodies[0]).toEqual({ projectId: PROJECT_ID, label: 'Team Board' });

    for (const bad of ['/Users/me/repo', 'a/b', 'C:\\repo', '~/repo', '', 'x'.repeat(121)]) {
      await expect(
        linkProjectToNexus({ apiUrl: API, store, projectRoot, name: bad, fetch: fetchImpl }),
      ).rejects.toMatchObject({ code: 'E_NEXUS_INVALID_LABEL' });
    }
    expect(bodies).toHaveLength(1);
    expect(validateNexusProjectLabel('  ok-name ')).toBe('ok-name');
  });

  it('requires a signed-in session', async () => {
    const empty = new FileNexusTokenStore(join(projectRoot, 'none.json'));
    const { fetchImpl } = mockProjects();
    await expect(
      linkProjectToNexus({ apiUrl: API, store: empty, projectRoot, fetch: fetchImpl }),
    ).rejects.toMatchObject({ code: 'E_NEXUS_NOT_SIGNED_IN' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a 401 means the session expired', async () => {
    const { fetchImpl } = mockProjects({ status: 401 });
    await expect(
      linkProjectToNexus({ apiUrl: API, store, projectRoot, fetch: fetchImpl }),
    ).rejects.toMatchObject({ code: 'E_NEXUS_SESSION_EXPIRED' });
  });

  it('passes a server refusal through with its remedy', async () => {
    const { fetchImpl } = mockProjects({ status: 409 });
    await expect(
      linkProjectToNexus({ apiUrl: API, store, projectRoot, fetch: fetchImpl }),
    ).rejects.toMatchObject({
      code: 'E_NEXUS_REQUEST_FAILED',
      fix: 'ask the owner to share the project',
    });
  });
});
