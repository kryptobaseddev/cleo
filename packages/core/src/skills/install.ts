/**
 * Skills installation functions.
 * Delegates installation to CAAMP's gated install pipeline.
 *
 * @epic T4454
 * @task T4521
 * @task T12383
 * @task T12384
 */

import { getInstalledProviders, installSkillFromSource } from '@cleocode/caamp';

/**
 * Install a single skill from the registered skill library via CAAMP.
 *
 * @remarks
 * Goes through `installSkillFromSource`, which resolves `library:<name>` to
 * the library's directory (or refuses), runs the fail-closed security gate,
 * and stages the new copy before replacing an installed one. Before T12383
 * this passed `library:<name>` to the copier as a path, which deleted the
 * installed skill and then failed.
 *
 * @param skillName - Name of a skill in the registered library
 * @param projectDir - Project directory for project-scoped provider links
 * @returns Whether the skill was installed, where, and why not when it was not
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

    const result = await installSkillFromSource(`library:${skillName}`, {
      providers,
      isGlobal: true,
      projectDir,
    });
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
