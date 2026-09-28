/**
 * `~/.cleo` link audit and repair — the keystone of global protocol delivery.
 *
 * The global hub `~/.agents/AGENTS.md` references
 * `@~/.cleo/templates/CLEO-INJECTION.md`. That path is only real when
 * `~/.cleo` links to the OS data directory (`getCleoHome()`): `~/.local/share/cleo`
 * on Linux, `~/Library/Application Support/cleo` on macOS,
 * `%LOCALAPPDATA%\cleo\Data` on Windows. A link carried between machines by
 * dotfiles (a macOS `~/.cleo` pointing at `/home/<user>/.local/share/cleo`)
 * dangles, and every harness loading the hub silently receives NO protocol —
 * no error, just an unresolved reference (T12596).
 *
 * `existsSync` follows links, so a dangling link reads as ABSENT; creating a
 * link over it then fails with `EEXIST`. Everything here classifies with
 * `lstat` first for that reason.
 *
 * @task T12596
 */

import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
} from 'node:fs';
import { rename, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, normalize, resolve, sep } from 'node:path';
import { resolveLegacyCleoDir } from '@cleocode/paths';
import { getCleoHome } from '../paths.js';

/** The reference the global hub writes; identical on every OS. */
export const CANONICAL_HUB_TEMPLATE_REF = '@~/.cleo/templates/CLEO-INJECTION.md';

/**
 * State of `~/.cleo`:
 * - `canonical` — a link to `getCleoHome()` (or `CLEO_HOME` IS `~/.cleo`).
 * - `absent`    — nothing there.
 * - `dangling`  — a link whose target does not exist (e.g. a Linux path on macOS).
 * - `foreign`   — a link to an existing directory that is not `getCleoHome()`.
 * - `directory` — a real directory (pre-canonical layout).
 * - `other`     — a regular file or anything else; never touched.
 */
export type CleoLinkState = 'canonical' | 'absent' | 'dangling' | 'foreign' | 'directory' | 'other';

/** Result of {@link auditCleoLink}. */
export interface CleoLinkAudit {
  /** Absolute `~/.cleo` path. */
  path: string;
  /** Where the link must point: `getCleoHome()`. */
  canonicalTarget: string;
  /** Classified state. */
  state: CleoLinkState;
  /** Current link target, or null when `~/.cleo` is not a link. */
  target: string | null;
  /** True when the hub reference `~/.cleo/templates/CLEO-INJECTION.md` resolves to a file. */
  hubReferenceResolves: boolean;
  /** True when `repairCleoLink` can bring the link to `canonical`. */
  repairable: boolean;
  /** Exact command that repairs this state, or null when healthy / not repairable. */
  remedy: string | null;
}

/** Receipt written for every non-dry-run {@link repairCleoLink}. */
export interface CleoLinkRepairReceipt {
  /** Unique receipt id. */
  receiptId: string;
  /** ISO timestamp. */
  at: string;
  /** What was done. */
  action: 'none' | 'created' | 'relinked' | 'refused';
  /** State and target before the repair. */
  before: { state: CleoLinkState; target: string | null };
  /** State and target after the repair. */
  after: { state: CleoLinkState; target: string | null };
  /**
   * Where the previous entry was moved (a live foreign link or a directory),
   * so the repair is reversible; null when nothing needed preserving.
   */
  preservedAt: string | null;
  /** Why the repair was refused, when `action === 'refused'`. */
  reason: string | null;
  /** JSONL file the receipt was appended to, or null on a dry run. */
  receiptLog: string | null;
  /**
   * Lifecycle phase of this receipt line. An `intent` line is appended BEFORE
   * anything on disk changes, so a crash between the preserve-rename and the
   * new link still leaves a record of where the old entry went; the final
   * line is `completed` or `rolled-back`. `planned` receipts (dry run, no-op,
   * refused) are returned but never written.
   */
  phase: 'intent' | 'completed' | 'rolled-back' | 'planned';
}

/** Thrown when creating the `~/.cleo` link fails; the previous entry has been restored. */
export class CleoLinkRepairError extends Error {
  /** Stable error code. */
  readonly code = 'E_CLEO_LINK_REPAIR_FAILED';
  /**
   * @param message - What failed.
   * @param receipt - The `rolled-back` receipt (also appended to the log).
   */
  constructor(
    message: string,
    readonly receipt: CleoLinkRepairReceipt,
  ) {
    super(message);
    this.name = 'CleoLinkRepairError';
  }
}

