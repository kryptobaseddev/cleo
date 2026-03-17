/**
 * Re-export platform paths from canonical source.
 * Used by packages/core/src/primitives/paths.ts.
 *
 * @epic T5716
 */

export { getPlatformPaths, getSystemInfo, _resetPlatformPathsCache } from '../../../../src/core/system/platform-paths.js';
export type { PlatformPaths, SystemInfo } from '../../../../src/core/system/platform-paths.js';
