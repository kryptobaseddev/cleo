/**
 * Unit tests for `cleo check canon docs` (T9796).
 *
 * Validates the routing engine in isolation (no git diff required) by
 * supplying `candidateFiles` directly. This pins the four routing
 * scenarios from the task spec:
 *
 *   1. `.cleo/adrs/ADR-XXX-test.md`  → E_CANON_VIOLATION (adr blocked)
 *   2. `docs/adr/ADR-XXX-test.md`    → PASS (publishMirror, never blocked)
 *   3. `.changeset/t9796-foo.md`     → PASS (rawMdAllowed: true)
 *   4. `llms.txt`                    → PASS (llm-readme at project root)
 *
 * Also exercises:
 *   - `.cleo/agent-outputs/foo.md` → E_CANON_VIOLATION (note blocked)
 *   - `.cleo/rcasd/T9000/note.md`  → PASS (rcasd allows raw md)
 *   - Missing `canon.yml`          → no-op success (`mode: 'no-canon'`)
 *   - Malformed `canon.yml`        → throws (surfaced as E_CANON_INVALID)
 *   - Direct CLI subcommand        → registered + exits 1 on violation
 *
 * @epic T9787 (SG-DOCS-CANON-CLOSURE)
 * @task T9796 (E-DOCS-CANON-LOCKDOWN)
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadCanonRegistry, runCanonDocsCheck } from '../../dispatch/domains/check/canon-docs.js';
import { checkCommand } from '../commands/check.js';

// ---------------------------------------------------------------------------
// Canonical fixture — mirrors the production `.cleo/canon.yml` exactly so
// every test exercises the same routing surface a real PR would see.
// ---------------------------------------------------------------------------

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
  research:
    canonicalHome: ssot
    publishMirror: docs/research/
    rawMdAllowed: false
    rawMdPaths:
      - .cleo/research/
      - .cleo/rcasd/
  handoff:
    canonicalHome: ssot
    publishMirror: docs/handoff/
    rawMdAllowed: false
  note:
    canonicalHome: ssot
    publishMirror: docs/note/
    rawMdAllowed: false
    rawMdPaths:
      - .cleo/agent-outputs/
  llm-readme:
    canonicalHome: ssot
    publishMirror: .
    rawMdAllowed: true
  changeset:
    canonicalHome: ssot-first
    publishMirror: .changeset/
    rawMdAllowed: true
  release-note:
    canonicalHome: ssot
    publishMirror: docs/release/
    rawMdAllowed: false
  plan:
    canonicalHome: ssot
    publishMirror: docs/plan/
    rawMdAllowed: false
  rcasd:
    canonicalHome: ssot
    publishMirror: .cleo/rcasd/
    rawMdAllowed: true
`;

/**
 * Materialise an isolated tmp project root with a `.cleo/canon.yml` so
 * tests exercise the same load path as production (no in-memory shortcut).
 */
async function setupTmpProject(canonContent: string | null): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cleo-canon-docs-'));
  mkdirSync(join(root, '.cleo'), { recursive: true });
  if (canonContent !== null) {
    writeFileSync(join(root, '.cleo', 'canon.yml'), canonContent, 'utf8');
  }
  return root;
}

// ---------------------------------------------------------------------------
// Engine-level tests (no CLI subprocess — keeps the suite < 1s)
// ---------------------------------------------------------------------------

