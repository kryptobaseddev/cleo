/**
 * Tests for the self-improvement fix-generation stage (T11889 · T11975).
 *
 * Two surfaces are covered:
 *
 *  1. **`fix-gen.ts` unit** — the pure helpers (`fixPatchPath`,
 *     `looksLikeUnifiedDiff`, `buildFixGenPrompt`, `stripCodeFences`) plus
 *     `generateFixPatch` with a DETERMINISTIC FAKE generator: a canned patch is
 *     written to the expected path; an empty / non-diff / throwing / `'none'`
 *     generator degrades to `{ kind: 'skipped' }` and writes NO file. NO real LLM
 *     is reached.
 *
 *  2. **`run-loop.ts` integration (the capstone)** — a regression replay + a
 *     deterministic fake fix generator proves the WHOLE pipeline closes: regression
 *     ⇒ leased DHQ ⇒ fix-gen writes `selfimprove-<scenario>.patch` ⇒ the egress's
 *     `existsSync` guard fires ⇒ `openDraftPr` would open a DRAFT PR (gh shell-out
 *     MOCKED — the injected `run` captures the `gh pr create --draft` invocation;
 *     NO real git/gh fires). The complementary case proves the gate: with the
 *     Pi-runner gate OFF, NO patch is written and the egress stays a dry-run.
 *
 * The LLM dependency is the injectable {@link FixGenerator} seam — every test
 * supplies a fake. The E9 chokepoint is never touched.
 *
 * @epic T11889
 * @task T11975
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { DispatchResponse } from '@cleocode/contracts/gateway';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetDualScopeDbCache, openDualScopeDbAtPath } from '../../store/dual-scope-db.js';
import { SELFIMPROVE_DHQ_TABLE } from '../../store/selfimprove-dhq-schema.js';
import { _resetWriterLeaseStateForTest } from '../../store/writer-lease.js';
import { createToolGuard } from '../../tools/guard.js';
import { createDhqAdapter, type DhqAdapter } from '../dhq-adapter.js';
import type { DiffEntry } from '../envelope-diff.js';
import {
  buildFixGenPrompt,
  type FixGenerator,
  type FixGenOutput,
  type FixGenRequest,
  fixPatchPath,
  generateFixPatch,
  looksLikeUnifiedDiff,
  stripCodeFences,
} from '../fix-gen.js';
import type { ReplayDispatch } from '../replay.js';
import { runSelfImprove } from '../run-loop.js';

vi.mock('../../logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

/** The canned fixture scenario shipped under `scenarios/dhq-replay-find`. */
const SCENARIO = 'dhq-replay-find';

/** A minimal but valid unified diff a fake generator can return. */
const CANNED_PATCH = [
  'diff --git a/packages/core/src/foo.ts b/packages/core/src/foo.ts',
  'index 0000000..1111111 100644',
  '--- a/packages/core/src/foo.ts',
  '+++ b/packages/core/src/foo.ts',
  '@@ -1,1 +1,1 @@',
  '-export const x = 1;',
  '+export const x = 2;',
].join('\n');

/** A regression diff entry the request carries as evidence. */
const REGRESSION: DiffEntry = {
  opIndex: 0,
  opCoord: 'tasks.find',
  path: 'data/count',
  actual: 2,
  expected: 1,
};

/** Build a fix-gen request for the canned scenario rooted at `root`. */
function makeRequest(root: string): FixGenRequest {
  return {
    dhqId: 'DHQ-deadbeef',
    scenario: SCENARIO,
    questionHash: 'deadbeefcafef00d',
    regressions: [REGRESSION],
    repoContext: { projectRoot: root, summary: 'find returns wrong count' },
  };
}

/** A deterministic fake generator that returns a fixed {@link FixGenOutput}. */
function fakeGenerator(output: FixGenOutput): FixGenerator {
  return { propose: vi.fn(async () => output) };
}

