/**
 * Test-fixture sweep for the real skills root — finds and quarantines skill
 * directories that caamp unit tests wrote into `<cleoHome>/skills` before the
 * test sandbox covered the skills root (T12645).
 *
 * Measured 2026-09-28 on macOS: 53 of the 70 entries were fixtures —
 * `<prefix>-<uuid>` dirs from `skills-installer.test.ts` /
 * `skills-installer-recordrow.test.ts`, plus `real-skill`, `skill-alpha` and
 * `skill-beta`. Every one surfaced in skill listings and harness installs.
 *
 * Matching is deliberately narrow. An entry is a fixture only when BOTH hold:
 * - its name is `<slug>-<uuid>` or one of {@link SKILL_FIXTURE_EXACT_NAMES};
 * - its content is exactly what those tests write: a `SKILL.md` whose
 *   description is `Test skill <name>` or `Deep nested skill`, plus only
 *   small regular files and directories (no links).
 * A name match whose content does not fit is reported `unclassified` and left
 * in place. Hidden/underscore entries (`.audit-log`, `_archive`, …), manifest
 * skills and bundled skill names are never candidates.
 *
 * Repair MOVES each fixture into
 * `<cleoHome>/audit/skill-fixture-quarantine/<receiptId>/<name>` — nothing
 * is deleted — and appends intent/completed receipts to
 * `<cleoHome>/audit/skill-fixtures.jsonl`, each naming both paths and the
 * sha256 of every file moved. Across filesystems (EXDEV) the move is a copy,
 * re-hashed against that inventory before the source is removed.
 * {@link restoreSkillFixtures} moves a run's entries back.
 *
 * @task T12645
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { basename, join, relative } from 'node:path';
import { getCleoHome } from '../paths.js';
import { listCanonicalSkillNames, parseFrontmatter } from '../skills/discovery.js';
import { resolveBundledSkillsDir, resolveSkillsRoot } from '../skills/skill-root.js';

/** Repair command printed in remedies. */
export const SKILL_FIXTURES_REPAIR_COMMAND = 'cleo doctor skill-fixtures --repair';

/** `<slug>-<uuid>` — every randomized caamp installer fixture name. */
export const SKILL_FIXTURE_UUID_NAME =
  /^[a-z0-9][a-z0-9._-]*-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Fixed fixture names written by `skills-installer.test.ts`. */
export const SKILL_FIXTURE_EXACT_NAMES: readonly string[] = [
  'real-skill',
  'skill-alpha',
  'skill-beta',
];

/** The only SKILL.md descriptions those tests write. */
const FIXTURE_DESCRIPTION = /^(Test skill \S+|Deep nested skill)$/;

/** Fixture files are one-liners; anything bigger is not ours to judge. */
const MAX_FIXTURE_FILE_BYTES = 1024;

/** Fixtures hold at most a handful of entries. */
const MAX_FIXTURE_ENTRIES = 16;

/** One file inside a fixture, recorded in the receipt. */
export interface SkillFixtureFile {
  /** Path relative to the fixture dir. */
  path: string;
  /** Size in bytes. */
  bytes: number;
  /** sha256 of the content. */
  sha256: string;
}

/** One candidate entry in the skills root. */
export interface SkillFixtureEntry {
  /** Entry name. */
  name: string;
  /** Absolute path. */
  path: string;
  /** `fixture` is safe to quarantine; `unclassified` is reported only. */
  state: 'fixture' | 'unclassified';
  /** Why an entry is unclassified, else null. */
  reason: string | null;
  /** Files found (empty when unclassified before the walk finished). */
  files: SkillFixtureFile[];
}

/** Audit of one skills root. */
export interface SkillFixtureAudit {
  /** Skills root inspected. */
  skillsRoot: string;
  /** Every fixture-named entry, classified. */
  entries: SkillFixtureEntry[];
  /** Per-state counts. */
  counts: { fixture: number; unclassified: number };
  /** True when no fixture remains. Unclassified entries need a human. */
  healthy: boolean;
  /** Exact repair command, or null when healthy. */
  remedy: string | null;
}

