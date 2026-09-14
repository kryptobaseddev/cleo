#!/usr/bin/env node

/**
 * execute-payload.mjs — Post-deploy step runner for the release pipeline.
 *
 * Invoked by `.github/workflows/release.yml` in the `execute-payload` job
 * AFTER all packages have been published to npm and the GitHub Release has
 * been created. Runs three classes of post-deploy work:
 *
 *   1. npm publish verification  — confirm every @cleocode/* package at
 *      <VERSION> is INSTALLABLE from the public npm registry.
 *   2. Deployment summary        — emit a structured JSON artifact that
 *      records which packages were verified, the timestamp, and the
 *      version. Used by downstream automation (registry announce, etc.).
 *   3. Post-deploy smoke         — records the verdict this run actually
 *      reached (captured as a CI artifact).
 *
 * What this verifies, and why it is not `npm view` (gh#1377)
 * ----------------------------------------------------------
 * Two facts propagate through npm's CDN INDEPENDENTLY: the per-version
 * METADATA document, and the TARBALL an install actually downloads. The old
 * implementation ran `npm view <pkg>@<ver> version`, which reads only the
 * metadata — so it could report a package "confirmed" while `npm i` on that
 * exact spec still 404'd on the tarball.
 *
 * Measured on the v2026.9.2 release (2026-09-14), polling both endpoints from
 * one host at the same instants:
 *
 *   package    metadata 200 at   tarball 200 at   window where the old
 *                                                 check passed and an
 *                                                 install would 404
 *   brain          +0s              +217s              217s
 *   cleo-os        +0s              +217s              217s
 *   git-shim       +0s              +200s              200s
 *   worktree      +23s              +200s              177s
 *   cleo       still 404 at +248s, and its tarball was still 404 at +5min
 *
 * The real job gave all of this ~13 seconds (2 attempts, one 3s gap) and
 * failed the release verification at 16/18. On v2026.9.1 the metadata check
 * went green across all 18 and `npm i -g` then failed on `cleo` and
 * `contracts`; full convergence took ~17 minutes.
 *
 * So this checks the tarball URL npm itself resolves to, and treats the
 * metadata document as a precondition rather than as the answer.
 *
 * Three states, not two (gh#1381's distinction, applied here)
 * -----------------------------------------------------------
 * "Not visible yet" and "the registry served the WRONG version" are different
 * facts and must not collapse into one failure class:
 *
 *   pending  — 404 / unreachable. A soft state. Retried until the deadline.
 *   mismatch — the registry answered with a different version. HARD, and not
 *              retried: waiting cannot turn a wrong answer into a right one,
 *              and retrying it would hide a genuine publish defect behind a
 *              propagation message.
 *   ok       — metadata present at the expected version AND tarball fetchable.
 *
 * Exit codes:
 *   0 — all steps passed
 *   1 — one or more packages never became installable, or served a wrong version
 *   2 — the check could not run (SSoT unreadable, or it named zero packages)
 *
 * Usage:
 *   node scripts/execute-payload.mjs --version 2026.4.xxx [--output-dir /tmp]
 *
 * Environment:
 *   POSTDEPLOY_TIMEOUT_MS   total propagation budget (default 900000 = 15 min)
 *   POSTDEPLOY_INTERVAL_MS  poll interval             (default 15000  = 15 s)
 *
 * @task gh#1377
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REGISTRY = 'https://registry.npmjs.org';

// ---------------------------------------------------------------------------
// Published packages — read from the SSoT, never a second copy
// ---------------------------------------------------------------------------

/**
 * The npm publish SSoT is the `publish_pkg` list in `.github/workflows/release.yml`
 * (AGENTS.md architectural gate 9). This file used to carry its own hardcoded
 * copy under the comment "must match release.yml publish order" — an unenforced
 * convention between two lists that a verifier depends on being identical.
 *
 * The drift that matters is silent: a package added to release.yml but not here
 * is PUBLISHED AND NEVER VERIFIED, and the run still prints "18/18 confirmed".
 * Reading the SSoT removes the second list instead of documenting a rule about
 * keeping it in step.
 *
 * @param {string} [root] - Repo root to resolve release.yml against.
 * @returns {Promise<string[]>} Package short-names, in publish order.
 * @throws {Error} When release.yml cannot be read — callers must fail closed.
 */
