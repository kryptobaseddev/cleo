/**
 * Concerns analyzer — scans for TODO/FIXME comments, large files, and complexity estimates.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ConcernAnalysis } from '../index.js';

const EXCLUDED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage',
  '.cleo', '.next', '.nuxt', '__pycache__', 'target', 'vendor',
]);

const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs',
  '.py', '.rs', '.go', '.rb', '.java', '.php', '.cs',
]);

const TODO_PATTERN = /\b(TODO|FIXME|HACK|XXX)\b[:\s]*(.*)/g;

export function analyzeConcerns(projectRoot: string): ConcernAnalysis {
  const todos: ConcernAnalysis['todos'] = [];
  const largeFiles: ConcernAnalysis['largeFiles'] = [];
  const complexity = { high: 0, medium: 0, low: 0 };

  const srcPath = join(projectRoot, 'src');
  const scanRoot = existsSync(srcPath) ? srcPath : projectRoot;

  walkSourceFiles(scanRoot, projectRoot, (filePath, relPath) => {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      const lineCount = lines.length;

      // Categorize by complexity (line count)
      if (lineCount > 500) {
        complexity.high++;
        largeFiles.push({ path: relPath, lines: lineCount });
      } else if (lineCount > 200) {
        complexity.medium++;
      } else {
        complexity.low++;
      }

      // Scan for TODO/FIXME (limit to first 50 total)
      if (todos.length < 50) {
        lines.forEach((line, idx) => {
          if (todos.length >= 50) return;
          const matches = [...line.matchAll(TODO_PATTERN)];
          for (const match of matches) {
            if (todos.length >= 50) break;
            todos.push({
              file: relPath,
              line: idx + 1,
              text: `${match[1]}: ${match[2].trim()}`.trim(),
            });
          }
        });
      }
    } catch {
      // ignore unreadable files
    }
  });

  // Sort large files by line count descending
  largeFiles.sort((a, b) => b.lines - a.lines);

  return { todos, largeFiles, complexity };
}

function walkSourceFiles(
  dir: string,
  projectRoot: string,
  callback: (filePath: string, relPath: string) => void,
  depth: number = 0,
): void {
  if (depth > 8) return;
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (EXCLUDED_DIRS.has(entry) || entry.startsWith('.')) continue;
      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          walkSourceFiles(fullPath, projectRoot, callback, depth + 1);
        } else {
          const ext = entry.slice(entry.lastIndexOf('.'));
          if (SOURCE_EXTENSIONS.has(ext)) {
            // Skip test files for concern analysis
            if (entry.endsWith('.test.ts') || entry.endsWith('.spec.ts') ||
                entry.endsWith('.test.js') || entry.endsWith('.spec.js')) continue;
            const relPath = fullPath.startsWith(projectRoot)
              ? fullPath.slice(projectRoot.length + 1)
              : fullPath;
            callback(fullPath, relPath);
          }
        }
      } catch {
        // ignore stat errors
      }
    }
  } catch {
    // ignore readdir errors
  }
}
