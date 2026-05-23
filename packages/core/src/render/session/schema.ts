/**
 * Human renderer for `cleo schema <operation>`.
 *
 * Renders the OperationSchema as a formatted summary table including params,
 * gates, and examples — matching the inline `renderSchemaHuman` logic previously
 * in commands/schema.ts.
 *
 * Migrated from `packages/cleo/src/cli/renderers/system.ts` (T10131 — B6).
 *
 * @task T1729
 * @task T10131
 * @epic T1691
 */

export function renderSchemaCommand(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) return '';

  const lines: string[] = [];

  lines.push(`Operation : ${String(data['operation'] ?? '')}`);
  lines.push(`Gateway   : ${String(data['gateway'] ?? '')}`);
  lines.push(`Description: ${String(data['description'] ?? '')}`);
  lines.push('');

  const params = (data['params'] as Array<Record<string, unknown>>) ?? [];
  lines.push('Parameters:');
  if (params.length === 0) {
    lines.push('  (none declared)');
  } else {
    for (const p of params) {
      const req = p['required'] ? '[required]' : '[optional]';
      const enumVal = p['enum'] as string[] | undefined;
      const enumStr = enumVal ? `  enum: ${enumVal.join(' | ')}` : '';
      const cli = p['cli'] as Record<string, unknown> | undefined;
      let cliStr = '';
      if (cli) {
        const parts: string[] = [];
        if (cli['positional']) parts.push('positional');
        if (cli['short']) parts.push(`short: ${String(cli['short'])}`);
        if (cli['flag']) parts.push(`flag: --${String(cli['flag'])}`);
        if (parts.length > 0) cliStr = `  cli: ${parts.join(', ')}`;
      }
      lines.push(`  ${String(p['name'] ?? '')} (${String(p['type'] ?? '')}) ${req}`);
      lines.push(`    ${String(p['description'] ?? '')}${enumStr}${cliStr}`);
    }
  }

  const gates = data['gates'] as Array<Record<string, unknown>> | undefined;
  if (gates !== undefined) {
    lines.push('');
    lines.push('Gates:');
    if (gates.length === 0) {
      lines.push('  (none declared — see note on static gate table)');
    } else {
      for (const g of gates) {
        lines.push(`  ${String(g['name'] ?? '')} → ${String(g['errorCode'] ?? '')}`);
        lines.push(`    ${String(g['description'] ?? '')}`);
        const triggers = (g['triggers'] as string[]) ?? [];
        for (const t of triggers) {
          lines.push(`    - ${t}`);
        }
      }
    }
  }

  const examples = data['examples'] as Array<Record<string, unknown>> | undefined;
  if (examples !== undefined && examples.length > 0) {
    lines.push('');
    lines.push('Examples:');
    for (const ex of examples) {
      lines.push(`  ${String(ex['command'] ?? '')}`);
      lines.push(`    ${String(ex['description'] ?? '')}`);
    }
  }

  return lines.join('\n');
}
