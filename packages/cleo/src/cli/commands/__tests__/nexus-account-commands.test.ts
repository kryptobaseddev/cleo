/**
 * CLI wiring for the Cleo Nexus account (T12712): `cleo login nexus` (and the
 * `auth login` / `llm login` aliases), the picker order, `cleo logout`,
 * `cleo auth list`'s nexus row, and `cleo project link`.
 *
 * The REAL core engine runs (`@cleocode/core/cloud/nexus-*.js`, the shared
 * device-code runner, the 0600 file store under the per-fork CLEO_HOME); only
 * the network is replaced, by a stubbed global `fetch` that mirrors the
 * better-auth device routes, `/api/auth/sign-out`, `/v1/account/me` and
 * `/v1/projects`. The first poll is approved or denied, so no test sleeps.
 *
 * @task T12712
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OnboardingResult } from '@cleocode/contracts';
import type { CommandDef } from 'citty';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — declared BEFORE importing the command modules.
// ---------------------------------------------------------------------------

const VALIDATED: OnboardingResult = {
  steps: [{ step: 'connect', status: 'ok', detail: 'ok' }],
  provider: 'anthropic',
  accountLabel: 'oauth-login',
  authMode: 'api_key',
  modelId: 'claude-test-1',
  profileName: 'default',
  validated: true,
};
const mockRunFrontDoorLogin = vi.fn(async (): Promise<OnboardingResult> => VALIDATED);
vi.mock('@cleocode/core/llm/onboarding/front-door.js', () => ({
  runFrontDoorLogin: (...a: unknown[]) => mockRunFrontDoorLogin(...(a as [])),
}));

vi.mock('@cleocode/core/llm/provider-registry/index.js', () => ({
  getProviderProfile: vi.fn(async () => ({ name: 'anthropic', oauth: undefined })),
  listProviders: vi.fn(async () => [{ name: 'openai' }, { name: 'anthropic' }]),
}));

const mockOpenBrowser = vi.fn();
vi.mock('../llm-login.js', () => ({
  runLlmLogin: vi.fn(),
  _tryOpenBrowser: (url: string) => mockOpenBrowser(url),
}));

const mockSelect = vi.fn(async (_q: string, options: readonly string[]) => options[0]);
vi.mock('../../lib/readline-wizard-io.js', () => ({
  ReadlineWizardIO: class {
    select(q: string, options: readonly string[]) {
      return mockSelect(q, options);
    }
    close() {}
  },
}));

vi.mock('../../../dispatch/adapters/cli.js', () => ({ dispatchFromCli: vi.fn() }));

vi.mock('@cleocode/core/llm/credential-pool.js', () => ({
  getCredentialPool: () => ({ seed: vi.fn(async () => undefined), list: vi.fn(async () => []) }),
}));

const mockRemoveLlmCredential = vi.fn();
vi.mock('@cleocode/core/llm/credential-remove-entry.js', () => ({
  removeLlmCredential: (...a: unknown[]) => mockRemoveLlmCredential(...a),
}));

import { nexusCredentialsPath } from '@cleocode/core/cloud/nexus-credentials.js';
import { authCommand } from '../auth.js';
import { llmCommand } from '../llm.js';
import { loginCommand, loginPickerOptions, NEXUS_PICKER_LABEL } from '../login.js';
import { logoutCommand } from '../logout.js';
import { projectCommand } from '../project.js';

// ---------------------------------------------------------------------------
// Mock Nexus API
// ---------------------------------------------------------------------------

const API = 'https://api.nexus.test';
const TOKEN = 'tok_SECRET_cli_session_0123456789abcdef';
const PROJECT_ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

let calls: Call[];
let tokenReply: { status: number; body: Record<string, unknown> };
let meStatus: 200 | 401;

const approved = {
  status: 200,
  body: { access_token: TOKEN, token_type: 'Bearer', expires_in: 3600 },
};

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const mockFetch = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
  const path = new URL(url).pathname;
  calls.push({
    method: init?.method ?? 'GET',
    path,
    headers: Object.fromEntries(new Headers(init?.headers).entries()),
    body: typeof init?.body === 'string' ? init.body : '',
  });
  switch (path) {
    case '/api/auth/device/code':
      return reply(200, {
        device_code: 'dev-1',
        user_code: 'WXYZ-1234',
        // The web app lives on the API's domain (api.X -> web.X), as in production.
        verification_uri: `https://${new URL(url).hostname.replace(/^api\./, 'web.')}/device`,
        verification_uri_complete: `https://${new URL(url).hostname.replace(/^api\./, 'web.')}/device?user_code=WXYZ-1234`,
        expires_in: 900,
        interval: 5,
      });
    case '/api/auth/device/token':
      return reply(tokenReply.status, tokenReply.body);
    case '/v1/account/me':
      return meStatus === 401
        ? reply(401, {
            success: false,
            error: { code: 'E_UNAUTHENTICATED', message: 'sign in required', requestId: 'r' },
          })
        : reply(200, {
            success: true,
            data: {
              user: { id: 'u-1', email: 'dev@example.test', name: 'Dev' },
              organizations: [{ id: 'o-1', name: 'Personal', slug: 'dev', personal: true }],
            },
          });
    case '/api/auth/sign-out':
      return reply(200, { success: true });
    case '/v1/projects': {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return reply(201, {
        success: true,
        data: {
          project: {
            projectId: body['projectId'],
            label: body['label'] ?? null,
            encryptedName: null,
            remoteUrl: null,
            organizationId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c',
            createdByUserId: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d',
            createdAt: '2026-09-28T00:00:00.000Z',
          },
          streamId: `project:${body['projectId']}`,
        },
      });
    }
    default:
      return reply(404, { success: false, error: { code: 'E_NOT_FOUND', message: path } });
  }
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

async function run(cmd: CommandDef, args: Record<string, unknown>): Promise<void> {
  const resolved = typeof cmd === 'function' ? await cmd() : cmd;
  const runFn = (resolved as { run?: (ctx: unknown) => Promise<void> }).run;
  if (!runFn) throw new Error('command has no run function');
  await runFn({ args, rawArgs: [], cmd: resolved });
}

async function sub(parent: CommandDef, name: string): Promise<CommandDef> {
  const p = parent as { subCommands?: unknown };
  const subs = (typeof p.subCommands === 'function' ? await p.subCommands() : p.subCommands) as
    | Record<string, CommandDef>
    | undefined;
  const found = subs?.[name];
  if (!found) throw new Error(`no subcommand ${name}`);
  return found;
}

/** Capture stdout + stderr; `exit` makes process.exit throw `__EXIT_<code>__`. */
function capture() {
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
  return {
    out,
    err,
    envelope: () => JSON.parse(out.filter((l) => l.trim().startsWith('{')).at(-1) ?? '{}'),
    restore: () => {
      for (const s of spies) s.mockRestore();
    },
  };
}

