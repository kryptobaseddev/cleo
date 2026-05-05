/**
 * nexus-vs-gitnexus.mjs — Reproducible benchmark harness.
 *
 * Runs cleo-nexus and gitnexus against a pinned-commit fixture and emits a
 * machine-readable JSON diff that falsifies (or confirms) parity claims.
 *
 * Output shape (stdout, JSON):
 * {
 *   "timestamp": "2026-05-05T...",
 *   "fixture": {
 *     "path": "/absolute/path/to/fixture",
 *     "sha": "<git-sha-or-sentinel>",
 *     "kind": "openclaw" | "internal-fixtures" | "custom",
 *     "fileCount": 42
 *   },
 *   "cleo": {
 *     "node_count_by_kind": { "function": 10, "class": 3, ... },
 *     "edge_count_by_kind": { "calls": 5, "defines": 12, ... },
 *     "communities": 4,
 *     "modularity": 0.82,
 *     "duration_ms": 450
 *   },
 *   "gitnexus": {
 *     "node_count_by_kind": { "Function": 8, "Class": 3, ... },
 *     "edge_count_by_kind": { "CONTAINS": 10, "DEFINES": 10, ... },
 *     "communities": 3,
 *     "modularity": null,
 *     "duration_ms": 12000
 *   },
 *   "delta": {
 *     "total_nodes_pct": 12.5,
 *     "total_edges_pct": 8.3,
 *     "duration_speedup_x": 26.7
 *   },
 *   "regression": {
 *     "failed": false,
 *     "violations": []
 *   }
 * }
 *
 * Exit 0 = success (no regression vs baseline snapshot).
 * Exit 1 = regression detected (cleo lost ground on a meaningful metric).
 * Exit 2 = fatal setup error (tool not found, fixture unavailable).
 *
 * Usage:
 *   pnpm bench:nexus
 *   BENCH_FIXTURE_PATH=/path/to/repo pnpm bench:nexus
 *
 * Environment variables:
 *   BENCH_FIXTURE_PATH   Override fixture path (must be a git repo or directory)
 *   BENCH_FIXTURE_SHA    Override fixture git SHA (recorded in output, not used for checkout)
 *   BENCH_BASELINE_PATH  Override baseline JSON path (default: scripts/bench/nexus-baseline.json)
 *   BENCH_NO_BASELINE    Set to "1" to skip regression check (useful when updating baseline)
 *   BENCH_GITNEXUS_REPO_NAME  Custom repo name hint for gitnexus cypher queries
 *
 * @task T1845
 * @module scripts/bench/nexus-vs-gitnexus
 */

import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const DEFAULT_BASELINE_PATH = join(REPO_ROOT, 'scripts/bench/nexus-baseline.json');

/**
 * Pinned openclaw SHA used when BENCH_FIXTURE_PATH is not overridden.
 * Update this when the openclaw fixture repo changes.
 */
const OPENCLAW_PINNED_SHA = 'd2e2d971b6d23e8b727250a0d76cbe41b8f4e1f4';
const OPENCLAW_DEFAULT_PATH = '/mnt/projects/openclaw';

/** Internal fixtures dir (relative to repo root) — proxy when openclaw absent. */
const INTERNAL_FIXTURES_RELPATH = 'packages/nexus/src/__tests__/fixtures';

/**
 * Minimum meaningful regression threshold (percent).
 * Deltas smaller than this are not flagged as regressions.
 */
const REGRESSION_THRESHOLD_PCT = -5;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * @param {string} msg
 */
function log(msg) {
  process.stderr.write(`[bench] ${msg}\n`);
}

/**
 * @param {string} msg
 * @returns {never}
 */
function fatal(msg) {
  process.stderr.write(`[bench] FATAL: ${msg}\n`);
  process.exit(2);
}

/**
 * Count files matching common source-code extensions.
 * @param {string} dir
 * @returns {number}
 */
function countSourceFiles(dir) {
  const exts = new Set([
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.py',
    '.go',
    '.rs',
    '.swift',
    '.kt',
    '.java',
  ]);
  let count = 0;
  function walk(d) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      if (entry.isDirectory()) {
        walk(join(d, entry.name));
      } else if (exts.has(entry.name.slice(entry.name.lastIndexOf('.')))) {
        count++;
      }
    }
  }
  try {
    walk(dir);
  } catch {
    // best-effort
  }
  return count;
}

