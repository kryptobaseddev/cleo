#!/usr/bin/env node
/**
 * Gate: every skill CLEO code names is installable, and the frontmatter
 * `metadata.install` field matches what install actually does (T12648 · spec
 * `skills-curation-and-automation` §3.2.3 · owner decision D11157).
 *
 * ## What this prevents
 *
 * Spawn prompts and stage guidance name skills by string. Measured
 * 2026-09-28: `ct-lead` (loaded for every tier-1 lead spawn) and six LOOM
 * stage skills were named by code but never installed, because install reads
 * a separate catalogue (`packages/skills/skills.json`, tier <= 2) that did not
 * list them. The lead prompt silently degraded to "Skills not installed" and
 * nothing failed. A skill name in code and a skill on disk are only useful
 * together; this gate checks the join.
 *
 * ## What it checks
 *
 * Emitted names are read from source, never `dist/`:
 *   - `STAGE_SKILL_MAP` values and `TIER_0_SKILLS` in
 *     `packages/core/src/lifecycle/stage-guidance.ts`;
 *   - `loadSkillExcerpt('<name>'` / `resolveSkillPath('<name>'` literals in
 *     `packages/core/src/orchestration/spawn-prompt.ts`;
 *   - `skillRef:` in `packages/core/src/validation/protocols/cant/*.cant`.
 *
 * For each emitted name: the skill directory exists, the manifest lists it
 * with `install: harness`, and install really installs it.
 *
 * For every skill: frontmatter `install: harness` holds exactly when install
 * really installs it. Otherwise the field is declarable but unenforced.
 *
 * "Install really installs it" mirrors `initCoreSkills`
 * (`packages/core/src/init.ts`): a `skills.json` entry with `tier <= 2` whose
 * directory exists. The mirror is only as good as its match with the code, so
 * the gate also fails if `init.ts` stops reading `skills.json` with that
 * filter: whoever changes install must change this gate with it.
 *
 * ## Baseline
 *
 * Known violations live in `scripts/.lint-emitted-skills-baseline.json`, each
 * with the task that removes it. A new violation fails. So does a baseline
 * entry that no longer occurs; delete it in the change that fixed it.
 * `--strict` ignores the baseline.
 *
 * Usage: node scripts/lint-emitted-skills.mjs [--check|--strict] [--json]
 *
 * @task T12648
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMain } from './lib/is-main.mjs';
import { MANIFEST_PATH, SKILLS_DIR } from './skills/lib/skill-frontmatter.mjs';

/** Repo-relative baseline path. */
export const BASELINE_PATH = 'scripts/.lint-emitted-skills-baseline.json';

const STAGE_GUIDANCE = 'packages/core/src/lifecycle/stage-guidance.ts';
const SPAWN_PROMPT = 'packages/core/src/orchestration/spawn-prompt.ts';
const CANT_DIR = 'packages/core/src/validation/protocols/cant';
const INIT_TS = 'packages/core/src/init.ts';
const SKILLS_JSON = 'packages/skills/skills.json';

/**
 * Markers that must be present in `init.ts` for the install mirror below to
 * describe what install does.
 */
export const INSTALL_TRIPWIRES = ["join(ctSkillsRoot, 'skills.json')", 's.tier <= 2'];

/**
 * Collect every skill name code emits, with where it came from.
 *
 * @param {string} root - Repository root.
 * @returns {{ name: string, source: string }[]}
 */
export function collectEmittedSkills(root) {
  const out = [];
  const guidance = readFileSync(join(root, STAGE_GUIDANCE), 'utf-8');
  const block = (re) => re.exec(guidance)?.[1] ?? '';
  const stageMap = block(/STAGE_SKILL_MAP[^=]*=\s*\{([\s\S]*?)\};/);
  const tier0 = block(/TIER_0_SKILLS[^=]*=\s*\[([\s\S]*?)\];/);
  for (const m of `${stageMap}\n${tier0}`.matchAll(/'([a-z][\w-]*)'/g)) {
    out.push({ name: m[1], source: STAGE_GUIDANCE });
  }
  const spawn = readFileSync(join(root, SPAWN_PROMPT), 'utf-8');
  for (const m of spawn.matchAll(/(?:loadSkillExcerpt|resolveSkillPath)\(\s*'([a-z][\w-]*)'/g)) {
    out.push({ name: m[1], source: SPAWN_PROMPT });
  }
  for (const file of readdirSync(join(root, CANT_DIR))
    .filter((f) => f.endsWith('.cant'))
    .sort()) {
    const text = readFileSync(join(root, CANT_DIR, file), 'utf-8');
    for (const m of text.matchAll(/^skillRef:\s*([a-z][\w-]*)\s*$/gm)) {
      out.push({ name: m[1], source: `${CANT_DIR}/${file}` });
    }
  }
  return out;
}

/**
 * The skills `initCoreSkills` installs: `skills.json` entries with
 * `tier <= 2` whose directory exists.
 *
 * @param {string} root - Repository root.
 * @returns {Set<string>}
 */
export function installedSkillNames(root) {
  const catalog = JSON.parse(readFileSync(join(root, SKILLS_JSON), 'utf-8'));
  const names = new Set();
  for (const s of catalog.skills ?? []) {
    const dir = join(root, 'packages/skills', s.path ?? '', '..');
    if (typeof s.tier === 'number' && s.tier <= 2 && existsSync(dir)) names.add(s.name);
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
        message: `${source} names '${name}', but install does not install it (${SKILLS_JSON} tier <= 2)`,
      });
    }
  }

  for (const [name, entry] of entries) {
    const declared = entry.install === 'harness';
    if (declared && !installed.has(name)) {
      violations.push({
        key: `install-mismatch:${name}`,
        message: `'${name}' declares metadata.install: harness, but install does not install it`,
      });
    } else if (!declared && installed.has(name)) {
      violations.push({
        key: `install-mismatch:${name}`,
        message: `'${name}' declares metadata.install: ${entry.install}, but install installs it to every harness`,
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
      `Every emitted skill is installable and metadata.install matches install (${violations.length} baselined) (T12648).\n`,
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
