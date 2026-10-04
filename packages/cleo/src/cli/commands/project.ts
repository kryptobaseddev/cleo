/**
 * CLI command group: cleo project — project lifecycle management.
 *
 * @task T11027
 * @task T12552 T12553 T12558 — pure dry runs, real error envelopes, reroot
 * @epic T10298
 * @saga T10295
 */

import { resolve } from 'node:path';
import type {
  EngineFailure,
  MoveProjectResult,
  NexusProjectLinkResult,
  ProjectRelocationPlan,
  RenderableEnvelope,
  RerootProjectResult,
} from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts';
import {
  CleoError,
  getProjectRoot,
  moveProject,
  projectLifecycle,
  renameProject,
  rerootProject,
} from '@cleocode/core';
import { defineCommand } from 'citty';
import { getFormatContext } from '../format-context.js';
import {
  emitNexusResult,
  failNexus,
  NEXUS_API_URL_ARG,
  nexusApiUrlArg,
  writeNexusWarnings,
} from '../lib/nexus-account-cli.js';
import { cliError, cliOutput } from '../renderers/index.js';

function formatSuccessSection(
  header: string,
  icon: string | undefined,
  items: string[],
): RenderableEnvelope<unknown> {
  const prefix = icon ? `${icon} ` : '';
  return { kind: 'section', data: { header: `${prefix}${header}`, items } };
}

/**
 * Emit an engine failure as a real LAFS error envelope (`success:false`) and
 * set the exit code from the engine's error class (T12553). Before T12553 the
 * failure was rendered as a SUCCESS section and the process then exited 1.
 */
function emitEngineFailure(error: EngineFailure['error'], operation: string): void {
  const exitCode = error.exitCode ?? ExitCode.GENERAL_ERROR;
  cliError(
    error.message,
    exitCode,
    { name: error.code, fix: error.fix, details: error.details },
    { operation },
  );
  process.exitCode = exitCode;
}

/**
 * Resolve the project root the way every other command does (walk up from
 * cwd), so `move` works from a subdirectory and `reroot .` from the child.
 * A refusal (`E_PROJECT_MOVED`, not a project) is emitted and `null` returned.
 */
function resolveRootOrFail(operation: string): string | null {
  try {
    return getProjectRoot();
  } catch (err) {
    const code =
      err instanceof CleoError && typeof err.details?.['code'] === 'string'
        ? err.details['code']
        : 'E_NOT_CLEO_PROJECT';
    emitEngineFailure(
      {
        code,
        message: (err as Error).message,
        exitCode: err instanceof CleoError ? err.code : ExitCode.CONFIG_ERROR,
        fix: err instanceof CleoError ? err.fix : undefined,
      },
      operation,
    );
    return null;
  }
}

/** Human lines for a relocation plan (`move` / `reroot` dry run). */
function planItems(plan: ProjectRelocationPlan): string[] {
  const r = plan.registry;
  return [
    `Source:      ${plan.source}`,
    `Target:      ${plan.target}`,
    `Rename:      ${plan.entries.join(', ') || '(nothing)'}`,
    ...plan.excluded.map((e) => `Left:        ${e.entry} (${e.reason})`),
    `Writes:      ${plan.writes.join(', ') || '(nothing)'}`,
    `Registry:    ${r.livePath} live; ${r.demotedPath} ${r.demotedState}`,
    `Checkpoint:  ${plan.checkpoint}`,
    ...plan.blockers.map((b) => `BLOCKER:     ${b}`),
    ...plan.deferredChecks.map((c) => `Checked at apply time: ${c}`),
    'Nothing was changed. Run without --dry-run to apply.',
  ];
}

/** Human lines for a completed move or reroot. */
function resultItems(r: MoveProjectResult | RerootProjectResult): string[] {
  const [from, to] = 'oldPath' in r ? [r.oldPath, r.newPath] : [r.oldRoot, r.newRoot];
  return [
    `Project ID:  ${r.projectId}`,
    `Old root:    ${from}`,
    `New root:    ${to}`,
    ...('renamed' in r ? [`Renamed:     ${r.renamed.join(', ') || '(resumed)'}`] : []),
    `Checkpoint:  ${r.checkpointPath || '(none: resumed)'}`,
    `Registry:    ${r.reconcileStatus}`,
    ...('notes' in r ? r.notes.map((n) => `Next:        ${n}`) : []),
  ];
}

/**
 * Emit a relocation plan or result: structured under `/data` for machines
 * (so `--field /data/blockers` works), a section for humans.
 */
