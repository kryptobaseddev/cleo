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

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { cwd as processCwd } from 'node:process';
import type { AdoptedSkillRowData, DoctorAdoptCliAdapters } from '@cleocode/caamp';
import { AgentsSkillsRealDirError, runDoctorAdopt, runDoctorBridge } from '@cleocode/caamp';
import { withProvenance } from '@cleocode/core/sentient';
import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import { isSubCommandDispatch } from '../lib/subcommand-guard.js';
import { cliError, cliOutput } from '../renderers/index.js';

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

/**
 * cleo skills doctor bridge — single bridge symlink + per-skill symlink removal (T9655).
 */
const doctorBridgeCommand = defineCommand({
  meta: {
    name: 'bridge',
    description:
      'Create the single ~/.agents/skills bridge symlink + remove orphan per-skill symlinks',
  },
  args: {
    force: {
      type: 'boolean',
      description: 'Back up and replace a real ~/.agents/skills directory if present',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Print planned actions without mutating disk state',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON (default)',
    },
    human: {
      type: 'boolean',
      description: 'Output in human-readable format',
    },
  },
  async run({ args }) {
    const { cliError, cliOutput } = await import('../renderers/index.js');
    try {
      const result = await runDoctorBridge({
        force: args.force === true,
        dryRun: args['dry-run'] === true,
      });
      cliOutput(
        { success: true, data: result },
        { command: 'skills doctor bridge', operation: 'skills.doctor.bridge' },
      );
    } catch (error) {
      if (error instanceof AgentsSkillsRealDirError) {
        cliError(
          error.message,
          error.code,
          {
            details: {
              agentsSkillsPath: error.agentsSkillsPath,
              entryCount: error.entryCount,
            },
          },
          { operation: 'skills.doctor.bridge' },
        );
        process.exit(1);
      }
      const message = error instanceof Error ? error.message : String(error);
      cliError(message, 'E_INTERNAL_ERROR', undefined, {
        operation: 'skills.doctor.bridge',
      });
      process.exit(1);
    }
  },
});

/**
 * Build the cleo-side `DoctorAdoptCliAdapters` that route every skills.db
 * access through the canonical `openCleoDb('skills')` chokepoint (ADR-068).
 *
 * @remarks
 * caamp cannot import `@cleocode/core` (dep direction is core → caamp), so
 * caamp emits pure-data callbacks and the cleo dispatch layer wires the
 * concrete sqlite helpers. Construction is lazy to keep `@cleocode/core`
 * out of the cold-start path for `cleo skills` invocations that never
 * touch the registry.
 *
 * @returns Adapters that delegate read+write to core's `skills-db` module.
 *
 * @task T9657
 */
function buildSkillsDoctorAdoptAdapters(): DoctorAdoptCliAdapters {
  return {
    loadRegisteredNames: async (): Promise<ReadonlySet<string>> => {
      const { listSkillsBySource } = await import('@cleocode/core');
      const rows = await Promise.all([
        listSkillsBySource('canonical'),
        listSkillsBySource('user'),
        listSkillsBySource('community'),
        listSkillsBySource('agent-created'),
      ]);
      return new Set(rows.flat().map((r) => r.name));
    },
    recordRow: async (data: AdoptedSkillRowData): Promise<void> => {
      const { upsertSkillRow } = await import('@cleocode/core');
      await upsertSkillRow({
        name: data.name,
        sourceType: data.sourceType,
        installPath: data.installPath,
        installedAt: data.installedAt,
        lifecycleState: data.lifecycleState,
        pinned: false,
        isAgentCreated: false,
      });
    },
  };
}

/**
 * cleo skills doctor adopt-orphans — interactive orphan audit + adoption (T9657).
 *
 * Routes skills.db reads + writes through `openCleoDb('skills')` from
 * `@cleocode/core/store/skills-db` to satisfy the ADR-068 chokepoint guard.
 */
