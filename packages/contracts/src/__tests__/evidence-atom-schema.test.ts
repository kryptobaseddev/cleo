/**
 * Tests for the ADR-051 evidence atom grammar schema (T10337).
 *
 * Coverage:
 *   - Per-atom-prefix valid + invalid parse cases.
 *   - Per-gate satisfying + insufficient atom sets.
 *   - Round-trip: parseEvidenceString output matches schema parse.
 *   - Behavior parity with the legacy `checkGateEvidenceMinimum` error
 *     message format.
 *
 * @task T10337
 * @saga T10326
 * @adr ADR-051
 */

import { describe, expect, it } from 'vitest';
import {
  type EvidenceAtomInput,
  EvidenceAtomSchema,
  EvidenceParseError,
  formatGateRequirement,
  formatGateRequirementHint,
  GATE_EVIDENCE_REQUIREMENTS,
  parseEvidenceString,
  validateEvidenceForGate,
} from '../index.js';
import type { VerificationGate } from '../task.js';

describe('EvidenceAtomSchema (T10337)', () => {
  // ─── Per-atom-prefix parse coverage ───────────────────────────────────────

  describe('commit atom', () => {
    it('accepts 7-40 hex SHA', () => {
      const a = EvidenceAtomSchema.parse({ kind: 'commit', sha: 'abc1234' });
      expect(a).toEqual({ kind: 'commit', sha: 'abc1234' });
      const b = EvidenceAtomSchema.parse({
        kind: 'commit',
        sha: 'a'.repeat(40),
      });
      expect(b.kind).toBe('commit');
    });

    it('rejects short SHA', () => {
      const r = EvidenceAtomSchema.safeParse({ kind: 'commit', sha: 'abc' });
      expect(r.success).toBe(false);
    });

    it('rejects non-hex SHA', () => {
      const r = EvidenceAtomSchema.safeParse({ kind: 'commit', sha: 'xyz1234' });
      expect(r.success).toBe(false);
    });
  });

  describe('files atom', () => {
    it('accepts non-empty paths array', () => {
      const a = EvidenceAtomSchema.parse({
        kind: 'files',
        paths: ['src/foo.ts', 'src/bar.ts'],
      });
      expect(a).toEqual({ kind: 'files', paths: ['src/foo.ts', 'src/bar.ts'] });
    });

    it('rejects empty paths array', () => {
      const r = EvidenceAtomSchema.safeParse({ kind: 'files', paths: [] });
      expect(r.success).toBe(false);
    });
  });

  describe('test-run atom', () => {
    it('accepts non-empty path', () => {
      const a = EvidenceAtomSchema.parse({ kind: 'test-run', path: '/tmp/v.json' });
      expect(a).toEqual({ kind: 'test-run', path: '/tmp/v.json' });
    });

    it('rejects empty path', () => {
      const r = EvidenceAtomSchema.safeParse({ kind: 'test-run', path: '' });
      expect(r.success).toBe(false);
    });
  });

  describe('tool atom', () => {
    it('accepts canonical and alias names', () => {
      expect(EvidenceAtomSchema.parse({ kind: 'tool', tool: 'test' }).kind).toBe('tool');
      expect(EvidenceAtomSchema.parse({ kind: 'tool', tool: 'pnpm-test' }).kind).toBe('tool');
    });

    it('rejects empty tool name', () => {
      const r = EvidenceAtomSchema.safeParse({ kind: 'tool', tool: '' });
      expect(r.success).toBe(false);
    });
  });

  describe('url atom', () => {
    it('accepts http and https', () => {
      expect(EvidenceAtomSchema.parse({ kind: 'url', url: 'https://example.com/x' }).kind).toBe(
        'url',
      );
      expect(EvidenceAtomSchema.parse({ kind: 'url', url: 'http://localhost:8080' }).kind).toBe(
        'url',
      );
    });

    it('rejects scheme-less url', () => {
      const r = EvidenceAtomSchema.safeParse({ kind: 'url', url: 'example.com' });
      expect(r.success).toBe(false);
    });
  });

  describe('note atom', () => {
    it('accepts 1-512 chars', () => {
      expect(EvidenceAtomSchema.parse({ kind: 'note', note: 'x' }).kind).toBe('note');
      expect(EvidenceAtomSchema.parse({ kind: 'note', note: 'a'.repeat(512) }).kind).toBe('note');
    });

    it('rejects empty and >512 char notes', () => {
      expect(EvidenceAtomSchema.safeParse({ kind: 'note', note: '' }).success).toBe(false);
      expect(EvidenceAtomSchema.safeParse({ kind: 'note', note: 'a'.repeat(513) }).success).toBe(
        false,
      );
    });
  });

  describe('decision atom', () => {
    it('accepts non-empty decision ID', () => {
      const a = EvidenceAtomSchema.parse({ kind: 'decision', decisionId: 'D-arch-001' });
      expect(a).toEqual({ kind: 'decision', decisionId: 'D-arch-001' });
    });

    it('rejects empty decision ID', () => {
      const r = EvidenceAtomSchema.safeParse({ kind: 'decision', decisionId: '' });
      expect(r.success).toBe(false);
    });
  });

  describe('pr atom', () => {
    it('accepts positive integer', () => {
      const a = EvidenceAtomSchema.parse({ kind: 'pr', prNumber: 357 });
      expect(a).toEqual({ kind: 'pr', prNumber: 357 });
    });

    it('rejects zero, negatives, and non-integers', () => {
      expect(EvidenceAtomSchema.safeParse({ kind: 'pr', prNumber: 0 }).success).toBe(false);
      expect(EvidenceAtomSchema.safeParse({ kind: 'pr', prNumber: -1 }).success).toBe(false);
      expect(EvidenceAtomSchema.safeParse({ kind: 'pr', prNumber: 1.5 }).success).toBe(false);
    });
  });

  describe('loc-drop atom', () => {
    it('accepts non-negative integers', () => {
      const a = EvidenceAtomSchema.parse({
        kind: 'loc-drop',
        fromLines: 1200,
        toLines: 800,
      });
      expect(a.kind).toBe('loc-drop');
    });

    it('rejects negative line counts', () => {
      const r = EvidenceAtomSchema.safeParse({
        kind: 'loc-drop',
        fromLines: -1,
        toLines: 0,
      });
      expect(r.success).toBe(false);
    });
  });

  describe('callsite-coverage atom', () => {
    it('accepts non-empty symbol + path', () => {
      const a = EvidenceAtomSchema.parse({
        kind: 'callsite-coverage',
        symbolName: 'myFn',
        relativeSourcePath: 'packages/core/src/myFn.ts',
      });
      expect(a.kind).toBe('callsite-coverage');
    });

    it('rejects empty symbol or path', () => {
      expect(
        EvidenceAtomSchema.safeParse({
          kind: 'callsite-coverage',
          symbolName: '',
          relativeSourcePath: 'x',
        }).success,
      ).toBe(false);
      expect(
        EvidenceAtomSchema.safeParse({
          kind: 'callsite-coverage',
          symbolName: 'x',
          relativeSourcePath: '',
        }).success,
      ).toBe(false);
    });
  });

  it('rejects unknown atom kind', () => {
    const r = EvidenceAtomSchema.safeParse({ kind: 'mystery', payload: 'x' });
    expect(r.success).toBe(false);
  });
});