/**
 * Resolve the cleo nexus.db path using the same logic as @cleocode/core.
 * Falls back to ~/.local/share/cleo/nexus.db.
 * @returns {string}
 */
function resolveNexusDbPath() {
  const envPath = process.env.CLEO_NEXUS_DB;
  if (envPath) return envPath;
  // Matches getCleoHome() in packages/core/src/paths.ts
  const xdgData = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(xdgData, 'cleo', 'nexus.db');
}

// ---------------------------------------------------------------------------
// Fixture resolution
// ---------------------------------------------------------------------------

/**
 * Resolve which fixture to use and return metadata.
 * Priority: BENCH_FIXTURE_PATH env → openclaw → internal-fixtures.
 *
 * @returns {{ path: string; sha: string; kind: string; fileCount: number; tmpDir: string | null }}
 */
function resolveFixture() {
  const envPath = process.env.BENCH_FIXTURE_PATH;
  const envSha = process.env.BENCH_FIXTURE_SHA;

  if (envPath) {
    if (!existsSync(envPath)) {
      fatal(`BENCH_FIXTURE_PATH="${envPath}" does not exist`);
    }
    let sha = envSha ?? 'unknown';
    try {
      sha = execFileSync('git', ['-C', envPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    } catch {
      // not a git repo or no commits — use env override or sentinel
    }
    return {
      path: resolve(envPath),
      sha,
      kind: 'custom',
      fileCount: countSourceFiles(envPath),
      tmpDir: null,
    };
  }

  // Try openclaw
  if (existsSync(OPENCLAW_DEFAULT_PATH)) {
    const sha = envSha ?? OPENCLAW_PINNED_SHA;
    log(`Using openclaw fixture at ${OPENCLAW_DEFAULT_PATH} (pinned SHA: ${sha.slice(0, 12)})`);
    return {
      path: OPENCLAW_DEFAULT_PATH,
      sha,
      kind: 'openclaw',
      fileCount: countSourceFiles(OPENCLAW_DEFAULT_PATH),
      tmpDir: null,
    };
  }

  // Proxy: copy internal fixtures into a temp git repo
  const internalFixtures = join(REPO_ROOT, INTERNAL_FIXTURES_RELPATH);
  if (!existsSync(internalFixtures)) {
    fatal(
      `Internal fixtures not found at ${internalFixtures}. ` +
        'Ensure T1841 shipped (fixture files must exist).',
    );
  }

  log(
    `openclaw not found at ${OPENCLAW_DEFAULT_PATH} — using internal fixtures as proxy ` +
      `(note: fixture: "internal-fixtures" will appear in output)`,
  );

  const tmpDir = '/tmp/cleo-bench-fixture-' + Date.now();
  mkdirSync(tmpDir, { recursive: true });

  // Copy fixture files
  execSync(`cp -r "${internalFixtures}"/* "${tmpDir}/"`, { stdio: 'inherit' });

  // Init as git repo so gitnexus can analyze it properly
  execSync('git init && git add . && git commit -q -m "bench fixture"', {
    cwd: tmpDir,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'bench',
      GIT_AUTHOR_EMAIL: 'bench@cleo.local',
      GIT_COMMITTER_NAME: 'bench',
      GIT_COMMITTER_EMAIL: 'bench@cleo.local',
    },
  });

  let sha = 'internal-fixtures';
  try {
    sha = execFileSync('git', ['-C', tmpDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    // ignore
  }

  return {
    path: tmpDir,
    sha,
    kind: 'internal-fixtures',
    fileCount: countSourceFiles(tmpDir),
    tmpDir,
  };
}

// ---------------------------------------------------------------------------
// cleo nexus analysis
// ---------------------------------------------------------------------------

/**
 * Run `cleo nexus analyze --json <fixtureDir>` and extract stats.
 *
 * @param {{ path: string }} fixture
 * @returns {{
 *   node_count_by_kind: Record<string,number>;
 *   edge_count_by_kind: Record<string,number>;
 *   communities: number;
 *   modularity: number | null;
 *   duration_ms: number;
 * }}
 */
function runCleoNexus(fixture) {
  log(`Running cleo nexus analyze on ${fixture.path} ...`);

  const startMs = Date.now();

  /** @type {string} */
  let stdout = '';
  /** @type {string} */
  let stderr = '';

  const result = spawnSync('cleo', ['nexus', 'analyze', '--json', fixture.path], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: 300_000,
  });

  stdout = result.stdout ?? '';
  stderr = result.stderr ?? '';

  if (result.error) {
    fatal(`cleo nexus analyze failed to spawn: ${result.error.message}`);
  }
  if (result.status !== 0 && !stdout.includes('"success":true')) {
    fatal(`cleo nexus analyze exited ${result.status}.\nstderr: ${stderr.slice(0, 500)}`);
  }

  const durationMs = Date.now() - startMs;

  // Parse JSON envelope from stdout
  /** @type {{ success: boolean; data: { projectId: string; nodeCount: number; relationCount: number; durationMs: number } }} */
  let envelope;
  try {
    const jsonStart = stdout.indexOf('{"success"');
    if (jsonStart < 0)
      fatal(`cleo nexus analyze: no JSON found in stdout.\nstdout: ${stdout.slice(0, 500)}`);
    envelope = JSON.parse(stdout.slice(jsonStart));
  } catch (e) {
    fatal(`cleo nexus analyze: JSON parse error: ${e.message}\nstdout: ${stdout.slice(0, 500)}`);
  }

  if (!envelope.success) {
    fatal(`cleo nexus analyze returned success:false. stdout: ${stdout.slice(0, 500)}`);
  }

  const projectId = envelope.data.projectId;
  const reportedDurationMs = envelope.data.durationMs ?? durationMs;

  // Extract modularity from stderr (logged by pipeline)
  // Format: "[nexus] Communities: N detected, modularity=X.XXX, nodes=Y"
  let modularity = null;
  const modMatch = stderr.match(/modularity=(\d+(?:\.\d+)?)/);
  if (modMatch) {
    modularity = parseFloat(modMatch[1]);
  }

  // Extract community count from stderr
  let communities = 0;
  const commMatch = stderr.match(/Communities:\s*(\d+)\s*detected/);
  if (commMatch) {
    communities = parseInt(commMatch[1], 10);
  }

  // Query nexus.db for node/edge breakdown
  const nexusDbPath = resolveNexusDbPath();
  const node_count_by_kind = {};
  const edge_count_by_kind = {};

  if (existsSync(nexusDbPath)) {
    try {
      // Node counts by kind
      const nodeRows = execFileSync(
        'sqlite3',
        [
          nexusDbPath,
          '-separator',
          ',',
          `SELECT kind, count(*) FROM nexus_nodes WHERE project_id='${projectId}' GROUP BY kind ORDER BY count(*) DESC`,
        ],
        { encoding: 'utf8' },
      );
      for (const line of nodeRows.trim().split('\n')) {
        if (!line.trim()) continue;
        const [kind, cnt] = line.split(',');
        if (kind && cnt) node_count_by_kind[kind.trim()] = parseInt(cnt.trim(), 10);
      }

      // Edge counts by type (column is "type" not "kind" in nexus_relations)
      const edgeRows = execFileSync(
        'sqlite3',
        [
          nexusDbPath,
          '-separator',
          ',',
          `SELECT type, count(*) FROM nexus_relations WHERE project_id='${projectId}' GROUP BY type ORDER BY count(*) DESC`,
        ],
        { encoding: 'utf8' },
      );
      for (const line of edgeRows.trim().split('\n')) {
        if (!line.trim()) continue;
        const [kind, cnt] = line.split(',');
        if (kind && cnt) edge_count_by_kind[kind.trim()] = parseInt(cnt.trim(), 10);
      }
    } catch (e) {
      log(`Warning: DB query failed (${e.message}) — node/edge kind breakdown unavailable`);
    }
  } else {
    log(`Warning: nexus.db not found at ${nexusDbPath} — node/edge kind breakdown unavailable`);
  }

  log(
    `cleo nexus: ${envelope.data.nodeCount} nodes, ${envelope.data.relationCount} edges, ${reportedDurationMs}ms`,
  );

  return {
    node_count_by_kind,
    edge_count_by_kind,
    communities,
    modularity,
    duration_ms: reportedDurationMs,
    _total_nodes: envelope.data.nodeCount,
    _total_edges: envelope.data.relationCount,
  };
}

// ---------------------------------------------------------------------------
// gitnexus analysis
// ---------------------------------------------------------------------------

/**
 * Find gitnexus repo name in the registry for a given path.
 * @param {string} fixturePath
 * @returns {string | null}
 */
function resolveGitnexusRepoName(fixturePath) {
  const envOverride = process.env.BENCH_GITNEXUS_REPO_NAME;
  if (envOverride) return envOverride;
  return basename(fixturePath);
}

/**
 * Run `gitnexus analyze --force --skip-agents-md <fixtureDir>` and extract stats.
 *
 * @param {{ path: string; kind: string }} fixture
 * @returns {{
 *   node_count_by_kind: Record<string,number>;
 *   edge_count_by_kind: Record<string,number>;
 *   communities: number;
 *   modularity: null;
 *   duration_ms: number;
 * }}
 */
function runGitnexus(fixture) {
  // Verify gitnexus is installed
  const whichResult = spawnSync('which', ['gitnexus'], { encoding: 'utf8' });
  if (whichResult.status !== 0) {
    fatal(
      'gitnexus not found in PATH. Install with: npm install -g gitnexus\n' +
        'Or set BENCH_FIXTURE_PATH to a path only used for cleo and skip gitnexus.',
    );
  }

  log(`Running gitnexus analyze on ${fixture.path} ...`);

  const startMs = Date.now();

  // Always force re-index and skip AGENTS.md mutation
  // Use --skip-git for subdirectory fixtures that may not have a .git
  const args = ['analyze', '--force', '--skip-agents-md'];
  if (fixture.kind === 'internal-fixtures' || !existsSync(join(fixture.path, '.git'))) {
    args.push('--skip-git');
  }
  args.push(fixture.path);

  const result = spawnSync('gitnexus', args, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: 600_000,
  });

  const durationMs = Date.now() - startMs;

  if (result.error) {
    fatal(`gitnexus analyze failed to spawn: ${result.error.message}`);
  }

  const combined = (result.stdout ?? '') + (result.stderr ?? '');

  if (result.status !== 0 && !combined.includes('indexed successfully')) {
    fatal(`gitnexus analyze exited ${result.status}.\ncombined: ${combined.slice(0, 500)}`);
  }

  log(`gitnexus analyze completed in ${durationMs}ms`);

  // Read meta.json for top-level stats
  const metaPath = join(fixture.path, '.gitnexus', 'meta.json');
  let metaStats = { nodes: 0, edges: 0, communities: 0 };
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
      metaStats = {
        nodes: meta.stats?.nodes ?? 0,
        edges: meta.stats?.edges ?? 0,
        communities: meta.stats?.communities ?? 0,
      };
    } catch (e) {
      log(`Warning: could not parse ${metaPath}: ${e.message}`);
    }
  }

  log(`gitnexus: ${metaStats.nodes} nodes, ${metaStats.edges} edges, ${durationMs}ms`);

  // Query node/edge breakdown via gitnexus cypher
  const repoName = resolveGitnexusRepoName(fixture.path);
  const node_count_by_kind = {};
  const edge_count_by_kind = {};

  // Node counts by label
  try {
    const nodeResult = spawnSync(
      'gitnexus',
      ['cypher', '-r', repoName, 'MATCH (n) RETURN labels(n) as labels, count(*) as count'],
      { encoding: 'utf8', timeout: 30_000 },
    );
    const nodeOut = (nodeResult.stdout ?? '') + (nodeResult.stderr ?? '');
    // Parse markdown table: "| Function | 38 |"
    const nodeJson = parseGitnexusCypherMarkdown(nodeOut, ['labels', 'count']);
    for (const row of nodeJson) {
      if (row.labels && row.count) {
        node_count_by_kind[String(row.labels)] = Number(row.count);
      }
    }
  } catch (e) {
    log(`Warning: gitnexus node cypher failed: ${e.message}`);
  }

  // Edge counts by type
  try {
    const edgeResult = spawnSync(
      'gitnexus',
      ['cypher', '-r', repoName, 'MATCH ()-[r]->() RETURN r.type as relType, count(*) as count'],
      { encoding: 'utf8', timeout: 30_000 },
    );
    const edgeOut = (edgeResult.stdout ?? '') + (edgeResult.stderr ?? '');
    const edgeJson = parseGitnexusCypherMarkdown(edgeOut, ['relType', 'count']);
    for (const row of edgeJson) {
      if (row.relType && row.count) {
        edge_count_by_kind[String(row.relType)] = Number(row.count);
      }
    }
  } catch (e) {
    log(`Warning: gitnexus edge cypher failed: ${e.message}`);
  }

  return {
    node_count_by_kind,
    edge_count_by_kind,
    communities: metaStats.communities,
    modularity: null, // gitnexus does not expose modularity in any output
    duration_ms: durationMs,
    _total_nodes: metaStats.nodes,
    _total_edges: metaStats.edges,
  };
}

