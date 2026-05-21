/**
 * Unit tests for the canon-lint agent-accountability harness (T9797).
 *
 * Validates the SDK-level routing engine that flags raw-markdown writes
 * to canonical doc paths in Claude Code-style session transcripts.
 *
 * Test surface:
 *   - Write tool → blocked path  → 1 violation
 *   - Edit tool → blocked path   → 1 violation
 *   - MultiEdit with N edits     → N violations
 *   - Write to publishMirror     → PASS (no violation)
 *   - Write to rawMdAllowed dir  → PASS (no violation)
 *   - Malformed line             → warning, scan continues
 *   - Missing transcript file    → no-op success
 *   - Missing canon.yml          → mode='no-canon' success
 *   - Absolute path vs project   → relative match still hits
 *
 * @epic T9787 — SG-DOCS-CANON-CLOSURE
 * @task T9797 — E-DOCS-REAL-WORLD-VALIDATION
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type CanonRegistry,
  lintSessionForCanonViolations,
  loadCanonRegistry,
} from '../canon-lint.js';

// Canonical fixture — mirrors production `.cleo/canon.yml` (T9796) so the
// harness exercises the same routing surface the CI gate enforces.
const CANON_YAML = `version: 1
kinds:
  adr:
    canonicalHome: ssot
    publishMirror: docs/adr/
    rawMdAllowed: false
    rawMdPaths:
      - .cleo/adrs/
  spec:
    canonicalHome: ssot
    publishMirror: docs/spec/
    rawMdAllowed: false
  note:
    canonicalHome: ssot
    publishMirror: docs/note/
    rawMdAllowed: false
    rawMdPaths:
      - .cleo/agent-outputs/
  changeset:
    canonicalHome: ssot-first
    publishMirror: .changeset/
    rawMdAllowed: true
  llm-readme:
    canonicalHome: ssot
    publishMirror: .
    rawMdAllowed: true
`;

/** Compose one JSONL line representing an assistant `tool_use` entry. */
function toolUseLine(
  tool: 'Write' | 'Edit' | 'MultiEdit',
  filePath: string,
  payload: Record<string, unknown>,
  toolUseId = 'toolu_abc',
): string {
  return JSON.stringify({
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: toolUseId,
          name: tool,
          input: { file_path: filePath, ...payload },
        },
      ],
    },
  });
}

