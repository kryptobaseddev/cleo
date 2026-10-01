/**
 * `cleo project link` engine (T12712): registers the project with Nexus under
 * its tracked `.cleo/project-id` and its display name as a plaintext label,
 * never a path, idempotently; re-linking after a rename updates the label.
 *
 * The mock `/v1/projects` behaves like the server
 * (cleo-nexus `apps/api/src/routes/projects.ts`): 201 on first registration,
 * 200 on a repeat, where `label: body.label ?? existing.label`.
 *
 * @task T12712
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProjectDisplayName } from '../../project-info.js';
import { withLock } from '../../store/file-utils.js';
import { FileNexusTokenStore } from '../nexus-credentials.js';
import {
  linkProjectToNexus,
  nexusLinkPath,
  readNexusProjectLink,
  validateNexusProjectLabel,
} from '../nexus-link.js';

vi.mock('../../store/file-utils.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../store/file-utils.js')>();
  return { ...real, withLock: vi.fn(real.withLock) };
});

const API = 'https://api.nexus.test';
const TOKEN = 'tok_SECRET_link_token_0123456789abcdef';
/** The tracked identity (`.cleo/project-id`): the id the server keys on. */
const PROJECT_ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
/** A different id in project-info.json, to prove it is NOT the one sent. */
const INFO_ID = 'c78d09c3a8ee';
const ORG_ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';

let base: string;
let projectRoot: string;
let store: FileNexusTokenStore;
let savedCleoDir: string | undefined;

function writeInfo(fields: Record<string, unknown>): void {
  writeFileSync(
    join(projectRoot, '.cleo', 'project-info.json'),
    JSON.stringify({ projectId: INFO_ID, projectHash: 'abcdef012345', ...fields }),
  );
}

/** A mock `/v1/projects` with the server's create/update semantics. */
function mockProjects(opts: { status?: 401 | 409 } = {}) {
  const bodies: Array<Record<string, unknown>> = [];
  const labels = new Map<string, string | null>();
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
    const id = String(body['projectId']);
    const created = !labels.has(id);
    const label =
      typeof body['label'] === 'string' ? body['label'] : created ? null : (labels.get(id) ?? null);
    labels.set(id, label);
    return new Response(
      JSON.stringify({
        success: true,
        data: {
          project: {
            projectId: id,
            label,
            encryptedName: null,
            remoteUrl: null,
            organizationId: ORG_ID,
            createdByUserId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d',
            createdAt: '2026-09-28T00:00:00.000Z',
          },
          streamId: `project:${id}`,
        },
        meta: { requestId: 'r' },
      }),
      { status: created ? 201 : 200 },
    );
  });
  return { fetchImpl, bodies, labels };
}

// These tests cover the 9.24 session path: pin device credentials off and
// sandbox CLEO_HOME so no test reads the real nexus-device.json (T12904).
let savedDeviceFlag: string | undefined;
let savedCleoHome: string | undefined;
let pinnedHome: string;
beforeEach(() => {
  savedDeviceFlag = process.env['CLEO_NEXUS_DEVICE'];
  savedCleoHome = process.env['CLEO_HOME'];
  process.env['CLEO_NEXUS_DEVICE'] = '0';
  // Status and logout read nexus-device.json whatever the switch says: point
  // CLEO_HOME at an empty sandbox so no test ever reads the real one.
  pinnedHome = mkdtempSync(join(tmpdir(), 'cleo-home-pin-'));
  process.env['CLEO_HOME'] = pinnedHome;
});
afterEach(() => {
  if (savedDeviceFlag === undefined) delete process.env['CLEO_NEXUS_DEVICE'];
  else process.env['CLEO_NEXUS_DEVICE'] = savedDeviceFlag;
  if (savedCleoHome === undefined) delete process.env['CLEO_HOME'];
  else process.env['CLEO_HOME'] = savedCleoHome;
  rmSync(pinnedHome, { recursive: true, force: true });
});

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'nexus-link-'));
  projectRoot = join(base, 'my-project');
  mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
  writeFileSync(join(projectRoot, '.cleo', 'project-id'), `${PROJECT_ID}\n`);
  writeInfo({ name: 'Team Board' });
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

describe('.cleo/.gitignore template', () => {
  it('denies nexus-link.json explicitly, so fresh `cleo init` projects never commit it', () => {
    const template = readFileSync(
      fileURLToPath(new URL('../../../templates/cleo-gitignore', import.meta.url)),
      'utf-8',
    );
    expect(template).toMatch(/^nexus-link\.json$/m);
    expect(template).not.toMatch(/^!nexus-link\.json$/m);
  });
});

