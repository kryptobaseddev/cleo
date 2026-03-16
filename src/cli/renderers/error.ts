/**
 * Structured markdown error renderer for CLI output.
 *
 * Renders CleoError instances as human-readable markdown for terminal display.
 *
 * @task T5240
 */

import { CleoError } from '../../core/errors.js';
import { getErrorDefinition } from '../../core/error-catalog.js';
import { getExitCodeName } from '../../types/exit-codes.js';

/**
 * Render a CleoError as structured markdown for CLI display.
 */
export function renderErrorMarkdown(error: CleoError): string {
  const def = getErrorDefinition(error.code);
  const name = getExitCodeName(error.code);
  const lines: string[] = [];

  lines.push(`**Error ${error.code}**: ${name}`);
  lines.push('');
  lines.push(error.message);

  if (def?.category) {
    lines.push('');
    lines.push(`Category: ${def.category}`);
  }

  const fix = error.fix ?? def?.fix;
  if (fix) {
    lines.push('');
    lines.push(`**Fix**: ${fix}`);
  }

  if (error.alternatives && error.alternatives.length > 0) {
    lines.push('');
    lines.push('**Alternatives**:');
    for (const alt of error.alternatives) {
      lines.push(`  - ${alt.action}: \`${alt.command}\``);
    }
  }

  if (def?.recoverable) {
    lines.push('');
    lines.push('This error is recoverable -- retrying may succeed.');
  }

  return lines.join('\n');
}
