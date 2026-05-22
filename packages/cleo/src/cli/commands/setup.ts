/**
 * `cleo setup` — interactive setup wizard CLI surface (T9421, T9611).
 *
 * Thin wrapper over the core {@link WizardRunner} from
 * `@cleocode/core/setup` (T9420). The CLI owns nothing beyond:
 *
 *   - Flag parsing (citty).
 *   - Construction of a real {@link WizardIO} via {@link ReadlineWizardIO}.
 *   - Bridging `--section` / `--non-interactive` / `--provider` / `--api-key`
 *     / `--config-json` / `--reset` / V2 section flags to the runner's APIs.
 *   - Emitting a LAFS-shaped envelope on stdout via {@link cliOutput}.
 *
 * Operating modes:
 *
 *   1. `cleo setup` — walks every built-in section in canonical order
 *      (`identity` → `llm` → `sentient` → `harness` → `brain` →
 *       `project-conventions` → `integrations` → `verification`).
 *   2. `cleo setup --section <name>` — runs one named section.
 *   3. `cleo setup --non-interactive --provider <p> --api-key <k>` —
 *      configures the LLM section without prompts. Other sections short-
 *      circuit silently when `--non-interactive` is set and they lack the
 *      required inputs (see `WizardOptions` contract in T9420).
 *   4. `cleo setup --config-json '{"identity":{"agentName":"Atlas"}}' --non-interactive` —
 *      fully scriptable: per-section config bag parsed from JSON and merged
 *      into the `WizardOptions` bag before handing off to the runner.
 *   5. `cleo setup --reset` — bypasses `isConfigured()` skip gates so already-
 *      configured sections run again.
 *
 * The command exits with status `0` when all sections succeeded (no
 * `failed:` summaries) and non-zero otherwise. Section-level exceptions
 * are caught by the runner and surfaced via `io.error()` — the CLI exit
 * code is the *only* signal of overall pass/fail to scripts.
 *
 * @task T9421
 * @task T9611
 * @epic E-CONFIG-AUTH-UNIFY (E3 §5.3 T-E3-2)
 * @epic E-CLEO-SETUP-V2 (T9591 §3.6)
 */

import type {
  WizardIO,
  WizardOptions,
  WizardRunResult,
  WizardSection,
  WizardSectionResult,
} from '@cleocode/core/setup';
import {
  createDefaultWizardRunner,
  mergeConfigJson,
  WizardInterruptError,
} from '@cleocode/core/setup';
import { defineCommand } from 'citty';
import { ReadlineWizardIO, StdinClosedError } from '../lib/readline-wizard-io.js';
import { cliError, cliOutput } from '../renderers/index.js';

// ---------------------------------------------------------------------------
// Public types — exported so the Studio `/setup` route (T-E3-8) can reuse
// the section-name union without re-deriving it from the core wizard.
// ---------------------------------------------------------------------------

/**
 * Concrete section ids accepted by `cleo setup --section <name>`.
 *
 * Mirrors {@link WizardSection} from `@cleocode/core/setup` but restated
 * here so a future plugin-registered section that the CLI does not yet
 * surface in its `--section` flag remains a compile-time error.
 *
 * @task T9421
 */
export type CleoSetupSection = WizardSection;

/**
 * Result envelope shape for `cleo setup` (and `cleo setup --section`).
 *
 * Mirrors {@link WizardRunResult} verbatim — exported so the Studio /
 * downstream tooling can type-check JSON consumers without depending on
 * `@cleocode/core` directly.
 *
 * @task T9421
 */
