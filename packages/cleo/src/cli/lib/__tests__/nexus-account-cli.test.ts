/**
 * `cleo login nexus` glue (T12868, T12904): device enrolment is the default
 * and passes `--read-only` and `--name`; `CLEO_NEXUS_DEVICE=0` runs the 9.24
 * session login exactly as before.
 *
 * The core flows are mocked; nothing touches the network or a CLEO home.
 *
 * @task T12868
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loginToNexus = vi.fn();
const loginToNexusDevice = vi.fn();
const attachNexusGlobalStore = vi.fn();

vi.mock('@cleocode/core/cloud/nexus-auth.js', () => ({ loginToNexus }));
vi.mock('@cleocode/core/cloud/nexus-enrol.js', () => ({
  loginToNexusDevice,
  NEXUS_TEST_BEARER_ENV: 'CLEO_NEXUS_TEST_BEARER',
  W_NEXUS_TEST_BEARER_IGNORED: 'W_NEXUS_TEST_BEARER_IGNORED',
}));
vi.mock('@cleocode/core/cloud/nexus-home.js', () => ({ attachNexusGlobalStore }));
vi.mock('@cleocode/core/cloud/nexus-device.js', () => ({
  isNexusDeviceEnabled: () => process.env['CLEO_NEXUS_DEVICE'] !== '0',
}));

const { nexusDeviceLogoutSummary, nexusLoginSummary, runNexusLogin } = await import(
  '../nexus-account-cli.js'
);

const RESULT = {
  apiUrl: 'https://api.nexus.test',
  user: { id: 'u-1', email: 'dev@example.test' },
  organization: null,
  expiresAt: null,
  credentialsPath: '/tmp/x',
  warnings: [],
};

let saved: string | undefined;
let savedBearer: string | undefined;
let stderr: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  saved = process.env['CLEO_NEXUS_DEVICE'];
  savedBearer = process.env['CLEO_NEXUS_TEST_BEARER'];
  delete process.env['CLEO_NEXUS_TEST_BEARER'];
  loginToNexus.mockReset().mockResolvedValue(RESULT);
  attachNexusGlobalStore.mockReset().mockResolvedValue({ replica: null, warnings: [] });
  loginToNexusDevice.mockReset().mockResolvedValue({
    ...RESULT,
    device: {
      deviceId: 'd-1',
      name: 'macOS arm64 · 0198',
      state: 'active',
      profile: 'read-only',
      created: true,
    },
    scopes: ['account:read'],
  });
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  if (saved === undefined) delete process.env['CLEO_NEXUS_DEVICE'];
  else process.env['CLEO_NEXUS_DEVICE'] = saved;
  if (savedBearer === undefined) delete process.env['CLEO_NEXUS_TEST_BEARER'];
  else process.env['CLEO_NEXUS_TEST_BEARER'] = savedBearer;
  stderr.mockRestore();
});

describe('runNexusLogin', () => {
  it('with CLEO_NEXUS_DEVICE=0, runs the 9.24 session login exactly as before', async () => {
    process.env['CLEO_NEXUS_DEVICE'] = '0';
    const result = await runNexusLogin({ 'api-url': 'https://api.nexus.test' }, () => {});
    expect(result).toBe(RESULT);
    expect(loginToNexusDevice).not.toHaveBeenCalled();
    expect(loginToNexus).toHaveBeenCalledTimes(1);
    const opts = loginToNexus.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(opts).sort()).toEqual(['apiUrl', 'onCode', 'onPending']);
    expect(opts['apiUrl']).toBe('https://api.nexus.test');
    expect(nexusLoginSummary(result)).toBe(
      'Signed in to https://api.nexus.test as dev@example.test.',
    );
    const written = stderr.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(written).not.toContain('CLEO_NEXUS_DEVICE');
  });

  it('by default (flag unset, or any value but 0), enrols the device (T12904)', async () => {
    for (const value of [undefined, '1', 'true']) {
      if (value === undefined) delete process.env['CLEO_NEXUS_DEVICE'];
      else process.env['CLEO_NEXUS_DEVICE'] = value;
      await runNexusLogin({}, () => {});
    }
    expect(loginToNexusDevice).toHaveBeenCalledTimes(3);
    expect(loginToNexus).not.toHaveBeenCalled();
    // T12952: a device login also attaches this device's global store.
    expect(attachNexusGlobalStore).toHaveBeenCalledTimes(3);
  });

  it('a failed global-store attach is a warning; the login still succeeds (T12952)', async () => {
    delete process.env['CLEO_NEXUS_DEVICE'];
    attachNexusGlobalStore.mockRejectedValueOnce(new Error('E_NEXUS_REPLICA_COPIED: copied'));
    const result = await runNexusLogin({}, () => {});
    expect(result.warnings.join('\n')).toMatch(
      /attaching this device's global store failed.*cleo login nexus/,
    );
    expect(RESULT.warnings).toEqual([]);
  });

  it('a read-only device login does not attach the global store (T12952)', async () => {
    process.env['CLEO_NEXUS_DEVICE'] = '1';
    await runNexusLogin({ 'read-only': true }, () => {});
    expect(attachNexusGlobalStore).not.toHaveBeenCalled();
  });

  it('with CLEO_NEXUS_DEVICE=0, --read-only is REFUSED, never a full-privilege login (review L1)', async () => {
    process.env['CLEO_NEXUS_DEVICE'] = '0';
    await expect(runNexusLogin({ 'read-only': true }, () => {})).rejects.toMatchObject({
      code: 'E_NEXUS_DEVICE_REQUIRED',
    });
    expect(loginToNexus).not.toHaveBeenCalled();
    expect(loginToNexusDevice).not.toHaveBeenCalled();
  });

  it('with CLEO_NEXUS_DEVICE=1, enrols the device with --read-only and --name', async () => {
    process.env['CLEO_NEXUS_DEVICE'] = '1';
    const result = await runNexusLogin({ 'read-only': true, name: 'ci box' }, () => {});
    expect(loginToNexus).not.toHaveBeenCalled();
    const opts = loginToNexusDevice.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts['readOnly']).toBe(true);
    expect(opts['name']).toBe('ci box');
    expect(nexusLoginSummary(result)).toContain('device d-1');
  });
});

describe('runNexusLogin: CLEO_NEXUS_TEST_BEARER (T12902)', () => {
  const written = (): string => stderr.mock.calls.map((c: unknown[]) => String(c[0])).join('');

  it('with CLEO_NEXUS_DEVICE=0, warns that the test bearer is ignored, never printing it', async () => {
    process.env['CLEO_NEXUS_DEVICE'] = '0';
    const bearer = 'sess_secret_value_0123456789abcdef';
    process.env['CLEO_NEXUS_TEST_BEARER'] = bearer;
    await runNexusLogin({}, () => {});
    expect(loginToNexus).toHaveBeenCalledTimes(1);
    expect(written()).toContain(
      'warning: W_NEXUS_TEST_BEARER_IGNORED: CLEO_NEXUS_TEST_BEARER needs device credentials, which CLEO_NEXUS_DEVICE turns off; ignored',
    );
    expect(written()).not.toContain(bearer);
  });

  it('prints "authorization approved" only when a device code was shown', async () => {
    // A test-bearer login: the core flow never calls onCode.
    await runNexusLogin({}, () => {});
    expect(written()).not.toContain('authorization approved');
    // A browser login: onCode fires, then the approval line is printed.
    loginToNexusDevice.mockImplementationOnce(
      async (opts: {
        onCode: (c: { userCode: string; verificationUri: string; expiresIn: number }) => void;
      }) => {
        opts.onCode({
          userCode: 'ABCD-EFGH',
          verificationUri: 'https://cleocode.dev/device',
          expiresIn: 900,
        });
        return RESULT;
      },
    );
    await runNexusLogin({}, () => {});
    expect(written()).toContain('authorization approved');
  });
});

describe('nexusDeviceLogoutSummary (T12870)', () => {
  const row = (outcome: 'confirmed' | 'pending' | 'unconfirmed') => ({
    userId: 'u-1',
    deviceId: 'd-1',
    action: 'sign-out' as const,
    retired: false,
    outcome,
    removedLocally: false,
  });
  const base = { apiUrl: 'https://api.nexus.test', session: null, warnings: [] };

  it('says nothing to do when nothing was stored', () => {
    expect(nexusDeviceLogoutSummary({ ...base, action: 'sign-out', devices: [] })).toBe(
      'Not signed in to https://api.nexus.test; nothing to do.',
    );
  });

  it('never claims an unconfirmed sign-out succeeded', () => {
    const line = nexusDeviceLogoutSummary({
      ...base,
      action: 'revoke',
      devices: [row('confirmed'), row('pending'), row('unconfirmed')],
    });
    expect(line).toBe(
      'Revoke NOT fully confirmed on https://api.nexus.test: 1 of 3 device request(s) confirmed; 2 NOT confirmed (see warnings).',
    );
  });
});
