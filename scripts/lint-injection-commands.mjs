#!/usr/bin/env node
/**
 * Lint rule: every `cleo …` command named in CLEO-INJECTION.md must exist.
 *
 * ## Why (T12069)
 *
 * `packages/core/templates/CLEO-INJECTION.md` is injected verbatim into the
 * context of EVERY agent CLEO spawns, and it is written as instruction, not
 * suggestion ("FIRST CALL IS …", "BEFORE editing any symbol, run …"). An agent
 * has no way to tell a documented-but-nonexistent command from one it invoked
 * incorrectly.
 *
 * Measured on 2026-08-06, the mandated Nexus section named seven "first-reach"
 * commands. **Five did not exist** — `nexus report` (described as the one call
 * that "answers most agent project-questions"), `nexus brain find`,
 * `nexus compare`, `nexus shared`, `nexus synthesize` — plus `nexus admin`.
 * Every one returned `E_UNKNOWN_COMMAND`.
 *
 * The cost is not the wasted turn. It is that an agent which follows the
 * protocol, watches it fail, and gets no signal distinguishing "command gone"
 * from "subsystem broken" reasonably abandons the whole surface and silently
 * falls back to `grep` — which is exactly what happened, on a 4,036-file repo,
 * for an entire session.
 *
 * ## What this checks
 *
 * Extracts every `cleo <verb> [<sub>]` occurrence from the injection template
 * and asserts the verb (and sub-verb, where the parent is a known group
 * command) resolves against the built CLI's own command registry. No child
 * process is spawned per command — the registry is read once.
 *
 * Modes: `--strict` (default here — the template is small and fully
 * enumerable) and `--json` for machine consumption.
 *
 * @task T12069
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = process.cwd();
const TEMPLATE = join(REPO_ROOT, 'packages/core/templates/CLEO-INJECTION.md');

/**
 * Verbs that are documented as prose placeholders rather than real commands
 * (`cleo <command> [args]` in the protocol header) or that name a user-supplied
 * operation rather than a fixed verb.
 */
const PLACEHOLDER_VERBS = new Set(['<command>', '<op>', '<verb>', '<id>', '<taskId>']);

/**
 * Commands the template names DELIBERATELY while documenting that they no
 * longer exist ("`cleo bug` / `--role` removed — use `cleo add --kind bug`").
 *
 * Naming a retired verb is how the protocol stops an agent from reaching for
 * muscle memory, so these must stay in the text. Each entry needs a rationale;
 * an entry whose command later comes BACK is harmless (the lint only checks
 * for absence).
 */
export const RETIRED_COMMAND_ALLOWLIST = new Map([
  [
    'bug',
    'Documented as REMOVED under Task Creation (ADR-066) — superseded by `cleo add --kind bug`.',
  ],
]);

/**
 * Extract `cleo <verb> <sub>` pairs from markdown.
 *
 * Handles both inline-code (`` `cleo nexus status` ``) and fenced-block forms,
 * since the template uses both. Flags/placeholders are ignored — only the verb
 * and an immediately-following bare sub-verb are considered.
 *
 * @param markdown - the template text.
 * @returns unique `{verb, sub, raw}` records in document order.
 */
export function extractCleoCommands(markdown) {
  const seen = new Map();
  for (const match of markdown.matchAll(/\bcleo\s+([a-z][\w-]*)(?:\s+([a-z][\w-]*))?/g)) {
    const verb = match[1];
    if (PLACEHOLDER_VERBS.has(verb)) continue;
    const sub = match[2] ?? null;
    const key = sub ? `${verb} ${sub}` : verb;
    if (!seen.has(key)) seen.set(key, { verb, sub, raw: key });
  }
  return [...seen.values()];
}

/**
 * Load the CLI's command registry by parsing SOURCE, never `dist/`.
 *
 * Static parsing is deliberate, and matches the convention the sibling
 * architectural gates already follow ("parses the SSoT from SOURCE (never
 * dist/, so a stale dist cannot hide the drift)"). It also means this gate
 * runs in CI on a bare checkout — no `pnpm install`, no build — which is what
 * keeps it a 30-second job rather than a 10-minute one.
 *
 * Top-level verbs come from the generated command manifest. Sub-verbs are read
 * from the `subCommands: { … }` block of the root `defineCommand` in each
 * referenced command module.
 *
 * @param neededSubs - verbs whose sub-commands must be resolved.
 * @returns map of verb → Set of sub-verbs (empty Set when leaf/unresolvable).
 */
