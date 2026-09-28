/**
 * CLI command group: cleo project — project lifecycle management.
 *
 * @task T11027
 * @task T12552 T12553 T12558 — pure dry runs, real error envelopes, reroot
 * @epic T10298
 * @saga T10295
 */

import { resolve } from 'node:path';
import type { EngineFailure, ProjectRelocationPlan, RenderableEnvelope } from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts';
import { moveProject, projectLifecycle, renameProject, rerootProject } from '@cleocode/core';
import { defineCommand } from 'citty';
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

/** Human lines for a relocation plan (`move` / `reroot` dry run). */
function planItems(plan: ProjectRelocationPlan): string[] {
  const r = plan.registry;
  return [
    `Project ID:  ${plan.projectId}`,
    `Source:      ${plan.source}`,
    `Target:      ${plan.target}`,
    `Transfer:    ${plan.transfer} ${plan.entries.join(', ') || '(nothing)'}`,
    `Excluded:    ${plan.excluded.join(', ') || '(none)'}`,
    `Writes:      ${plan.writes.join(', ')}`,
    `Registry:    ${r.action} → ${r.livePath} live; ${r.demotedPath} ${r.demotedState} (nonce ${r.nonce})`,
    ...(plan.checkpoint ? [`Checkpoint:  ${plan.checkpoint}`] : []),
    ...plan.blockers.map((b) => `BLOCKER:     ${b}`),
    ...plan.deferredChecks.map((c) => `Checked at apply time: ${c}`),
    'Nothing was changed. Run without --dry-run to apply.',
  ];
}

const moveSubCommand = defineCommand({
  meta: {
    name: 'move',
    description:
      'Copy this project to a new directory (root-level .git and node_modules are not copied), leave the old copy in place, and rebind the registry to the new copy. The old copy is demoted; delete it yourself. For a subdirectory of this project use `cleo project reroot`.',
  },
  args: {
    newPath: {
      type: 'positional',
      description: 'New project root: absent or an empty directory, outside this project.',
      required: true,
    },
    'dry-run': {
      type: 'boolean',
      description: 'Print the plan (files, registry action) and change nothing.',
      default: false,
    },
    json: { type: 'boolean', description: 'Output raw JSON envelope.', default: false },
  },
  async run({ args }) {
    const newPath = resolve(args['newPath']);
    const operation = 'project.move';
    const dryRun = args['dry-run'] === true;
    const result = await moveProject(newPath, process.cwd(), { dryRun });
    if (!result.success) {
      emitEngineFailure(result.error, operation);
      return;
    }
    const r = result.data;
    if (r.dryRun) {
      cliOutput(formatSuccessSection('Dry Run: project move', undefined, planItems(r)), {
        command: 'project',
        operation,
      });
      return;
    }
    cliOutput(
      formatSuccessSection('Project Copied and Rebound', '✅', [
        `Project ID:  ${r.projectId}`,
        `Old path:    ${r.oldPath} (left in place, demoted)`,
        `New path:    ${r.newPath}`,
        `New hash:    ${r.newProjectHash}`,
        `Not copied:  ${r.excluded.join(', ') || '(none)'}`,
        `Registry:    ${r.reconcileStatus}`,
      ]),
      { command: 'project', operation },
    );
  },
});

const rerootSubCommand = defineCommand({
  meta: {
    name: 'reroot',
    description:
      'Make a subdirectory of this project the project root: checkpoint, then RENAME .cleo/ (and .worktreeinclude) into it, keep the same project id, and rebind the registry. Refuses while a session or worktree is active.',
  },
  args: {
    childDir: {
      type: 'positional',
      description: 'Existing subdirectory of the current project root.',
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
    const childDir = resolve(args['childDir']);
    const operation = 'project.reroot';
    const dryRun = args['dry-run'] === true;
    const result = await rerootProject(childDir, process.cwd(), { dryRun });
    if (!result.success) {
      emitEngineFailure(result.error, operation);
      return;
    }
    const r = result.data;
    if (r.dryRun) {
      cliOutput(formatSuccessSection('Dry Run: project reroot', undefined, planItems(r)), {
        command: 'project',
        operation,
      });
      return;
    }
    cliOutput(
      formatSuccessSection('Project Rerooted', '✅', [
        `Project ID:  ${r.projectId}`,
        `Old root:    ${r.oldRoot}`,
        `New root:    ${r.newRoot}`,
        `Renamed:     ${r.renamed.join(', ')}`,
        `project-id:  ${r.projectIdFile}`,
        `Checkpoint:  ${r.checkpointId}`,
        `Registry:    ${r.reconcileStatus}`,
        ...r.notes.map((n) => `Next:        ${n}`),
      ]),
      { command: 'project', operation },
    );
  },
});

const renameSubCommand = defineCommand({
  meta: { name: 'rename', description: 'Rename this project.' },
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

export const projectCommand = defineCommand({
  meta: {
    name: 'project',
    description: 'Project lifecycle management (move, reroot, rename, re-register).',
  },
  subCommands: {
    move: moveSubCommand,
    reroot: rerootSubCommand,
    rename: renameSubCommand,
    're-register': reregisterSubCommand,
  },
});
