/**
 * Session Context Injection
 *
 * Reads protocol injection content for a given protocol type. Extracted from
 * engine-compat.ts during the memory domain cutover (T5241) to separate
 * session concerns from brain.db cognitive memory.
 *
 * @task T5241
 * @epic T5149
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getProjectRoot } from '../paths.js';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';

/**
 * Resolve the project root, defaulting to getProjectRoot() if not specified.
 */
function resolveRoot(projectRoot?: string): string {
  return projectRoot || getProjectRoot();
}

/**
 * Data returned by context injection.
 */
export interface ContextInjectionData {
  protocolType: string;
  content: string;
  path: string | null;
  contentLength: number;
  estimatedTokens: number;
  taskId: string | null;
  variant: string | null;
}

/**
 * Read protocol injection content for a given protocol type.
 * Core logic for session.context.inject.
 */
export function injectContext(
  protocolType: string,
  params?: { taskId?: string; variant?: string },
  projectRoot?: string,
): ContextInjectionData {
  if (!protocolType) {
    throw new CleoError(ExitCode.INVALID_INPUT, 'protocolType is required');
  }

  const root = resolveRoot(projectRoot);

  const protocolLocations = [
    resolve(root, 'protocols', `${protocolType}.md`),
    resolve(root, 'skills', '_shared', `${protocolType}.md`),
    resolve(root, 'agents', 'cleo-subagent', 'protocols', `${protocolType}.md`),
  ];

  let protocolContent: string | null = null;
  let protocolPath: string | null = null;

  for (const loc of protocolLocations) {
    if (existsSync(loc)) {
      try {
        protocolContent = readFileSync(loc, 'utf-8');
        protocolPath = loc.replace(root + '/', '');
        break;
      } catch {
        continue;
      }
    }
  }

  if (!protocolContent) {
    throw new CleoError(
      ExitCode.NOT_FOUND,
      `Protocol '${protocolType}' not found in src/protocols/, skills/_shared/, or agents/cleo-subagent/protocols/`
    );
  }

  return {
    protocolType,
    content: protocolContent,
    path: protocolPath,
    contentLength: protocolContent.length,
    estimatedTokens: Math.ceil(protocolContent.length / 4),
    taskId: params?.taskId || null,
    variant: params?.variant || null,
  };
}
