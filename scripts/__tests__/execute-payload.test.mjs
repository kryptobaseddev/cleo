/**
 * Regression tests for scripts/execute-payload.mjs (gh#1377).
 *
 * The load-bearing case is `metadata 200 + tarball 404`. That is the exact
 * state four packages were in for 177-217 seconds during the v2026.9.2
 * release, and the pre-fix implementation — `npm view <pkg>@<ver> version` —
 * reported every one of them as "confirmed" while an install would 404.
 *
 * A test that only stubbed the metadata endpoint would pass against the old
 * code too, so it would not be a regression test at all. Every case below
 * distinguishes the two endpoints.
 *
 * @task gh#1377
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkMetadata,
  checkPackage,
  checkTarball,
  parseArgs,
  readPublishedPackages,
  verifyAll,
} from '../execute-payload.mjs';

/**
 * Build a fetch stub that answers the metadata and tarball URLs independently.
 * @param {{ metadata?: number; tarball?: number; servedVersion?: string }} opts
 * @returns {typeof fetch}
 */
function stubFetch({ metadata = 200, tarball = 200, servedVersion = '2026.9.2' }) {
  // @ts-expect-error - minimal Response shape, only what the checks read
  return async (url, init) => {
    const isTarball = String(url).includes('/-/');
    const status = isTarball ? tarball : metadata;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ version: servedVersion }),
      _method: init?.method,
    };
  };
}

describe('gh#1377 — the tarball is the fact, metadata is only a precondition', () => {
  it('REGRESSION: metadata 200 + tarball 404 is NOT installable', async () => {
    // The pre-fix check read metadata only and called this "confirmed".
    const meta = await checkMetadata(
      'cleo-os',
      '2026.9.2',
      stubFetch({ metadata: 200, tarball: 404 }),
    );
    expect(meta.state, 'metadata alone looks fine — this is why the old check passed').toBe('ok');

    const verdict = await checkPackage(
      'cleo-os',
      '2026.9.2',
      stubFetch({ metadata: 200, tarball: 404 }),
    );
    expect(verdict.state).toBe('pending');
    expect(verdict.detail).toContain('tarball');
  });

  it('metadata 200 + tarball 200 is installable', async () => {
    const verdict = await checkPackage('core', '2026.9.2', stubFetch({}));
    expect(verdict.state).toBe('ok');
  });

  it('requests the tarball with HEAD, at the URL npm resolves to', async () => {
    /** @type {{ url: string; method?: string }[]} */
    const calls = [];
    // @ts-expect-error - minimal Response shape
    const spy = async (url, init) => {
      calls.push({ url: String(url), method: init?.method });
      return { ok: true, status: 200, json: async () => ({ version: '2026.9.2' }) };
    };
    await checkTarball('git-shim', '2026.9.2', spy);
    expect(calls[0].method).toBe('HEAD');
    expect(calls[0].url).toBe(
      'https://registry.npmjs.org/@cleocode/git-shim/-/git-shim-2026.9.2.tgz',
    );
  });
});

describe('gh#1377 — three states, not two', () => {
  it('a WRONG version is a hard mismatch, never a propagation delay', async () => {
    const verdict = await checkPackage(
      'core',
      '2026.9.2',
      stubFetch({ servedVersion: '2026.9.1' }),
    );
    expect(verdict.state).toBe('mismatch');
    expect(verdict.detail).toContain('registry served version');
  });

  it('a mismatch is terminal — it is not retried until the deadline', async () => {
    let polls = 0;
    // @ts-expect-error - minimal Response shape
    const counting = async (url) => {
      if (!String(url).includes('/-/')) polls++;
      return { ok: true, status: 200, json: async () => ({ version: '1.0.0' }) };
    };
    const results = await verifyAll(['core'], '2026.9.2', {
      fetchImpl: counting,
      timeoutMs: 60_000,
      intervalMs: 1,
      sleepImpl: async () => {},
    });
    expect(results[0].ok).toBe(false);
    expect(results[0].reason).toContain('registry served version');
    expect(polls, 'a wrong answer must not be polled again').toBe(1);
  });

  it('a 404 is soft and is retried, then reported at the deadline', async () => {
    let attempts = 0;
    // @ts-expect-error - minimal Response shape
    const flaky = async (url) => {
      const isTarball = String(url).includes('/-/');
      if (isTarball) {
        attempts++;
        // converge on the third attempt
        const status = attempts >= 3 ? 200 : 404;
        return { ok: status === 200, status };
      }
      return { ok: true, status: 200, json: async () => ({ version: '2026.9.2' }) };
    };
    const results = await verifyAll(['brain'], '2026.9.2', {
      fetchImpl: flaky,
      timeoutMs: 60_000,
      intervalMs: 1,
      sleepImpl: async () => {},
    });
    expect(results[0].ok, 'a soft 404 must be waited out, not failed immediately').toBe(true);
    expect(attempts).toBeGreaterThanOrEqual(3);
  });

  it('gives up with a failure — never a pass — when the budget expires', async () => {
    const results = await verifyAll(['cleo'], '2026.9.2', {
      fetchImpl: stubFetch({ metadata: 200, tarball: 404 }),
      timeoutMs: 0,
      intervalMs: 1,
      sleepImpl: async () => {},
    });
    expect(results[0].ok).toBe(false);
    expect(results[0].reason).toContain('tarball');
  });
});

describe('gh#1377 — the package list comes from the SSoT, and an empty scan fails closed', () => {
  it('reads publish_pkg entries from release.yml', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ep-ssot-'));
    await mkdir(path.join(root, '.github/workflows'), { recursive: true });
    await writeFile(
      path.join(root, '.github/workflows/release.yml'),
      ['    publish_pkg contracts', '    publish_pkg paths', '    publish_pkg core'].join('\n'),
      'utf8',
    );
    expect(await readPublishedPackages(root)).toEqual(['contracts', 'paths', 'core']);
  });

  it('throws rather than returning [] when release.yml is unreadable', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ep-missing-'));
    // An empty array here would be indistinguishable from "nothing to verify",
    // which is exactly how a lost input becomes a green run.
    await expect(readPublishedPackages(root)).rejects.toThrow();
  });

  it('verifying an empty list returns an empty result set, not a pass', async () => {
    const results = await verifyAll([], '2026.9.2', { fetchImpl: stubFetch({}) });
    expect(results).toEqual([]);
    // main() turns this into exit 2; the guarantee here is that nothing in the
    // verification layer manufactures a success from an empty input.
  });

  it('the real repo SSoT parses to a non-empty list', async () => {
    const pkgs = await readPublishedPackages();
    expect(pkgs.length).toBeGreaterThan(0);
    expect(pkgs).toContain('cleo');
  });
});

describe('arg parsing', () => {
  it('reads --version and --output-dir', () => {
    expect(parseArgs(['--version', '2026.9.2', '--output-dir', '/tmp/x'])).toEqual({
      version: '2026.9.2',
      outputDir: '/tmp/x',
    });
  });

  it('defaults the output dir', () => {
    expect(parseArgs(['--version', '2026.9.2']).outputDir).toBe('/tmp/postdeploy-artifacts');
  });
});
