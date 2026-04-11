/**
 * Custom grouped help renderer for the root `cleo --help` command.
 *
 * Replaces citty's default flat subcommand listing with domain-grouped,
 * alias-aware, short-description output. Sub-command help (e.g.
 * `cleo add --help`) still uses citty's built-in renderer.
 *
 * @module
 */

import type { ArgsDef, CommandDef } from 'citty';
import { showUsage as cittyShowUsage } from 'citty';
import type { ShimCommand } from './commander-shim.js';

// ---------------------------------------------------------------------------
// ANSI helpers — matches citty's internal palette so output is visually
// consistent between grouped root help and per-command help.
// ---------------------------------------------------------------------------

const noColor = (() => {
  const env = globalThis.process?.env ?? {};
  return env.NO_COLOR === '1' || env.TERM === 'dumb' || env.TEST || env.CI;
})();

const ansi =
  (code: number, reset = 39) =>
  (t: string) =>
    noColor ? t : `\x1b[${code}m${t}\x1b[${reset}m`;
const bold = ansi(1, 22);
const cyan = ansi(36);
const gray = ansi(90);
const underline = ansi(4, 24);

// ---------------------------------------------------------------------------
// Domain groups
// ---------------------------------------------------------------------------

interface CommandGroup {
  name: string;
  commands: string[];
}

/**
 * Commands registered as separate `.command()` entries but semantically
 * aliases of another command. These are shown as `(alias)` next to the
 * primary command and hidden from the main listing.
 */
const IMPLICIT_ALIASES: Record<string, string> = {
  tags: 'labels',
};

/**
 * Descriptions for native citty commands that bypass the commander-shim.
 * These have no ShimCommand entry so must be provided explicitly.
 */
const NATIVE_COMMAND_DESCS: Record<string, string> = {
  version: 'Display CLEO version',
  code: 'Code analysis via tree-sitter AST',
};

/**
 * Ordered domain groups for the root help display.
 * Commands not listed here appear under "Other" at the bottom.
 */
