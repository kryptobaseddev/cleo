/**
 * `cleo setup` — interactive setup wizard CLI surface (T9421).
 *
 * Thin wrapper over the core {@link WizardRunner} from
 * `@cleocode/core/setup` (T9420). The CLI owns nothing beyond:
 *
 *   - Flag parsing (citty).
 *   - Construction of a real {@link WizardIO} via {@link ReadlineWizardIO}.
 *   - Bridging `--section` / `--non-interactive` / `--provider` / `--api-key`
 *     to the runner's APIs.
 *   - Emitting a LAFS-shaped envelope on stdout via {@link cliOutput}.
 *
 * Three operating modes (matching T9421 acceptance criteria):
 *
 *   1. `cleo setup` — walks every built-in section in canonical order
 *      (`llm` → `identity` → `sentient` → `project-conventions`).
 *   2. `cleo setup --section <name>` — runs one named section.
 *   3. `cleo setup --non-interactive --provider <p> --api-key <k>` —
 *      configures the LLM section without prompts. Other sections short-
 *      circuit silently when `--non-interactive` is set and they lack the
 *      required inputs (see `WizardOptions` contract in T9420).
 *
 * The command exits with status `0` when all sections succeeded (no
 * `failed:` summaries) and non-zero otherwise. Section-level exceptions
 * are caught by the runner and surfaced via `io.error()` — the CLI exit
 * code is the *only* signal of overall pass/fail to scripts.
 *
 * @task T9421
 * @epic E-CONFIG-AUTH-UNIFY (E3 §5.3 T-E3-2)
 */

import type {
  WizardIO,
  WizardOptions,
  WizardRunResult,
  WizardSection,
  WizardSectionResult,
} from '@cleocode/core/setup';
import { createDefaultWizardRunner } from '@cleocode/core/setup';
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

/**
 * Parse the CLI args bag into the cross-section {@link WizardOptions}
 * payload the runner expects.
 *
 * Centralised here so both the multi-section and single-section paths
 * use the same flag → options mapping; tests assert on this function via
 * the public command interface.
 *
 * @param args - Citty-resolved arg bag.
 * @returns A populated {@link WizardOptions} object.
 *
 * @internal
 */
export function buildWizardOptions(args: Record<string, unknown>): WizardOptions {
  const out: WizardOptions = {};
  if (args['non-interactive'] === true || args['nonInteractive'] === true) {
    out.nonInteractive = true;
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
  // brain section flag
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
 */
export const setupCommand = defineCommand({
  meta: {
    name: 'setup',
    description:
      'Interactive setup wizard — runs all sections in canonical order (llm → identity → sentient → project-conventions → harness → brain). Use --section <name> for a single section or --non-interactive with section-specific flags to configure without prompts.',
  },
  args: {
    section: {
      type: 'string',
      description:
        'Run only one named section. Valid: llm | identity | sentient | project-conventions | harness | brain',
    },
    'non-interactive': {
      type: 'boolean',
      description:
        'Skip prompts. Requires section-specific flags (e.g. --provider/--api-key for llm, --harness for harness, --brain-bridge-mode for brain, --sentient/--tier2 for sentient). Missing required flags emit E_SETUP_MISSING_FLAG.',
    },
    provider: {
      type: 'string',
      description:
        'LLM provider id when --non-interactive (anthropic, openai, gemini, openrouter, …).',
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
