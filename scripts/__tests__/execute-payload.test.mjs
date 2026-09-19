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
  it('reads --version, --output-dir and --dist-tag', () => {
    expect(
      parseArgs(['--version', '2026.9.2', '--output-dir', '/tmp/x', '--dist-tag', 'beta']),
    ).toEqual({
      version: '2026.9.2',
      outputDir: '/tmp/x',
      distTag: 'beta',
    });
  });

  it('defaults the output dir', () => {
    expect(parseArgs(['--version', '2026.9.2']).outputDir).toBe('/tmp/postdeploy-artifacts');
  });

  // `--dist-tag` has NO default on purpose. The release job owns the
  // version -> tag derivation; a default here would silently reinstate the
  // second copy that let this job verify `latest` during a `beta` release.
  it('leaves --dist-tag empty rather than guessing it', () => {
    expect(parseArgs(['--version', '2026.9.2-beta.1']).distTag).toBe('');
  });
});

// ---------------------------------------------------------------------------
// gh#1474 — the dist-tag rung, resolved tarball URLs, and the verdict split
// ---------------------------------------------------------------------------

/**
 * Build a fetch stub answering FOUR endpoints independently: per-version
 * metadata, tarball, and the dist-tags document.
 *
 * Four, not two, on purpose. A stub that conflates any of them would pass
 * against the pre-fix code and therefore would not be a regression test —
 * which is the discipline the gh#1377 harness above already established.
 *
 * @param {{ metadata?: number; tarball?: number; servedVersion?: string;
 *   distTags?: Record<string, string>; tarballUrl?: string }} opts
 * @returns {typeof fetch}
 */
function stubFetch4({
  metadata = 200,
  tarball = 200,
  servedVersion = '2026.9.8',
  distTags = { latest: '2026.9.8' },
  tarballUrl,
} = {}) {
  // @ts-expect-error - minimal Response shape
  return async (url, init) => {
    const u = String(url);
    if (u.includes('/-/package/')) {
      return { ok: true, status: 200, json: async () => distTags };
    }
    if (u.includes('/-/') || u.endsWith('.tgz')) {
      return { ok: tarball >= 200 && tarball < 300, status: tarball };
    }
    return {
      ok: metadata >= 200 && metadata < 300,
      status: metadata,
      json: async () => ({
        version: servedVersion,
        dist: {
          ...(tarballUrl ? { tarball: tarballUrl } : {}),
          fileCount: 728,
          unpackedSize: 32054520,
        },
      }),
    };
  };
}

describe('gh#1474 — dist-tags is a third document and nothing checked it', () => {
  it('REGRESSION: metadata 200 + tarball 200 + STALE dist-tag is NOT installable', async () => {
    // This is the state nothing in the pipeline could see before. `npm i -g
    // @cleocode/cleo` resolves through dist-tags, so both prior rungs can be
    // green while the command every user types still returns the old version.
    const v = await checkPackage(
      'cleo',
      '2026.9.8',
      stubFetch4({ distTags: { latest: '2026.9.7' } }),
      'latest',
    );
    expect(v.state).toBe('pending');
    expect(v.rung).toBe('dist-tag');
    expect(v.detail).toContain('2026.9.7');
  });

  it('a stale tag is PENDING, never mismatch — waiting can fix it', async () => {
    const v = await checkPackage(
      'cleo',
      '2026.9.8',
      stubFetch4({ distTags: { latest: '2026.9.7' } }),
      'latest',
    );
    expect(v.state).not.toBe('mismatch');
  });

  it('a --tag beta release does NOT require `latest` to move', async () => {
    // The false-alarm regression. On a prerelease, `latest` is SUPPOSED to
    // stay behind; demanding it would fail every beta.
    const v = await checkPackage(
      'cleo',
      '2026.9.8-beta.1',
      stubFetch4({
        servedVersion: '2026.9.8-beta.1',
        distTags: { latest: '2026.9.7', beta: '2026.9.8-beta.1' },
      }),
      'beta',
    );
    expect(v.state).toBe('ok');
    expect(v.rung).toBe('installable');
  });

  it('omitting distTag skips rung 3 entirely (back-compat)', async () => {
    const v = await checkPackage('cleo', '2026.9.8', stubFetch4({ distTags: { latest: 'old' } }));
    expect(v.state).toBe('ok');
  });
});

describe('gh#1474 — the tarball URL is resolved, not reconstructed', () => {
  it('uses dist.tarball even when it is not the conventional URL', async () => {
    /** @type {string[]} */
    const hit = [];
    const odd = 'https://registry.npmjs.org/@cleocode/cleo/-/RELOCATED-2026.9.8.tgz';
    // @ts-expect-error - minimal Response shape
    const spy = async (url, init) => {
      const u = String(url);
      hit.push(u);
      if (u.includes('/-/package/')) {
        return { ok: true, status: 200, json: async () => ({ latest: '2026.9.8' }) };
      }
      if (u.endsWith('.tgz')) return { ok: true, status: 200, _m: init?.method };
      return {
        ok: true,
        status: 200,
        json: async () => ({ version: '2026.9.8', dist: { tarball: odd } }),
      };
    };
    const v = await checkPackage('cleo', '2026.9.8', spy, 'latest');
    expect(v.state).toBe('ok');
    // The conventional URL would be .../cleo-2026.9.8.tgz — prove we did not
    // build it ourselves.
    expect(hit).toContain(odd);
    expect(hit.some((u) => u.endsWith('/cleo-2026.9.8.tgz'))).toBe(false);
  });

  it('falls back to the conventional URL when dist carries no tarball', async () => {
    const v = await checkPackage(
      'cleo',
      '2026.9.8',
      stubFetch4({ tarballUrl: undefined }),
      'latest',
    );
    expect(v.state).toBe('ok');
  });

  it('carries fileCount and unpackedSize forward from rung 1', async () => {
    const v = await checkPackage('cleo', '2026.9.8', stubFetch4(), 'latest');
    expect(v.fileCount).toBe(728);
    expect(v.unpackedSize).toBe(32054520);
  });
});

describe('gh#1474 — pending and defect are different facts', () => {
  it('a timeout marks the package pending, NOT a defect', async () => {
    const results = await verifyAll(['cleo'], '2026.9.8', {
      timeoutMs: 0,
      intervalMs: 1,
      distTag: 'latest',
      fetchImpl: stubFetch4({ metadata: 404 }),
      sleepImpl: async () => {},
    });
    expect(results[0].ok).toBe(false);
    expect(results[0].defect).toBeUndefined();
    expect(results[0].rung).toBe('metadata');
  });

  it('a WRONG SERVED VERSION marks the package a defect', async () => {
    // Terminal on the first pass: waiting cannot turn a wrong answer right.
    const results = await verifyAll(['cleo'], '2026.9.8', {
      timeoutMs: 60_000,
      intervalMs: 1,
      distTag: 'latest',
      fetchImpl: stubFetch4({ servedVersion: '2026.9.7' }),
      sleepImpl: async () => {},
    });
    expect(results[0].ok).toBe(false);
    expect(results[0].defect).toBe(true);
  });
});
