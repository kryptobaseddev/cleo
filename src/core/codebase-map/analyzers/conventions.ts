/**
 * Convention analyzer — detects linting, formatting, error handling patterns, and code conventions.
 * Extends projectContext.conventions with tool-level details.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectContext } from '../../../store/project-detect.js';
import type { ConventionAnalysis } from '../index.js';

export function analyzeConventions(
  projectRoot: string,
  projectContext: ProjectContext,
): ConventionAnalysis {
  const conventions: ConventionAnalysis = {
    fileNaming: projectContext.conventions?.fileNaming ?? 'unknown',
    importStyle: projectContext.conventions?.importStyle ?? 'unknown',
  };

  if (projectContext.conventions?.typeSystem) {
    conventions.typeSystem = projectContext.conventions.typeSystem;
  }

  conventions.linter = detectLinter(projectRoot);
  conventions.formatter = detectFormatter(projectRoot);
  conventions.errorHandling = detectErrorHandling(projectRoot);

  return conventions;
}

function detectLinter(projectRoot: string): string | undefined {
  if (existsSync(join(projectRoot, 'biome.json')) || existsSync(join(projectRoot, 'biome.jsonc'))) {
    return 'biome';
  }
  if (
    existsSync(join(projectRoot, '.eslintrc')) ||
    existsSync(join(projectRoot, '.eslintrc.js')) ||
    existsSync(join(projectRoot, '.eslintrc.ts')) ||
    existsSync(join(projectRoot, '.eslintrc.json')) ||
    existsSync(join(projectRoot, '.eslintrc.yml')) ||
    existsSync(join(projectRoot, '.eslintrc.yaml')) ||
    existsSync(join(projectRoot, 'eslint.config.js')) ||
    existsSync(join(projectRoot, 'eslint.config.ts')) ||
    existsSync(join(projectRoot, 'eslint.config.mjs'))
  ) {
    return 'eslint';
  }
  if (
    existsSync(join(projectRoot, '.oxlintrc.json')) ||
    existsSync(join(projectRoot, 'oxlint.json'))
  ) {
    return 'oxlint';
  }
  try {
    const content = readFileSync(join(projectRoot, 'pyproject.toml'), 'utf-8');
    if (content.includes('[tool.ruff]')) return 'ruff';
    if (content.includes('[tool.flake8]')) return 'flake8';
    if (content.includes('[tool.pylint]')) return 'pylint';
  } catch {
    // ignore
  }
  if (existsSync(join(projectRoot, '.rubocop.yml'))) return 'rubocop';
  return undefined;
}

function detectFormatter(projectRoot: string): string | undefined {
  if (existsSync(join(projectRoot, 'biome.json')) || existsSync(join(projectRoot, 'biome.jsonc'))) {
    return 'biome';
  }
  if (
    existsSync(join(projectRoot, '.prettierrc')) ||
    existsSync(join(projectRoot, '.prettierrc.js')) ||
    existsSync(join(projectRoot, '.prettierrc.json')) ||
    existsSync(join(projectRoot, '.prettierrc.yml')) ||
    existsSync(join(projectRoot, '.prettierrc.yaml')) ||
    existsSync(join(projectRoot, 'prettier.config.js')) ||
    existsSync(join(projectRoot, 'prettier.config.ts')) ||
    existsSync(join(projectRoot, 'prettier.config.mjs'))
  ) {
    return 'prettier';
  }
  try {
    const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf-8')) as Record<
      string,
      unknown
    >;
    if (pkg.prettier) return 'prettier';
  } catch {
    // ignore
  }
  return undefined;
}

function detectErrorHandling(projectRoot: string): string | undefined {
  const srcPath = join(projectRoot, 'src');
  if (!existsSync(srcPath)) return undefined;

  let tryCatchCount = 0;
  let resultTypeCount = 0;
  let throwCount = 0;
  let filesChecked = 0;

  const sampleFiles = collectSampleFiles(srcPath, 10);
  for (const filePath of sampleFiles) {
    try {
      const content = readFileSync(filePath, 'utf-8');
      filesChecked++;
      tryCatchCount += (content.match(/try\s*{/g) ?? []).length;
      resultTypeCount += (content.match(/Result<|Either<|neverthrow|Ok\(|Err\(/g) ?? []).length;
      throwCount += (content.match(/throw\s+new\s+\w+Error/g) ?? []).length;
    } catch {
      // ignore
    }
  }

  if (filesChecked === 0) return undefined;
  if (resultTypeCount > tryCatchCount) return 'Result type';
  if (tryCatchCount > 0) return 'try/catch';
  if (throwCount > 0) return 'throw/catch';
  return undefined;
}

function collectSampleFiles(dir: string, limit: number): string[] {
  const files: string[] = [];
  const EXCLUDED = new Set(['node_modules', '.git', 'dist', 'build', '__tests__']);

  function walk(current: string): void {
    if (files.length >= limit) return;
    try {
      const entries = readdirSync(current);
      for (const entry of entries) {
        if (files.length >= limit) return;
        if (EXCLUDED.has(entry)) continue;
        const fullPath = join(current, entry);
        if (entry.endsWith('.ts') || entry.endsWith('.js')) {
          if (
            !entry.endsWith('.test.ts') &&
            !entry.endsWith('.test.js') &&
            !entry.endsWith('.spec.ts')
          ) {
            files.push(fullPath);
          }
        } else {
          try {
            if (statSync(fullPath).isDirectory()) walk(fullPath);
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }
  }

  walk(dir);
  return files;
}
