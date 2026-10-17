#!/usr/bin/env node
/**
 * One release PR, scripted end to end (T13825).
 *
 *   node scripts/release-run.mjs <version> (--epic <id> | --tasks <ids>) \
 *     --notes-review <file> [--operator <name>] [--execute]
 *
 * Runs plan -> notes review -> plan branch -> prepare -> wait -> version-only
 * assert -> merge -> tag with no manual handoff, keeping every check the
 * manual flow had:
 *
 *  1. `cleo release plan` writes `.cleo/release/<v>.plan.json` and the
 *     CHANGELOG section (skipped when the plan file already exists).
 *  2. Independent review of the notes: `--notes-review` is a JSON file
 *     `{ "reviewer": "<name>", "notesSha256": "<hex>", "approved": true }`
 *     written by someone other than `--operator`, for the exact notes in the
 *     plan. Without a matching review the run stops and prints the hash.
 *  3. `release/plan-<v>` is created through the GitHub git-data API: ONE commit
 *     on the default branch's HEAD holding the plan and CHANGELOG.md. Nothing
 *     is pushed to the default branch.
 *  4. `cleo release open <v> --ref release/plan-<v>` dispatches release-prepare
 *     there, so the bump PR (`release/<v>`) carries the plan and the bump.
 *  5. Waits for the prepare run, then for the dispatched `CI` run on the bump
 *     PR's exact head SHA.
 *  6. Asserts the PR is version-only against its merge-base with the default
 *     branch (`scripts/ci-detect-version-only.mjs`).
 *  7. Admin-merges with `--match-head-commit` (the one sanctioned `--admin`,
 *     docs/release/merge-queue-runbook.md) and appends the audit line to
 *     `.cleo/audit/force-bypass.jsonl`.
 *  8. Tags the merge commit explicitly (`git tag -a`) and pushes the tag.
 *
 * Dry run by default: every precondition is checked, every mutation is printed
 * and none is performed. `--execute` performs them. Each step is resumable: a
 * re-run finds the plan, branch, run, PR, merge and tag already there and
 * continues from the first step not yet done.
 *
 * @task T13825
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Poll interval while waiting on GitHub (ms). */
const POLL_MS = 30_000;

/** Longest wait for the prepare run, then for the bump PR's CI (ms). */
const WAIT_MS = 120 * 60_000;

/** The audit log every admin-merge appends to. */
export const AUDIT_LOG = '.cleo/audit/force-bypass.jsonl';

/**
 * Parse the command line.
 *
 * @param {string[]} argv
 * @returns {{ version: string, epic?: string, tasks?: string, notesReview?: string, operator?: string, execute: boolean }}
 */
export function parseArgs(argv) {
  const out = { execute: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--execute') out.execute = true;
    else if (a === '--epic') out.epic = take();
    else if (a === '--tasks') out.tasks = take();
    else if (a === '--notes-review') out.notesReview = take();
    else if (a === '--operator') out.operator = take();
    else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`);
    else rest.push(a);
  }
  if (rest.length !== 1) throw new Error('exactly one <version> is required');
  const version = rest[0].startsWith('v') ? rest[0] : `v${rest[0]}`;
  if (!/^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) {
    throw new Error(`not a release version: ${rest[0]}`);
  }
  if ((out.epic === undefined) === (out.tasks === undefined)) {
    throw new Error('pass exactly one of --epic or --tasks');
  }
  return { ...out, version };
}

/**
 * sha256 of the release notes a plan carries (`meta.releaseNotes`).
 *
 * @param {unknown} plan - Parsed plan file.
 * @returns {string | null} Hex digest, or null when the plan has no notes.
 */
export function notesSha256(plan) {
  const notes = plan?.meta?.releaseNotes;
  if (typeof notes !== 'string' || notes.trim() === '') return null;
  return createHash('sha256').update(notes).digest('hex');
}

/**
 * Check an independent review of the notes.
 *
 * @param {string | null} sha - {@link notesSha256} of the plan.
 * @param {unknown} review - Parsed `--notes-review` file, or undefined.
 * @param {string} operator - Who runs the release.
 * @returns {string | null} Why the review does not hold, or null when it does.
 */
export function reviewProblem(sha, review, operator) {
  if (sha === null) return 'the plan has no meta.releaseNotes to review';
  if (review === undefined) return 'no --notes-review file was given';
  if (typeof review !== 'object' || review === null) return 'the review file is not a JSON object';
  if (review.approved !== true) return 'the review does not approve the notes';
  if (typeof review.reviewer !== 'string' || review.reviewer.trim() === '') {
    return 'the review names no reviewer';
  }
  if (review.reviewer.trim() === operator.trim()) {
    return `the reviewer (${review.reviewer}) is the operator; the review must be independent`;
  }
  if (review.notesSha256 !== sha) {
    return `the review is for notes ${review.notesSha256}, but the plan's notes are ${sha}`;
  }
  return null;
}