describe('getProjectDisplayName', () => {
  it('reads project-info name, then legacy projectName, then the directory name', () => {
    expect(getProjectDisplayName(projectRoot)).toBe('Team Board');
    writeInfo({ projectName: 'Legacy Name' });
    expect(getProjectDisplayName(projectRoot)).toBe('Legacy Name');
    writeInfo({});
    expect(getProjectDisplayName(projectRoot)).toBe('my-project');
  });
});

describe('linkProjectToNexus', () => {
  it('sends the tracked project id and the display name in plaintext — never a path', async () => {
    const { fetchImpl, bodies } = mockProjects();
    const result = await linkProjectToNexus({ apiUrl: API, store, projectRoot, fetch: fetchImpl });

    expect(bodies).toEqual([{ projectId: PROJECT_ID, label: 'Team Board' }]);
    const wire = JSON.stringify(bodies);
    expect(wire).not.toContain(INFO_ID);
    expect(wire).not.toContain(base);
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
      label: 'Team Board',
      streamId: `project:${PROJECT_ID}`,
    });
    expect(result.alreadyLinked).toBe(false);
    expect(result.linkPath).toBe(nexusLinkPath(projectRoot));
    expect(readNexusProjectLink(projectRoot, API)?.remoteProjectId).toBe(PROJECT_ID);
    expect(readFileSync(result.linkPath, 'utf-8')).not.toContain(TOKEN);
  });

  it('is idempotent: a repeat link answers 200 and reports alreadyLinked', async () => {
    const { fetchImpl, bodies } = mockProjects();
    await linkProjectToNexus({ apiUrl: API, store, projectRoot, fetch: fetchImpl });
    const again = await linkProjectToNexus({ apiUrl: API, store, projectRoot, fetch: fetchImpl });

    expect(again.alreadyLinked).toBe(true);
    expect(bodies).toEqual([
      { projectId: PROJECT_ID, label: 'Team Board' },
      { projectId: PROJECT_ID, label: 'Team Board' },
    ]);
    const file = JSON.parse(readFileSync(again.linkPath, 'utf-8')) as {
      links: Record<string, unknown>;
    };
    expect(Object.keys(file.links)).toEqual([API]);
  });

  it('re-linking after a rename sends the new name and updates the server label', async () => {
    const { fetchImpl, bodies, labels } = mockProjects();
    await linkProjectToNexus({ apiUrl: API, store, projectRoot, fetch: fetchImpl });
    writeInfo({ name: 'Renamed Board' });
    const again = await linkProjectToNexus({ apiUrl: API, store, projectRoot, fetch: fetchImpl });

    expect(bodies[1]).toEqual({ projectId: PROJECT_ID, label: 'Renamed Board' });
    expect(labels.get(PROJECT_ID)).toBe('Renamed Board');
    expect(again.link.label).toBe('Renamed Board');
    expect(readNexusProjectLink(projectRoot, API)?.label).toBe('Renamed Board');
  });

  it('--label overrides the name; path-like labels are refused before any request', async () => {
    const { fetchImpl, bodies } = mockProjects();
    await linkProjectToNexus({ apiUrl: API, store, projectRoot, label: 'Ops', fetch: fetchImpl });
    expect(bodies[0]).toEqual({ projectId: PROJECT_ID, label: 'Ops' });

    for (const bad of ['/Users/me/repo', 'a/b', 'C:\\repo', '~/repo', '', 'x'.repeat(121)]) {
      await expect(
        linkProjectToNexus({ apiUrl: API, store, projectRoot, label: bad, fetch: fetchImpl }),
      ).rejects.toMatchObject({ code: 'E_NEXUS_INVALID_LABEL' });
    }
    expect(bodies).toHaveLength(1);
    expect(validateNexusProjectLabel('  ok-name ')).toBe('ok-name');
  });

  it('requires a signed-in session', async () => {
    const empty = new FileNexusTokenStore(join(base, 'none.json'));
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

  it('passes a server refusal (409) through with its remedy', async () => {
    const { fetchImpl } = mockProjects({ status: 409 });
    await expect(
      linkProjectToNexus({ apiUrl: API, store, projectRoot, fetch: fetchImpl }),
    ).rejects.toMatchObject({
      code: 'E_NEXUS_REQUEST_FAILED',
      fix: 'ask the owner to share the project',
    });
  });

  it('retries the registration once on 409 project-id-taken (T12868, contract §4.0.4 N3)', async () => {
    const { fetchImpl: real, bodies } = mockProjects();
    let first = true;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      if (first) {
        first = false;
        return new Response(
          JSON.stringify({
            success: false,
            error: {
              code: 'E_CONFLICT',
              message: 'registered concurrently',
              requestId: 'r',
              details: { reason: 'project-id-taken' },
            },
          }),
          { status: 409 },
        );
      }
      return real(url, init);
    });
    const result = await linkProjectToNexus({ apiUrl: API, store, projectRoot, fetch: fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(bodies).toHaveLength(1);
    expect(result.link.remoteProjectId).toBe(PROJECT_ID);
  });

  it('does not retry a second project-id-taken, and never retries another 409', async () => {
    const conflict = (reason: string) =>
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: false,
              error: { code: 'E_CONFLICT', message: reason, requestId: 'r', details: { reason } },
            }),
            { status: 409 },
          ),
      );
    const taken = conflict('project-id-taken');
    await expect(
      linkProjectToNexus({ apiUrl: API, store, projectRoot, fetch: taken }),
    ).rejects.toMatchObject({ code: 'E_NEXUS_REQUEST_FAILED' });
    expect(taken).toHaveBeenCalledTimes(2);
    const other = conflict('project-other-account');
    await expect(
      linkProjectToNexus({ apiUrl: API, store, projectRoot, fetch: other }),
    ).rejects.toMatchObject({ code: 'E_NEXUS_REQUEST_FAILED' });
    expect(other).toHaveBeenCalledTimes(1);
  });
});

