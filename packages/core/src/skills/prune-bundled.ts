/**
 * Prune bundled skills that CLEO no longer installs (T12678).
 *
 * `initCoreSkills` installs every `@cleocode/skills` manifest entry declared
 * `metadata.install: harness`, but it never removed anything. A skill later
 * declared `internal` (ct-grade) or retired (ct-docs-lookup, ct-docs-write,
 * …) stayed linked into every harness on machines that installed it earlier.
 *
 * Candidates are names the bundled manifest says CLEO must NOT install: its
 * non-harness entries plus its `retiredSkills` list. A candidate is removed
 * only where CLEO can prove it put it there — never by name alone:
 *
 * - a harness entry that is a symlink resolving into CLEO's canonical skills
 *   root (`resolveSkillsRoot()`), which is where CLEO's installer links from;
 * - a harness entry that is a byte-identical copy of CLEO's canonical copy
 *   (copy-mode harnesses such as Pi);
 * - the canonical copy itself, when the bundled-install ledger
 *   (`<skillsRoot>/.cleo-bundled.json`, written by `initCoreSkills`) records
 *   it, or when at least one harness symlink proves CLEO linked it.
 *
 * Real directories in harness skill dirs (user-owned or hand-copied) and
 * canonical copies with no ownership evidence are left alone and reported as
 * skipped. Every non-dry run appends a JSON receipt line.
 *
 * @task T12678
 */

import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
} from 'node:fs';
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

/** File under the canonical skills root listing skills CLEO installed from the bundle. */
export const BUNDLED_LEDGER_FILE = '.cleo-bundled.json';

/** What happened to one path during a prune. */
export interface BundledSkillPruneAction {
  /** Skill name. */
  name: string;
  /** Absolute path acted on. */
  path: string;
  /** `removed`, `would-remove` (dry run) or `skipped` (not provably CLEO-owned). */
  action: 'removed' | 'would-remove' | 'skipped';
  /** Why this path was (or was not) treated as CLEO-owned. */
  reason: string;
}

/** Receipt for one prune run. */
export interface BundledSkillPruneReceipt {
  /** ISO timestamp. */
  at: string;
  /** True when nothing was deleted. */
  dryRun: boolean;
  /** Names the bundled manifest says CLEO must not install. */
  candidates: string[];
  /** Per-path outcomes. */
  actions: BundledSkillPruneAction[];
  /** Removal failures (`path: message`). */
  errors: string[];
}

/** Inputs for {@link pruneBundledSkills}. */
export interface PruneBundledSkillsOptions {
  /** `<@cleocode/skills>/skills` — holds `manifest.json`. */
  bundledSkillsDir: string;
  /** CLEO's canonical skills root (`resolveSkillsRoot()`). */
  skillsRoot: string;
  /** Every harness skills directory CLEO installs into. */
  providerSkillDirs: string[];
  /** Report only; delete nothing. */
  dryRun?: boolean;
  /** JSONL file the receipt is appended to on a non-dry run. */
  receiptPath?: string;
}

/** Shape of the bundled manifest fields this module reads. */
interface BundledManifest {
  skills?: Array<{ name?: string; install?: string }>;
  retiredSkills?: string[];
}

/**
 * Names the bundled manifest says must not be installed to harnesses.
 *
 * @param manifest - Parsed `skills/manifest.json`.
 * @returns Sorted unique candidate names.
 */
export function pruneCandidates(manifest: BundledManifest): string[] {
  const names = new Set<string>();
  for (const s of manifest.skills ?? []) {
    if (typeof s.name === 'string' && s.install !== 'harness') names.add(s.name);
  }
  for (const n of manifest.retiredSkills ?? []) names.add(n);
  return [...names].sort();
}

/**
 * Read the bundled-install ledger (names CLEO installed from the bundle).
 *
 * @param skillsRoot - Canonical skills root.
 * @returns The recorded names (empty when absent or unreadable).
 */
