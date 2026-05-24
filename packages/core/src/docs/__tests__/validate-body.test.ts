/**
 * Unit tests for {@link validateDocBody} — body-schema validation per DocKind.
 *
 * Covers the matrix declared in T10160 acceptance:
 *   - all required H2 sections present → ok
 *   - missing sections → reported by canonical name
 *   - case-insensitive matching
 *   - hyphen / space tolerance
 *   - kinds with no `requiredSections` (e.g. `note`) → always ok
 *   - unknown kinds → ok (advisory, additive)
 *   - registry override for project extensions
 *
 * @task T10160 (E12.C3 · absorbs T10154)
 * @epic T10157
 * @saga T9855
 */

import { DocKindRegistry } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { validateDocBody } from '../validate-body.js';

describe('validateDocBody', () => {
  it('passes when every required H2 section is present (ADR)', () => {
    const body = [
      '# adr-001-foo',
      '',
      '## Status',
      'Accepted',
      '',
      '## Date',
      '2026-05-24',
      '',
      '## Context',
      'why',
      '',
      '## Decision',
      'do it',
      '',
      '## Consequences',
      'plus and minus',
    ].join('\n');

    const r = validateDocBody('adr', body);

    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it("reports a missing 'Decision' section for an ADR", () => {
    const body = [
      '## Status',
      'Accepted',
      '',
      '## Date',
      '2026-05-24',
      '',
      '## Context',
      'why',
      '',
      '## Consequences',
      'plus and minus',
    ].join('\n');

    const r = validateDocBody('adr', body);

    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['Decision']);
  });

  it('reports multiple missing sections in declaration order', () => {
    const body = '## Status\nA\n\n## Decision\nDo it';

    const r = validateDocBody('adr', body);

    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['Date', 'Context', 'Consequences']);
  });

  it('matches H2 headers case-insensitively (## decision === Decision)', () => {
    const body = [
      '## status',
      'A',
      '## date',
      '2026-05-24',
      '## context',
      'why',
      '## decision',
      'do it',
      '## consequences',
      'plus and minus',
    ].join('\n');

    expect(validateDocBody('adr', body).ok).toBe(true);
  });

  it('treats hyphens and spaces as interchangeable (## Next Steps === Next-Steps)', () => {
    const body = ['## Context', 'c', '## State', 's', '## Next Steps', 'n'].join('\n');

    const r = validateDocBody('handoff', body);

    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it('tolerates trailing punctuation in headers (## Decision:)', () => {
    const body = [
      '## Status:',
      'A',
      '## Date.',
      'd',
      '## Context',
      'c',
      '## Decision:',
      'd',
      '## Consequences',
      'p',
    ].join('\n');

    expect(validateDocBody('adr', body).ok).toBe(true);
  });

  it('ignores H1 and H3 headers — only H2 (##) counts', () => {
    const body = [
      '# Decision',
      'looks like a section but it is H1',
      '### Decision',
      'looks like a section but it is H3',
      '## Status',
      'A',
      '## Date',
      'd',
      '## Context',
      'c',
      '## Consequences',
      'p',
    ].join('\n');

    const r = validateDocBody('adr', body);

    expect(r.ok).toBe(false);
    expect(r.missing).toContain('Decision');
  });

  it('returns ok for a kind declared with no requiredSections (note)', () => {
    const r = validateDocBody('note', 'free-form observation prose');

    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it('returns ok for an unknown kind (advisory — no rules)', () => {
    const r = validateDocBody('not-a-real-kind', 'whatever');

    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it('returns ok on an empty body when the kind has no required sections', () => {
    expect(validateDocBody('note', '').ok).toBe(true);
  });

  it('reports every required section as missing when body is empty', () => {
    const r = validateDocBody('adr', '');

    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['Status', 'Date', 'Context', 'Decision', 'Consequences']);
  });

  it('honours a project-extension registry that adds a kind with requiredSections', () => {
    const registry = DocKindRegistry.fromConfig({
      extensions: [
        {
          kind: 'incident',
          label: 'Incident',
          description: 'Production incident write-up',
          defaultOwnerKind: 'task',
          publishDir: 'docs/incidents',
          requiresEntityId: false,
          requiredSections: ['Summary', 'Timeline', 'Resolution'],
        },
      ],
    });

    const bodyOk = '## Summary\ns\n## Timeline\nt\n## Resolution\nr';
    const bodyBad = '## Summary\ns\n## Timeline\nt';

    expect(validateDocBody('incident', bodyOk, registry).ok).toBe(true);
    const bad = validateDocBody('incident', bodyBad, registry);
    expect(bad.ok).toBe(false);
    expect(bad.missing).toEqual(['Resolution']);
  });

  it('returns ok when an extension kind declares an empty requiredSections', () => {
    const registry = DocKindRegistry.fromConfig({
      extensions: [
        {
          kind: 'changelog-snippet',
          label: 'Changelog Snippet',
          description: 'Free-form changelog entry',
          defaultOwnerKind: 'task',
          publishDir: 'docs/changelog',
          requiresEntityId: false,
          requiredSections: [],
        },
      ],
    });

    expect(validateDocBody('changelog-snippet', 'anything', registry).ok).toBe(true);
  });
});
