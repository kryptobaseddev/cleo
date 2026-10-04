/**
 * `@cleocode/core/registrations` carries every module-load registration the
 * CORE barrel performs (T13126).
 *
 * The CLI loads `registrations` instead of `@cleocode/core/internal` before an
 * operation. That is only behaviour-preserving while every module in the
 * barrel's graph that does something at load (a top-level statement) is also
 * reachable from `registrations`. A bare side-effect import is an edge: what
 * it runs is its target's top-level statements. This test scans
 * both static graphs and fails on a gap, so a new registration added anywhere
 * under the barrel cannot silently stop running for CLI operations.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Barrel modules with load-time effects that operations do not depend on, and why.
 */
const EXEMPT: Readonly<Record<string, string>> = {
  'internal.ts': "the barrel's own dev-only warning about importing it",
  'render/tasks/index.ts':
    'human renderers: the CLI loads render/index for human output, and only render/ reads the registry',
  'render/session/index.ts': 'renderer registration, see render/index.ts',
  'render/orchestration/index.ts': 'renderer registration, see render/index.ts',
  'render/brain/index.ts': 'renderer registration, see render/index.ts',
  'llm/model-runner.ts':
    'installs the AI SDK warning handler, which the CLI entry installs at startup',
  'store/agent-resolver.ts': '`void _DatabaseSync`: a no-op reference',
  'llm/executor-factory.ts':
    'registers the llm-summarization context engine; its only reader (`cleo llm engines`) imports executor-factory itself',
  'llm/context-engines/index.ts': 'fills its own module-local registry; readers import it',
  'templates/registry.ts':
    'a load-time assertion that the template sources exist (no registration); it now runs when templates are used',
  'error-registry.ts': 'fills its own module-local exit-code map in a loop; readers import it',
};

/** Static, non-type relative imports and re-exports of a module. */
function staticDeps(file: string): { deps: string[]; effects: string[] } {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const deps: string[] = [];
  const effects: string[] = [];
  for (const st of sf.statements) {
    const spec =
      (ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) &&
      st.moduleSpecifier &&
      ts.isStringLiteral(st.moduleSpecifier)
        ? st.moduleSpecifier.text
        : null;
    if (spec !== null) {
      const typeOnly =
        (ts.isImportDeclaration(st) && st.importClause?.isTypeOnly === true) ||
        (ts.isExportDeclaration(st) && st.isTypeOnly);
      if (typeOnly || !spec.startsWith('.')) continue;
      const base = resolve(dirname(file), spec).replace(/\.js$/, '');
      const target = [`${base}.ts`, join(base, 'index.ts')].find((c) => existsSync(c));
      if (target) deps.push(target);
      // A bare import runs its target; the target's own statements are the effect.
      if (ts.isImportDeclaration(st) && !st.importClause && !target) {
        effects.push(`import '${spec}'`);
      }
      continue;
    }
    if (ts.isExpressionStatement(st) && !ts.isStringLiteral(st.expression)) {
      effects.push(st.expression.getText(sf).slice(0, 60));
      continue;
    }
    // Statements that run code at load without being an expression: a
    // `try { register() }`, an `if (x) install()`, a loop, a bare block, an
    // `export =`. Initializer calls (`const x = register()`) are not caught:
    // they cannot be told apart from plain values without false positives.
    if (
      ts.isIfStatement(st) ||
      ts.isTryStatement(st) ||
      ts.isForStatement(st) ||
      ts.isForInStatement(st) ||
      ts.isForOfStatement(st) ||
      ts.isWhileStatement(st) ||
      ts.isDoStatement(st) ||
      ts.isBlock(st) ||
      ts.isExportAssignment(st)
    ) {
      effects.push(st.getText(sf).slice(0, 60));
    }
  }
  return { deps, effects };
}

/** Every module reachable from `entry`, with its load-time effects. */
function graph(entry: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || out.has(file)) continue;
    const { deps, effects } = staticDeps(file);
    out.set(file, effects);
    queue.push(...deps);
  }
  return out;
}

describe('@cleocode/core/registrations', () => {
  it('reaches every module of the barrel that does something at load', () => {
    const barrel = graph(join(SRC, 'internal.ts'));
    const registrations = graph(join(SRC, 'registrations.ts'));
    const missing = [...barrel]
      .filter(([, effects]) => effects.length > 0)
      .map(([file]) => relative(SRC, file).split('\\').join('/'))
      .filter((file) => !(file in EXEMPT))
      .filter((file) => !registrations.has(join(SRC, file)));
    expect(missing).toEqual([]);
  });

  it('keeps every exemption current', () => {
    const barrel = graph(join(SRC, 'internal.ts'));
    for (const file of Object.keys(EXEMPT)) {
      expect(barrel.get(join(SRC, file))?.length ?? 0, file).toBeGreaterThan(0);
    }
  });

  it('loads far less than the barrel', () => {
    const barrel = graph(join(SRC, 'internal.ts')).size;
    const registrations = graph(join(SRC, 'registrations.ts')).size;
    expect(registrations).toBeLessThan(barrel / 2);
  });
});
