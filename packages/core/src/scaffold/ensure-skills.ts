/**
 * Project-context scaffolding: detects project type and writes
 * project-context.json.
 */

import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ScaffoldResult } from '@cleocode/contracts/scaffold-diagnostics';
import { pushWarning } from '../output.js';
import { resolveScaffoldCleoDir } from './ensure-config.js';

/**
 * Detect and write project-context.json.
 * Idempotent: skips if file exists and is less than staleDays old (default: 30).
 *
 * @param projectRoot - Absolute path to the project root directory
 * @param opts - Optional configuration
 * @param opts.force - When true, regenerate even if the file is fresh
 * @param opts.staleDays - Age threshold in days before regeneration (default: 30)
 * @returns Scaffold result indicating the action taken
 */
export async function ensureProjectContext(
  projectRoot: string,
  opts?: { force?: boolean; staleDays?: number },
): Promise<ScaffoldResult> {
  const cleoDir = resolveScaffoldCleoDir(projectRoot);
  const contextPath = join(cleoDir, 'project-context.json');
  const staleDays = opts?.staleDays ?? 30;

  if (existsSync(contextPath) && !opts?.force) {
    try {
      const content = JSON.parse(readFileSync(contextPath, 'utf-8'));
      if (content.detectedAt) {
        const detectedAt = new Date(content.detectedAt);
        const ageMs = Date.now() - detectedAt.getTime();
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        if (ageDays < staleDays) {
          return {
            action: 'skipped',
            path: contextPath,
            details: `Fresh (${Math.floor(ageDays)}d old)`,
          };
        }
      }
    } catch {
      // If we can't parse it, regenerate
    }
  }

  const { detectProjectType } = await import('../store/project-detect.js');
  const context = detectProjectType(projectRoot);

  try {
    const schemaPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '../../schemas/project-context.schema.json',
    );
    if (existsSync(schemaPath)) {
      const AjvModule = await import('ajv');
      const ajvMod = AjvModule as Record<string, unknown>;
      const AjvClass = (
        typeof ajvMod.default === 'function' ? ajvMod.default : AjvModule.default
      ) as new (
        opts?: Record<string, unknown>,
      ) => {
        validate(schema: unknown, data: unknown): boolean;
        errors?: unknown[] | null;
        addFormat?: (name: string, format: unknown) => unknown;
      };
      const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
      const ajv = new AjvClass({ strict: false });
      const addFormatsModule = await import('ajv-formats');
      const fmtMod = addFormatsModule as Record<string, unknown>;
      const addFormats = (
        typeof fmtMod.default === 'function' ? fmtMod.default : addFormatsModule.default
      ) as (instance: unknown) => unknown;
      addFormats(ajv);
      const valid = ajv.validate(schema, context);
      if (!valid) {
        pushWarning({
          code: 'W_SCAFFOLD_PARTIAL',
          message: `project-context.json schema validation warnings: ${JSON.stringify(ajv.errors)}`,
        });
      }
    }
  } catch {
    // Schema validation is best-effort — never block the write
  }

  await writeFile(contextPath, JSON.stringify(context, null, 2));

  return {
    action: existsSync(contextPath) ? 'repaired' : 'created',
    path: contextPath,
  };
}
