/**
 * Numbered backup system for CLEO data files.
 * Maintains a rotating window of recent backups for rollback protection.
 * @epic T4454
 * @task T4457
 */
/**
 * Create a numbered backup of a file.
 * Rotates existing backups (file.1 -> file.2, etc.) and removes excess.
 */
export declare function createBackup(filePath: string, backupDir: string, maxBackups?: number): Promise<string>;
/**
 * List existing backups for a file, sorted by number (newest first).
 */
export declare function listBackups(fileName: string, backupDir: string): Promise<string[]>;
/**
 * Restore a file from its most recent backup.
 * Returns the path of the backup that was restored.
 */
export declare function restoreFromBackup(fileName: string, backupDir: string, targetPath: string): Promise<string>;
//# sourceMappingURL=backup.d.ts.map