export function readBundledLedger(skillsRoot: string): Set<string> {
  try {
    const data: { skills?: unknown } = JSON.parse(
      readFileSync(join(skillsRoot, BUNDLED_LEDGER_FILE), 'utf-8'),
    );
    return new Set(
      Array.isArray(data.skills) ? data.skills.filter((s) => typeof s === 'string') : [],
    );
  } catch {
    return new Set();
  }
}

/**
 * Record the skills CLEO installed from the bundle, so a later prune can
 * prove ownership of their canonical copies.
 *
 * @param skillsRoot - Canonical skills root.
 * @param names - Skills installed by this run.
 */
export async function writeBundledLedger(skillsRoot: string, names: string[]): Promise<void> {
  const merged = new Set([...readBundledLedger(skillsRoot), ...names]);
  await mkdir(skillsRoot, { recursive: true });
  await writeFile(
    join(skillsRoot, BUNDLED_LEDGER_FILE),
    `${JSON.stringify({ skills: [...merged].sort(), updatedAt: new Date().toISOString() }, null, 2)}\n`,
  );
}

/**
 * Resolve where a symlink points, even when its target no longer exists.
 *
 * @param linkPath - Path of the symlink.
 * @returns Absolute target path.
 */
function linkTarget(linkPath: string): string {
  try {
    return realpathSync(linkPath);
  } catch {
    const raw = readlinkSync(linkPath);
    return isAbsolute(raw) ? raw : resolve(dirname(linkPath), raw);
  }
}

/**
 * Whether two paths resolve to the same real location.
 *
 * @param a - First path.
 * @param b - Second path.
 * @returns `true` when both exist and share a real path.
 */
function sameRealPath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * List every file under `dir`, relative, sorted (`__pycache__` ignored).
 *
 * @param dir - Directory to walk.
 * @param base - Prefix accumulated during recursion.
 * @returns Relative file paths.
 */
