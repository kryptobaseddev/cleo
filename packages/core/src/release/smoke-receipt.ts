/**
 * The release smoke receipt gate (T14250): a stable release needs a passing
 * real-store smoke of the commit it ships. `scripts/release-mac-smoke.mjs`
 * writes the receipt; `releaseCut` and `releaseOpen` read it.
 *
 * @task T14250
 * @epic T14234
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The release smoke check of a commit. */
export interface ReleaseSmokeCheck {
  /** The receipt read, or the first path looked at when none exists. */
  receipt: string;
  /** Why the receipt does not clear the commit, or null when it passed on it. */
  problem: string | null;
}

/** The fields of a `scripts/release-mac-smoke.mjs` receipt the gate reads. */
interface ReleaseSmokeReceipt {
  sha: string | null;
  passed: boolean;
  cliVersion: string | null;
}

/**
 * Read the release smoke receipt for `sha`. The smoke writes
 * `.cleo/release-smoke/<sha12>/results.json` in the checkout it ran from, so
 * every given checkout is looked in, in order.
 *
 * @param roots - Checkouts to look in.
 * @param sha - The full commit sha the release ships.
 * @returns The receipt path and why it does not clear `sha` (null when it does).
 */
export function releaseSmokeCheck(roots: readonly string[], sha: string): ReleaseSmokeCheck {
  const paths = [...new Set(roots)].map((root) =>
    join(root, '.cleo', 'release-smoke', sha.slice(0, 12), 'results.json'),
  );
  const receipt = paths.find((p) => existsSync(p));
  if (receipt === undefined) {
    return { receipt: paths[0] ?? '', problem: `no release smoke receipt for ${sha}` };
  }
  let parsed: Partial<ReleaseSmokeReceipt>;
  try {
    parsed = JSON.parse(readFileSync(receipt, 'utf8'));
  } catch (err) {
    return { receipt, problem: `the smoke receipt is unreadable: ${String(err)}` };
  }
  if (parsed.sha !== sha) {
    return {
      receipt,
      problem: `the smoke receipt is for ${parsed.sha ?? 'no commit'}, not ${sha}`,
    };
  }
  if (parsed.passed !== true) {
    return {
      receipt,
      problem: `the release smoke FAILED on ${sha} (CLI ${parsed.cliVersion ?? 'unknown'})`,
    };
  }
  return { receipt, problem: null };
}

/**
 * The fix a refusal names: smoke the commit on the owner's Mac.
 *
 * @param sha - The commit to smoke.
 * @returns The fix text.
 */
export function releaseSmokeFix(sha: string): string {
  return `On the owner's Mac, check out ${sha} and run node scripts/release-mac-smoke.mjs --sha ${sha}; fix forward if it fails, then re-run`;
}