export interface CleoSetupResult {
  /** Section ids that actually executed (in order). */
  sectionsRun: WizardSection[];
  /** One human-readable summary line per executed section. */
  summary: string[];
  /** `true` if every section reported success (no `failed:` summary). */
  ok: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
//
// `mergeConfigJson` + `WIZARD_SECTION_IDS` moved to
// `@cleocode/core/setup` per T9985 (E8-CLI-LAYERING / Package-Boundary Check).
// Imported above; no local declarations remain here.

/**
 * Parse the CLI args bag into the cross-section {@link WizardOptions}
 * payload the runner expects.
 *
 * Centralised here so both the multi-section and single-section paths
 * use the same flag → options mapping; tests assert on this function via
 * the public command interface.
 *
 * V2 additions (T9611 / E-CLEO-SETUP-V2 §3.6):
 *   - `--config-json` — JSON bag of per-section options, merged before
 *     explicit flag values (explicit flags win).
 *   - `--reset` — sets `options.reset = true` to bypass `isConfigured()`.
 *   - `--retention-days` — BRAIN retention days (brain section).
 *   - `--signaldock-enabled` — enable SignalDock transport (integrations).
 *   - `--signaldock-endpoint` — SignalDock endpoint URL (integrations).
 *   - `--studio-enabled` — enable Studio web UI (integrations).
 *
 * @param args - Citty-resolved arg bag.
 * @returns A populated {@link WizardOptions} object.
 *
 * @internal
 */
export function buildWizardOptions(args: Record<string, unknown>): WizardOptions {
  const out: WizardOptions = {};

  // --- 1. Parse --config-json first (lowest priority — explicit flags override) ---
  const configJsonRaw = args['config-json'] ?? args['configJson'];
  if (typeof configJsonRaw === 'string' && configJsonRaw !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(configJsonRaw);
    } catch {
      // Silently ignore malformed JSON — sections get undefined for all keys.
      // Callers that need strict validation should pre-parse before calling.
    }
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      mergeConfigJson(parsed as Record<string, Record<string, unknown>>, out);
    }
  }

  // --- 2. Explicit CLI flags (highest priority — override any configJson values) ---

  if (args['non-interactive'] === true || args['nonInteractive'] === true) {
    out.nonInteractive = true;
  }

  // --reset: bypass isConfigured() skip gates
  if (args['reset'] === true) {
    out.reset = true;
  }

  if (typeof args['provider'] === 'string' && args['provider'] !== '') {
    out.provider = args['provider'] as string;
  }
  if (typeof args['api-key'] === 'string' && (args['api-key'] as string) !== '') {
    out.apiKey = args['api-key'] as string;
  } else if (typeof args['apiKey'] === 'string' && (args['apiKey'] as string) !== '') {
    out.apiKey = args['apiKey'] as string;
  }
  if (typeof args['label'] === 'string' && args['label'] !== '') {
    out.label = args['label'] as string;
  }
  if (typeof args['agent-name'] === 'string' && args['agent-name'] !== '') {
    out.agentName = args['agent-name'] as string;
  } else if (typeof args['agentName'] === 'string' && args['agentName'] !== '') {
    out.agentName = args['agentName'] as string;
  }
  if (typeof args['strictness'] === 'string' && args['strictness'] !== '') {
    const s = args['strictness'] as string;
    if (s === 'strict' || s === 'standard' || s === 'minimal') {
      out.strictness = s;
    }
  }
  if (typeof args['project-root'] === 'string' && args['project-root'] !== '') {
    out.projectRoot = args['project-root'] as string;
  }
  // harness section flag
  if (typeof args['harness'] === 'string' && args['harness'] !== '') {
    const h = args['harness'] as string;
    if (h === 'pi' || h === 'claude-code') {
      out.harness = h;
    }
  }
  // brain section flags
  if (typeof args['brain-bridge-mode'] === 'string' && args['brain-bridge-mode'] !== '') {
    const b = args['brain-bridge-mode'] as string;
    if (b === 'digest' || b === 'file' || b === 'disabled') {
      out.brainBridgeMode = b;
    }
  } else if (
    typeof args['brainBridgeMode'] === 'string' &&
    (args['brainBridgeMode'] as string) !== ''
  ) {
    const b = args['brainBridgeMode'] as string;
    if (b === 'digest' || b === 'file' || b === 'disabled') {
      out.brainBridgeMode = b;
    }
  }
  // --retention-days: BRAIN retention days (integrates into brain section)
  if (typeof args['retention-days'] === 'string' && args['retention-days'] !== '') {
    const days = Number.parseInt(args['retention-days'] as string, 10);
    if (!Number.isNaN(days) && days >= 0) {
      out.brainRetentionDays = days;
    }
  } else if (typeof args['retentionDays'] === 'number') {
    const days = args['retentionDays'] as number;
    if (Number.isInteger(days) && days >= 0) {
      out.brainRetentionDays = days;
    }
  }
  // sentient section flags
  if (typeof args['sentient'] === 'string' && args['sentient'] !== '') {
    const s = args['sentient'] as string;
    if (s === 'on') out.sentientEnabled = true;
    else if (s === 'off') out.sentientEnabled = false;
  }
  if (typeof args['tier2'] === 'string' && args['tier2'] !== '') {
    const t = args['tier2'] as string;
    if (t === 'on') out.tier2Enabled = true;
    else if (t === 'off') out.tier2Enabled = false;
  }
  // integrations section flags
  if (args['signaldock-enabled'] === true) {
    out.signaldockEnabled = true;
  } else if (args['signaldock-enabled'] === false) {
    out.signaldockEnabled = false;
  }
  if (typeof args['signaldock-endpoint'] === 'string' && args['signaldock-endpoint'] !== '') {
    out.signaldockEndpoint = args['signaldock-endpoint'] as string;
  }
  if (args['studio-enabled'] === true) {
    out.studioEnabled = true;
  } else if (args['studio-enabled'] === false) {
    out.studioEnabled = false;
  }

  return out;
}

