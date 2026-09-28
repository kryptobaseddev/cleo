#!/usr/bin/env node
/**
 * Gate: every skill CLEO code names is installable (T12648, T12653 · spec
 * `skills-curation-and-automation` §3.2.3 · owner decision D11157).
 *
 * ## What this prevents
 *
 * Spawn prompts, stage guidance, the skill dispatcher and the protocol files
 * name skills by string. Measured 2026-09-28: `ct-lead` (loaded for every
 * tier-1 lead spawn) and six LOOM stage skills were named by code but never
 * installed, because install read a separate catalogue (`skills.json`,
 * tier <= 2) that did not list them, and `SKILL_NAME_MAP` resolved aliases to
 * three skills that had never existed (`ct-test-writer-bats`,
 * `ct-library-implementer-bash`, `ct-skill-lookup`). Nothing failed. A skill
 * name in code and a skill on disk are only useful together; this gate checks
 * the join.
 *
 * ## What it checks
 *
 * Emitted names are read from source, never `dist/`:
 *   - `STAGE_SKILL_MAP` values and `TIER_0_SKILLS` in
 *     `packages/core/src/lifecycle/stage-guidance.ts`;
 *   - `loadSkillExcerpt(...)` / `resolveSkillPath(...)` literals in
 *     `packages/core/src/orchestration/spawn-prompt.ts`;
 *   - `SKILL_NAME_MAP` values in `packages/core/src/skills/types.ts`;
 *   - `skill:` values in `packages/core/src/skills/dispatch.ts`;
 *   - `skillRef:` in `packages/core/src/validation/protocols/cant/*.cant`.
 *
 * String literals are matched in single, double or backtick quotes. Object
 * and array blocks are read only up to their own closing brace or bracket,
 * so a trailing `as const` or `satisfies` cannot pull in the next statement.
 *
 * For each emitted name: the skill directory exists, the manifest lists it
 * with `install: harness`, and install really installs it.
 *
 * "Install really installs it" mirrors `initCoreSkills`
 * (`packages/core/src/init.ts`): a `packages/skills/skills/manifest.json`
 * entry with `install: harness` whose `skills/<name>/` directory exists. The
 * mirror is only as good as its match with the code, so the gate also fails
 * if `init.ts` stops making that selection: whoever changes install must
 * change this gate with it.
 *
 * ## Baseline
 *
 * Known violations live in `scripts/.lint-emitted-skills-baseline.json`, each
 * with the task that removes it (empty since T12653). A new violation fails.
 * So does a baseline entry that no longer occurs. `--strict` ignores the
 * baseline.
 *
 * Usage: node scripts/lint-emitted-skills.mjs [--check|--strict] [--json]
 *
 * @task T12648
 * @task T12653
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMain } from './lib/is-main.mjs';
import { MANIFEST_PATH, SKILLS_DIR } from './skills/lib/skill-frontmatter.mjs';

/** Repo-relative baseline path. */
export const BASELINE_PATH = 'scripts/.lint-emitted-skills-baseline.json';

const STAGE_GUIDANCE = 'packages/core/src/lifecycle/stage-guidance.ts';
const SPAWN_PROMPT = 'packages/core/src/orchestration/spawn-prompt.ts';
const SKILL_TYPES = 'packages/core/src/skills/types.ts';
const SKILL_DISPATCH = 'packages/core/src/skills/dispatch.ts';
const CANT_DIR = 'packages/core/src/validation/protocols/cant';
const INIT_TS = 'packages/core/src/init.ts';

/**
 * Markers that must be present in `init.ts` for {@link installedSkillNames}
 * to describe what install does.
 */
export const INSTALL_TRIPWIRES = [
  "join(ctSkillsRoot, 'skills', 'manifest.json')",
  "s.install === 'harness'",
  "join(ctSkillsRoot, 'skills', skill.name)",
];