/** Options shared by the audit and repair functions (tests inject paths). */
export interface CleoLinkOptions {
  /** `~/.cleo` path. Defaults to `resolveLegacyCleoDir()`. */
  path?: string;
  /** Link target. Defaults to `getCleoHome()`. */
  canonicalTarget?: string;
}

/** Repair command printed in remedies and warnings. */
export const CLEO_LINK_REPAIR_COMMAND = 'cleo doctor global-delivery --repair';

function sameTarget(a: string, b: string): boolean {
  return normalize(a.replace(/^\\\\\?\\/, '')) === normalize(b);
}

/**
 * True when mutating `linkPath` to point at `target` would bind a real,
 * non-temporary `~/.cleo` to a temporary directory — the shape of a test run
 * that overrides `CLEO_HOME` without overriding `HOME`. Refused so a test can
 * never repoint the developer's own `~/.cleo` at a scratch directory.
 */
export function wouldBindRealHomeToTemp(linkPath: string, target: string): boolean {
  const roots = [...new Set([tmpdir(), '/tmp', '/private/tmp'].map(realPathOf))];
  const inTmp = (p: string): boolean => {
    const real = realPathOf(p);
    return roots.some((root) => real === root || real.startsWith(root + sep));
  };
  return inTmp(target) && !inTmp(linkPath);
}

/**
 * `realpath` of `p`, or of its nearest existing ancestor with the missing tail
 * re-appended. Paths being repaired often do not exist yet, and a prefix match
 * on the unresolved form misses `/tmp` → `/private/tmp` and
 * `os.tmpdir()` → `/private/var/folders/…` on macOS.
 */
function realPathOf(p: string): string {
  let current = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(current), ...tail.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(p);
      tail.push(basename(current));
      current = parent;
    }
  }
}

/**
 * Classify `~/.cleo` without modifying anything.
 *
 * @param opts - Path overrides (tests).
 * @returns The audit; `remedy` names the exact repair command when one applies.
 * @task T12596
 */
export function auditCleoLink(opts: CleoLinkOptions = {}): CleoLinkAudit {
  const path = opts.path ?? resolveLegacyCleoDir();
  const canonicalTarget = opts.canonicalTarget ?? getCleoHome();
  const hubReferenceResolves = existsSync(join(path, 'templates', 'CLEO-INJECTION.md'));
  const result = (
    state: CleoLinkState,
    target: string | null,
    repairable: boolean,
  ): CleoLinkAudit => ({
    path,
    canonicalTarget,
    state,
    target,
    hubReferenceResolves,
    repairable,
    remedy: state === 'canonical' || !repairable ? null : CLEO_LINK_REPAIR_COMMAND,
  });

  // CLEO_HOME set to ~/.cleo itself: the data dir IS the reference path.
  if (sameTarget(path, canonicalTarget)) return result('canonical', null, false);

  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    return result('absent', null, true);
  }
  if (stat.isSymbolicLink()) {
    const target = readlinkSync(path);
    const absolute = resolve(dirname(path), target);
    if (sameTarget(target, canonicalTarget) || sameTarget(absolute, canonicalTarget)) {
      return result('canonical', target, false);
    }
    return result(existsSync(absolute) ? 'foreign' : 'dangling', target, true);
  }
  if (stat.isDirectory()) return result('directory', null, true);
  return result('other', null, false);
}

/**
 * Bring `~/.cleo` to the canonical link and record a receipt.
 *
 * - `absent` → create the link.
 * - `dangling` → replace the link (it reaches nothing, so nothing is lost;
 *   the old target is kept in the receipt).
 * - `foreign` / `directory` → move the entry to `~/.cleo.preserved-<ts>` (a
 *   foreign link stays a link, keeping its target), then create the link.
 * - `other`, or a real `~/.cleo` whose target would be a temp dir → refused.
 *
 * Receipts are appended to `<cleoHome>/audit/cleo-link-repairs.jsonl`.
 *
 * @param opts - `dryRun` reports the planned action without touching disk;
 *   `states` limits which states may be repaired (bootstrap passes only the
 *   lossless ones: `absent`, `dangling`).
 * @returns The final audit plus the receipt.
 * @task T12596
 */