/**
 * Parse a gitnexus cypher markdown table into an array of row objects.
 *
 * Input example (from JSON response):
 *   {"markdown":"| labels | count |\n| --- | --- |\n| Function | 38 |","row_count":1}
 *
 * @param {string} output
 * @param {string[]} colNames
 * @returns {Array<Record<string,string>>}
 */
function parseGitnexusCypherMarkdown(output, colNames) {
  const rows = [];
  // gitnexus cypher returns JSON with a "markdown" field
  const jsonStart = output.indexOf('{');
  if (jsonStart < 0) return rows;

  try {
    const obj = JSON.parse(output.slice(jsonStart));
    const md = obj.markdown ?? '';
    const lines = md.split('\n').filter((l) => l.trim() && !l.includes('---'));
    // Skip header row (first line)
    for (let i = 1; i < lines.length; i++) {
      const cells = lines[i]
        .split('|')
        .map((c) => c.trim())
        .filter(Boolean);
      if (cells.length >= 2) {
        const row = {};
        for (let c = 0; c < colNames.length && c < cells.length; c++) {
          row[colNames[c]] = cells[c];
        }
        rows.push(row);
      }
    }
  } catch {
    // parse failure — return empty
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Delta calculation
// ---------------------------------------------------------------------------

/**
 * Compute percent delta: (a - b) / b * 100, or null when b is zero.
 * @param {number} a
 * @param {number} b
 * @returns {number | null}
 */
function pctDelta(a, b) {
  if (b === 0) return null;
  return parseFloat((((a - b) / b) * 100).toFixed(1));
}

/**
 * Build the delta object comparing cleo vs gitnexus stats.
 *
 * @param {{ _total_nodes: number; _total_edges: number; duration_ms: number; communities: number }} cleo
 * @param {{ _total_nodes: number; _total_edges: number; duration_ms: number; communities: number }} gitnexus
 * @returns {Record<string,number|null>}
 */
function buildDelta(cleo, gitnexus) {
  return {
    total_nodes_pct: pctDelta(cleo._total_nodes, gitnexus._total_nodes),
    total_edges_pct: pctDelta(cleo._total_edges, gitnexus._total_edges),
    communities_pct: pctDelta(cleo.communities, gitnexus.communities),
    duration_speedup_x:
      gitnexus.duration_ms > 0
        ? parseFloat((gitnexus.duration_ms / cleo.duration_ms).toFixed(1))
        : null,
  };
}

// ---------------------------------------------------------------------------
// Regression check
// ---------------------------------------------------------------------------

/**
 * Compare current run against the saved baseline.
 * A regression is when a cleo metric drops by more than REGRESSION_THRESHOLD_PCT
 * compared to the baseline cleo numbers (not gitnexus).
 *
 * @param {{ _total_nodes: number; _total_edges: number; communities: number; modularity: number | null }} current
 * @param {object} baseline
 * @returns {{ failed: boolean; violations: string[] }}
 */
function checkRegression(current, baseline) {
  if (!baseline?.cleo) return { failed: false, violations: [] };

  const violations = [];
  const bl = baseline.cleo;

  /** @param {string} metric @param {number} curr @param {number} base */
  function check(metric, curr, base) {
    const pct = pctDelta(curr, base);
    if (pct !== null && pct < REGRESSION_THRESHOLD_PCT) {
      violations.push(
        `${metric}: ${base} → ${curr} (${pct > 0 ? '+' : ''}${pct}% — below ${REGRESSION_THRESHOLD_PCT}% threshold)`,
      );
    }
  }

  check('total_nodes', current._total_nodes, bl._total_nodes ?? 0);
  check('total_edges', current._total_edges, bl._total_edges ?? 0);
  check('communities', current.communities, bl.communities ?? 0);

  if (bl.modularity != null && current.modularity != null) {
    // modularity regression: drop of > 0.05 absolute
    const modDelta = current.modularity - bl.modularity;
    if (modDelta < -0.05) {
      violations.push(
        `modularity: ${bl.modularity.toFixed(3)} → ${current.modularity.toFixed(3)} (drop of ${(-modDelta).toFixed(3)} — exceeds 0.05 threshold)`,
      );
    }
  }

  return { failed: violations.length > 0, violations };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  log('=== cleo-nexus vs gitnexus benchmark ===');

  const fixture = resolveFixture();
  log(
    `Fixture: ${fixture.path} (${fixture.kind}, sha:${fixture.sha.slice(0, 12)}, ${fixture.fileCount} source files)`,
  );

  // Run both tools
  const cleoStats = runCleoNexus(fixture);
  const gitnexusStats = runGitnexus(fixture);

  // Clean up temp dir
  if (fixture.tmpDir) {
    try {
      rmSync(fixture.tmpDir, { recursive: true, force: true });
      log(`Cleaned up temp fixture dir: ${fixture.tmpDir}`);
    } catch {
      // non-fatal
    }
  }

  const delta = buildDelta(cleoStats, gitnexusStats);

  // Load baseline
  const baselinePath = process.env.BENCH_BASELINE_PATH ?? DEFAULT_BASELINE_PATH;
  let baseline = null;
  if (existsSync(baselinePath)) {
    try {
      baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
    } catch (e) {
      log(`Warning: could not parse baseline at ${baselinePath}: ${e.message}`);
    }
  } else {
    log(`No baseline found at ${baselinePath} — regression check skipped`);
  }

  const skipBaseline = process.env.BENCH_NO_BASELINE === '1';
  const regression =
    skipBaseline || baseline === null
      ? { failed: false, violations: [] }
      : checkRegression(cleoStats, baseline);

  // Strip internal fields from output
  const { _total_nodes: cleoTotalNodes, _total_edges: cleoTotalEdges, ...cleoPublic } = cleoStats;
  const { _total_nodes: gnTotalNodes, _total_edges: gnTotalEdges, ...gnPublic } = gitnexusStats;

  const output = {
    timestamp: new Date().toISOString(),
    fixture: {
      path: fixture.path,
      sha: fixture.sha,
      kind: fixture.kind,
      fileCount: fixture.fileCount,
    },
    cleo: {
      ...cleoPublic,
      _total_nodes: cleoTotalNodes,
      _total_edges: cleoTotalEdges,
    },
    gitnexus: {
      ...gnPublic,
      _total_nodes: gnTotalNodes,
      _total_edges: gnTotalEdges,
    },
    delta,
    regression,
  };

  process.stdout.write(JSON.stringify(output, null, 2) + '\n');

  if (regression.failed) {
    process.stderr.write('\n[bench] REGRESSION DETECTED:\n');
    for (const v of regression.violations) {
      process.stderr.write(`  - ${v}\n`);
    }
    process.stderr.write(`\nBaseline: ${baselinePath}\n`);
    process.stderr.write('Update baseline with: pnpm bench:nexus --update-baseline\n');
    process.exit(1);
  }

  log(
    `Done. cleo: ${cleoTotalNodes} nodes in ${cleoStats.duration_ms}ms | gitnexus: ${gnTotalNodes} nodes in ${gitnexusStats.duration_ms}ms`,
  );
  if (delta.duration_speedup_x != null) {
    log(`Speed: cleo is ${delta.duration_speedup_x}x faster than gitnexus`);
  }
}

// Handle --update-baseline flag
if (process.argv.includes('--update-baseline')) {
  process.env.BENCH_NO_BASELINE = '1';
  const baselinePath = process.env.BENCH_BASELINE_PATH ?? DEFAULT_BASELINE_PATH;
  log(`Will write baseline to ${baselinePath} after run`);

  // Monkey-patch process.stdout.write to capture and save
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...args) => {
    const res = origWrite(chunk, ...args);
    if (typeof chunk === 'string' && chunk.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(chunk);
        mkdirSync(dirname(baselinePath), { recursive: true });
        writeFileSync(baselinePath, JSON.stringify(parsed, null, 2) + '\n');
        process.stderr.write(`[bench] Baseline written to ${baselinePath}\n`);
      } catch {
        // not the final JSON
      }
    }
    return res;
  };
}

main().catch((e) => {
  process.stderr.write(`[bench] Uncaught error: ${e.message}\n${e.stack}\n`);
  process.exit(2);
});