/** Receipt for one {@link repairSkillFixtures} run. */
export interface SkillFixtureReceipt {
  /** Unique receipt id; also the quarantine subdirectory name. */
  receiptId: string;
  /** ISO timestamp. */
  at: string;
  /** Dry run: nothing moved, nothing written. */
  dryRun: boolean;
  /** `planned` (dry run, returned only) · `intent` · `completed` · `failed`. */
  phase: 'planned' | 'intent' | 'completed' | 'failed';
  /** Quarantine directory for this run. */
  quarantineDir: string;
  /** Every fixture the run moves, with its destination and file hashes. */
  planned: Array<{ from: string; to: string; files: SkillFixtureFile[] }>;
  /** Entries actually moved: `rename`, or `copy` (verified, then source removed) across devices. */
  moved: SkillFixtureMove[];
  /** Entries left in place, with the reason. */
  skipped: Array<{ path: string; reason: string }>;
  /** Error that stopped the run, when `phase === 'failed'`. */
  error: string | null;
  /** JSONL receipt log, or null on a dry run. */
  receiptLog: string | null;
}

/** One entry moved by a repair or a restore. */
export interface SkillFixtureMove {
  /** Path before the move. */
  from: string;
  /** Path after the move. */
  to: string;
  /** `rename`, or `copy` when rename failed with EXDEV (hashes verified before the source is removed). */
  method: 'rename' | 'copy';
}

/** Receipt for one {@link restoreSkillFixtures} run. */
export interface SkillFixtureRestoreReceipt {
  /** The repair receipt being undone. */
  receiptId: string;
  /** ISO timestamp. */
  at: string;
  /** Dry run: nothing moved, nothing written. */
  dryRun: boolean;
  /** `restore-planned` (dry run, returned only) · `restored`. */
  phase: 'restore-planned' | 'restored';
  /** Entries moved back to their original path. */
  restored: SkillFixtureMove[];
  /** Entries left in quarantine, with the reason. */
  skipped: Array<{ path: string; reason: string }>;
  /** JSONL receipt log, or null on a dry run. */
  receiptLog: string | null;
}

/** Move primitive; injectable so tests can force the cross-device path. */
export type RenameFn = (from: string, to: string) => void;

/** Injection points (tests). */
export interface SkillFixtureOptions {
  /** Skills root. Defaults to {@link resolveSkillsRoot}. */
  skillsRoot?: string;
  /** Receipt + quarantine dir. Defaults to `<cleoHome>/audit`. */
  auditDir?: string;
  /** Names that are never candidates. Defaults to manifest + bundled names. */
  protectedNames?: readonly string[];
  /** Rename primitive. Defaults to `renameSync`. */
  rename?: RenameFn;
}

/** Stable comparison key for a file inventory. */
function inventoryKey(files: readonly SkillFixtureFile[]): string {
  return JSON.stringify([...files].sort((a, b) => a.path.localeCompare(b.path)));
}

/**
 * Move `from` to `to`. A plain rename when possible; when rename fails with
 * EXDEV (quarantine on another filesystem), copy, re-hash the copy against
 * `expected`, and only then remove the source. A copy that does not verify is
 * removed and the source stays in place.
 */
function moveVerified(
  from: string,
  to: string,
  expected: readonly SkillFixtureFile[],
  rename: RenameFn,
): SkillFixtureMove {
  try {
    rename(from, to);
    return { from, to, method: 'rename' };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
  }
  cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
  const copied = classifySkillFixture(basename(to), to).files;
  if (inventoryKey(copied) !== inventoryKey(expected)) {
    rmSync(to, { recursive: true, force: true });
    throw new Error(
      `copy of ${from} to ${to} did not match the recorded sha256 inventory; source left in place`,
    );
  }
  rmSync(from, { recursive: true });
  return { from, to, method: 'copy' };
}

/** Manifest skill names plus every skill directory bundled in `@cleocode/skills`. */
function defaultProtectedNames(): string[] {
  const names = new Set(listCanonicalSkillNames());
  const bundled = resolveBundledSkillsDir();
  if (bundled !== null) for (const name of readdirSync(bundled)) names.add(name);
  return [...names];
}

/**
 * Classify one fixture-named entry by content.
 *
 * @param name - Entry name.
 * @param entryPath - Absolute entry path.
 * @returns The classified entry.
 */
