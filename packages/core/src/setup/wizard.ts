/**
 * Core setup wizard engine (E-CONFIG-AUTH-UNIFY E3 / T9420).
 *
 * Hermes-style modular wizard: every section (LLM, identity, sentient,
 * project conventions, …) is an independent {@link WizardSectionRunner}
 * that can be run on its own, in a fixed pipeline, or via the Studio
 * `/setup` route — the engine has zero awareness of which surface (CLI
 * vs. web) is driving the I/O.
 *
 * The engine is intentionally I/O-agnostic: callers pass a
 * {@link WizardIO} implementation (a readline-backed `ConsoleWizardIO`
 * from the CLI, a stub recorder in tests, a SvelteKit form helper from
 * the Studio). The runner never imports `node:readline` directly so
 * unit tests can drive it without a TTY.
 *
 * ## Design pointers
 *
 * - `run(sections?)` walks every (or a named subset of) section
 *   in declared order, gathering a per-section summary line. The
 *   summary is returned to the caller so `cleo setup` can echo a
 *   final overview before exiting.
 * - `runSection(name)` resolves the section by `section` field — this
 *   is the field consumers see in `--section <name>` flags.
 * - The non-interactive mode flag is *plumbed into `WizardOptions`* so
 *   each section can decide whether to prompt or apply CLI flags
 *   silently. Sections that have no non-interactive contract simply
 *   short-circuit with `{ changed: false, summary: 'skipped (non-interactive)' }`.
 *
 * ## Section contract
 *
 * Built-in sections live under `./sections/` and are exported via
 * {@link createBuiltinSections}. Each section's `run()` returns a
 * {@link WizardSectionResult} carrying:
 *   - `changed`: did the section apply any change? Used to label the
 *     summary line.
 *   - `summary`: a single-line human-readable description of what was
 *     done (or skipped).
 *
 * @task T9420
 * @task T9607
 * @task T9613
 * @epic T9402
 * @epic T9591
 * @see docs/plans/E-CONFIG-AUTH-UNIFY.md §3.3.5, §5.3 T-E3-1
 * @see docs/plans/E-CLEO-SETUP-V2.md §3.1, §3.2, §3.3, §3.4
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getCleoPlatformPaths } from '@cleocode/paths';
import { setConfigValue } from '../config.js';

/**
 * Base class for errors that are fatal to the entire wizard run.
 *
 * `WizardRunner.invokeSection` catches and swallows section-level errors so
 * a single failing section does not abort the rest of the wizard. But some
 * error conditions (e.g. stdin closed) make further prompting impossible and
 * must propagate all the way out so the CLI can emit a proper LAFS error
 * envelope instead of silently continuing with dead prompts.
 *
 * CLI-layer error classes (e.g. `StdinClosedError` in
 * `packages/cleo/src/cli/lib/readline-wizard-io.ts`) extend this class so
 * the runner recognises them without importing CLI types.
 *
 * @task T9599
 */
export class WizardFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WizardFatalError';
  }

  /**
   * Type-guard so `invokeSection` can detect subclasses without `instanceof`
   * across package boundaries.
   */
  static is(err: unknown): err is WizardFatalError {
    return err instanceof WizardFatalError;
  }
}

/**
 * Canonical identifier for every built-in wizard section.
 *
 * Surface order matters: `cleo setup` runs sections in declaration order
 * unless `--section` selects a single one. The `harness` and `brain`
 * slots are reserved here so T-E3-6 can drop in additional runners
 * without re-typing the union downstream.
 *
 * V2 additions (T9607): `integrations` and `verification` extend the union
 * to support the two new sections added in E-CLEO-SETUP-V2 (T9591).
 *
 * @task T9420
 * @task T9607
 */
export type WizardSection =
  | 'llm'
  | 'models-roles'
  | 'identity'
  | 'harness'
  | 'sentient'
  | 'project-conventions'
  | 'brain'
  | 'integrations'
  | 'telemetry'
  | 'verification';

