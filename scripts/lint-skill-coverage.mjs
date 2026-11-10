#!/usr/bin/env node
/**
 * Gate: a change to code a skill documents must update that skill
 * (T12124 · gh#1256 · spec `skills-curation-and-automation` §3.2.5 · D11157).
 *
 * ## Why
 *
 * AGENTS.md described a "Skill Drift Check" for months that no script
 * implemented: a coverage map (`skill-coverage.yml`) that nothing read, with
 * one entry for a skill that did not exist. Skills drifted exactly as it
 * predicted — the release skill taught a retired auto-tag workflow and six
 * LOOM skills taught flags the CLI rejects.
 *
 * ## What it checks
 *
 * Each skill declares the code it documents in its own frontmatter:
 *
 * ```yaml
 * metadata:
 *   covers:
 *     - packages/cleo/src/cli/commands/orchestrate.ts
 *     - packages/core/src/validation/protocols/cant/research.cant
 * ```
 *
 * Always (the `cleo check arch` mode):
 * - every core skill, and every skill bound to a LOOM stage, declares covers;
 * - every covers glob matches at least one tracked file (a glob that matches
 *   nothing is the defect `skill-coverage.yml` had).
 *
 * With `--base <ref>` (PR mode; CI passes the PR base):
 * - a changed file matched by a skill's covers requires a change under that
 *   skill's directory — or, for an on-demand skill only, a commit trailer
 *   `Skill-Drift-Reviewed: <skill>: <reason>`. Core skills reject the
 *   trailer (D11157);
 * - a changed skill directory requires the PR head's `metadata.version` to be
 *   greater than the version at the branch point (the merge-base of the base
 *   and the PR head), and the merged version never lower than the base's.
 *
 * ## Why the branch point, not the base tip (T14393)
 *
 * Parallel PRs that change one skill each bump its version from the same
 * starting value. Measured against the base tip, the second PR to merge
 * failed (its bump equalled the first PR's) and had to re-bump, which then
 * conflicted with every other open PR. Measured against the branch point,
 * PRs that make the same bump (next minor) carry the identical
 * `version:` line and the identical manifest entry, so git merges them in
 * either order with no conflict. Monotonic releases still hold: when a
 * stable release tag (`v*`, not `-canary`/`-rc`) reachable from the base was
 * cut after the branch point, the version must exceed the tag's, so released
 * content never repeats a version. A missing merge base or stable tag fails
 * and names the fetch that fixes it. In CI the checkout is GitHub's merge
 * commit (which inherits other PRs' bumps), so the workflow passes the PR
 * head with `--head` and the PR's own version is the one compared.
 *
 * Usage: node scripts/lint-skill-coverage.mjs [--check|--strict] [--base <ref>] [--head <ref>] [--json]
 *
 * @task T12124
 * @task T14393
 */

import { execFileSync } from 'node:child_process';
import { isMain } from './lib/is-main.mjs';
import {
  listSkillDirs,
  parseFrontmatter,
  readSkillFrontmatter,
  SKILLS_DIR,
} from './skills/lib/skill-frontmatter.mjs';

/** Commit trailer that acknowledges an on-demand skill needs no update. */
export const TRAILER = 'Skill-Drift-Reviewed';

/**
 * Convert a covers glob to a RegExp over repo-relative POSIX paths.
 * `**` spans directories, `*` and `?` stay inside one segment.
 *
 * @param {string} glob - Glob pattern.
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/**
 * Run git and return trimmed stdout lines.
 *
 * @param {string} root - Repository root.
 * @param {string[]} args - git arguments.
 * @returns {string[]}
 */
function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Every skill with its tier, loom stage, version and covers globs.
 *
 * @param {string} root - Repository root.
 * @returns {{ name: string, tier: string, loomStage?: string, version?: string, covers: string[] }[]}
 */
export function loadSkillCoverage(root) {
  return listSkillDirs(root).map((name) => {
    const fm = readSkillFrontmatter(root, name);
    return {
      name,
      tier: fm.metadata.tier,
      loomStage: fm.metadata.loomStage,
      version: fm.metadata.version,
      covers: fm.metadataLists.covers ?? [],
    };
  });
}

/**
 * Static checks: required covers present and every glob live.
 *
 * @param {string} root - Repository root.
 * @param {string[]} [tracked] - Tracked files (defaults to `git ls-files`).
 * @returns {string[]} Problems.
 */
