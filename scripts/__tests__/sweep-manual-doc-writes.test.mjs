/**
 * Tests for scripts/sweep-manual-doc-writes.mjs.
 *
 * Strategy:
 *   - Build a tiny synthetic git repo under tmpdir() with a fake
 *     `.cleo/canon.yml`, a fake cutoff commit, and a known mix of
 *     pre-cutoff + post-cutoff markdown files.
 *   - Stub `cleo` on PATH with a shell shim that emits canned SSoT
 *     responses (one file matches by sha → in-sync; one slug exists
 *     but with a different sha → drift; one neither matches → orphan).
 *   - Invoke the sweep script with `--repo-root` against the sandbox
 *     and assert the resulting summary + per-item classifications.
 *
 * @task T10372
 * @epic T10293
 * @saga T10288
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '../..');
const SCRIPT = join(REPO_ROOT, 'scripts/sweep-manual-doc-writes.mjs');

/** @type {string} */
let sandbox;
/** @type {string} */
let projectRoot;
/** @type {string} */
let stubBin;

const CANON_YML = `version: 1
kinds:
  adr:
    canonicalHome: ssot
    publishMirror: docs/adr/
    rawMdAllowed: false
    rawMdPaths:
      - .cleo/adrs/
  research:
    canonicalHome: ssot
    publishMirror: docs/research/
    rawMdAllowed: false
    rawMdPaths:
      - .cleo/research/
  llm-readme:
    canonicalHome: ssot
    publishMirror: .
    rawMdAllowed: true
`;

function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

function gitInit(dir) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 't@e',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 't@e',
  };
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, env });
  spawnSync('git', ['config', 'user.email', 't@e'], { cwd: dir, env });
  spawnSync('git', ['config', 'user.name', 'test'], { cwd: dir, env });
}

function gitCommit(dir, msg) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 't@e',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 't@e',
  };
  spawnSync('git', ['add', '-A'], { cwd: dir, env });
  const r = spawnSync('git', ['commit', '-q', '-m', msg], { cwd: dir, env });
  if (r.status !== 0) throw new Error(`git commit failed: ${r.stderr.toString()}`);
}

function gitHead(dir) {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8' });
  return r.stdout.trim();
}

/**
 * Write a `cleo` shim into `stubBin`. The shim parses argv for
 * `docs list` and `docs fetch <sha>` and returns canned envelopes.
 *
 * Stub config is written to `<stubBin>/cleo-stub-config.json`:
 *   { listAttachments: [{slug,type,sha256,id}, ...], blobBySha: {sha:meta, ...} }
 */
