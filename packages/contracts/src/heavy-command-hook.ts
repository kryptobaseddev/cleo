/**
 * Heavy-command provider hook — shared types.
 *
 * CLEO ships a pre-exec hook for agent harnesses (Claude Code, Codex, Kimi,
 * opencode) that recognises heavy shell commands (test runners, compilers,
 * builds, installs) and routes them through `cleo run`, so every agent on the
 * machine shares the ResourceGovernor's one budget. The planner lives in
 * `@cleocode/core` (`resources/heavy-command`, on top of `resources/run-class`),
 * the provider wire formats and the entry point (`cleo hook heavy-command`) in
 * `@cleocode/cleo` (`cli/hook-entry`), and the per-provider installers in
 * `@cleocode/adapters` (`providers/shared/heavy-command-hook-install`).
 *
 * @task T12983
 * @epic T12978
 */

/**
 * How the hook treats a recognised heavy command.
 *
 * - `rewrite` — DEFAULT. Wrap it in place as
 *   `cleo run --wait --passthrough --class <c> -- <cmd>`, when the harness
 *   runs in `bypassPermissions` or `auto` mode and no deny or ask rule names
 *   the command (otherwise the hook warns: a rewrite would change which
 *   permission rules match).
 * - `warn` — leave the command alone; add a context line naming the governed
 *   form.
 * - `off` — do nothing (the installer also removes the hook entry).
 *
 * Set by the `CLEO_HEAVY_COMMAND_HOOK` environment variable or the
 * `resources.heavyCommandHook` config key (the variable wins).
 */
export type HeavyCommandHookMode = 'rewrite' | 'warn' | 'off';

/** The harnesses `cleo hook heavy-command --provider <p>` answers for. */
export type HeavyCommandHookProvider = 'claude-code' | 'codex' | 'kimi' | 'opencode';

/** One heavy command found in a shell command line. */
export interface HeavyCommandSegment {
  /** The list element exactly as written (a simple command or a pipeline). */
  readonly text: string;
  /** The `cleo run --class` value: `test`, `build`, `full-build` or `db`. */
  readonly runClass: string;
  /** The element with `cleo run --wait --passthrough … --` inserted before the heavy command. */
  readonly governed: string;
  /** The heavy command's own words (quotes removed), command word first. */
  readonly argv: readonly string[];
}

/**
 * What the planner decided for one shell command line.
 *
 * - `none` — nothing heavy (or already governed): leave it alone.
 * - `rewrite` — `command` is the whole line with every heavy command wrapped
 *   in place; every other byte is unchanged.
 * - `warn` — heavy, but rewriting could change what the line does (a heavy
 *   command inside `$(…)`, a subshell, a compound command, a background job,
 *   reading a heredoc, or sharing a pipeline with another heavy command), or
 *   the hook may not rewrite here; `reason` says which.
 */
export type HeavyCommandPlan =
  | { readonly action: 'none' }
  | {
      readonly action: 'rewrite';
      readonly command: string;
      readonly segments: readonly HeavyCommandSegment[];
    }
  | {
      readonly action: 'warn';
      readonly reason: string;
      readonly segments: readonly HeavyCommandSegment[];
    };

/** A JSON value as a hook receives it on stdin. */
export type HookJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly HookJsonValue[]
  | { readonly [key: string]: HookJsonValue };

/**
 * A shell tool's input: Claude Code and Codex `Bash`, Kimi `Shell`, opencode
 * `bash`. Every harness carries the command line in `command`; the other
 * fields (`timeout`, `description`, `run_in_background`, …) vary.
 */
export interface ShellToolInput {
  /** The shell command line the agent wants to run. */
  readonly command: string;
  /** Harness-specific fields, passed back unchanged unless noted. */
  readonly [field: string]: HookJsonValue;
}

/**
 * The fields of a `PreToolUse` hook's stdin JSON the heavy-command hook reads.
 * Claude Code, Codex and Kimi send this shape; CLEO's generated opencode
 * plugin sends the same fields.
 */
export interface PreToolUseHookInput {
  readonly hook_event_name?: string;
  /** `Bash` (Claude Code, Codex), `Shell` (Kimi), `bash` (opencode). */
  readonly tool_name?: string;
  readonly tool_input?: ShellToolInput;
  /** The session's working directory. */
  readonly cwd?: string;
  /** Claude Code and Codex: `default`, `plan`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`. */
  readonly permission_mode?: string;
}

/** The answer `cleo hook heavy-command --provider opencode` prints for CLEO's opencode plugin. */
export interface OpencodeHeavyCommandAnswer {
  /** Replacement for `output.args.command`, when the command was rewritten. */
  readonly command?: string;
  /** Replacement for `output.args.timeout` (ms): the old one plus the queue wait. */
  readonly timeout?: number;
  /** What the hook tells the agent; the plugin appends it to the tool's output. */
  readonly context?: string;
}

/**
 * The Claude-style `PreToolUse` hook answer on stdout. Claude Code, Codex and
 * Kimi share this shape (each honours a different subset of it).
 */
export interface PreToolUseHookOutput {
  readonly hookSpecificOutput: {
    readonly hookEventName: 'PreToolUse';
    /** Omitted unless the provider requires it (Codex rewrites need `allow`). */
    readonly permissionDecision?: 'allow' | 'deny';
    /** Shown to the agent on `deny`. */
    readonly permissionDecisionReason?: string;
    /** Replaces the whole tool input. */
    readonly updatedInput?: ShellToolInput;
    /** Added to the agent's context alongside the tool result. */
    readonly additionalContext?: string;
  };
}
