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
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pushWarning } from '@cleocode/core';
import { resolveLegacyCleoDir } from '@cleocode/paths';
import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import { isSubCommandDispatch } from '../lib/subcommand-guard.js';
import { cliError } from '../renderers/index.js';

/** Canonical section names supported by `cleo briefing inject`. */
const INJECTION_SECTION_NAMES = [
  'session-start',
  'work-loop',
  'triggers',
  'task-creation',
  'task-discovery',
  'session-commands',
  'memory',
  'nexus',
  'orchestration',
  'playbooks',
  'documents',
  'error-handling',
  'pre-complete-gate',
  'spawn-tiers',
  'rules',
  'memory-jit',
  'escalation',
] as const;

/** Union of all valid injection section name strings. */
export type InjectionSectionName = (typeof INJECTION_SECTION_NAMES)[number];

/** Adapter-specific rendering formats for `--format adapter:<name>`. */
const ADAPTER_FORMATS = ['claude', 'codex', 'gemini', 'compact-json'] as const;
type AdapterFormat = (typeof ADAPTER_FORMATS)[number];

/**
 * Resolve the CLEO-INJECTION.md path from the standard XDG location.
 *
 * Falls back to `~/.cleo/templates/CLEO-INJECTION.md` for installations
 * without XDG_CONFIG_HOME set.
 */
function resolveInjectionTemplatePath(): string {
  const xdgConfig = resolveLegacyCleoDir(process.env['XDG_CONFIG_HOME']);
  return join(xdgConfig, 'templates', 'CLEO-INJECTION.md');
}

/**
 * Extract a named section from CLEO-INJECTION.md using HTML-comment anchors.
 *
 * Anchors have the form:
 *   <!-- CLEO-INJECTION:section=NAME -->
 *   ...content...
 *   <!-- /CLEO-INJECTION:section=NAME -->
 *
 * Returns the content between the anchors (exclusive), or null if the section
 * is not found.
 */
function extractSection(content: string, sectionName: string): string | null {
  const openTag = `<!-- CLEO-INJECTION:section=${sectionName} -->`;
  const closeTag = `<!-- /CLEO-INJECTION:section=${sectionName} -->`;
  const start = content.indexOf(openTag);
  if (start === -1) return null;
  const contentStart = start + openTag.length;
  const end = content.indexOf(closeTag, contentStart);
  if (end === -1) return null;
  return content.slice(contentStart, end).trim();
}

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
 * Core inject logic — reads the INJECTION template and emits the named section.
 * Shared between the direct argv dispatch path and the citty subcommand path.
 *
 * @task T9148
 */
async function runBriefingInject(sectionName: string, formatStr: string): Promise<void> {
  const templatePath = resolveInjectionTemplatePath();
  if (!existsSync(templatePath)) {
    // T9772: template-not-found is a non-fatal inject failure — surface as
    // a `W_TEMPLATE_INJECT_FAILED` warning attached to the LAFS error envelope.
    pushWarning({
      code: 'W_TEMPLATE_INJECT_FAILED',
      message: `CLEO-INJECTION.md not found at ${templatePath}`,
    });
    cliError(
      `CLEO-INJECTION.md not found at ${templatePath}`,
      1,
      {
        name: 'E_TEMPLATE_NOT_FOUND',
        fix: 'Re-run `cleo init` or restore the templates directory.',
      },
      { operation: 'briefing.inject' },
    );
    process.exitCode = 1;
    return;
  }

  const content = readFileSync(templatePath, 'utf-8');
  const section = extractSection(content, sectionName);

  if (section === null) {
    const available = INJECTION_SECTION_NAMES.join(', ');
    // T9772: unknown section is a validation failure — emit envelope with warning.
    pushWarning({
      code: 'W_TEMPLATE_INJECT_FAILED',
      message: `Section "${sectionName}" not found in CLEO-INJECTION.md.`,
    });
    cliError(
      `Section "${sectionName}" not found in CLEO-INJECTION.md. Available sections: ${available}`,
      1,
      {
        name: 'E_VALIDATION',
        fix: `Pass one of: ${available}`,
      },
      { operation: 'briefing.inject' },
    );
    process.exitCode = 1;
    return;
  }

  let output = section;
  if (formatStr.startsWith('adapter:')) {
    const adapterName = formatStr.slice('adapter:'.length) as AdapterFormat;
    if (!(ADAPTER_FORMATS as readonly string[]).includes(adapterName)) {
      // T9772: unknown adapter is a validation failure — emit envelope with warning.
      const supported = ADAPTER_FORMATS.join(', ');
      pushWarning({
        code: 'W_TEMPLATE_INJECT_FAILED',
        message: `Unknown adapter format "${adapterName}".`,
      });
      cliError(
        `Unknown adapter format "${adapterName}". Supported: ${supported}`,
        1,
        {
          name: 'E_VALIDATION',
          fix: `Pass one of: ${supported}`,
        },
        { operation: 'briefing.inject' },
      );
      process.exitCode = 1;
      return;
    }
    output = renderForAdapter(sectionName, section, adapterName);
  }

  process.stdout.write(output + '\n');
}

/**
 * Root briefing command — show composite session-start context.
 *
 * Dispatches to `session.briefing.show` with optional scope and result-count
 * limits. Use at session start to restore context quickly.
 *
 * Subcommands:
 * - `inject` — emit one CLEO-INJECTION.md section by anchor name (T9148)
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
      default: '5',
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
  },
  async run({ args, cmd, rawArgs }) {
    // Citty does not route to subcommands within lazy-loaded top-level commands.
    // Detect 'inject' in process.argv directly (rawArgs may be empty at parent level).
    const allArgv = process.argv.slice(2);
    const briefingIdx = allArgv.indexOf('briefing');
    const argsAfterBriefing =
      briefingIdx >= 0 ? allArgv.slice(briefingIdx + 1) : rawArgs ? [...rawArgs] : [];
    const firstNonFlag = argsAfterBriefing.find((a) => !a.startsWith('-'));
    if (firstNonFlag === 'inject') {
      // Parse --section and --format from process.argv manually.
      const sectionIdx = argsAfterBriefing.indexOf('--section');
      const sectionName = sectionIdx >= 0 ? argsAfterBriefing[sectionIdx + 1] : '';
      const formatIdx = argsAfterBriefing.indexOf('--format');
      const formatStr =
        formatIdx >= 0 ? (argsAfterBriefing[formatIdx + 1] ?? 'markdown') : 'markdown';
      await runBriefingInject(sectionName ?? '', formatStr);
      return;
    }
    if (isSubCommandDispatch(argsAfterBriefing as readonly string[], cmd.subCommands)) return;

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