/**
 * A `.cleo/audit/force-bypass.jsonl` line for the bump-PR admin-merge.
 *
 * Two phases (T13839): `intent` is written BEFORE `gh pr merge --admin` runs,
 * naming the head it may merge, so a merge whose `gh` call dies after the
 * server merged still leaves a record; `merged` is written once the PR is
 * MERGED, with the merge commit. The notes review is an attestation, not a
 * verified signature, so the line says "attested by" and carries the sha256
 * of the review file as given.
 *
 * @param {{ ts: string, phase: 'intent' | 'merged', pr: number, head: string, merge: string | null, version: string, operator: string, reviewer: string, reviewSha256: string, ciRun: string }} f
 * @returns {string} One JSON line, newline-terminated.
 */
export function auditLine(f) {
  return `${JSON.stringify({
    ts: f.ts,
    pr: f.pr,
    kind: 'admin-merge-release-bump',
    phase: f.phase,
    head: f.head,
    merge: f.merge,
    operator: f.operator,
    reason: `release bump-PR ${f.version}: dispatched CI green on ${f.head} (${f.ciRun}); version-only diff asserted; notes attested by ${f.reviewer} (review file sha256 ${f.reviewSha256}) (scripts/release-run.mjs, T13825)`,
  })}\n`;
}

/**
 * Whether the audit log already holds a release-bump line of `phase` for `pr`.
 *
 * @param {string} logPath - Path to `.cleo/audit/force-bypass.jsonl`.
 * @param {number} pr
 * @param {'intent' | 'merged'} phase
 * @returns {boolean}
 */
export function hasAuditLine(logPath, pr, phase) {
  if (!existsSync(logPath)) return false;
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .some((line) => {
      try {
        const row = JSON.parse(line);
        return row.kind === 'admin-merge-release-bump' && row.pr === pr && row.phase === phase;
      } catch {
        return false;
      }
    });
}

/**
 * Read `version_only=<bool>` from `ci-detect-version-only.mjs` output.
 *
 * @param {string} output
 * @returns {boolean}
 */
export function isVersionOnly(output) {
  return /^version_only=true\b/m.test(output);
}

