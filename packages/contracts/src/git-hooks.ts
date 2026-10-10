/** Hash-guarded Git hook installation and recovery contracts. */
import { z } from 'zod';

/** Canonical names of the three shipped Git checks. */
export const CLEO_GIT_HOOK_NAMES = ['commit-msg', 'pre-commit', 'pre-push'] as const;

/** One recoverable managed Git hook change. */
export const GitHookChangeSchema = z.object({
  name: z.enum(CLEO_GIT_HOOK_NAMES),
  before: z.string().nullable(),
  beforeMode: z.number().int().min(0).max(0o777).nullable(),
  afterHash: z.string().regex(/^[a-f0-9]{64}$/),
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
