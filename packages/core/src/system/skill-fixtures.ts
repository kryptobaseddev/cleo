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
 * sha256 of every file moved.
 *
 * @task T12645
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
} from 'node:fs';
import { join, relative } from 'node:path';
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
  /** Entries actually moved. */
  moved: string[];
  /** Entries left in place, with the reason. */
  skipped: Array<{ path: string; reason: string }>;
  /** Error that stopped the run, when `phase === 'failed'`. */
  error: string | null;
  /** JSONL receipt log, or null on a dry run. */
  receiptLog: string | null;
}

/** Injection points (tests). */
export interface SkillFixtureOptions {
  /** Skills root. Defaults to {@link resolveSkillsRoot}. */
  skillsRoot?: string;
  /** Receipt + quarantine dir. Defaults to `<cleoHome>/audit`. */
  auditDir?: string;
  /** Names that are never candidates. Defaults to manifest + bundled names. */
  protectedNames?: readonly string[];
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
      if (now.state !== 'fixture' || JSON.stringify(now.files) !== JSON.stringify(entry.files)) {
        receipt.skipped.push({ path: entry.path, reason: 'changed since audit; left in place' });
        continue;
      }
      renameSync(entry.path, join(quarantineDir, entry.name));
      receipt.moved.push(entry.path);
    }
  } catch (err) {
    receipt.error = err instanceof Error ? err.message : String(err);
    log('failed');
    throw err;
  }
  log('completed');
  return { audit: auditSkillFixtures(opts), receipt };
}