// ─── parseEvidenceString — string → atom[] ─────────────────────────────────

describe('parseEvidenceString (T10337)', () => {
  it('parses a single commit atom', () => {
    expect(parseEvidenceString('commit:abc1234')).toEqual([{ kind: 'commit', sha: 'abc1234' }]);
  });

  it('parses files with comma-separated paths', () => {
    expect(parseEvidenceString('files:a.ts,b.ts,c.ts')).toEqual([
      { kind: 'files', paths: ['a.ts', 'b.ts', 'c.ts'] },
    ]);
  });

  it('parses test-run, tool, url, note atoms', () => {
    expect(parseEvidenceString('test-run:/tmp/v.json')).toEqual([
      { kind: 'test-run', path: '/tmp/v.json' },
    ]);
    expect(parseEvidenceString('tool:lint')).toEqual([{ kind: 'tool', tool: 'lint' }]);
    expect(parseEvidenceString('url:https://example.com')).toEqual([
      { kind: 'url', url: 'https://example.com' },
    ]);
    expect(parseEvidenceString('note:no network surface')).toEqual([
      { kind: 'note', note: 'no network surface' },
    ]);
  });

  it('parses decision and pr atoms', () => {
    expect(parseEvidenceString('decision:D-arch-001')).toEqual([
      { kind: 'decision', decisionId: 'D-arch-001' },
    ]);
    expect(parseEvidenceString('pr:357')).toEqual([{ kind: 'pr', prNumber: 357 }]);
  });

  it('parses loc-drop and callsite-coverage atoms', () => {
    expect(parseEvidenceString('loc-drop:1200:800')).toEqual([
      { kind: 'loc-drop', fromLines: 1200, toLines: 800 },
    ]);
    expect(parseEvidenceString('callsite-coverage:myFn:packages/core/src/myFn.ts')).toEqual([
      {
        kind: 'callsite-coverage',
        symbolName: 'myFn',
        relativeSourcePath: 'packages/core/src/myFn.ts',
      },
    ]);
  });

  it('parses multi-atom evidence strings with semicolons', () => {
    const atoms = parseEvidenceString('commit:abc1234;files:src/a.ts,src/b.ts;tool:lint');
    expect(atoms).toEqual([
      { kind: 'commit', sha: 'abc1234' },
      { kind: 'files', paths: ['src/a.ts', 'src/b.ts'] },
      { kind: 'tool', tool: 'lint' },
    ]);
  });

  it('tolerates whitespace around separators', () => {
    expect(parseEvidenceString('  commit:abc1234 ; tool:test  ')).toEqual([
      { kind: 'commit', sha: 'abc1234' },
      { kind: 'tool', tool: 'test' },
    ]);
  });

  it('consumes state:MERGED modifier in-place (no separate atom)', () => {
    expect(parseEvidenceString('pr:357;state:MERGED')).toEqual([{ kind: 'pr', prNumber: 357 }]);
  });

  it('rejects state:MERGED without preceding pr atom', () => {
    expect(() => parseEvidenceString('state:MERGED')).toThrow(EvidenceParseError);
  });

  it('rejects state with non-MERGED value', () => {
    expect(() => parseEvidenceString('pr:357;state:OPEN')).toThrow(EvidenceParseError);
  });

  it('rejects empty evidence string', () => {
    expect(() => parseEvidenceString('')).toThrow(EvidenceParseError);
    expect(() => parseEvidenceString(';;;')).toThrow(EvidenceParseError);
  });

  it('rejects malformed atoms', () => {
    expect(() => parseEvidenceString('justakind')).toThrow(EvidenceParseError);
    expect(() => parseEvidenceString(':payloadonly')).toThrow(EvidenceParseError);
    expect(() => parseEvidenceString('kind:')).toThrow(EvidenceParseError);
  });

  it('rejects unknown kinds', () => {
    expect(() => parseEvidenceString('mystery:foo')).toThrow(EvidenceParseError);
  });

  it('rejects malformed loc-drop', () => {
    expect(() => parseEvidenceString('loc-drop:notanumber:0')).toThrow(EvidenceParseError);
    expect(() => parseEvidenceString('loc-drop:1200')).toThrow(EvidenceParseError);
    expect(() => parseEvidenceString('loc-drop:-1:0')).toThrow(EvidenceParseError);
  });

  it('rejects malformed pr', () => {
    expect(() => parseEvidenceString('pr:notanumber')).toThrow(EvidenceParseError);
    expect(() => parseEvidenceString('pr:0')).toThrow(EvidenceParseError);
    expect(() => parseEvidenceString('pr:-5')).toThrow(EvidenceParseError);
  });

  it('rejects malformed callsite-coverage', () => {
    expect(() => parseEvidenceString('callsite-coverage:fn')).toThrow(EvidenceParseError);
    expect(() => parseEvidenceString('callsite-coverage::p.ts')).toThrow(EvidenceParseError);
    expect(() => parseEvidenceString('callsite-coverage:fn:')).toThrow(EvidenceParseError);
  });

  it('round-trip: every parseEvidenceString output validates under EvidenceAtomSchema', () => {
    const inputs = [
      'commit:abc1234',
      'files:a.ts,b.ts',
      'test-run:/tmp/x.json',
      'tool:lint',
      'url:https://example.com',
      'note:waiver text',
      'decision:D-arch-001',
      'pr:357',
      'loc-drop:1200:800',
      'callsite-coverage:fn:src/fn.ts',
    ];
    for (const raw of inputs) {
      const atoms = parseEvidenceString(raw);
      for (const atom of atoms) {
        const r = EvidenceAtomSchema.safeParse(atom);
        expect(r.success, `${raw} -> ${JSON.stringify(atom)}`).toBe(true);
      }
    }
  });
});

