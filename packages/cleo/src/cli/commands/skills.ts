/**
 * CLI skills command group — skill management: list, search, validate, info, install.
 *
 * Exposes all skill operations under the tools domain as native citty subcommands:
 *
 *   cleo skills list            — list installed skills
 *   cleo skills search <query>  — search for skills
 *   cleo skills validate <name> — validate skill against protocol
 *   cleo skills info <name>     — show skill details
 *   cleo skills install <name>  — install skill to agent directory
 *   cleo skills uninstall <name>— uninstall a skill
 *   cleo skills enable <name>   — enable a skill (alias for install)
 *   cleo skills disable <name>  — disable a skill (alias for uninstall)
 *   cleo skills refresh         — refresh skills cache
 *   cleo skills dispatch <name> — resolve dispatch path for a skill
 *   cleo skills catalog         — browse CAAMP skill catalog
 *   cleo skills precedence      — show or resolve skill provider precedence
 *   cleo skills deps <name>     — show skill dependency tree
 *   cleo skills spawn-providers — list providers capable of spawning subagents
 *
 * @task T4555
 * @epic T4545
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/** cleo skills list — list installed skills */
const listCommand = defineCommand({
  meta: { name: 'list', description: 'List installed skills' },
  args: {
    global: {
      type: 'boolean',
      description: 'Use global skills directory',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'tools',
      'skill.list',
      {
        scope: args.global ? 'global' : 'project',
      },
      { command: 'skills', operation: 'tools.skill.list' },
    );
  },
});

/** cleo skills search — search for skills */
const searchCommand = defineCommand({
  meta: { name: 'search', description: 'Search for skills' },
  args: {
    query: {
      type: 'positional',
      description: 'Search query',
      required: true,
    },
    mp: {
      type: 'boolean',
      description: 'Search marketplace (agentskills.in)',
    },
    all: {
      type: 'boolean',
      description: 'Search both local and marketplace',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'tools',
      'skill.find',
      {
        query: args.query,
        source: args.mp ? 'skillsmp' : args.all ? 'all' : 'local',
      },
      { command: 'skills', operation: 'tools.skill.find' },
    );
  },
});

/** cleo skills validate — validate skill against protocol */
const validateCommand = defineCommand({
  meta: { name: 'validate', description: 'Validate skill against protocol' },
  args: {
    'skill-name': {
      type: 'positional',
      description: 'Skill name to validate',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'tools',
      'skill.verify',
      {
        name: args['skill-name'],
      },
      { command: 'skills', operation: 'tools.skill.verify' },
    );
  },
});

/** cleo skills info — show skill details */
const infoCommand = defineCommand({
  meta: { name: 'info', description: 'Show skill details' },
  args: {
    'skill-name': {
      type: 'positional',
      description: 'Skill name to show details for',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'tools',
      'skill.show',
      {
        name: args['skill-name'],
      },
      { command: 'skills', operation: 'tools.skill.show' },
    );
  },
});

/** cleo skills install — install skill to agent directory */
const installCommand = defineCommand({
  meta: { name: 'install', description: 'Install skill to agent directory' },
  args: {
    'skill-name': {
      type: 'positional',
      description: 'Skill name to install',
      required: true,
    },
    global: {
      type: 'boolean',
      description: 'Install globally',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'tools',
      'skill.install',
      {
        name: args['skill-name'],
        global: !!args.global,
      },
      { command: 'skills', operation: 'tools.skill.install' },
    );
  },
});

/** cleo skills uninstall — uninstall a skill */
const uninstallCommand = defineCommand({
  meta: { name: 'uninstall', description: 'Uninstall a skill' },
  args: {
    'skill-name': {
      type: 'positional',
      description: 'Skill name to uninstall',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'tools',
      'skill.uninstall',
      {
        name: args['skill-name'],
      },
      { command: 'skills', operation: 'tools.skill.uninstall' },
    );
  },
});

/** cleo skills enable — enable a skill (alias for install, skill.enable was removed in T5615) */
const enableCommand = defineCommand({
  meta: { name: 'enable', description: 'Enable a skill (alias for install)' },
  args: {
    'skill-name': {
      type: 'positional',
      description: 'Skill name to enable',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'tools',
      'skill.install',
      {
        name: args['skill-name'],
      },
      { command: 'skills', operation: 'tools.skill.install' },
    );
  },
});

/** cleo skills disable — disable a skill (alias for uninstall, skill.disable was removed in T5615) */
const disableCommand = defineCommand({
  meta: { name: 'disable', description: 'Disable a skill (alias for uninstall)' },
  args: {
    'skill-name': {
      type: 'positional',
      description: 'Skill name to disable',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'mutate',
      'tools',
      'skill.uninstall',
      {
        name: args['skill-name'],
      },
      { command: 'skills', operation: 'tools.skill.uninstall' },
    );
  },
});

