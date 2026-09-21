#!/usr/bin/env node
/**
 * Lint rule: every `cleo …` command CLEO writes into an agent's prompt must
 * exist, and every flag on it must be one the command accepts.
 *
 * ## Why (gh#1468)
 *
 * Gate 14 checks `CLEO-INJECTION.md`. Gate 15 checks workflow `run:` blocks.
 * Neither checks the third agent-facing surface, and it is the one CLEO
 * GENERATES: `cleo orchestrate spawn <id>` composes a prompt whose
 * stage-specific guidance is a literal instruction list, embedded verbatim in
 * every spawned agent's context.
 *
 * Measured on 2026-09-21, the Validation stage told every agent:
 *
 *     - Run `cleo verify <id> --run` and capture output
 *
 * `--run` had been the documented typed-gate driver since T768, and had been
 * dropped from the command. The agent that followed the instruction got
 * `Unknown flag: --run`, discovered that typed gates nevertheless execute as a
 * side effect of an unrelated `--evidence` write, and had no supported way to
 * ask the question the protocol had just told it to ask.
 *
 * That is the same defect class as T12069's five nonexistent Nexus commands,
 * on a surface nobody was watching — and it is arguably worse, because a
 * template is at least reviewable as text, while this instruction is assembled
 * at runtime and only ever read inside somebody else's agent.
 *
 * ## What this checks
 *
 * The prompt-emitting modules listed in {@link PROMPT_SOURCES} are scanned for
 * `cleo <verb> [<sub>] [--flags]` invocations. Verb and sub-verb must resolve
 * against the CLI's command manifest; every long flag must be declared by that
 * command, be a CLI global, or be hand-wired.
 *
 * Every rule and allowlist is imported from `lint-injection-commands.mjs`
 * rather than restated. A second copy of the CLI's flag model would drift from
 * the parser it models, and a gate that rejects flags the CLI accepts is worse
 * than the silence it replaces.
 *
 * Modes: `--strict` / `--check` (identical — this surface is small and fully
 * enumerable, so there is no baseline) and `--json`.
 *
 * @task gh#1468
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  extractInvocationsWithFlags,
  findFlagViolations,
  findViolations,
  makeFlagChecker,
} from './lint-injection-commands.mjs';

const REPO_ROOT = process.cwd();

/**
 * Modules that write `cleo …` invocations into text an agent is told to follow.
 *
 * Deliberately an explicit list, not a glob. A glob over `packages/core/src`
 * would sweep in error messages, comments and test fixtures, and the resulting
 * noise is what gets a gate disabled. A module that starts emitting agent
 * instructions gets added here in the same PR.
 */
export const PROMPT_SOURCES = [
  'packages/core/src/orchestration/spawn-prompt.ts',
  'packages/core/src/orchestration/harness-hint.ts',
  'packages/core/src/agents/work-loop.ts',
];

/**
 * Source trees whose RUNTIME ERROR remediations are checked (gh#1470).
 *
 * A `fix:` string is the most load-bearing instruction CLEO emits: the reader
 * is already stuck, has just been told the thing they tried was wrong, and has
 * no reason to doubt the one command offered as the way out. A remediation
 * that does not run costs the turn AND the reader's trust in the subsystem.
 *
 * Measured 2026-09-21, scanning 255 remediation lines: two were unrunnable.
 * `cleo session list --active` (the flag is `--status active`) was the advice
 * for resolving a session conflict — the exact situation in which an agent is
 * already blocked — and `cleo schema --list`, offered when an operation key is
 * unknown, named a flag that had never existed, so the remedy for "you do not
 * know the key" was itself rejected with E_UNKNOWN_FLAG.
 *
 * Both are the same defect the `E_EVIDENCE_GIT_ROOT` and `E_SESSION_CONFLICT`
 * messages had: a remedy that cannot resolve what it reports.
 */
export const REMEDIATION_ROOTS = ['packages/core/src', 'packages/cleo/src'];

/**
 * Lines that are commentary about a command rather than an instruction to run
 * it.
 *
 * A source module explains itself in prose, and a TSDoc line naming a retired
 * verb while documenting its removal must not be read as telling an agent to
 * run it — the same carve-out gate 14 makes for `RETIRED_COMMAND_ALLOWLIST`.
 * Only `//`- and `*`-prefixed lines qualify: anything inside a template
 * literal reaches the agent.
 *
 * @param raw - the matched invocation text.
 * @param line - the full source line it was found on.
 */
function isCommentary(line) {
  return /^\s*(?:\/\/|\/\*|\*)/.test(line);
}

/**
 * Violations across every prompt source.
 *
 * @param repoRoot - absolute repo root.
 * @returns `{ file, violations }` records for files with findings.
 */
