import { describe, it, expect } from 'vitest';
import { resolveFlags } from '../src/flagResolver.js';
import { LAFSFlagError } from '../src/flagSemantics.js';

describe('resolveFlags — unified cross-layer resolution', () => {
  it('returns json format with no field extraction when no flags set', () => {
    const res = resolveFlags({});
    expect(res.format.format).toBe('json');
    expect(res.fields.field).toBeUndefined();
    expect(res.fields.fields).toBeUndefined();
    expect(res.warnings).toHaveLength(0);
  });

  it('resolves --human without field flags', () => {
    const res = resolveFlags({ human: true });
    expect(res.format.format).toBe('human');
    expect(res.warnings).toHaveLength(0);
  });

  it('resolves --json without field flags', () => {
    const res = resolveFlags({ json: true });
    expect(res.format.format).toBe('json');
    expect(res.warnings).toHaveLength(0);
  });

  it('resolves --field alone (json format)', () => {
    const res = resolveFlags({ field: 'title' });
    expect(res.format.format).toBe('json');
    expect(res.fields.field).toBe('title');
    expect(res.warnings).toHaveLength(0);
  });

  it('resolves --fields alone (json format)', () => {
    const res = resolveFlags({ fields: 'id,title' });
    expect(res.format.format).toBe('json');
    expect(res.fields.fields).toEqual(['id', 'title']);
    expect(res.warnings).toHaveLength(0);
  });

  it('--human + --field → both resolved, warning emitted', () => {
    const res = resolveFlags({ human: true, field: 'ready' });
    expect(res.format.format).toBe('human');
    expect(res.fields.field).toBe('ready');
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain('--human + --field');
    expect(res.warnings[0]).toContain('§5.4.1');
  });

  it('--human + --fields → both resolved, warning emitted', () => {
    const res = resolveFlags({ human: true, fields: ['id', 'title'] });
    expect(res.format.format).toBe('human');
    expect(res.fields.fields).toEqual(['id', 'title']);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain('--human + --fields');
  });

  it('--json + --field → valid, no warning', () => {
    const res = resolveFlags({ json: true, field: 'status' });
    expect(res.format.format).toBe('json');
    expect(res.fields.field).toBe('status');
    expect(res.warnings).toHaveLength(0);
  });

  it('--json + --fields → valid, no warning', () => {
    const res = resolveFlags({ json: true, fields: 'id,title' });
    expect(res.format.format).toBe('json');
    expect(res.fields.fields).toEqual(['id', 'title']);
    expect(res.warnings).toHaveLength(0);
  });

  it('--quiet + --field → valid, no warning', () => {
    const res = resolveFlags({ quiet: true, field: 'id' });
    expect(res.format.format).toBe('json');
    expect(res.format.quiet).toBe(true);
    expect(res.fields.field).toBe('id');
    expect(res.warnings).toHaveLength(0);
  });

  it('--human + --json → E_FORMAT_CONFLICT', () => {
    expect(() => resolveFlags({ human: true, json: true })).toThrow(LAFSFlagError);
  });

  it('--human + --json + --field → E_FORMAT_CONFLICT (format wins)', () => {
    expect(() => resolveFlags({ human: true, json: true, field: 'x' })).toThrow(LAFSFlagError);
  });

  it('--field + --fields → E_FIELD_CONFLICT', () => {
    expect(() => resolveFlags({ field: 'x', fields: ['y'] })).toThrow(LAFSFlagError);
  });

  it('--human + --mvi → no warning (§5.4.3)', () => {
    const res = resolveFlags({ human: true, mvi: 'minimal' });
    expect(res.format.format).toBe('human');
    expect(res.fields.mvi).toBe('minimal');
    expect(res.warnings).toHaveLength(0);
  });

  it('--field with --mvi → field + mvi both resolved', () => {
    const res = resolveFlags({ field: 'ready', mvi: 'minimal' });
    expect(res.fields.field).toBe('ready');
    expect(res.fields.mvi).toBe('minimal');
  });
});