describe('label privacy (T12712 review item 8)', () => {
  it('refuses drive-letter and Unicode look-alike slash labels', async () => {
    const { fetchImpl, bodies } = mockProjects();
    for (const bad of [
      'C:foo',
      'c:',
      'a\uFF0Fb',
      'a\u2215b',
      'a\u29F8b',
      'a\u2044b',
      'a\uFF3Cb',
      'a\u29F9b',
    ]) {
      await expect(
        linkProjectToNexus({ apiUrl: API, store, projectRoot, label: bad, fetch: fetchImpl }),
      ).rejects.toMatchObject({ code: 'E_NEXUS_INVALID_LABEL' });
    }
    expect(bodies).toHaveLength(0);
  });

  it('refuses the OS username as a label (it would leak the account name)', async () => {
    const username = userInfo().username;
    const { fetchImpl, bodies } = mockProjects();
    await expect(
      linkProjectToNexus({ apiUrl: API, store, projectRoot, label: username, fetch: fetchImpl }),
    ).rejects.toMatchObject({
      code: 'E_NEXUS_INVALID_LABEL',
      fix: expect.stringContaining('--label'),
    });
    writeInfo({ name: username });
    await expect(
      linkProjectToNexus({ apiUrl: API, store, projectRoot, fetch: fetchImpl }),
    ).rejects.toMatchObject({ code: 'E_NEXUS_INVALID_LABEL' });
    expect(bodies).toHaveLength(0);
  });

  it('refuses a default label when the project root is the home directory', async () => {
    const savedHome = process.env['HOME'];
    process.env['HOME'] = projectRoot;
    try {
      const { fetchImpl, bodies } = mockProjects();
      await expect(
        linkProjectToNexus({ apiUrl: API, store, projectRoot, fetch: fetchImpl }),
      ).rejects.toMatchObject({
        code: 'E_NEXUS_INVALID_LABEL',
        fix: expect.stringContaining('--label'),
      });
      expect(bodies).toHaveLength(0);
      // An explicit label is the user's choice and goes through.
      await linkProjectToNexus({
        apiUrl: API,
        store,
        projectRoot,
        label: 'Board',
        fetch: fetchImpl,
      });
      expect(bodies).toEqual([{ projectId: PROJECT_ID, label: 'Board' }]);
    } finally {
      if (savedHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = savedHome;
    }
  });
});

describe('link file concurrency (T12712 review item 9)', () => {
  it('reads and writes nexus-link.json under the file lock', async () => {
    const { fetchImpl } = mockProjects();
    vi.mocked(withLock).mockClear();
    const result = await linkProjectToNexus({ apiUrl: API, store, projectRoot, fetch: fetchImpl });
    expect(vi.mocked(withLock).mock.calls.map((c) => c[0])).toContain(result.linkPath);
  });
});