function emitRelocation(
  data: ProjectRelocationPlan | MoveProjectResult | RerootProjectResult,
  operation: string,
): void {
  if (getFormatContext().format !== 'human') {
    cliOutput(data, { command: 'project', operation });
    return;
  }
  const verb = operation === 'project.move' ? 'move' : 'reroot';
  cliOutput(
    data.dryRun
      ? formatSuccessSection(`Dry Run: project ${verb}`, undefined, [
          `Project ID:  ${data.projectId}`,
          ...planItems(data),
        ])
      : formatSuccessSection(
          verb === 'move' ? 'Project Moved' : 'Project Rerooted',
          '✅',
          resultItems(data),
        ),
    { command: 'project', operation },
  );
}

const moveSubCommand = defineCommand({
  meta: {
    name: 'move',
    description:
      'Move this project to a new path on the same device by RENAMING its root: .git, the database and everything else move together, nothing is copied and no old copy is left. The registry is rebound to the new path. Refuses a cross-device target (use a plain `mv`, then any cleo command), a target inside the project (use `cleo project reroot`), and any move while sessions are active or worktrees exist (end them first).',
  },
  args: {
    newPath: {
      type: 'positional',
      description: 'New project root: absent or an empty directory, outside this project.',
      required: true,
    },
    'dry-run': {
      type: 'boolean',
      description: 'Print the plan (renames, blockers, registry action) and change nothing.',
      default: false,
    },
    json: { type: 'boolean', description: 'Output raw JSON envelope.', default: false },
  },
  async run({ args }) {
    const operation = 'project.move';
    const root = resolveRootOrFail(operation);
    if (root === null) return;
    const result = await moveProject(resolve(args['newPath']), root, {
      dryRun: args['dry-run'] === true,
    });
    if (!result.success) {
      emitEngineFailure(result.error, operation);
      return;
    }
    emitRelocation(result.data, operation);
  },
});

const rerootSubCommand = defineCommand({
  meta: {
    name: 'reroot',
    description:
      "Make a subdirectory of this project the project root. Checkpoints, then RENAMES CLEO's own top-level entries into it (.cleo/, .worktreeinclude, and .github/ when it holds only CLEO's init templates), keeps the same project id, leaves a .cleo-moved.json tombstone at the old root and rebinds the registry. Everything else stays. Refuses while a session or worktree is active. Run `cleo project reroot .` from the child to finish an interrupted reroot.",
  },
  args: {
    childDir: {
      type: 'positional',
      description:
        'Existing subdirectory of the current project root (`.` from the child resumes).',
      required: true,
    },
    'dry-run': {
      type: 'boolean',
      description: 'Print the plan and change nothing (no disk, no registry).',
      default: false,
    },
    json: { type: 'boolean', description: 'Output raw JSON envelope.', default: false },
  },
  async run({ args }) {
    const operation = 'project.reroot';
    const root = resolveRootOrFail(operation);
    if (root === null) return;
    const result = await rerootProject(resolve(args['childDir']), root, {
      dryRun: args['dry-run'] === true,
    });
    if (!result.success) {
      emitEngineFailure(result.error, operation);
      return;
    }
    emitRelocation(result.data, operation);
  },
});

const renameSubCommand = defineCommand({
  meta: {
    name: 'rename',
    description:
      'Rename this project: the committed .cleo/project.json name, the registry label, and a Cleo Nexus relink hint (the id never changes).',
  },
  args: {
    newName: { type: 'positional', description: 'New project name.', required: true },
    'dry-run': { type: 'boolean', description: 'Validate without applying.', default: false },
    json: { type: 'boolean', description: 'Output raw JSON envelope.', default: false },
  },
  async run({ args }) {
    const newName = args['newName'];
    const dryRun = args['dry-run'] ?? false;
    const nameRe = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;
    if (!newName || !nameRe.test(newName)) {
      emitEngineFailure(
        {
          code: 'E_VALIDATION',
          message: `Invalid project name: "${newName}".`,
          exitCode: ExitCode.INVALID_INPUT,
          fix: 'Use 1-100 characters: letters, digits, "_" or "-", starting with a letter or digit',
        },
        'project.rename',
      );
      return;
    }
    if (dryRun) {
      cliOutput(
        formatSuccessSection('Dry Run', undefined, [
          `Would rename project to "${newName}".`,
          'Run without --dry-run to apply.',
        ]),
        { command: 'project', operation: 'project.rename' },
      );
      return;
    }
    const result = await renameProject(newName, process.cwd());
    if (result.success) {
      const r = result.data;
      cliOutput(
        formatSuccessSection('Project Renamed', '✅', [
          `Project ID:   ${r.projectId}`,
          `Old name:     ${r.oldName}`,
          `New name:     ${r.newName}`,
          `Project hash: ${r.newProjectHash}`,
          ...(r.recordedIn ? [`Recorded in:  .cleo/${r.recordedIn}`] : []),
          ...(r.registry ? [`Registry:     ${r.registry}`] : []),
          ...(r.nexusLabel ? [`Nexus label:  ${r.nexusLabel}`] : []),
          ...(r.hint ? [`Next:         ${r.hint}`] : []),
        ]),
        { command: 'project', operation: 'project.rename' },
      );
    } else {
      emitEngineFailure(result.error, 'project.rename');
    }
  },
});

