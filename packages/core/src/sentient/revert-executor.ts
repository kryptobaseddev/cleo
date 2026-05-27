/**
 * Revert Executor — squashed git revert + revert event write.
 *
 * Executes `git revert --no-edit --no-commit <range>` over the commit list
 * collected by {@link collectMergeCommits}, commits the result as a single
 * squashed revert commit, writes a `kind:'revert'` sentient event, and sets
 * the global pause flag via {@link pauseAllTiers}.
 *
 * ## Human-commit guard
 *
 * Before executing the revert, `detectHumanCommits` inspects each commit in
 * the range using `git log --format="%H %ae"`. Any commit whose author email
 * does NOT match the daemon's sentient identity pubkey prefix is flagged as
 * a human commit. When human commits are detected and `includeHuman = false`
 * (the default), the executor aborts with a descriptive error.
 *
 * ## Safety
 *
 * - `receiptId` and commit SHAs are passed as separate arguments to
 *   `child_process.spawn` — never shell-interpolated.
 * - The revert commit message is constructed in process; no user input is
 *   passed through to shell.
 *
 * @see DESIGN.md §8 T1012-S2
 * @task T1038
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { AgentIdentity } from 'llmtxt/identity';
import { isOwnerSigner } from './allowlist.js';
import { SENTIENT_STATE_FILE } from './daemon.js';
import type { MergeEvent } from './events.js';
import { appendSentientEvent } from './events.js';
import { pauseAllTiers } from './state.js';

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

/** Human commit detected in revert range when `includeHuman = false`. */
export const E_HUMAN_COMMIT_IN_RANGE = 'E_HUMAN_COMMIT_IN_RANGE';

/** The revert git operation itself failed (non-zero exit). */
export const E_REVERT_FAILED = 'E_REVERT_FAILED';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The sentient agent email used in commit authorship. */
export const SENTIENT_AUTHOR_EMAIL = 'sentient@cleocode';

/**
 * Options for {@link executeSquashedRevert}.
 */
export interface ExecuteSquashedRevertOptions {
  /** Absolute path to the project / git repository root. */
  cleoRoot: string;
  /** Commit SHAs to revert, oldest first (from {@link collectMergeCommits}). */
  commits: string[];
  /** The merge events corresponding to the commit list. */
  mergeEvents: MergeEvent[];
  /** The receiptId of the starting event (used in the commit message). */
  fromReceiptId: string;
  /** Signing identity for the revert sentient event. */
  identity: AgentIdentity;
  /**
   * When `true`, allows reverting a range that contains commits not authored
   * by the sentient agent. When `false` (default), aborts if any human commit
   * is detected.
   */
  includeHuman?: boolean;
}

/**
 * Result returned by {@link executeSquashedRevert}.
 */
