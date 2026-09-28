/**
 * CLI briefing command — show composite session-start context.
 *
 * Aggregates session-start context from multiple sources:
 * - Last session handoff
 * - Current focus
 * - Top-N next tasks
 * - Open bugs
 * - Blocked tasks
 * - Active epics
 * - Pipeline stage
 *
 * @task T4916
 * @epic T4914
 * @task T9148
 * @task T12580
 */

import { pushWarning } from '@cleocode/core';
import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import { isSubCommandDispatch } from '../lib/subcommand-guard.js';
import { cliError } from '../renderers/index.js';

/** Adapter-specific rendering formats for `--format adapter:<name>`. */
const ADAPTER_FORMATS = ['claude', 'codex', 'gemini', 'compact-json'] as const;
type AdapterFormat = (typeof ADAPTER_FORMATS)[number];

/**
 * Render section content in adapter-appropriate form for provider context windows.
 *
 * - `claude`: markdown as-is (Claude handles markdown natively)
 * - `codex`: strip markdown emphasis, reduce table headers
 * - `gemini`: similar to claude (markdown supported)
 * - `compact-json`: JSON with `{ section, content }` shape (for tool call injection)
 */
function renderForAdapter(sectionName: string, content: string, format: AdapterFormat): string {
  switch (format) {
    case 'claude':
    case 'gemini':
      return content;
    case 'codex': {
      // Strip markdown bold/italic; compact tables by removing separator rows.
      const stripped = content
        .replace(/\*\*(.*?)\*\*/g, '$1')
        .replace(/\*(.*?)\*/g, '$1')
        .split('\n')
        .filter((line) => !/^\|[-: |]+\|$/.test(line))
        .join('\n');
      return stripped;
    }
    case 'compact-json':
      return JSON.stringify({ section: sectionName, content }, null, 0);
  }
}

/**
 * Emit a validation failure for `cleo briefing inject` as a LAFS error envelope
 * plus a `W_TEMPLATE_INJECT_FAILED` warning (T9772).
 */
function failInject(message: string, fix: string): void {
  pushWarning({ code: 'W_TEMPLATE_INJECT_FAILED', message });
  cliError(message, 1, { name: 'E_VALIDATION', fix }, { operation: 'briefing.inject' });
  process.exitCode = 1;
}

/**
 * `cleo briefing inject --section <name>` — print one protocol section.
 *
 * `CLEO-INJECTION.md` is the always-loaded core; reference sections live in
 * the package's `CLEO-REFERENCE.md` and are fetched with this command. Output
 * is the raw section markdown (or the `--format adapter:<name>` rendering),
 * not an envelope — it is context for the agent to read.
 *
 * @task T9148
 * @task T12580
 */
const briefingInjectCommand = defineCommand({
  meta: {
    name: 'inject',
    description:
      'Print one CLEO protocol section (core or on-demand reference) by name, e.g. --section task-creation',
  },
  args: {
    section: {
      type: 'string',
      description: 'Section name (see the On-demand reference table in CLEO-INJECTION.md)',
      required: true,
    },
    format: {
      type: 'string',
      description: 'markdown (default) or adapter:<claude|codex|gemini|compact-json>',
      default: 'markdown',
    },
  },
  async run({ args }) {
    const { readInjectionSection } = await import('@cleocode/core/injection');
    const sectionName = String(args.section ?? '');
    const lookup = readInjectionSection(sectionName);
    if (lookup.content === null) {
      const available = lookup.available.join(', ');
      failInject(
        lookup.available.length === 0
          ? 'No CLEO protocol template found (package templates and installed CLEO-INJECTION.md are missing).'
          : `Section "${sectionName}" not found. Available sections: ${available}`,
        lookup.available.length === 0
          ? 'Re-run `cleo init` or reinstall @cleocode/cleo.'
          : `Pass one of: ${available}`,
      );
      return;
    }
    const formatStr = String(args.format ?? 'markdown');
    let output = lookup.content;
    if (formatStr.startsWith('adapter:')) {
      const adapterName = formatStr.slice('adapter:'.length);
      if (!(ADAPTER_FORMATS as readonly string[]).includes(adapterName)) {
        const supported = ADAPTER_FORMATS.join(', ');
        failInject(
          `Unknown adapter format "${adapterName}". Supported: ${supported}`,
          `Pass one of: ${supported}`,
        );
        return;
      }
      output = renderForAdapter(sectionName, lookup.content, adapterName as AdapterFormat);
    }
    process.stdout.write(`${output}\n`);
  },
});

