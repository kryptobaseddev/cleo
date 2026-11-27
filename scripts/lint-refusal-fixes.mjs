#!/usr/bin/env node
/**
 * Gate 42 — every refusal on the task close, cancel, verify, done, review,
 * docs-link and docs-update paths carries a runnable fix (T14299, T14663).
 *
 * A refusal is a `new CleoError(code, message, options)`, an
 * `engineError(code, message, options)` or a `lafsError(code, message, op,
 * fix)` inside one of {@link REFUSAL_PATHS}; on an entry with `results: true`
 * it is also a returned `{ ok: false, error: { code, message, fix } }` result
 * literal. It counts as fix-less unless an options (or `error`) object literal
 * names `fix` (or `lafsError` gets its fourth argument). A fix that is a
 * string or template literal, a conditional between two, or a local `const`
 * initialised with one, must also run as written: every `cleo …` command in it resolves against the CLI command
 * manifest with declared flags, judged by gate 14's own registry and flag
 * checker (the same check `scripts/__tests__/runnable-remedies.test.mjs` runs
 * on each named remedy).
 *
 * {@link PINNED} caps the fix-less and unrunnable refusals per file. A count
 * above its pin fails; a count below it fails too, naming the lower pin, so
 * the cap only falls. There is no `--baseline` mode: a pin is lowered by hand
 * in the PR that adds the fixes. Accepted modes: `--check` (default) and
 * `--strict` (every pin treated as zero).
 *
 * @task T14299
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { isMain } from './lib/is-main.mjs';
import {
  findFlagViolations,
  findViolations,
  loadRegistry,
  makeFlagChecker,
} from './lint-injection-commands.mjs';

/**
 * The paths whose refusals must carry a fix: a file, optionally the
 * functions (declarations, methods or object-property handlers) within it,
 * and `results: true` when the file refuses through `{ ok: false, error }`
 * result literals instead of thrown errors.
 */
export const REFUSAL_PATHS = [
  { path: 'close', file: 'packages/core/src/tasks/complete.ts' },
  { path: 'close', file: 'packages/core/src/tasks/merge-close.ts' },
  {
    path: 'cancel',
    file: 'packages/core/src/tasks/engine-wrap.ts',
    functions: ['coreTaskCancel', 'taskCancel'],
  },
  {
    path: 'verify',
    file: 'packages/core/src/validation/engine-ops.ts',
    functions: ['validateGateVerify'],
  },
  // The dispatch handler `cleo verify` runs, and its --criterion receipt path.
  {
    path: 'verify',
    file: 'packages/cleo/src/dispatch/domains/check.ts',
    functions: ['gate.set', 'gate.run'],
  },
  {
    path: 'verify',
    file: 'packages/core/src/tasks/criterion-receipt.ts',
    functions: ['recordCriterionReceipt'],
  },
  // `cleo complete` re-validates every hard atom here before closing.
  { path: 'close', file: 'packages/core/src/tasks/evidence.ts', functions: ['revalidateEvidence'] },
  { path: 'done', file: 'packages/core/src/tasks/done-plan.ts' },
  { path: 'done', file: 'packages/core/src/tasks/done-record.ts' },
  { path: 'review', file: 'packages/core/src/tasks/review-verdict.ts' },
  {
    path: 'docs-link',
    file: 'packages/cleo/src/dispatch/domains/docs.ts',
    functions: ['link-decision', 'unlink-decision', 'decisionLinkResponse'],
  },
  // `cleo docs update`: the dispatch handler, and the core function whose
  // `{ ok: false, error }` results it forwards with `error.fix` (T14663).
  {
    path: 'docs-update',
    file: 'packages/cleo/src/dispatch/domains/docs.ts',
    functions: ['update'],
  },
  { path: 'docs-update', file: 'packages/core/src/docs/docs-update.ts', results: true },
];

