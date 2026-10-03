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
 *   runs in `bypassPermissions` or `auto` mode, or (Claude Code `default`,
 *   `acceptEdits`, `dontAsk`) when the user's allow rules already approve the
 *   command, and no deny or ask rule names it. Otherwise the hook warns: a
 *   rewrite would change which permission rules match.
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
    /**
     * Omitted unless needed: Codex rewrites need `allow`, Kimi's "re-run it"
     * is a `deny`, and a Claude Code rewrite carries `allow` only when the
     * user's allow rules already approve the original command (T13124).
     */
    readonly permissionDecision?: 'allow' | 'deny';
    /** Shown to the agent on `deny`; written to Claude Code's debug log on `allow`. */
    readonly permissionDecisionReason?: string;
    /** Replaces the whole tool input. */
    readonly updatedInput?: ShellToolInput;
    /** Added to the agent's context alongside the tool result. */
    readonly additionalContext?: string;
  };
}

// ---------------------------------------------------------------------------
// Project-level delivery (T13124)
// ---------------------------------------------------------------------------

/**
 * What delivering the hook to one provider did in one project.
 *
 * - `installed` / `updated` / `removed` / `unchanged` — the config file was
 *   written, refreshed, cleaned (mode `off`) or already current.
 * - `skipped` — not applicable: the provider is not in use on this machine or
 *   project, or the project is the user's home directory (whose provider
 *   configs are user-global, which CLEO never writes).
 * - `blocked` — a path the hook must live under exists but is not a
 *   directory (a stray `.codex` file, say); nothing was written.
 * - `unsupported` — the provider cannot take a project-level hook (Kimi reads
 *   hooks only from its global config).
 * - `needs-consent` — the config is the project's own (Codex's committable
 *   `.codex/hooks.json`, tracked or holding anything CLEO did not write), so
 *   CLEO does not write or hide it; `snippet` is the entry to add by hand.
 * - `failed` — any other error, such as a config file that is not valid JSON
 *   (left untouched).
 */
export type HeavyHookDeliveryStatus =
  | 'installed'
  | 'updated'
  | 'removed'
  | 'unchanged'
  | 'skipped'
  | 'blocked'
  | 'unsupported'
  | 'needs-consent'
  | 'failed';

/** One provider's result from syncing the hook into a project. */
export interface HeavyHookDeliveryOutcome {
  /** The harness. */
  readonly provider: HeavyCommandHookProvider;
  /** What the sync did. */
  readonly status: HeavyHookDeliveryStatus;
  /** The config file (or plugin file) the hook lives in, absolute. */
  readonly target: string;
  /** Why it was skipped, blocked, unsupported or failed. */
  readonly reason?: string;
  /** The exact step that fixes a `blocked`, `unsupported`, `needs-consent` or `failed` outcome. */
  readonly remedy?: string;
  /** `needs-consent`: the exact JSON entry to add to the config by hand. */
  readonly snippet?: string;
}

/**
 * The hook's state for one provider in one project, as `cleo doctor` reports it.
 *
 * - `installed` — present and identical to what this CLEO would write.
 * - `outdated` — present but written by another CLEO build, only in a legacy
 *   location, or visible to git as an untracked file (gh#1805: it widens
 *   `cleo verify`'s evidence scope); `cleo upgrade` refreshes it.
 * - `missing` — the provider is in use and the hook is absent.
 * - `blocked` — see {@link HeavyHookDeliveryStatus}.
 * - `unreadable` — the config file exists but cannot be read or parsed.
 * - `unsupported` — the provider cannot take a project-level hook.
 * - `needs-consent` — see {@link HeavyHookDeliveryStatus}; `snippet` holds the entry.
 * - `disabled` — `resources.heavyCommandHook` is `off`, and no CLEO hook is left.
 * - `not-detected` — the provider is not in use here; nothing is expected.
 */
