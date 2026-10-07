/**
 * A provider's PROJECT instruction file, skipped (not failed) at a project
 * rooted at the home directory (T13227).
 *
 * Providers load CLAUDE.md / AGENTS.md / GEMINI.md from the working directory
 * up through every ancestor, so a file at `$HOME` reaches every session under
 * it: CAAMP refuses it with `HomeInstructionFileError`. An adapter's install
 * reports that step as `skipped` and carries on with the rest, the way the
 * heavy-command hook already skips the home directory (T12983).
 *
 * @task T13227
 */

import {
  type EnsureProviderInstructionFileOptions,
  type EnsureProviderInstructionFileResult,
  ensureProviderInstructionFile,
  HomeInstructionFileError,
} from '@cleocode/caamp';

/**
 * Ensure a provider's project instruction file, or `null` when the project is
 * the home directory and the file was refused (nothing written).
 *
 * @param providerId - CAAMP provider id.
 * @param projectDir - the project root.
 * @param options - references, content, scope.
 * @returns the CAAMP result, or `null` when skipped at `$HOME`.
 *
 * @example
 * ```typescript
 * const r = await ensureProjectInstructionFile('codex', projectDir, { scope: 'project' });
 * if (r === null) details.instructionFile = 'skipped';
 * ```
 */
export async function ensureProjectInstructionFile(
  providerId: string,
  projectDir: string,
  options: EnsureProviderInstructionFileOptions,
): Promise<EnsureProviderInstructionFileResult | null> {
  try {
    return await ensureProviderInstructionFile(providerId, projectDir, options);
  } catch (err) {
    if (err instanceof HomeInstructionFileError) return null;
    throw err;
  }
}