// ─── GATE_EVIDENCE_REQUIREMENTS — gate-to-atom mapping ─────────────────────

describe('GATE_EVIDENCE_REQUIREMENTS (T10337)', () => {
  it('covers every VerificationGate', () => {
    const expected: VerificationGate[] = [
      'implemented',
      'testsPassed',
      'qaPassed',
      'documented',
      'securityPassed',
      'cleanupDone',
      'nexusImpact',
    ];
    for (const g of expected) {
      expect(GATE_EVIDENCE_REQUIREMENTS[g]).toBeDefined();
      expect(GATE_EVIDENCE_REQUIREMENTS[g].oneOf.length).toBeGreaterThan(0);
    }
  });

  it('implemented accepts the 5 canonical combinations', () => {
    const a: EvidenceAtomInput[] = [
      { kind: 'commit', sha: 'abc1234' },
      { kind: 'files', paths: ['x.ts'] },
    ];
    expect(validateEvidenceForGate('implemented', a).ok).toBe(true);

    const b: EvidenceAtomInput[] = [
      { kind: 'commit', sha: 'abc1234' },
      { kind: 'note', note: 'deleted x.ts' },
    ];
    expect(validateEvidenceForGate('implemented', b).ok).toBe(true);

    const c: EvidenceAtomInput[] = [
      { kind: 'decision', decisionId: 'D-1' },
      { kind: 'files', paths: ['research.md'] },
    ];
    expect(validateEvidenceForGate('implemented', c).ok).toBe(true);

    const d: EvidenceAtomInput[] = [
      { kind: 'decision', decisionId: 'D-1' },
      { kind: 'note', note: 'decision-only' },
    ];
    expect(validateEvidenceForGate('implemented', d).ok).toBe(true);

    const e: EvidenceAtomInput[] = [{ kind: 'pr', prNumber: 357 }];
    expect(validateEvidenceForGate('implemented', e).ok).toBe(true);
  });

  it('implemented rejects insufficient sets with the legacy error format', () => {
    const r = validateEvidenceForGate('implemented', [
      { kind: 'commit', sha: 'abc1234' },
    ] as EvidenceAtomInput[]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toMatch(/^Gate 'implemented' requires evidence: /);
      expect(r.message).toContain('[commit AND files]');
      expect(r.message).toContain('[pr]');
    }
  });

  it('testsPassed accepts test-run, tool, pr — single-atom alternatives', () => {
    expect(
      validateEvidenceForGate('testsPassed', [
        { kind: 'test-run', path: '/tmp/v.json' },
      ] as EvidenceAtomInput[]).ok,
    ).toBe(true);
    expect(
      validateEvidenceForGate('testsPassed', [
        { kind: 'tool', tool: 'test' },
      ] as EvidenceAtomInput[]).ok,
    ).toBe(true);
    expect(
      validateEvidenceForGate('testsPassed', [{ kind: 'pr', prNumber: 357 }] as EvidenceAtomInput[])
        .ok,
    ).toBe(true);
  });

  it('testsPassed rejects empty evidence', () => {
    expect(validateEvidenceForGate('testsPassed', []).ok).toBe(false);
  });

  it('qaPassed accepts a single tool atom (behavior parity with legacy)', () => {
    // Critical parity check: GATE_EVIDENCE_REQUIREMENTS.qaPassed.oneOf is
    // [['tool'], ['pr']] — not [['tool', 'tool']]. The legacy runtime did NOT
    // count distinct tool names, so one tool atom passes.
    expect(
      validateEvidenceForGate('qaPassed', [{ kind: 'tool', tool: 'lint' }] as EvidenceAtomInput[])
        .ok,
    ).toBe(true);
  });

  it('qaPassed also accepts pr atom', () => {
    expect(
      validateEvidenceForGate('qaPassed', [{ kind: 'pr', prNumber: 357 }] as EvidenceAtomInput[])
        .ok,
    ).toBe(true);
  });

  it('documented accepts files or url', () => {
    expect(
      validateEvidenceForGate('documented', [
        { kind: 'files', paths: ['docs/x.md'] },
      ] as EvidenceAtomInput[]).ok,
    ).toBe(true);
    expect(
      validateEvidenceForGate('documented', [
        { kind: 'url', url: 'https://docs.example.com' },
      ] as EvidenceAtomInput[]).ok,
    ).toBe(true);
  });

  it('securityPassed accepts tool or note waiver', () => {
    expect(
      validateEvidenceForGate('securityPassed', [
        { kind: 'tool', tool: 'security-scan' },
      ] as EvidenceAtomInput[]).ok,
    ).toBe(true);
    expect(
      validateEvidenceForGate('securityPassed', [
        { kind: 'note', note: 'no network surface' },
      ] as EvidenceAtomInput[]).ok,
    ).toBe(true);
  });

  it('cleanupDone accepts only note', () => {
    expect(
      validateEvidenceForGate('cleanupDone', [
        { kind: 'note', note: 'removed dead branches' },
      ] as EvidenceAtomInput[]).ok,
    ).toBe(true);
    expect(
      validateEvidenceForGate('cleanupDone', [
        { kind: 'tool', tool: 'test' },
      ] as EvidenceAtomInput[]).ok,
    ).toBe(false);
  });

  it('nexusImpact accepts tool or note waiver', () => {
    expect(
      validateEvidenceForGate('nexusImpact', [
        { kind: 'tool', tool: 'nexus-impact-full' },
      ] as EvidenceAtomInput[]).ok,
    ).toBe(true);
    expect(
      validateEvidenceForGate('nexusImpact', [
        { kind: 'note', note: 'nexus gate disabled' },
      ] as EvidenceAtomInput[]).ok,
    ).toBe(true);
  });
});

