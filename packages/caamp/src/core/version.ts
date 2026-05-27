import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let cachedVersion: string | null = null;

/**
 * Retrieve the current CAAMP package version from the nearest `package.json`.
 *
 * @remarks
 * The version string is read once from `package.json` relative to this module
 * and cached for the lifetime of the process. Returns `"0.0.0"` when the file
 * cannot be found or parsed.
 *
 * @returns The semver version string (e.g. `"1.8.1"`)
 *
 * @example
 * ```typescript
 * const version = getCaampVersion();
 * console.log(`CAAMP v${version}`);
 * ```
 *
 * @public
 */
export function getCaampVersion(): string {
  if (cachedVersion) return cachedVersion;

  try {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const packageJsonPath = join(currentDir, '..', 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { version?: string };
    cachedVersion = packageJson.version ?? '0.0.0';
  } catch {
    cachedVersion = '0.0.0';
  }

  return cachedVersion;
}
