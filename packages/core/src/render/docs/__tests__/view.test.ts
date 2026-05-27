/**
 * Unit tests for renderDocsView — markdown-to-terminal rendering.
 *
 * @task T11184
 */

import { describe, expect, it } from 'vitest';
import { renderDocsView } from '../view.js';

describe('renderDocsView', () => {
  it('renders plain text unchanged', () => {
    const result = renderDocsView('hello world', undefined, { color: 'never' });
    expect(result).toContain('hello world');
  });

  it('renders H1 headings with underline', () => {
    const result = renderDocsView('# My Title', undefined, { color: 'never' });
    expect(result).toContain('My Title');
    expect(result).toContain('───');
  });

  it('renders H2 headings', () => {
    const result = renderDocsView('## Section', undefined, { color: 'never' });
    expect(result).toContain('Section');
  });

  it('renders H3 headings', () => {
    const result = renderDocsView('### Subsection', undefined, { color: 'never' });
    expect(result).toContain('Subsection');
  });

  it('renders bold text', () => {
    const result = renderDocsView('hello **world** today', undefined, { color: 'never' });
    expect(result).not.toContain('**world**');
    expect(result).toContain('world');
  });

  it('renders italic text', () => {
    const result = renderDocsView('hello *world* today', undefined, { color: 'never' });
    expect(result).not.toContain('*world*');
    expect(result).toContain('world');
  });

  it('renders inline code', () => {
    const result = renderDocsView('use `createDocs()` function', undefined, { color: 'never' });
    expect(result).not.toContain('`createDocs()`');
    expect(result).toContain('createDocs()');
  });

  it('renders fenced code blocks', () => {
    const input = '```ts\nconst x = 1;\nconsole.log(x);\n```';
    const result = renderDocsView(input, undefined, { color: 'never' });
    expect(result).toContain('const x = 1');
    expect(result).toContain('console.log(x)');
    expect(result).not.toContain('```');
  });

  it('renders bullet lists', () => {
    const input = '- item one\n- item two\n- item three';
    const result = renderDocsView(input, undefined, { color: 'never' });
    expect(result).toContain('item one');
    expect(result).toContain('item two');
    expect(result).toContain('item three');
  });

  it('renders numbered lists', () => {
    const input = '1. first\n2. second\n3. third';
    const result = renderDocsView(input, undefined, { color: 'never' });
    expect(result).toContain('first');
    expect(result).toContain('second');
    expect(result).toContain('third');
  });

  it('renders block quotes', () => {
    const input = '> This is a quote';
    const result = renderDocsView(input, undefined, { color: 'never' });
    expect(result).toContain('This is a quote');
    expect(result).not.toContain('> ');
  });

  it('renders horizontal rules', () => {
    const result = renderDocsView('---', undefined, { color: 'never' });
    expect(result).toContain('───');
  });

  it('renders links with URL', () => {
    const result = renderDocsView('[click here](https://example.com)', undefined, { color: 'never' });
    expect(result).toContain('click here');
    expect(result).toContain('https://example.com');
  });

  it('displays metadata header when provided', () => {
    const result = renderDocsView(
      '# Content',
      { slug: 'my-doc', type: 'adr', title: 'My ADR', sha256: 'abcdef1234567890abcdef1234567890abcdef12' },
      { color: 'never' },
    );
    expect(result).toContain('My ADR');
    expect(result).toContain('my-doc');
    expect(result).toContain('adr');
    expect(result).toContain('abcdef123456');
  });

  it('handles empty content', () => {
    const result = renderDocsView('', undefined, { color: 'never' });
    expect(result).toBe('');
  });

  it('handles multi-paragraph content', () => {
    const input = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.';
    const result = renderDocsView(input, undefined, { color: 'never' });
    expect(result).toContain('First paragraph');
    expect(result).toContain('Second paragraph');
    expect(result).toContain('Third paragraph');
  });

  it('honors width option for wrapping', () => {
    const longText = 'This is a very long line that should be wrapped at the specified width';
    const result = renderDocsView(longText, undefined, { color: 'never', width: 20 });
    const lines = result.split('\n');
    for (const line of lines) {
      if (line.length > 0 && !line.includes('─')) {
        expect(line.length).toBeLessThanOrEqual(22);
      }
    }
  });

  it('strips markdown syntax when color is off', () => {
    const input = '# Title\n\n**bold** and *italic* and `code`';
    const result = renderDocsView(input, undefined, { color: 'never' });
    expect(result).not.toContain('# ');
    expect(result).not.toContain('**');
    expect(result).not.toContain('`');
  });

  it('handles content with no trailing newline', () => {
    const result = renderDocsView('single line', undefined, { color: 'never' });
    expect(result).toBe('single line');
  });
});
