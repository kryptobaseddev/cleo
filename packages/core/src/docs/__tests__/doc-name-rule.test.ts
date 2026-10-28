/**
 * The doc naming rule (T14107, D11210): names say what a doc is about, never
 * which task, session or date it came from.
 *
 * @task T14107
 */

import { describe, expect, it } from 'vitest';
import {
  checkDocNames,
  describeDocNameViolation,
  docNameViolation,
  isGovernedDocPath,
  suggestDocName,
} from '../doc-name-rule.js';

describe('docNameViolation', () => {
  it('accepts a subject name', () => {
    expect(docNameViolation('release-flow')).toBeNull();
    expect(docNameViolation('wave-0-5-grammar-blueprint')).toBeNull();
  });

  it('refuses task ids, session ids and dates, with a cleaned suggestion', () => {
    expect(docNameViolation('t12345-release-flow')).toEqual({
      reasons: ['task-id'],
      suggestion: 'release-flow',
    });
    expect(docNameViolation('handoff-ses-20261027044006-931954')).toEqual({
      reasons: ['session-id', 'date'],
      suggestion: 'handoff',
    });
    expect(docNameViolation('cache-study-2026-10-28')).toEqual({
      reasons: ['date'],
      suggestion: 'cache-study',
    });
    expect(docNameViolation('triage-20260525')?.reasons).toEqual(['date']);
    expect(docNameViolation('CLEO-ULTRAPLAN')).toEqual({
      reasons: ['format'],
      suggestion: 'cleo-ultraplan',
    });
    expect(docNameViolation('a'.repeat(65))?.reasons).toEqual(['length']);
  });

  it("keeps an ADR's number and a release note's version", () => {
    expect(docNameViolation('adr-0091-release-flow', 'adr')).toBeNull();
    expect(docNameViolation('adr-1234-12-factor', 'adr')).toBeNull();
    expect(docNameViolation('v2026.10.27', 'release-note')).toBeNull();
    expect(docNameViolation('v2026.10.27')?.reasons).toEqual(['format']);
    expect(docNameViolation('adr-0091-t12345-flow')).toEqual({
      reasons: ['task-id'],
      suggestion: 'adr-0091-flow',
    });
  });

  it('exempts task working state and release plumbing', () => {
    expect(docNameViolation('t12345-root-cause', 'rcasd')).toBeNull();
    expect(docNameViolation('t12345-fix', 'changeset')).toBeNull();
  });

  it('explains the rule and where the links go', () => {
    const violation = docNameViolation('t12345-flow');
    if (!violation) throw new Error('expected a violation');
    expect(describeDocNameViolation('t12345-flow', violation)).toMatch(
      /carries a task id; name docs by subject \(e\.g\. "flow"\) and record task, decision and date links in the doc's metadata/,
    );
    expect(suggestDocName('T662-')).toBe('doc');
  });
});

describe('checkDocNames', () => {
  it('governs docs/**.md except generated output and READMEs', () => {
    expect(isGovernedDocPath('docs/plan/a.md')).toBe(true);
    expect(isGovernedDocPath('docs/generated/T1-x.md')).toBe(false);
    expect(isGovernedDocPath('docs/plan/README.md')).toBe(false);
    expect(isGovernedDocPath('packages/core/T1-x.md')).toBe(false);
  });

  it('tolerates baselined names, flags new ones, and flags stale baseline entries', () => {
    const result = checkDocNames(
      ['docs/plans/T662-report.md', 'docs/plan/t999-new.md', 'docs/plan/fine.md'],
      ['docs/plans/T662-report.md', 'docs/plans/2026-04-21-gone.md'],
    );
    expect(result.violations.map((v) => v.file)).toEqual(['docs/plan/t999-new.md']);
    expect(result.stale).toEqual(['docs/plans/2026-04-21-gone.md']);
  });
});
