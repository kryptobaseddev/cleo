/**
 * Tests for CAAMP-backed skills version tracking.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getTrackedSkills: vi.fn(),
  checkSkillUpdate: vi.fn(),
  checkAllSkillUpdates: vi.fn(),
}));

vi.mock('@cleocode/caamp', () => ({
  getTrackedSkills: mocks.getTrackedSkills,
  checkSkillUpdate: mocks.checkSkillUpdate,
  checkAllSkillUpdates: mocks.checkAllSkillUpdates,
}));

import {
  getInstalledVersionAsync,
  checkSkillUpdateAsync,
  checkAllSkillUpdatesAsync,
} from '../version.js';

describe('skills version tracking (CAAMP)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads installed version from CAAMP lock', async () => {
    mocks.getTrackedSkills.mockResolvedValue({
      'ct-test': { version: '2.1.0' },
    });

    await expect(getInstalledVersionAsync('ct-test')).resolves.toBe('2.1.0');
    await expect(getInstalledVersionAsync('missing')).resolves.toBeNull();
  });

  it('returns update details for a single skill', async () => {
    mocks.checkSkillUpdate.mockResolvedValue({
      hasUpdate: true,
      currentVersion: '2.0.0',
      latestVersion: '2.1.0',
      status: 'update-available',
    });

    await expect(checkSkillUpdateAsync('ct-test')).resolves.toEqual({
      needsUpdate: true,
      currentVersion: '2.0.0',
      latestVersion: '2.1.0',
    });
  });

  it('maps bulk update results', async () => {
    mocks.checkAllSkillUpdates.mockResolvedValue({
      'ct-test': {
        hasUpdate: true,
        currentVersion: '2.0.0',
        latestVersion: '2.1.0',
        status: 'update-available',
      },
      'ct-stable': {
        hasUpdate: false,
        currentVersion: '1.0.0',
        latestVersion: '1.0.0',
        status: 'up-to-date',
      },
    });

    await expect(checkAllSkillUpdatesAsync()).resolves.toEqual([
      {
        name: 'ct-test',
        installedVersion: '2.0.0',
        availableVersion: '2.1.0',
        needsUpdate: true,
      },
      {
        name: 'ct-stable',
        installedVersion: '1.0.0',
        availableVersion: '1.0.0',
        needsUpdate: false,
      },
    ]);
  });
});
