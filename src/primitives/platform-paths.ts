/**
 * Re-export platform paths from canonical source.
 * Used by packages/core/src/primitives/paths.ts.
 *
 * @epic T5716
 */

export type { PlatformPaths, SystemInfo } from '../core/system/platform-paths.js';
export {
  _resetPlatformPathsCache,
  getPlatformPaths,
  getSystemInfo,
} from '../core/system/platform-paths.js';