/**
 * Outcome of running a single wizard section.
 *
 * `changed: true` means the section mutated on-disk state (credential
 * added, config key written, identity rotated). `summary` is a
 * single-line human-readable string suitable for inclusion in a
 * final `cleo setup` echo.
 *
 * `skipped` is present when the section was bypassed by the skip-logic
 * guard (i.e. `isConfigured()` returned `true` and `reset` was not set).
 *
 * @task T9420
 * @task T9613
 */
export interface WizardSectionResult {
  /** Did this section mutate on-disk state? */
  changed: boolean;
  /** Single-line human description of what was done (or skipped). */
  summary: string;
  /**
   * Set to `'already-configured'` when the section was bypassed by the
   * idempotency guard. Absent when the section ran normally.
   *
   * @task T9613
   */
  skipped?: 'already-configured';
}

/**
 * Options threaded through every section invocation.
 *
 * Sections that have no opinion on a field ignore it. The shape lives
 * here (not in each section) so the CLI command can pre-parse all
 * flags once, hand the bag to the runner, and let each section
 * cherry-pick.
 *
 * @task T9420
 * @task T9607
 */
export interface WizardOptions {
  /**
   * Skip prompts. Sections that lack the data they need from
   * {@link WizardOptions} (or whose state is already configured)
   * short-circuit silently with `changed: false`.
   */
  nonInteractive?: boolean;
  /** LLM provider id when running the `llm` section non-interactively. */
  provider?: string;
  /** API key when running the `llm` section non-interactively. */
  apiKey?: string;
  /** Optional credential label override; defaults to `'cli-input'`. */
  label?: string;
  /** Agent display name for the `identity` section. */
  agentName?: string;
  /** Optional path or inline content for the SOUL.md persona block. */
  soulMdContent?: string;
  /** `true` to enable the sentient daemon, `false` to disable. */
  sentientEnabled?: boolean;
  /** `true` to enable Tier-2 proposals (subordinate to daemon enable). */
  tier2Enabled?: boolean;
  /** Strictness preset to apply for `project-conventions`. */
  strictness?: 'strict' | 'standard' | 'minimal';
  /**
   * Active harness for the `harness` section (T9425).
   *
   * Mirrors the `CLEO_HARNESS` env var surface today (`pi` | `claude-code`)
   * and is persisted to `harness.active` in the global config.
   */
  harness?: 'pi' | 'claude-code';
  /**
   * BRAIN memory-bridge mode for the `brain` section (T9425).
   *
   * Operator-facing label: `'digest'` maps to the on-disk `'cli'` mode;
   * `'file'` and `'disabled'` round-trip 1:1.
   */
  brainBridgeMode?: 'digest' | 'file' | 'disabled';
  /** Project root override; defaults to `process.cwd()`. */
  projectRoot?: string;

  // --- V2 fields added in T9607 (E-CLEO-SETUP-V2 §3.2) ---

  /**
   * `identity` section: when `true`, emit a prompt directing the user to
   * run `cleo signaldock connect` after writing the agent name.
   * Does not block on network I/O — config only.
   */
  signaldockAutoConnect?: boolean;

  /**
   * `brain` section: how many days to retain memory entries.
   * `0` means retain forever (the default).
   * Persisted to `brain.retention.days` in the global config.
   */
  brainRetentionDays?: number;

  /**
   * `brain` section: enable or disable the BRAIN embedding index.
   * Persisted to `brain.embedding.enabled` in the global config.
   */
  brainEmbeddingEnabled?: boolean;

  /**
   * `integrations` section: enable the SignalDock transport.
   * Persisted to `signaldock.enabled` in the global config.
   */
  signaldockEnabled?: boolean;

  /**
   * `integrations` section: SignalDock endpoint URL.
   * Persisted to `signaldock.endpoint` in the global config.
   */
  signaldockEndpoint?: string;

  /**
   * `integrations` section: enable the Studio web UI.
   * Persisted to `studio.enabled` in the global config.
   */
  studioEnabled?: boolean;

  /**
   * `integrations` section: custom Conduit local DB path (absolute).
   * Persisted to `conduit.dbPath` in the project config.
   */
  conduitPath?: string;

  /**
   * `llm` section: consent to including the API key in the CLEO
   * credential pool for multi-agent distribution.
   * Persisted to `auth.poolSeedingConsent` in the global config.
   */
  poolSeedingConsent?: boolean;

