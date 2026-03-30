/**
 * smart_unfold — single symbol extraction from source files.
 *
 * Takes a file path + symbol name, parses the file via tree-sitter,
 * finds the matching symbol node, and extracts complete source including
 * JSDoc/docstring, decorators, and full body. AST node boundaries
 * guarantee no truncation.
 *
 * @task T153
 */

import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import type { CodeSymbol } from '@cleocode/contracts';
import { detectLanguage } from '../lib/tree-sitter-languages.js';
import { parseFile } from './parser.js';

/** Result of unfolding a single symbol. */
export interface SmartUnfoldResult {
  /** Whether the symbol was found. */
  found: boolean;
  /** The matched symbol metadata. */
  symbol?: CodeSymbol;
  /** Complete source text including JSDoc, decorators, and body. */
  source: string;
  /** Start line (1-based, inclusive of leading doc comment). */
  startLine: number;
  /** End line (1-based). */
  endLine: number;
  /** Estimated token count for this extraction. */
  estimatedTokens: number;
  /** File path (relative). */
  filePath: string;
  /** Errors encountered. */
  errors: string[];
}

/**
 * Find leading documentation comment (JSDoc, docstring, Rust doc) above a symbol.
 *
 * Scans backwards from the symbol's start line to find attached doc comments.
 */
function findLeadingDocStart(lines: string[], symbolStartLine: number, language: string): number {
  const idx = symbolStartLine - 1; // 1-based to 0-based
  if (idx <= 0) return symbolStartLine;

  let docStart = idx;

  if (language === 'python') {
    // Python: look for decorator lines above
    let i = idx - 1;
    while (i >= 0 && lines[i]!.trimStart().startsWith('@')) {
      docStart = i + 1; // back to 1-based
      i--;
    }
    return docStart;
  }

  // C-family / Rust / JS/TS: look for block comments (/** ... */) or /// lines
  let i = idx - 1;

  // Skip blank lines immediately above
  while (i >= 0 && lines[i]!.trim() === '') i--;

  if (i < 0) return symbolStartLine;

  const line = lines[i]!.trimStart();

  // Block comment ending: */
  if (line.endsWith('*/')) {
    // Walk backwards to find opening /**
    while (i >= 0) {
      if (lines[i]!.trimStart().startsWith('/**') || lines[i]!.trimStart().startsWith('/*')) {
        docStart = i + 1; // 1-based
        break;
      }
      i--;
    }
  }
  // Line comments: /// (Rust) or // (TS/JS decorators less common)
  else if (line.startsWith('///') || line.startsWith('//!')) {
    while (i >= 0 && (lines[i]!.trimStart().startsWith('///') || lines[i]!.trimStart().startsWith('//!'))) {
      docStart = i + 1;
      i--;
    }
  }

  // Also capture decorators (TS/Java) above the doc comment
  i = docStart - 2; // 0-based, line above current docStart
  while (i >= 0 && lines[i]!.trimStart().startsWith('@')) {
    docStart = i + 1;
    i--;
  }

  return docStart;
}

/**
 * Extract a symbol's complete source from a file.
 *
 * Finds the symbol by name (supports "Class.method" dot notation),
 * determines its full range including leading documentation, and
 * returns the exact source text.
 *
 * @param filePath - Absolute path to source file
 * @param symbolName - Symbol to extract (e.g. "parseFile" or "HttpTransport.connect")
 * @param projectRoot - Project root for relative path computation
 * @returns Unfold result with complete source text
 */
export function smartUnfold(
  filePath: string,
  symbolName: string,
  projectRoot?: string,
): SmartUnfoldResult {
  const root = projectRoot ?? process.cwd();
  const relPath = relative(root, filePath);
  const language = detectLanguage(filePath);

  const empty: SmartUnfoldResult = {
    found: false,
    source: '',
    startLine: 0,
    endLine: 0,
    estimatedTokens: 0,
    filePath: relPath,
    errors: [],
  };

  if (!language) {
    return { ...empty, errors: ['Unsupported language'] };
  }

  // Parse the file
  const parseResult = parseFile(filePath, root);
  if (parseResult.symbols.length === 0) {
    return { ...empty, errors: parseResult.errors.length > 0 ? parseResult.errors : ['No symbols found'] };
  }

  // Find the matching symbol
  const parts = symbolName.split('.');
  let match: CodeSymbol | undefined;

  if (parts.length === 2) {
    // Nested: "Class.method" — find method with matching parent range
    const [parentName, childName] = parts;
    const parent = parseResult.symbols.find(
      (s) => s.name === parentName && (s.kind === 'class' || s.kind === 'struct' || s.kind === 'impl'),
    );
    if (parent) {
      match = parseResult.symbols.find(
        (s) =>
          s.name === childName &&
          s.startLine >= parent.startLine &&
          s.endLine <= parent.endLine,
      );
    }
  } else {
    // Top-level: exact name match, prefer non-method over method
    match = parseResult.symbols.find((s) => s.name === symbolName && s.kind !== 'method');
    if (!match) {
      match = parseResult.symbols.find((s) => s.name === symbolName);
    }
  }

  if (!match) {
    return { ...empty, errors: [`Symbol "${symbolName}" not found in ${relPath}`] };
  }

  // Read source lines
  let lines: string[];
  try {
    lines = readFileSync(filePath, 'utf-8').split('\n');
  } catch (err) {
    return { ...empty, errors: [`Failed to read file: ${err instanceof Error ? err.message : String(err)}`] };
  }

  // Determine full range including doc comment
  const docStart = findLeadingDocStart(lines, match.startLine, language);
  const startLine = Math.min(docStart, match.startLine);
  const endLine = match.endLine;

  // Extract source text
  const source = lines.slice(startLine - 1, endLine).join('\n');
  const estimatedTokens = Math.ceil(source.length / 4);

  return {
    found: true,
    symbol: match,
    source,
    startLine,
    endLine,
    estimatedTokens,
    filePath: relPath,
    errors: [],
  };
}
