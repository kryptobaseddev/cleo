/**
 * Global delivery audit/repair — does every harness on this machine actually
 * load CLEO? One surface for the three things that silently break it:
 *
 * 1. `~/.cleo` — must link to the platform data dir ({@link auditCleoLink}).
 * 2. The global hub `~/.agents/AGENTS.md` — its reference must resolve, or it
 *    must carry the protocol embedded.
 * 3. Skill installs in every harness skills dir — each CLEO skill entry must
 *    resolve. Links written through `~/.cleo/skills/<name>` (the pre-T12598
 *    install target) break all at once when `~/.cleo` dangles: measured
 *    2026-09-28 on macOS, 96 dangling `ct-*` links across six harness dirs.
 *
 * Repairs relink skill entries to the physical `<cleoHome>/skills/<name>`
 * (symlink, verified; copy when a link cannot be made or does not resolve)
 * and append one receipt per run to `<cleoHome>/audit/global-delivery.jsonl`.
 *
 * @task T12596
 * @task T12598
 */

import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { join, resolve } from 'node:path';
import { getAgentsHome, getCleoHome } from '../paths.js';
import { resolveSkillsRoot } from '../skills/skill-root.js';
import {
  auditCleoLink,
  CANONICAL_HUB_TEMPLATE_REF,
  type CleoLinkAudit,
  type CleoLinkOptions,
  type CleoLinkRepairReceipt,
  repairCleoLink,
} from './cleo-link.js';

/** Repair command printed in remedies. */
export const GLOBAL_DELIVERY_REPAIR_COMMAND = 'cleo doctor global-delivery --repair';

/**
 * Skill dirs an older CLEO/CAAMP release wrote to that the provider registry
 * no longer lists, relative to the home directory. Scanned so their stale
 * links are reported and repaired rather than left dangling forever.
 */
export const LEGACY_HARNESS_SKILL_DIRS: readonly string[] = ['.kimi-code/skills'];

/**
 * State of one harness skill entry:
 * - `ok` — resolves directly to the canonical skill (or is a real copy).
 * - `dangling` — a link that resolves to nothing; repairable when the
 *   canonical skill exists.
 * - `legacy-route` — resolves today but only THROUGH `~/.cleo`, so it breaks
 *   whenever that link does; relinked to the physical path on repair.
 * - `orphan` — dangling, and no canonical skill of that name exists.
 */
export type SkillInstallState = 'ok' | 'dangling' | 'legacy-route' | 'orphan';

/** One CLEO-managed entry in a harness skills directory. */
export interface SkillInstallEntry {
  /** Harness skills directory. */
  dir: string;
  /** Entry name (skill name). */
  name: string;
  /** Absolute entry path. */
  path: string;
  /** Link target as written, or null for a real directory. */
  target: string | null;
  /** Classified state. */
  state: SkillInstallState;
}

/** Hub state. */
export interface HubAudit {
  /** `~/.agents/AGENTS.md` path. */
  path: string;
  /**
   * - `reference` — carries the canonical reference and it resolves.
   * - `embedded` — carries the protocol text inline (T12596 fallback).
   * - `unresolved` — carries the reference but it resolves to nothing.
   * - `missing` — no hub file, or no CLEO reference in it.
   */
  state: 'reference' | 'embedded' | 'unresolved' | 'missing';
}

/** Full audit. */
export interface GlobalDeliveryAudit {
  /** `~/.cleo` link state. */
  link: CleoLinkAudit;
  /** Hub state. */
  hub: HubAudit;
  /** Canonical skills root the entries should resolve to. */
  skillsRoot: string;
  /** Every CLEO-managed skill entry found. */
  skills: SkillInstallEntry[];
  /** Per-state counts over {@link GlobalDeliveryAudit.skills}. */
  skillCounts: Record<SkillInstallState, number>;
  /** True when the link, hub and every skill entry resolve. */
  healthy: boolean;
  /** Exact repair command, or null when healthy. */
  remedy: string | null;
}

/** Per-entry repair outcome recorded in the receipt. */
export interface SkillRepairOutcome {
  /** Entry path. */
  path: string;
  /** State before. */
  before: SkillInstallState;
  /** Previous link target. */
  previousTarget: string | null;
  /** What was written: a verified symlink, a copy, or nothing. */
  action: 'symlink' | 'copy' | 'skipped';
  /** Why the entry was skipped, when it was. */
  reason: string | null;
}

/** Receipt for one {@link repairGlobalDelivery} run. */
export interface GlobalDeliveryReceipt {
  /** Unique receipt id. */
  receiptId: string;
  /** ISO timestamp. */
  at: string;
  /** Dry run: nothing was written. */
  dryRun: boolean;
  /** The `~/.cleo` link repair receipt. */
  link: CleoLinkRepairReceipt;
  /** Skill entry outcomes. */
  skills: SkillRepairOutcome[];
  /** JSONL file the receipt was appended to, or null on a dry run. */
  receiptLog: string | null;
}