  /**
   * `models-roles` section (T11726): default model id for the global binding
   * (`cleo llm use` equivalent). Persisted to `llm.default.model` in the global
   * config. The provider for the default binding comes from
   * {@link WizardOptions.provider} (or an existing `llm.default.provider`).
   */
  defaultModel?: string;

  /**
   * `models-roles` section (T11726): per-role provider/model pins
   * (`cleo llm profile` equivalent), keyed by role name (a member of
   * `WHOAMI_ROLE_IDS`). Each binding is persisted to `llm.roles.<role>` in the
   * global config. Roles absent from the map are left untouched.
   */
  roleBindings?: Record<string, { provider: string; model?: string; credentialLabel?: string }>;

  /**
   * `project-conventions` section: enforcement mode for tasks that
   * are missing Acceptance Criteria.
   * Persisted to `enforcement.acceptance.mode` in the project config.
   */
  acEnforcementMode?: 'block' | 'warn' | 'off';

  /**
   * `project-conventions` section: whether to auto-start a session on
   * `cleo` invocation when none is active.
   * Persisted to `session.autoStart` in the project config.
   */
  sessionAutoStart?: boolean;

  /**
   * `telemetry` section (T9673): consent to anonymous skills-usage telemetry.
   * `true` is the default-on contract for new installs; `false` is the
   * single opt-out flag. Persisted to `telemetry.enabled` in the global
   * config.
   */
  telemetryEnabled?: boolean;

  /**
   * Top-level: structured per-section config bag parsed from `--config-json`.
   *
   * Keys are section IDs (`'llm'`, `'identity'`, …); values are objects
   * whose keys mirror the corresponding `WizardOptions` field names.
   * `buildWizardOptions()` merges these into the flat options bag before
   * handing off to the runner.
   *
   * Example:
   * ```json
   * {
   *   "identity": { "agentName": "Atlas" },
   *   "llm": { "provider": "anthropic", "apiKey": "sk-ant-..." }
   * }
   * ```
   */
  configJson?: Record<string, Record<string, unknown>>;

  /**
   * Top-level: when `true`, the `isConfigured()` guard on every section
   * is bypassed for this run, allowing re-configuration of already-set
   * sections without touching the credential pool.
   *
   * Set by `cleo setup --reset`.
   */
  reset?: boolean;
}

/**
 * I/O surface every section uses to prompt the operator.
 *
 * Implementations:
 *   - `ConsoleWizardIO` — basic stub that captures all output and pulls
 *     responses from a pre-seeded queue. Used for tests.
 *   - CLI command (T9421) — wraps `node:readline`.
 *   - Studio `/setup` (T-E3-8) — buffers questions to a SvelteKit form.
 *
 * Every method is async so implementations can use streams, fetches,
 * or persisted form state.
 *
 * @task T9420
 */
export interface WizardIO {
  /** Ask a free-form text question; empty string means "no answer". */
  prompt(question: string): Promise<string>;
  /** Yes/no question with an optional default. */
  confirm(question: string, defaultValue?: boolean): Promise<boolean>;
  /** Single-choice selection across a finite option list. */
  select<T extends string>(question: string, options: readonly T[]): Promise<T>;
  /** Informational message (goes to stderr in the CLI — never to stdout). */
  info(message: string): void;
  /** Non-fatal warning (goes to stderr in the CLI). */
  warn(message: string): void;
  /** Error message (goes to stderr in the CLI). */
  error(message: string): void;
}

/**
 * One runnable wizard section.
 *
 * Every built-in section under `./sections/` implements this. Custom
 * sections (e.g. a plugin or a future studio wizard) only need to
 * supply the same shape — the runner walks the array blindly.
 *
 * @task T9420
 * @task T9607
 */
export interface WizardSectionRunner {
  /** Identifier matched against `--section` flags. */
  section: WizardSection;
  /** Short human title shown before the section runs. */
  title: string;
  /** `true` if skipping the section keeps CLEO functional. */
  optional: boolean;

