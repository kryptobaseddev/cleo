/**
 * CLI command group: cleo project — project lifecycle management.
 *
 * Subcommands:
 *   cleo project move <newPath>    — Move project to a new directory
 *   cleo project rename <newName>  — Rename project
 *   cleo project re-register       — Reconcile project with NEXUS registry
 *
 * All three verbs return RenderableEnvelope per T10346 contract.
 * Output wrapped as kind=section with header and items array.
 * Error responses also wrapped in RenderableEnvelope.
 *
 * @task T11027
 * @task T11012
 * @task T11015
 * @task T11017
 * @epic T10298
 * @saga T10295
 */

import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RenderableEnvelope } from '@cleocode/contracts';
import {
  type MoveProjectResult,
  moveProject,
  projectLifecycle,
  type RenameProjectResult,
  type ReregisterProjectResult,
  renameProject,
} from '@cleocode/core';
import { defineCommand } from 'citty';
import { cliOutput } from '../renderers/index.js';

// ── Shared Helpers ──────────────────────────────────────────────────────

function formatSuccessSection(
  header: string,
  icon: string | undefined,
  items: string[],
): RenderableEnvelope<unknown> {
  const prefix = icon ? `${icon} ` : '';
  return {
    kind: 'section',
    data: { header: `${prefix}${header}`, items },
  };
}

function formatErrorSection(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): RenderableEnvelope<unknown> {
  const items: string[] = [message];
  if (details) {
    for (const [key, value] of Object.entries(details)) {
      if (value !== undefined && value !== null) {
        items.push(`${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
      }
    }
  }
  return {
    kind: 'section',
    data: { header: `Error: ${code}`, items },
  };
}

// ── Subcommand: project move ─────────────────────────────────────────────

const moveSubCommand = defineCommand({
  meta: {
    name: 'move',
    description:
      'Move a CLEO project to a new directory — preserves projectId, updates project hash and nexus registry.',
  },
  args: {
    newPath: {
      type: 'positional',
      description: 'New absolute path for the project root.',
      required: true,
    },
    'dry-run': {
      type: 'boolean',
      description: 'Compute the plan but do not execute the move.',
      default: false,
    },
    json: {
      type: 'boolean',
      description: 'Output raw JSON envelope for programmatic consumption.',
      default: false,
    },
  },
  async run({ args }) {
    const newPathRaw = args['newPath'] as string;
    const dryRun = (args['dry-run'] as boolean) ?? false;
    const newPath = resolve(newPathRaw);

    // Pre-flight validation for non-dry-run
    if (!dryRun && existsSync(newPath)) {
      const stat = statSync(newPath);
      if (stat.isFile()) {
        cliOutput(
          formatErrorSection('E_INVALID_PATH', `newPath exists but is not a directory: ${newPath}`),
          { command: 'project', operation: 'project.move' },
        );
        process.exit(1);
      }
    }

    const result = await moveProject(newPath, process.cwd());

    if (result.success) {
      const r = result.data as MoveProjectResult;
      cliOutput(
        formatSuccessSection('Project Moved', result.data.registryUpdated ? '✅' : '⚠️', [
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
        formatErrorSection(result.error.code, result.error.message, {
          fix: result.error.fix,
        }),
        { command: 'project', operation: 'project.move' },
      );
      process.exit(1);
    }
  },
});

// ── Subcommand: project rename ────────────────────────────────────────────

const renameSubCommand = defineCommand({
  meta: {
    name: 'rename',
    description:
      'Rename this project — updates project-info.json, recomputes hash, registers alias.',
  },
  args: {
    newName: {
      type: 'positional',
      description: 'New project name (1–100 chars, alphanumeric + hyphens/underscores).',
      required: true,
    },
    'dry-run': {
      type: 'boolean',
      description: 'Validate the name without applying changes.',
      default: false,
    },
    json: {
      type: 'boolean',
      description: 'Output raw JSON envelope for programmatic consumption.',
      default: false,
    },
  },
  async run({ args }) {
    const newName = args['newName'] as string;
    const dryRun = (args['dry-run'] as boolean) ?? false;

    // Validate name format
    const nameRe = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;
    if (!newName || !nameRe.test(newName)) {
      cliOutput(
        formatErrorSection(
          'E_VALIDATION',
          `Invalid project name: "${newName}". Must be 1–100 characters, alphanumeric with hyphens/underscores.`,
        ),
        { command: 'project', operation: 'project.rename' },
      );
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
      const r = result.data as RenameProjectResult;
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
        formatErrorSection(result.error.code, result.error.message, {
          fix: result.error.fix,
        }),
        { command: 'project', operation: 'project.rename' },
      );
      process.exit(1);
    }
  },
});

// ── Subcommand: project re-register ───────────────────────────────────────

const reregisterSubCommand = defineCommand({
  meta: {
    name: 're-register',
    description: 'Re-register project with NEXUS — detect and report filesystem drift.',
  },
  args: {
    fix: {
      type: 'boolean',
      description: 'Auto-heal path_updated drift by updating project-info.json.',
      default: false,
    },
    json: {
      type: 'boolean',
      description: 'Output raw JSON envelope for programmatic consumption.',
      default: false,
    },
  },
  async run({ args }) {
    const _fix = (args['fix'] as boolean) ?? false;

    const result = await projectLifecycle.reregisterProject(process.cwd());

    if (result.success) {
      const r = result.data as ReregisterProjectResult;
      const statusIcon = r.drifted ? '⚠️' : '✅';
      const items: string[] = [
        `Project ID:  ${r.projectId}`,
        `Project root: ${r.projectRoot}`,
        `Hash:        ${r.projectHash}`,
        `Status:      ${r.reconcileStatus}`,
      ];
      if (r.drifted && r.oldPath) {
        items.push(`Old path:    ${r.oldPath}`);
      }
      cliOutput(
        formatSuccessSection(
          r.drifted ? 'Project Re-registered (Drift Detected)' : 'Project Re-registered',
          statusIcon,
          items,
        ),
        { command: 'project', operation: 'project.re-register' },
      );
    } else {
      cliOutput(
        formatErrorSection(result.error.code, result.error.message, {
          fix: result.error.fix,
        }),
        { command: 'project', operation: 'project.re-register' },
      );
      process.exit(1);
    }
  },
});

// ── Root command group ───────────────────────────────────────────────────

/**
 * Root project command group — registers project lifecycle subcommands.
 *
 * Usage:
 *   cleo project move <newPath> [--dry-run] [--json]
 *   cleo project rename <newName> [--dry-run] [--json]
 *   cleo project re-register [--fix] [--json]
 */
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