/** Injection points (tests). */
export interface GlobalDeliveryOptions extends CleoLinkOptions {
  /** Home directory. Defaults to `homedir()`. */
  home?: string;
  /** Hub path. Defaults to `<agentsHome>/AGENTS.md`. */
  hubPath?: string;
  /** Canonical skills root. Defaults to {@link resolveSkillsRoot}. */
  skillsRoot?: string;
  /** Harness skill dirs. Defaults to every provider's global dirs + legacy dirs. */
  skillDirs?: string[];
  /** Receipt log dir. Defaults to `<cleoHome>/audit`. */
  auditDir?: string;
}

/**
 * Every harness skills directory the provider registry knows (global scope),
 * plus {@link LEGACY_HARNESS_SKILL_DIRS}. Only directories that exist.
 *
 * @param home - Home directory.
 * @returns Unique absolute directories.
 */
export async function discoverHarnessSkillDirs(home: string = homedir()): Promise<string[]> {
  const dirs = new Set<string>();
  try {
    const caamp = await import('@cleocode/caamp');
    for (const provider of caamp.getAllProviders()) {
      try {
        for (const d of caamp.resolveProviderSkillsDirs(provider, 'global')) if (d) dirs.add(d);
      } catch {
        // A provider without a global skills dir contributes nothing.
      }
    }
  } catch {
    // caamp unavailable: legacy dirs only.
  }
  for (const rel of LEGACY_HARNESS_SKILL_DIRS) dirs.add(join(home, rel));
  return [...dirs].filter((d) => existsSync(d));
}

/** The subset of `node:path` the classifier needs (posix or win32). */
export type PathApi = Pick<typeof path, 'resolve' | 'sep'>;

/**
 * True when a link target routes through `~/.cleo` — the pre-T12598 install
 * target that breaks every link at once when `~/.cleo` dangles.
 *
 * Pure over `pathApi` so macOS, Linux and Windows path shapes can be checked
 * on any host.
 *
 * @param target - Link target as written (relative or absolute).
 * @param linkDir - Directory holding the link.
 * @param cleoLink - Absolute `~/.cleo` path.
 * @param pathApi - `path.posix` or `path.win32`; defaults to the host.
 */
export function routesThroughCleoLink(
  target: string,
  linkDir: string,
  cleoLink: string,
  pathApi: PathApi = path,
): boolean {
  const absolute = pathApi.resolve(linkDir, target);
  const root = pathApi.resolve(cleoLink);
  const norm = (s: string): string => (pathApi.sep === '\\' ? s.toLowerCase() : s);
  return norm(absolute) === norm(root) || norm(absolute).startsWith(norm(root + pathApi.sep));
}

/**
 * Classify every CLEO-managed entry in the given harness skill dirs.
 *
 * An entry is CLEO-managed when a canonical skill of the same name exists in
 * `skillsRoot`, or when it is a link routed through `~/.cleo` or into
 * `skillsRoot`. Links owned by other tools (e.g. `~/.claude/skills/x ->
 * ../../.agents/skills/x`) are never reported or touched.
 *
 * @param dirs - Harness skills directories.
 * @param skillsRoot - Canonical skills root.
 * @param cleoLink - Absolute `~/.cleo` path.
 * @returns Managed entries.
 */
export function auditSkillInstalls(
  dirs: readonly string[],
  skillsRoot: string,
  cleoLink: string,
): SkillInstallEntry[] {
  const canonical = new Set(existsSync(skillsRoot) ? readdirSync(skillsRoot) : []);
  const entries: SkillInstallEntry[] = [];
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const entryPath = join(dir, name);
      let isLink = false;
      try {
        isLink = lstatSync(entryPath).isSymbolicLink();
      } catch {
        continue;
      }
      if (!isLink) {
        if (canonical.has(name) && resolve(entryPath) !== resolve(skillsRoot, name)) {
          entries.push({ dir, name, path: entryPath, target: null, state: 'ok' });
        }
        continue;
      }
      const target = readlinkSync(entryPath);
      const absolute = resolve(dir, target);
      const legacy = routesThroughCleoLink(target, dir, cleoLink);
      const managed = canonical.has(name) || legacy || absolute.startsWith(resolve(skillsRoot));
      if (!managed) continue;
      const resolves = existsSync(entryPath);
      let state: SkillInstallState;
      if (!resolves) state = canonical.has(name) ? 'dangling' : 'orphan';
      else if (legacy) state = 'legacy-route';
      else state = 'ok';
      entries.push({ dir, name, path: entryPath, target, state });
    }
  }
  return entries;
}

