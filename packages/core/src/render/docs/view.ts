/**
 * Docs view renderer — renders doc content for terminal display.
 *
 * Converts markdown to ANSI-formatted terminal output with:
 *   - H1-H3 headings (bold, underlined via dim separators)
 *   - Bold (**bold**) and italic (_italic_)
 *   - Inline code (`code`) with dim background feel
 *   - Fenced code blocks (```) with dim border
 *   - Bullet lists (-, *, +) with indent
 *   - Numbered lists (1., 2.) with indent
 *   - Block quotes (> ) with dim prefix
 *   - Horizontal rules (---, ***) as full-width separators
 *   - Links rendered as [text](url) — url in dim
 *
 * Honors `NO_COLOR` and `FORCE_COLOR` env vars.
 * Width-aware: wraps text at specified or detected terminal width.
 *
 * @task T11184
 * @epic T10519
 * @saga T10516
 */

import { BOLD, DIM, NC } from '../ansi.js';
import { terminalWidth } from '../helpers.js';

// ---------------------------------------------------------------------------
// ANSI styling helpers
// ---------------------------------------------------------------------------

/** Whether ANSI color escape codes should be emitted. */
const colorsEnabled: boolean = (() => {
  if (process.env['NO_COLOR'] !== undefined) return false;
  if (process.env['FORCE_COLOR'] !== undefined) return true;
  return process.stdout.isTTY === true;
})();

function ansi(code: string): string {
  return colorsEnabled ? code : '';
}

const ITALIC = ansi('\x1b[3m');
const UNDERLINE = ansi('\x1b[4m');
const CODE_DIM = ansi('\x1b[2m\x1b[7m');
const QUOTE_DIM = ansi('\x1b[2m');

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DocsViewOptions {
  /** Terminal width in columns (default: detected). */
  width?: number;
  /** Override color behavior. */
  color?: 'auto' | 'always' | 'never';
}

/**
 * Render markdown content for terminal display.
 */
