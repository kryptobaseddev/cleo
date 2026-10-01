/**
 * CLI wiring for the read-only `cleo cloud` commands (T12871): envelopes,
 * operations, exit codes, the offline `details`, and that no token is ever
 * printed. The REAL core flows run against a temp CLEO home and project; only
 * the network is replaced by a stubbed global `fetch`.
 *
 * @task T12871
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateEd25519, generateX25519 } from '@cleocode/core/cloud/crypto.js';
import {
  applyEnrolment,
  NexusDeviceEnrolment,
  NexusDeviceStore,
} from '@cleocode/core/cloud/nexus-device.js';
import type { CommandDef } from 'citty';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cloudCommand } from '../cloud.js';

const API = 'https://api.nexus.test';
const USER = '0198a1b2-0000-7000-8000-0000000000aa';
const DEVICE = '0198a1b2-0000-7000-8000-0000000000d1';
const PROJECT_ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const NOW = '2026-09-30T12:00:00.000Z';

const mockFetch = vi.fn(async (url: string): Promise<Response> => {
  const path = new URL(url).pathname;
  if (path === '/v1/whoami') {
    return new Response(
      JSON.stringify({
        success: true,
        data: {
          user: { id: USER, email: 'dev@example.test', name: 'Dev' },
          organizations: [],
          credential: { kind: 'device', profile: 'device', scopes: ['account:read'] },
          device: { deviceId: DEVICE, name: 'laptop', state: 'active', current: true },
        },
        meta: { requestId: 'r' },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  throw new Error('getaddrinfo ENOTFOUND');
});

let base: string;
let token: string;
const saved: Record<string, string | undefined> = {};
const ENV = [
  'CLEO_HOME',
  'CLEO_DIR',
  'CLEO_ROOT',
  'CLEO_NEXUS_DEVICE',
  'CLEO_NEXUS_API_URL',
  'CLEO_FORMAT',
];

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  base = mkdtempSync(join(tmpdir(), 'cloud-cli-'));
  const home = join(base, 'home');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const project = join(base, 'proj');
  mkdirSync(join(project, '.cleo'), { recursive: true });
  writeFileSync(join(project, '.cleo', 'project-id'), `${PROJECT_ID}\n`);
  process.env['CLEO_HOME'] = home;
  process.env['CLEO_DIR'] = join(project, '.cleo');
  process.env['CLEO_ROOT'] = project;
  process.env['CLEO_NEXUS_DEVICE'] = '1';
  process.env['CLEO_NEXUS_API_URL'] = API;
  process.env['CLEO_FORMAT'] = 'json';
  mockFetch.mockClear();
  vi.stubGlobal('fetch', mockFetch);
  token = '';
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(base, { recursive: true, force: true });
});

async function signIn(): Promise<void> {
  token = `cnx_d1_${randomBytes(32).toString('base64url')}`;
  const home = process.env['CLEO_HOME'] ?? '';
  const store = new NexusDeviceStore(join(home, 'nexus-device.json'), { cleoHome: home });
  const enc = generateX25519();
  const sig = generateEd25519();
  await store.update((tx) => {
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
            scopes: ['account:read'],
            createdAt: NOW,
          },
        }),
      ),
    );
  });
}

async function sub(name: string): Promise<CommandDef> {
  const subs = cloudCommand.subCommands as Record<string, CommandDef>;
  const found = subs[name];
  if (!found) throw new Error(`no subcommand ${name}`);
  return found;
}

/** Run a subcommand, capturing stdout/stderr; `process.exit` throws `__EXIT_<code>__`. */
async function run(name: string, args: Record<string, unknown>) {
  const out: string[] = [];
  const err: string[] = [];
  const spies = [
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      out.push(String(s));
      return true;
    }),
    vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
      err.push(String(s));
      return true;
    }),
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`__EXIT_${code}__`);
    }) as never),
  ];
  let exit: string | null = null;
  try {
    const cmd = (await sub(name)) as { run: (ctx: object) => Promise<void> };
    await cmd.run({ args, rawArgs: [], cmd });
  } catch (e) {
    exit = e instanceof Error ? e.message : String(e);
  } finally {
    for (const s of spies) s.mockRestore();
  }
  const line = out.filter((l) => l.trim().startsWith('{')).at(-1) ?? '{}';
  return { envelope: JSON.parse(line), out: out.join(''), err: err.join(''), exit };
}

describe('cleo cloud', () => {
  it('status without a credential: success envelope, verdict not-signed-in, no request', async () => {
    const r = await run('status', {});
    expect(r.exit).toBeNull();
    expect(r.envelope.success).toBe(true);
    expect(r.envelope.data.verdict).toBe('not-signed-in');
    expect(r.envelope.data.local.projectId).toBe(PROJECT_ID);
    expect(r.envelope.meta.operation).toBe('cloud.status');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('status offline: E_NEXUS_UNREACHABLE with the local facts in details, exit 1', async () => {
    await signIn();
    const r = await run('status', {});
    expect(r.exit).toBe('__EXIT_1__');
    expect(r.envelope.success).toBe(false);
    expect(r.envelope.error.codeName).toBe('E_NEXUS_UNREACHABLE');
    expect(r.envelope.error.details.local.nexusDeviceId).toBe(DEVICE);
    expect(r.envelope.error.details.summary.headSeq).toBeNull();
    expect(r.out + r.err).not.toContain(token);
  });

  it('whoami: envelope with the user, the token never printed', async () => {
    await signIn();
    const r = await run('whoami', {});
    expect(r.exit).toBeNull();
    expect(r.envelope.data.user.email).toBe('dev@example.test');
    expect(r.envelope.meta.operation).toBe('cloud.whoami');
    expect(r.out + r.err).not.toContain('cnx_d1_');
  });

  it('devices --state bogus is a validation failure (exit 6) before any request', async () => {
    await signIn();
    const r = await run('devices', { state: 'bogus' });
    expect(r.exit).toBe('__EXIT_6__');
    expect(r.envelope.error.codeName).toBe('E_VALIDATION');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('projects with an unknown action is a validation failure', async () => {
    const r = await run('projects', { action: 'delete' });
    expect(r.exit).toBe('__EXIT_6__');
    expect(r.envelope.error.codeName).toBe('E_VALIDATION');
  });

  it('refuses with E_NEXUS_DEVICE_REQUIRED when CLEO_NEXUS_DEVICE=0', async () => {
    process.env['CLEO_NEXUS_DEVICE'] = '0';
    const r = await run('status', {});
    expect(r.exit).toBe('__EXIT_6__');
    expect(r.envelope.error.codeName).toBe('E_NEXUS_DEVICE_REQUIRED');
  });
});
