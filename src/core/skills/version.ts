/**
 * Skills version tracking.
 *
 * CAAMP's skills-lock is the exclusive source of truth for skill versions.
 *
 * @epic T4454
 * @task T4521
 * @task T4680
 */

import {
  getTrackedSkills as caampGetTrackedSkills,
  checkSkillUpdate as caampCheckSkillUpdate,
  checkAllSkillUpdates as caampCheckAllSkillUpdates,
} from '@cleocode/caamp';

/**
 * Get the installed version of a skill from CAAMP lock state.
 */
export async function getInstalledVersionAsync(name: string): Promise<string | null> {
  try {
    const tracked = await caampGetTrackedSkills();
    const entry = tracked[name];
    return entry?.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Check if a specific skill needs an update via CAAMP.
 */
export async function checkSkillUpdateAsync(name: string): Promise<{
  needsUpdate: boolean;
  currentVersion?: string;
  latestVersion?: string;
}> {
  try {
    const result = await caampCheckSkillUpdate(name);
    return {
      needsUpdate: result.hasUpdate,
      currentVersion: result.currentVersion,
      latestVersion: result.latestVersion,
    };
  } catch {
    return { needsUpdate: false };
  }
}

/**
 * Check all installed skills for available updates via CAAMP.
 */
export async function checkAllSkillUpdatesAsync(): Promise<Array<{
  name: string;
  installedVersion: string;
  availableVersion: string;
  needsUpdate: boolean;
}>> {
  try {
    const results = await caampCheckAllSkillUpdates();
    return Object.entries(results).map(([name, status]) => ({
      name,
      installedVersion: status.currentVersion ?? 'unknown',
      availableVersion: status.latestVersion ?? 'unknown',
      needsUpdate: status.hasUpdate,
    }));
  } catch {
    return [];
  }
}