export function classifySkillFixture(name: string, entryPath: string): SkillFixtureEntry {
  const entry: SkillFixtureEntry = {
    name,
    path: entryPath,
    state: 'unclassified',
    reason: null,
    files: [],
  };
  const stat = lstatSync(entryPath);
  if (!stat.isDirectory()) {
    entry.reason = stat.isSymbolicLink() ? 'is a symlink' : 'is not a directory';
    return entry;
  }
  const pending = [entryPath];
  let seen = 0;
  while (pending.length > 0) {
    const dir = pending.pop() as string;
    for (const child of readdirSync(dir)) {
      const childPath = join(dir, child);
      const childStat = lstatSync(childPath);
      if (++seen > MAX_FIXTURE_ENTRIES) {
        entry.reason = `more than ${MAX_FIXTURE_ENTRIES} entries`;
        return entry;
      }
      if (childStat.isDirectory()) {
        pending.push(childPath);
      } else if (!childStat.isFile()) {
        entry.reason = `${relative(entryPath, childPath)} is not a regular file`;
        return entry;
      } else if (childStat.size > MAX_FIXTURE_FILE_BYTES) {
        entry.reason = `${relative(entryPath, childPath)} is larger than ${MAX_FIXTURE_FILE_BYTES} bytes`;
        return entry;
      } else {
        const content = readFileSync(childPath);
        entry.files.push({
          path: relative(entryPath, childPath),
          bytes: childStat.size,
          sha256: createHash('sha256').update(content).digest('hex'),
        });
      }
    }
  }
  const skillMd = join(entryPath, 'SKILL.md');
  if (!existsSync(skillMd)) {
    entry.reason = 'no SKILL.md';
    return entry;
  }
  const { description } = parseFrontmatter(readFileSync(skillMd, 'utf-8'));
  if (!FIXTURE_DESCRIPTION.test(String(description ?? '').trim())) {
    entry.reason = `SKILL.md description is not a test fixture's: ${JSON.stringify(description)}`;
    return entry;
  }
  entry.state = 'fixture';
  return entry;
}

/**
 * Audit a skills root for caamp test fixtures.
 *
 * @param opts - Injection points (tests).
 * @returns Every fixture-named entry, classified, with the remedy.
 * @task T12645
 */
export function auditSkillFixtures(opts: SkillFixtureOptions = {}): SkillFixtureAudit {
  const skillsRoot = opts.skillsRoot ?? resolveSkillsRoot();
  const protectedNames = new Set(opts.protectedNames ?? defaultProtectedNames());
  const entries: SkillFixtureEntry[] = [];
  const names = existsSync(skillsRoot) ? readdirSync(skillsRoot).sort() : [];
  for (const name of names) {
    if (name.startsWith('.') || name.startsWith('_') || protectedNames.has(name)) continue;
    if (!SKILL_FIXTURE_UUID_NAME.test(name) && !SKILL_FIXTURE_EXACT_NAMES.includes(name)) continue;
    entries.push(classifySkillFixture(name, join(skillsRoot, name)));
  }
  const fixture = entries.filter((e) => e.state === 'fixture').length;
  return {
    skillsRoot,
    entries,
    counts: { fixture, unclassified: entries.length - fixture },
    healthy: fixture === 0,
    remedy: fixture === 0 ? null : SKILL_FIXTURES_REPAIR_COMMAND,
  };
}

/**
 * Move every fixture found by {@link auditSkillFixtures} into a per-run
 * quarantine directory, with intent and outcome receipts. Each entry is
 * re-classified immediately before its move; one that changed is skipped.
 *
 * @param opts - `dryRun` plans without writing; plus injection points.
 * @returns The post-repair audit and the receipt.
 * @task T12645
 */
