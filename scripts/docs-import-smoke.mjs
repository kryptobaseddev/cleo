#!/usr/bin/env node
/**
 * scripts/docs-import-smoke.mjs
 *
 * CI smoke test for `cleo docs import` (T9640 / Saga T9625 / Epic T9628).
 *
 * Builds a tiny synthetic markdown corpus inside a tmp project root,
 * invokes the import via the built CLI, and asserts:
 *
 *   1. The command exits 0.
 *   2. Counter-integrity holds: scanCount === importCount + noopCount + errorCount.
 *   3. scanCount matches the local find -name '*.md' count.
 *   4. Every `created` row's blob exists at .cleo/blobs/blobs/<sha> AND
 *      sha256(blob) === manifest entry sha === sha256(source file).
 *
 * Designed to run in CI without network. Cleans its tmp root on exit.
 *
 * Usage:
 *   node scripts/docs-import-smoke.mjs
 *
 * Exit codes:
 *   0 — all assertions pass
 *   1 — any assertion fails
 *
 * @task T9640
 * @epic T9628 (Saga T9625)
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const cliEntry = resolve(repoRoot, 'packages/cleo/dist/cli/index.js');

let exitCode = 0;
const fail = (msg) => {
  console.error(`FAIL ${msg}`);
  exitCode = 1;
};
const pass = (msg) => console.log(`PASS ${msg}`);

const sandbox = mkdtempSync(join(tmpdir(), 'cleo-docs-import-smoke-'));
const projectRoot = join(sandbox, 'project');
mkdirSync(join(projectRoot, '.cleo/adrs'), { recursive: true });
mkdirSync(join(projectRoot, '.cleo/research'), { recursive: true });
mkdirSync(join(projectRoot, '.cleo/agent-outputs/nested'), { recursive: true });
mkdirSync(join(projectRoot, 'docs/specs'), { recursive: true });

const fixtures = [
  { path: '.cleo/adrs/ADR-001-example.md', body: '# ADR 001\n\nExample architectural decision.\n' },
  { path: '.cleo/adrs/ADR-002-other.md', body: '# ADR 002\n\nAnother decision.\n' },
  {
    path: '.cleo/research/study-a.md',
    body: '# Research A\n\nFindings on a topic that informs ADR-001.\n',
  },
  {
    path: '.cleo/agent-outputs/T0001-handoff.md',
    body: '# Handoff for T0001\n\nNotes from agent.\n',
  },
  {
    path: '.cleo/agent-outputs/nested/inner-note.md',
    body: '# Inner note\n\nNested agent-output to exercise the walker.\n',
  },
  { path: 'docs/specs/SPEC-LAYOUT.md', body: '# Spec layout\n\nA spec.\n' },
];

const findCount = fixtures.length;
for (const { path, body } of fixtures) {
  writeFileSync(join(projectRoot, path), body, 'utf-8');
}

const manifestPath = join(projectRoot, 'docs-import-smoke.json');
const result = spawnSync(
  process.execPath,
  [cliEntry, 'docs', 'import', projectRoot, '--json', '--audit-manifest', manifestPath],
  {
    encoding: 'utf-8',
    env: { ...process.env, CLEO_PROJECT_ROOT: projectRoot, NO_COLOR: '1' },
    maxBuffer: 64 * 1024 * 1024,
  },
);

try {
  if (result.status !== 0) {
    fail(
      `cleo docs import exited ${result.status}. stderr:\n${result.stderr}\nstdout (head):\n${(result.stdout ?? '').slice(0, 800)}`,
    );
    throw new Error('import failed');
  }
  pass('cleo docs import exited 0');

  const envelopeMatch = (result.stdout ?? '').match(/\{"success":true[\s\S]*\}/);
  if (!envelopeMatch) {
    fail('could not locate LAFS JSON envelope in stdout');
    throw new Error('no envelope');
  }
  const envelope = JSON.parse(envelopeMatch[0]);
  const { counters, entries } = envelope.data;
  if (!counters) {
    fail('envelope missing counters');
    throw new Error('no counters');
  }

  const sum = counters.importCount + counters.noopCount + counters.errorCount;
  if (sum !== counters.scanCount) {
    fail(
      `counter-integrity broken: importCount(${counters.importCount}) + noopCount(${counters.noopCount}) + errorCount(${counters.errorCount}) = ${sum} != scanCount(${counters.scanCount})`,
    );
  } else {
    pass(`counter-integrity holds (${sum} === ${counters.scanCount})`);
  }

  // Locally count .md files to cross-check the scanner.
  const localCount = await countMarkdownFiles(projectRoot);
  if (localCount !== counters.scanCount) {
    fail(`find-count(${localCount}) !== scanCount(${counters.scanCount})`);
  } else {
    pass(`scanCount(${counters.scanCount}) matches local find -name '*.md' count (${localCount})`);
  }

  if (localCount !== findCount) {
    fail(`unexpected local-count ${localCount} (expected ${findCount}) — fixture corruption?`);
  } else {
    pass(`fixture corpus count matches expected (${findCount})`);
  }

  // Round-trip: for every `created` entry, blob must exist and bytes must match source.
  const blobsDir = join(projectRoot, '.cleo/blobs/blobs');
  let rtPass = 0;
  let rtFail = 0;
  for (const entry of entries) {
    if (entry.action !== 'created') continue;
    const blobPath = join(blobsDir, entry.sha);
    let blobBytes;
    try {
      blobBytes = readFileSync(blobPath);
    } catch (err) {
      fail(`blob missing on disk for ${entry.file}: ${blobPath} (${err.message})`);
      rtFail++;
      continue;
    }
    const blobSha = createHash('sha256').update(blobBytes).digest('hex');
    const sourceBytes = readFileSync(join(projectRoot, entry.file));
    const sourceSha = createHash('sha256').update(sourceBytes).digest('hex');
    if (blobSha === entry.sha && sourceSha === entry.sha) {
      rtPass++;
    } else {
      fail(
        `round-trip mismatch for ${entry.file}: source=${sourceSha} blob=${blobSha} manifest=${entry.sha}`,
      );
      rtFail++;
    }
  }
  if (rtFail === 0 && rtPass > 0) {
    pass(`round-trip byte-equality verified for ${rtPass}/${rtPass} created blobs`);
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

if (exitCode === 0) {
  console.log('\nOK: docs-import smoke passed.');
}
process.exit(exitCode);

/**
 * @param {string} root
 */
async function countMarkdownFiles(root) {
  let count = 0;
  /** @param {string} dir */
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', '.git', 'dist', 'coverage', 'build', '_archived'].includes(entry.name))
          continue;
        await walk(abs);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.md')) count++;
    }
  }
  await walk(root);
  void relative; // touch the import so future maintainers see it's intentional
  return count;
}
