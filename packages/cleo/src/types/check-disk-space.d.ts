/**
 * Module declaration shim for check-disk-space.
 *
 * check-disk-space v3 ships a `.d.ts` declaration but not `.d.mts`. TypeScript 6 +
 * NodeNext ESM resolution resolves the package through the "types" condition to the
 * `.d.ts` file, but treats the module as a namespace (no call signatures) because
 * there is no corresponding `.d.mts` for the ESM import path. This shim overrides
 * the module declaration to expose the correct callable default export. (T755)
 */
declare module 'check-disk-space' {
  /** Disk usage information returned by checkDiskSpace. */
  export interface DiskSpace {
    diskPath: string;
    free: number;
    size: number;
  }

  /**
   * Check the available disk space at the given directory path.
   *
   * @param directoryPath - Filesystem path to check disk space for.
   * @returns Promise resolving to disk usage info (diskPath, free, size in bytes).
   */
  export default function checkDiskSpace(directoryPath: string): Promise<DiskSpace>;
}