/** Fix-less or unrunnable refusals allowed per file; may only fall (T14299). */
export const PINNED = {
  'packages/core/src/tasks/complete.ts': 0,
  'packages/core/src/tasks/merge-close.ts': 0,
  'packages/core/src/tasks/engine-wrap.ts': 0,
  'packages/core/src/validation/engine-ops.ts': 0,
  'packages/cleo/src/dispatch/domains/check.ts': 0,
  'packages/core/src/tasks/criterion-receipt.ts': 0,
  'packages/core/src/tasks/evidence.ts': 0,
  'packages/core/src/tasks/done-plan.ts': 0,
  'packages/core/src/tasks/done-record.ts': 0,
  'packages/core/src/tasks/review-verdict.ts': 0,
  'packages/cleo/src/dispatch/domains/docs.ts': 0,
  'packages/core/src/docs/docs-update.ts': 0,
};

/** The name a function-like node is known by, or null. */
function functionName(node) {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name !== undefined) {
    return node.name.getText().replace(/^['"]|['"]$/g, '');
  }
  if (
    ts.isPropertyAssignment(node) &&
    (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
  ) {
    return node.name.getText().replace(/^['"]|['"]$/g, '');
  }
  return null;
}

/** The fix argument of a refusal call, `null` when it has none. */
function fixOf(callee, args) {
  if (callee === 'lafsError') {
    const fix = args[3];
    return fix === undefined || fix.getText() === 'undefined' ? null : fix;
  }
  for (const arg of args) {
    if (!ts.isObjectLiteralExpression(arg)) continue;
    for (const prop of arg.properties) {
      if (ts.isPropertyAssignment(prop) && prop.name.getText() === 'fix') return prop.initializer;
      if (ts.isShorthandPropertyAssignment(prop) && prop.name.getText() === 'fix') return prop.name;
    }
  }
  return null;
}

/** The literal text of a fix, with each `${…}` replaced by a placeholder id. */
function fixText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((s) => `T1${s.literal.text}`).join('');
  }
  return null;
}

/** The literal texts a fix may take: both branches of a conditional, else its one text. */
function fixTexts(node) {
  if (ts.isParenthesizedExpression(node)) return fixTexts(node.expression);
  if (ts.isConditionalExpression(node)) {
    return [...fixTexts(node.whenTrue), ...fixTexts(node.whenFalse)];
  }
  return [fixText(node)];
}

/** The `error` object literal of an `{ ok: false, error: {…} }` result literal, or null. */
function resultError(node) {
  if (!ts.isObjectLiteralExpression(node)) return null;
  let failed = false;
  let error = null;
  for (const prop of node.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const key = prop.name.getText();
    if (key === 'ok' && prop.initializer.kind === ts.SyntaxKind.FalseKeyword) failed = true;
    if (key === 'error' && ts.isObjectLiteralExpression(prop.initializer)) error = prop.initializer;
  }
  return failed ? error : null;
}

/** Every literal a `const` of each name is initialised with in a file. */
function constLiterals(sf) {
  const byName = new Map();
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      fixText(node.initializer) !== null
    ) {
      const name = node.name.text;
      byName.set(name, [...(byName.get(name) ?? []), fixText(node.initializer)]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return byName;
}

/**
 * The refusals of one file that carry no fix, or a fix naming a command the
 * CLI rejects.
 *
 * @param repoRoot - Absolute repository root.
 * @param entry - A {@link REFUSAL_PATHS} entry.
 * @param check - `(text) => violations` for one fix's commands.
 * @returns One record per offending refusal.
 */
export function offendingRefusals(repoRoot, entry, check) {
  const source = readFileSync(join(repoRoot, entry.file), 'utf8');
  const sf = ts.createSourceFile(entry.file, source, ts.ScriptTarget.Latest, true);
  const consts = constLiterals(sf);
  const out = [];
  const visit = (node, inScope) => {
    const name = functionName(node);
    const scoped = inScope || (name !== null && (entry.functions ?? []).includes(name));
    let callee = null;
    let args = null;
    if (ts.isNewExpression(node) && node.expression.getText() === 'CleoError') {
      callee = 'CleoError';
      args = [...(node.arguments ?? [])];
    } else if (ts.isCallExpression(node)) {
      const text = node.expression.getText();
      if (text === 'engineError' || text === 'lafsError') {
        callee = text;
        args = [...node.arguments];
      }
    } else if (entry.results === true && resultError(node) !== null) {
      callee = '{ ok: false } result';
      args = [resultError(node)];
    }
    if (callee !== null && (entry.functions === undefined || scoped)) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      const fix = fixOf(callee, args);
      if (fix === null) out.push({ file: entry.file, line, reason: `${callee} with no fix` });
      else {
        // A fix named by a local `const` is checked through its literal(s);
        // any other expression (a passed-through `error.fix`) is not literal.
        const texts = ts.isIdentifier(fix) ? (consts.get(fix.text) ?? []) : fixTexts(fix);
        const bad = texts.flatMap((text) => (text === null ? [] : check(text)));
        if (bad.length > 0)
          out.push({ file: entry.file, line, reason: `fix does not run: ${bad.join('; ')}` });
      }
    }
    ts.forEachChild(node, (child) => visit(child, scoped));
  };
  visit(sf, false);
  return out;
}

/**
 * The fix checker gate 42 judges with: gate 14's command registry and flag
 * checker over the CLI command manifest.
 *
 * @param repoRoot - Absolute repository root.
 * @returns `check(text)`, the violations of one fix's commands.
 */
export function refusalChecker(repoRoot) {
  const registry = loadRegistry(
    new Set([
      'backup',
      'check',
      'deps',
      'docs',
      'doctor',
      'memory',
      'nexus',
      'orchestrate',
      'release',
      'req',
      'review',
      'session',
      'worktree',
    ]),
    repoRoot,
  );
  const checker = makeFlagChecker(repoRoot);
  const check = (text) => [
    ...findViolations(text, registry).map((v) => v.reason),
    ...findFlagViolations(text, checker).map((v) => v.reason),
  ];
  return { check };
}

/**
 * Judge every refusal path against its pin.
 *
 * @param repoRoot - Absolute repository root.
 * @param strict - Treat every pin as zero.
 * @returns The offending refusals and the per-file failures.
 */
export function judgeRefusalFixes(repoRoot, strict = false) {
  const { check } = refusalChecker(repoRoot);
  const byFile = new Map();
  for (const entry of REFUSAL_PATHS) {
    byFile.set(entry.file, [
      ...(byFile.get(entry.file) ?? []),
      ...offendingRefusals(repoRoot, entry, check),
    ]);
  }
  const failures = [];
  for (const [file, offending] of byFile) {
    const pin = strict ? 0 : (PINNED[file] ?? 0);
    if (offending.length > pin)
      failures.push(
        `${file}: ${offending.length} refusal(s) without a runnable fix (pinned at ${pin}):\n` +
          offending.map((o) => `  ${o.file}:${o.line} ${o.reason}`).join('\n'),
      );
    else if (offending.length < pin)
      failures.push(
        `${file}: ${offending.length} refusal(s) without a runnable fix, below its pin ${pin}; lower PINNED['${file}'] to ${offending.length}`,
      );
  }
  return { byFile, failures };
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== '--check' && a !== '--strict');
  if (unknown.length > 0) {
    console.error(
      `lint-refusal-fixes: unknown argument(s) ${unknown.join(' ')}; use --check or --strict`,
    );
    process.exit(2);
  }
  const { byFile, failures } = judgeRefusalFixes(process.cwd(), args.includes('--strict'));
  if (failures.length > 0) {
    console.error(`lint-refusal-fixes (T14299): FAIL\n${failures.join('\n')}`);
    process.exit(1);
  }
  const total = [...byFile.values()].reduce((n, o) => n + o.length, 0);
  console.log(
    `lint-refusal-fixes: OK — ${REFUSAL_PATHS.length} refusal path(s) in ${byFile.size} file(s), ${total} refusal(s) without a runnable fix (all at or under their pins).`,
  );
}