const doctorAdoptOrphansCommand = defineCommand({
  meta: {
    name: 'adopt-orphans',
    description:
      'Interactive audit of on-disk skill dirs not tracked in skills.db (canonical/user/delete/skip)',
  },
  args: {
    'non-interactive': {
      type: 'boolean',
      description: 'List orphans + exit without action',
    },
    'auto-user-adopt': {
      type: 'boolean',
      description: 'Bulk-mark all orphans as source_type=user without prompting',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON (default)',
    },
    human: {
      type: 'boolean',
      description: 'Output in human-readable format',
    },
  },
  async run({ args }) {
    const { cliError, cliOutput } = await import('../renderers/index.js');
    try {
      const adapters = buildSkillsDoctorAdoptAdapters();
      const result = await runDoctorAdopt({
        nonInteractive: args['non-interactive'] === true,
        autoUserAdopt: args['auto-user-adopt'] === true,
        loadRegisteredNames: adapters.loadRegisteredNames,
        recordRow: adapters.recordRow,
      });
      cliOutput(
        { success: true, data: result },
        { command: 'skills doctor adopt-orphans', operation: 'skills.doctor.adopt-orphans' },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      cliError(message, 'E_INTERNAL_ERROR', undefined, {
        operation: 'skills.doctor.adopt-orphans',
      });
      process.exit(1);
    }
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
 * `cleo skills doctor diagnose` — read-only health report (T9652).
 *
 * Reports canonical SSoT path state, legacy fallback presence, bridge symlink
 * status, `~/.claude/skills/agents-shared/` link integrity, skills.db drift,
 * and orphan directories. Performs zero writes.
 */
const doctorDiagnoseCommand = defineCommand({
  meta: {
    name: 'diagnose',
    description: 'Read-only health report on skill storage, db drift, orphans, and bridge symlinks',
  },
  args: {
    verbose: {
      type: 'boolean',
      description: 'Include per-skill detail in the rendered summary',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'tools',
      'skill.doctor.diagnose',
      { verbose: !!args.verbose },
      { command: 'skills', operation: 'tools.skill.doctor.diagnose' },
    );
  },
});

/** cleo skills doctor — skill-store health + bridge/adopt-orphans subcommands (T9652, T9655, T9657). */
const doctorCommand = defineCommand({
  meta: {
    name: 'doctor',
    description: 'Skill-store health checks (diagnose, bridge, adopt-orphans)',
  },
  subCommands: {
    diagnose: doctorDiagnoseCommand,
    bridge: doctorBridgeCommand,
    'adopt-orphans': doctorAdoptOrphansCommand,
  },
  async run({ cmd, rawArgs }) {
    // Default to diagnose when no subcommand is given.
    if (isSubCommandDispatch(rawArgs, cmd.subCommands)) return;
    await dispatchFromCli(
      'query',
      'tools',
      'skill.doctor.diagnose',
      { verbose: false },
      { command: 'skills', operation: 'tools.skill.doctor.diagnose' },
    );
  },
});

/**
 * `cleo skill propose-patch <name> --diff <path>` — open a PR against the
 * cleocode repo carrying a canonical-skill patch (T9714).
 *
 * Sphere A canonical skills are owner-CI-only: the write-guard at
 * `upsertSkillRow` refuses any mutation unless the active provenance
 * frame is `'pr-generator'`. This command IS that legal bypass:
 *
 *   1. Reads the unified diff at `--diff <path>`.
 *   2. Verifies `gh` CLI is available + authenticated.
 *   3. Cuts a `propose-patch/skill-<name>-<timestamp>` branch in the
 *      current cleocode checkout (cwd MUST be a cleocode worktree).
 *   4. Applies the diff with `git apply` and commits.
 *   5. Pushes the branch and opens the PR via `gh pr create`.
 *
 * The actual on-cwd skill mutation runs inside
 * `withProvenance('pr-generator', ...)` so the (hypothetical) follow-on
 * `skills.db` row update from `cleo skills install` would be permitted.
 * For the PR-cut path itself the only canonical artefacts touched are
 * the source files in `packages/skills/skills/<name>/`, which are
 * filesystem entries (not `skills.db` rows).
 *
 * @task T9714
 * @epic T9563
 */
const proposePatchCommand = defineCommand({
  meta: {
    name: 'propose-patch',
    description: 'Open a PR against the cleocode repo carrying a canonical-skill patch (Sphere A)',
  },
  args: {
    'skill-name': {
      type: 'positional',
      description: 'Skill identifier (e.g. ct-orchestrator)',
      required: true,
    },
    diff: {
      type: 'string',
      description: 'Path to a unified-diff file to apply',
      required: true,
    },
    title: {
      type: 'string',
      description: 'PR title (defaults to "skill(<name>): proposed patch")',
    },
    body: {
      type: 'string',
      description: 'PR body markdown (defaults to a stub citing the skill + diff path)',
    },
    base: {
      type: 'string',
      description: 'Base branch for the PR (defaults to main)',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Print the steps without invoking git/gh',
    },
    json: {
      type: 'boolean',
      description: 'Emit LAFS JSON envelope',
    },
  },
  async run({ args }) {
    const skillName = String(args['skill-name']);
    const diffPath = String(args.diff);
    const title =
      typeof args.title === 'string' && args.title.length > 0
        ? args.title
        : `skill(${skillName}): proposed patch`;
    const body =
      typeof args.body === 'string' && args.body.length > 0
        ? args.body
        : [
            `Auto-improve patch for canonical skill **${skillName}**.`,
            '',
            `Diff source: \`${diffPath}\``,
            '',
            'This PR was opened via `cleo skill propose-patch` (T9714).',
            'Sphere A canonical skills are owner-CI-only — the local',
            'sentient daemon CANNOT mutate them in place; this PR is the',
            'audited path for incorporating a council-approved patch.',
          ].join('\n');
    const base = typeof args.base === 'string' && args.base.length > 0 ? args.base : 'main';
    const dryRun = args['dry-run'] === true;
    const jsonMode = args.json === true;

    const resolvedDiff = resolvePath(processCwd(), diffPath);
    if (!existsSync(resolvedDiff)) {
      cliError(
        `Diff file not found at '${resolvedDiff}'`,
        'E_NOT_FOUND',
        { name: 'E_NOT_FOUND' },
        { operation: 'tools.skill.propose-patch' },
      );
      process.exit(1);
      return;
    }
    const diffBytes = readFileSync(resolvedDiff, 'utf8');
    if (diffBytes.length === 0) {
      cliError(
        `Diff file '${resolvedDiff}' is empty`,
        'E_PATCH_EMPTY',
        { name: 'E_PATCH_EMPTY' },
        { operation: 'tools.skill.propose-patch' },
      );
      process.exit(1);
      return;
    }

    // gh availability check — handle the dry-run path before invoking.
    if (!dryRun) {
      try {
        execFileSync('gh', ['--version'], { stdio: 'pipe' });
      } catch {
        cliError(
          'gh CLI not found or not authenticated — install gh and run `gh auth login`',
          'E_GH_UNAVAILABLE',
          { name: 'E_GH_UNAVAILABLE' },
          { operation: 'tools.skill.propose-patch' },
        );
        process.exit(1);
        return;
      }
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const branchName = `propose-patch/skill-${skillName}-${timestamp}`;
    const steps: string[] = [
      `git checkout -b ${branchName}`,
      `git apply ${resolvedDiff}`,
      `git add -A`,
      `git commit -m "skill(${skillName}): propose patch"`,
      `git push -u origin ${branchName}`,
      `gh pr create --base ${base} --head ${branchName} --title "${title}" --body <stdin>`,
    ];

    if (dryRun) {
      cliOutput(
        {
          skillName,
          diffPath: resolvedDiff,
          branchName,
          base,
          steps,
          dryRun: true,
        },
        {
          command: 'skills',
          message: `[dry-run] would open PR for ${skillName} on branch ${branchName}`,
          operation: 'tools.skill.propose-patch',
        },
      );
      return;
    }

    try {
      const result = await withProvenance('pr-generator', async () => {
        execFileSync('git', ['checkout', '-b', branchName], { stdio: 'pipe' });
        execFileSync('git', ['apply', resolvedDiff], { stdio: 'pipe' });
        execFileSync('git', ['add', '-A'], { stdio: 'pipe' });
        execFileSync('git', ['commit', '-m', `skill(${skillName}): propose patch`], {
          stdio: 'pipe',
        });
        execFileSync('git', ['push', '-u', 'origin', branchName], { stdio: 'pipe' });
        const prUrl = execFileSync(
          'gh',
          ['pr', 'create', '--base', base, '--head', branchName, '--title', title, '--body', body],
          { stdio: 'pipe' },
        )
          .toString('utf8')
          .trim();
        return { prUrl, branchName };
      });
      cliOutput(
        { skillName, prUrl: result.prUrl, branchName: result.branchName, base },
        {
          command: 'skills',
          message: `Opened PR ${result.prUrl}`,
          operation: 'tools.skill.propose-patch',
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cliError(
        `propose-patch failed: ${message}`,
        'E_PROPOSE_PATCH_FAILED',
        { name: 'E_PROPOSE_PATCH_FAILED' },
        { operation: 'tools.skill.propose-patch' },
      );
      process.exit(1);
    }
    // jsonMode is honoured automatically by cliOutput / cliError via the
    // global --json flag; the local variable is kept for symmetry with
    // other commands and to silence the lint about unused destructure.
    void jsonMode;
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
    doctor: doctorCommand,
    'propose-patch': proposePatchCommand,
  },
  async run({ cmd, rawArgs }) {
    // Parent run() fires after subcommand per citty@0.2.x — skip default
    // list so `cleo skills install X` doesn't also list. T1187-followup.
    if (isSubCommandDispatch(rawArgs, cmd.subCommands)) return;
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