const COMMAND_GROUPS: CommandGroup[] = [
  {
    name: 'Task Management',
    commands: [
      'add',
      'show',
      'find',
      'list',
      'update',
      'complete',
      'delete',
      'start',
      'stop',
      'current',
      'next',
      'exists',
      'bug',
    ],
  },
  {
    name: 'Task Organization',
    commands: [
      'archive',
      'labels',
      'promote',
      'relates',
      'reorder',
      'reparent',
      'deps',
      'tree',
      'blockers',
    ],
  },
  {
    name: 'Sessions & Planning',
    commands: ['session', 'briefing', 'dash', 'plan', 'safestop', 'context'],
  },
  {
    name: 'Phases & Lifecycle',
    commands: ['phase', 'phases', 'lifecycle', 'release', 'roadmap'],
  },
  {
    name: 'Memory & Notes',
    commands: ['memory', 'brain', 'refresh-memory', 'sticky', 'reason'],
  },
  {
    name: 'Analysis & Stats',
    commands: ['analyze', 'stats', 'history', 'archive-stats'],
  },
  {
    name: 'Validation & Compliance',
    commands: [
      'check',
      'validate',
      'verify',
      'testing',
      'compliance',
      'implementation',
      'specification',
      'consensus',
      'contribution',
      'decomposition',
      'backfill',
    ],
  },
  {
    name: 'Code & Documentation',
    commands: ['code', 'docs', 'detect-drift', 'map'],
  },
  {
    name: 'Research & Orchestration',
    commands: ['research', 'orchestrate'],
  },
  {
    name: 'Import / Export',
    commands: ['export', 'import', 'export-tasks', 'import-tasks', 'snapshot', 'inject'],
  },
  {
    name: 'Collaboration',
    commands: ['nexus', 'remote', 'push', 'pull', 'checkpoint'],
  },
  {
    name: 'Agents',
    commands: ['agent', 'grade'],
  },
  {
    name: 'System & Admin',
    commands: [
      'version',
      'init',
      'config',
      'env',
      'admin',
      'doctor',
      'upgrade',
      'self-update',
      'commands',
      'ops',
      'schema',
      'log',
      'sequence',
      'adr',
      'cant',
      'token',
      'otel',
      'migrate',
      'detect',
      'generate-changelog',
      'issue',
      'skills',
      'web',
      'backup',
      'restore',
    ],
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build alias lookup: alias name -> primary command name.
 * Includes both `.alias()` registrations and implicit aliases.
 */
export function buildAliasMap(shims: ShimCommand[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const shim of shims) {
    for (const alias of shim._aliases) {
      map.set(alias, shim._name);
    }
  }
  // Add implicit aliases (commands registered as separate .command() but
  // semantically aliases, e.g. `tags` → `labels`)
  for (const [alias, primary] of Object.entries(IMPLICIT_ALIASES)) {
    map.set(alias, primary);
  }
  return map;
}

/**
 * Extract a short one-line description from a shim's description.
 *
 * Commands that use `buildOperationHelp()` have multi-line descriptions
 * starting with `"Description: <one-liner>"`. This extracts just that line.
 * Other commands already have a one-liner.
 */
function getShortDescription(desc: string): string {
  if (!desc) return '';
  const match = desc.match(/^Description:\s*(.+)/);
  if (match) return match[1].trim();
  const firstLine = desc.split('\n').find((l) => l.trim().length > 0);
  return firstLine?.trim() ?? desc.trim();
}

// ---------------------------------------------------------------------------
// Grouped help renderer
// ---------------------------------------------------------------------------

/**
 * Render grouped help text for the root CLEO command.
 */
export function renderGroupedHelp(
  version: string,
  shims: ShimCommand[],
  aliasMap: Map<string, string>,
): string {
  // Build command -> short description map
  const descMap = new Map<string, string>();
  for (const shim of shims) {
    descMap.set(shim._name, getShortDescription(shim._description));
  }
  // Add native citty commands that bypass the commander-shim
  for (const [name, desc] of Object.entries(NATIVE_COMMAND_DESCS)) {
    if (!descMap.has(name)) {
      descMap.set(name, desc);
    }
  }

  // Build command -> aliases map (reverse of aliasMap)
  const cmdAliases = new Map<string, string[]>();
  for (const [alias, primary] of aliasMap) {
    const existing = cmdAliases.get(primary) ?? [];
    existing.push(alias);
    cmdAliases.set(primary, existing);
  }

  // Compute max display width for column alignment
  let maxCmdWidth = 0;
  const allGroupedCmds = COMMAND_GROUPS.flatMap((g) => g.commands);
  const allCmds = [...new Set([...allGroupedCmds, ...shims.map((s) => s._name), 'version'])];
  for (const cmd of allCmds) {
    if (!descMap.has(cmd) || aliasMap.has(cmd)) continue;
    const aliases = cmdAliases.get(cmd);
    const display = aliases && aliases.length > 0 ? `${cmd} (${aliases.join(', ')})` : cmd;
    if (display.length > maxCmdWidth) maxCmdWidth = display.length;
  }

  const lines: string[] = [];

  // Header
  lines.push(gray(`CLEO V2 - Task management for AI coding agents (cleo v${version})`));
  lines.push('');
  lines.push(`${underline(bold('USAGE'))} ${cyan('cleo <command> [OPTIONS]')}`);
  lines.push('');

  const rendered = new Set<string>();

  for (const group of COMMAND_GROUPS) {
    const groupLines: string[] = [];
    for (const cmd of group.commands) {
      if (!descMap.has(cmd)) continue;
      rendered.add(cmd);
      const aliases = cmdAliases.get(cmd);
      const display = aliases && aliases.length > 0 ? `${cmd} (${aliases.join(', ')})` : cmd;
      const desc = descMap.get(cmd) ?? '';
      groupLines.push(`  ${cyan(display.padEnd(maxCmdWidth + 2))}${desc}`);
    }
    if (groupLines.length > 0) {
      lines.push(underline(bold(group.name.toUpperCase())));
      lines.push(...groupLines);
      lines.push('');
    }
  }

  // Catch commands not in any group (safety net for new commands)
  const ungrouped: string[] = [];
  for (const shim of shims) {
    if (!rendered.has(shim._name) && !aliasMap.has(shim._name)) {
      ungrouped.push(shim._name);
    }
  }
  if (ungrouped.length > 0) {
    lines.push(underline(bold('OTHER')));
    for (const cmd of ungrouped) {
      const aliases = cmdAliases.get(cmd);
      const display = aliases && aliases.length > 0 ? `${cmd} (${aliases.join(', ')})` : cmd;
      const desc = descMap.get(cmd) ?? '';
      lines.push(`  ${cyan(display.padEnd(maxCmdWidth + 2))}${desc}`);
    }
    lines.push('');
  }

  lines.push(`Use ${cyan('cleo <command> --help')} for more information about a command.`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Custom showUsage factory
// ---------------------------------------------------------------------------

/**
 * Create a custom `showUsage` function that renders grouped help for the
 * root command and delegates to citty's default for sub-commands.
 *
 * Passed to `runMain(cmd, { showUsage })` so citty uses it for `--help`.
 */
export function createCustomShowUsage(
  version: string,
  shims: ShimCommand[],
  aliasMap: Map<string, string>,
): <T extends ArgsDef = ArgsDef>(cmd: CommandDef<T>, parent?: CommandDef<T>) => Promise<void> {
  return async <T extends ArgsDef = ArgsDef>(cmd: CommandDef<T>, parent?: CommandDef<T>) => {
    // Root command (no parent) → show grouped help
    if (!parent) {
      const meta = await (typeof cmd.meta === 'function' ? cmd.meta() : cmd.meta);
      if (meta?.name === 'cleo') {
        console.log(renderGroupedHelp(version, shims, aliasMap) + '\n');
        return;
      }
    }
    // Sub-commands → citty's default renderer
    await cittyShowUsage(cmd, parent);
  };
}