export function checkDeclarations(root, tracked = git(root, ['ls-files'])) {
  const problems = [];
  for (const s of loadSkillCoverage(root)) {
    if ((s.tier === 'core' || s.loomStage) && s.covers.length === 0) {
      problems.push(
        `${s.name}: ${s.tier === 'core' ? 'core' : 'LOOM-stage'} skill declares no metadata.covers`,
      );
    }
    for (const glob of s.covers) {
      const re = globToRegExp(glob);
      if (!tracked.some((f) => re.test(f))) {
        problems.push(`${s.name}: metadata.covers '${glob}' matches no tracked file`);
      }
    }
  }
  return problems;
}

/**
 * Whether semver `a` is strictly greater than `b` (X.Y.Z; anything
 * unparseable is never greater).
 *
 * @param {string | undefined} a - Candidate version.
 * @param {string} b - Base version.
 * @returns {boolean}
 */
export function semverGreater(a, b) {
  const pa = /^(\d+)\.(\d+)\.(\d+)$/.exec(a ?? '');
  const pb = /^(\d+)\.(\d+)\.(\d+)$/.exec(b);
  if (!pa || !pb) return false;
  for (let i = 1; i <= 3; i++) {
    if (Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) > Number(pb[i]);
  }
  return false;
}

/**
 * The ref a PR's skill versions are measured against: the newest stable
 * release tag (`v*`, excluding `-canary` and `-rc` prereleases) reachable
 * from `base` when it was cut after the branch point, otherwise the branch
 * point itself (T14393).
 *
 * Never falls back silently: a missing merge base (shallow clone) or a
 * missing stable tag (tagless clone) throws with the fetch that fixes it,
 * since either would let a skill change ship under an already-released
 * version.
 *
 * @param {string} root - Repository root.
 * @param {string} base - Base ref.
 * @param {string} head - PR head ref.
 * @returns {{ ref: string, tag?: string }}
 * @throws {Error} When the merge base or a stable release tag cannot be found.
 */
