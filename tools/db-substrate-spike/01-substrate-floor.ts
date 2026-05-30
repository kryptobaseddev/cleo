/**
 * T11321 — Substrate-floor verification harness.
 *
 * Proves the already-landed substrate floor holds on the live runtime:
 *
 *   1. `SELECT sqlite_version()` returns >= 3.53.0 (the WAL-reset corruption
 *      fix; same class as the historical `epic:T1075` brain.db malformation).
 *   2. `process.versions.sqlite` agrees with the SQL-reported version.
 *   3. The runtime Node version satisfies the `engines.node` floor that the
 *      SSoT gate (`@cleocode/paths` node-version-gate, Gate 8) enforces, and
 *      `FALLBACK_MIN_NODE` in that gate equals root `engines.node`.
 *
 * Fail-fast: a non-compliant runtime exits non-zero so the spike cannot
 * silently certify on a wrong substrate.
 *
 * Run: `pnpm dlx tsx tools/db-substrate-spike/01-substrate-floor.ts`
 *
 * @task T11321
 * @task T11244
 * @saga T11242
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sqliteVersion } from './lib/open.js';

/** Compare two `major.minor.patch` strings; returns true when `a >= b`. */
function gteVersion(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** A single floor check with its measured value and pass verdict. */
interface FloorCheck {
  name: string;
  required: string;
  actual: string;
  pass: boolean;
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Read root `engines.node` (the SSoT floor the gate enforces). */
function rootEnginesNode(): string {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    engines?: { node?: string };
  };
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(pkg.engines?.node ?? '');
  return m ? `${m[1]}.${m[2]}.${m[3]}` : '0.0.0';
}

/** Read `FALLBACK_MIN_NODE` from the node-version-gate SSoT source. */
function fallbackMinNode(): string {
  const src = readFileSync(
    join(REPO_ROOT, 'packages', 'paths', 'src', 'node-version-gate.ts'),
    'utf8',
  );
  const m = /FALLBACK_MIN_NODE\s*=\s*'([\d.]+)'/.exec(src);
  return m?.[1] ?? '0.0.0';
}

/** Execute every floor check and emit a JSON verdict to stdout. */
function main(): void {
  const SQLITE_FLOOR = '3.53.0';
  const sqlVer = sqliteVersion();
  const procSqlite = process.versions.sqlite ?? 'unknown';
  const nodeVer = process.versions.node;
  const enginesFloor = rootEnginesNode();
  const fallback = fallbackMinNode();

  const checks: FloorCheck[] = [
    {
      name: 'sqlite_version() >= 3.53.0',
      required: `>=${SQLITE_FLOOR}`,
      actual: sqlVer,
      pass: gteVersion(sqlVer, SQLITE_FLOOR),
    },
    {
      name: 'process.versions.sqlite matches SQL-reported',
      required: sqlVer,
      actual: procSqlite,
      pass: procSqlite === sqlVer,
    },
    {
      name: 'Node >= engines.node floor',
      required: `>=${enginesFloor}`,
      actual: nodeVer,
      pass: gteVersion(nodeVer, enginesFloor),
    },
    {
      name: 'FALLBACK_MIN_NODE === root engines.node (Gate 8 SSoT)',
      required: enginesFloor,
      actual: fallback,
      pass: fallback === enginesFloor,
    },
  ];

  const allPass = checks.every((c) => c.pass);
  const report = {
    task: 'T11321',
    runtime: {
      node: nodeVer,
      sqlite_sql: sqlVer,
      sqlite_process: procSqlite,
      platform: process.platform,
      arch: process.arch,
    },
    enginesFloor,
    fallbackMinNode: fallback,
    checks,
    verdict: allPass ? 'PASS' : 'FAIL',
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!allPass) process.exit(1);
}

main();
