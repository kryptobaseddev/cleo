/**
 * Human-readable renderers for the **contracts** family of nexus subcommands.
 *
 * Covers cross-project / contract-level + brain/task footprint surfaces:
 * - contractsSync, contractsShow, contractsLinkTasks
 * - conduitScan, taskSymbols
 * - brainAnchors, taskFootprint
 * - wiki
 *
 * Each renderer follows the legacy `(data, quiet) => string` shape. The
 * shape stays stable until the consumer-side dispatcher migrates to the
 * typed envelope path (B5 `renderEnvelopeForHuman`).
 *
 * Subtask: T10151 (B7.2). Migrated verbatim from the deleted file
 * `packages/cleo/src/cli/renderers/nexus.ts` per ADR-077.
 *
 * @epic T10114
 * @task T10132
 */

import { str } from '../_format.js';

// ---------------------------------------------------------------------------
// nexus task-footprint
// ---------------------------------------------------------------------------

/**
 * Render `cleo nexus task-footprint` human output.
 */
export function renderNexusTaskFootprint(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) return '';
  const files = (data['files'] as string[]) ?? [];
  const symbols = (data['symbols'] as Array<Record<string, unknown>>) ?? [];
  const blastRadius = (data['blastRadius'] as Record<string, unknown>) ?? {};
  const brainObservations = (data['brainObservations'] as Array<Record<string, unknown>>) ?? [];
  const decisions = (data['decisions'] as Array<Record<string, unknown>>) ?? [];
  const durationMs = Number(data['_durationMs'] ?? 0);

  const lines: string[] = [
    `\n## Task Code Impact: ${str(data['taskId'])}`,
    '',
    `**Risk Score**: ${str(data['riskScore'])}`,
    `**Files** (${files.length}): ${files.slice(0, 10).join(', ') || '—'}`,
    '',
    `### Symbols (${symbols.length})`,
  ];
  for (const s of symbols.slice(0, 20)) {
    lines.push(
      `  [${str(s['riskLevel'])}] ${str(s['label'])} (${str(s['kind'])})  d1=${str(s['directCallers'])}  total=${str(s['totalAffected'])}`,
    );
  }
  if (symbols.length === 0)
    lines.push(`  (none — run 'cleo nexus analyze' or link task to symbols first)`);
  lines.push('\n### Blast Radius');
  lines.push(
    `  analyzed=${str(blastRadius['symbolsAnalyzed'])}  total_affected=${str(blastRadius['totalAffected'])}  max_risk=${str(blastRadius['maxRisk'])}`,
  );
  lines.push(`\n### Brain Observations (${brainObservations.length})`);
  for (const o of brainObservations.slice(0, 5))
    lines.push(`  [${str(o['nodeType'])}] ${str(o['label']).slice(0, 80)}`);
  lines.push(`\n### Decisions (${decisions.length})`);
  for (const d of decisions.slice(0, 5))
    lines.push(`  [${str(d['linkType'])}] ${str(d['decision']).slice(0, 80)}`);
  lines.push(`\n(${durationMs}ms)`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// nexus brain-anchors
// ---------------------------------------------------------------------------

/**
 * Render `cleo nexus brain-anchors` human output.
 */
export function renderNexusBrainAnchors(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) return '';
  const nexusNodes = (data['nexusNodes'] as Array<Record<string, unknown>>) ?? [];
  const tasksForNodes = (data['tasksForNodes'] as Array<Record<string, unknown>>) ?? [];
  const durationMs = Number(data['_durationMs'] ?? 0);

  const lines: string[] = [
    `\n## Brain Code Anchors: ${str(data['entryId'])}`,
    '',
    `**Plasticity Signal**: ${Number(data['plasticitySignal'] ?? 0).toFixed(2)}`,
    '',
    `### Nexus Nodes (${nexusNodes.length})`,
  ];
  for (const n of nexusNodes.slice(0, 20)) {
    lines.push(
      `  [${str(n['kind'])}] ${str(n['label'])}  file=${str(n['filePath'], '—')}  edge=${str(n['edgeType'])}  w=${Number(n['weight'] ?? 0).toFixed(2)}`,
    );
  }
  if (nexusNodes.length === 0) lines.push(`  (none)`);
  lines.push(`\n### Tasks for Nodes (${tasksForNodes.length} nodes with task links)`);
  for (const entry of tasksForNodes.slice(0, 10)) {
    const tList = ((entry['tasks'] as Array<{ taskId: string }>) ?? [])
      .map((t) => t.taskId)
      .join(', ');
    lines.push(`  ${str(entry['nexusNodeId'])}: ${tList}`);
  }
  if (tasksForNodes.length === 0) lines.push(`  (none)`);
  lines.push(`\n(${durationMs}ms)`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// nexus conduit-scan
// ---------------------------------------------------------------------------

/**
 * Render `cleo nexus conduit-scan` human output.
 */
export function renderNexusConduitScan(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) return '';
  const durationMs = Number(data['_durationMs'] ?? 0);
  return `[nexus] conduit-scan complete: scanned=${str(data['scanned'])} linked=${str(data['linked'])} (${durationMs}ms)`;
}

// ---------------------------------------------------------------------------
// nexus task-symbols
// ---------------------------------------------------------------------------

/**
 * Render `cleo nexus task-symbols` human output.
 */
export function renderNexusTaskSymbols(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) return '';
  const taskId = str(data['taskId']);
  const symbols = (data['symbols'] as Array<Record<string, unknown>>) ?? [];
  const durationMs = Number(data['_durationMs'] ?? 0);

  if (symbols.length === 0) {
    return `[nexus] No symbols found for task ${taskId}.\n  Run 'cleo nexus analyze' and ensure git history is available.`;
  }
  const lines: string[] = [`[nexus] Symbols touched by ${taskId} (${symbols.length} total):`, ''];
  for (const s of symbols) {
    lines.push(
      `  [${str(s['kind']).padEnd(12)}] ${str(s['label']).padEnd(50)}  w=${Number(s['weight'] ?? 0).toFixed(2)}  via=${str(s['matchStrategy'])}`,
    );
  }
  lines.push('', `(${durationMs}ms)`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// nexus contracts sync
// ---------------------------------------------------------------------------

/**
 * Render `cleo nexus contracts sync` human output.
 */
export function renderNexusContractsSync(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) return '';
  const durationMs = Number(data['_durationMs'] ?? 0);
  return (
    `[nexus] Contracts extracted from ${str(data['projectId'])}:\n` +
    `  HTTP:  ${str(data['http'])}\n` +
    `  gRPC:  ${str(data['grpc'])}\n` +
    `  Topic: ${str(data['topic'])}\n` +
    `  Total: ${str(data['totalCount'])}\n` +
    `  (${durationMs}ms)`
  );
}

// ---------------------------------------------------------------------------
// nexus contracts show
// ---------------------------------------------------------------------------

/**
 * Render `cleo nexus contracts show` human output.
 */
export function renderNexusContractsShow(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) return '';
  const projectA = str(data['_projectA'] ?? data['projectAId']);
  const projectB = str(data['_projectB'] ?? data['projectBId']);
  const matches = (data['matches'] as Array<Record<string, unknown>>) ?? [];
  const durationMs = Number(data['_durationMs'] ?? 0);

  if (matches.length === 0) {
    return `[nexus] No contract matches found between ${projectA} and ${projectB}.\n  Run 'cleo nexus contracts sync' on both projects first.`;
  }
  const lines: string[] = [
    `[nexus] Contract compatibility: ${projectA} ↔ ${projectB}\n` +
      `  Compatible: ${str(data['compatibleCount'])}  Incompatible: ${str(data['incompatibleCount'])}  Partial: ${str(data['partialCount'])}\n` +
      `  Overall: ${str(data['overallCompatibility'])}%`,
    '',
  ];
  for (const m of matches.slice(0, 20)) {
    const contractA = (m['contractA'] as { id: string }) ?? { id: '—' };
    const contractB = (m['contractB'] as { id: string }) ?? { id: '—' };
    lines.push(
      `  [${str(m['compatibility']).toUpperCase().padEnd(12)}] ${contractA.id} ↔ ${contractB.id}  score=${Number(m['score'] ?? 0).toFixed(2)}`,
    );
  }
  if (matches.length > 20) lines.push(`  (showing 20 of ${matches.length} matches)`);
  lines.push('', `(${durationMs}ms)`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// nexus contracts link-tasks
// ---------------------------------------------------------------------------

/**
 * Render `cleo nexus contracts link-tasks` human output.
 */
export function renderNexusContractsLinkTasks(
  data: Record<string, unknown>,
  quiet: boolean,
): string {
  if (quiet) return '';
  const durationMs = Number(data['_durationMs'] ?? 0);
  return (
    `[nexus] contracts link-tasks:\n` +
    `  Commits processed: ${str(data['commitsProcessed'])}\n` +
    `  Tasks found:       ${str(data['tasksFound'])}\n` +
    `  Edges linked:      ${str(data['linked'])}\n` +
    `  Last commit:       ${str(data['lastCommitHash'], '—')}\n` +
    `  (${durationMs}ms)`
  );
}

// ---------------------------------------------------------------------------
// nexus wiki
// ---------------------------------------------------------------------------

/**
 * Render `cleo nexus wiki` human output.
 */
export function renderNexusWiki(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) return '';
  const outputDir = str(data['_outputDir'] ?? '');
  const durationMs = Number(data['_durationMs'] ?? 0);
  const skippedCommunities = (data['skippedCommunities'] as string[]) ?? [];
  const skippedNote =
    skippedCommunities.length > 0
      ? `\n  Skipped:     ${skippedCommunities.length} unchanged communities`
      : '';
  const loomNote = data['loomEnabled'] ? ' (LOOM narratives enabled)' : ' (scaffold mode)';
  return (
    `[nexus] wiki generated${loomNote}:\n` +
    `  Communities: ${str(data['communityCount'])}\n` +
    `  Files:       ${str(data['fileCount'])}\n` +
    `  Output:      ${outputDir}` +
    skippedNote +
    `\n  (${durationMs}ms)`
  );
}