function readHub(hubPath: string, cleoLink: CleoLinkAudit): HubAudit {
  if (!existsSync(hubPath)) return { path: hubPath, state: 'missing' };
  const text = readFileSync(hubPath, 'utf-8');
  if (text.includes(CANONICAL_HUB_TEMPLATE_REF)) {
    return { path: hubPath, state: cleoLink.hubReferenceResolves ? 'reference' : 'unresolved' };
  }
  if (text.includes('# CLEO Protocol')) return { path: hubPath, state: 'embedded' };
  return { path: hubPath, state: 'missing' };
}

/**
 * Audit `~/.cleo`, the global hub and every harness skill install.
 *
 * @param opts - Injection points (tests).
 * @returns The audit, with the exact remedy when unhealthy.
 * @task T12598
 */
export async function auditGlobalDelivery(
  opts: GlobalDeliveryOptions = {},
): Promise<GlobalDeliveryAudit> {
  const home = opts.home ?? homedir();
  const link = auditCleoLink(opts);
  const skillsRoot = opts.skillsRoot ?? resolveSkillsRoot();
  const dirs = opts.skillDirs ?? (await discoverHarnessSkillDirs(home));
  const skills = auditSkillInstalls(dirs, skillsRoot, link.path);
  const skillCounts: Record<SkillInstallState, number> = {
    ok: 0,
    dangling: 0,
    'legacy-route': 0,
    orphan: 0,
  };
  for (const s of skills) skillCounts[s.state] += 1;
  const hub = readHub(opts.hubPath ?? join(getAgentsHome(), 'AGENTS.md'), link);
  const healthy =
    link.state === 'canonical' &&
    (hub.state === 'reference' || hub.state === 'embedded') &&
    skillCounts.dangling === 0 &&
    skillCounts['legacy-route'] === 0;
  return {
    link,
    hub,
    skillsRoot,
    skills,
    skillCounts,
    healthy,
    remedy: healthy ? null : GLOBAL_DELIVERY_REPAIR_COMMAND,
  };
}

/**
 * Point one harness entry at the canonical skill: a symlink verified to
 * resolve, or a copy when the link cannot be made or does not resolve
 * (Windows without Developer Mode; filesystems without links). The old entry
 * is a link, so replacing it discards no data.
 */
function relinkEntry(entryPath: string, canonicalPath: string): 'symlink' | 'copy' {
  unlinkSync(entryPath);
  try {
    symlinkSync(canonicalPath, entryPath, process.platform === 'win32' ? 'junction' : 'dir');
    if (existsSync(join(entryPath, 'SKILL.md')) || existsSync(entryPath)) return 'symlink';
    unlinkSync(entryPath);
  } catch {
    rmSync(entryPath, { recursive: true, force: true });
  }
  cpSync(canonicalPath, entryPath, { recursive: true });
  return 'copy';
}

/**
 * Repair everything {@link auditGlobalDelivery} reports: relink `~/.cleo`,
 * then relink every `dangling` / `legacy-route` skill entry to the physical
 * canonical path. `orphan` entries are reported, never deleted. The hub needs
 * no rewrite once `~/.cleo` resolves; `cleo install-global` refreshes it.
 *
 * @param opts - `dryRun` plans without writing; plus injection points.
 * @returns The post-repair audit and the receipt.
 * @task T12598
 */
export async function repairGlobalDelivery(
  opts: GlobalDeliveryOptions & { dryRun?: boolean } = {},
): Promise<{ audit: GlobalDeliveryAudit; receipt: GlobalDeliveryReceipt }> {
  const dryRun = opts.dryRun === true;
  const before = await auditGlobalDelivery(opts);
  const { receipt: linkReceipt } = await repairCleoLink({ ...opts, dryRun });
  const outcomes: SkillRepairOutcome[] = [];
  for (const entry of before.skills) {
    if (entry.state === 'ok') continue;
    const canonicalPath = join(before.skillsRoot, entry.name);
    const outcome: SkillRepairOutcome = {
      path: entry.path,
      before: entry.state,
      previousTarget: entry.target,
      action: 'skipped',
      reason: null,
    };
    if (entry.state === 'orphan' || !existsSync(canonicalPath)) {
      outcome.reason = `no canonical skill at ${canonicalPath}; left in place`;
    } else if (dryRun) {
      outcome.action = 'symlink';
    } else {
      outcome.action = relinkEntry(entry.path, canonicalPath);
    }
    outcomes.push(outcome);
  }

  const receipt: GlobalDeliveryReceipt = {
    receiptId: randomUUID(),
    at: new Date().toISOString(),
    dryRun,
    link: linkReceipt,
    skills: outcomes,
    receiptLog: null,
  };
  if (!dryRun) {
    const auditDir = opts.auditDir ?? join(opts.canonicalTarget ?? getCleoHome(), 'audit');
    mkdirSync(auditDir, { recursive: true });
    receipt.receiptLog = join(auditDir, 'global-delivery.jsonl');
    appendFileSync(receipt.receiptLog, `${JSON.stringify(receipt)}\n`, 'utf8');
  }
  const audit = dryRun ? before : await auditGlobalDelivery(opts);
  return { audit, receipt };
}
