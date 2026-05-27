/**
 * CLI command group: cleo project — project lifecycle management.
 *
 * @task T11027
 * @epic T10298
 * @saga T10295
 */

import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RenderableEnvelope } from '@cleocode/contracts';
import { moveProject, projectLifecycle, renameProject } from '@cleocode/core';
import { defineCommand } from 'citty';
import { cliOutput } from '../renderers/index.js';

function formatSuccessSection(
  header: string,
  icon: string | undefined,
  items: string[],
): RenderableEnvelope<unknown> {
  const prefix = icon ? `${icon} ` : '';
  return { kind: 'section', data: { header: `${prefix}${header}`, items } };
}

function formatErrorSection(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): RenderableEnvelope<unknown> {
  const items = [message];
  if (details) {
    for (const [key, value] of Object.entries(details)) {
      if (value !== undefined && value !== null) {
        items.push(`${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
      }
    }
  }
  return { kind: 'section', data: { header: `Error: ${code}`, items } };
}

const moveSubCommand = defineCommand({
  meta: { name: 'move', description: 'Move a CLEO project to a new directory.' },
  args: {
    newPath: {
      type: 'positional',
      description: 'New absolute path for the project root.',
      required: true,
    },
    'dry-run': {
      type: 'boolean',
      description: 'Compute the plan without executing.',
      default: false,
    },
    json: { type: 'boolean', description: 'Output raw JSON envelope.', default: false },
  },
  async run({ args }) {
    const newPathRaw = args['newPath'];
    const dryRun = args['dry-run'] ?? false;
    const newPath = resolve(newPathRaw);
    if (!dryRun && existsSync(newPath) && statSync(newPath).isFile()) {
      cliOutput(formatErrorSection('E_INVALID_PATH', `newPath is not a directory: ${newPath}`), {
        command: 'project',
        operation: 'project.move',
      });
      process.exit(1);
    }
    const result = await moveProject(newPath, process.cwd());
    if (result.success) {
      const r = result.data;
      cliOutput(
        formatSuccessSection('Project Moved', '✅', [
          `Project ID:  ${r.projectId}`,
          `Old path:    ${r.oldPath}`,
          `New path:    ${r.newPath}`,
          `New hash:    ${r.newProjectHash}`,
          `Registry:    ${r.reconcileStatus}`,
        ]),
        { command: 'project', operation: 'project.move' },
      );
    } else {
      cliOutput(
        formatErrorSection(result.error.code, result.error.message, { fix: result.error.fix }),
        { command: 'project', operation: 'project.move' },
      );
      process.exit(1);
    }
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
      cliOutput(formatErrorSection('E_VALIDATION', `Invalid project name: "${newName}".`), {
        command: 'project',
        operation: 'project.rename',
      });
      process.exit(2);
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
      cliOutput(
        formatErrorSection(result.error.code, result.error.message, { fix: result.error.fix }),
        { command: 'project', operation: 'project.rename' },
      );
      process.exit(1);
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
      cliOutput(
        formatErrorSection(result.error.code, result.error.message, { fix: result.error.fix }),
        { command: 'project', operation: 'project.re-register' },
      );
      process.exit(1);
    }
  },
});

export const projectCommand = defineCommand({
  meta: {
    name: 'project',
    description: 'Project lifecycle management (move, rename, re-register).',
  },
  subCommands: {
    move: moveSubCommand,
    rename: renameSubCommand,
    're-register': reregisterSubCommand,
  },
});