function listFiles(dir: string, base = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__pycache__') continue;
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

/**
 * Whether a harness copy is byte-identical to CLEO's canonical copy — the
 * proof that CLEO's copy-mode installer (Pi) put it there.
 *
 * @param copy - Directory in a harness skills dir.
 * @param canonical - CLEO's canonical copy.
 * @returns `true` when both trees hold the same files with the same bytes.
 */
function sameTree(copy: string, canonical: string): boolean {
  try {
    const a = listFiles(copy);
    const b = listFiles(canonical);
    if (a.length === 0 || a.join('\n') !== b.join('\n')) return false;
    return a.every((f) => readFileSync(join(copy, f)).equals(readFileSync(join(canonical, f))));
  } catch {
    return false;
  }
}

/**
 * Canonical form of the skills root for prefix checks.
 *
 * @param skillsRoot - Canonical skills root.
 * @returns Real path with a trailing separator.
 */
function rootPrefix(skillsRoot: string): string {
  let real = skillsRoot;
  try {
    real = realpathSync(skillsRoot);
  } catch {
    // Root missing — fall back to the given path.
  }
  return real.endsWith(sep) ? real : `${real}${sep}`;
}

/**
 * Remove harness links and canonical copies of skills CLEO no longer
 * installs, where CLEO can prove it owns them. See the module doc.
 *
 * @param opts - Paths, dry-run flag and receipt location.
 * @returns The receipt (also appended to `receiptPath` on a non-dry run).
 */
export async function pruneBundledSkills(
  opts: PruneBundledSkillsOptions,
): Promise<BundledSkillPruneReceipt> {
  const dryRun = opts.dryRun === true;
  const manifest: BundledManifest = JSON.parse(
    readFileSync(join(opts.bundledSkillsDir, 'manifest.json'), 'utf-8'),
  );
  const candidates = pruneCandidates(manifest);
  const ledger = readBundledLedger(opts.skillsRoot);
  const prefix = rootPrefix(opts.skillsRoot);
  const actions: BundledSkillPruneAction[] = [];
  const errors: string[] = [];

  /** Delete (or plan to delete) one path. */
  const remove = async (name: string, path: string, reason: string): Promise<void> => {
    if (dryRun) {
      actions.push({ name, path, action: 'would-remove', reason });
      return;
    }
    try {
      await rm(path, { recursive: true, force: true });
      actions.push({ name, path, action: 'removed', reason });
    } catch (err) {
      errors.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Several providers share a directory (~/.agents/skills); visit each once.
  const providerDirs = [...new Set(opts.providerSkillDirs)];
  for (const name of candidates) {
    const canonical = join(opts.skillsRoot, name);
    let linkedByCleo = false;

    for (const dir of providerDirs) {
      const entry = join(dir, name);
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(entry);
      } catch {
        continue; // absent
      }
      if (stat.isSymbolicLink()) {
        const target = linkTarget(entry);
        if (`${target}${sep}`.startsWith(prefix)) {
          linkedByCleo = true;
          await remove(name, entry, 'symlink into the CLEO canonical skills root');
          continue;
        }
        actions.push({
          name,
          path: entry,
          action: 'skipped',
          reason: `symlink points outside the CLEO skills root (${target})`,
        });
        continue;
      }
      if (sameRealPath(entry, canonical)) continue; // the canonical copy itself, handled below
      if (sameTree(entry, canonical)) {
        linkedByCleo = true;
        await remove(name, entry, 'byte-identical copy of the CLEO canonical copy');
        continue;
      }
      actions.push({
        name,
        path: entry,
        action: 'skipped',
        reason: 'real directory in a harness skills dir — no proof CLEO owns it',
      });
    }

    if (existsSync(canonical)) {
      if (ledger.has(name) || linkedByCleo) {
        await remove(
          name,
          canonical,
          ledger.has(name)
            ? 'recorded in the bundled-install ledger'
            : 'CLEO harness links point to it',
        );
      } else {
        actions.push({
          name,
          path: canonical,
          action: 'skipped',
          reason: 'canonical copy with no ledger record or CLEO link — may be user-installed',
        });
      }
    }
  }

  // A pruned canonical copy is no longer CLEO's: drop it from the ledger so a
  // later user install of the same name is never mistaken for a bundled one.
  const prunedCanonical = actions
    .filter((a) => a.action === 'removed' && a.path === join(opts.skillsRoot, a.name))
    .map((a) => a.name);
  if (prunedCanonical.length > 0) {
    const kept = [...ledger].filter((n) => !prunedCanonical.includes(n));
    await writeFile(
      join(opts.skillsRoot, BUNDLED_LEDGER_FILE),
      `${JSON.stringify({ skills: kept.sort(), updatedAt: new Date().toISOString() }, null, 2)}\n`,
    );
  }

  const receipt: BundledSkillPruneReceipt = {
    at: new Date().toISOString(),
    dryRun,
    candidates,
    actions,
    errors,
  };
  if (!dryRun && opts.receiptPath && actions.some((a) => a.action === 'removed')) {
    await mkdir(dirname(opts.receiptPath), { recursive: true });
    await appendFile(opts.receiptPath, `${JSON.stringify(receipt)}\n`);
  }
  return receipt;
}

/**
 * Dry-run the prune `initCoreSkills` would perform, against the real
 * bundled manifest, canonical root and installed harnesses (T12678).
 *
 * @returns One human-readable line per path that would be removed or is
 *   skipped as not provably CLEO-owned; empty when nothing applies or the
 *   bundled skills cannot be located.
 */
export async function previewBundledSkillPrune(): Promise<string[]> {
  const { getInstalledProviders, resolveProviderSkillsDirs } = await import('@cleocode/caamp');
  const { resolveBundledSkillsDir, resolveSkillsRoot } = await import('./skill-root.js');
  const bundledSkillsDir = resolveBundledSkillsDir();
  if (!bundledSkillsDir) return [];
  const receipt = await pruneBundledSkills({
    bundledSkillsDir,
    skillsRoot: resolveSkillsRoot(),
    providerSkillDirs: getInstalledProviders().flatMap((p) =>
      resolveProviderSkillsDirs(p, 'global'),
    ),
    dryRun: true,
  });
  return receipt.actions.map((a) =>
    a.action === 'would-remove'
      ? `skills: would prune ${a.path} (${a.reason})`
      : `skills: would keep ${a.path} (${a.reason})`,
  );
}