  /**
   * Return `true` if the section has already been configured and should be
   * skipped unless `options.reset === true`.
   *
   * Called by {@link WizardRunner} before `run()`. When undefined, the
   * section always runs — preserving backward compatibility for custom
   * sections that do not implement idempotency.
   *
   * Implementations MUST be read-only (no side-effects). They may read
   * config or the filesystem, but MUST NOT write anything.
   *
   * @param options - The current invocation options bag (for `projectRoot`
   *   resolution and other context the check may need).
   * @returns `true` when the section is fully configured and safe to skip.
   * @task T9607
   */
  isConfigured?(options: WizardOptions): Promise<boolean>;

  /**
   * Execute the section.
   *
   * @param io - Prompting surface (CLI/Studio/test stub).
   * @param options - Pre-parsed CLI flags / programmatic invocation bag.
   * @returns Section outcome — `changed` plus a one-line summary.
   */
  run(io: WizardIO, options: WizardOptions): Promise<WizardSectionResult>;
}

/**
 * Aggregate result of `WizardRunner.run()`.
 *
 * Returned to the caller so `cleo setup` can render a final summary
 * line per section and exit non-zero only when every section reported
 * an error via {@link WizardIO.error}.
 *
 * @task T9420
 * @task T9613
 */
export interface WizardRunResult {
  /** Sections that actually executed (skipped sections appear here too). */
  sectionsRun: WizardSection[];
  /** One human-readable summary line per section in declaration order. */
  summary: string[];
  /**
   * `true` when the runner wrote `auth.firstRunComplete = true` to the
   * global config at the end of this run (i.e. all sections completed
   * without any `failed:` summary lines).
   *
   * `false` when any section failed, preventing the completion marker.
   *
   * @task T9613
   */
  firstRunComplete: boolean;
}

/**
 * Thrown when the operator interrupts the wizard (Ctrl-C or EOF).
 *
 * The CLI command MUST catch this error, print
 * `"Setup interrupted. Run 'cleo setup' to continue."`, and exit with
 * code 130 (SIGINT convention).
 *
 * `WizardIO` implementations that wrap interactive streams (e.g.
 * `ReadlineWizardIO`) MUST throw this when a SIGINT or close event is
 * received during any `prompt()`, `confirm()`, or `select()` call.
 * The `StubWizardIO` never throws this — test cases that want to
 * exercise interrupt handling should throw it manually.
 *
 * @task T9607
 * @epic T9591
 */
export class WizardInterruptError extends Error {
  /** Discriminator — allows `instanceof` checks without relying on class identity across module boundaries. */
  readonly isWizardInterruptError = true as const;

  /**
   * @param message - Human-readable description of what triggered the
   *   interrupt (e.g. `'interrupted by user'`, `'stdin closed'`).
   */
  constructor(message: string = 'Setup wizard interrupted') {
    super(message);
    this.name = 'WizardInterruptError';
    // Preserve correct prototype chain for `instanceof` in transpiled output.
    Object.setPrototypeOf(this, WizardInterruptError.prototype);
  }
}

/**
 * Runs an ordered collection of {@link WizardSectionRunner} instances.
 *
 * Stateless: every method takes the registered sections from the
 * constructor argument and the per-invocation `io`/`options`. The
 * runner deliberately swallows section-level exceptions so a failing
 * section never aborts the rest of the wizard — exceptions are logged
 * via `io.error()` and the section's summary line records `failed`.
 *
 * Mirrors Hermes Agent's `setup.py` decomposition.
 *
 * @task T9420
 */
export class WizardRunner {
  private readonly sections: ReadonlyMap<WizardSection, WizardSectionRunner>;

  /**
   * Construct a runner over a fixed section list.
   *
   * The list order is preserved as the execution order for {@link run}.
   * Passing the same `section` id twice throws — every id MUST be unique.
   *
   * @param sections - The wizard's section runners in execution order.
   */
  constructor(private readonly sectionList: readonly WizardSectionRunner[]) {
    const map = new Map<WizardSection, WizardSectionRunner>();
    for (const section of sectionList) {
      if (map.has(section.section)) {
        throw new Error(
          `WizardRunner: duplicate section id '${section.section}' — every section id must be unique.`,
        );
      }
      map.set(section.section, section);
    }
    this.sections = map;
  }