function writeStub(config) {
  const configPath = join(stubBin, 'cleo-stub-config.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  // Node-based shim — portable & avoids bash quoting hell.
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'cleo-stub-config.json'), 'utf-8'));
const argv = process.argv.slice(2);
function emit(env, status = 0) {
  process.stdout.write(JSON.stringify(env));
  process.exit(status);
}
if (argv[0] === 'docs' && argv[1] === 'list') {
  emit({ success: true, data: { attachments: config.listAttachments || [] } });
}
if (argv[0] === 'docs' && argv[1] === 'fetch') {
  const sha = argv[2];
  const meta = (config.blobBySha || {})[sha];
  if (!meta) {
    emit({ success: false, error: { code: 4, codeName: 'E_NOT_FOUND', message: 'not found' } }, 4);
  }
  emit({ success: true, data: { metadata: { ...meta, sha256: sha } } });
}
emit({ success: false, error: { code: 1, codeName: 'E_UNKNOWN_VERB', message: 'unknown' } }, 1);
`;
  const stubPath = join(stubBin, 'cleo');
  writeFileSync(stubPath, script);
  chmodSync(stubPath, 0o755);
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'cleo-sweep-test-'));
  projectRoot = join(sandbox, 'project');
  stubBin = join(sandbox, 'bin');
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(stubBin, { recursive: true });
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('sweep-manual-doc-writes — classification', () => {
  it('classifies each file as in-sync, drift, or orphan against the SSoT stub', () => {
    // Build sandbox project with canon.yml + a pre-cutoff legacy file.
    mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
    mkdirSync(join(projectRoot, '.cleo/adrs'), { recursive: true });
    mkdirSync(join(projectRoot, '.cleo/research'), { recursive: true });
    writeFileSync(join(projectRoot, '.cleo/canon.yml'), CANON_YML);

    gitInit(projectRoot);
    // Pre-cutoff commit — files here should NOT appear in the sweep.
    writeFileSync(join(projectRoot, '.cleo/adrs/ADR-001-legacy.md'), '# legacy\n');
    gitCommit(projectRoot, 'pre-cutoff');
    const cutoffSha = gitHead(projectRoot);

    // Post-cutoff: three files exercising every classification branch.
    const insyncBody = '# in-sync ADR\n\nMatches SSoT exactly.\n';
    const driftBody = '# drifted ADR\n\nLocal edits since last publish.\n';
    const orphanBody = '# orphan research\n\nNever made it into SSoT.\n';
    writeFileSync(join(projectRoot, '.cleo/adrs/ADR-002-insync.md'), insyncBody);
    writeFileSync(join(projectRoot, '.cleo/adrs/ADR-003-drift.md'), driftBody);
    writeFileSync(join(projectRoot, '.cleo/research/r-orphan.md'), orphanBody);
    gitCommit(projectRoot, 'post-cutoff additions');

    // Stub `cleo`:
    //   - ADR-002 in-sync   → blobBySha keyed by file SHA
    //   - ADR-003 drift     → list contains slug 'adr-003-drift' but with a
    //                          different sha (the on-disk SHA is NOT in blobBySha)
    //   - r-orphan          → neither index has it
    const insyncSha = sha256(insyncBody);
    writeStub({
      listAttachments: [
        { slug: 'adr-002-insync', type: 'adr', sha256: insyncSha.slice(0, 8) + '…', id: 'att-1' },
        { slug: 'adr-003-drift', type: 'adr', sha256: 'deadbeef…', id: 'att-2' },
      ],
      blobBySha: {
        [insyncSha]: { slug: 'adr-002-insync', type: 'adr', id: 'att-1' },
      },
    });

    const env = { ...process.env, PATH: `${stubBin}:${process.env.PATH}` };
    const result = spawnSync(
      'node',
      [
        SCRIPT,
        '--repo-root',
        projectRoot,
        '--cutoff',
        cutoffSha,
        '--out',
        join(sandbox, 'report.json'),
        '--allow-unresolved',
      ],
      { encoding: 'utf-8', env },
    );

    // The summary printed to stdout is the non-JSON-only branch — parse the
    // first JSON object only.
    const stdoutFirstBlock = result.stdout.split('}\n')[0] + '}';
    const summary = JSON.parse(stdoutFirstBlock);
    expect(summary.totalFiles).toBe(3);
    expect(summary.inSync).toBe(1);
    expect(summary.drift).toBe(1);
    expect(summary.orphan).toBe(1);
    expect(summary.deleted).toBe(0);

    // Report file should mirror the in-memory classification.
    const report = JSON.parse(readFileSync(join(sandbox, 'report.json'), 'utf-8'));
    expect(report.grouped.orphan).toHaveLength(1);
    expect(report.grouped.orphan[0].file).toBe('.cleo/research/r-orphan.md');
    expect(report.grouped.drift).toHaveLength(1);
    expect(report.grouped.drift[0].file).toBe('.cleo/adrs/ADR-003-drift.md');
    expect(report.grouped.drift[0].ssotSlug).toBe('adr-003-drift');
    expect(report.grouped['in-sync']).toHaveLength(1);
    expect(report.grouped['in-sync'][0].file).toBe('.cleo/adrs/ADR-002-insync.md');
    // Pre-cutoff file MUST NOT appear.
    const allFiles = [
      ...report.grouped.orphan,
      ...report.grouped.drift,
      ...report.grouped['in-sync'],
    ].map((i) => i.file);
    expect(allFiles).not.toContain('.cleo/adrs/ADR-001-legacy.md');
  });

  it('exits 1 when orphans exist and --allow-unresolved is not passed', () => {
    mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
    mkdirSync(join(projectRoot, '.cleo/adrs'), { recursive: true });
    writeFileSync(join(projectRoot, '.cleo/canon.yml'), CANON_YML);
    gitInit(projectRoot);
    writeFileSync(join(projectRoot, 'README.md'), '# placeholder\n');
    gitCommit(projectRoot, 'init');
    const cutoffSha = gitHead(projectRoot);
    writeFileSync(join(projectRoot, '.cleo/adrs/ADR-100-orphan.md'), '# orphan\n');
    gitCommit(projectRoot, 'add orphan');

    writeStub({ listAttachments: [], blobBySha: {} });

    const env = { ...process.env, PATH: `${stubBin}:${process.env.PATH}` };
    const result = spawnSync(
      'node',
      [
        SCRIPT,
        '--repo-root',
        projectRoot,
        '--cutoff',
        cutoffSha,
        '--out',
        join(sandbox, 'report.json'),
      ],
      { encoding: 'utf-8', env },
    );
    expect(result.status).toBe(1);
  });

  it('exits 0 when sweep is clean (no post-cutoff raw writes)', () => {
    mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
    mkdirSync(join(projectRoot, '.cleo/adrs'), { recursive: true });
    writeFileSync(join(projectRoot, '.cleo/canon.yml'), CANON_YML);
    gitInit(projectRoot);
    writeFileSync(join(projectRoot, 'README.md'), '# placeholder\n');
    gitCommit(projectRoot, 'init');
    const cutoffSha = gitHead(projectRoot);
    // No post-cutoff commits at all — file list is empty.

    writeStub({ listAttachments: [], blobBySha: {} });

    const env = { ...process.env, PATH: `${stubBin}:${process.env.PATH}` };
    const result = spawnSync(
      'node',
      [
        SCRIPT,
        '--repo-root',
        projectRoot,
        '--cutoff',
        cutoffSha,
        '--out',
        join(sandbox, 'report.json'),
      ],
      { encoding: 'utf-8', env },
    );
    expect(result.status).toBe(0);
    const report = JSON.parse(readFileSync(join(sandbox, 'report.json'), 'utf-8'));
    expect(report.summary.totalFiles).toBe(0);
    expect(report.summary.unresolved).toBe(0);
  });

  it('classifies files removed after cutoff as deleted (informational only)', () => {
    mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
    mkdirSync(join(projectRoot, '.cleo/adrs'), { recursive: true });
    writeFileSync(join(projectRoot, '.cleo/canon.yml'), CANON_YML);
    gitInit(projectRoot);
    writeFileSync(join(projectRoot, 'README.md'), '# placeholder\n');
    gitCommit(projectRoot, 'init');
    const cutoffSha = gitHead(projectRoot);
    const addedPath = join(projectRoot, '.cleo/adrs/ADR-999-ephemeral.md');
    writeFileSync(addedPath, '# ephemeral\n');
    gitCommit(projectRoot, 'add ephemeral');
    // Now delete it (simulate post-add cleanup).
    rmSync(addedPath);
    gitCommit(projectRoot, 'remove ephemeral');

    writeStub({ listAttachments: [], blobBySha: {} });
    const env = { ...process.env, PATH: `${stubBin}:${process.env.PATH}` };
    const result = spawnSync(
      'node',
      [
        SCRIPT,
        '--repo-root',
        projectRoot,
        '--cutoff',
        cutoffSha,
        '--out',
        join(sandbox, 'report.json'),
      ],
      { encoding: 'utf-8', env },
    );
    // Deleted file does not count toward unresolved → exit 0.
    expect(result.status).toBe(0);
    const report = JSON.parse(readFileSync(join(sandbox, 'report.json'), 'utf-8'));
    expect(report.summary.deleted).toBe(1);
    expect(report.summary.unresolved).toBe(0);
  });
});
