/**
 * `nexus-account` setup section (T12712): optional, skipped when
 * non-interactive or declined, and otherwise runs the same login engine as
 * `cleo login nexus`, showing the code through the wizard I/O.
 *
 * @task T12712
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NexusLoginResult } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { loginToNexus } from '../../../cloud/nexus-auth.js';
import { createBuiltinSections } from '../../index.js';
import { StubWizardIO } from '../../wizard.js';
import { createNexusAccountSection } from '../nexus-account.js';

const RESULT: NexusLoginResult = {
  apiUrl: 'https://api.cleocode.dev',
  user: { id: 'u-1', email: 'dev@example.test' },
  organization: { id: 'o-1', name: 'Personal', personal: true },
  expiresAt: null,
  credentialsPath: '/tmp/nexus-credentials.json',
  warnings: [],
};

function stubLogin() {
  return vi.fn<typeof loginToNexus>(async (opts) => {
    opts?.onCode?.({
      deviceCode: 'd',
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://cleocode.dev/device',
      verificationUriComplete: 'https://cleocode.dev/device?user_code=ABCD-EFGH',
      expiresIn: 900,
      interval: 5,
    });
    return RESULT;
  });
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

describe('nexus-account setup section', () => {
  it('is registered as an optional built-in section', () => {
    const section = createBuiltinSections().find((s) => s.section === 'nexus-account');
    expect(section?.optional).toBe(true);
  });

  it('skips when non-interactive (a person must approve the code)', async () => {
    const login = stubLogin();
    const result = await createNexusAccountSection({ login }).run(new StubWizardIO(), {
      nonInteractive: true,
    });
    expect(result.changed).toBe(false);
    expect(result.summary).toMatch(/skipped/);
    expect(login).not.toHaveBeenCalled();
  });

  it('skips when the user declines', async () => {
    const login = stubLogin();
    const result = await createNexusAccountSection({ login }).run(
      new StubWizardIO({ confirms: [false] }),
      {},
    );
    expect(result).toEqual({ changed: false, summary: 'skipped' });
    expect(login).not.toHaveBeenCalled();
  });

  it('runs the login engine and shows the code through the wizard I/O', async () => {
    const login = stubLogin();
    const io = new StubWizardIO({ confirms: [true] });
    const result = await createNexusAccountSection({ login }).run(io, {});
    expect(login).toHaveBeenCalledTimes(1);
    expect(io.infos.join('\n')).toContain('ABCD-EFGH');
    expect(io.infos.join('\n')).toContain('https://cleocode.dev/device?user_code=ABCD-EFGH');
    expect(result).toEqual({
      changed: true,
      summary: 'signed in to https://api.cleocode.dev as dev@example.test',
    });
  });

  it('reports not configured when no session is stored', async () => {
    expect(await createNexusAccountSection().isConfigured?.({})).toBe(false);
  });
});