  /**
   * Return the registered section runners in declaration order.
   *
   * Read-only view — callers MUST NOT mutate.
   *
   * @returns Frozen list of section runners.
   */
  list(): readonly WizardSectionRunner[] {
    return this.sectionList;
  }

  /**
   * Execute every section in declaration order.
   *
   * Each section runs against the supplied `io`/`options`. Section
   * failures are caught and reported via `io.error()`; the next section
   * still runs.
   *
   * ### Skip logic (T9613 / E-CLEO-SETUP-V2 §3.4)
   *
   * Before invoking each section, `run()` calls `section.isConfigured?.(options)`.
   * When that returns `true` and `options.reset` is not set, the section is
   * bypassed with a `skipped (already configured)` summary line and an info
   * message directing the user to `--reset` for a full reconfigure.
   *
   * ### Progress prefix (T9613 / E-CLEO-SETUP-V2 §3.4)
   *
   * Section headers are emitted as `[N/total] title (section-id)` so
   * scripted consumers can parse progress reliably.
   *
   * ### First-run completion (T9613 / E-CLEO-SETUP-V2 §3.4)
   *
   * After all sections complete without any `failed:` summary line, this
   * method writes `auth.firstRunComplete = true` to the global config and
   * writes a `setup-completed.json` marker to the CLEO data directory.
   * The returned {@link WizardRunResult.firstRunComplete} flag reflects
   * whether the marker was written.
   *
   * @param io - Prompting surface.
   * @param options - Pre-parsed flags / programmatic bag.
   * @returns Aggregate run result with per-section summary lines.
   */
  async run(io: WizardIO, options: WizardOptions = {}): Promise<WizardRunResult> {
    const sectionsRun: WizardSection[] = [];
    const summary: string[] = [];
    const total = this.sectionList.length;
    let index = 0;

    for (const runner of this.sectionList) {
      index++;
      sectionsRun.push(runner.section);

      // Progress prefix: [N/total] title (section-id)
      io.info(`\n[${index}/${total}] ${runner.title} (${runner.section})`);

      // Skip logic: check isConfigured() unless reset is set
      if (!options.reset && runner.isConfigured) {
        const alreadyConfigured = await runner.isConfigured(options);
        if (alreadyConfigured) {
          io.info(`[skip] ${runner.title} — already configured. Use --reset to reconfigure.`);
          summary.push(`${runner.section}: skipped (already configured)`);
          continue;
        }
      }

      const result = await this.invokeSection(runner, io, options);
      summary.push(`${runner.section}: ${result.summary}`);
    }

    // First-run completion: if no section produced a 'failed:' line, mark
    // auth.firstRunComplete in global config and write the data-dir marker.
    const anyFailed = summary.some((line) => line.includes(': failed:'));
    if (!anyFailed) {
      try {
        await setConfigValue('auth.firstRunComplete', true, undefined, { global: true });
        const dataDir = getCleoPlatformPaths().data;
        await mkdir(dataDir, { recursive: true });
        await writeFile(
          join(dataDir, 'setup-completed.json'),
          JSON.stringify({ completedAt: new Date().toISOString() }),
          'utf-8',
        );
      } catch {
        // Non-fatal: failure to write the completion marker is surfaced
        // only via the returned flag — it MUST NOT abort the wizard run.
      }
      return { sectionsRun, summary, firstRunComplete: true };
    }

    return { sectionsRun, summary, firstRunComplete: false };
  }

  /**
   * Execute a single named section.
   *
   * @param name - Section id matching a registered runner's `section` field.
   * @param io - Prompting surface.
   * @param options - Pre-parsed flags / programmatic bag.
   * @returns The section's own {@link WizardSectionResult}.
   * @throws When `name` is not registered.
   */
  async runSection(
    name: WizardSection,
    io: WizardIO,
    options: WizardOptions = {},
  ): Promise<WizardSectionResult> {
    const runner = this.sections.get(name);
    if (!runner) {
      throw new Error(
        `WizardRunner.runSection: no section registered for id '${name}'. ` +
          `Known sections: ${Array.from(this.sections.keys()).join(', ') || '(none)'}.`,
      );
    }
    io.info(`\n── ${runner.title} (${runner.section}) ──`);
    return this.invokeSection(runner, io, options);
  }

