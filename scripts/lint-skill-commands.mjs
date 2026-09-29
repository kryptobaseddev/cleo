#!/usr/bin/env node
/**
 * Gate: every `cleo` command a canonical skill tells an agent to run exists
 * and is runnable (T12649 · spec `skills-curation-and-automation` §3.2.2 ·
 * owner decision D11157).
 *
 * ## Why
 *
 * Gate 14 holds the injection template to this rule and gate 23 the spawn
 * prompt, but nothing checked the skills — and the skills are what an agent
 * loads when it needs the detail. Measured 2026-09-28 at a03ec27f0: 96 dead
 * invocations across 21 skill directories. ct-orchestrator, embedded in every
 * tier-2 spawn, taught `cleo orchestrate ready --epic <id>` (the epic is
 * positional); six LOOM skills taught `cleo check protocol --taskId …`, which
 * the CLI rejects with `E_UNKNOWN_FLAG`; ct-lead taught a `cleo lead rollup`
 * that never existed.
 *
 * ## What it checks
 *
 * Every `*.md` under `packages/skills/skills/` (SKILL.md, references, agents;
 * never `__tests__`) with the same rules gate 14 applies, imported rather
 * than restated: the verb and sub-verb exist, every flag is declared, a
 * partially-flagged invocation carries its required flags, and a documented
 * `--field` pointer resolves.
 *
 * A line documenting a deliberately wrong invocation (for example an
 * `E_UNKNOWN_FLAG` demonstration) opts out with a trailing
 * `# cleo-cmd: negative-example` (shell) or `<!-- cleo-cmd: negative-example -->`.
 *
 * ## Baseline
 *
 * Core-tier skills (`metadata.tier: core`) are zero-tolerance: a finding in
 * one fails even if baselined. Other skills ratchet against
 * `scripts/.lint-skill-commands-baseline.json`: a new finding fails, and so
 * does a baseline entry that no longer occurs. `--strict` ignores the
 * baseline.
 *
 * Usage: node scripts/lint-skill-commands.mjs [--check|--strict] [--json]
 *
 * @task T12649
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { isMain } from './lib/is-main.mjs';
import {
  extractCleoCommands,
  extractInvocationsWithFlags,
  findFlagViolations,
  findPointerViolations,
  findRequiredArgViolations,
  findViolations,
  loadFieldPointerContracts,
  loadRegistry,
  makeFlagChecker,
  makeSourceForVerb,
} from './lint-injection-commands.mjs';
import { MANIFEST_PATH, SKILLS_DIR } from './skills/lib/skill-frontmatter.mjs';

/** Repo-relative baseline path. */
export const BASELINE_PATH = 'scripts/.lint-skill-commands-baseline.json';

/** Marker that exempts one line documenting a deliberately wrong invocation. */
export const NEGATIVE_EXAMPLE_MARKER = 'cleo-cmd: negative-example';

/**
 * Every markdown file under a skill directory, excluding tests.
 *
 * @param {string} dir - Absolute directory.
 * @returns {string[]} Absolute paths, sorted.
 */
function markdownFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    if (entry === '__tests__' || entry === 'node_modules') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...markdownFiles(path));
    else if (entry.endsWith('.md')) out.push(path);
  }
  return out;
}

/**
 * Prepare skill markdown for scanning, keeping line numbers stable:
 * - blank the YAML frontmatter (metadata, not instructions — and `name:
 *   ct-cleo` followed by `description:` otherwise reads as `cleo description`);
 * - blank lines that carry the negative-example marker;
 * - neutralise `cleo` glued to a preceding word character or hyphen
 *   (`ct-cleo`, `non-cleo run`), which is a name, not an invocation.
 *
 * @param {string} text - File content.
 * @returns {string}
 */
export function prepareForScan(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    for (let i = 0; i <= end; i++) lines[i] = '';
  }
  return lines
    .map(dropNegativeExample)
    .join('\n')
    .replace(/([\w-])cleo\b/g, '$1CLEO');
}