function loadRegistry(neededSubs) {
  const manifestSource = readFileSync(
    join(REPO_ROOT, 'packages/cleo/src/cli/generated/command-manifest.ts'),
    'utf-8',
  );

  // Each manifest entry pairs a user-facing `name` with the module it imports.
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
  // Root aliases declared in cli/index.ts via `alias(<name>, <export>)`.
  const cliIndex = readFileSync(join(REPO_ROOT, 'packages/cleo/src/cli/index.ts'), 'utf-8');
  for (const m of cliIndex.matchAll(/^alias\('([^']+)'/gm)) registry.set(m[1], new Set());

  for (const verb of neededSubs) {
    const moduleName = moduleByVerb.get(verb);
    if (!moduleName) continue;
    const modulePath = join(REPO_ROOT, 'packages/cleo/src/cli/commands', `${moduleName}.ts`);
    let source;
    try {
      source = readFileSync(modulePath, 'utf-8');
    } catch {
      continue; // command lives in a directory module — treat as leaf
    }
    const subs = extractRootSubCommands(source, verb);
    if (subs.size > 0) registry.set(verb, subs);
  }
  return registry;
}

/**
 * Extract sub-command keys from a command module's ROOT `defineCommand`.
 *
 * A module declares many nested `defineCommand`s; only the exported root one
 * (`export const <verb>Command = defineCommand({ … })`) enumerates the
 * user-facing sub-verbs. Scans forward from that export to its first
 * `subCommands: {` and collects keys until the block closes.
 *
 * @param source - the command module source.
 * @param verb   - the user-facing verb (used to locate the export).
 * @returns the set of sub-command keys (empty when the command is a leaf).
 */
export function extractRootSubCommands(source, verb) {
  const exportRe = new RegExp(`export const ${verb}Command\\s*[:=]`);
  const exportAt = source.search(exportRe);
  if (exportAt === -1) return new Set();

  const blockAt = source.indexOf('subCommands: {', exportAt);
  if (blockAt === -1) return new Set();

  const bodyStart = blockAt + 'subCommands: {'.length;
  let depth = 1;
  let i = bodyStart;
  for (; i < source.length && depth > 0; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
  }
  // Strip line comments first: entries are routinely preceded by a `// T1058
  // — code symbol search` note, which breaks a naive "comma then key" match
  // and silently under-reports the sub-command set (a false violation on a
  // command that demonstrably works).
  const body = source.slice(bodyStart, i - 1).replace(/\/\/[^\n]*/g, '');

  const subs = new Set();
  // Keys may be bare (`status:`) or quoted (`'search-code':`) — hyphenated
  // verbs must be quoted, and those are exactly the ones worth catching.
  for (const m of body.matchAll(/(?:^|[,{])\s*'?([a-z][\w-]*)'?\s*:/gm)) subs.add(m[1]);
  return subs;
}

/**
 * Required flags declared by a sub-command's citty `args` block.
 *
 * T12077: Gate 14 originally asserted only that a command EXISTS. That is not
 * enough — the protocol table said
 *
 *   | Start session | `cleo session start --scope global` |
 *
 * and `session start` declares BOTH `scope` and `name` as `required: true`, so
 * following the protocol literally produced
 * `E_VALIDATION: Missing required argument: --name`. This is the first command
 * an agent runs when dropped into a new project, so the documented onboarding
 * path failed at step one.
 *
 * Existence and invocability are different properties; a protocol that is
 * phrased as instruction has to satisfy both.
 *
 * @param source - the command module source.
 * @param sub    - the sub-command key (e.g. `start`).
 * @returns set of required flag names, or an empty set when none/unparseable.
 */
export function extractRequiredArgs(source, sub) {
  // Locate `meta: { name: '<sub>' ... }` then the sibling `args: {` block.
  const metaRe = new RegExp(`meta:\\s*\\{[^}]*name:\\s*'${sub}'`);
  const metaAt = source.search(metaRe);
  if (metaAt === -1) return new Set();

  const argsAt = source.indexOf('args: {', metaAt);
  if (argsAt === -1) return new Set();
  // Bail if another defineCommand starts before the args block — that means
  // this command declares no args of its own.
  const nextDefine = source.indexOf('defineCommand(', metaAt + 1);
  if (nextDefine !== -1 && nextDefine < argsAt) return new Set();

  const bodyStart = argsAt + 'args: {'.length;
  let depth = 1;
  let i = bodyStart;
  for (; i < source.length && depth > 0; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
  }
  const body = source.slice(bodyStart, i - 1).replace(/\/\/[^\n]*/g, '');

  const required = new Set();
  // Each entry is `<flag>: { ... }` — capture the flag then test its block.
  for (const m of body.matchAll(/(?:^|[,{])\s*'?([a-z][\w-]*)'?\s*:\s*\{/gm)) {
    const start = m.index + m[0].length;
    let d = 1;
    let j = start;
    for (; j < body.length && d > 0; j++) {
      if (body[j] === '{') d++;
      else if (body[j] === '}') d--;
    }
    const block = body.slice(start, j - 1);
    // Positionals are supplied without a flag, so a doc line that passes them
    // inline (`cleo memory find "<topic>"`) is correct and must not be
    // reported. Only flag-style args can be 'missing' from an invocation.
    if (/type:\s*'positional'/.test(block)) continue;
    if (/required:\s*true/.test(block)) required.add(m[1]);
  }
  return required;
}

/**
 * Flags present on a documented command invocation.
 *
 * @param invocation - the raw text of the documented command.
 * @returns set of flag names (without leading dashes).
 */
export function flagsIn(invocation) {
  return new Set([...invocation.matchAll(/--([a-z][\w-]*)/g)].map((m) => m[1]));
}

/**
 * Check the template against the registry.
 *
 * @param markdown - template text.
 * @param registry - verb → sub-verb map.
 * @returns violation records (empty when clean).
 */
export function findViolations(markdown, registry) {
  const violations = [];
  for (const cmd of extractCleoCommands(markdown)) {
    if (!registry.has(cmd.verb)) {
      if (RETIRED_COMMAND_ALLOWLIST.has(cmd.verb)) continue;
      violations.push({ ...cmd, reason: `no such command: cleo ${cmd.verb}` });
      continue;
    }
    const subs = registry.get(cmd.verb);
    // Only enforce the sub-verb when the parent actually declares sub-commands;
    // otherwise the second token is a positional argument, not a verb.
    if (cmd.sub && subs.size > 0 && !subs.has(cmd.sub)) {
      violations.push({
        ...cmd,
        reason: `cleo ${cmd.verb} has no sub-command '${cmd.sub}' (has: ${[...subs].sort().join(', ')})`,
      });
    }
  }
  return violations;
}

/**
 * Report documented invocations that omit a REQUIRED flag.
 *
 * Only invocations that already carry at least one `--flag` are checked. A bare
 * `cleo session start` in prose is a reference to the command; a partially
 * flagged one is a worked example, and a worked example that cannot run is the
 * defect. This keeps the rule quiet on prose while still catching the T12077
 * case, where the table said `cleo session start --scope global` and `name` is
 * equally required.
 *
 * @param markdown - the template text.
 * @param sourceForVerb - resolves a verb to its command-module source.
 * @returns violation records (empty when clean).
 *
 * @task T12077
 */
export function findRequiredArgViolations(markdown, sourceForVerb) {
  const violations = [];
  const seen = new Set();

  for (const m of markdown.matchAll(/`cleo\s+([a-z][\w-]*)\s+([a-z][\w-]*)([^`]*)`/g)) {
    const [, verb, sub, tail] = m;
    const flags = flagsIn(tail);
    if (flags.size === 0) continue; // prose reference, not a worked example

    const source = sourceForVerb(verb);
    if (!source) continue;

    const required = extractRequiredArgs(source, sub);
    if (required.size === 0) continue;

    const missing = [...required].filter((f) => !flags.has(f));
    if (missing.length === 0) continue;

    const key = `${verb} ${sub}:${missing.join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);

    violations.push({
      verb,
      sub,
      raw: `cleo ${verb} ${sub}${tail}`.trim(),
      reason: `missing required flag(s): ${missing.map((f) => `--${f}`).join(' ')}`,
    });
  }
  return violations;
}

// ---------------------------------------------------------------------------
// T12127 (GH #1225 · #1239 · #1231) — documented POINTERS must resolve too.
//
// Gate 14 already asserts that every `cleo <verb>` named in the template
// exists, and T12077 extended it to "exists AND is runnable". This is the same
// rule one level down: a documented `--field` JSON pointer must resolve against
// the operation's `fieldPointers` contract.
//
// The template's only `--field` example was `cleo add … --field /data/created/0`
// — a MUTATION envelope, which is flat. Read envelopes nest under `task`. With
// no read example to generalise from, every agent following the injection
// guessed `/data/<field>` for a read and hit E_FIELD_NOT_FOUND. Three separate
// agents filed it (#1225, #1239, #1231), and each said the same thing: the
// error message is excellent, the documentation is what was wrong.
// ---------------------------------------------------------------------------

/** Pointers documented for a shell-variable capture rather than a real op. */
const POINTER_PLACEHOLDERS = new Set(['<jsonpointer>', '<pointer>', '<field>']);

/**
 * Extract every `cleo <verb> … --field <pointer>` pairing from markdown.
 *
 * Scoped to a single line so a `--field` further down the document is never
 * attributed to an unrelated verb above it.
 *
 * @param markdown - the template text.
 * @returns `{verb, pointer, raw}` records in document order.
 */
export function extractDocumentedPointers(markdown) {
  const out = [];
  for (const line of markdown.split('\n')) {
    for (const m of line.matchAll(
      /\bcleo\s+([a-z][\w-]*)[^\n]*?--field\s+(\/[\w\-./<>]+|<[\w-]+>)/g,
    )) {
      const verb = m[1];
      const pointer = m[2];
      if (POINTER_PLACEHOLDERS.has(pointer)) continue;
      if (!pointer.startsWith('/')) continue;
      out.push({ verb, pointer, raw: `cleo ${verb} --field ${pointer}` });
    }
  }
  return out;
}

/**
 * Parse `operation -> Set<fieldPointer>` out of the OUTPUT_CONTRACTS source.
 *
 * Reads from SOURCE, never `dist/`, so the gate runs on a bare checkout with
 * no install and no build — the same contract the sibling gates follow.
 *
 * @param source - contents of `packages/contracts/src/operations/output-contracts-data.ts`.
 * @returns map of operation name → the pointers its contract declares.
 */
export function loadFieldPointerContracts(source) {
  const contracts = new Map();
  const opMatches = [...source.matchAll(/operation:\s*'([a-z][\w.-]*)'/g)];
  for (let i = 0; i < opMatches.length; i++) {
    const op = opMatches[i][1];
    const start = opMatches[i].index ?? 0;
    const end =
      i + 1 < opMatches.length ? (opMatches[i + 1].index ?? source.length) : source.length;
    const block = source.slice(start, end);
    const fp = block.match(/fieldPointers:\s*\[([\s\S]*?)\]/);
    if (!fp) continue;
    const pointers = new Set([...fp[1].matchAll(/'(\/[^']+)'/g)].map((m) => m[1]));
    if (pointers.size > 0) contracts.set(op, pointers);
  }
  return contracts;
}

/**
 * Resolve a CLI verb to its canonical `<domain>.<operation>` identifier.
 *
 * Three declaration styles are in use across the command modules, so all three
 * are matched rather than assuming one:
 *   - `dispatchRaw('query', 'tasks', 'show')`
 *   - `operation: 'tasks.update'`
 *   - `getOperationParams('query', 'tasks', 'show')`
 *
 * @param source - the verb's command-module source, or null when unresolvable.
 * @returns the operation name, or null.
 */
export function operationForVerbSource(source) {
  if (!source) return null;
  const dispatch = source.match(/dispatchRaw\(\s*'(?:query|mutate)',\s*'([\w.-]+)',\s*'([\w.-]+)'/);
  if (dispatch) return `${dispatch[1]}.${dispatch[2]}`;
  const explicit = source.match(/operation:\s*'([a-z][\w.-]*\.[\w.-]+)'/);
  if (explicit) return explicit[1];
  const params = source.match(
    /getOperationParams\(\s*'(?:query|mutate)',\s*'([\w.-]+)',\s*'([\w.-]+)'/,
  );
  if (params) return `${params[1]}.${params[2]}`;
  return null;
}

/**
 * Flag every documented `--field` pointer that its operation's contract does
 * not declare.
 *
 * Silent when the verb cannot be resolved to an operation, or the operation has
 * no OUTPUT contract yet (OUTPUT_CONTRACTS is populated incrementally) — this
 * gate asserts that what IS documented is correct, never that every op has a
 * contract.
 *
 * @param markdown - the template text.
 * @param contracts - from {@link loadFieldPointerContracts}.
 * @param sourceForVerb - resolves a verb to its command-module source.
 * @returns violation records shaped like the gate's other checks.
 */
export function findPointerViolations(markdown, contracts, sourceForVerb) {
  const violations = [];
  for (const doc of extractDocumentedPointers(markdown)) {
    const operation = operationForVerbSource(sourceForVerb(doc.verb));
    if (!operation) continue;
    const declared = contracts.get(operation);
    if (!declared) continue;
    if (declared.has(doc.pointer)) continue;
    violations.push({
      raw: doc.raw,
      reason:
        `pointer "${doc.pointer}" is not declared by the ${operation} OUTPUT contract. ` +
        `Valid: ${[...declared].join(', ')}. ` +
        'Every agent CLEO spawns is instructed to use these pointers, so a wrong one ' +
        'costs a turn and teaches the wrong envelope shape.',
    });
  }
  return violations;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const asJson = process.argv.includes('--json');
  const markdown = readFileSync(TEMPLATE, 'utf-8');
  const neededSubs = new Set(
    extractCleoCommands(markdown)
      .filter((c) => c.sub !== null)
      .map((c) => c.verb),
  );
  const registry = loadRegistry(neededSubs);
  const violations = findViolations(markdown, registry);

  // T12077: existence is not enough — a documented invocation must also be
  // runnable. Resolve each verb's module source once and check required flags.
  const manifestSrc = readFileSync(
    join(REPO_ROOT, 'packages/cleo/src/cli/generated/command-manifest.ts'),
    'utf-8',
  );
  const moduleByVerb = new Map(
    [
      ...manifestSrc.matchAll(
        /name:\s*'([^']+)',[\s\S]{0,400}?import\('\.\.\/commands\/([^']+)\.js'\)/g,
      ),
    ].map((m) => [m[1], m[2]]),
  );
  const sourceForVerb = (verb) => {
    const mod = moduleByVerb.get(verb);
    if (!mod) return null;
    try {
      return readFileSync(join(REPO_ROOT, 'packages/cleo/src/cli/commands', `${mod}.ts`), 'utf-8');
    } catch {
      return null;
    }
  };
  violations.push(...findRequiredArgViolations(markdown, sourceForVerb));

  // T12127: existence and runnability are still not enough — a documented
  // `--field` pointer must also RESOLVE against the op's OUTPUT contract.
  const pointerContracts = loadFieldPointerContracts(
    readFileSync(
      join(REPO_ROOT, 'packages/contracts/src/operations/output-contracts-data.ts'),
      'utf-8',
    ),
  );
  violations.push(...findPointerViolations(markdown, pointerContracts, sourceForVerb));

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ violations }, null, 2)}\n`);
  } else if (violations.length > 0) {
    process.stderr.write(
      `CLEO-INJECTION.md has ${violations.length} unresolvable reference(s) ` +
        '(a command that does not exist, an invocation that cannot run, or a ' +
        '`--field` pointer the operation does not declare).\n' +
        'Every agent CLEO spawns is instructed to follow these.\n\n',
    );
    for (const v of violations) {
      process.stderr.write(`  ✗ ${v.raw}\n      ${v.reason}\n`);
    }
    process.stderr.write(
      '\nFix the template, or implement the command / add the pointer to the contract.\n',
    );
  } else {
    process.stdout.write(
      `CLEO-INJECTION.md: all ${extractCleoCommands(markdown).length} referenced commands exist, ` +
        `and all ${extractDocumentedPointers(markdown).length} documented --field pointer(s) resolve.\n`,
    );
  }
  process.exit(violations.length > 0 ? 1 : 0);
}
