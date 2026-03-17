/**
 * Git checkpoint system for CLEO state files.
 * Ported from lib/data/git-checkpoint.sh
 *
 * Opt-in automatic git commits of .cleo/ state files at semantic
 * boundaries (save_json, session end) with debounce to prevent commit noise.
 * All git errors are suppressed - checkpointing is never fatal.
 *
 * @task T4552
 * @task T4872
 * @epic T4545
 */
/**
 * Build environment variables that point git at the isolated .cleo/.git repo.
 * @task T4872
 */
export declare function makeCleoGitEnv(cleoDir: string): NodeJS.ProcessEnv;
/**
 * Run a git command against the isolated .cleo/.git repo, suppressing errors.
 * @task T4872
 */
export declare function cleoGitCommand(args: string[], cleoDir: string): Promise<{
    stdout: string;
    success: boolean;
}>;
/**
 * Check whether the isolated .cleo/.git repo has been initialized.
 * @task T4872
 */
export declare function isCleoGitInitialized(cleoDir: string): boolean;
/**
 * Load additional state file paths from config.json `checkpoint.stateFileAllowlist`.
 * Returns an empty array if config is missing, malformed, or the key is absent.
 */
export declare function loadStateFileAllowlist(cwd?: string): Promise<string[]>;
/** Checkpoint configuration. */
export interface CheckpointConfig {
    enabled: boolean;
    debounceMinutes: number;
    messagePrefix: string;
    noVerify: boolean;
}
/** Checkpoint status information. */
export interface CheckpointStatus {
    config: CheckpointConfig;
    status: {
        isGitRepo: boolean;
        lastCheckpoint: string;
        lastCheckpointEpoch: number;
        pendingChanges: number;
        suppressed: boolean;
    };
}
/** Changed file with its status. */
export interface ChangedFile {
    path: string;
    status: 'modified' | 'untracked';
}
/**
 * Load checkpoint configuration from config.json.
 * @task T4552
 */
export declare function loadCheckpointConfig(cwd?: string): Promise<CheckpointConfig>;
/**
 * Check whether a checkpoint should be performed.
 * Evaluates: enabled, .cleo/.git initialized, debounce elapsed, files changed.
 * @task T4552
 * @task T4872
 */
export declare function shouldCheckpoint(options?: {
    force?: boolean;
    cwd?: string;
}): Promise<boolean>;
/**
 * Stage .cleo/ state files and commit to the isolated .cleo/.git repo.
 * Never fatal - all git errors are suppressed.
 * @task T4552
 * @task T4872
 */
export declare function gitCheckpoint(trigger?: 'auto' | 'session-end' | 'manual', context?: string, cwd?: string): Promise<void>;
/**
 * Show checkpoint configuration and status.
 * @task T4552
 * @task T4872
 */
export declare function gitCheckpointStatus(cwd?: string): Promise<CheckpointStatus>;
/**
 * Show what files would be committed (dry-run).
 * @task T4552
 * @task T4872
 */
export declare function gitCheckpointDryRun(cwd?: string): Promise<ChangedFile[]>;
//# sourceMappingURL=git-checkpoint.d.ts.map