/**
 * Remove only the invocation a negative-example marker annotates, so valid
 * commands elsewhere on the same line are still checked.
 *
 * - `<!-- cleo-cmd: negative-example: release ship -->` removes every
 *   `cleo release ship …` on the line (up to the next backtick or `|`).
 * - An unnamed marker (`# cleo-cmd: negative-example`) removes from the last
 *   `cleo ` before the marker to the end of the line.
 *
 * @param {string} line - One markdown line.
 * @returns {string}
 */
export function dropNegativeExample(line) {
  const at = line.indexOf(NEGATIVE_EXAMPLE_MARKER);
  if (at === -1) return line;
  const named = /cleo-cmd: negative-example:\s*([a-z][\w -]*?)\s*(?:-->|$)/.exec(line);
  if (named) {
    const phrase = named[1].trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return line.replace(new RegExp(`cleo ${phrase}[^\`|]*`, 'g'), '');
  }
  const cut = line.lastIndexOf('cleo ', at);
  return cut === -1 ? line.slice(0, at) : line.slice(0, cut);
}

/**
 * Whether sub-command `sub` in a command module declares a positional
 * argument. `null` when its `args` block cannot be located (not judged).
 *
 * @param {string} source - Command module source.
 * @param {string} sub - Sub-command name.
 * @returns {boolean | null}
 */
