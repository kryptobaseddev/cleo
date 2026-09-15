#!/usr/bin/env node
/**
 * Gate 15: every `cleo …` command invoked by a GitHub workflow must exist.
 *
 * ## Why (T12093)
 *
 * Gate 14 (`lint-injection-commands.mjs`) asserts this for the text injected
 * into agents. The same defect in a *workflow* is strictly worse, because the
 * failure is delayed and expensive:
 *
 * `release-prepare.yml` ran `cleo version-bump --version …` at step 3 of the
 * `Prepare bump-PR` job. That verb has NEVER existed — it is absent from the
 * command manifest — so every dispatch died with
 *
 *     Unknown command version-bump
 *     Process completed with exit code 127
 *
 * *after* a full green preflight: lint, typecheck, build and both test shards,
 * ~21 minutes per attempt. The very next step called `cleo release changelog`,
 * which does not exist either (`cleo release` has no `changelog` sub-verb), so
 * fixing only the first would have burned another 21 minutes to reveal the
 * second. Both had been in the workflow — and in the shipped template every
 * consuming project renders — since PR #868 on 2026-05-31.
 *
 * A lint that reads the command manifest answers this in 200 ms.
 *
 * ## What this checks
 *
 * Every `.github/workflows/*.yml` plus every rendered
 * `packages/core/templates/workflows/*.yml.tmpl`: each `cleo <verb> [<sub>]`
 * occurrence must resolve against the CLI's own command registry, parsed from
 * SOURCE (never `dist/`) so the gate needs no build.
 *
 * Zero-tolerance: no baseline. A workflow step that cannot run is never
 * something to burn down gradually — it is a broken pipeline.
 *
 * @task T12093
 */

import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  extractRootSubCommands,
  findFlagViolations,
  makeFlagChecker,
} from './lint-injection-commands.mjs';

const REPO_ROOT = process.cwd();

/**
 * `cleo <verb> [<sub>]`, anchored so a *suffix* of a longer token cannot match.
 *
 * The lookbehind is the whole reason this is a bespoke pattern: `\b` matches
 * after `/`, so `pnpm --filter @cleocode/cleo exec node build.mjs` would read as
 * the nonexistent `cleo exec`, and `packages/cleo packages/cleo-os` as
 * `cleo packages`. Both are real lines in this repo's workflows.
 */
const CLEO_INVOCATION = /(?<![\w/@.-])cleo[ \t]+([a-z][\w-]*)(?:[ \t]+([a-z][\w-]*))?/g;

/**
 * Extract `cleo <verb> [<sub>]` invocations from the `run:` blocks of a workflow.
 *
 * Two deliberate narrowings versus gate 14's extractor:
 *
 * - **`run:` only.** A `name:` is a display string; `- name: Assert every cleo
 *   command in CLEO-INJECTION.md exists` describes a step, it does not invoke
 *   anything. Only shell can fail with exit 127, so only shell is scanned.
 * - **Line-local matching.** Gate 14 matches across newlines (`\s+`), which is
 *   right for prose but wrong for YAML: `ln -sf … /usr/local/bin/cleo` is
 *   followed by the next mapping key, and would read as `cleo timeout-minutes`.
 *
 * `#` comment lines inside a script are skipped, so a comment that documents a
 * removed verb cannot fail the gate.
 *
 * @param yamlText - the workflow source (placeholders already blanked).
 * @returns unique `{verb, sub, raw, line}` records in document order.
 */