/**
 * Root briefing command — show composite session-start context.
 *
 * Dispatches to `session.briefing.show` with optional scope and result-count
 * limits. Use at session start to restore context quickly.
 *
 * Subcommands:
 * - `inject` — print one protocol section (core or reference) by name (T9148 · T12580)
 *
 * @task T4916
 * @epic T4914
 */
export const briefingCommand = defineCommand({
  meta: {
    name: 'briefing',
    description:
      'Session resume context: last handoff, current task, next tasks, bugs, blockers, epics, and memory. Use at session start to restore context.',
  },
  args: {
    scope: {
      type: 'string',
      description: 'Scope filter (global or epic:T###)',
      alias: 's',
    },
    'max-next': {
      type: 'string',
      description: 'Maximum next tasks to show',
      default: '3',
    },
    'max-bugs': {
      type: 'string',
      description: 'Maximum bugs to show',
      default: '10',
    },
    'max-blocked': {
      type: 'string',
      description: 'Maximum blocked tasks to show',
      default: '10',
    },
    'max-epics': {
      type: 'string',
      description: 'Maximum active epics to show',
      default: '5',
    },
    /**
     * T1905 / BBTT-W1-3: strict contract mode.
     *
     * When set, exit non-zero if the briefing contains any contract violations
     * (stale data, duplicate IDs, excluded-provenance items). Use in CI to
     * catch briefing regressions early.
     */
    strict: {
      type: 'boolean',
      description: 'Exit non-zero when briefing contract violations are detected (T1905)',
      alias: 'x',
    },
    /**
     * T9974: debug mode — surface peerPatterns and other verbose fields
     * suppressed by default. Passing --debug --with-profile --max-next 5
     * restores the ~pre-T9974 output shape.
     */
    debug: {
      type: 'boolean',
      description: 'Include verbose debug fields (peerPatterns etc.) suppressed by default',
      default: false,
    },
    /**
     * T9974: include cold.userProfile traits in the bundle.
     * Off by default — large trait dump rarely needed at session start.
     */
    'with-profile': {
      type: 'boolean',
      description: 'Include user profile traits in the bundle (suppressed by default)',
      default: false,
    },
    /**
     * T9964: restore full text fields on peerLearnings and decisions.
     * By default these are truncated to 80-char previews with a `_next.fetch`
     * hint. Pass --memory-detail to restore the full `insight` and `decision`
     * body fields (equivalent to pre-T9964 output for those fields).
     */
    'memory-detail': {
      type: 'boolean',
      description:
        'Restore full peerLearnings/decisions body text (suppressed by default for token budget)',
      default: false,
    },
  },
  subCommands: {
    inject: briefingInjectCommand,
  },
  async run({ args, cmd, rawArgs }) {
    if (isSubCommandDispatch(rawArgs, cmd.subCommands)) return;

    const result = await dispatchFromCli(
      'query',
      'session',
      'briefing.show',
      {
        scope: args.scope as string | undefined,
        maxNextTasks: parseInt(args['max-next'], 10),
        maxBugs: parseInt(args['max-bugs'], 10),
        maxBlocked: parseInt(args['max-blocked'], 10),
        maxEpics: parseInt(args['max-epics'], 10),
        debug: args.debug as boolean | undefined,
        withProfile: args['with-profile'] as boolean | undefined,
        memoryDetail: args['memory-detail'] as boolean | undefined,
      },
      { command: 'briefing' },
    );

    // T1905: --strict exits non-zero when contractViolations are present
    if (args.strict) {
      const data = (result as Record<string, unknown> | undefined)?.['data'] as
        | Record<string, unknown>
        | undefined;
      const violations = data?.['contractViolations'] as unknown[] | undefined;
      if (violations && violations.length > 0) {
        process.exitCode = 1;
      }
    }
  },
});
