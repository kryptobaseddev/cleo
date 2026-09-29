/**
 * T12698 — no code path reads the focus pointer around `readLiveFocus`.
 *
 * A per-call scan over the TypeScript AST of core, cleo and studio:
 *  - `readFocusState(...)` (the RAW reader) may be called only from the
 *    read-modify-write writer functions listed below, by `file#function`;
 *  - `getMetaValue` / `setMetaValue` on a focus key — any quote style, a
 *    template, the `LEGACY_FOCUS_STATE_KEY` constant or a `focusStateKey(...)`
 *    call — only inside the focus store itself.
 * Paths are compared with `/` separators on every platform.
 *
 * @task T12698
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const STORE = 'packages/core/src/sessions/focus-state-store.ts';

/** RAW `readFocusState` call sites: writers that read-modify-write the blob. */
const RAW_READ_ALLOWED = new Set([
  'packages/core/src/sessions/focus-state-store.ts#readLiveFocus',
  'packages/core/src/sessions/session-switch.ts#switchSession',
  'packages/core/src/tasks/analyze.ts#analyzeTaskPriority',
  'packages/core/src/task-work/index.ts#startTask',
  'packages/core/src/task-work/index.ts#stopTask',
  'packages/core/src/task-work/index.ts#getWorkHistory',
  'packages/core/src/phases/index.ts#renamePhase',
  'packages/core/src/session/engine-ops.ts#sessionEnd',
  'packages/core/src/session/engine-ops.ts#sessionResume',
  // T12661: reads only focus.currentPhase for the ranking tiebreak, never the
  // task pointer; readLiveFocus would load the pointed task for nothing.
  'packages/core/src/tasks/task-next.ts#resolveRankingPhase',
]);

/** Violations in one source file, keyed `path#function: what`. */
export function scanFocusReads(relPath: string, text: string, seen?: Set<string>): string[] {
  const path = relPath.split(sep).join('/').replace(/\\/g, '/');
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];

  const calleeName = (call: ts.CallExpression): string | null => {
    const e = call.expression;
    if (ts.isIdentifier(e)) return e.text;
    if (ts.isPropertyAccessExpression(e)) return e.name.text;
    return null;
  };
  const isFocusKey = (node: ts.Node | undefined): boolean => {
    if (!node) return false;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      return node.text === 'focus_state' || node.text.startsWith('focus_state:');
    if (ts.isTemplateExpression(node)) return node.head.text.startsWith('focus_state');
    if (ts.isIdentifier(node)) return node.text === 'LEGACY_FOCUS_STATE_KEY';
    if (ts.isPropertyAccessExpression(node)) return node.name.text === 'LEGACY_FOCUS_STATE_KEY';
    if (ts.isCallExpression(node)) return calleeName(node) === 'focusStateKey';
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node))
      return isFocusKey(node.expression);
    return false;
  };
  const enclosing = (node: ts.Node): string => {
    for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
      if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name)
        return n.name.getText(source);
      if (
        (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) &&
        ts.isVariableDeclaration(n.parent) &&
        ts.isIdentifier(n.parent.name)
      )
        return n.parent.name.text;
    }
    return '<module>';
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      const site = `${path}#${enclosing(node)}`;
      if (name === 'readFocusState') {
        if (RAW_READ_ALLOWED.has(site)) seen?.add(site);
        else out.push(`${site}: raw readFocusState`);
      }
      if (
        (name === 'getMetaValue' || name === 'setMetaValue') &&
        path !== STORE &&
        isFocusKey(node.arguments[0])
      )
        out.push(`${site}: ${name} on a focus key`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');

function sourceFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory())
      return name === '__tests__' || name === 'node_modules' || name === 'generated'
        ? []
        : sourceFiles(path);
    return /\.ts$/.test(name) && !/\.(test|spec|d)\.ts$/.test(name) ? [path] : [];
  });
}

describe('the focus scanner catches every shape (T12698)', () => {
  const at = 'packages/cleo/src/x.ts';
  it.each([
    ['double quotes', 'acc.getMetaValue("focus_state")'],
    ['single quotes', "acc.getMetaValue('focus_state')"],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test
    ['a template', 'acc.getMetaValue(`focus_state:${id}`)'],
    ['the legacy constant', 'acc.getMetaValue(LEGACY_FOCUS_STATE_KEY)'],
    ['a namespaced constant', 'acc.getMetaValue(store.LEGACY_FOCUS_STATE_KEY)'],
    ['focusStateKey()', 'acc.setMetaValue(focusStateKey(sid), v)'],
    ['an unlisted raw read', 'readFocusState(acc, sid)'],
  ])('%s', (_label, call) => {
    expect(scanFocusReads(at, `export async function f() { await ${call}; }`)).toHaveLength(1);
  });

  it('allows a listed writer, per function — not a whole file', () => {
    const file = 'packages/core/src/task-work/index.ts';
    expect(
      scanFocusReads(file, 'export async function startTask() { readFocusState(a, b); }'),
    ).toEqual([]);
    expect(
      scanFocusReads(file, 'export async function currentTask() { readFocusState(a, b); }'),
    ).toEqual([`${file}#currentTask: raw readFocusState`]);
  });

  it('normalises Windows separators', () => {
    expect(
      scanFocusReads(
        'packages\\core\\src\\task-work\\index.ts',
        'export async function startTask() { readFocusState(a, b); }',
      ),
    ).toEqual([]);
  });

  it('ignores an unrelated meta key', () => {
    expect(
      scanFocusReads(at, "export async function f() { acc.getMetaValue('project'); }"),
    ).toEqual([]);
  });
});

describe('no reader bypasses readLiveFocus in core, cleo or studio (T12698)', () => {
  it('finds no violation, and every allowed writer still exists', () => {
    const seen = new Set<string>();
    const violations = ['packages/core/src', 'packages/cleo/src', 'packages/studio/src'].flatMap(
      (dir) =>
        sourceFiles(join(repo, dir)).flatMap((file) =>
          scanFocusReads(relative(repo, file), readFileSync(file, 'utf-8'), seen),
        ),
    );
    expect(violations).toEqual([]);
    // A stale allowlist entry would silently re-open a raw read later.
    expect([...RAW_READ_ALLOWED].filter((site) => !seen.has(site))).toEqual([]);
  });
});