export function renderDocsView(
  content: string,
  metadata?: { slug?: string; type?: string; title?: string; sha256?: string },
  opts: DocsViewOptions = {},
): string {
  const width = opts.width ?? terminalWidth();
  const lines = content.split('\n');

  let useColor = colorsEnabled;
  if (opts.color === 'always') useColor = true;
  if (opts.color === 'never') useColor = false;

  const B = useColor ? BOLD : '';
  const D = useColor ? DIM : '';
  const N = useColor ? NC : '';
  const I = useColor ? ITALIC : '';
  const U = useColor ? UNDERLINE : '';
  const CD = useColor ? CODE_DIM : '';
  const QD = useColor ? QUOTE_DIM : '';

  const output: string[] = [];

  if (metadata) {
    if (metadata.title) {
      output.push(`${B}${metadata.title}${N}`);
      output.push(D + '─'.repeat(Math.min(width, 80)) + N);
    }
    const chips: string[] = [];
    if (metadata.slug) chips.push(`${D}slug:${N} ${metadata.slug}`);
    if (metadata.type) chips.push(`${D}type:${N} ${metadata.type}`);
    if (metadata.sha256) chips.push(`${D}sha:${N} ${metadata.sha256.slice(0, 12)}`);
    if (chips.length > 0) {
      output.push(chips.join('  '));
      output.push('');
    }
  }

  let i = 0;
  let inCodeBlock = false;
  let codeBlockLines: string[] = [];

  while (i < lines.length) {
    const rawLine = lines[i] ?? '';

    if (rawLine.startsWith('```')) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeBlockLines = [];
        i++;
        continue;
      } else {
        inCodeBlock = false;
        output.push(renderCodeBlock(codeBlockLines, width, D, N, CD));
        codeBlockLines = [];
        i++;
        continue;
      }
    }

    if (inCodeBlock) {
      codeBlockLines.push(rawLine);
      i++;
      continue;
    }

    if (rawLine.trim() === '') {
      const prev = output.length > 0 ? (output[output.length - 1] ?? '') : '';
      if (prev !== '') output.push('');
      i++;
      continue;
    }

    if (/^(---|\*\*\*|___)\s*$/.test(rawLine)) {
      output.push(D + '─'.repeat(Math.min(width, 80)) + N);
      i++;
      continue;
    }

    const h1Match = rawLine.match(/^# (.+)$/);
    if (h1Match) {
      const text = h1Match[1] ?? '';
      output.push('');
      output.push(`${B}${U}${text}${N}`);
      output.push(D + '─'.repeat(Math.min(visibleLen(text, useColor), width)) + N);
      output.push('');
      i++;
      continue;
    }

    const h2Match = rawLine.match(/^## (.+)$/);
    if (h2Match) {
      const text = h2Match[1] ?? '';
      output.push('');
      output.push(`${B}${text}${N}`);
      output.push(D + '─'.repeat(Math.min(visibleLen(text, useColor), width)) + N);
      i++;
      continue;
    }

    const h3Match = rawLine.match(/^### (.+)$/);
    if (h3Match) {
      output.push(`${B}${h3Match[1] ?? ''}${N}`);
      i++;
      continue;
    }

    if (rawLine.startsWith('>')) {
      const content = rawLine.replace(/^>\s?/, '');
      output.push(`${QD}│${N} ${I}${renderInline(content, B, D, N, I, CD, useColor)}${N}`);
      i++;
      continue;
    }

    const bulletMatch = rawLine.match(/^(\s*)[-*+]\s+(.+)$/);
    if (bulletMatch) {
      const indent = (bulletMatch[1] ?? '').length;
      const text = bulletMatch[2] ?? '';
      const pad = '  '.repeat(indent > 0 ? 1 : 0);
      output.push(`${pad}${D}•${N} ${renderInline(text, B, D, N, I, CD, useColor)}`);
      i++;
      continue;
    }

    const numMatch = rawLine.match(/^(\s*)\d+\.\s+(.+)$/);
    if (numMatch) {
      const indent = (numMatch[1] ?? '').length;
      const text = numMatch[2] ?? '';
      const pad = '  '.repeat(indent > 0 ? 1 : 0);
      output.push(`${pad}${D}•${N} ${renderInline(text, B, D, N, I, CD, useColor)}`);
      i++;
      continue;
    }

    const wrapped = wrapText(renderInline(rawLine, B, D, N, I, CD, useColor), width, useColor);
    output.push(wrapped);
    i++;
  }

  if (inCodeBlock && codeBlockLines.length > 0) {
    output.push(renderCodeBlock(codeBlockLines, width, D, N, CD));
  }

  return output.join('\n');
}

function renderInline(
  text: string,
  B: string,
  D: string,
  N: string,
  I: string,
  CD: string,
  useColor: boolean,
): string {
  let result = text;
  result = result.replace(/`([^`]+)`/g, (_, code: string) => `${CD} ${code} ${N}`);
  result = result.replace(/\*\*\*(.+?)\*\*\*/g, (_, t: string) => `${B}${I}${t}${N}`);
  result = result.replace(/\*\*(.+?)\*\*/g, (_, t: string) => `${B}${t}${N}`);
  result = result.replace(/(?<!\w)\*(.+?)\*(?!\w)/g, (_, t: string) => `${I}${t}${N}`);
  result = result.replace(/(?<!\w)_(.+?)_(?!\w)/g, (_, t: string) => `${I}${t}${N}`);
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t: string, u: string) => {
    return `${t} ${D}(${u})${N}`;
  });
  return result;
}

function renderCodeBlock(
  lines: string[],
  width: number,
  D: string,
  N: string,
  CD: string,
): string {
  if (lines.length === 0) return '';
  const border = D + '┌' + '─'.repeat(Math.min(width - 2, 78)) + '┐' + N;
  const bottom = D + '└' + '─'.repeat(Math.min(width - 2, 78)) + '┘' + N;
  const content = lines.map((l) => `${D}│${N} ${CD}${l}${N}`).join('\n');
  return `${border}\n${content}\n${bottom}`;
}

function wrapText(text: string, width: number, _useColor: boolean): string {
  if (visibleLen(text, false) <= width) return text;
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const testLine = current ? `${current} ${word}` : word;
    if (visibleLen(testLine, false) <= width) {
      current = testLine;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.join('\n');
}

function visibleLen(s: string, _useColor: boolean): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}