export interface ExecuteSquashedRevertResult {
  /** The new squashed-revert commit SHA (HEAD after the revert commit). */
  revertCommitSha: string;
  /** The commit SHAs that were reverted. */
  revertedRange: string[];
  /** Whether any human commit was present (and was allowed via includeHuman). */
  humanCommitPresent: boolean;
  /** The receiptId of the `kind:'revert'` event written to the audit log. */
  revertEventReceiptId: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute a squashed git revert over the given commit list.
 *
 * Steps:
 * 1. Validate the commit list is non-empty.
 * 2. Check for human commits in the range; abort if found and `!includeHuman`.
 * 3. Run `git revert --no-edit --no-commit <sha_first>^..<sha_last>`.
 * 4. Run `git commit` with the canonical revert message.
 * 5. Capture the new HEAD SHA.
 * 6. Write a `kind:'revert'` sentient event.
 * 7. Set `pausedByRevert = true` via {@link pauseAllTiers}.
 *
 * @param opts - Revert options.
 * @returns The result including the new revert commit SHA.
 * @throws `E_HUMAN_COMMIT_IN_RANGE` if human commits are present and `!includeHuman`.
 * @throws `E_REVERT_FAILED` if the git revert or commit operation fails.
 *
 * @example
 * ```ts
 * const result = await executeSquashedRevert({
 *   cleoRoot: '/home/user/project',
 *   commits: ['sha1', 'sha2', 'sha3'],
 *   mergeEvents: [...],
 *   fromReceiptId: 'ABC123receiptId',
 *   identity,
 * });
 * console.log('Reverted to:', result.revertCommitSha);
 * ```
 */
export async function executeSquashedRevert(
  opts: ExecuteSquashedRevertOptions,
): Promise<ExecuteSquashedRevertResult> {
  const { cleoRoot, commits, fromReceiptId, identity, includeHuman = false } = opts;
  // opts.mergeEvents is reserved for future structured revert event payloads.

  if (commits.length === 0) {
    const err = new Error('No merge commits found starting from receipt ' + fromReceiptId);
    (err as NodeJS.ErrnoException).code = E_REVERT_FAILED;
    throw err;
  }

  // Step 0: Allowlist check — verify the requesting identity is an owner signer.
  // Non-blocking warning unless CLEO_STRICT_ALLOWLIST=1 is set.
  const signerBytes = Buffer.from(identity.pubkeyHex, 'hex');
  const signerAllowed = await isOwnerSigner(cleoRoot, signerBytes);
  if (!signerAllowed) {
    const reason = `signer-not-in-allowlist: pub=${identity.pubkeyHex.slice(0, 16)}...`;
    if (process.env['CLEO_STRICT_ALLOWLIST'] === '1') {
      const err = new Error(`Revert blocked: ${reason}. Set ownerPubkeys in .cleo/config.json.`);
      (err as NodeJS.ErrnoException).code = E_REVERT_FAILED;
      throw err;
    }
    process.stderr.write(
      `[revert-executor] Warning: ${reason} (set CLEO_STRICT_ALLOWLIST=1 to hard-reject)\n`,
    );
  }

  // Step 1: Detect human commits in the range.
  const humanCommits = await detectHumanCommits(cleoRoot, commits);
  const humanCommitPresent = humanCommits.length > 0;

  if (humanCommitPresent && !includeHuman) {
    const list = humanCommits.join(', ');
    const err = new Error(
      `Human commit(s) detected in revert range: ${list}. ` +
        `Use --include-human to allow reverting commits not authored by the sentient agent.`,
    );
    (err as NodeJS.ErrnoException).code = E_HUMAN_COMMIT_IN_RANGE;
    throw err;
  }

  if (humanCommitPresent) {
    process.stderr.write(
      `Warning: reverting range that includes human commit(s): ${humanCommits.join(', ')}\n`,
    );
  }

  const firstCommit = commits[0];
  const lastCommit = commits[commits.length - 1];

  // Step 2: git revert --no-edit --no-commit <firstCommit>^..<lastCommit>
  // We pass <firstCommit>^..<lastCommit> as two separate args to avoid shell interpolation.
  const revertRange = `${firstCommit}^..${lastCommit}`;
  await runGit(cleoRoot, ['revert', '--no-edit', '--no-commit', revertRange]);

  // Step 3: Compose and commit the squash message.
  const shortPubkey = identity.pubkeyHex.slice(0, 16);
  const commitLines = commits.map((sha) => `  ${sha}`).join('\n');
  const commitMessage =
    `revert(sentient): squash revert from ${fromReceiptId}\n\n` +
    `Reverts:\n${commitLines}\n\n` +
    `Owner-attested: ${shortPubkey}\n` +
    `Receipt chain: ${fromReceiptId}..HEAD\n\n` +
    `Co-authored-by: CLEO Sentient <${SENTIENT_AUTHOR_EMAIL}>`;

  await runGit(cleoRoot, [
    'commit',
    '--allow-empty',
    '-m',
    commitMessage,
    '--author',
    `CLEO Sentient <${SENTIENT_AUTHOR_EMAIL}>`,
  ]);

  // Step 4: Capture the new HEAD SHA.
  const newHeadSha = await getHeadSha(cleoRoot);

  // Step 5: Write kind:'revert' sentient event.
  const revertEvent = await appendSentientEvent(cleoRoot, identity, {
    kind: 'revert',
    experimentId: '',
    taskId: '',
    payload: {
      fromReceiptId,
      revertCommitSha: newHeadSha,
      revertedRange: commits,
      globalPauseSet: true,
    },
  });

  // Step 6: Pause all tiers.
  const statePath = join(cleoRoot, SENTIENT_STATE_FILE);
  await pauseAllTiers(statePath, revertEvent.receiptId);

  return {
    revertCommitSha: newHeadSha,
    revertedRange: commits,
    humanCommitPresent,
    revertEventReceiptId: revertEvent.receiptId,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Detect commits in the range whose author email is NOT the sentient agent email.
 *
 * Uses `git log <sha>^..<sha> --format="%H %ae"` to check each commit.
 *
 * @param cwd - Git repository root.
 * @param commits - List of commit SHAs (oldest first).
 * @returns SHAs of commits with non-sentient authorship.
 *
 * @internal
 */
async function detectHumanCommits(cwd: string, commits: string[]): Promise<string[]> {
  if (commits.length === 0) return [];

  const firstCommit = commits[0];
  const lastCommit = commits[commits.length - 1];
  const range = `${firstCommit}^..${lastCommit}`;

  let output: string;
  try {
    output = await runGitOutput(cwd, ['log', range, '--format=%H %ae']);
  } catch {
    // If git log fails (e.g. in a fresh repo), be conservative and return empty.
    return [];
  }

  const humanShas: string[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(' ');
    const sha = parts[0];
    const email = parts.slice(1).join(' ');
    if (email !== SENTIENT_AUTHOR_EMAIL) {
      humanShas.push(sha);
    }
  }
  return humanShas;
}

/**
 * Run a git command and capture stdout.
 *
 * All arguments are passed as separate items to `spawn` — never shell-interpolated.
 *
 * @internal
 */
function runGitOutput(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        const err = new Error(`git ${args[0]} failed (exit ${code}): ${stderr.trim()}`);
        (err as NodeJS.ErrnoException).code = E_REVERT_FAILED;
        reject(err);
      }
    });
    proc.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Run a git command (no output capture needed).
 *
 * @internal
 */
function runGit(cwd: string, args: string[]): Promise<void> {
  return runGitOutput(cwd, args).then(() => undefined);
}

/**
 * Get the current HEAD SHA.
 *
 * @internal
 */
async function getHeadSha(cwd: string): Promise<string> {
  const output = await runGitOutput(cwd, ['rev-parse', 'HEAD']);
  return output.trim();
}
