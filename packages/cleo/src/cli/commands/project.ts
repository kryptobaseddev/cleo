/**
 * CLI command group: cleo project — project lifecycle management.
 *
 * Subcommands: move, rename, re-register.
 * All three verbs return RenderableEnvelope (kind: section) per T10346.
 * Error responses also wrapped in RenderableEnvelope.
 *
 * @task T11027
 * @epic T10298
 * @saga T10295
 */

import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RenderableEnvelope } from '@cleocode/contracts';
import { moveProject, renameProject, projectLifecycle } from '@cleocode/core';
import { defineCommand } from 'citty';
import { cliOutput } from '../renderers/index.js';

function section(header, icon, items) {
  const p = icon ? `${icon} ` : '';
  return { kind: 'section', data: { header: `${p}${header}`, items } };
}
function errSection(code, message, details) {
  const items = [message];
  if (details) for (const [k, v] of Object.entries(details)) if (v != null) items.push(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  return { kind: 'section', data: { header: `Error: ${code}`, items } };
}

const move = defineCommand({
  meta: { name: 'move', description: 'Move a CLEO project to a new directory.' },
  args: { newPath: { type: 'positional', required: true }, 'dry-run': { type: 'boolean', default: false }, json: { type: 'boolean', default: false } },
  async run({ args }) {
    const r = await moveProject(resolve(args['newPath']), process.cwd());
    if (r.success) { const d = r.data; cliOutput(section('Project Moved', '✅', [`Project ID:  ${d.projectId}`, `Old path:    ${d.oldPath}`, `New path:    ${d.newPath}`, `New hash:    ${d.newProjectHash}`, `Registry:    ${d.reconcileStatus}`]), { command: 'project', operation: 'project.move' }); }
    else { cliOutput(errSection(r.error.code, r.error.message, { fix: r.error.fix }), { command: 'project', operation: 'project.move' }); process.exit(1); }
  },
});

const rename = defineCommand({
  meta: { name: 'rename', description: 'Rename this project.' },
  args: { newName: { type: 'positional', required: true }, 'dry-run': { type: 'boolean', default: false }, json: { type: 'boolean', default: false } },
  async run({ args }) {
    const n = args['newName']; const re = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;
    if (!n || !re.test(n)) { cliOutput(errSection('E_VALIDATION', `Invalid name: "${n}"`), { command: 'project', operation: 'project.rename' }); process.exit(2); }
    if (args['dry-run']) { cliOutput(section('Dry Run', undefined, [`Would rename to "${n}".`]), { command: 'project', operation: 'project.rename' }); return; }
    const r = await renameProject(n, process.cwd());
    if (r.success) { const d = r.data; cliOutput(section('Project Renamed', '✅', [`Project ID:   ${d.projectId}`, `Old name:     ${d.oldName}`, `New name:     ${d.newName}`, `Project hash: ${d.newProjectHash}`]), { command: 'project', operation: 'project.rename' }); }
    else { cliOutput(errSection(r.error.code, r.error.message, { fix: r.error.fix }), { command: 'project', operation: 'project.rename' }); process.exit(1); }
  },
});

const reregister = defineCommand({
  meta: { name: 're-register', description: 'Re-register project with NEXUS.' },
  args: { fix: { type: 'boolean', default: false }, json: { type: 'boolean', default: false } },
  async run() {
    const r = await projectLifecycle.reregisterProject(process.cwd());
    if (r.success) { const d = r.data; const icon = d.drifted ? '⚠️' : '✅'; const items = [`Project ID:  ${d.projectId}`, `Project root: ${d.projectRoot}`, `Hash:        ${d.projectHash}`, `Status:      ${d.reconcileStatus}`]; if (d.drifted && d.oldPath) items.push(`Old path:    ${d.oldPath}`); cliOutput(section(d.drifted ? 'Project Re-registered (Drift Detected)' : 'Project Re-registered', icon, items), { command: 'project', operation: 'project.re-register' }); }
    else { cliOutput(errSection(r.error.code, r.error.message, { fix: r.error.fix }), { command: 'project', operation: 'project.re-register' }); process.exit(1); }
  },
});

export const projectCommand = defineCommand({
  meta: { name: 'project', description: 'Project lifecycle management (move, rename, re-register).' },
  subCommands: { move, rename, 're-register': reregister },
});