describe('fix-gen — pure helpers', () => {
  it('fixPatchPath sanitizes the scenario and resolves against cwd', () => {
    // `/`, `.`, `.`, `/` → 4 dashes; no traversal escapes the cwd.
    const p = fixPatchPath('weird/../name', '/tmp/proj');
    expect(p).toBe('/tmp/proj/selfimprove-weird----name.patch');
  });

  it('looksLikeUnifiedDiff accepts a real diff and rejects prose / empty', () => {
    expect(looksLikeUnifiedDiff(CANNED_PATCH)).toBe(true);
    expect(looksLikeUnifiedDiff('Sorry, I cannot help with that.')).toBe(false);
    expect(looksLikeUnifiedDiff('')).toBe(false);
    expect(looksLikeUnifiedDiff('   \n  ')).toBe(false);
  });

  it('stripCodeFences unwraps a fenced diff but leaves a bare diff untouched', () => {
    expect(stripCodeFences('```diff\n' + CANNED_PATCH + '\n```')).toBe(CANNED_PATCH);
    expect(stripCodeFences(CANNED_PATCH)).toBe(CANNED_PATCH);
  });

  it('buildFixGenPrompt embeds the regression coordinates + demands a unified diff', () => {
    const { system, user } = buildFixGenPrompt(makeRequest('/tmp/p'));
    expect(system).toContain('unified diff');
    expect(system).toContain('NO_PATCH');
    expect(user).toContain('tasks.find');
    expect(user).toContain('data/count');
    expect(user).toContain('DHQ-deadbeef');
  });
});

