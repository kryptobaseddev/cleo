/**
 * Branch-mutation denylist for the git-shim binary (T1118 L2).
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
  // Every-ref pushes: worktrees share refs, so --all pushes main and --mirror force-updates and deletes (T13533).
  {
    subcommand: 'push',
    flag: '--all',
    reason: 'agents MUST NOT push every branch — push your task branch only',
  },
  {
    subcommand: 'push',
    flag: '--mirror',
    reason: 'agents MUST NOT mirror-push — it force-updates and deletes remote refs',
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
  if (subcommand === 'push') {
    const spec = protectedPushRefspec(args);
    if (spec !== null) {
      return {
        subcommand: 'push',
        flag: spec,
        reason:
          'agents MUST NOT push to a protected branch (main/master) — push your task branch; the orchestrator merges through a PR',
      };
    }
  }
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

/** Branches a restricted role may never push to (T13522). */
export const PROTECTED_PUSH_BRANCHES: ReadonlySet<string> = new Set(['main', 'master']);

/**
 * The refspec of a `git push` that targets a protected branch, or `null`.
 * The first positional argument is the remote; each later one is a refspec
 * whose destination (`src:dst`, or the name itself) is checked, ignoring a
 * leading `+` and `refs/heads/`.
 *
 * @param args - The arguments after `push`.
 * @returns The offending refspec, or `null` when none targets a protected branch.
 * @example
 * ```ts
 * protectedPushRefspec(['origin', 'HEAD:main']); // 'HEAD:main'
 * protectedPushRefspec(['origin', 'task/T1']);   // null
 * ```
 * @task T13522
 */
export function protectedPushRefspec(args: readonly string[]): string | null {
  const positional = args.filter((a) => !a.startsWith('-'));
  for (const spec of positional.slice(1)) {
    const dst = spec.includes(':') ? spec.slice(spec.lastIndexOf(':') + 1) : spec;
    const branch = dst.replace(/^\+/, '').replace(/^refs\/heads\//, '');
    // A pattern destination (`refs/heads/*`) can match main: refuse it outright (T13535).
    if (PROTECTED_PUSH_BRANCHES.has(branch) || branch.includes('*')) return spec;
  }
  return null;
}

/** Git global options that take their value as the next argument. */
const GLOBAL_OPTIONS_WITH_VALUE = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--config-env',
  '--exec-path',
  '--list-cmds',
  '--attr-source',
]);

/**
 * Split a git argv into its subcommand and the arguments after it, skipping
 * the global options before the subcommand (`git -C dir -c k=v push …`), so
 * no global option hides a denied subcommand from the shim (T13533).
 *
 * @param argv - Arguments after `git`.
 * @returns The subcommand (or `undefined`) and its arguments.
 * @example
 * ```ts
 * splitGitArgv(['-C', '.', 'push', 'origin', 'main']); // { subcommand: 'push', args: ['origin', 'main'] }
 * ```
 * @task T13533
 */
export function splitGitArgv(argv: readonly string[]): {
  global: string[];
  subcommand: string | undefined;
  args: string[];
  /** A leading option this parser does not know: it may take a value, so the subcommand is uncertain. */
  unknownGlobal: string | null;
} {
  let i = 0;
  let unknownGlobal: string | null = null;
  while (i < argv.length) {
    const a = argv[i] as string;
    if (!a.startsWith('-')) break;
    if (!GLOBAL_OPTIONS_WITH_VALUE.has(a) && !GLOBAL_FLAGS.has(a) && !a.includes('=')) {
      unknownGlobal ??= a;
    }
    i += GLOBAL_OPTIONS_WITH_VALUE.has(a) ? 2 : 1;
  }
  return { global: argv.slice(0, i), subcommand: argv[i], args: argv.slice(i + 1), unknownGlobal };
}

/** Git global options that take no value. */
const GLOBAL_FLAGS = new Set([
  '-p',
  '-P',
  '--paginate',
  '--no-pager',
  '--bare',
  '--no-replace-objects',
  '--no-lazy-fetch',
  '--no-optional-locks',
  '--no-advice',
  '--literal-pathspecs',
  '--glob-pathspecs',
  '--noglob-pathspecs',
  '--icase-pathspecs',
  '-v',
  '--version',
  '-h',
  '--help',
  '--html-path',
  '--man-path',
  '--info-path',
]);

/**
 * The protected branches a `git push --dry-run --porcelain` would update.
 * Porcelain lines are `<flag>\t<from>:<to>\t<summary>`; a deletion has an
 * empty `<from>`. Up-to-date refs count too: the push named them.
 *
 * @param porcelain - The dry run's stdout.
 * @returns The protected destination refs found (e.g. `refs/heads/main`).
 * @example
 * ```ts
 * protectedPorcelainDestinations('To /r\n*\trefs/heads/x:refs/heads/main\t[new branch]\nDone\n');
 * // ['refs/heads/main']
 * ```
 * @task T13535
 */
export function protectedPorcelainDestinations(porcelain: string): string[] {
  return porcelainDestinations(porcelain).filter((dst) =>
    PROTECTED_PUSH_BRANCHES.has(dst.replace(/^refs\/heads\//, '')),
  );
}

/**
 * Every destination ref in `git push --porcelain` output.
 *
 * @param porcelain - The dry run's stdout.
 * @returns The destination refs, in order.
 * @task T13535
 */
export function porcelainDestinations(porcelain: string): string[] {
  const out: string[] = [];
  for (const line of porcelain.split('\n')) {
    const ref = line.split('\t')[1];
    if (ref === undefined || !ref.includes(':')) continue;
    out.push(ref.slice(ref.lastIndexOf(':') + 1));
  }
  return out;
}
