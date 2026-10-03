/**
 * The account's projects by name (T13102): display names (decrypted
 * `encryptedName`, label, id), the restore command the first run prints, and
 * the resolution behind `cleo cloud restore <name>` (unique, case-insensitive,
 * ambiguous, none, ids). `GET /v1/projects` is a routing mock; the decryption
 * with the real account key is covered against the fake Cleo Nexus in
 * `nexus-vault.test.ts` ("guided first run").
 *
 * @task T13102
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecryptError, generateEd25519, generateX25519, randomKey } from '../crypto.js';
import type { FetchLike } from '../http.js';
import { openProjectName, sealProjectName } from '../keys.js';
import { NEXUS_API_URL_ENV } from '../nexus-auth.js';
import { FileNexusTokenStore } from '../nexus-credentials.js';
import {
  applyEnrolment,
  NEXUS_DEVICE_ENV,
  NexusDeviceEnrolment,
  NexusDeviceStore,
} from '../nexus-device.js';
import {
  listNexusNamedProjects,
  matchNexusProjects,
  type NexusNamedProjectsOptions,
  NexusProjectRefError,
  resolveNexusProjectRef,
  safeNexusProjectName,
  shellQuoteWord,
  W_NEXUS_PROJECT_NAME_LOCKED,
} from '../nexus-project-names.js';

const API = 'https://api.nexus.test';
const USER = '0198a1b2-0000-7000-8000-0000000000aa';
const DEVICE = '0198a1b2-0000-7000-8000-0000000000d1';
const OTHER_DEVICE = '0198a1b2-0000-7000-8000-0000000000d2';
const ORG = '0198a1b2-0000-7000-8000-0000000000f1';
const NOW = '2026-10-02T12:00:00.000Z';
const P1 = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a01';
const P2 = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a02';
const P3 = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a03';
const LEGACY = 'c78d09c3a8ee';

let base: string;
let home: string;
let devices: NexusDeviceStore;
let sessions: FileNexusTokenStore;
let saved: Record<string, string | undefined>;

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), 'nexus-names-'));
  home = join(base, 'cleo-home');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  saved = {
    [NEXUS_DEVICE_ENV]: process.env[NEXUS_DEVICE_ENV],
    [NEXUS_API_URL_ENV]: process.env[NEXUS_API_URL_ENV],
    CLEO_HOME: process.env['CLEO_HOME'],
  };
  process.env[NEXUS_DEVICE_ENV] = '1';
  process.env['CLEO_HOME'] = home;
  process.env[NEXUS_API_URL_ENV] = API;
  devices = new NexusDeviceStore(join(home, 'nexus-device.json'), {
    cleoHome: home,
    lockWaitMs: 10_000,
  });
  sessions = new FileNexusTokenStore(join(home, 'nexus-credentials.json'));
  const token = `cnx_d1_${randomBytes(32).toString('base64url')}`;
  const enc = generateX25519();
  const sig = generateEd25519();
  await devices.update((tx) => {
    tx.set(
      API,
      USER,
      applyEnrolment(
        tx.get(API, USER),
        new NexusDeviceEnrolment({
          deviceId: DEVICE,
          keys: {
            encryption: {
              publicKey: enc.publicKey.toString('base64'),
              privateKey: enc.privateKey.toString('base64'),
            },
            signing: {
              publicKey: sig.publicKey.toString('base64'),
              privateKey: sig.privateKey.toString('base64'),
            },
          },
          credential: {
            credentialId: '0198a1b2-0000-7000-8000-0000000000c1',
            token,
            profile: 'device',
            scopes: ['account:read', 'devices:read', 'projects:read'],
            createdAt: NOW,
          },
        }),
      ),
    );
  });
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(base, { recursive: true, force: true });
});

interface Item {
  projectId: string;
  label: string | null;
  encryptedName?: string | null;
  headCheckpointId?: string | null;
  replicaDevices?: string[];
}

function listItem(i: Item): Record<string, unknown> {
  return {
    projectId: i.projectId,
    label: i.label,
    encryptedName: i.encryptedName ?? null,
    remoteUrl: null,
    organizationId: ORG,
    organizationName: 'Personal',
    createdByUserId: USER,
    createdAt: NOW,
    role: 'owner',
    streamId: `project:${i.projectId}`,
    headSeq: 3,
    ...(i.headCheckpointId !== undefined ? { headCheckpointId: i.headCheckpointId } : {}),
    openConflicts: 0,
    replicas: (i.replicaDevices ?? []).map((deviceId, n) => ({
      projectId: i.projectId,
      replicaId: `0198a1b2-0000-7000-8000-00000000${String(n).padStart(4, '0')}`,
      deviceId,
      deviceName: 'laptop',
      deviceState: 'active',
      attachedAt: NOW,
      lastSyncAt: NOW,
      presence: null,
      presenceAt: NOW,
    })),
    devices: { active: 1, total: 1 },
    replicaCount: (i.replicaDevices ?? []).length,
    lastSyncAt: NOW,
    lastPresenceAt: NOW,
    replicasTruncated: false,
  };
}

/** `GET /v1/projects` answering `items` in one page; counts the requests. */
function server(items: Item[]): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    if (url.pathname !== '/v1/projects') {
      return new Response(
        JSON.stringify({
          success: false,
          error: { code: 'E_NOT_FOUND', message: 'route not found', requestId: 'r' },
        }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(
      JSON.stringify({
        success: true,
        data: { projects: items.map(listItem), nextCursor: null, truncated: false },
        meta: { requestId: 'r' },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  return { fetch, calls };
}

function opts(
  fetch: FetchLike,
  extra: Partial<NexusNamedProjectsOptions> = {},
): NexusNamedProjectsOptions {
  return { apiUrl: API, fetch, deviceStore: devices, store: sessions, ...extra };
}

/** An opener that never succeeds: names stay locked. */
const lockedOpener = async (): Promise<string> => {
  throw new Error('the account key is not available');
};

async function refError(p: Promise<object>): Promise<NexusProjectRefError> {
  const err = await p.then(
    () => null,
    (e: Error) => e,
  );
  expect(err).toBeInstanceOf(NexusProjectRefError);
  return err as NexusProjectRefError;
}

describe('project name sealing', () => {
  it('opens with the same data key and project, and fails for another project or key', () => {
    const pdk = randomKey();
    const sealed = sealProjectName(pdk, P1, 'Secret Board');
    expect(Buffer.from(sealed, 'base64').toString('utf8')).not.toContain('Secret Board');
    expect(openProjectName(pdk, P1, sealed)).toBe('Secret Board');
    expect(() => openProjectName(pdk, P2, sealed)).toThrow(DecryptError);
    expect(() => openProjectName(randomKey(), P1, sealed)).toThrow(DecryptError);
  });
});

describe('display names', () => {
  it('uses the decrypted name, then the label, then the id', async () => {
    const pdk = randomKey();
    const s = server([
      {
        projectId: P1,
        label: 'public-label',
        encryptedName: sealProjectName(pdk, P1, 'Real Name'),
      },
      { projectId: P2, label: 'board', headCheckpointId: 'cp-2' },
      { projectId: P3, label: null, headCheckpointId: 'cp-3' },
    ]);
    const r = await listNexusNamedProjects(
      opts(s.fetch, { openName: async (id, enc) => openProjectName(pdk, id, enc) }),
    );
    expect(r.projects.map((p) => [p.name, p.nameSource])).toEqual([
      ['Real Name', 'encrypted-name'],
      ['board', 'label'],
      [P3, 'id'],
    ]);
    expect(r.warnings).toEqual([]);
    expect(s.calls.every((c) => c.startsWith('GET '))).toBe(true);
  });

  it('a name that does not open falls back to the label with one warning', async () => {
    const s = server([
      { projectId: P1, label: 'one', encryptedName: 'AAAA' },
      { projectId: P2, label: 'two', encryptedName: 'BBBB' },
    ]);
    const r = await listNexusNamedProjects(opts(s.fetch, { openName: lockedOpener }));
    expect(r.projects.map((p) => p.name)).toEqual(['one', 'two']);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]?.code).toBe(W_NEXUS_PROJECT_NAME_LOCKED);
    expect(r.warnings[0]?.message).toContain('2 project name(s)');
  });

  it('strips control and bidi-override characters from server-held names', async () => {
    expect(safeNexusProjectName('\u001b[31mred\u001b[0m')).toBe('[31mred[0m');
    expect(safeNexusProjectName('a‮b')).toBe('ab');
    expect(safeNexusProjectName('\u0007')).toBeNull();
    const s = server([{ projectId: P1, label: 'evil\u001b]0;title\u0007' }]);
    const r = await listNexusNamedProjects(opts(s.fetch, { openName: lockedOpener }));
    expect(r.projects[0]?.name).toBe('evil]0;title');
  });
});

describe('restore commands', () => {
  it('by name when unique (quoted for the shell), by id when the name is shared', async () => {
    const s = server([
      { projectId: P1, label: 'My App', headCheckpointId: 'cp-1' },
      { projectId: P2, label: 'dup', headCheckpointId: 'cp-2' },
      { projectId: P3, label: 'DUP', headCheckpointId: 'cp-3' },
    ]);
    const r = await listNexusNamedProjects(opts(s.fetch, { openName: lockedOpener }));
    expect(r.projects.map((p) => p.restoreCommand)).toEqual([
      "cleo cloud restore 'My App'",
      // Exact matching tells "dup" from "DUP", so each name restores its own project.
      'cleo cloud restore dup',
      'cleo cloud restore DUP',
    ]);
  });

  it('a name that two projects share exactly, or that reads as a flag or id, restores by id', async () => {
    const s = server([
      { projectId: P1, label: 'same', headCheckpointId: 'cp-1' },
      { projectId: P2, label: 'same', headCheckpointId: 'cp-2' },
      { projectId: P3, label: '--force', headCheckpointId: 'cp-3' },
    ]);
    const r = await listNexusNamedProjects(opts(s.fetch, { openName: lockedOpener }));
    expect(r.projects.map((p) => p.restoreCommand)).toEqual([
      `cleo cloud restore ${P1}`,
      `cleo cloud restore ${P2}`,
      `cleo cloud restore ${P3}`,
    ]);
  });

  it('no command for a project with no backup or already on this device', async () => {
    const s = server([
      { projectId: P1, label: 'empty', headCheckpointId: null },
      { projectId: P2, label: 'here', headCheckpointId: 'cp-2', replicaDevices: [DEVICE] },
      { projectId: P3, label: 'there', headCheckpointId: 'cp-3', replicaDevices: [OTHER_DEVICE] },
    ]);
    const r = await listNexusNamedProjects(
      opts(s.fetch, { openName: lockedOpener, deviceId: DEVICE }),
    );
    expect(r.projects.map((p) => [p.hasBackup, p.onThisDevice, p.restoreCommand])).toEqual([
      [false, false, null],
      [true, true, null],
      [true, false, 'cleo cloud restore there'],
    ]);
  });

  it('an older server without headCheckpointId still offers the command (hasBackup null)', async () => {
    const s = server([{ projectId: P1, label: 'legacy' }]);
    const r = await listNexusNamedProjects(opts(s.fetch, { openName: lockedOpener }));
    expect(r.projects[0]?.hasBackup).toBeNull();
    expect(r.projects[0]?.restoreCommand).toBe('cleo cloud restore legacy');
  });

  it('names the API URL when it is not the default', async () => {
    process.env[NEXUS_API_URL_ENV] = 'https://api.cleocode.dev';
    const s = server([{ projectId: P1, label: 'x', headCheckpointId: 'cp' }]);
    const r = await listNexusNamedProjects(opts(s.fetch, { openName: lockedOpener }));
    expect(r.projects[0]?.restoreCommand).toBe(`cleo cloud restore x --api-url ${API}`);
  });

  it('quotes single quotes for a POSIX shell', () => {
    expect(shellQuoteWord("it's")).toBe(`'it'\\''s'`);
    expect(shellQuoteWord('plain-name_1.0')).toBe('plain-name_1.0');
  });
});

describe('cleo cloud restore <name> resolution', () => {
  const items: Item[] = [
    { projectId: P1, label: 'board', headCheckpointId: 'cp-1' },
    { projectId: P2, label: 'Shared', headCheckpointId: 'cp-2' },
    { projectId: P3, label: 'shared', headCheckpointId: 'cp-3' },
  ];

  it('a UUID is the id, without a request', async () => {
    const s = server(items);
    const r = await resolveNexusProjectRef(P1.toUpperCase(), opts(s.fetch));
    expect(r).toEqual({ projectId: P1, name: null, matchedBy: 'id' });
    expect(s.calls).toEqual([]);
  });

  it('a unique label resolves to its id; matching ignores case when nothing matches exactly', async () => {
    const s = server(items);
    expect(
      await resolveNexusProjectRef('board', opts(s.fetch, { openName: lockedOpener })),
    ).toEqual({
      projectId: P1,
      name: 'board',
      matchedBy: 'name',
    });
    expect(
      (await resolveNexusProjectRef('  BOARD ', opts(s.fetch, { openName: lockedOpener })))
        .projectId,
    ).toBe(P1);
  });

  it('an exact match wins over case-insensitive ones', async () => {
    const s = server(items);
    const r = await resolveNexusProjectRef('Shared', opts(s.fetch, { openName: lockedOpener }));
    expect(r.projectId).toBe(P2);
  });

  it('an ambiguous name lists every candidate with a by-id restore command', async () => {
    const s = server(items);
    const err = await refError(
      resolveNexusProjectRef('SHARED', opts(s.fetch, { openName: lockedOpener })),
    );
    expect(err.code).toBe('E_NEXUS_PROJECT_AMBIGUOUS');
    expect(err.message).toContain('matches 2 projects');
    expect(err.message).toContain(P2);
    expect(err.message).toContain(P3);
    expect(err.publicDetails.ref).toBe('SHARED');
    expect(err.publicDetails.candidates.map((c) => c.restoreCommand)).toEqual([
      `cleo cloud restore ${P2}`,
      `cleo cloud restore ${P3}`,
    ]);
    expect(err.fix).toContain(`cleo cloud restore ${P2}`);
  });

  it('no match is E_NEXUS_PROJECT_NOT_FOUND with the listing command as the remedy', async () => {
    const s = server(items);
    const err = await refError(
      resolveNexusProjectRef('nope', opts(s.fetch, { openName: lockedOpener })),
    );
    expect(err.code).toBe('E_NEXUS_PROJECT_NOT_FOUND');
    expect(err.fix).toContain('cleo cloud projects');
    expect(err.publicDetails.candidates).toEqual([]);
  });

  it('a decrypted name resolves too', async () => {
    const pdk = randomKey();
    const s = server([
      { projectId: P1, label: null, encryptedName: sealProjectName(pdk, P1, 'Hidden Board') },
    ]);
    const r = await resolveNexusProjectRef(
      'hidden board',
      opts(s.fetch, { openName: async (id, enc) => openProjectName(pdk, id, enc) }),
    );
    expect(r).toEqual({ projectId: P1, name: 'Hidden Board', matchedBy: 'name' });
  });

  it('a legacy 12-hex id resolves by id when listed, and passes through when not', async () => {
    const listed = server([{ projectId: LEGACY, label: 'old', headCheckpointId: 'cp' }]);
    expect(
      await resolveNexusProjectRef(LEGACY, opts(listed.fetch, { openName: lockedOpener })),
    ).toEqual({ projectId: LEGACY, name: null, matchedBy: 'id' });
    const empty = server([]);
    expect(
      (await resolveNexusProjectRef('abcdef012345', opts(empty.fetch, { openName: lockedOpener })))
        .projectId,
    ).toBe('abcdef012345');
  });

  it('matchNexusProjects: empty references match nothing', () => {
    expect(matchNexusProjects([], '')).toEqual([]);
  });
});