export async function repairCleoLink(
  opts: CleoLinkOptions & { dryRun?: boolean; states?: readonly CleoLinkState[] } = {},
): Promise<{ audit: CleoLinkAudit; receipt: CleoLinkRepairReceipt }> {
  const before = auditCleoLink(opts);
  const at = new Date().toISOString();
  const receipt: CleoLinkRepairReceipt = {
    receiptId: randomUUID(),
    at,
    action: 'none',
    before: { state: before.state, target: before.target },
    after: { state: before.state, target: before.target },
    preservedAt: null,
    reason: null,
    receiptLog: null,
    phase: 'planned',
  };

  const allowed = opts.states ?? ['absent', 'dangling', 'foreign', 'directory'];
  if (before.state === 'canonical') return { audit: before, receipt };
  if (!before.repairable || !allowed.includes(before.state)) {
    receipt.action = 'refused';
    receipt.reason = before.repairable
      ? `state "${before.state}" is not repaired automatically; run: ${CLEO_LINK_REPAIR_COMMAND}`
      : `~/.cleo is a ${before.state} entry; move it aside manually`;
    return { audit: before, receipt };
  }
  if (wouldBindRealHomeToTemp(before.path, before.canonicalTarget)) {
    receipt.action = 'refused';
    receipt.reason = `refusing to link ${before.path} to temporary directory ${before.canonicalTarget}`;
    return { audit: before, receipt };
  }

  receipt.action = before.state === 'absent' ? 'created' : 'relinked';
  if (before.state === 'foreign' || before.state === 'directory') {
    receipt.preservedAt = `${before.path}.preserved-${at.replace(/[:.]/g, '-')}`;
  }
  if (opts.dryRun === true) {
    receipt.after = { state: 'canonical', target: before.canonicalTarget };
    return { audit: before, receipt };
  }

  mkdirSync(before.canonicalTarget, { recursive: true });
  const logDir = join(before.canonicalTarget, 'audit');
  mkdirSync(logDir, { recursive: true });
  receipt.receiptLog = join(logDir, 'cleo-link-repairs.jsonl');
  const log = (phase: CleoLinkRepairReceipt['phase']): void => {
    receipt.phase = phase;
    appendFileSync(receipt.receiptLog as string, `${JSON.stringify(receipt)}\n`, 'utf8');
  };
  // Intent first: if anything below dies, the log still says where the old
  // entry is (preservedAt) and what it pointed at (before.target).
  log('intent');

  let unlinkedDangling = false;
  let preserved = false;
  try {
    if (before.state === 'dangling') {
      await unlink(before.path);
      unlinkedDangling = true;
    }
    if (receipt.preservedAt) {
      await rename(before.path, receipt.preservedAt);
      preserved = true;
    }
    const linkType: 'dir' | 'junction' = process.platform === 'win32' ? 'junction' : 'dir';
    await symlink(before.canonicalTarget, before.path, linkType);
  } catch (err) {
    // Roll back: put the previous entry exactly where it was.
    if (preserved && receipt.preservedAt) await rename(receipt.preservedAt, before.path);
    if (unlinkedDangling && before.target !== null) await symlink(before.target, before.path);
    receipt.after = { state: before.state, target: before.target };
    receipt.reason = err instanceof Error ? err.message : String(err);
    log('rolled-back');
    throw new CleoLinkRepairError(
      `Could not link ${before.path} → ${before.canonicalTarget}: ${receipt.reason}. ` +
        'The previous entry was restored.',
      receipt,
    );
  }

  const after = auditCleoLink(opts);
  receipt.after = { state: after.state, target: after.target };
  log('completed');
  return { audit: after, receipt };
}

/**
 * Content for the global hub's CAAMP block.
 *
 * Normally the one-line canonical reference. When `~/.cleo/templates` does not
 * resolve (a link the bootstrap could not repair), a reference would deliver
 * nothing — so the protocol text is embedded instead, with a marker naming
 * the repair. Once the link is repaired the next bootstrap writes the
 * reference again.
 *
 * @param templateContent - Installed `CLEO-INJECTION.md` text (embedded on fallback).
 * @param opts - Path overrides (tests).
 * @returns The block content and which mode was chosen.
 * @task T12596
 */
export function resolveGlobalHubContent(
  templateContent: string | null,
  opts: CleoLinkOptions = {},
): { content: string; mode: 'reference' | 'embedded'; audit: CleoLinkAudit } {
  const audit = auditCleoLink(opts);
  if (audit.hubReferenceResolves || templateContent === null) {
    return { content: CANONICAL_HUB_TEMPLATE_REF, mode: 'reference', audit };
  }
  const note =
    `<!-- CLEO protocol embedded: ${CANONICAL_HUB_TEMPLATE_REF.slice(1)} does not resolve ` +
    `(~/.cleo is ${audit.state}). Run \`${CLEO_LINK_REPAIR_COMMAND}\`. -->`;
  return { content: `${note}\n${templateContent.trim()}`, mode: 'embedded', audit };
}
