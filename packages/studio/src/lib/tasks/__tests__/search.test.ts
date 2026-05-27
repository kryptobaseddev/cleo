import { describe, expect, it } from 'vitest';
import { normalizeSearch } from '../search.js';

describe('normalizeSearch', () => {
  it('returns empty for blank string', () => {
    expect(normalizeSearch('')).toEqual({ kind: 'empty' });
  });

  it('returns empty for whitespace-only input', () => {
    expect(normalizeSearch('   ')).toEqual({ kind: 'empty' });
  });

  it('parses uppercase T prefix', () => {
    expect(normalizeSearch('T663')).toEqual({ kind: 'id', id: 'T663' });
  });

  it('parses lowercase t prefix (case-insensitive)', () => {
    expect(normalizeSearch('t663')).toEqual({ kind: 'id', id: 'T663' });
  });

  it('parses bare digits', () => {
    expect(normalizeSearch('663')).toEqual({ kind: 'id', id: 'T663' });
  });

  it('trims surrounding whitespace before matching ID', () => {
    expect(normalizeSearch('  T123  ')).toEqual({ kind: 'id', id: 'T123' });
  });

  it('parses single-digit task ID', () => {
    expect(normalizeSearch('T1')).toEqual({ kind: 'id', id: 'T1' });
  });

  it('parses large numeric ID', () => {
    expect(normalizeSearch('9999')).toEqual({ kind: 'id', id: 'T9999' });
  });

  it('returns title kind for partial word', () => {
    expect(normalizeSearch('council')).toEqual({ kind: 'title', query: 'council' });
  });

  it('returns title kind for multi-word query', () => {
    expect(normalizeSearch('living brain')).toEqual({ kind: 'title', query: 'living brain' });
  });

  it('returns title kind for mixed alpha-numeric that is not a valid ID', () => {
    expect(normalizeSearch('T663a')).toEqual({ kind: 'title', query: 'T663a' });
  });

  it('returns title kind for query with leading T but non-digit suffix', () => {
    expect(normalizeSearch('Tasks')).toEqual({ kind: 'title', query: 'Tasks' });
  });
});
