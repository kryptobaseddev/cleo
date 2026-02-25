import { registerSkillLibraryFromPath } from '@cleocode/caamp';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export function bootstrapCaamp(): void {
  const thisFile = fileURLToPath(import.meta.url);
  const packageRoot = join(dirname(thisFile), '..', '..');
  const ctSkillsRoot = join(packageRoot, 'packages', 'ct-skills');

  try {
    registerSkillLibraryFromPath(ctSkillsRoot);
  } catch (err) {
    console.error(`Failed to register bundled CAAMP skill library: ${err}`);
    process.exit(1);
  }
}
