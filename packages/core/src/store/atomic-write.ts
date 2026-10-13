/**
 * Crash-safe single-file writes shared by every byte-target writer
 * (T13657 review on #2210): the `docs-update` blob mirror, the
 * attachment-store legacy + blob-store writes, and the docs-doctor
 * blob backfill. One chokepoint so the tmp-then-rename discipline is
 * not re-implemented (and not re-broken) at each site.
 *
 * Two primitives:
 *
 *   - {@link writeFileAtomic} writes to a UNIQUE tmp file
 *     (`<target>.tmp.<pid>.<uuid>`) and renames it into place. A fixed
 *     tmp name lets two concurrent writers of the same content truncate
 *     each other; a plain write-to-target lets an interrupted write
 *     leave a truncated file that `existsSync`-style existence checks
 *     then trust forever. The rename is atomic on the same filesystem,
 *     so readers never observe a partial target, and a crash mid-write
 *     leaves only the tmp file — which nothing counts as coverage.
 *   - {@link fileBytesMatchSha256} re-hashes an existing target before
 *     it is trusted. A truncated or corrupted file at a content address
 *     fails the check, so callers replace it from their already-verified
 *     bytes instead of skipping the write on existence alone.
 *
 * @module
 * @task T13657
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Write `bytes` to `target` crash-safely: unique tmp file in the target's
 * directory, then an atomic rename over the target.
 *
 * The tmp name carries the pid AND a random suffix, so two writers racing
 * the same target — even two puts of the same content in one process —
 * each write their own tmp and the last rename wins with complete bytes.
 * A crash mid-write leaves only the tmp file, never a truncated target;
 * a failure removes the tmp best-effort before the error propagates.
 *
 * @param target - Absolute final path. Its directory is created when missing.
 * @param bytes - The complete, already-verified bytes to write.
 */
export async function writeFileAtomic(target: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${process.pid}.${randomUUID()}`;
  try {
    await writeFile(tmp, bytes);
    await rename(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {
      /* tmp already gone — nothing to clean */
    });
    throw err;
  }
}

/**
 * True when `target` exists AND its bytes re-hash to `sha256`. Any read
 * failure (absent, unreadable) returns false — existence alone is never
 * proof that a content-addressed file holds the bytes its name claims
 * (T13657): a truncated leftover from an interrupted pre-atomic write
 * must be replaced, not trusted.
 *
 * @param target - Absolute path of the content-addressed file.
 * @param sha256 - Lowercase hex SHA-256 the bytes must match.
 */
export async function fileBytesMatchSha256(target: string, sha256: string): Promise<boolean> {
  try {
    const bytes = await readFile(target);
    return createHash('sha256').update(bytes).digest('hex') === sha256;
  } catch {
    return false;
  }
}