export type HeavyHookInstallState =
  | 'installed'
  | 'outdated'
  | 'missing'
  | 'blocked'
  | 'unreadable'
  | 'unsupported'
  | 'needs-consent'
  | 'disabled'
  | 'not-detected';

/** One provider's hook state in one project. */
export interface HeavyHookInspection {
  /** The harness. */
  readonly provider: HeavyCommandHookProvider;
  /** Whether the provider is in use on this machine or in this project. */
  readonly detected: boolean;
  /** The hook's state. */
  readonly state: HeavyHookInstallState;
  /** The config file (or plugin file) the hook lives in, absolute. */
  readonly target: string;
  /** One line saying what was found. */
  readonly detail: string;
  /** The exact step that fixes the state, when one is needed. */
  readonly remedy?: string;
  /** `needs-consent`: the exact JSON entry to add to the config by hand. */
  readonly snippet?: string;
}

/**
 * Whether the `cleo` a hook finds on PATH can answer it.
 *
 * - `current` — it answers `cleo hook heavy-command`.
 * - `older` — it predates `cleo hook` (and `cleo run`): the hook lets every
 *   command run ungoverned. The hook's own marker (exit 127, "Unknown
 *   command") or a direct probe says so.
 * - `missing` — no `cleo` on PATH: the hook stays silent.
 * - `unknown` — the probe failed some other way (a broken version-manager
 *   shim, a timeout, a crash). The hook fails open, so it governs nothing
 *   while this lasts.
 */
export type HeavyHookCliState = 'current' | 'older' | 'missing' | 'unknown';

/** The result of probing the `cleo` on PATH from a project directory. */
export interface HeavyHookCliProbe {
  /** What the probe found. */
  readonly state: HeavyHookCliState;
  /** The `cleo` the hook resolves on PATH, or `null`. */
  readonly path: string | null;
  /** One line saying what was found. */
  readonly detail: string;
  /** The exact step that fixes (or diagnoses) a CLI that is not `current`. */
  readonly remedy?: string;
}

/** Options for the project-level delivery functions (all injectable for tests). */
export interface HeavyHookDeliveryOptions {
  /** Environment for provider detection (`PATH`, `HOME`, `CODEX_HOME`, …). Default `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Providers to consider. Default: every provider CLEO knows. */
  readonly providers?: readonly HeavyCommandHookProvider[];
  /**
   * Inspection only: run the git checks (a hook file git can see, a shared
   * Codex `hooks.json`). Default `true`; the session briefing passes `false`
   * to skip their git spawns (`cleo doctor` keeps them).
   */
  readonly gitChecks?: boolean;
}

/**
 * The project-level delivery surface `@cleocode/adapters` exports at
 * `@cleocode/adapters/heavy-command-hook`. `@cleocode/core` loads it at run
 * time (adapters builds on core, so core cannot import it statically) for
 * `cleo init`, `cleo upgrade`, `cleo doctor` and the session briefing.
 */
export interface HeavyHookDeliveryApi {
  /**
   * Install, refresh or (mode `off`) remove CLEO's hook for every provider in
   * use, each independently. Never throws: every provider gets an outcome.
   */
  readonly syncProjectHeavyCommandHooks: (
    projectDir: string,
    mode: HeavyCommandHookMode,
    options?: HeavyHookDeliveryOptions,
  ) => Promise<readonly HeavyHookDeliveryOutcome[]>;
  /** Read-only: the hook's state for every provider. Never throws. */
  readonly inspectProjectHeavyCommandHooks: (
    projectDir: string,
    mode: HeavyCommandHookMode,
    options?: HeavyHookDeliveryOptions,
  ) => readonly HeavyHookInspection[];
  /**
   * Whether the `cleo` on PATH (as the hook resolves it from `projectDir`)
   * can answer the hook. Starts that `cleo` once. Never throws.
   */
  readonly probeHeavyHookCli: (
    projectDir: string,
    options?: HeavyHookDeliveryOptions,
  ) => HeavyHookCliProbe;
}
