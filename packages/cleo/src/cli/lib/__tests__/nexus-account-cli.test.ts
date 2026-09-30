/**
 * `cleo login nexus` glue (T12868): with `CLEO_NEXUS_DEVICE` unset it runs
 * the 9.24 session login exactly as before; with `CLEO_NEXUS_DEVICE=1` it
 * runs the device enrolment and passes `--read-only` and `--name`.
 *
 * The core flows are mocked; nothing touches the network or a CLEO home.
 *
 * @task T12868
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loginToNexus = vi.fn();
const loginToNexusDevice = vi.fn();

vi.mock('@cleocode/core/cloud/nexus-auth.js', () => ({ loginToNexus }));
vi.mock('@cleocode/core/cloud/nexus-enrol.js', () => ({ loginToNexusDevice }));
vi.mock('@cleocode/core/cloud/nexus-device.js', () => ({
  isNexusDeviceEnabled: () => process.env['CLEO_NEXUS_DEVICE'] === '1',
}));

const { nexusLoginSummary, runNexusLogin } = await import('../nexus-account-cli.js');

const RESULT = {
  apiUrl: 'https://api.nexus.test',
  user: { id: 'u-1', email: 'dev@example.test' },
  organization: null,
  expiresAt: null,
  credentialsPath: '/tmp/x',
  warnings: [],
};

let saved: string | undefined;
let stderr: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  saved = process.env['CLEO_NEXUS_DEVICE'];
  loginToNexus.mockReset().mockResolvedValue(RESULT);
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
  stderr.mockRestore();
});

describe('runNexusLogin', () => {
  it('with the flag unset, runs the 9.24 session login exactly as before', async () => {
    delete process.env['CLEO_NEXUS_DEVICE'];
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

  it('with the flag unset, a value other than 1 still runs the session login', async () => {
    process.env['CLEO_NEXUS_DEVICE'] = 'true';
    await runNexusLogin({}, () => {});
    expect(loginToNexus).toHaveBeenCalledTimes(1);
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
