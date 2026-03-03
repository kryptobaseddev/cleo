import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCleoHome } from './paths.js';
import { ensureGlobalSchemas } from './schema-management.js';
import { getInjectionTemplateContent } from './injection.js';

/**
 * Ensure global CLEO home baseline exists for MCP-first runtime use.
 * Best-effort and non-throwing by default for server startup resilience.
 */
export function ensureGlobalBootstrap(): { initialized: boolean; details: string[] } {
  const details: string[] = [];
  const cleoHome = getCleoHome();

  if (!existsSync(cleoHome)) {
    mkdirSync(cleoHome, { recursive: true });
    details.push('created CLEO_HOME');
  }

  const schemaResult = ensureGlobalSchemas();
  if (schemaResult.installed > 0 || schemaResult.updated > 0) {
    details.push(`schemas installed=${schemaResult.installed} updated=${schemaResult.updated}`);
  }

  const templatesDir = join(cleoHome, 'templates');
  if (!existsSync(templatesDir)) {
    mkdirSync(templatesDir, { recursive: true });
    details.push('created templates dir');
  }

  const injectionTemplate = getInjectionTemplateContent();
  if (injectionTemplate) {
    const injectionPath = join(templatesDir, 'CLEO-INJECTION.md');
    if (!existsSync(injectionPath)) {
      writeFileSync(injectionPath, injectionTemplate, 'utf-8');
      details.push('installed CLEO-INJECTION.md');
    }
  }

  return { initialized: true, details };
}
