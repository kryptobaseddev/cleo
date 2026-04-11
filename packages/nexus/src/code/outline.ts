/**
 * smart_outline — file structural skeleton via tree-sitter.
 *
 * Parses a source file and returns all top-level and nested symbols
 * with signatures only (bodies collapsed). This gives agents a ~1-2K
 * token overview of a file vs ~12K for a full Read.
 *
 * @task T151
 * @module code/outline
 */

import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import type { CodeSymbol } from '@cleocode/contracts';
import { parseFile } from './parser.js';
import { detectLanguage } from './tree-sitter-languages.js';

/** A symbol node in the outline tree, with optional children. */
export interface OutlineNode {
  /** Symbol name. */
  name: string;
  /** Symbol kind (function, class, method, etc.). */
  kind: string;
  /** Start line (1-based). */
  startLine: number;
  /** End line (1-based). */
  endLine: number;
  /** Signature line(s) — the declaration without the body. */
  signature: string;
  /** Whether this symbol is exported. */
  exported: boolean;
  /** Nested symbols (methods inside classes, etc.). */
  children: OutlineNode[];
}

/** Result of generating a smart outline for a file. */
export interface SmartOutlineResult {
  /** Source file path (relative). */
  filePath: string;
  /** Detected language. */
  language: string;
  /** Top-level symbol tree. */
  symbols: OutlineNode[];
  /** Estimated token count for this outline. */
  estimatedTokens: number;
  /** Parse errors (non-fatal). */
  errors: string[];
}

/**
 * Extract the signature line(s) from source for a symbol.
 *
 * Reads the opening lines of the symbol declaration up to the first
 * opening brace or colon (for Python). This gives context without
 * the full implementation body.
 */
function extractSignature(
  lines: string[],
  startLine: number,
  endLine: number,
  language: string,
): string {
  const start = Math.max(0, startLine - 1); // 1-based to 0-based
  const end = Math.min(lines.length, endLine);

  // For short symbols (< 3 lines), return the whole thing
  if (end - start <= 3) {
    return lines.slice(start, end).join('\n');
  }

  // Find the signature boundary (opening brace, colon for Python)
  const sigLines: string[] = [];
  for (let i = start; i < end && sigLines.length < 5; i++) {
    const line = lines[i]!;
    sigLines.push(line);

    if (language === 'python') {
      if (line.trimEnd().endsWith(':')) break;
    } else {
      if (line.includes('{')) break;
    }
  }

  const bodyLines = end - start - sigLines.length;
  if (bodyLines > 0) {
    sigLines.push(`  // ... ${bodyLines} lines`);
  }

  return sigLines.join('\n');
}

/**
 * Build a tree from flat symbols by nesting methods inside their parent classes.
 */
function buildTree(symbols: CodeSymbol[], lines: string[], language: string): OutlineNode[] {
  const nodes: OutlineNode[] = [];
  const classNodes = new Map<string, OutlineNode>();

  // First pass: create all nodes
  for (const sym of symbols) {
    const node: OutlineNode = {
      name: sym.name,
      kind: sym.kind,
      startLine: sym.startLine,
      endLine: sym.endLine,
      signature: extractSignature(lines, sym.startLine, sym.endLine, language),
      exported: sym.exported ?? false,
      children: [],
    };

    if (
      sym.kind === 'class' ||
      sym.kind === 'struct' ||
      sym.kind === 'impl' ||
      sym.kind === 'trait'
    ) {
      classNodes.set(sym.name, node);
      nodes.push(node);
    } else if (sym.kind === 'method' && sym.parent) {
      const parent = classNodes.get(sym.parent);
      if (parent) {
        parent.children.push(node);
      } else {
        nodes.push(node);
      }
    } else {
      // Check if this symbol is nested inside a class by line range
      let nested = false;
      for (const [, classNode] of classNodes) {
        if (sym.startLine >= classNode.startLine && sym.endLine <= classNode.endLine) {
          classNode.children.push(node);
          nested = true;
          break;
        }
      }
      if (!nested) nodes.push(node);
    }
  }

  return nodes;
}

/** Estimate token count for an outline (rough: ~4 chars per token). */
function estimateTokens(nodes: OutlineNode[]): number {
  let chars = 0;
  for (const node of nodes) {
    chars += node.signature.length + node.name.length + node.kind.length + 20; // overhead
    chars += estimateTokens(node.children);
  }
  return Math.ceil(chars / 4);
}

/**
 * Generate a smart outline for a source file.
 *
 * Returns a tree of symbols with signatures only (bodies collapsed),
 * suitable for giving agents a quick structural overview.
 *
 * @param filePath - Absolute path to source file
 * @param projectRoot - Project root for relative path computation
 * @returns Smart outline result with symbol tree and token estimate
 */
export function smartOutline(filePath: string, projectRoot?: string): SmartOutlineResult {
  const root = projectRoot ?? process.cwd();
  const relPath = relative(root, filePath);
  const language = detectLanguage(filePath);

  if (!language) {
    return {
      filePath: relPath,
      language: 'unknown',
      symbols: [],
      estimatedTokens: 0,
      errors: ['Unsupported language'],
    };
  }

  // Parse the file for symbols
  const parseResult = parseFile(filePath, root);
  if (parseResult.errors.length > 0 && parseResult.symbols.length === 0) {
    return {
      filePath: relPath,
      language,
      symbols: [],
      estimatedTokens: 0,
      errors: parseResult.errors,
    };
  }

  // Read source lines for signature extraction
  let lines: string[];
  try {
    lines = readFileSync(filePath, 'utf-8').split('\n');
  } catch (err) {
    return {
      filePath: relPath,
      language,
      symbols: [],
      estimatedTokens: 0,
      errors: [`Failed to read file: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  // Build symbol tree with signatures
  const tree = buildTree(parseResult.symbols, lines, language);
  const estimatedTokens = estimateTokens(tree);

  return {
    filePath: relPath,
    language,
    symbols: tree,
    estimatedTokens,
    errors: parseResult.errors,
  };
}
