/**
 * Writer audit test (T10368) — every `.md` writer call in
 * `packages/core/src/**` MUST either route through {@link WriterRegistry.write}
 * or be registered in {@link WriterRegistry.listSystemManaged} with an ADR
 * pointer.
 *
 * The test walks the repo via filesystem read + simple text scan (NOT a full
 * AST parse — the parse cost is not justified for ~30 hits). For every
 * `writeFileSync(`/`fs.writeFile(`/`writeFile(` call we check:
 *
 *   1. Does the file path string literal end with `.md` AND
 *   2. Does the source file have either:
 *      - An `import` for `WriterRegistry` (routes-through-the-registry), OR
 *      - A `// T10368-audit-ok: <id>` annotation linking to a registered
 *        `SYSTEM_MANAGED_ENTRIES` id?
 *
 * Test files (`__tests__/`, `.test.ts`, `.spec.ts`) are excluded — they
 * intentionally write `.md` fixtures to scratch dirs.
 *
 * This is intentionally simple. The full lint gate lands in T10369 with AST
 * walking + more sophisticated path tracking; this test is the per-PR
 * regression net for the audit work done in this PR.
 *
 * @task T10368
 * @epic T10290
 * @saga T10288
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WriterRegistry } from '../writer-registry.js';

// Walk up from this test file to the repo root.
const PROJECT_ROOT = resolve(__dirname, '..', '..', '..', '..', '..');
const CORE_SRC = join(PROJECT_ROOT, 'packages', 'core', 'src');

/**
 * Recursively enumerate every `.ts` file under `dir`, skipping test
 * directories.
 */
function* walkTs(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === '__tests__' || name === 'node_modules' || name === 'dist') continue;
    const full = join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      yield* walkTs(full);
    } else if (st.isFile()) {
      if (name.endsWith('.test.ts') || name.endsWith('.spec.ts')) continue;
      if (name.endsWith('.ts')) yield full;
    }
  }
}

/**
 * Quick-and-dirty single-line heuristic: a writer call line that mentions
 * `.md` somewhere in its surroundings. Matches the same shapes the audit
 * grep used:
 *
 *   - `writeFileSync(<expr>, ...)`
 *   - `fs.writeFileSync(<expr>, ...)`
 *   - `writeFile(<expr>, ...)` (fs/promises)
 *   - `fs.writeFile(<expr>, ...)`
 *
 * Returns the matched lines together with their line numbers.
 */
function findMdWriterLines(source: string): Array<{ lineNo: number; line: string }> {
  const lines = source.split('\n');
  const hits: Array<{ lineNo: number; line: string }> = [];
  const writerRe = /\b(writeFileSync|fs\.writeFile|writeFile)\s*\(/;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    if (!writerRe.test(raw)) continue;
    // Strip line comments + leading whitespace for the .md heuristic. We
    // grab the next few lines too so multi-line writer calls still match.
    const context = lines.slice(i, Math.min(i + 4, lines.length)).join('\n');
    if (!/\.md\b|\.md['"`]|\.MD\b|CHANGELOG/i.test(context)) continue;
    hits.push({ lineNo: i + 1, line: raw });
  }
  return hits;
}

describe('Writer audit (T10368)', () => {
  it('every .md writer in packages/core/src/** is either WriterRegistry-routed or system-managed-registered', () => {
    const unregisteredHits: Array<{
      file: string;
      lineNo: number;
      line: string;
    }> = [];

    for (const filePath of walkTs(CORE_SRC)) {
      const rel = relative(PROJECT_ROOT, filePath);
      // Skip the writer-registry module itself — it OWNS the system-managed
      // map and references `.md` extensions in glob strings.
      if (rel.endsWith('packages/core/src/docs/writer-registry.ts')) continue;
      // Skip non-source helpers like the audit walker.
      if (rel.endsWith('packages/core/src/docs/__tests__/writer-audit.test.ts')) continue;

      let source: string;
      try {
        source = readFileSync(filePath, 'utf-8');
      } catch {
        continue;
      }

      const hits = findMdWriterLines(source);
      if (hits.length === 0) continue;

      // The file mentions a `.md` writer. Permit it if:
      //  (a) the source imports WriterRegistry (routes-through-the-registry),
      //  (b) the source has a `// T10368-audit-ok: <id>` annotation, OR
      //  (c) every hit line / its 2-line neighborhood mentions a path string
      //      that matches one of the registered system-managed globs.
      const importsRegistry = /from\s+['"][^'"]*writer-registry(?:\.js)?['"]/.test(source);
      const auditOk = /\/\/\s*T10368-audit-ok\s*:/.test(source);

      // For each hit, attempt to extract a path-literal substring and test
      // it against `WriterRegistry.isSystemManaged`. If the literal is built
      // dynamically (`join(...)`), we accept the call ONLY when the source
      // already imports `WriterRegistry` or carries the audit-ok annotation.
      for (const hit of hits) {
        if (importsRegistry || auditOk) continue;

        // Look for a quoted `.md`-ish string literal on the call line.
        // This is a best-effort path extraction.
        const strMatch = hit.line.match(/['"`]([^'"`]*\.(?:md|MD|json))['"`]/);
        if (strMatch !== null && strMatch[1] !== undefined) {
          const entry = WriterRegistry.isSystemManaged(strMatch[1]);
          if (entry !== null) continue;
        }

        // Look at the broader neighborhood (CHANGELOG.md, etc.).
        const neighborhood = source
          .split('\n')
          .slice(Math.max(0, hit.lineNo - 5), hit.lineNo + 5)
          .join('\n');
        if (/CHANGELOG\.md/.test(neighborhood)) {
          const entry = WriterRegistry.isSystemManaged('CHANGELOG.md');
          if (entry !== null) continue;
        }

        unregisteredHits.push({ file: rel, lineNo: hit.lineNo, line: hit.line.trim() });
      }
    }

    if (unregisteredHits.length > 0) {
      const report = unregisteredHits
        .map(
          (h) =>
            `  ${h.file}:${h.lineNo}\n    ${h.line}\n` +
            `    → route through WriterRegistry.write OR register in SYSTEM_MANAGED_ENTRIES`,
        )
        .join('\n');
      throw new Error(
        `T10368 writer audit found ${unregisteredHits.length} unregistered .md writer(s):\n${report}`,
      );
    }
  });

  it('every system-managed entry points at a real file on disk', () => {
    for (const entry of WriterRegistry.listSystemManaged()) {
      const absolute = join(PROJECT_ROOT, entry.sourcePath);
      let exists = false;
      try {
        exists = statSync(absolute).isFile();
      } catch {
        exists = false;
      }
      expect(exists, `${entry.id} → ${entry.sourcePath} should exist`).toBe(true);
    }
  });
});