export function findPromptViolations(repoRoot) {
  const checker = makeFlagChecker(repoRoot);
  const manifestSubs = new Map();
  const results = [];
  let scanned = 0;

  for (const rel of PROMPT_SOURCES) {
    let source;
    try {
      source = readFileSync(join(repoRoot, rel), 'utf-8');
    } catch {
      continue; // an emitter that moved is gate 20's problem, not a false fail
    }
    // Drop comment lines before scanning so prose about a command is never
    // read as an instruction to run it.
    const instructions = source
      .split('\n')
      .map((line) => (isCommentary(line) ? '' : line))
      .join('\n');

    scanned += extractInvocationsWithFlags(instructions).length;
    const violations = [
      ...findViolations(instructions, loadRegistry(repoRoot, manifestSubs)),
      ...findFlagViolations(instructions, checker),
    ];
    if (violations.length > 0) results.push({ file: rel, violations });
  }

  // gh#1470: the same rule, applied to runtime remediations.
  for (const { file, text, count } of remediationLines(repoRoot)) {
    scanned += count;
    const violations = findFlagViolations(text, checker);
    if (violations.length > 0) results.push({ file, violations });
  }

  return { results, scanned };
}

/**
 * Remediation lines — a `fix:`/`Run …` string naming a `cleo` command.
 *
 * Narrow on purpose. A source file mentions commands in prose, in TSDoc and in
 * tests; only a line that both reads as a remediation AND names a command is
 * an instruction someone will follow. Comment lines are dropped first, so a
 * docblock describing a retired verb is never read as advice to run it.
 *
 * @param repoRoot - absolute repo root.
 * @returns one `{file, text, count}` record per file with remediation lines.
 */
function remediationLines(repoRoot) {
  const out = [];
  for (const root of REMEDIATION_ROOTS) {
    let files;
    try {
      files = execFileSync(
        'grep',
        ['-rl', '--include=*.ts', '-E', String.raw`fix:\s*['\x60"]`, join(repoRoot, root)],
        { encoding: 'utf-8' },
      )
        .trim()
        .split('\n')
        .filter(Boolean);
    } catch {
      continue; // grep exits 1 on no matches
    }
    for (const abs of files) {
      if (abs.includes('__tests__')) continue;
      const lines = readFileSync(abs, 'utf-8')
        .split('\n')
        .filter((l) => !isCommentary(l))
        .filter((l) => /\bcleo\s+[a-z]/.test(l) && /fix:|Fix:|Run '|Run \x60/.test(l));
      if (lines.length === 0) continue;
      out.push({
        file: abs.replace(`${repoRoot}/`, ''),
        text: lines.join('\n'),
        count: lines.length,
      });
    }
  }
  return out;
}

/**
 * Verb → sub-verb registry, read from the manifest once and memoised.
 *
 * @param repoRoot - absolute repo root.
 * @param cache - caller-owned memo map.
 */
function loadRegistry(repoRoot, cache) {
  if (cache.has('registry')) return cache.get('registry');
  const manifestSource = readFileSync(
    join(repoRoot, 'packages/cleo/src/cli/generated/command-manifest.ts'),
    'utf-8',
  );
  const registry = new Map();
  for (const entry of manifestSource.matchAll(
    /name:\s*'([^']+)',[\s\S]{0,400}?import\('\.\.\/commands\/([^']+)\.js'\)/g,
  )) {
    registry.set(entry[1], new Set());
  }
  registry.set('version', new Set());
  const cliIndex = readFileSync(join(repoRoot, 'packages/cleo/src/cli/index.ts'), 'utf-8');
  for (const m of cliIndex.matchAll(/^alias\('([^']+)'/gm)) registry.set(m[1], new Set());
  cache.set('registry', registry);
  return registry;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const asJson = process.argv.includes('--json');
  const { results, scanned } = findPromptViolations(REPO_ROOT);
  const total = results.reduce((n, r) => n + r.violations.length, 0);

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ files: results }, null, 2)}\n`);
  } else if (total > 0) {
    process.stderr.write(
      `Agent prompts contain ${total} unrunnable \`cleo\` invocation(s).\n` +
        'These are written into the context of every agent CLEO spawns and are ' +
        'phrased as instructions, so a command or flag that does not exist ' +
        'burns the turn and teaches the agent the subsystem is broken.\n\n',
    );
    for (const { file, violations } of results) {
      process.stderr.write(`  ${file}\n`);
      for (const v of violations) process.stderr.write(`    ✗ ${v.raw}\n        ${v.reason}\n`);
    }
    process.stderr.write('\nFix the prompt, or implement the command / flag it names.\n');
  } else {
    process.stdout.write(
      `Agent prompts + runtime remediations: all ${scanned} \`cleo\` invocation(s) ` +
        `across ${PROMPT_SOURCES.length} emitter(s) and ${REMEDIATION_ROOTS.length} source ` +
        `tree(s) name an existing command with declared flags.\n`,
    );
  }
  process.exit(total > 0 ? 1 : 0);
}