export function extractWorkflowCleoCommands(yamlText) {
  const seen = new Map();
  const lines = yamlText.split('\n');

  /** Indentation of the `run:` key whose block we are inside, or null. */
  let blockIndent = null;

  const scan = (text, lineNo) => {
    for (const m of text.matchAll(CLEO_INVOCATION)) {
      const key = m[2] ? `${m[1]} ${m[2]}` : m[1];
      if (!seen.has(key)) {
        seen.set(key, { verb: m[1], sub: m[2] ?? null, raw: `cleo ${key}`, line: lineNo });
      }
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const indent = line.length - line.trimStart().length;

    if (blockIndent !== null) {
      // A blank line stays in the block; a dedent to the key's level ends it.
      if (line.trim() === '') continue;
      if (indent > blockIndent) {
        if (!/^\s*#/.test(line)) scan(line, i + 1);
        continue;
      }
      blockIndent = null;
    }

    const runKey = line.match(/^(\s*)(?:-\s+)?run:[ \t]*(.*)$/);
    if (!runKey) continue;

    const rest = runKey[2].trim();
    if (rest === '' || rest === '|' || rest === '>' || /^[|>][-+]?\d*$/.test(rest)) {
      blockIndent = indent;
    } else {
      scan(rest, i + 1);
    }
  }
  return [...seen.values()];
}

/**
 * Load verb → sub-verb map from the CLI manifest, resolving sub-commands only
 * for the verbs actually referenced.
 *
 * @param neededSubs - verbs whose sub-commands must be resolved.
 * @returns map of verb → Set of sub-verbs (empty Set when leaf/unresolvable).
 */
function loadRegistry(neededSubs) {
  const manifestSource = readFileSync(
    join(REPO_ROOT, 'packages/cleo/src/cli/generated/command-manifest.ts'),
    'utf-8',
  );

  const registry = new Map();
  const moduleByVerb = new Map();
  for (const entry of manifestSource.matchAll(
    /name:\s*'([^']+)',[\s\S]{0,400}?import\('\.\.\/commands\/([^']+)\.js'\)/g,
  )) {
    registry.set(entry[1], new Set());
    moduleByVerb.set(entry[1], entry[2]);
  }
  // `version` is defined inline in cli/index.ts rather than via the manifest.
  registry.set('version', new Set());
  const cliIndex = readFileSync(join(REPO_ROOT, 'packages/cleo/src/cli/index.ts'), 'utf-8');
  for (const m of cliIndex.matchAll(/^alias\('([^']+)'/gm)) registry.set(m[1], new Set());

  for (const verb of neededSubs) {
    const moduleName = moduleByVerb.get(verb);
    if (!moduleName) continue;
    let source;
    try {
      source = readFileSync(
        join(REPO_ROOT, 'packages/cleo/src/cli/commands', `${moduleName}.ts`),
        'utf-8',
      );
    } catch {
      continue; // directory module — treat as leaf
    }
    const subs = extractRootSubCommands(source, verb);
    if (subs.size > 0) registry.set(verb, subs);
  }
  return registry;
}

/**
 * Check one workflow document against the registry.
 *
 * @param file     - repo-relative path, for reporting.
 * @param yamlText - the workflow source.
 * @param registry - verb → sub-verb map.
 * @returns violation records (empty when clean).
 */
export function findWorkflowViolations(file, yamlText, registry) {
  const violations = [];
  for (const cmd of extractWorkflowCleoCommands(yamlText)) {
    if (!registry.has(cmd.verb)) {
      violations.push({
        file,
        ...cmd,
        reason: `no such command: \`cleo ${cmd.verb}\` — the verb is absent from the CLI manifest, so this step exits 127 at runtime`,
      });
      continue;
    }
    const subs = registry.get(cmd.verb);
    if (cmd.sub && subs.size > 0 && !subs.has(cmd.sub)) {
      violations.push({
        file,
        ...cmd,
        reason: `\`cleo ${cmd.verb}\` has no sub-command '${cmd.sub}' (has: ${[...subs].sort().join(', ')})`,
      });
    }
  }
  return violations;
}

/**
 * Render `{{PLACEHOLDER}}` tokens out of a template so the YAML scans cleanly.
 *
 * The substituted values are irrelevant here — only `cleo` invocations matter,
 * and a placeholder never expands into one. Blanking them keeps a
 * `{{VERSION_BUMP_CMD}}` line from being mistaken for a command.
 *
 * @param source - template text.
 * @returns text with placeholders replaced by a neutral token.
 */
function stripPlaceholders(source) {
  return source.replace(/\{\{[A-Z_]+\}\}/g, 'PLACEHOLDER');
}

/**
 * The shell text of a workflow's `run:` blocks, with every other line blanked.
 *
 * Blanking rather than dropping keeps line numbers aligned with the file, so a
 * violation points at the step an operator can actually open. Comment lines are
 * blanked too, matching {@link extractWorkflowCleoCommands}: gate 15 has always
 * held that a `#` line documenting a removed verb is not a broken step, and the
 * same must hold for a removed flag — `worktree-cleanup.yml`'s header comment
 * explains that `--pr` never existed, and a gate that failed on the
 * explanation would force the explanation to be deleted.
 *
 * @param yamlText - the workflow source (placeholders already blanked).
 * @returns text of the same line count, containing only `run:` shell.
 * @task T12190
 */
export function extractRunBlockText(yamlText) {
  const lines = yamlText.split('\n');
  const out = new Array(lines.length).fill('');
  let blockIndent = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const indent = line.length - line.trimStart().length;

    if (blockIndent !== null) {
      if (line.trim() === '') continue;
      if (indent > blockIndent) {
        if (!/^\s*#/.test(line)) out[i] = line;
        continue;
      }
      blockIndent = null;
    }

    const runKey = line.match(/^(\s*)(?:-\s+)?run:[ \t]*(.*)$/);
    if (!runKey) continue;
    const rest = runKey[2].trim();
    if (rest === '' || rest === '|' || rest === '>' || /^[|>][-+]?\d*$/.test(rest)) {
      blockIndent = indent;
    } else {
      out[i] = rest;
    }
  }
  return out.join('\n');
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const asJson = process.argv.includes('--json');

  const files = [
    ...globSync('.github/workflows/*.yml', { cwd: REPO_ROOT }),
    ...globSync('packages/core/templates/workflows/*.yml.tmpl', { cwd: REPO_ROOT }),
  ].sort();

  const docs = files.map((rel) => ({
    rel,
    text: stripPlaceholders(readFileSync(join(REPO_ROOT, rel), 'utf-8')),
  }));

  const neededSubs = new Set(
    docs.flatMap((d) =>
      extractWorkflowCleoCommands(d.text)
        .filter((c) => c.sub !== null)
        .map((c) => c.verb),
    ),
  );
  const registry = loadRegistry(neededSubs);

  const violations = docs.flatMap((d) => findWorkflowViolations(d.rel, d.text, registry));

  // T12190 (GH #1373) — the verb half is not the whole call site. `cleo init
  // --yes` sat in `worktree-cleanup.yml` since PR #868 doing nothing, and
  // `release-rollback.yml.tmpl` passed `--reason "${REASON}"` to a command with
  // no such flag, so the operator's rollback reason was parsed as a stray
  // positional and never reached the database — while the step reported
  // success every time. Both are shipped templates, so both went to every
  // consuming project.
  const checker = makeFlagChecker(REPO_ROOT);
  for (const d of docs) {
    for (const v of findFlagViolations(extractRunBlockText(d.text), checker)) {
      violations.push({ file: d.rel, ...v });
    }
  }
  const checked = docs.reduce((n, d) => n + extractWorkflowCleoCommands(d.text).length, 0);

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ checked, violations }, null, 2)}\n`);
  } else if (violations.length > 0) {
    process.stderr.write(
      `lint-workflow-cleo-commands: FAIL — ${violations.length} workflow step(s) invoke a command, sub-command or flag that does not exist.\n\n`,
    );
    for (const v of violations) {
      process.stderr.write(`  ✗ ${v.file}:${v.line}  ${v.raw}\n      ${v.reason}\n`);
    }
    process.stderr.write(
      '\nWhy this is zero-tolerance: these steps run AFTER preflight, so each one costs a\n' +
        'full ~20-minute green build to discover, and the shipped template carries the same\n' +
        'break into every consuming project. Implement the command or fix the workflow.\n',
    );
  } else {
    process.stdout.write(
      `lint-workflow-cleo-commands: OK — ${checked} cleo invocation(s) across ${files.length} workflow file(s) all resolve, flags included.\n`,
    );
  }
  process.exit(violations.length > 0 ? 1 : 0);
}
