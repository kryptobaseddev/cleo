/**
 * gh#1187 — the legacy MCP reaper kills live Codex CLI sessions.
 *
 * A hand-applied systemd user timer selects victims by
 * `/proc/PID/comm === 'MainThread'` — a generic Node launcher comm, not an MCP
 * signature. The npm Codex CLI has exactly that comm and forwards SIGTERM to
 * its child, so the reaper ends a live session cleanly enough that it was first
 * misdiagnosed as a Codex crash. It was never package-owned, so no upgrade has
 * ever removed it.
 *
 * These tests pin the classification, which is where the value is: failing on
 * inert leftovers would train operators to ignore the check, and passing on an
 * armed timer would leave sessions killable.
 */

import { describe, expect, it } from 'vitest';
import { buildRecommendation, isUnitDangerous, scanLegacyReaper } from '../legacy-reaper.js';

describe('isUnitDangerous', () => {
  it.each([
    'enabled',
    'static',
    'enabled-runtime',
    'linked',
  ])('treats %s as still able to fire', (state) => {
    expect(isUnitDangerous(state)).toBe(true);
  });

  it.each(['masked', 'disabled', 'absent'])('treats %s as inert', (state) => {
    // `masked` cannot start; `disabled` cannot be triggered by its own timer.
    expect(isUnitDangerous(state)).toBe(false);
  });
});

describe('buildRecommendation', () => {
  const unit = (fileState: string) => ({
    unit: 'cleo-mcp-reaper.timer',
    fileState,
    activeState: 'inactive',
    dangerous: isUnitDangerous(fileState),
  });

  it('says CLEAN when nothing is installed', () => {
    const msg = buildRecommendation({ armed: false, remediated: false, units: [], scripts: [] });
    expect(msg).toMatch(/clean/i);
  });

  it('shouts when the timer is armed, and names the one-line manual fix', () => {
    const msg = buildRecommendation({
      armed: true,
      remediated: false,
      units: [unit('enabled')],
      scripts: ['/home/u/.local/bin/cleo-mcp-reaper.sh'],
    });

    expect(msg).toMatch(/ARMED/);
    // An operator reading this mid-incident needs the command, not a concept.
    expect(msg).toContain('systemctl --user disable --now cleo-mcp-reaper.timer');
    expect(msg).toContain('cleo janitor run');
  });

  it('does not shout at a host whose units are present but inert', () => {
    const msg = buildRecommendation({
      armed: false,
      remediated: false,
      units: [unit('masked')],
      scripts: ['/home/u/.local/bin/cleo-mcp-reaper.sh'],
    });

    expect(msg).toMatch(/inert/i);
    expect(msg).not.toMatch(/ARMED/);
  });

  it('after a fix, says the script was deliberately kept', () => {
    // The helper and its journal are evidence of a real incident — the repair
    // disables and masks, it does not delete.
    const msg = buildRecommendation({
      armed: true,
      remediated: true,
      units: [unit('masked')],
      scripts: ['/home/u/.local/bin/cleo-mcp-reaper.sh'],
    });

    expect(msg).toMatch(/evidence/i);
    expect(msg).toContain('cleo janitor run');
  });
});

describe('scanLegacyReaper', () => {
  it('returns a coherent report without mutating anything', () => {
    const report = scanLegacyReaper();

    expect(typeof report.armed).toBe('boolean');
    expect(report.remediated).toBe(false);
    expect(report.recommendation.length).toBeGreaterThan(0);
    expect(Array.isArray(report.units)).toBe(true);
  });

  it('does not report a unit that does not exist', () => {
    // `systemctl show` answers `ActiveState=inactive` for a unit that was never
    // installed, while `UnitFileState` comes back empty. Keying presence off
    // ActiveState made every clean host report two phantom "inert" units —
    // a check that cries wolf is a check operators learn to skip.
    const report = scanLegacyReaper();
    for (const u of report.units) {
      expect(u.fileState).not.toBe('absent');
    }
  });

  it('is a no-op off Linux, where the artifact cannot exist', () => {
    if (process.platform === 'linux') return;
    const report = scanLegacyReaper();
    expect(report.units).toEqual([]);
    expect(report.armed).toBe(false);
  });
});