describe('fix-gen — generateFixPatch with a deterministic fake', () => {
  let root: string;

  beforeEach(() => {
    root = join(tmpdir(), `fixgen-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('writes the canned patch to the egress-expected path', async () => {
    const generator = fakeGenerator({ kind: 'patch', diff: CANNED_PATCH, model: 'fake-model' });
    const res = await generateFixPatch({ request: makeRequest(root), generator, cwd: root });

    expect(res.kind).toBe('written');
    if (res.kind !== 'written') throw new Error('unreachable');
    expect(res.patchPath).toBe(join(root, `selfimprove-${SCENARIO}.patch`));
    expect(res.model).toBe('fake-model');
    expect(existsSync(res.patchPath)).toBe(true);
    const written = readFileSync(res.patchPath, 'utf8');
    expect(written.startsWith('diff --git')).toBe(true);
    expect(written.endsWith('\n')).toBe(true); // normalized trailing newline
  });

  it('degrades to skipped (no file) when the generator returns none', async () => {
    const generator = fakeGenerator({ kind: 'none', reason: 'model-declined' });
    const res = await generateFixPatch({ request: makeRequest(root), generator, cwd: root });
    expect(res.kind).toBe('skipped');
    if (res.kind === 'skipped') expect(res.reason).toContain('model-declined');
    expect(existsSync(join(root, `selfimprove-${SCENARIO}.patch`))).toBe(false);
  });

  it('degrades to skipped (no file) when the output is not a unified diff', async () => {
    const generator = fakeGenerator({ kind: 'patch', diff: 'just some prose', model: 'm' });
    const res = await generateFixPatch({ request: makeRequest(root), generator, cwd: root });
    expect(res.kind).toBe('skipped');
    if (res.kind === 'skipped') expect(res.reason).toBe('fixgen-not-a-diff');
    expect(existsSync(join(root, `selfimprove-${SCENARIO}.patch`))).toBe(false);
  });

  it('degrades to skipped (no file) when the generator throws — never rethrows', async () => {
    const generator: FixGenerator = {
      propose: vi.fn(async () => {
        throw new Error('boom');
      }),
    };
    const res = await generateFixPatch({ request: makeRequest(root), generator, cwd: root });
    expect(res.kind).toBe('skipped');
    if (res.kind === 'skipped') expect(res.reason).toContain('fixgen-threw');
    expect(existsSync(join(root, `selfimprove-${SCENARIO}.patch`))).toBe(false);
  });
});

/**
 * Build a dispatch port that DIVERGES from the golden so the loop finds a
 * regression (mirrors the run-loop test's regressionDispatch).
 */
function regressionDispatch(): ReplayDispatch {
  return vi.fn(
    async (op): Promise<DispatchResponse> => ({
      meta: {
        gateway: 'query',
        domain: 'tasks',
        operation: op.operation,
        timestamp: new Date().toISOString(),
        duration_ms: 3,
        source: 'rpc',
        requestId: `req-${op.operation}`,
      },
      success: true,
      data: { operation: op.operation, drifted: 'unexpected' },
    }),
  );
}

describe('run-loop CAPSTONE — regression → fix-gen → DRAFT PR (deterministic fake, mocked gh)', () => {
  let testRoot: string;
  let projectRoot: string;
  let native: DatabaseSync;
  let realAdapter: DhqAdapter;
  const guard = createToolGuard({ mode: 'enforce' });

  beforeEach(async () => {
    testRoot = join(tmpdir(), `fixgen-loop-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    projectRoot = join(testRoot, 'project');
    const cleoDir = join(projectRoot, '.cleo');
    mkdirSync(cleoDir, { recursive: true });
    const handle = await openDualScopeDbAtPath('project', join(cleoDir, 'cleo.db'));
    native = (handle.db as unknown as { $client: DatabaseSync }).$client;
    realAdapter = createDhqAdapter({ cwd: projectRoot, now: () => 1000 });
  });

  afterEach(() => {
    _resetDualScopeDbCache();
    _resetWriterLeaseStateForTest();
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  /** Read the one open DHQ row's regression_json (the recorded evidence). */
  function openRegressionJson(): string | null {
    const row = native
      .prepare(`SELECT regression_json AS j FROM ${SELFIMPROVE_DHQ_TABLE} WHERE status = 'open'`)
      .get() as { j: string } | undefined;
    return row?.j ?? null;
  }

  it('GATE ON: fake fix-gen writes a patch ⇒ egress opens a DRAFT PR (gh fully mocked)', async () => {
    const generator = fakeGenerator({ kind: 'patch', diff: CANNED_PATCH, model: 'fake-model' });

    // FULLY MOCKED git/gh runner — every shell-out is captured, NEVER executed.
    // Injected straight into the run-loop's egress via the `draftPrRun` seam so
    // the whole capstone is one deterministic call with NO real git/gh.
    const ghCalls: string[][] = [];
    const draftPrRun = vi.fn((file: string, args: readonly string[]): string => {
      ghCalls.push([file, ...args]);
      if (file === 'gh' && args[0] === 'pr' && args[1] === 'create') {
        return 'https://github.com/cleocode/cleocode/pull/4242\n';
      }
      return '';
    });

    const res = await runSelfImprove({
      scenario: SCENARIO,
      dispatch: regressionDispatch(),
      backend: 'in-process',
      guard,
      adapter: realAdapter,
      cwd: projectRoot,
      execute: true,
      piRunnerEnabled: true, // arm fix-gen WITHOUT mutating process.env
      fixGenerator: generator,
      draftPrRun, // mock the egress shell-out
    });

    // 1. The pipeline closed: regression acted on + fix-gen wrote the patch.
    expect(res.outcome).toBe('regression-acted');
    expect(res.fixGen?.kind).toBe('written');
    expect(generator.propose).toHaveBeenCalledTimes(1);
    const patchPath = join(projectRoot, `selfimprove-${SCENARIO}.patch`);
    expect(existsSync(patchPath)).toBe(true);
    if (res.fixGen?.kind === 'written') {
      expect(res.fixGen.patchPath).toBe(patchPath);
    }

    // 2. The egress found the patch (no E_NOT_FOUND skip) + opened a DRAFT PR.
    expect(res.draftPr?.kind).toBe('ok');
    if (res.draftPr?.kind === 'ok') {
      expect(res.draftPr.prUrl).toBe('https://github.com/cleocode/cleocode/pull/4242');
    }
    const ghCreate = ghCalls.find(([f, a]) => f === 'gh' && a === 'pr');
    expect(ghCreate).toBeDefined();
    expect(ghCreate?.join(' ')).toContain('--draft');
    expect(ghCreate?.join(' ')).toContain('--base');
    // NEVER a push to main.
    expect(ghCalls.some(([, ...a]) => /push.*\bmain\b/.test(a.join(' ')))).toBe(false);

    // 3. The PR url + fix-gen outcome were recorded back onto the leased DHQ row.
    const evidence = openRegressionJson();
    expect(evidence).not.toBeNull();
    expect(evidence).toContain('"fixGen"');
    expect(evidence).toContain('"written"');
  });

  it('GATE OFF: piRunnerEnabled=false ⇒ NO patch written, egress is a no-patch skip', async () => {
    const generator = fakeGenerator({ kind: 'patch', diff: CANNED_PATCH, model: 'fake-model' });

    const res = await runSelfImprove({
      scenario: SCENARIO,
      dispatch: regressionDispatch(),
      backend: 'in-process',
      guard,
      adapter: realAdapter,
      cwd: projectRoot,
      execute: true,
      piRunnerEnabled: false, // gate OFF
      fixGenerator: generator,
    });

    // DHQ still emitted (execute), but fix-gen never ran and no patch exists.
    expect(res.fixGen).toBeNull();
    expect(generator.propose).not.toHaveBeenCalled();
    expect(existsSync(join(projectRoot, `selfimprove-${SCENARIO}.patch`))).toBe(false);

    // With no patch on disk the egress degrades to the existing no-patch skip.
    expect(res.draftPr?.kind).toBe('error');
    if (res.draftPr?.kind === 'error') {
      expect(res.draftPr.code).toBe('E_NOT_FOUND');
    }
  });
});