export function versionAnchor(root, base, head) {
  /** Run git quietly; null on a non-zero exit. */
  const tryGit = (args) => {
    try {
      return execFileSync('git', args, {
        cwd: root,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return null;
    }
  };
  const branchPoint = tryGit(['merge-base', base, head]);
  if (!branchPoint) {
    throw new Error(
      `no merge base between ${base} and ${head}; fetch full history (git fetch --unshallow origin, or actions/checkout fetch-depth: 0)`,
    );
  }
  const tag = tryGit([
    'describe',
    '--tags',
    '--abbrev=0',
    '--match',
    'v[0-9]*',
    '--exclude',
    '*-canary*',
    '--exclude',
    '*-rc*',
    base,
  ]);
  if (!tag) {
    throw new Error(
      `no stable release tag (v*, not -canary/-rc) reachable from ${base}; fetch tags (git fetch --tags origin, or actions/checkout fetch-depth: 0)`,
    );
  }
  const cutAfter =
    tryGit(['rev-parse', `${tag}^{commit}`]) !== branchPoint &&
    tryGit(['merge-base', '--is-ancestor', branchPoint, tag]) !== null;
  if (cutAfter) {
    return { ref: tag, tag };
  }
  return { ref: branchPoint };
}

/**
 * PR checks against a base ref.
 *
 * @param {string} root - Repository root.
 * @param {string} base - Base ref (e.g. `origin/main`).
 * @param {{ head?: string, changed?: string[], messagesTouching?: (file: string) => string, skillMdAt?: (ref: string, name: string) => string | null }} [io]
 *   PR head (defaults to `HEAD`; CI passes the PR head because its checkout
 *   is the merge commit) and injectable git reads (tests).
 *   `messagesTouching(file)` returns the bodies of the commits in
 *   base..HEAD that touch `file`.
 * @returns {string[]} Problems.
 */
export function checkPullRequest(root, base, io = {}) {
  const changed = io.changed ?? git(root, ['diff', '--name-only', `${base}...HEAD`]);
  const messagesTouching =
    io.messagesTouching ??
    ((file) => git(root, ['log', '--format=%B', `${base}..HEAD`, '--', file]).join('\n'));
  const skillMdAt =
    io.skillMdAt ??
    ((ref, name) => {
      try {
        return execFileSync('git', ['show', `${ref}:${SKILLS_DIR}/${name}/SKILL.md`], {
          cwd: root,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch {
        return null;
      }
    });
  const versionAt = (ref, name) => {
    const md = skillMdAt(ref, name);
    return md ? parseFrontmatter(md).metadata.version : undefined;
  };
  const head = io.head || 'HEAD';
  /** @type {{ ref: string, tag?: string } | null | undefined} */
  let anchor;
  /** The version anchor, resolved once on the first changed skill. */
  const resolveAnchor = (problems) => {
    if (anchor === undefined) {
      try {
        anchor = versionAnchor(root, base, head);
      } catch (err) {
        anchor = null;
        problems.push(`skill version check cannot run: ${err.message}`);
      }
    }
    return anchor;
  };

  /**
   * Whether every covered file that changed was touched by a commit carrying
   * `Skill-Drift-Reviewed: <skill>: <reason>` for this skill — a trailer on
   * an unrelated commit (say one merged in from another PR) does not count.
   */
  const reviewedFor = (skill, files) =>
    files.every((f) =>
      new RegExp(`^${TRAILER}:\\s*${skill}\\s*:\\s*\\S.*$`, 'm').test(messagesTouching(f)),
    );

  const problems = [];
  for (const s of loadSkillCoverage(root)) {
    const dir = `${SKILLS_DIR}/${s.name}/`;
    const skillChanged = changed.some((f) => f.startsWith(dir));
    const hits = changed.filter((f) => s.covers.some((g) => globToRegExp(g).test(f)));

    if (hits.length > 0 && !skillChanged) {
      if (s.tier === 'core') {
        problems.push(
          `${s.name} (core) documents ${hits.join(', ')}, which changed; update the skill — core skills do not accept ${TRAILER}`,
        );
      } else if (!reviewedFor(s.name, hits)) {
        problems.push(
          `${s.name} documents ${hits.join(', ')}, which changed; update the skill, or add "${TRAILER}: ${s.name}: <why no update is needed>" to a commit that touches each of those files`,
        );
      }
    }

    if (skillChanged) {
      const fix = 'bump it (then run node scripts/skills/generate-manifest.mjs)';
      const at = resolveAnchor(problems);
      if (!at) continue;
      // The PR's own version, not the merge commit's: a merge ref inherits
      // another PR's bump, which would hide a PR that never bumped.
      const headVersion = versionAt(head, s.name);
      const anchorVersion = versionAt(at.ref, s.name);
      const baseVersion = versionAt(base, s.name);
      if (anchorVersion !== undefined && !semverGreater(headVersion, anchorVersion)) {
        problems.push(
          `${s.name} changed but metadata.version ${headVersion} is not greater than ${anchorVersion}${at.tag ? `, released in ${at.tag}` : ''}; ${fix}`,
        );
      } else if (baseVersion !== undefined && semverGreater(baseVersion, s.version)) {
        problems.push(
          `${s.name} changed but metadata.version ${s.version} is lower than ${base}'s ${baseVersion}; ${fix}`,
        );
      }
    }
  }
  return problems;
}

/**
 * Run the gate.
 *
 * @param {string} root - Repository root.
 * @param {{ base?: string, head?: string, json?: boolean }} [opts] - Mode flags.
 * @returns {number} Exit code.
 */
export function runGate(root, opts = {}) {
  const problems = checkDeclarations(root);
  if (opts.base) problems.push(...checkPullRequest(root, opts.base, { head: opts.head }));
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ base: opts.base ?? null, problems }, null, 2)}\n`);
    return problems.length > 0 ? 1 : 0;
  }
  if (problems.length === 0) {
    process.stdout.write(
      `Skill coverage OK${opts.base ? ` against ${opts.base}` : ' (declarations; pass --base <ref> for PR checks)'} (T12124).\n`,
    );
    return 0;
  }
  for (const p of problems) process.stderr.write(`  ✗ ${p}\n`);
  return 1;
}

if (isMain(import.meta.url)) {
  const arg = (flag) => {
    const i = process.argv.indexOf(flag);
    return i !== -1 ? process.argv[i + 1] : undefined;
  };
  process.exit(
    runGate(process.cwd(), {
      base: arg('--base'),
      head: arg('--head'),
      json: process.argv.includes('--json'),
    }),
  );
}