/** A quoted skill-name literal in any JS quote style; group 2 is the name. */
const QUOTED_NAME = /(['"`])([a-z][\w-]*)\1/g;

/**
 * The body of `<name> ... = {` up to its own closing brace (or `[` ... `]`).
 *
 * @param {string} source - Module source.
 * @param {string} name - Declared constant name.
 * @param {'{' | '['} open - Opening delimiter of the literal.
 * @returns {string} The literal's body, or '' when absent.
 */
function literalBody(source, name, open) {
  const close = open === '{' ? '}' : ']';
  const start = new RegExp(`\\b${name}\\b[^=]*=\\s*\\${open}`).exec(source);
  if (!start) return '';
  const from = start.index + start[0].length;
  const end = source.indexOf(close, from);
  return end === -1 ? '' : source.slice(from, end);
}

/**
 * Collect every skill name code emits, with where it came from.
 *
 * @param {string} root - Repository root.
 * @returns {{ name: string, source: string }[]}
 */
export function collectEmittedSkills(root) {
  const out = [];
  const read = (rel) => readFileSync(join(root, rel), 'utf-8');
  const push = (text, source) => {
    for (const m of text.matchAll(QUOTED_NAME)) out.push({ name: m[2], source });
  };

  const guidance = read(STAGE_GUIDANCE);
  push(literalBody(guidance, 'STAGE_SKILL_MAP', '{'), STAGE_GUIDANCE);
  push(literalBody(guidance, 'TIER_0_SKILLS', '['), STAGE_GUIDANCE);

  const spawn = read(SPAWN_PROMPT);
  for (const m of spawn.matchAll(
    /(?:loadSkillExcerpt|resolveSkillPath)\(\s*(['"`])([a-z][\w-]*)\1/g,
  )) {
    out.push({ name: m[2], source: SPAWN_PROMPT });
  }

  // Values only: keys are user-facing aliases, not skill names.
  const nameMap = literalBody(read(SKILL_TYPES), 'SKILL_NAME_MAP', '{');
  for (const m of nameMap.matchAll(/:\s*(['"`])([a-z][\w-]*)\1/g)) {
    out.push({ name: m[2], source: SKILL_TYPES });
  }

  for (const m of read(SKILL_DISPATCH).matchAll(/\bskill:\s*(['"`])([a-z][\w-]*)\1/g)) {
    out.push({ name: m[2], source: SKILL_DISPATCH });
  }

  for (const file of readdirSync(join(root, CANT_DIR))
    .filter((f) => f.endsWith('.cant'))
    .sort()) {
    const text = read(`${CANT_DIR}/${file}`);
    for (const m of text.matchAll(/^skillRef:\s*([a-z][\w-]*)\s*$/gm)) {
      out.push({ name: m[1], source: `${CANT_DIR}/${file}` });
    }
  }
  return out;
}

/**
 * The skills `initCoreSkills` installs: manifest entries with
 * `install: harness` whose `skills/<name>/` directory exists. An entry
 * without a name, or whose directory is missing, is not installed.
 *
 * @param {string} root - Repository root.
 * @returns {Set<string>}
 */
export function installedSkillNames(root) {
  const manifest = JSON.parse(readFileSync(join(root, MANIFEST_PATH), 'utf-8'));
  const names = new Set();
  for (const s of manifest.skills ?? []) {
    if (typeof s.name !== 'string' || s.install !== 'harness') continue;
    if (existsSync(join(root, SKILLS_DIR, s.name))) names.add(s.name);
  }
  return names;
}

/**
 * Find every violation, before the baseline is applied.
 *
 * @param {string} root - Repository root.
 * @returns {{ key: string, message: string }[]} `key` is the stable baseline key.
 */
export function findViolations(root) {
  const violations = [];
  const initSource = readFileSync(join(root, INIT_TS), 'utf-8');
  for (const marker of INSTALL_TRIPWIRES) {
    if (!initSource.includes(marker)) {
      violations.push({
        key: `tripwire:${marker}`,
        message: `${INIT_TS} no longer contains \`${marker}\`: install changed, so installedSkillNames() in this gate no longer mirrors it. Update both together.`,
      });
    }
  }

  const manifest = JSON.parse(readFileSync(join(root, MANIFEST_PATH), 'utf-8'));
  const entries = new Map((manifest.skills ?? []).map((s) => [s.name, s]));
  const installed = installedSkillNames(root);

  const seen = new Set();
  for (const { name, source } of collectEmittedSkills(root)) {
    if (seen.has(name)) continue;
    seen.add(name);
    const entry = entries.get(name);
    if (!existsSync(join(root, SKILLS_DIR, name, 'SKILL.md'))) {
      violations.push({
        key: `emitted-missing:${name}`,
        message: `${source} names '${name}', but ${SKILLS_DIR}/${name}/SKILL.md does not exist`,
      });
    } else if (entry?.install !== 'harness') {
      violations.push({
        key: `emitted-not-harness:${name}`,
        message: `${source} names '${name}', but its metadata.install is '${entry?.install ?? 'absent'}' (must be harness)`,
      });
    }
    if (!installed.has(name)) {
      violations.push({
        key: `emitted-not-installed:${name}`,
        message: `${source} names '${name}', but install does not install it`,
      });
    }
  }
  return violations;
}

/**
 * Load the baseline map of key → owning task.
 *
 * @param {string} root - Repository root.
 * @returns {Map<string, string>}
 */
export function loadBaseline(root) {
  const path = join(root, BASELINE_PATH);
  if (!existsSync(path)) return new Map();
  const data = JSON.parse(readFileSync(path, 'utf-8'));
  return new Map((data.entries ?? []).map((e) => [e.key, e.task]));
}

/**
 * Run the gate.
 *
 * @param {string} root - Repository root.
 * @param {{ strict?: boolean, json?: boolean }} [opts] - Mode flags.
 * @returns {number} Exit code.
 */
export function runGate(root, opts = {}) {
  const violations = findViolations(root);
  const baseline = opts.strict ? new Map() : loadBaseline(root);
  const fresh = violations.filter((v) => !baseline.has(v.key));
  const found = new Set(violations.map((v) => v.key));
  const stale = [...baseline.keys()].filter((k) => !found.has(k));

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({ violations: fresh, stale, baselined: violations.length - fresh.length }, null, 2)}\n`,
    );
    return fresh.length + stale.length > 0 ? 1 : 0;
  }
  if (fresh.length + stale.length === 0) {
    process.stdout.write(
      `Every emitted skill exists, is metadata.install: harness and is installed (${violations.length} baselined) (T12653).\n`,
    );
    return 0;
  }
  for (const v of fresh) process.stderr.write(`  ✗ ${v.message}\n`);
  for (const k of stale) {
    process.stderr.write(
      `  ✗ baseline entry '${k}' no longer occurs — remove it from ${BASELINE_PATH}\n`,
    );
  }
  process.stderr.write(
    'A skill named by code must exist, be declared metadata.install: harness, and be installed.\n',
  );
  return 1;
}

if (isMain(import.meta.url)) {
  process.exit(
    runGate(process.cwd(), {
      strict: process.argv.includes('--strict'),
      json: process.argv.includes('--json'),
    }),
  );
}
