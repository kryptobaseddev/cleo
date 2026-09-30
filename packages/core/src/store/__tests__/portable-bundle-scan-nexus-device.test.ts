/**
 * `cleo backup export` must never carry `nexus-device.json` (T12867 review
 * B1): it holds the device credential and private keys, sealed under the
 * machine key, and is device-local by contract (§2.2). Like `machine-key`, it
 * is excluded from every bundle, encrypted or not, and so is its temp file.
 *
 * @task T12867
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GLOBAL_HOME_RULES, scanSection } from '../portable-bundle-scan.js';

describe('global home scan: nexus-device.json', () => {
  it('excludes the device file and its temp file, and never lists them as files or secrets', () => {
    const home = mkdtempSync(join(tmpdir(), 'bundle-scan-nexus-device-'));
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'nexus-device.json'), '{"version":1,"devices":{}}\n', { mode: 0o600 });
    writeFileSync(join(home, '.nexus-device.json.0123456789ab.tmp'), '{}', { mode: 0o600 });
    writeFileSync(join(home, 'config.json'), '{}');

    const scan = scanSection(home, GLOBAL_HOME_RULES);
    const exported = [...scan.files, ...scan.sqlite, ...scan.secrets.map((s) => s.relPath)];

    expect(exported).not.toContain('nexus-device.json');
    expect(exported).not.toContain('.nexus-device.json.0123456789ab.tmp');
    expect(exported).toContain('config.json');
    const device = scan.excluded.find((e) => e.relPath === 'nexus-device.json');
    expect(device?.reason).toMatch(/never exported, even encrypted/);
    expect(scan.excluded.map((e) => e.relPath)).toContain('.nexus-device.json.0123456789ab.tmp');
  });
});