const reregisterSubCommand = defineCommand({
  meta: { name: 're-register', description: 'Re-register project with NEXUS.' },
  args: {
    fix: { type: 'boolean', description: 'Auto-heal path_updated drift.', default: false },
    json: { type: 'boolean', description: 'Output raw JSON envelope.', default: false },
  },
  async run() {
    const result = await projectLifecycle.reregisterProject(process.cwd());
    if (result.success) {
      const r = result.data;
      const icon = r.drifted ? '⚠️' : '✅';
      const items = [
        `Project ID:  ${r.projectId}`,
        `Project root: ${r.projectRoot}`,
        `Hash:        ${r.projectHash}`,
        `Status:      ${r.reconcileStatus}`,
      ];
      if (r.drifted && r.oldPath) items.push(`Old path:    ${r.oldPath}`);
      cliOutput(
        formatSuccessSection(
          r.drifted ? 'Project Re-registered (Drift Detected)' : 'Project Re-registered',
          icon,
          items,
        ),
        { command: 'project', operation: 'project.re-register' },
      );
    } else {
      emitEngineFailure(result.error, 'project.re-register');
    }
  },
});

/**
 * `cleo project link` — register this project with Cleo Nexus under its
 * `.cleo/project-id`, with its display name as a plaintext label (`--label`
 * overrides; never a path), and record the binding in `.cleo/nexus-link.json`.
 * Idempotent; re-linking after a rename updates the label. Logic:
 * `@cleocode/core/cloud/nexus-link.js`.
 *
 * @task T12712
 */
const linkSubCommand = defineCommand({
  meta: {
    name: 'link',
    description:
      'Register this project with Cleo Nexus under its project id (.cleo/project-id) with its name as a plaintext label (--label overrides; never a filesystem path). Idempotent: re-linking after a rename updates the label. Requires cleo login nexus.',
  },
  args: {
    label: {
      type: 'string',
      description:
        'Name shown in Nexus, sent in plaintext (default: the project name). A name, never a path.',
    },
    rebind: {
      type: 'boolean',
      description:
        'Use only after E_NEXUS_REPLICA_COPIED: give this copy of the project a new replica id before attaching it (this machine was re-enrolled, or the store was copied). Each run mints a new id and leaves the old one on the server as stale history.',
    },
    'api-url': NEXUS_API_URL_ARG,
    json: { type: 'boolean', description: 'Output raw JSON envelope.', default: false },
  },
  async run({ args }) {
    const { linkProjectToNexus } = await import(
      /* webpackIgnore: true */ '@cleocode/core/cloud/nexus-link.js'
    );
    let result: NexusProjectLinkResult;
    try {
      result = await linkProjectToNexus({
        apiUrl: nexusApiUrlArg(args),
        ...(typeof args['label'] === 'string' && args['label'] ? { label: args['label'] } : {}),
        ...(args['rebind'] === true ? { rebind: true } : {}),
      });
    } catch (err) {
      failNexus(err, 'project.link');
    }
    const { link, replica } = result;
    const verb = result.alreadyLinked ? 'Already linked' : 'Linked';
    const attached = replica
      ? ` This machine (device ${replica.deviceId}) holds it as replica ${replica.replicaId}${replica.reboundFrom ? ` (rebound from ${replica.reboundFrom})` : ''}${replica.presenceAt ? '; presence reported' : ''}.`
      : '';
    const keyed =
      result.initialKeyVersion !== null
        ? ` Its encryption key (version ${result.initialKeyVersion}) was stored with the registration.`
        : '';
    const summary = `${verb}: project ${link.localProjectId} as "${link.label ?? ''}" on ${link.apiUrl}.${attached}${keyed}`;
    writeNexusWarnings(result.warnings);
    emitNexusResult(result, summary, 'project', 'project.link');
  },
});

export const projectCommand = defineCommand({
  meta: {
    name: 'project',
    description: 'Project lifecycle management (move, reroot, rename, re-register, link).',
  },
  subCommands: {
    link: linkSubCommand,
    move: moveSubCommand,
    reroot: rerootSubCommand,
    rename: renameSubCommand,
    're-register': reregisterSubCommand,
  },
});
