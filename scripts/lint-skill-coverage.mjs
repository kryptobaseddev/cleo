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
 * - a changed skill directory requires a `metadata.version` bump against the
 *   base.
 *
 * Usage: node scripts/lint-skill-coverage.mjs [--check|--strict] [--base <ref>] [--json]
 *
 * @task T12124
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
 * PR checks against a base ref.
 *
 * @param {string} root - Repository root.
 * @param {string} base - Base ref (e.g. `origin/main`).
 * @param {{ changed?: string[], trailers?: string, baseSkillMd?: (name: string) => string | null }} [io]
 *   Injectable git reads (tests).
 * @returns {string[]} Problems.
 */
export function checkPullRequest(root, base, io = {}) {
  const changed = io.changed ?? git(root, ['diff', '--name-only', `${base}...HEAD`]);
  const messages = io.trailers ?? git(root, ['log', '--format=%B', `${base}..HEAD`]).join('\n');
  const baseSkillMd =
    io.baseSkillMd ??
    ((name) => {
      try {
        return execFileSync('git', ['show', `${base}:${SKILLS_DIR}/${name}/SKILL.md`], {
          cwd: root,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch {
        return null;
      }
    });

  const reviewed = new Map();
  for (const m of messages.matchAll(new RegExp(`^${TRAILER}:\\s*([\\w-]+)\\s*:\\s*(.+)$`, 'gm'))) {
    reviewed.set(m[1], m[2].trim());
  }

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
      } else if (!reviewed.has(s.name)) {
        problems.push(
          `${s.name} documents ${hits.join(', ')}, which changed; update the skill or add a commit trailer "${TRAILER}: ${s.name}: <why no update is needed>"`,
        );
      }
    }

    if (skillChanged) {
      const before = baseSkillMd(s.name);
      const baseVersion = before ? parseFrontmatter(before).metadata.version : undefined;
      if (baseVersion !== undefined && baseVersion === s.version) {
        problems.push(
          `${s.name} changed but metadata.version is still ${s.version}; bump it (then run node scripts/skills/generate-manifest.mjs)`,
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
 * @param {{ base?: string, json?: boolean }} [opts] - Mode flags.
 * @returns {number} Exit code.
 */
export function runGate(root, opts = {}) {
  const problems = checkDeclarations(root);
  if (opts.base) problems.push(...checkPullRequest(root, opts.base));
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
  const i = process.argv.indexOf('--base');
  const base = i !== -1 ? process.argv[i + 1] : undefined;
  process.exit(runGate(process.cwd(), { base, json: process.argv.includes('--json') }));
}