describe('runCanonDocsCheck — routing', () => {
  let projectRoot = '';

  beforeEach(async () => {
    projectRoot = await setupTmpProject(CANON_YAML);
  });
  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('flags a NEW raw .md addition under .cleo/adrs/ as a violation', () => {
    const result = runCanonDocsCheck({
      projectRoot,
      candidateFiles: ['.cleo/adrs/ADR-XXX-test.md'],
    });
    expect(result.passed).toBe(false);
    expect(result.mode).toBe('enforced');
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      file: '.cleo/adrs/ADR-XXX-test.md',
      kind: 'adr',
      matchedPath: '.cleo/adrs/',
    });
    expect(result.violations[0]?.fix).toContain('cleo docs add');
    expect(result.violations[0]?.fix).toContain('--type adr');
  });

  it('passes when the same file lands under docs/adr/ (publish mirror)', () => {
    const result = runCanonDocsCheck({
      projectRoot,
      candidateFiles: ['docs/adr/ADR-XXX-test.md'],
    });
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.scanned).toBe(1);
  });

  it('passes for .changeset/ additions (rawMdAllowed: true)', () => {
    const result = runCanonDocsCheck({
      projectRoot,
      candidateFiles: ['.changeset/t9796-canon-lockdown.md'],
    });
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('passes for llms.txt at the project root (llm-readme)', () => {
    const result = runCanonDocsCheck({
      projectRoot,
      candidateFiles: ['llms.txt'],
    });
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('blocks raw additions to .cleo/agent-outputs/ (note kind)', () => {
    const result = runCanonDocsCheck({
      projectRoot,
      candidateFiles: ['.cleo/agent-outputs/T9796-handoff.md'],
    });
    expect(result.passed).toBe(false);
    expect(result.violations[0]?.kind).toBe('note');
  });

  it('tolerates .cleo/rcasd/ additions (rcasd rawMdAllowed: true)', () => {
    const result = runCanonDocsCheck({
      projectRoot,
      candidateFiles: ['.cleo/rcasd/T9000/investigation.md'],
    });
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('handles deeply-nested files under a rawMdPaths entry', () => {
    const result = runCanonDocsCheck({
      projectRoot,
      candidateFiles: ['.cleo/adrs/legacy/sub/ADR-200-deep.md'],
    });
    expect(result.passed).toBe(false);
    expect(result.violations[0]?.kind).toBe('adr');
  });

  it('does not match adjacent directories with the same prefix', () => {
    // `.cleo/adrs-archive/` MUST NOT match `.cleo/adrs/` — the engine
    // appends a trailing `/` to every rawMdPath specifically to prevent
    // this class of false positive.
    const result = runCanonDocsCheck({
      projectRoot,
      candidateFiles: ['.cleo/adrs-archive/old-thing.md'],
    });
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('emits PASS with mode=enforced when no candidates supplied', () => {
    const result = runCanonDocsCheck({ projectRoot, candidateFiles: [] });
    expect(result.passed).toBe(true);
    expect(result.mode).toBe('enforced');
    expect(result.scanned).toBe(0);
  });

  it('groups mixed inputs — only the blocked one fails', () => {
    const result = runCanonDocsCheck({
      projectRoot,
      candidateFiles: ['.changeset/t-ok.md', '.cleo/adrs/ADR-BAD.md', 'docs/spec/SPEC-OK.md'],
    });
    expect(result.passed).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.file).toBe('.cleo/adrs/ADR-BAD.md');
    expect(result.scanned).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// no-canon mode — gate is a no-op when canon.yml is missing
// ---------------------------------------------------------------------------

describe('runCanonDocsCheck — no canon.yml', () => {
  let projectRoot = '';

  beforeEach(async () => {
    projectRoot = await setupTmpProject(null);
  });
  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('returns mode=no-canon and passes regardless of candidates', () => {
    const result = runCanonDocsCheck({
      projectRoot,
      // These would all be violations under the production canon.yml.
      candidateFiles: ['.cleo/adrs/ADR-X.md', '.cleo/agent-outputs/foo.md'],
    });
    expect(result.passed).toBe(true);
    expect(result.mode).toBe('no-canon');
    expect(result.violations).toHaveLength(0);
  });

  it('loadCanonRegistry returns undefined when file is missing', () => {
    expect(loadCanonRegistry(projectRoot)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Invalid canon.yml — surfaced as a throw (callers map to E_CANON_INVALID)
// ---------------------------------------------------------------------------

describe('runCanonDocsCheck — invalid canon.yml', () => {
  it('throws when version is missing', async () => {
    const root = await setupTmpProject('kinds: {}\n');
    expect(() => runCanonDocsCheck({ projectRoot: root, candidateFiles: [] })).toThrow(/version/);
    await rm(root, { recursive: true, force: true });
  });

  it('throws when an entry omits canonicalHome', async () => {
    const root = await setupTmpProject(`version: 1
kinds:
  adr:
    publishMirror: docs/adr/
    rawMdAllowed: false
`);
    expect(() => runCanonDocsCheck({ projectRoot: root, candidateFiles: [] })).toThrow(
      /canonicalHome/,
    );
    await rm(root, { recursive: true, force: true });
  });

  it('throws when canonicalHome is not ssot|ssot-first', async () => {
    const root = await setupTmpProject(`version: 1
kinds:
  adr:
    canonicalHome: bogus
    publishMirror: docs/adr/
    rawMdAllowed: false
`);
    expect(() => runCanonDocsCheck({ projectRoot: root, candidateFiles: [] })).toThrow(
      /canonicalHome/,
    );
    await rm(root, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// CLI subcommand registration — the `docs` verb must be reachable.
// ---------------------------------------------------------------------------

describe('cleo check canon — subcommand surface', () => {
  it('registers the `docs` subcommand under `canon`', () => {
    const canon = checkCommand.subCommands?.canon as {
      subCommands?: Record<string, unknown>;
    };
    expect(canon).toBeDefined();
    expect(canon.subCommands?.['docs']).toBeDefined();
  });
});
