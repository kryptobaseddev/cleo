/**
 * Derived markdown view of a session handoff.
 *
 * IMPORTANT: this module produces a one-way *view* of the canonical
 * handoff data that already lives in `session.handoffJson` (SQLite).
 * The markdown is NEVER read back by CLEO — it exists only as a UI
 * artifact for humans / external systems. Source of truth remains
 * TASKS + BRAIN, exposed via `cleo briefing`.
 *
 * Operator directive (2026-04-29, T1593): markdown handoffs are an
 * anti-pattern when used as canonical state. They lie when agents
 * "update" them by deletion. This emitter is opt-in via
 * `cleo session end --emit-markdown <path>` and produces a clearly
 * labelled derived snapshot.
 *
 * @task T1593
 */

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import type { HandoffData } from './handoff.js';

/**
 * Optional context attached to the rendered markdown view.
 */
export interface HandoffMarkdownContext {
  /** Session id whose handoff is being rendered. */
  sessionId?: string;
  /** ISO timestamp when the session ended. */
  endedAt?: string;
  /** Session scope label (e.g. `global`, `epic:T1593`). */
  scope?: string;
  /** Project root absolute path (for traceability). */
  projectRoot?: string;
}

/**
 * Render a HandoffData record as a human-readable markdown view.
 *
 * The output is a derived snapshot. It MUST NOT be re-ingested by
 * CLEO; instead, run `cleo briefing` which reads the canonical state
 * from tasks.db + brain.db.
 *
 * @param handoff - Canonical handoff payload from `session.handoffJson`.
 * @param ctx     - Optional rendering context (session id, scope, etc.).
 * @returns Markdown string ready to write to disk.
 */
export function renderHandoffMarkdown(
  handoff: HandoffData,
  ctx: HandoffMarkdownContext = {},
): string {
  const lines: string[] = [];
  const stamp = new Date().toISOString();

  lines.push('# Session Handoff (derived view)');
  lines.push('');
  lines.push(
    '> **NOT a source of truth.** This file is a one-way view derived from `session.handoffJson` ' +
      'in tasks.db. To resume context, run `cleo briefing` — it reads the live state from TASKS + BRAIN.',
  );
  lines.push('');
  lines.push('## Metadata');
  lines.push('');
  if (ctx.sessionId) lines.push(`- Session: \`${ctx.sessionId}\``);
  if (ctx.endedAt) lines.push(`- Ended: ${ctx.endedAt}`);
  if (ctx.scope) lines.push(`- Scope: \`${ctx.scope}\``);
  if (ctx.projectRoot) lines.push(`- Project: \`${ctx.projectRoot}\``);
  lines.push(`- Rendered: ${stamp}`);
  lines.push('');

  lines.push('## Last Task');
  lines.push('');
  lines.push(handoff.lastTask ? `- \`${handoff.lastTask}\`` : '- (none)');
  lines.push('');

  lines.push(`## Tasks Completed (${handoff.tasksCompleted.length})`);
  lines.push('');
  if (handoff.tasksCompleted.length === 0) {
    lines.push('- (none)');
  } else {
    for (const id of handoff.tasksCompleted) lines.push(`- \`${id}\``);
  }
  lines.push('');

  lines.push(`## Tasks Created (${handoff.tasksCreated.length})`);
  lines.push('');
  if (handoff.tasksCreated.length === 0) {
    lines.push('- (none)');
  } else {
    for (const id of handoff.tasksCreated) lines.push(`- \`${id}\``);
  }
  lines.push('');

  lines.push('## Decisions Recorded');
  lines.push('');
  lines.push(`- ${handoff.decisionsRecorded}`);
  lines.push('');

  lines.push(`## Next Suggested (${handoff.nextSuggested.length})`);
  lines.push('');
  if (handoff.nextSuggested.length === 0) {
    lines.push('- (none — run `cleo next` for fresh suggestions)');
  } else {
    for (const id of handoff.nextSuggested) lines.push(`- \`${id}\``);
  }
  lines.push('');

  lines.push(`## Open Blockers (${handoff.openBlockers.length})`);
  lines.push('');
  if (handoff.openBlockers.length === 0) {
    lines.push('- (none)');
  } else {
    for (const id of handoff.openBlockers) lines.push(`- \`${id}\``);
  }
  lines.push('');

  lines.push(`## Open Bugs (${handoff.openBugs.length})`);
  lines.push('');
  if (handoff.openBugs.length === 0) {
    lines.push('- (none)');
  } else {
    for (const id of handoff.openBugs) lines.push(`- \`${id}\``);
  }
  lines.push('');

  if (handoff.note) {
    lines.push('## Note');
    lines.push('');
    lines.push(handoff.note);
    lines.push('');
  }

  if (handoff.nextAction) {
    lines.push('## Next Action');
    lines.push('');
    lines.push(handoff.nextAction);
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(
    '_To resume in a new session, run `cleo briefing`. Do **not** copy this file forward; the live data lives in `tasks.db` + `brain.db`._',
  );

  return lines.join('\n');
}

/**
 * Write a markdown handoff view to disk. Creates parent directories as
 * needed. Atomic via write-then-rename pattern.
 *
 * @param outputPath - Absolute path of the destination markdown file.
 * @param handoff    - Canonical handoff payload to render.
 * @param ctx        - Optional rendering context (session id, scope, etc.).
 */
export async function emitHandoffMarkdown(
  outputPath: string,
  handoff: HandoffData,
  ctx: HandoffMarkdownContext = {},
): Promise<void> {
  const md = renderHandoffMarkdown(handoff, ctx);
  await fs.mkdir(dirname(outputPath), { recursive: true });
  const tmp = `${outputPath}.tmp-${Date.now()}`;
  await fs.writeFile(tmp, md, 'utf8');
  await fs.rename(tmp, outputPath);
}