export function subDeclaresPositional(source, sub) {
  const metaAt = source.search(new RegExp(`meta:\\s*\\{[^}]*name:\\s*'${sub}'`));
  if (metaAt === -1) return null;
  // The command object runs from its meta to the next defineCommand( (or EOF).
  const nextDefine = source.indexOf('defineCommand(', metaAt + 1);
  const extent = source.slice(metaAt, nextDefine === -1 ? undefined : nextDefine);
  // A group: the next token is a sub-sub-command, not a positional.
  if (/\bsubCommands\s*:/.test(extent)) return null;
  const argsMatch = /\bargs\s*:\s*(\{)?/.exec(extent);
  if (!argsMatch) return false; // no args at all
  if (!argsMatch[1]) return null; // args built elsewhere (identifier/spread): not judged
  let depth = 1;
  let i = argsMatch.index + argsMatch[0].length;
  for (; i < extent.length && depth > 0; i++) {
    if (extent[i] === '{') depth++;
    else if (extent[i] === '}') depth--;
  }
  const body = extent.slice(argsMatch.index, i);
  if (/\.\.\./.test(body)) return null; // spread-in args: not judged
  return /type:\s*'positional'/.test(body);
}

/**
 * Report invocations that pass a positional argument to a sub-command that
 * declares none — citty drops it silently (`cleo manifest append '<json>'`
 * then reads stdin instead).
 *
 * @param {string} text - Prepared markdown.
 * @param {Map<string, Set<string>>} registry - verb → sub-verbs.
 * @param {(verb: string) => string | null} sourceForVerb - Module source lookup.
 * @returns {{ raw: string, reason: string }[]}
 */
export function findPositionalViolations(text, registry, sourceForVerb) {
  const out = [];
  for (const inv of extractInvocationsWithFlags(text)) {
    if (!inv.sub || !registry.get(inv.verb)?.has(inv.sub)) continue;
    const after = inv.raw.replace(new RegExp(`^cleo\\s+${inv.verb}\\s+${inv.sub}`), '').trim();
    if (after === '' || after.startsWith('-') || after.startsWith('[')) continue;
    const source = sourceForVerb(inv.verb);
    if (!source || subDeclaresPositional(source, inv.sub) !== false) continue;
    out.push({
      raw: inv.raw,
      reason: `\`cleo ${inv.verb} ${inv.sub}\` declares no positional argument, so \`${after.split(/\s+/)[0]}\` is silently ignored — pass it through a flag`,
    });
  }
  return out;
}

/**
 * Find every dead invocation across all skill markdown.
 *
 * @param {string} root - Repository root.
 * @returns {{ key: string, skill: string, core: boolean, file: string, message: string }[]}
 */
export function findSkillCommandViolations(root) {
  const skillsRoot = join(root, SKILLS_DIR);
  const manifest = JSON.parse(readFileSync(join(root, MANIFEST_PATH), 'utf-8'));
  const coreSkills = new Set(
    (manifest.skills ?? []).filter((s) => s.deliveryTier === 'core').map((s) => s.name),
  );

  const files = readdirSync(skillsRoot)
    .filter((d) => statSync(join(skillsRoot, d)).isDirectory())
    .flatMap((d) => markdownFiles(join(skillsRoot, d)).map((f) => ({ skill: d, path: f })));

  const texts = files.map((f) => ({ ...f, text: prepareForScan(readFileSync(f.path, 'utf-8')) }));
  const neededSubs = new Set(
    texts.flatMap((f) =>
      extractCleoCommands(f.text)
        .filter((c) => c.sub)
        .map((c) => c.verb),
    ),
  );
  const registry = loadRegistry(neededSubs, root);
  const checker = makeFlagChecker(root);
  const sourceForVerb = makeSourceForVerb(root);
  const contractsPath = join(root, 'packages/contracts/src/operations/output-contracts-data.ts');
  const contracts = existsSync(contractsPath)
    ? loadFieldPointerContracts(readFileSync(contractsPath, 'utf-8'))
    : new Map();

  const out = [];
  for (const { skill, path, text } of texts) {
    const file = relative(root, path);
    const found = [
      ...findViolations(text, registry),
      ...findFlagViolations(text, checker),
      ...findRequiredArgViolations(text, sourceForVerb),
      ...findPointerViolations(text, contracts, sourceForVerb),
      ...findPositionalViolations(text, registry, sourceForVerb),
    ];
    const seen = new Set();
    for (const v of found) {
      const raw = (v.raw ?? v.label ?? '').replace(/\s+/g, ' ').trim();
      const key = `${file}::${raw}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, skill, core: coreSkills.has(skill), file, message: `${raw} — ${v.reason}` });
    }
  }
  return out;
}

/**
 * Load the baseline map of key → skill.
 *
 * @param {string} root - Repository root.
 * @returns {Map<string, string>}
 */
export function loadBaseline(root) {
  const path = join(root, BASELINE_PATH);
  if (!existsSync(path)) return new Map();
  const data = JSON.parse(readFileSync(path, 'utf-8'));
  return new Map((data.entries ?? []).map((e) => [e.key, e.skill]));
}

/**
 * Run the gate.
 *
 * @param {string} root - Repository root.
 * @param {{ strict?: boolean, json?: boolean }} [opts] - Mode flags.
 * @returns {number} Exit code.
 */
export function runGate(root, opts = {}) {
  const violations = findSkillCommandViolations(root);
  const baseline = opts.strict ? new Map() : loadBaseline(root);
  const fresh = violations.filter((v) => v.core || !baseline.has(v.key));
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
      `Every cleo invocation in the skills resolves; core skills clean (${violations.length} baselined in non-core skills) (T12649).\n`,
    );
    return 0;
  }
  for (const v of fresh) {
    process.stderr.write(`  ✗ ${v.file}${v.core ? ' [core]' : ''}: ${v.message}\n`);
  }
  for (const k of stale) {
    process.stderr.write(`  ✗ baseline entry no longer occurs — remove it: ${k}\n`);
  }
  process.stderr.write(
    'Skills are instructions agents follow; a command or flag that does not exist burns the turn.\n' +
      'Fix the skill (core skills cannot be baselined), or mark a deliberate wrong example with ' +
      `\`# ${NEGATIVE_EXAMPLE_MARKER}\`.\n`,
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