const savedTTY = process.stdin.isTTY;

// These tests cover the 9.24 session path: pin device credentials off so no
// test reads the real nexus-device.json (T12904 made them the default).
let savedDeviceFlag: string | undefined;
beforeEach(() => {
  savedDeviceFlag = process.env['CLEO_NEXUS_DEVICE'];
  process.env['CLEO_NEXUS_DEVICE'] = '0';
});
afterEach(() => {
  if (savedDeviceFlag === undefined) delete process.env['CLEO_NEXUS_DEVICE'];
  else process.env['CLEO_NEXUS_DEVICE'] = savedDeviceFlag;
});

beforeEach(() => {
  calls = [];
  tokenReply = approved;
  meStatus = 200;
  mockFetch.mockClear();
  mockOpenBrowser.mockClear();
  mockSelect.mockClear();
  mockRunFrontDoorLogin.mockClear();
  mockRemoveLlmCredential.mockReset();
  vi.stubGlobal('fetch', mockFetch);
  process.env['CLEO_FORMAT'] = 'json';
  process.env['CLEO_NEXUS_API_URL'] = API;
  rmSync(nexusCredentialsPath(), { force: true });
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env['CLEO_NEXUS_API_URL'];
  Object.defineProperty(process.stdin, 'isTTY', { value: savedTTY, configurable: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cleo login nexus', () => {
  it('--json --no-browser: envelope, code on stderr, token stored 0600 and never printed', async () => {
    const cap = capture();
    try {
      await run(loginCommand, { provider: 'nexus', json: true, browser: false });
    } finally {
      cap.restore();
    }
    const env = cap.envelope();
    expect(env.success).toBe(true);
    expect(env.meta.operation).toBe('login.run');
    expect(env.data).toMatchObject({
      apiUrl: API,
      user: { email: 'dev@example.test' },
      organization: { name: 'Personal' },
      credentialsPath: nexusCredentialsPath(),
    });
    expect(cap.err.join('')).toContain('WXYZ-1234');
    expect(mockOpenBrowser).not.toHaveBeenCalled();
    expect(`${cap.out.join('')}${cap.err.join('')}`).not.toContain(TOKEN);
    expect(statSync(nexusCredentialsPath()).mode & 0o777).toBe(0o600);
    // No LLM registry lookup or front-door run for the reserved target.
    expect(mockRunFrontDoorLogin).not.toHaveBeenCalled();
  });

  it('opens the pre-filled verification URL unless --no-browser', async () => {
    const cap = capture();
    try {
      await run(loginCommand, { provider: 'nexus', json: true, browser: true });
    } finally {
      cap.restore();
    }
    expect(mockOpenBrowser).toHaveBeenCalledWith(
      'https://web.nexus.test/device?user_code=WXYZ-1234',
    );
  });

  it('--api-url overrides the default origin', async () => {
    const cap = capture();
    try {
      await run(loginCommand, {
        provider: 'nexus',
        'api-url': 'https://api.other.test/',
        browser: false,
      });
    } finally {
      cap.restore();
    }
    expect(cap.envelope().data.apiUrl).toBe('https://api.other.test');
    expect(calls[0]?.path).toBe('/api/auth/device/code');
  });

  it('a denied request exits 1 with E_NEXUS_ACCESS_DENIED', async () => {
    tokenReply = { status: 400, body: { error: 'access_denied', error_description: 'denied' } };
    const cap = capture();
    try {
      await expect(run(loginCommand, { provider: 'nexus', browser: false })).rejects.toThrow(
        '__EXIT_1__',
      );
    } finally {
      cap.restore();
    }
    const env = cap.envelope();
    expect(env.success).toBe(false);
    expect(env.error.codeName).toBe('E_NEXUS_ACCESS_DENIED');
    expect(existsSync(nexusCredentialsPath())).toBe(false);
  });

  it('cleo auth login nexus and cleo llm login nexus run the same flow', async () => {
    const cap = capture();
    try {
      await run(await sub(authCommand, 'login'), { provider: 'nexus', browser: false });
      await run(await sub(llmCommand, 'login'), { provider: 'nexus', browser: false });
    } finally {
      cap.restore();
    }
    const ops = cap.out
      .filter((l) => l.trim().startsWith('{'))
      .map((l) => JSON.parse(l) as { success: boolean; meta: { operation: string } });
    expect(ops.map((e) => [e.success, e.meta.operation])).toEqual([
      [true, 'auth.login'],
      [true, 'llm.login'],
    ]);
    expect(mockRunFrontDoorLogin).not.toHaveBeenCalled();
  });

  it('an LLM provider still runs the unchanged front door, with no Nexus traffic', async () => {
    const cap = capture();
    try {
      await run(loginCommand, {
        provider: 'anthropic',
        auth: 'api_key',
        'api-key': 'sk-test-1234',
        json: true,
      });
    } finally {
      cap.restore();
    }
    expect(mockRunFrontDoorLogin).toHaveBeenCalledTimes(1);
    expect(mockRunFrontDoorLogin.mock.calls[0]?.[0]).toBe('anthropic');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(cap.envelope().data.validated).toBe(true);
  });
});

describe('login picker', () => {
  it('lists the Cleo Nexus account first, then the providers in name order', () => {
    expect(loginPickerOptions(['openai', 'anthropic'])).toEqual([
      NEXUS_PICKER_LABEL,
      'anthropic',
      'openai',
    ]);
  });

  it('on a terminal with no target, offers Nexus first and runs it when picked', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    const cap = capture();
    try {
      await run(loginCommand, { browser: false });
    } finally {
      cap.restore();
    }
    expect(mockSelect).toHaveBeenCalledTimes(1);
    expect(mockSelect.mock.calls[0]?.[1]).toEqual(['Cleo Nexus account', 'anthropic', 'openai']);
    expect(cap.envelope().data.user.email).toBe('dev@example.test');
  });

  it('picking a provider hands it to the LLM front door', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    mockSelect.mockImplementationOnce(async () => 'openai');
    const cap = capture();
    try {
      await run(loginCommand, { auth: 'api_key', 'api-key': 'sk-x', json: true });
    } finally {
      cap.restore();
    }
    expect(mockRunFrontDoorLogin.mock.calls[0]?.[0]).toBe('openai');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('cleo logout', () => {
  it('nexus (the default): revokes server-side with the bearer token and deletes locally', async () => {
    const cap = capture();
    try {
      await run(loginCommand, { provider: 'nexus', browser: false });
      calls = [];
      await run(logoutCommand, {});
    } finally {
      cap.restore();
    }
    const signOut = calls.find((c) => c.path === '/api/auth/sign-out');
    expect(signOut?.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    const env = cap.envelope();
    expect(env.meta.operation).toBe('logout.run');
    expect(env.data).toMatchObject({ removedLocally: true, revocation: 'revoked' });
    const { FileNexusTokenStore } = await import('@cleocode/core/cloud/nexus-credentials.js');
    expect(await new FileNexusTokenStore().get(API)).toBeNull();
    expect(`${cap.out.join('')}${cap.err.join('')}`).not.toContain(TOKEN);
  });

  it('<provider> [label] delegates to the auth-remove logic', async () => {
    mockRemoveLlmCredential.mockResolvedValue({
      ok: true,
      result: {
        provider: 'anthropic',
        label: 'oauth-login',
        source: 'manual',
        removed: true,
        cleaned: [],
        hints: [],
        suppressed: false,
      },
    });
    const cap = capture();
    try {
      await run(logoutCommand, { target: 'anthropic' });
    } finally {
      cap.restore();
    }
    expect(mockRemoveLlmCredential).toHaveBeenCalledWith('anthropic', undefined);
    expect(cap.envelope().data).toMatchObject({ provider: 'anthropic', removed: true });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('cleo auth list — nexus row', () => {
  it('reports signed-in email, organization and api url; a 401 reads as expired', async () => {
    const cap = capture();
    try {
      await run(loginCommand, { provider: 'nexus', browser: false });
      await run(await sub(authCommand, 'list'), {});
      meStatus = 401;
      await run(await sub(authCommand, 'list'), {});
    } finally {
      cap.restore();
    }
    const lists = cap.out
      .filter((l) => l.trim().startsWith('{'))
      .map((l) => JSON.parse(l) as { meta: { operation: string }; data: { nexus: unknown[] } })
      .filter((e) => e.meta.operation === 'auth.list');
    expect(lists[0]?.data.nexus).toEqual([
      expect.objectContaining({
        apiUrl: API,
        state: 'signed-in',
        email: 'dev@example.test',
        organization: 'Personal',
      }),
    ]);
    expect(lists[1]?.data.nexus).toEqual([expect.objectContaining({ state: 'expired' })]);
  });
});

describe('cleo project link', () => {
  it('sends the tracked id and the project name (plaintext); --label overrides it', async () => {
    const base = mkdtempSync(join(tmpdir(), 'cli-link-'));
    const root = join(base, 'board');
    mkdirSync(join(root, '.cleo'), { recursive: true });
    writeFileSync(join(root, '.cleo', 'project-id'), `${PROJECT_ID}\n`);
    writeFileSync(
      join(root, '.cleo', 'project-info.json'),
      JSON.stringify({ projectId: 'c78d09c3a8ee', projectHash: 'abcdef012345', name: 'Board' }),
    );
    const savedDir = process.env['CLEO_DIR'];
    const savedRoot = process.env['CLEO_ROOT'];
    process.env['CLEO_DIR'] = join(root, '.cleo');
    process.env['CLEO_ROOT'] = root;
    const cap = capture();
    try {
      await run(loginCommand, { provider: 'nexus', browser: false });
      await run(await sub(projectCommand, 'link'), {});
      await run(await sub(projectCommand, 'link'), { label: 'Ops Board' });
    } finally {
      cap.restore();
      if (savedDir === undefined) delete process.env['CLEO_DIR'];
      else process.env['CLEO_DIR'] = savedDir;
      if (savedRoot === undefined) delete process.env['CLEO_ROOT'];
      else process.env['CLEO_ROOT'] = savedRoot;
    }
    const posts = calls.filter((c) => c.path === '/v1/projects');
    expect(posts.map((p) => JSON.parse(p.body))).toEqual([
      { projectId: PROJECT_ID, label: 'Board' },
      { projectId: PROJECT_ID, label: 'Ops Board' },
    ]);
    for (const p of posts) expect(p.body).not.toContain(base);
    const env = cap.envelope();
    expect(env.meta.operation).toBe('project.link');
    expect(env.data.link).toMatchObject({
      localProjectId: PROJECT_ID,
      remoteProjectId: PROJECT_ID,
    });
  });
});