/**
 * Single-section pseudo-{@link WizardRunResult} so the JSON envelope shape
 * stays identical whether the user ran every section or just one.
 *
 * @internal
 */
function wrapSingleSection(name: WizardSection, result: WizardSectionResult): WizardRunResult {
  return {
    sectionsRun: [name],
    summary: [`${name}: ${result.summary}`],
    // Single-section runs never trigger the full first-run completion flow.
    firstRunComplete: false,
  };
}

/**
 * Determine whether *every* summary line in a run result represents
 * success. The wizard engine writes `failed: <message>` whenever a
 * section throws (see `WizardRunner.invokeSection`).
 *
 * @internal
 */
function isOk(result: WizardRunResult): boolean {
  return !result.summary.some((line) => /:\s*failed:/i.test(line));
}

/**
 * Run the wizard against the supplied I/O implementation and exit-code
 * helper. Extracted from the citty `run` so unit tests can drive the
 * wizard with a stub `WizardIO` while still exercising the full flag-
 * dispatch logic.
 *
 * @task T9421
 * @task T9611
 */
export async function runSetup(
  args: Record<string, unknown>,
  io: WizardIO,
): Promise<CleoSetupResult> {
  const options = buildWizardOptions(args);
  const runner = createDefaultWizardRunner();

  // --section <name> path
  const sectionArg = typeof args['section'] === 'string' ? (args['section'] as string) : null;
  let runResult: WizardRunResult;
  if (sectionArg) {
    const known = runner.list().map((r) => r.section);
    if (!known.includes(sectionArg as WizardSection)) {
      throw new Error(`cleo setup: unknown section '${sectionArg}'. Known: ${known.join(', ')}`);
    }
    const single = await runner.runSection(sectionArg as WizardSection, io, options);
    runResult = wrapSingleSection(sectionArg as WizardSection, single);
  } else {
    runResult = await runner.run(io, options);
  }

  return {
    sectionsRun: runResult.sectionsRun,
    summary: runResult.summary,
    ok: isOk(runResult),
  };
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/**
 * `cleo setup` — entry-point command.
 *
 * See file-level docstring for behaviour.
 *
 * @task T9421
 * @task T9611
 */
export const setupCommand = defineCommand({
  meta: {
    name: 'setup',
    description:
      'Interactive setup wizard — runs all 8 sections in canonical order (identity → llm → sentient → harness → brain → project-conventions → integrations → verification). Use --section <name> for a single section, --non-interactive with section-specific flags to configure without prompts, --config-json for fully scripted setup, or --reset to reconfigure already-set sections.',
  },
  args: {
    section: {
      type: 'string',
      description:
        'Run only one named section. Valid: identity | llm | sentient | harness | brain | project-conventions | integrations | verification',
    },
    'non-interactive': {
      type: 'boolean',
      description:
        'Skip prompts. Requires section-specific flags (e.g. --provider/--api-key for llm, --harness for harness, --brain-bridge-mode for brain, --sentient/--tier2 for sentient, --signaldock-enabled/--signaldock-endpoint/--studio-enabled for integrations). Missing required flags emit E_SETUP_MISSING_FLAG.',
    },
    provider: {
      type: 'string',
      description:
        'LLM provider id when --non-interactive (anthropic, openai, gemini, openrouter, moonshot, deepseek, xai, groq, ollama).',
    },
    'api-key': {
      type: 'string',
      description: 'API key used when --non-interactive --provider is set.',
    },
    label: {
      type: 'string',
      description: "Optional credential label override (defaults to 'cli-input').",
    },
    'agent-name': {
      type: 'string',
      description: 'Override agent display name for the identity section.',
    },
    strictness: {
      type: 'string',
      description: "Project-conventions strictness preset: 'strict' | 'standard' | 'minimal'.",
    },
    'project-root': {
      type: 'string',
      description: 'Override project root path (defaults to process.cwd()).',
    },
    harness: {
      type: 'string',
      description:
        "Active harness for the harness section when --non-interactive: 'pi' | 'claude-code'.",
    },
    'brain-bridge-mode': {
      type: 'string',
      description:
        "BRAIN memory bridge mode for the brain section when --non-interactive: 'digest' | 'file' | 'disabled'.",
    },
    sentient: {
      type: 'string',
      description:
        "Enable or disable the sentient daemon for the sentient section when --non-interactive: 'on' | 'off'.",
    },
    tier2: {
      type: 'string',
      description:
        "Enable or disable Tier-2 proposals for the sentient section when --non-interactive: 'on' | 'off'.",
    },
    'config-json': {
      type: 'string',
      description:
        "JSON bag of per-section options. Keys are section IDs ('identity', 'llm', 'brain', 'sentient', 'harness', 'project-conventions', 'integrations', 'verification'), values are WizardOptions sub-objects. Example: '{\"identity\":{\"agentName\":\"Atlas\"},\"llm\":{\"provider\":\"anthropic\",\"apiKey\":\"sk-ant-...\"}}'. Explicit CLI flags take precedence over configJson values.",
    },
    reset: {
      type: 'boolean',
      description:
        "Clear the 'already configured' sentinel before running — forces all sections to re-run even if they report isConfigured()=true. Does NOT clear the credential pool; use 'cleo llm remove' for that.",
    },
    'retention-days': {
      type: 'string',
      description:
        'BRAIN retention days for the brain section when --non-interactive (0 = retain forever, default 0). Must be a non-negative integer.',
    },
    'signaldock-enabled': {
      type: 'boolean',
      description:
        'Enable (true) or disable (false) the SignalDock transport. Used by the integrations section.',
    },
    'signaldock-endpoint': {
      type: 'string',
      description:
        'SignalDock endpoint URL for the integrations section (e.g. http://localhost:4000). Must be a valid HTTP(S) URL.',
    },
    'studio-enabled': {
      type: 'boolean',
      description:
        'Enable (true) or disable (false) the Studio web UI. Used by the integrations section.',
    },
  },
  async run({ args }) {
    const io = new ReadlineWizardIO();
    let result: CleoSetupResult;
    try {
      result = await runSetup(args as Record<string, unknown>, io);
    } catch (err) {
      // close() is idempotent — safe to call here even though the finally
      // block will call it again; ensures readline releases stdin before exit.
      io.close();

      // WizardInterruptError: operator pressed Ctrl-C or sent EOF.
      // Spec (T9607 / E-CLEO-SETUP-V2 §3.5): print a human-readable message
      // and exit 130 (SIGINT convention).
      if (
        err instanceof WizardInterruptError ||
        (err as { isWizardInterruptError?: boolean })?.isWizardInterruptError
      ) {
        process.stderr.write("Setup interrupted. Run 'cleo setup' to continue.\n");
        process.exit(130);
      }

      // T9612: Ctrl-C / SIGINT — print a friendly message and exit 130
      // (SIGINT convention) so shells can distinguish interrupted from failed.
      if (err instanceof WizardInterruptError) {
        process.stderr.write("Setup interrupted. Run 'cleo setup' to continue.\n");
        process.exit(130);
      }
      // Bug #10 (T9599): stdin closed before the wizard finished — emit a
      // LAFS error envelope and exit 1 instead of silently exiting 0 with
      // no JSON output.
      if (StdinClosedError.is(err)) {
        cliError(err.message, 1, {
          name: err.codeName,
          fix: 'Run cleo setup interactively (with a TTY) or use --non-interactive flags.',
        });
        process.exit(1);
      }
      throw err;
    } finally {
      io.close();
    }

    cliOutput(result, {
      command: 'setup',
      operation: 'setup.run',
      message: result.ok
        ? `Setup completed (${result.sectionsRun.length} section(s)).`
        : `Setup finished with errors (${result.sectionsRun.length} section(s)).`,
    });

    if (!result.ok) {
      process.exit(1);
    }
  },
});