export async function readPublishedPackages(root = REPO_ROOT) {
  const yml = await readFile(path.join(root, '.github/workflows/release.yml'), 'utf8');
  return [...new Set([...yml.matchAll(/^\s*publish_pkg ([a-z0-9-]+)\s*$/gm)].map((m) => m[1]))];
}

// ---------------------------------------------------------------------------
// Registry checks
// ---------------------------------------------------------------------------

/**
 * Ask the registry for the per-version metadata document.
 *
 * A PRECONDITION, not the answer: metadata can be present while the tarball is
 * still 404. It is checked first only because a version mismatch is visible
 * here and is a hard failure worth reporting without waiting out the budget.
 *
 * @param {string} pkg - Short package name (e.g. "core").
 * @param {string} ver - Full version string (e.g. "2026.9.2").
 * @param {typeof fetch} [fetchImpl] - Injected for tests.
 * @returns {Promise<{ state: 'ok' | 'pending' | 'mismatch'; detail?: string }>}
 */
export async function checkMetadata(pkg, ver, fetchImpl = fetch) {
  const url = `${REGISTRY}/@cleocode/${encodeURIComponent(pkg)}/${encodeURIComponent(ver)}`;
  let res;
  try {
    res = await fetchImpl(url, { headers: { accept: 'application/json' } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { state: 'pending', detail: `metadata unreachable: ${msg}` };
  }
  if (res.status === 404) return { state: 'pending', detail: 'metadata 404' };
  if (!res.ok) return { state: 'pending', detail: `metadata HTTP ${res.status}` };

  /** @type {{ version?: string }} */
  let body;
  try {
    body = await res.json();
  } catch {
    return { state: 'pending', detail: 'metadata body not JSON' };
  }
  if (body.version !== ver) {
    return {
      state: 'mismatch',
      detail: `registry served version "${body.version}", expected "${ver}"`,
    };
  }
  return { state: 'ok' };
}

/**
 * Ask for the tarball an install would actually download.
 *
 * This is the load-bearing check: it is the exact URL npm resolves
 * `@cleocode/<pkg>@<ver>` to, so a 200 here is the fact "installable".
 *
 * @param {string} pkg - Short package name.
 * @param {string} ver - Full version string.
 * @param {typeof fetch} [fetchImpl] - Injected for tests.
 * @returns {Promise<{ state: 'ok' | 'pending'; detail?: string }>}
 */
export async function checkTarball(pkg, ver, fetchImpl = fetch) {
  const p = encodeURIComponent(pkg);
  const url = `${REGISTRY}/@cleocode/${p}/-/${p}-${encodeURIComponent(ver)}.tgz`;
  try {
    const res = await fetchImpl(url, { method: 'HEAD' });
    if (res.ok) return { state: 'ok' };
    return { state: 'pending', detail: `tarball HTTP ${res.status}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { state: 'pending', detail: `tarball unreachable: ${msg}` };
  }
}

/**
 * Resolve one package to a terminal state: metadata must be present AND at the
 * expected version, and the tarball must be fetchable.
 *
 * @param {string} pkg - Short package name.
 * @param {string} ver - Full version string.
 * @param {typeof fetch} [fetchImpl] - Injected for tests.
 * @returns {Promise<{ state: 'ok' | 'pending' | 'mismatch'; detail?: string }>}
 */
export async function checkPackage(pkg, ver, fetchImpl = fetch) {
  const meta = await checkMetadata(pkg, ver, fetchImpl);
  if (meta.state !== 'ok') return meta;
  return await checkTarball(pkg, ver, fetchImpl);
}

/**
 * Poll every package until each reaches a terminal state or the budget expires.
 *
 * @param {string[]} packages - Package short-names to verify.
 * @param {string} ver - Full version string.
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] - Total propagation budget.
 * @param {number} [opts.intervalMs] - Poll interval.
 * @param {typeof fetch} [opts.fetchImpl] - Injected for tests.
 * @param {(msg: string) => void} [opts.log] - Progress sink.
 * @param {(ms: number) => Promise<unknown>} [opts.sleepImpl] - Injected for tests.
 * @returns {Promise<Array<{ pkg: string; ok: boolean; reason?: string; elapsedMs: number }>>}
 */
export async function verifyAll(packages, ver, opts = {}) {
  const {
    timeoutMs = 900_000,
    intervalMs = 15_000,
    fetchImpl = fetch,
    log = () => {},
    sleepImpl = sleep,
  } = opts;

  /** @type {Map<string, { state: string; detail?: string; elapsedMs: number }>} */
  const settled = new Map();
  const started = Date.now();
  let pending = [...packages];

  while (pending.length > 0) {
    const results = await Promise.all(
      pending.map(async (pkg) => ({ pkg, ...(await checkPackage(pkg, ver, fetchImpl)) })),
    );

    /** @type {string[]} */
    const stillPending = [];
    for (const r of results) {
      if (r.state === 'pending') {
        stillPending.push(r.pkg);
        continue;
      }
      // ok and mismatch are both terminal — a wrong version never becomes right.
      const elapsedMs = Date.now() - started;
      settled.set(r.pkg, { state: r.state, detail: r.detail, elapsedMs });
      const secs = Math.round(elapsedMs / 1000);
      log(
        r.state === 'ok'
          ? `  [OK]   @cleocode/${r.pkg}@${ver}  (installable at +${secs}s)`
          : `  [FAIL] @cleocode/${r.pkg}@${ver}  ${r.detail}`,
      );
    }

    pending = stillPending;
    if (pending.length === 0) break;

    const elapsed = Date.now() - started;
    if (elapsed >= timeoutMs) {
      for (const pkg of pending) {
        const last = await checkPackage(pkg, ver, fetchImpl);
        settled.set(pkg, {
          state: 'timeout',
          detail: last.detail ?? 'still not installable at deadline',
          elapsedMs: elapsed,
        });
        log(`  [FAIL] @cleocode/${pkg}@${ver}  ${last.detail ?? 'not installable'}`);
      }
      break;
    }

    log(
      `  ... ${pending.length} not yet installable at +${Math.round(elapsed / 1000)}s: ${pending.join(', ')}`,
    );
    await sleepImpl(intervalMs);
  }

  return packages.map((pkg) => {
    const s = settled.get(pkg);
    return {
      pkg,
      ok: s?.state === 'ok',
      ...(s && s.state !== 'ok' ? { reason: s.detail } : {}),
      elapsedMs: s?.elapsedMs ?? 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Parse CLI arguments into a flat key/value map.
 * @param {string[]} argv
 * @returns {{ version: string; outputDir: string }}
 */
export function parseArgs(argv) {
  const result = { version: '', outputDir: '/tmp/postdeploy-artifacts' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--version' && argv[i + 1]) {
      result.version = argv[++i];
    } else if (arg === '--output-dir' && argv[i + 1]) {
      result.outputDir = argv[++i];
    }
  }
  return result;
}

/**
 * Run the full post-deploy payload.
 * @returns {Promise<number>} Process exit code.
 */
export async function main() {
  const { version, outputDir } = parseArgs(process.argv.slice(2));
  if (!version) {
    console.error('ERROR: --version <VERSION> is required');
    return 1;
  }

  const timeoutMs = Number(process.env.POSTDEPLOY_TIMEOUT_MS ?? 900_000);
  const intervalMs = Number(process.env.POSTDEPLOY_INTERVAL_MS ?? 15_000);

  /** @type {string[]} */
  let packages;
  try {
    packages = await readPublishedPackages();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`::error::execute-payload could not read the publish SSoT: ${msg}`);
    console.error('Refusing to verify against an unknown package set (gh#1377).');
    return 2;
  }

  // Fail closed. Without this an empty list makes the loop run zero times,
  // `failures` is empty, and the script exits 0 having verified nothing —
  // the absence-reads-as-success shape this whole fix is about.
  if (packages.length === 0) {
    console.error(
      '::error::execute-payload found no publish_pkg entries in .github/workflows/release.yml.',
    );
    console.error(
      'Refusing to report success for a verification that examined zero packages (gh#1377).',
    );
    return 2;
  }

  console.log(`\n=== execute-payload: post-deploy steps for v${version} ===\n`);
  console.log(`Step 1: Verify npm registry — ${packages.length} packages from release.yml (SSoT)`);
  console.log(
    `        budget ${Math.round(timeoutMs / 1000)}s, polling every ${Math.round(intervalMs / 1000)}s; ` +
      'checking the tarball an install fetches, not just metadata.\n',
  );

  const verifyResults = await verifyAll(packages, version, {
    timeoutMs,
    intervalMs,
    log: (m) => console.log(m),
  });

  const failures = verifyResults.filter((r) => !r.ok);
  const passed = verifyResults.filter((r) => r.ok);
  const slowest = passed.reduce((max, r) => Math.max(max, r.elapsedMs), 0);

  console.log(
    `\nRegistry verification: ${passed.length}/${packages.length} packages installable` +
      (passed.length > 0 ? ` (slowest converged at +${Math.round(slowest / 1000)}s)` : ''),
  );

  // The denominator is part of the claim: a run that examined fewer packages
  // than it was given has not verified the release.
  if (verifyResults.length !== packages.length) {
    console.error('::error::verification produced fewer results than packages — refusing to pass.');
    return 2;
  }

  console.log('\nStep 2: Writing deployment summary artifact...');
  const summary = {
    version,
    timestamp: new Date().toISOString(),
    registry: REGISTRY,
    verifiedBy: 'tarball HEAD + per-version metadata (gh#1377)',
    budgetMs: timeoutMs,
    packages: verifyResults.map(({ pkg, ok, reason, elapsedMs }) => ({
      name: `@cleocode/${pkg}`,
      version,
      verified: ok,
      convergedAfterMs: elapsedMs,
      ...(reason ? { reason } : {}),
    })),
    stats: {
      total: packages.length,
      verified: passed.length,
      failed: failures.length,
      slowestConvergenceMs: slowest,
    },
  };

  await mkdir(outputDir, { recursive: true });
  const summaryPath = path.join(outputDir, `deploy-summary-${version}.json`);
  await writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log(`  Summary written to: ${summaryPath}`);

  console.log('\nStep 3: Post-deploy smoke...');
  const verdict = failures.length === 0 ? 'PASS' : 'FAIL';
  const smokePath = path.join(outputDir, `smoke-${version}.txt`);
  await writeFile(
    smokePath,
    [
      'execute-payload ran end-to-end',
      `version: ${version}`,
      `timestamp: ${summary.timestamp}`,
      `packages_installable: ${passed.length}/${packages.length}`,
      ...(failures.length > 0 ? [`not_installable: ${failures.map((f) => f.pkg).join(', ')}`] : []),
      '',
      // The old version wrote "PASS" here unconditionally, above the failure
      // check — so the artifact of a failing run still read PASS.
      `${verdict}: execute-payload complete`,
    ].join('\n'),
    'utf8',
  );
  console.log(`  Smoke file written to: ${smokePath}`);

  if (failures.length > 0) {
    const mismatched = failures.filter((f) => (f.reason ?? '').includes('registry served version'));
    const missing = failures.filter((f) => !(f.reason ?? '').includes('registry served version'));

    console.error(`\n::error::Post-deploy verification failed for v${version}`);
    if (mismatched.length > 0) {
      console.error(
        `  WRONG VERSION (not a propagation delay — do not retry): ${mismatched.map((f) => f.pkg).join(', ')}`,
      );
      for (const f of mismatched) console.error(`    @cleocode/${f.pkg}: ${f.reason}`);
    }
    if (missing.length > 0) {
      console.error(
        `  NOT INSTALLABLE after ${Math.round(timeoutMs / 1000)}s: ${missing.map((f) => f.pkg).join(', ')}`,
      );
      console.error(
        '    Their tarballs were still unfetchable at the deadline. Raise POSTDEPLOY_TIMEOUT_MS',
      );
      console.error('    and re-run the job; an identical retry will fail the same way.');
    }
    return 1;
  }

  console.log(`\n=== execute-payload: all steps passed for v${version} ===\n`);
  return 0;
}

// Only run when invoked directly, so the checks above can be imported by tests.
const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  process.exit(await main());
}
