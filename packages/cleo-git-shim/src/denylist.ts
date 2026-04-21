/**
 * Branch-mutation denylist for the cleo-git-shim binary (T1118 L2).
 *
 * When CLEO_AGENT_ROLE is set to a restricted role (worker|lead|subagent),
 * any git invocation matching an entry in this list is rejected with exit 1
 * and a structured error on stderr.
 *
 * The allowlist is implicit: any subcommand NOT in the denylist passes through
 * to real git transparently.
 *
 * @task T1118
 * @task T1121
 */

import type { DeniedGitOp } from '@cleocode/contracts';

/**
 * Roles that are subject to the branch-mutation denylist.
 *
 * Orchestrators bypass the shim entirely.
 *
 * @task T1118
 * @task T1121
 */
export const RESTRICTED_ROLES = new Set(['worker', 'lead', 'subagent']);

/**
 * Branch-mutating git operations that are denied for restricted roles.
 *
 * Entries are matched against argv[1] (subcommand) and optional flags.
 * When a flag is present, BOTH the subcommand AND the flag must appear.
 *
 * @remarks
 * - `flag: undefined` means any invocation of the subcommand is denied.
 * - `flag: "--hard"` means only `git reset --hard` is denied; `git reset
 *   --soft` passes through.
 *
 * @task T1118
 * @task T1121
 */
export const GIT_OP_DENYLIST: ReadonlyArray<DeniedGitOp> = [
  // Branch-switching operations
  {
    subcommand: 'checkout',
    reason: 'agents MUST NOT switch branches — use the assigned worktree branch',
  },
  {
    subcommand: 'switch',
    reason: 'agents MUST NOT switch branches — use the assigned worktree branch',
  },

  // Branch mutation
  {
    subcommand: 'branch',
    flag: '-b',
    reason: 'agents MUST NOT create branches — the orchestrator manages branch lifecycle',
  },
  {
    subcommand: 'branch',
    flag: '-B',
    reason: 'agents MUST NOT create/reset branches — the orchestrator manages branch lifecycle',
  },
  {
    subcommand: 'branch',
    flag: '-D',
    reason: 'agents MUST NOT delete branches — the orchestrator manages branch lifecycle',
  },
  {
    subcommand: 'branch',
    flag: '-d',
    reason: 'agents MUST NOT delete branches — the orchestrator manages branch lifecycle',
  },
  {
    subcommand: 'branch',
    flag: '--delete',
    reason: 'agents MUST NOT delete branches — the orchestrator manages branch lifecycle',
  },
  {
    subcommand: 'branch',
    flag: '-m',
    reason: 'agents MUST NOT rename branches — the orchestrator manages branch lifecycle',
  },
  {
    subcommand: 'branch',
    flag: '-M',
    reason: 'agents MUST NOT rename branches — the orchestrator manages branch lifecycle',
  },
  {
    subcommand: 'branch',
    flag: '--move',
    reason: 'agents MUST NOT rename branches — the orchestrator manages branch lifecycle',
  },

  // Worktree operations (workers must not create/remove worktrees)
  {
    subcommand: 'worktree',
    flag: 'add',
    reason: 'agents MUST NOT create worktrees — the orchestrator manages worktree lifecycle',
  },
  {
    subcommand: 'worktree',
    flag: 'remove',
    reason: 'agents MUST NOT remove worktrees — the orchestrator manages worktree lifecycle',
  },
  {
    subcommand: 'worktree',
    flag: 'move',
    reason: 'agents MUST NOT move worktrees — the orchestrator manages worktree lifecycle',
  },
  {
    subcommand: 'worktree',
    flag: 'lock',
    reason: 'agents MUST NOT lock/unlock worktrees — the orchestrator manages worktree lifecycle',
  },
  {
    subcommand: 'worktree',
    flag: 'unlock',
    reason: 'agents MUST NOT lock/unlock worktrees — the orchestrator manages worktree lifecycle',
  },
  {
    subcommand: 'worktree',
    flag: 'prune',
    reason: 'agents MUST NOT prune worktrees — the orchestrator manages worktree lifecycle',
  },

  // Destructive reset
  {
    subcommand: 'reset',
    flag: '--hard',
    reason: 'agents MUST NOT hard-reset — create a new commit or use `git restore` instead',
  },
  {
    subcommand: 'reset',
    flag: '--merge',
    reason: 'agents MUST NOT merge-reset — create a new commit or use `git restore` instead',
  },
  {
    subcommand: 'reset',
    flag: '--keep',
    reason: 'agents MUST NOT keep-reset — create a new commit or use `git restore` instead',
  },

  // Clean operations
  {
    subcommand: 'clean',
    flag: '-f',
    reason: 'agents MUST NOT force-clean — use `git restore` for individual files',
  },
  {
    subcommand: 'clean',
    flag: '-fd',
    reason: 'agents MUST NOT force-clean directories — use `git restore` for individual files',
  },
  {
    subcommand: 'clean',
    flag: '-fdx',
    reason: 'agents MUST NOT force-clean directories including ignored files — unsafe for agents',
  },

  // Rebase (rewrites history)
  {
    subcommand: 'rebase',
    reason: "agents MUST NOT rebase — history rewriting is the orchestrator's responsibility",
  },

  // Stash pop/apply (applies stashed changes to working tree)
  {
    subcommand: 'stash',
    flag: 'pop',
    reason: 'agents MUST NOT pop stashes — use explicit git apply or cherry-pick instead',
  },
  {
    subcommand: 'stash',
    flag: 'apply',
    reason: 'agents MUST NOT apply stashes — use explicit git apply or cherry-pick instead',
  },

  // Direct ref manipulation
  {
    subcommand: 'update-ref',
    reason: 'agents MUST NOT directly manipulate refs — use commits instead',
  },

  // Force push
  {
    subcommand: 'push',
    flag: '-f',
    reason: 'agents MUST NOT force-push — the orchestrator manages push lifecycle',
  },
  {
    subcommand: 'push',
    flag: '--force',
    reason: 'agents MUST NOT force-push — the orchestrator manages push lifecycle',
  },
  {
    subcommand: 'push',
    flag: '--force-with-lease',
    reason: 'agents MUST NOT force-push — the orchestrator manages push lifecycle',
  },
];

/**
 * Determine whether a git invocation should be denied for a restricted role.
 *
 * @param subcommand - The git subcommand (argv[1]).
 * @param args - The remaining arguments (argv[2..]).
 * @returns The matching {@link DeniedGitOp} if denied, or null if allowed.
 */
export function findDeniedOp(subcommand: string, args: string[]): DeniedGitOp | null {
  for (const entry of GIT_OP_DENYLIST) {
    if (entry.subcommand !== subcommand) continue;

    if (entry.flag === undefined) {
      // Any invocation of this subcommand is denied.
      return entry;
    }

    // Check if the flag appears anywhere in the argument list.
    if (args.includes(entry.flag)) {
      return entry;
    }
  }
  return null;
}