/** cleo skills refresh — refresh skills cache */
const refreshCommand = defineCommand({
  meta: { name: 'refresh', description: 'Refresh skills cache' },
  async run() {
    await dispatchFromCli(
      'mutate',
      'tools',
      'skill.refresh',
      {},
      {
        command: 'skills',
        operation: 'tools.skill.refresh',
      },
    );
  },
});

/** cleo skills dispatch — resolve dispatch path for a skill */
const dispatchCommand = defineCommand({
  meta: { name: 'dispatch', description: 'Resolve dispatch path for a skill' },
  args: {
    'skill-name': {
      type: 'positional',
      description: 'Skill name to resolve dispatch path for',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'tools',
      'skill.dispatch',
      { name: args['skill-name'] },
      { command: 'skills', operation: 'tools.skill.dispatch' },
    );
  },
});

/** cleo skills catalog — browse CAAMP skill catalog */
const catalogCommand = defineCommand({
  meta: {
    name: 'catalog',
    description: 'Browse CAAMP skill catalog (protocols, profiles, resources, info)',
  },
  args: {
    type: {
      type: 'string',
      description: 'Catalog type: protocols, profiles, resources, info (default: info)',
    },
    limit: {
      type: 'string',
      description: 'Maximum items to return',
    },
    offset: {
      type: 'string',
      description: 'Offset for pagination',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'tools',
      'skill.catalog',
      {
        type: args.type ?? 'info',
        limit: args.limit ? Number(args.limit) : undefined,
        offset: args.offset ? Number(args.offset) : undefined,
      },
      { command: 'skills', operation: 'tools.skill.catalog' },
    );
  },
});

/** cleo skills precedence — show or resolve skill provider precedence */
const precedenceCommand = defineCommand({
  meta: { name: 'precedence', description: 'Show or resolve skill provider precedence' },
  args: {
    resolve: {
      type: 'string',
      description: 'Resolve precedence for a specific provider',
    },
    scope: {
      type: 'string',
      description: 'Scope: global or project (default: global)',
    },
  },
  async run({ args }) {
    const providerId = args.resolve as string | undefined;
    await dispatchFromCli(
      'query',
      'tools',
      'skill.precedence',
      {
        action: providerId ? 'resolve' : 'show',
        providerId,
        scope: args.scope ?? 'global',
      },
      { command: 'skills', operation: 'tools.skill.precedence' },
    );
  },
});

/** cleo skills deps — show skill dependency tree */
const depsCommand = defineCommand({
  meta: { name: 'deps', description: 'Show skill dependency tree' },
  args: {
    'skill-name': {
      type: 'positional',
      description: 'Skill name to show dependency tree for',
      required: true,
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'tools',
      'skill.dependencies',
      { name: args['skill-name'] },
      { command: 'skills', operation: 'tools.skill.dependencies' },
    );
  },
});

/** cleo skills spawn-providers — list providers capable of spawning subagents */
const spawnProvidersCommand = defineCommand({
  meta: { name: 'spawn-providers', description: 'List providers capable of spawning subagents' },
  args: {
    capability: {
      type: 'string',
      description:
        'Filter by capability: supportsSubagents, supportsProgrammaticSpawn, supportsInterAgentComms, supportsParallelSpawn',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'tools',
      'skill.spawn.providers',
      { capability: args.capability },
      { command: 'skills', operation: 'tools.skill.spawn.providers' },
    );
  },
});

/**
 * Root skills command group — registers all skill management subcommands.
 *
 * Default action (no subcommand) dispatches to `tools.skill.list` for project scope.
 * Dispatches to `tools.skill.*` registry operations.
 */
export const skillsCommand = defineCommand({
  meta: { name: 'skills', description: 'Skill management: list, search, validate, info, install' },
  subCommands: {
    list: listCommand,
    search: searchCommand,
    validate: validateCommand,
    info: infoCommand,
    install: installCommand,
    uninstall: uninstallCommand,
    enable: enableCommand,
    disable: disableCommand,
    refresh: refreshCommand,
    dispatch: dispatchCommand,
    catalog: catalogCommand,
    precedence: precedenceCommand,
    deps: depsCommand,
    'spawn-providers': spawnProvidersCommand,
  },
  async run() {
    await dispatchFromCli(
      'query',
      'tools',
      'skill.list',
      {
        scope: 'project',
      },
      { command: 'skills', operation: 'tools.skill.list' },
    );
  },
});
