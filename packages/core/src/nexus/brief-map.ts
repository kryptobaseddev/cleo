/**
 * Brief codebase map: what already exists, so "reuse first" costs no search (T13666).
 *
 * One line per folder listing its exported names, inside a character budget,
 * shared code (utils, lib, services, core, …) first and tests skipped. The
 * names come from the nexus graph (parsed by tree-sitter, exact) when the
 * project is indexed, else from a regex walk of git-tracked files. The idea
 * and the fallback's patterns are adapted from Ponytail 5.1.0's
 * `ponytail-map.js` (DietrichGebert, MIT).
 *
 * @task T13666
 * @epic T13418
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import type { BriefMapFile, BriefMapReport } from '@cleocode/contracts';

/** Default character budget (Ponytail's default). */
export const BRIEF_MAP_DEFAULT_BUDGET = 2000;

/** What `cleo briefing` prints instead of a map when the project has no code index. */
export const BRIEF_MAP_NO_INDEX = 'no code index; run `cleo nexus analyze`';

const MAX_FILES = 4000;
const SRC = /\.(py|js|jsx|mjs|cjs|ts|tsx|go|rs|rb|java|kt|php|swift|cs)$/;
const SKIP_DIR =
  /(^|\/)(node_modules|\.git|dist|build|out|vendor|venv|\.venv|__pycache__|coverage|\.next|target|migrations|fixtures|tests?|__tests__|spec)(\/|$)/;
const SKIP_FILE = /(^|\/)(test_[^/]*|[^/]*(_test|\.test|\.spec|\.gen|\.min|\.d)\.[a-z]+)$/;
const SHARED = /(util|helper|lib|common|shared|service|component|hook|core|model|schema|api)/i;

/** Symbol kinds that name something reusable. */
const SYMBOL_KINDS = new Set([
  'function',
  'class',
  'interface',
  'struct',
  'trait',
  'type_alias',
  'enum',
  'constant',
  'variable',
  'module',
  'record',
  'union',
  'typedef',
  'type',
]);

/** Whether a repo-relative path is source worth mapping (not a test, generated or vendored file). */
export function isMappableSource(file: string): boolean {
  return SRC.test(file) && !SKIP_DIR.test(file) && !SKIP_FILE.test(file);
}

/**
 * Render the map from per-file names: one line per folder, shared folders
 * first, within `budget` characters.
 *
 * @param files - files with their exported names.
 * @param budget - character budget for the folder lines.
 * @returns the text, and how many folders were listed and skipped.
 */
export function formatBriefMap(
  files: readonly BriefMapFile[],
  budget: number = BRIEF_MAP_DEFAULT_BUDGET,
): { text: string; folders: number; skipped: number } {
  const ordered = files
    .filter((f) => f.names.length > 0 && isMappableSource(f.file))
    .slice()
    .sort(
      (a, b) =>
        Number(SHARED.test(b.file)) - Number(SHARED.test(a.file)) || a.file.localeCompare(b.file),
    );
  const dirs = new Map<string, (readonly string[])[]>();
  for (const f of ordered) {
    const dir = dirname(f.file);
    dirs.set(dir, [...(dirs.get(dir) ?? []), f.names]);
  }
  const lines: string[] = [];
  let used = 0;
  let skipped = 0;
  for (const [dir, perFile] of dirs) {
    // The first names say what a file is; in a folder of many files, one name each.
    const take = perFile.length > 8 ? 1 : 3;
    const names = [...new Set(perFile.flatMap((n) => n.slice(0, take)))];
    const line = `${dir}/: ${names.slice(0, 30).join(', ')}${names.length > 30 ? ', ...' : ''}`;
    if (used + line.length > budget) {
      skipped++;
      continue;
    }
    lines.push(line);
    used += line.length + 1;
  }
  if (lines.length === 0) return { text: '', folders: 0, skipped };
  const text = [
    'Codebase map (what already exists; reuse it, read a file only when you need its details):',
    ...lines,
    ...(skipped ? [`(${skipped} more folders not listed)`] : []),
  ].join('\n');
  return { text, folders: lines.length, skipped };
}

