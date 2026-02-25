/**
 * Skills installation functions.
 * Delegates installation to CAAMP.
 *
 * @epic T4454
 * @task T4521
 */

import {
  installSkill as caampInstallSkill,
  getInstalledProviders,
} from '@cleocode/caamp';

/**
 * Install a single skill via CAAMP.
 */
export async function installSkill(
  skillName: string,
  projectDir?: string,
): Promise<{ installed: boolean; path: string; error?: string }> {
  try {
    const providers = getInstalledProviders();
    if (providers.length === 0) {
      return { installed: false, path: '', error: 'No target providers found' };
    }

    const source = `library:${skillName}`;
    const result = await caampInstallSkill(source, skillName, providers, true, projectDir);
    if (!result.success) {
      return {
        installed: false,
        path: result.canonicalPath,
        error: result.errors.join('; ') || 'Install failed',
      };
    }

    return {
      installed: true,
      path: result.canonicalPath,
    };
  } catch (err) {
    return {
      installed: false,
      path: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