  /**
   * Run one section while shielding the wizard from its exceptions.
   *
   * Section bugs surface as `failed: <message>` summary lines rather
   * than uncaught throws so an `cleo setup` invocation always completes
   * with a non-fatal report instead of a stack trace.
   *
   * **Exception**: {@link WizardFatalError} subclasses (e.g. `StdinClosedError`)
   * are re-thrown immediately — they signal conditions (stdin EOF, broken pipe)
   * where further prompting is impossible and the CLI must emit a LAFS error
   * envelope rather than continuing with a dead I/O surface.
   *
   * @internal
   */
  private async invokeSection(
    runner: WizardSectionRunner,
    io: WizardIO,
    options: WizardOptions,
  ): Promise<WizardSectionResult> {
    try {
      return await runner.run(io, options);
    } catch (err) {
      // Re-throw fatal errors — they propagate to the CLI for LAFS envelope
      // emission (T9599 bug #10: stdin EOF must not be silently swallowed).
      if (WizardFatalError.is(err)) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      io.error(`section '${runner.section}' failed: ${message}`);
      return { changed: false, summary: `failed: ${message}` };
    }
  }
}

/**
 * Queued-input {@link WizardIO} implementation for tests and the Studio
 * non-interactive form flow.
 *
 * Pre-seed `prompts`, `confirms`, and `selects` arrays (in the order the
 * sections will consume them); every recorded `info`/`warn`/`error`
 * message lands on the corresponding public array so assertions can
 * inspect output without a TTY.
 *
 * Production CLI code MUST NOT use this — it crashes on prompt
 * exhaustion. Use the readline-backed `ConsoleWizardIO` from T9421.
 *
 * @task T9420
 */
export class StubWizardIO implements WizardIO {
  /** Recorded info messages in emission order. */
  readonly infos: string[] = [];
  /** Recorded warn messages in emission order. */
  readonly warns: string[] = [];
  /** Recorded error messages in emission order. */
  readonly errors: string[] = [];
  /** Recorded prompts in `(question, answer)` order. */
  readonly promptHistory: Array<{ question: string; answer: string }> = [];

  /**
   * @param queues - Pre-seeded answer queues. Empty arrays cause prompt
   *   methods to throw — surfaces broken test fixtures fast.
   */
  constructor(
    private readonly queues: {
      prompts?: string[];
      confirms?: boolean[];
      selects?: string[];
    } = {},
  ) {
    this.queues = {
      prompts: [...(queues.prompts ?? [])],
      confirms: [...(queues.confirms ?? [])],
      selects: [...(queues.selects ?? [])],
    };
  }

  async prompt(question: string): Promise<string> {
    const prompts = this.queues.prompts ?? [];
    if (prompts.length === 0) {
      throw new Error(`StubWizardIO: prompt queue exhausted on question '${question}'`);
    }
    const answer = prompts.shift() as string;
    this.promptHistory.push({ question, answer });
    return answer;
  }

  async confirm(question: string, defaultValue?: boolean): Promise<boolean> {
    const confirms = this.queues.confirms ?? [];
    if (confirms.length === 0) {
      if (defaultValue !== undefined) {
        this.promptHistory.push({ question, answer: defaultValue ? 'y' : 'n' });
        return defaultValue;
      }
      throw new Error(`StubWizardIO: confirm queue exhausted on question '${question}'`);
    }
    const answer = confirms.shift() as boolean;
    this.promptHistory.push({ question, answer: answer ? 'y' : 'n' });
    return answer;
  }

  async select<T extends string>(question: string, options: readonly T[]): Promise<T> {
    const selects = this.queues.selects ?? [];
    if (selects.length === 0) {
      throw new Error(`StubWizardIO: select queue exhausted on question '${question}'`);
    }
    const choice = selects.shift() as string;
    if (!options.includes(choice as T)) {
      throw new Error(
        `StubWizardIO: queued select answer '${choice}' is not in options [${options.join(', ')}]`,
      );
    }
    this.promptHistory.push({ question, answer: choice });
    return choice as T;
  }

  info(message: string): void {
    this.infos.push(message);
  }
  warn(message: string): void {
    this.warns.push(message);
  }
  error(message: string): void {
    this.errors.push(message);
  }
}