/** Exported names per file from the nexus graph; empty when the project is not indexed. */
async function filesFromNexus(projectRoot: string): Promise<BriefMapFile[]> {
  try {
    const { and, eq } = await import('drizzle-orm');
    const { getNexusDb, nexusSchema } = await import('../store/nexus-sqlite.js');
    const db = await getNexusDb(projectRoot);
    const t = nexusSchema.nexusNodes;
    const rows = db
      .select({ file: t.filePath, name: t.name, kind: t.kind, line: t.startLine })
      .from(t)
      .where(and(eq(t.isExported, true), eq(t.isExternal, false)))
      .all();
    const byFile = new Map<string, { name: string; line: number }[]>();
    for (const r of rows) {
      if (!r.file || !r.name || !SYMBOL_KINDS.has(r.kind) || r.name.startsWith('_')) continue;
      byFile.set(r.file, [...(byFile.get(r.file) ?? []), { name: r.name, line: r.line ?? 0 }]);
    }
    return [...byFile].map(([file, names]) => ({
      file,
      names: [...new Set(names.sort((a, b) => a.line - b.line).map((n) => n.name))],
    }));
  } catch {
    return [];
  }
}

const PATTERNS: Readonly<Record<string, readonly RegExp[]>> = {
  py: [/^(?:async\s+)?def\s+([A-Za-z]\w*)/gm, /^class\s+([A-Za-z]\w*)/gm],
  js: [
    /^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm,
    /^export\s*\{([^}]*)\}/gm,
  ],
  go: [/^func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)/gm, /^type\s+([A-Z]\w*)/gm],
  rs: [/^pub\s+(?:async\s+)?(?:fn|struct|enum|trait|type)\s+(\w+)/gm],
  rb: [/^\s*(?:def|class|module)\s+([A-Za-z][\w.]*)/gm],
  jvm: [/^\s*(?:public\s+)?(?:static\s+)?(?:final\s+)?(?:class|interface|enum|record)\s+(\w+)/gm],
};
const LANG: Readonly<Record<string, string>> = {
  py: 'py',
  js: 'js',
  jsx: 'js',
  mjs: 'js',
  cjs: 'js',
  ts: 'js',
  tsx: 'js',
  go: 'go',
  rs: 'rs',
  rb: 'rb',
  java: 'jvm',
  kt: 'jvm',
  swift: 'jvm',
  cs: 'jvm',
  php: 'jvm',
};

/**
 * Exported top-level names in one source file, by regex.
 * shortcut: regex, not a parser (misses nested or dynamic exports), use the nexus graph when indexed
 *
 * @param file - repo-relative path (its extension picks the patterns).
 * @param text - file contents.
 */
export function namesInSource(file: string, text: string): string[] {
  const names: string[] = [];
  for (const re of PATTERNS[LANG[extname(file).slice(1)] ?? ''] ?? []) {
    for (const m of text.matchAll(re)) {
      for (const raw of (m[1] ?? '').split(',')) {
        const n =
          raw
            .trim()
            .split(/\s+as\s+/)
            .pop() ?? '';
        if (n && !n.startsWith('_') && !names.includes(n)) names.push(n);
      }
    }
  }
  return names;
}

/** Exported names per git-tracked file, by regex. */
function filesFromGitWalk(projectRoot: string): BriefMapFile[] {
  let tracked: string[];
  try {
    tracked = execFileSync('git', ['ls-files'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      maxBuffer: 64 * 1024 * 1024,
    })
      .split('\n')
      .filter(isMappableSource)
      .slice(0, MAX_FILES);
  } catch {
    return [];
  }
  const files: BriefMapFile[] = [];
  for (const file of tracked) {
    try {
      const text = readFileSync(join(projectRoot, file), 'utf-8').slice(0, 65536);
      files.push({ file, names: namesInSource(file, text) });
    } catch {
      // unreadable or deleted since ls-files: skip
    }
  }
  return files;
}

/**
 * Build the brief map from the nexus graph only, never walking the tree, so it
 * is cheap enough for `cleo briefing`.
 *
 * @param projectRoot - the project root.
 * @param budget - character budget (default {@link BRIEF_MAP_DEFAULT_BUDGET}).
 * @returns the report, or `null` when the project has no code index.
 */
export async function buildNexusBriefMap(
  projectRoot: string,
  budget: number = BRIEF_MAP_DEFAULT_BUDGET,
): Promise<BriefMapReport | null> {
  const files = await filesFromNexus(projectRoot);
  if (files.length === 0) return null;
  return { source: 'nexus', budget, ...formatBriefMap(files, budget) };
}

/**
 * Build the brief map for a project: from the nexus graph when indexed, else
 * from a git-tracked regex walk.
 *
 * @param projectRoot - the project root.
 * @param budget - character budget (default {@link BRIEF_MAP_DEFAULT_BUDGET}).
 */
export async function buildBriefMap(
  projectRoot: string,
  budget: number = BRIEF_MAP_DEFAULT_BUDGET,
): Promise<BriefMapReport> {
  return (
    (await buildNexusBriefMap(projectRoot, budget)) ?? {
      source: 'git-walk',
      budget,
      ...formatBriefMap(filesFromGitWalk(projectRoot), budget),
    }
  );
}
