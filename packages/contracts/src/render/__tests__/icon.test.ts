import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ascii, BadgeIcon, KindIcon, pickIcon, RelationIcon, StatusIcon } from '../icon.js';

describe('icon enums', () => {
  it('StatusIcon emoji values match ADR-077', () => {
    expect(StatusIcon.PENDING).toBe('⏳');
    expect(StatusIcon.ACTIVE).toBe('🚧');
    expect(StatusIcon.DONE).toBe('✅');
    expect(StatusIcon.BLOCKED).toBe('🚪');
    expect(StatusIcon.ARCHIVED).toBe('🗄');
    expect(StatusIcon.CANCELLED).toBe('✗');
  });

  it('KindIcon emoji values match ADR-077', () => {
    expect(KindIcon.SAGA).toBe('🌲');
    expect(KindIcon.EPIC).toBe('📋');
    expect(KindIcon.TASK).toBe('•');
    expect(KindIcon.SUBTASK).toBe('◦');
    expect(KindIcon.RESEARCH).toBe('📖');
    expect(KindIcon.BUG).toBe('🐛');
    expect(KindIcon.RELEASE).toBe('🚀');
  });

  it('BadgeIcon emoji values match ADR-077 (ORPHAN amended in T10137)', () => {
    expect(BadgeIcon.EMPTY).toBe('🪦');
    // ADR-077 §2 originally specified '🚪' for ORPHAN — identical to
    // StatusIcon.BLOCKED. String enums share runtime values so ascii() cannot
    // disambiguate. Amended to '👻' (abandoned/lonely). T10137 (B12) updates
    // the ADR text to match.
    expect(BadgeIcon.ORPHAN).toBe('👻');
    expect(BadgeIcon.NESTED).toBe('🔁');
    expect(BadgeIcon.CAUTION).toBe('⚠');
    expect(BadgeIcon.NEW).toBe('★');
  });

  it('RelationIcon emoji values match ADR-077', () => {
    expect(RelationIcon.GROUPS).toBe('⊂');
    expect(RelationIcon.PARENT).toBe('⤴');
    expect(RelationIcon.DEPENDS).toBe('⇨');
    expect(RelationIcon.BLOCKS).toBe('⊘');
  });

  it('no two enum members share the same runtime string value', () => {
    const all = [
      ...Object.values(StatusIcon),
      ...Object.values(KindIcon),
      ...Object.values(BadgeIcon),
      ...Object.values(RelationIcon),
    ];
    const unique = new Set(all);
    expect(unique.size).toBe(all.length);
  });
});

describe('ascii()', () => {
  it('returns NO_COLOR fallback for every StatusIcon', () => {
    expect(ascii(StatusIcon.PENDING)).toBe('[ ]');
    expect(ascii(StatusIcon.ACTIVE)).toBe('[~]');
    expect(ascii(StatusIcon.DONE)).toBe('[x]');
    expect(ascii(StatusIcon.BLOCKED)).toBe('[!]');
    expect(ascii(StatusIcon.ARCHIVED)).toBe('[#]');
    expect(ascii(StatusIcon.CANCELLED)).toBe('[-]');
  });

  it('returns NO_COLOR fallback for every KindIcon', () => {
    expect(ascii(KindIcon.SAGA)).toBe('SG');
    expect(ascii(KindIcon.EPIC)).toBe('E');
    expect(ascii(KindIcon.TASK)).toBe('-');
    expect(ascii(KindIcon.SUBTASK)).toBe('.');
    expect(ascii(KindIcon.RESEARCH)).toBe('R');
    expect(ascii(KindIcon.BUG)).toBe('B');
    expect(ascii(KindIcon.RELEASE)).toBe('>');
  });

  it('returns NO_COLOR fallback for every BadgeIcon', () => {
    expect(ascii(BadgeIcon.EMPTY)).toBe('(empty)');
    expect(ascii(BadgeIcon.ORPHAN)).toBe('(orphan)');
    expect(ascii(BadgeIcon.NESTED)).toBe('(nested)');
    expect(ascii(BadgeIcon.CAUTION)).toBe('(!)');
    expect(ascii(BadgeIcon.NEW)).toBe('(new)');
  });

  it('returns NO_COLOR fallback for every RelationIcon', () => {
    expect(ascii(RelationIcon.GROUPS)).toBe('in');
    expect(ascii(RelationIcon.PARENT)).toBe('^');
    expect(ascii(RelationIcon.DEPENDS)).toBe('->');
    expect(ascii(RelationIcon.BLOCKS)).toBe('!>');
  });
});

describe('pickIcon()', () => {
  const originalNoColor = process.env['NO_COLOR'];
  const originalTerm = process.env['TERM'];

  beforeEach(() => {
    delete process.env['NO_COLOR'];
    delete process.env['TERM'];
  });

  afterEach(() => {
    if (originalNoColor === undefined) {
      delete process.env['NO_COLOR'];
    } else {
      process.env['NO_COLOR'] = originalNoColor;
    }
    if (originalTerm === undefined) {
      delete process.env['TERM'];
    } else {
      process.env['TERM'] = originalTerm;
    }
  });

  it('returns the emoji when noColor is explicitly false', () => {
    expect(pickIcon(KindIcon.SAGA, { noColor: false })).toBe('🌲');
    expect(pickIcon(StatusIcon.DONE, { noColor: false })).toBe('✅');
  });

  it('returns the ASCII form when noColor is explicitly true', () => {
    expect(pickIcon(KindIcon.SAGA, { noColor: true })).toBe('SG');
    expect(pickIcon(StatusIcon.DONE, { noColor: true })).toBe('[x]');
  });

  it('falls back to NO_COLOR=1 from process.env', () => {
    process.env['NO_COLOR'] = '1';
    expect(pickIcon(KindIcon.EPIC)).toBe('E');
    expect(pickIcon(BadgeIcon.ORPHAN)).toBe('(orphan)');
  });

  it('falls back to TERM=dumb from process.env', () => {
    process.env['TERM'] = 'dumb';
    expect(pickIcon(RelationIcon.GROUPS)).toBe('in');
  });

  it('returns the emoji when no NO_COLOR signals are present', () => {
    expect(pickIcon(KindIcon.TASK)).toBe('•');
    expect(pickIcon(StatusIcon.ACTIVE)).toBe('🚧');
  });
});