/** Thrown to stop the run with a message and exit code, not a stack. */
class Stop extends Error {
  /**
   * @param {string} message
   * @param {number} [code]
   */
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

/**
 * Run the release.
 *
 * @param {ReturnType<typeof parseArgs>} opts
 * @param {{ root: string, exec: (cmd: string, args: string[], input?: string) => string, sleep: (ms: number) => void, now: () => number, log: (line: string) => void }} io
 * @returns {void}
 */
export function runRelease(opts, io) {
  const { version, execute } = opts;
  const sh = (cmd, args, input) => io.exec(cmd, args, input).trim();
  const gh = (...args) => sh('gh', args);
  const mutate = (what, fn) => {
    if (!execute) {
      io.log(`[dry-run] would ${what}`);
      return undefined;
    }
    io.log(`-> ${what}`);
    return fn();
  };
  const waitFor = (what, probe) => {
    const until = io.now() + WAIT_MS;
    for (;;) {
      const r = probe();
      if (r !== undefined) return r;
      if (io.now() >= until) throw new Stop(`timed out waiting for ${what}`);
      io.sleep(POLL_MS);
    }
  };

  const branch = gh('repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name');
  const operator = opts.operator ?? sh('git', ['config', 'user.name']);
  const planRel = `.cleo/release/${version}.plan.json`;
  const planBranch = `release/plan-${version}`;
  const bumpBranch = `release/${version}`;
  const scope = opts.epic !== undefined ? ['--epic', opts.epic] : ['--tasks', opts.tasks];

  // ── 1. plan ──
  sh('git', ['fetch', '--quiet', 'origin', branch]);
  const head = sh('git', ['rev-parse', 'HEAD']);
  const base = sh('git', ['rev-parse', `origin/${branch}`]);
  const planPath = join(io.root, planRel);
  const planExists = existsSync(planPath);
  const remotePlanBranch = gh(
    'api',
    `repos/{owner}/{repo}/git/matching-refs/heads/${planBranch}`,
    '--jq',
    `.[] | select(.ref == "refs/heads/${planBranch}") | .object.sha`,
  );
  if (remotePlanBranch === '') {
    // The plan commit is built from this checkout, so it must BE the default
    // branch's HEAD, changed only by the plan's CHANGELOG section.
    if (head !== base) {
      throw new Stop(
        `this checkout is at ${head}, not origin/${branch} (${base}); check out origin/${branch} first`,
      );
    }
    // Untrimmed: porcelain's status column can start with a space.
    const dirty = io
      .exec('git', ['status', '--porcelain', '--untracked-files=no'])
      .split('\n')
      .filter(Boolean)
      .filter((l) => l.slice(3) !== 'CHANGELOG.md');
    if (dirty.length > 0)
      throw new Stop(`tracked files other than CHANGELOG.md are modified: ${dirty.join(', ')}`);
  }
  if (!planExists) {
    if (remotePlanBranch !== '')
      throw new Stop(`${planBranch} exists but ${planRel} is missing here`);
    mutate(`cleo release plan ${version} ${scope.join(' ')}`, () =>
      sh('cleo', ['release', 'plan', version, ...scope]),
    );
  }
  if (!execute && !existsSync(planPath)) {
    io.log('[dry-run] stopping before the notes review: no plan file yet');
    return;
  }

  // ── 2. independent review of the notes ──
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const sha = notesSha256(plan);
  const reviewBytes = opts.notesReview === undefined ? undefined : readFileSync(opts.notesReview);
  const review = reviewBytes === undefined ? undefined : JSON.parse(reviewBytes.toString('utf8'));
  const reviewSha256 =
    reviewBytes === undefined ? '' : createHash('sha256').update(reviewBytes).digest('hex');
  const problem = reviewProblem(sha, review, operator);
  if (problem !== null) {
    throw new Stop(
      `notes review: ${problem}. Have someone other than ${operator} review the notes in ${planRel} (sha256 ${sha}) and write {"reviewer","notesSha256","approved":true} to a file passed as --notes-review.`,
      3,
    );
  }
  io.log(`notes ${sha} attested by ${review.reviewer} (review file sha256 ${reviewSha256})`);

  // ── 3. plan branch: one commit on the default branch's HEAD ──
  if (remotePlanBranch === '') {
    const numstat = sh('git', ['diff', '--numstat', 'HEAD', '--', 'CHANGELOG.md']);
    if (numstat === '' || numstat.split(/\s+/)[1] !== '0') {
      throw new Stop(
        "CHANGELOG.md must differ from HEAD by added lines only (the plan's release section)",
      );
    }
    mutate(`create ${planBranch} = ${base} + ${planRel} + CHANGELOG.md`, () => {
      const blob = (path) =>
        JSON.parse(
          io.exec(
            'gh',
            ['api', '-X', 'POST', 'repos/{owner}/{repo}/git/blobs', '--input', '-'],
            JSON.stringify({
              content: readFileSync(join(io.root, path)).toString('base64'),
              encoding: 'base64',
            }),
          ),
        ).sha;
      const baseTree = gh('api', `repos/{owner}/{repo}/git/commits/${base}`, '--jq', '.tree.sha');
      const tree = JSON.parse(
        io.exec(
          'gh',
          ['api', '-X', 'POST', 'repos/{owner}/{repo}/git/trees', '--input', '-'],
          JSON.stringify({
            base_tree: baseTree,
            tree: [planRel, 'CHANGELOG.md'].map((path) => ({
              path,
              mode: '100644',
              type: 'blob',
              sha: blob(path),
            })),
          }),
        ),
      ).sha;
      const commit = JSON.parse(
        io.exec(
          'gh',
          ['api', '-X', 'POST', 'repos/{owner}/{repo}/git/commits', '--input', '-'],
          JSON.stringify({ message: `release: plan ${version}`, tree, parents: [base] }),
        ),
      ).sha;
      io.exec(
        'gh',
        ['api', '-X', 'POST', 'repos/{owner}/{repo}/git/refs', '--input', '-'],
        JSON.stringify({ ref: `refs/heads/${planBranch}`, sha: commit }),
      );
    });
  } else {
    io.log(`${planBranch} exists at ${remotePlanBranch}; release open verifies its plan bytes`);
  }

  // ── 4. prepare, on the plan branch ──
  const opened = mutate(`cleo release open ${version} --ref ${planBranch}`, () =>
    JSON.parse(sh('cleo', ['release', 'open', version, '--ref', planBranch, ...scope])),
  );
  if (!execute) {
    io.log(
      '[dry-run] would wait for release-prepare, the bump PR CI, assert version-only, merge and tag',
    );
    return;
  }
  if (opened?.success !== true)
    throw new Stop(`release open failed: ${JSON.stringify(opened?.error ?? opened)}`);
  const runId = String(opened.data.workflowRunUrl).split('/').pop();

  // ── 5. wait: prepare, then the bump PR's CI on its exact head ──
  waitFor(`release-prepare run ${runId}`, () => {
    const r = JSON.parse(gh('run', 'view', runId, '--json', 'status,conclusion'));
    if (r.status !== 'completed') return undefined;
    if (r.conclusion !== 'success')
      throw new Stop(`release-prepare run ${runId} concluded ${r.conclusion}`);
    return true;
  });
  const pr = JSON.parse(
    gh(
      'pr',
      'list',
      '--head',
      bumpBranch,
      '--state',
      'all',
      '--json',
      'number,headRefOid,state',
      '--jq',
      '.[0]',
    ) || 'null',
  );
  if (pr === null) throw new Stop(`no bump PR from ${bumpBranch}`);
  const ciRun = waitFor(`CI on ${pr.headRefOid}`, () => {
    const runs = JSON.parse(
      gh(
        'run',
        'list',
        '--workflow',
        'ci.yml',
        '--branch',
        bumpBranch,
        '--event',
        'workflow_dispatch',
        '--json',
        'headSha,status,conclusion,url',
      ),
    );
    const run = runs.find((r) => r.headSha === pr.headRefOid);
    if (run === undefined || run.status !== 'completed') return undefined;
    if (run.conclusion !== 'success')
      throw new Stop(`CI on the bump PR head concluded ${run.conclusion} (${run.url})`);
    return run.url;
  });

  // ── 6. version-only assert, against the merge-base ──
  sh('git', ['fetch', '--quiet', 'origin', branch, bumpBranch]);
  const mergeBase = sh('git', ['merge-base', `origin/${branch}`, pr.headRefOid]);
  const verdict = io.exec('node', ['scripts/ci-detect-version-only.mjs', mergeBase, pr.headRefOid]);
  if (!isVersionOnly(verdict))
    throw new Stop(`bump PR #${pr.number} is not version-only: ${verdict.trim()}`);
  io.log(verdict.trim());

  // ── 7. merge (audited) ──
  let state = JSON.parse(
    gh('pr', 'view', String(pr.number), '--json', 'state,mergeCommit,headRefOid'),
  );
  const logPath = join(io.root, AUDIT_LOG);
  const audit = (phase, head, merge) => {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(
      logPath,
      auditLine({
        ts: new Date(io.now()).toISOString(),
        phase,
        pr: pr.number,
        head,
        merge,
        version,
        operator,
        reviewer: review.reviewer,
        reviewSha256,
        ciRun,
      }),
    );
  };
  if (state.state !== 'MERGED') {
    if (state.headRefOid !== pr.headRefOid)
      throw new Stop(`bump PR #${pr.number} moved to ${state.headRefOid} after CI was checked`);
    // T13839: the intent goes on record before the irreversible call.
    audit('intent', pr.headRefOid, null);
    let mergeError = null;
    try {
      gh(
        'pr',
        'merge',
        String(pr.number),
        '--admin',
        '--merge',
        '--match-head-commit',
        pr.headRefOid,
      );
    } catch (err) {
      // gh can exit non-zero after the server merged; the state decides.
      mergeError = err;
    }
    state = JSON.parse(
      gh('pr', 'view', String(pr.number), '--json', 'state,mergeCommit,headRefOid'),
    );
    if (state.state !== 'MERGED') {
      throw new Stop(
        `bump PR #${pr.number} is ${state.state} after merge${mergeError ? `: ${mergeError instanceof Error ? mergeError.message : String(mergeError)}` : ''}`,
      );
    }
  }
  // T13839: also on a resumed run, a MERGED PR gets its line if it has none.
  if (!hasAuditLine(logPath, pr.number, 'merged')) {
    audit('merged', state.headRefOid, state.mergeCommit.oid);
  }
  const merge = state.mergeCommit.oid;

  // ── 8. explicit tag on the merge commit ──
  const remoteTag = gh(
    'api',
    `repos/{owner}/{repo}/git/matching-refs/tags/${version}`,
    '--jq',
    `.[] | select(.ref == "refs/tags/${version}") | .object.sha`,
  );
  if (remoteTag !== '') {
    io.log(`tag ${version} already exists on origin; not re-tagging`);
    return;
  }
  sh('git', ['fetch', '--quiet', 'origin', branch]);
  sh('git', ['tag', '-a', version, '-m', `Release ${version}`, merge]);
  sh('git', ['push', 'origin', `refs/tags/${version}`]);
  io.log(`tagged ${version} at ${merge}; release.yml publishes from the tag`);
}

/* c8 ignore start */
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    runRelease(opts, {
      root,
      exec: (cmd, args, input) =>
        execFileSync(cmd, args, {
          cwd: root,
          encoding: 'utf8',
          input,
          maxBuffer: 64 * 1024 * 1024,
        }),
      sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
      now: Date.now,
      log: (line) => process.stdout.write(`${line}\n`),
    });
  } catch (err) {
    process.stderr.write(`release-run: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(err instanceof Stop ? err.code : 1);
  }
}
/* c8 ignore stop */
