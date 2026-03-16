/**
 * Dynamic Skill Content Generator
 *
 * Generates provider-aware skill content for ct-cleo based on the
 * active adapter's capabilities. Produces dynamic instructions that
 * reference the correct channels and operations for the current provider.
 *
 * @task T5240
 */

import { getPreferredChannel } from './routing-table.js';

/**
 * Provider capability context for dynamic skill generation.
 */
export interface ProviderContext {
  providerId: string;
  providerName: string;
  supportsMcp: boolean;
  supportsHooks: boolean;
  supportsSpawn: boolean;
  instructionFilePattern?: string;
}

/**
 * Generate dynamic memory protocol instructions based on provider capabilities.
 *
 * @param context - Provider capability context
 * @returns Markdown content for memory protocol guidance
 */
export function generateMemoryProtocol(context: ProviderContext): string {
  const lines: string[] = [];

  lines.push('## Memory Protocol');
  lines.push('');

  if (context.supportsMcp) {
    lines.push('Use the 3-layer retrieval pattern for token-efficient access:');
    lines.push('');
    lines.push('| Step | Operation | Gateway | ~Tokens |');
    lines.push('|------|-----------|---------|---------|');
    lines.push('| 1 | `memory find` | query | 50/hit |');
    lines.push('| 2 | `memory timeline` | query | 200-500 |');
    lines.push('| 3 | `memory fetch` | query | 500/entry |');
    lines.push('| Save | `memory observe` | mutate | ~50 |');
  } else {
    lines.push('Use the CLEO CLI for memory operations:');
    lines.push('');
    lines.push('```bash');
    lines.push('cleo memory find "search query" --limit 10');
    lines.push('cleo memory observe "observation text" --title "Title"');
    lines.push('```');
  }

  return lines.join('\n');
}

/**
 * Generate a dynamic routing guide based on operation preferences.
 *
 * @param context - Provider capability context
 * @returns Markdown content showing preferred channels per operation
 */
export function generateRoutingGuide(context: ProviderContext): string {
  const lines: string[] = [];

  lines.push('## Preferred Channels');
  lines.push('');

  if (!context.supportsMcp) {
    lines.push('This provider does not support MCP. Use CLI commands for all operations.');
    return lines.join('\n');
  }

  const operations = [
    { domain: 'tasks', operation: 'find', label: 'Task discovery' },
    { domain: 'tasks', operation: 'show', label: 'Task details' },
    { domain: 'tasks', operation: 'current', label: 'Current task' },
    { domain: 'session', operation: 'status', label: 'Session check' },
    { domain: 'memory', operation: 'find', label: 'Brain search' },
    { domain: 'memory', operation: 'observe', label: 'Save observation' },
  ];

  lines.push('| Operation | Channel | Reason |');
  lines.push('|-----------|---------|--------|');

  for (const op of operations) {
    const channel = getPreferredChannel(op.domain, op.operation);
    lines.push(`| ${op.label} | ${channel.toUpperCase()} | ${op.domain}.${op.operation} |`);
  }

  return lines.join('\n');
}

/**
 * Generate complete dynamic skill content for the current provider.
 *
 * @param context - Provider capability context
 * @returns Complete dynamic skill markdown content
 */
export function generateDynamicSkillContent(context: ProviderContext): string {
  const sections: string[] = [];

  sections.push(`# CLEO Protocol — ${context.providerName}`);
  sections.push('');
  sections.push(`Provider: **${context.providerName}** (${context.providerId})`);
  sections.push('');

  // Capabilities summary
  sections.push('## Capabilities');
  sections.push('');
  sections.push(`- MCP: ${context.supportsMcp ? 'Yes' : 'No'}`);
  sections.push(`- Hooks: ${context.supportsHooks ? 'Yes' : 'No'}`);
  sections.push(`- Spawn: ${context.supportsSpawn ? 'Yes' : 'No'}`);
  if (context.instructionFilePattern) {
    sections.push(`- Instruction file: \`${context.instructionFilePattern}\``);
  }
  sections.push('');

  // Memory protocol
  sections.push(generateMemoryProtocol(context));
  sections.push('');

  // Routing guide
  sections.push(generateRoutingGuide(context));

  return sections.join('\n');
}