export function repairSkillFixtures(opts: SkillFixtureOptions & { dryRun?: boolean } = {}): {
  audit: SkillFixtureAudit;
  receipt: SkillFixtureReceipt;
} {
  const dryRun = opts.dryRun === true;
  const before = auditSkillFixtures(opts);
  const auditDir = opts.auditDir ?? join(getCleoHome(), 'audit');
  const receiptId = randomUUID();
  const quarantineDir = join(auditDir, 'skill-fixture-quarantine', receiptId);
  const fixtures = before.entries.filter((e) => e.state === 'fixture');
  const receipt: SkillFixtureReceipt = {
    receiptId,
    at: new Date().toISOString(),
    dryRun,
    phase: 'planned',
    quarantineDir,
    planned: fixtures.map((e) => ({
      from: e.path,
      to: join(quarantineDir, e.name),
      files: e.files,
    })),
    moved: [],
    skipped: before.entries
      .filter((e) => e.state === 'unclassified')
      .map((e) => ({ path: e.path, reason: e.reason ?? 'unclassified' })),
    error: null,
    receiptLog: null,
  };
  if (dryRun || fixtures.length === 0) return { audit: before, receipt };

  mkdirSync(quarantineDir, { recursive: true });
  receipt.receiptLog = join(auditDir, 'skill-fixtures.jsonl');
  const log = (phase: SkillFixtureReceipt['phase']): void => {
    receipt.phase = phase;
    appendFileSync(receipt.receiptLog as string, `${JSON.stringify(receipt)}\n`, 'utf8');
  };
  log('intent');
  try {
    for (const entry of fixtures) {
      const now = classifySkillFixture(entry.name, entry.path);
      if (now.state !== 'fixture' || inventoryKey(now.files) !== inventoryKey(entry.files)) {
        receipt.skipped.push({ path: entry.path, reason: 'changed since audit; left in place' });
        continue;
      }
      receipt.moved.push(
        moveVerified(
          entry.path,
          join(quarantineDir, entry.name),
          entry.files,
          opts.rename ?? renameSync,
        ),
      );
    }
  } catch (err) {
    receipt.error = err instanceof Error ? err.message : String(err);
    log('failed');
    throw err;
  }
  log('completed');
  return { audit: auditSkillFixtures(opts), receipt };
}

/**
 * Undo one {@link repairSkillFixtures} run: move every entry its receipt
 * records as moved back from quarantine to its original path. An entry whose
 * original path is occupied, whose quarantine copy is gone, or whose files no
 * longer match the recorded sha256 inventory is skipped and reported. Appends
 * a `restored` line to the same JSONL log.
 *
 * @param receiptId - The repair receipt id (also the quarantine dir name).
 * @param opts - `dryRun` plans without moving; `auditDir` / `rename` injection.
 * @returns The restore receipt.
 * @throws When the log has no finished run with that id, or it was already restored.
 * @task T12645
 */
export function restoreSkillFixtures(
  receiptId: string,
  opts: Pick<SkillFixtureOptions, 'auditDir' | 'rename'> & { dryRun?: boolean } = {},
): SkillFixtureRestoreReceipt {
  const auditDir = opts.auditDir ?? join(getCleoHome(), 'audit');
  const receiptLog = join(auditDir, 'skill-fixtures.jsonl');
  const lines = existsSync(receiptLog)
    ? readFileSync(receiptLog, 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as SkillFixtureReceipt | SkillFixtureRestoreReceipt)
        .filter((line) => line.receiptId === receiptId)
    : [];
  if (lines.some((line) => line.phase === 'restored')) {
    throw new Error(`skill-fixture receipt ${receiptId} was already restored`);
  }
  const run = [...lines]
    .reverse()
    .find(
      (line): line is SkillFixtureReceipt => line.phase === 'completed' || line.phase === 'failed',
    );
  if (run === undefined) {
    throw new Error(`no completed or failed skill-fixture repair ${receiptId} in ${receiptLog}`);
  }

  const dryRun = opts.dryRun === true;
  const receipt: SkillFixtureRestoreReceipt = {
    receiptId,
    at: new Date().toISOString(),
    dryRun,
    phase: 'restore-planned',
    restored: [],
    skipped: [],
    receiptLog: null,
  };
  for (const move of run.moved) {
    const files = run.planned.find((p) => p.from === move.from)?.files ?? [];
    if (!existsSync(move.to)) {
      receipt.skipped.push({ path: move.to, reason: 'quarantine copy is missing' });
    } else if (existsSync(move.from)) {
      receipt.skipped.push({ path: move.from, reason: 'original path is occupied' });
    } else if (
      inventoryKey(classifySkillFixture(basename(move.to), move.to).files) !== inventoryKey(files)
    ) {
      receipt.skipped.push({
        path: move.to,
        reason: 'quarantined files no longer match the receipt',
      });
    } else if (dryRun) {
      receipt.restored.push({ from: move.to, to: move.from, method: 'rename' });
    } else {
      receipt.restored.push(moveVerified(move.to, move.from, files, opts.rename ?? renameSync));
    }
  }
  if (!dryRun) {
    receipt.phase = 'restored';
    receipt.receiptLog = receiptLog;
    appendFileSync(receiptLog, `${JSON.stringify(receipt)}\n`, 'utf8');
  }
  return receipt;
}
