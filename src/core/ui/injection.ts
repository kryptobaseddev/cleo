/**
 * Instruction injection engine - manages CLEO instruction blocks in target files.
 *
 * Handles injection of CLEO configuration blocks into CLAUDE.md, AGENTS.md,
 * GEMINI.md, and other agent instruction files. Uses marker-based idempotent
 * injection to update without duplicating content.
 *
 * NOTE: For CAAMP-managed injection, use @cleocode/caamp imports.
 * This module provides CLEO-specific wrapper logic only.
 *
 * @task T4454
 * @epic T4454
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { getCleoDir } from '../paths.js';

/** Injection block markers. */
const MARKER_START = '<!-- CLEO:START -->';
const MARKER_END = '<!-- CLEO:END -->';

/** Valid injection target filenames. */
export const INJECTION_TARGETS = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'] as const;
export type InjectionTarget = (typeof INJECTION_TARGETS)[number];

/** Check if a filename is a valid injection target. */
export function isValidTarget(target: string): target is InjectionTarget {
  const name = target.split('/').pop() ?? target;
  return (INJECTION_TARGETS as readonly string[]).includes(name);
}

/** Check if a file has a CLEO injection block. */
export function hasInjectionBlock(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  const content = readFileSync(filePath, 'utf-8');
  return content.includes(MARKER_START) && content.includes(MARKER_END);
}

/** Get the template path for injection content. */
export function getTemplatePath(cwd?: string): string {
  return join(getCleoDir(cwd), 'templates', 'AGENT-INJECTION.md');
}

/** Get the content between CLEO markers in a file. */
export function getInjectionContent(filePath: string): string | null {
  if (!hasInjectionBlock(filePath)) return null;

  const content = readFileSync(filePath, 'utf-8');
  const startIdx = content.indexOf(MARKER_START) + MARKER_START.length;
  const endIdx = content.indexOf(MARKER_END);
  return content.slice(startIdx, endIdx).trim();
}

/**
 * Build the injection content from template.
 * Returns the full block including markers.
 */
function buildInjectionBlock(templatePath: string): string {
  if (!existsSync(templatePath)) {
    return `${MARKER_START}\n@${templatePath}\n${MARKER_END}`;
  }

  // Use @-reference format
  return `${MARKER_START}\n@${templatePath}\n${MARKER_END}`;
}

/** Injection action result. */
export interface InjectionResult {
  action: 'created' | 'updated' | 'added' | 'no_change';
  target: string;
  dryRun: boolean;
}

/**
 * Update or add injection to a target file.
 * Idempotent: will update existing block or add new one.
 */
export function injectionUpdate(
  target: string,
  options: { dryRun?: boolean; templatePath?: string } = {},
): InjectionResult {
  const templatePath = options.templatePath ?? '.cleo/templates/AGENT-INJECTION.md';
  const injectionBlock = buildInjectionBlock(templatePath);

  let action: InjectionResult['action'];

  if (!existsSync(target)) {
    action = 'created';
  } else if (hasInjectionBlock(target)) {
    // Check if content is already up to date
    const current = getInjectionContent(target);
    const expected = `@${templatePath}`;
    if (current === expected) {
      return { action: 'no_change', target, dryRun: options.dryRun ?? false };
    }
    action = 'updated';
  } else {
    action = 'added';
  }

  if (options.dryRun) {
    return { action, target, dryRun: true };
  }

  if (action === 'created') {
    writeFileSync(target, injectionBlock + '\n', 'utf-8');
  } else if (action === 'updated') {
    const content = readFileSync(target, 'utf-8');
    const startIdx = content.indexOf(MARKER_START);
    const endIdx = content.indexOf(MARKER_END) + MARKER_END.length;
    const updated = content.slice(0, startIdx) + injectionBlock + content.slice(endIdx);
    writeFileSync(target, updated, 'utf-8');
  } else {
    // 'added' - prepend to file
    const existing = readFileSync(target, 'utf-8');
    writeFileSync(target, injectionBlock + '\n' + existing, 'utf-8');
  }

  return { action, target, dryRun: false };
}

/** Check injection status for a target file. */
export function injectionCheck(target: string): {
  target: string;
  status: 'configured' | 'none' | 'missing' | 'outdated';
  fileExists: boolean;
  hasBlock: boolean;
} {
  if (!existsSync(target)) {
    return { target, status: 'missing', fileExists: false, hasBlock: false };
  }

  const hasBlock = hasInjectionBlock(target);
  if (!hasBlock) {
    return { target, status: 'none', fileExists: true, hasBlock: false };
  }

  // Check if content is the expected @-reference
  const content = getInjectionContent(target);
  if (content?.startsWith('@.cleo/templates/')) {
    return { target, status: 'configured', fileExists: true, hasBlock: true };
  }

  return { target, status: 'outdated', fileExists: true, hasBlock: true };
}

/** Update all injection targets in the project root. */
export function updateAllTargets(
  options: { dryRun?: boolean; cwd?: string } = {},
): InjectionResult[] {
  const projectRoot = dirname(getCleoDir(options.cwd));
  return INJECTION_TARGETS.map(target => {
    const targetPath = join(projectRoot, target);
    return injectionUpdate(targetPath, { dryRun: options.dryRun });
  });
}