describe('canon-lint (T9797 · agent-accountability)', () => {
  let projectRoot: string;
  let transcriptPath: string;
  const SESSION_ID = '00000000-1111-2222-3333-444444444444';

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'canon-lint-'));
    mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
    writeFileSync(join(projectRoot, '.cleo', 'canon.yml'), CANON_YAML, 'utf8');
    transcriptPath = join(projectRoot, `${SESSION_ID}.jsonl`);
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('loadCanonRegistry parses the fixture cleanly', () => {
    const reg = loadCanonRegistry(projectRoot);
    expect(reg).toBeDefined();
    expect(reg?.version).toBe(1);
    expect(reg?.kinds['adr']?.rawMdAllowed).toBe(false);
    expect(reg?.kinds['changeset']?.rawMdAllowed).toBe(true);
  });

  it('Write to .cleo/adrs/ produces an adr violation', () => {
    writeFileSync(
      transcriptPath,
      toolUseLine('Write', `${projectRoot}/.cleo/adrs/ADR-999-raw.md`, {
        content: '# raw md\n\nBypass attempt.',
      }),
    );
    const result = lintSessionForCanonViolations({ transcriptPath, projectRoot });
    expect(result.mode).toBe('enforced');
    expect(result.passed).toBe(false);
    expect(result.violations).toHaveLength(1);
    const v = result.violations[0]!;
    expect(v.docKind).toBe('adr');
    expect(v.matchedPath).toBe('.cleo/adrs/');
    expect(v.path).toBe('.cleo/adrs/ADR-999-raw.md');
    expect(v.kind).toBe('raw-md-canonical');
    expect(v.sessionId).toBe(SESSION_ID);
    expect(v.toolUseId).toBe('toolu_abc');
    expect(v.fix).toContain('cleo docs add');
    expect(v.fix).toContain('--type adr');
    expect(v.evidence).toContain('raw md');
  });

  it('Edit to .cleo/agent-outputs/ produces a note violation', () => {
    writeFileSync(
      transcriptPath,
      toolUseLine('Edit', `${projectRoot}/.cleo/agent-outputs/handoff.md`, {
        old_string: 'foo',
        new_string: 'bar baz qux',
      }),
    );
    const result = lintSessionForCanonViolations({ transcriptPath, projectRoot });
    expect(result.passed).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.docKind).toBe('note');
  });

  it('MultiEdit with N edits yields N violations (per-call resolution)', () => {
    const lineRaw = JSON.stringify({
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_multi',
            name: 'MultiEdit',
            input: {
              file_path: `${projectRoot}/.cleo/adrs/ADR-998-multi.md`,
              edits: [
                { old_string: 'a', new_string: 'A' },
                { old_string: 'b', new_string: 'B' },
                { old_string: 'c', new_string: 'C' },
              ],
            },
          },
        ],
      },
    });
    writeFileSync(transcriptPath, lineRaw);
    const result = lintSessionForCanonViolations({ transcriptPath, projectRoot });
    expect(result.passed).toBe(false);
    expect(result.violations).toHaveLength(3);
    expect(result.violations.every((v) => v.docKind === 'adr')).toBe(true);
    expect(result.scanned).toBe(3);
  });

  it('Write to docs/adr/ (publishMirror) is NOT blocked', () => {
    writeFileSync(
      transcriptPath,
      toolUseLine('Write', `${projectRoot}/docs/adr/ADR-100-ok.md`, { content: '# ok' }),
    );
    const result = lintSessionForCanonViolations({ transcriptPath, projectRoot });
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('Write to .changeset/ (rawMdAllowed: true) is NOT blocked', () => {
    writeFileSync(
      transcriptPath,
      toolUseLine('Write', `${projectRoot}/.changeset/t9797-foo.md`, { content: '---' }),
    );
    const result = lintSessionForCanonViolations({ transcriptPath, projectRoot });
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('llms.txt at project root (rawMdAllowed: true) is NOT blocked', () => {
    writeFileSync(
      transcriptPath,
      toolUseLine('Write', `${projectRoot}/llms.txt`, { content: '# llms' }),
    );
    const result = lintSessionForCanonViolations({ transcriptPath, projectRoot });
    expect(result.passed).toBe(true);
  });

  it('relative file_path (no projectRoot prefix) still matches', () => {
    writeFileSync(
      transcriptPath,
      toolUseLine('Write', '.cleo/adrs/ADR-997-relative.md', { content: '# relative' }),
    );
    const result = lintSessionForCanonViolations({ transcriptPath, projectRoot });
    expect(result.passed).toBe(false);
    expect(result.violations[0]!.path).toBe('.cleo/adrs/ADR-997-relative.md');
  });

  it('malformed JSON line surfaces as a warning, scan continues', () => {
    const goodLine = toolUseLine('Write', `${projectRoot}/.cleo/adrs/ADR-good.md`, {
      content: '# good',
    });
    writeFileSync(transcriptPath, ['{not-json', goodLine].join('\n'));
    const result = lintSessionForCanonViolations({ transcriptPath, projectRoot });
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toMatch(/line 1/);
    expect(result.violations).toHaveLength(1);
  });

  it('lines without tool_use are skipped silently', () => {
    const userLine = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } });
    const fileSnapshot = JSON.stringify({ type: 'file-history-snapshot' });
    const goodLine = toolUseLine('Write', `${projectRoot}/.cleo/adrs/ADR-skip.md`, {
      content: '# skip',
    });
    writeFileSync(transcriptPath, [userLine, fileSnapshot, goodLine].join('\n'));
    const result = lintSessionForCanonViolations({ transcriptPath, projectRoot });
    expect(result.warnings).toHaveLength(0);
    expect(result.violations).toHaveLength(1);
    expect(result.scanned).toBe(1);
  });

  it('missing transcript file → empty success (no throw)', () => {
    const result = lintSessionForCanonViolations({
      transcriptPath: join(projectRoot, 'missing.jsonl'),
      projectRoot,
    });
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.scanned).toBe(0);
    expect(result.mode).toBe('enforced');
  });

  it('missing canon.yml → mode="no-canon" success', async () => {
    await rm(join(projectRoot, '.cleo', 'canon.yml'));
    writeFileSync(
      transcriptPath,
      toolUseLine('Write', `${projectRoot}/.cleo/adrs/ADR-x.md`, { content: 'x' }),
    );
    const result = lintSessionForCanonViolations({ transcriptPath, projectRoot });
    expect(result.passed).toBe(true);
    expect(result.mode).toBe('no-canon');
  });

  it('caller-supplied registry overrides disk read', () => {
    const customReg: CanonRegistry = {
      version: 1,
      kinds: {
        custom: {
          canonicalHome: 'ssot',
          publishMirror: 'docs/custom/',
          rawMdAllowed: false,
          rawMdPaths: ['.custom/'],
        },
      },
    };
    writeFileSync(
      transcriptPath,
      toolUseLine('Write', `${projectRoot}/.custom/foo.md`, { content: 'foo' }),
    );
    const result = lintSessionForCanonViolations({
      transcriptPath,
      projectRoot,
      registry: customReg,
    });
    expect(result.passed).toBe(false);
    expect(result.violations[0]!.docKind).toBe('custom');
  });

  it('sessionId is derived from transcript filename', () => {
    const customPath = join(projectRoot, 'abc-123.jsonl');
    writeFileSync(
      customPath,
      toolUseLine('Write', `${projectRoot}/.cleo/adrs/ADR-x.md`, { content: 'x' }),
    );
    const result = lintSessionForCanonViolations({
      transcriptPath: customPath,
      projectRoot,
    });
    expect(result.sessionId).toBe('abc-123');
    expect(result.violations[0]!.sessionId).toBe('abc-123');
  });

  it('evidence snippet is truncated to 200 chars + ellipsis', () => {
    const longContent = 'x'.repeat(500);
    writeFileSync(
      transcriptPath,
      toolUseLine('Write', `${projectRoot}/.cleo/adrs/ADR-long.md`, { content: longContent }),
    );
    const result = lintSessionForCanonViolations({ transcriptPath, projectRoot });
    const v = result.violations[0]!;
    expect(v.evidence.length).toBeLessThanOrEqual(201); // 200 + ellipsis
    expect(v.evidence.endsWith('…')).toBe(true);
  });
});