// ─── formatGateRequirement — error message helper ──────────────────────────

describe('formatGateRequirement (T10337)', () => {
  it('formats implemented combinations as legacy string', () => {
    const s = formatGateRequirement('implemented');
    expect(s).toContain('[commit AND files]');
    expect(s).toContain('[commit AND note]');
    expect(s).toContain('[decision AND files]');
    expect(s).toContain('[decision AND note]');
    expect(s).toContain('[pr]');
    // Joiner between combinations is ' OR '.
    expect(s.split(' OR ').length).toBe(5);
  });

  it('formats single-element combination without AND', () => {
    expect(formatGateRequirement('cleanupDone')).toBe('[note]');
  });
});

// ─── formatGateRequirementHint — rich CLI `fix:` surface (T9949) ────────────

describe('formatGateRequirementHint (T9949)', () => {
  it('renders implemented as multi-line list of copy-pasteable verify commands', () => {
    const h = formatGateRequirementHint('implemented');
    // Header line names the gate and uses "ONE of" framing.
    expect(h).toMatch(/^Gate 'implemented' requires programmatic evidence\. Use ONE of:/);
    // Each combination renders as a complete `cleo verify ... --evidence '<atoms>'` line.
    expect(h).toContain("--evidence 'commit:<sha>;files:path/a.ts,path/b.ts'");
    expect(h).toContain("--evidence 'commit:<sha>;note:<short description>'");
    expect(h).toContain("--evidence 'decision:D-arch-001;files:path/a.ts,path/b.ts'");
    expect(h).toContain("--evidence 'decision:D-arch-001;note:<short description>'");
    expect(h).toContain("--evidence 'pr:357'");
    // Routes a `note:`-only caller at the partner atom they need.
    expect(h).toContain("'note:' alone is NOT accepted for this gate");
    expect(h).toContain("'commit:'");
    expect(h).toContain("'decision:'");
  });

  it('routes note-only callers for testsPassed at the right alternatives', () => {
    // testsPassed accepts test-run, tool, or pr — none of which involve note.
    const h = formatGateRequirementHint('testsPassed');
    expect(h).toContain("--evidence 'test-run:/tmp/vitest-out.json'");
    expect(h).toContain("--evidence 'tool:test'");
    expect(h).toContain("--evidence 'pr:357'");
    // When no combination includes note at all, the helper falls through to a
    // generic "not accepted, see ADR-051" clarifier rather than fabricating a
    // partner suggestion.
    expect(h).toContain("'note:' is NOT accepted for this gate");
    expect(h).toContain('ADR-051');
  });

  it('confirms note-only acceptance for cleanupDone', () => {
    const h = formatGateRequirementHint('cleanupDone');
    expect(h).toContain("--evidence 'note:<short description>'");
    expect(h).toContain("'note:' alone IS accepted for this gate");
  });

  it('confirms note-only acceptance for securityPassed and nexusImpact', () => {
    for (const gate of ['securityPassed', 'nexusImpact'] as const) {
      const h = formatGateRequirementHint(gate);
      expect(h, `${gate}: should confirm note alone is accepted`).toContain(
        "'note:' alone IS accepted for this gate",
      );
    }
  });

  it('renders documented with files and url, and points away from note', () => {
    const h = formatGateRequirementHint('documented');
    expect(h).toContain("--evidence 'files:path/a.ts,path/b.ts'");
    expect(h).toContain("--evidence 'url:https://example.com/docs'");
    // documented has no note pairings — generic clarifier path.
    expect(h).toContain("'note:' is NOT accepted for this gate");
  });
});

// ─── validateEvidenceForGate — failure carries `hint` (T9949) ───────────────

describe('validateEvidenceForGate failure surface (T9949)', () => {
  it('populates a `hint` field alongside the legacy `message`', () => {
    const r = validateEvidenceForGate('implemented', [
      { kind: 'note', note: 'just a note' },
    ] as EvidenceAtomInput[]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // Legacy single-line message preserved byte-for-byte.
      expect(r.message).toBe(
        "Gate 'implemented' requires evidence: [commit AND files] OR [commit AND note] OR [decision AND files] OR [decision AND note] OR [pr]",
      );
      // New rich hint includes the same content as formatGateRequirementHint.
      expect(r.hint).toBe(formatGateRequirementHint('implemented'));
    }
  });

  it('notes-only against testsPassed surfaces the right alternatives', () => {
    const r = validateEvidenceForGate('testsPassed', [
      { kind: 'note', note: 'I ran the tests by hand' },
    ] as EvidenceAtomInput[]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.hint).toContain("--evidence 'tool:test'");
      expect(r.hint).toContain("--evidence 'pr:357'");
      expect(r.hint).toContain("'note:' is NOT accepted for this gate");
    }
  });
});
