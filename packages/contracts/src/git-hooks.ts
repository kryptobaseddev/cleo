/** Hash-guarded Git hook installation and recovery contracts. */
import { z } from 'zod';

/**
 * Canonical names of the shipped Git hooks: three checks, and four `post-*`
 * hooks that start a detached incremental NEXUS refresh (T14010, T12349).
 */
export const CLEO_GIT_HOOK_NAMES = [
  'commit-msg',
  'pre-commit',
  'pre-push',
  'post-merge',
  'post-commit',
  'post-checkout',
  'post-rewrite',
] as const;

/** Name of a shipped Git hook. */
export type CleoGitHookName = (typeof CLEO_GIT_HOOK_NAMES)[number];

/**
 * Hooks whose exit status Git ignores. A foreign hook found at one of these
 * names is chained, not skipped: it moves to `<name>.cleo-chained`, and the
 * CLEO hook runs it last with the same arguments and stdin (T12349).
 */
export const CHAINED_GIT_HOOK_NAMES: readonly CleoGitHookName[] = [
  'post-merge',
  'post-commit',
  'post-checkout',
  'post-rewrite',
];

/**
 * Hooks that exist only to keep the NEXUS index current (T12349): installed
 * unless `cleo.nexusAutoReindex` is `false`, and removed by
 * `cleo nexus hooks uninstall`.
 */
export const NEXUS_GIT_HOOK_NAMES: readonly CleoGitHookName[] = [
  'post-commit',
  'post-checkout',
  'post-rewrite',
];

/** One recoverable managed Git hook change. */
export const GitHookChangeSchema = z.object({
  name: z.enum(CLEO_GIT_HOOK_NAMES),
  before: z.string().nullable(),
  beforeMode: z.number().int().min(0).max(0o777).nullable(),
  afterHash: z.string().regex(/^[a-f0-9]{64}$/),
  /** The `before` hook was moved to `<name>.cleo-chained`, not overwritten. */
  chained: z.boolean().optional(),
});
/** A receipt scoped to the effective Git hook directory. */
export const GitHookInstallReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  hooksDir: z.string(),
  changes: z.array(GitHookChangeSchema),
});
/** One managed change with its recovery image. */
export type GitHookChange = z.infer<typeof GitHookChangeSchema>;
/** Installation image used only after matching the current content hash. */
export type GitHookInstallReceipt = z.infer<typeof GitHookInstallReceiptSchema>;

/** Exact hashes of historical shipped templates; marker text is insufficient. */
export const GitHookLegacyHashesSchema = z.record(
  z.string(),
  z.array(z.string().regex(/^[a-f0-9]{64}$/)),
);

/** Explicit installer controls shared by SDK wrappers and CLI delivery. */
export interface GitHookInstallOptions {
  /** Override shipped template location. */
  templatesDir?: string;
  /** Deprecated compatibility flag; never bypasses ownership or tracked-path safety. */
  force?: boolean;
  /** Preview without filesystem mutations. */
  dryRun?: boolean;
  /** Restore matching local installation images. */
  rollbackReceipt?: GitHookInstallReceipt;
  /** Explicitly permit writes into an effective hooksPath inside the working tree. */
  allowTrackedHooksPath?: boolean;
  /** Hooks to manage (default: every shipped hook, less the NEXUS hooks when disabled). */
  names?: readonly CleoGitHookName[];
  /** Restore the recorded pre-CLEO image of `names` (exact bytes and mode). */
  uninstall?: boolean;
}
