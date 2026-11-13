/** Shared package-export selection for workspace source resolution and its architecture gate. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @param {unknown} value - A parsed JSON value.
 * @returns {value is Record<string, unknown>} Whether the value is an object map.
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Read a workspace package's subpath export map without loading its built code.
 *
 * @param {string} packageDir - The package directory.
 * @returns {Record<string, unknown>} The export map, or an empty map when absent.
 */
export function readPackageExports(packageDir) {
  const path = join(packageDir, 'package.json');
  if (!existsSync(path)) return {};
  const manifest = /** @type {unknown} */ (JSON.parse(readFileSync(path, 'utf8')));
  return isRecord(manifest) && isRecord(manifest.exports) ? manifest.exports : {};
}

/**
 * Pick the conditional target of one `exports` value for an ESM import.
 *
 * @param {unknown} value - An `exports` map value.
 * @param {'import' | 'types'} condition - The condition to resolve.
 * @returns {string | null} The target string, or null.
 */
function conditionalTarget(value, condition) {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return null;
  for (const [key, inner] of Object.entries(value)) {
    if (key === condition || key === 'default') return conditionalTarget(inner, condition);
  }
  return null;
}

/**
 * Resolve a package subpath through its `exports`: exact keys first, then
 * patterns with the longest prefix before `*` (ties: the longer key).
 *
 * @param {Record<string, unknown>} exportsMap - `package.json` `exports`.
 * @param {string} subpath - The subpath after the package name (`config.js`), or empty for the root.
 * @param {'import' | 'types'} condition - The condition to resolve.
 * @returns {string | null} The target (`./dist/x.js`), or null when not exported.
 */
export function resolveExportsTarget(exportsMap, subpath, condition) {
  const key = subpath === '' ? '.' : `./${subpath}`;
  if (Object.hasOwn(exportsMap, key)) return conditionalTarget(exportsMap[key], condition);
  let best = null;
  for (const pattern of Object.keys(exportsMap)) {
    const star = pattern.indexOf('*');
    if (star === -1 || pattern.indexOf('*', star + 1) !== -1) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (key.length < pattern.length || !key.startsWith(prefix) || !key.endsWith(suffix)) continue;
    if (
      best === null ||
      prefix.length > best.prefix.length ||
      (prefix.length === best.prefix.length && pattern.length > best.pattern.length)
    ) {
      best = { pattern, prefix, match: key.slice(prefix.length, key.length - suffix.length) };
    }
  }
  if (best === null) return null;
  const target = conditionalTarget(exportsMap[best.pattern], condition);
  return target === null ? null : target.replaceAll('*', best.match);
}
