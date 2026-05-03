/**
 * Human-readable renderers for nexus CLI subcommands.
 *
 * Each renderer function accepts the structured data from the dispatch result
 * and returns a formatted multi-line string for --human output.
 *
 * All renderers follow the `HumanRenderer` contract:
 *   (data: Record<string, unknown>, quiet: boolean) => string
 *
 * Data shape for each renderer mirrors the dispatch result shape.
 *
 * @task T1720
 * @epic T1691
 */

/** Format a string field or fall back to a default. */
function str(v: unknown, fallback = '—'): string {
  if (v === null || v === undefined) return fallback;
  return String(v);
}

/** Format a number with optional padding. */
function num(v: unknown, width = 0, fallback = '—'): string {
  if (v === null || v === undefined) return fallback;
  const s = String(Number(v));
  return width > 0 ? s.padStart(width) : s;
}

// ---------------------------------------------------------------------------
// nexus status
// ---------------------------------------------------------------------------

/**
 * Render `cleo nexus status` human output.
 */
export function renderNexusStatus(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) return '';
  const repoPath = str(data['repoPath']);
  const projectId = str(data['projectId']);
  const indexed = data['indexed'] as boolean | undefined;
  if (!indexed) {
    return (
      `[nexus] Index status for: ${repoPath}\n` +
      `  Status:     NOT INDEXED\n` +
      `  Run 'cleo nexus analyze' to build the index.`
    );
  }
  const staleFileCount = Number(data['staleFileCount'] ?? -1);
  const staleLabel =
    staleFileCount < 0
      ? 'unknown'
      : staleFileCount === 0
        ? 'up to date'
        : `${staleFileCount} stale`;
  return (
    `[nexus] Index status for: ${repoPath}\n` +
    `  Project ID:   ${projectId}\n` +
    `  Nodes:        ${str(data['nodeCount'])}\n` +
    `  Relations:    ${str(data['relationCount'])}\n` +
    `  Files:        ${str(data['fileCount'])}\n` +
    `  Last indexed: ${str(data['lastIndexedAt'], 'never')}\n` +
    `  Staleness:    ${staleLabel}`
  );
}

// ---------------------------------------------------------------------------
// nexus setup
// ---------------------------------------------------------------------------

/**
 * Render `cleo nexus setup` human output.
 */
export function renderNexusSetup(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) return '';
  const homeDir = str(data['homeDir']);
  return (
    `[nexus] Installed PreToolUse hook at ${homeDir}/.cleo/hooks/nexus-augment.sh\n` +
    `[nexus] Hook will inject symbol context into Grep/Glob/Read tool calls`
  );
}

// ---------------------------------------------------------------------------
// nexus clusters
// ---------------------------------------------------------------------------

/**
 * Render `cleo nexus clusters` human output.
 */
export function renderNexusClusters(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) return '';
  const projectId = str(data['projectId']);
  const communities = (data['communities'] as Array<Record<string, unknown>>) ?? [];
  if (communities.length === 0) {
    return `[nexus] No communities found for project ${projectId}.\n  Run 'cleo nexus analyze' first.`;
  }
  const lines: string[] = [
    `[nexus] Communities for project ${projectId} (${communities.length} total):`,
  ];
  for (const c of communities) {
    const cohesion =
      typeof c['cohesion'] === 'number' ? (c['cohesion'] as number).toFixed(3) : '0.000';
    lines.push(
      `  ${str(c['id']).padEnd(16)}  label=${str(c['label'] ?? '').padEnd(24)}  symbols=${num(c['symbolCount'], 5)}  cohesion=${cohesion}`,
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// nexus flows
// ---------------------------------------------------------------------------

/**
 * Render `cleo nexus flows` human output.
 */
export function renderNexusFlows(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) return '';
  const projectId = str(data['projectId']);
  const flows = (data['flows'] as Array<Record<string, unknown>>) ?? [];
  if (flows.length === 0) {
    return `[nexus] No execution flows found for project ${projectId}.\n  Run 'cleo nexus analyze' first.`;
  }
  const lines: string[] = [
    `[nexus] Execution flows for project ${projectId} (${flows.length} total):`,
  ];
  for (const p of flows) {
    const processType = str(p['processType']).replace('_community', '');
    lines.push(
      `  ${str(p['id']).padEnd(30)}  steps=${num(p['stepCount'], 3)}  type=${processType.padEnd(12)}  ${str(p['label'] ?? '')}`,
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// nexus context
// ---------------------------------------------------------------------------

/**
 * Render `cleo nexus context` human output.
 */
export function renderNexusContext(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) return '';
  const matchCount = Number(data['matchCount'] ?? 0);
  const symbolName = str(data['_symbolName'] ?? '(unknown)');
  if (matchCount === 0) {
    return `[nexus] No symbol found matching '${symbolName}'.\n  Run 'cleo nexus analyze' first, or check the symbol name.`;
  }
  const results = (data['results'] as Array<Record<string, unknown>>) ?? [];
  const lines: string[] = [
    `[nexus] Context for symbol '${symbolName}' (${matchCount} match${matchCount !== 1 ? 'es' : ''}):`,
  ];
  for (const r of results) {
    const callers = (r['callers'] as Array<{ name: string; kind: string }>) ?? [];
    const callees = (r['callees'] as Array<{ name: string; kind: string }>) ?? [];
    const processes = (r['processes'] as Array<{ label: unknown; role: string }>) ?? [];
    const community = r['community'] as { id: string | null; label: unknown } | null;
    const source = r['source'] as
      | { source: string; startLine: number; endLine: number; errors: string[] }
      | undefined;
    lines.push('');
    let entry =
      `  Symbol:   ${str(r['name'])}  (${str(r['kind'])})\n  File:     ${str(r['filePath'], 'n/a')}` +
      (r['startLine'] ? `:${str(r['startLine'])}` : '') +
      '\n';
    if (r['docSummary']) entry += `  Doc:      ${str(r['docSummary'])}\n`;
    if (community) entry += `  Community: ${str(community.label ?? community.id)}\n`;
    entry += `  Callers (${callers.length}): ${callers.length === 0 ? 'none' : callers.map((c) => `${c.name}[${c.kind}]`).join(', ')}\n`;
    entry += `  Callees (${callees.length}): ${callees.length === 0 ? 'none' : callees.map((c) => `${c.name}[${c.kind}]`).join(', ')}`;
    if (processes.length > 0) {
      entry += `\n  Processes: ${processes.map((p) => `${str(p.label)}(${p.role})`).join(', ')}`;
    }
    lines.push(entry);
    if (source?.source) {
      const ext = str(r['filePath']).split('.').pop() ?? 'txt';
      lines.push(
        `\n  Source (lines ${source.startLine}-${source.endLine}):\n  \`\`\`${ext}\n${source.source
          .split('\n')
          .map((line) => `  ${line}`)
          .join('\n')}\n  \`\`\``,
      );
    } else if (source?.errors?.length) {
      lines.push(`\n  [warning] Could not retrieve source: ${source.errors[0]}`);
    }
  }
  if (matchCount > 5) {
    lines.push(`\n  (Showing 5 of ${matchCount} matches — use --json for full list)`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// nexus impact
// ---------------------------------------------------------------------------

/**
 * Render `cleo nexus impact` human output.
 */
export function renderNexusImpact(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) return '';
  const symbolName = str(data['_symbolName'] ?? data['targetName'] ?? '(unknown)');
  if (data['_notFound']) {
    return `[nexus] No symbol found matching '${symbolName}'.\n  Run 'cleo nexus analyze' first, or check the symbol name.`;
  }
  const lines: string[] = [
    `[nexus] Impact analysis for '${symbolName}'\n` +
      `  Target:  ${str(data['targetName'])}  (${str(data['targetKind'])})\n` +
      `  File:    ${str(data['targetFilePath'], 'n/a')}\n` +
      `  Risk:    ${str(data['riskLevel'])}  (${num(data['totalImpactedNodes'])} impacted node${Number(data['totalImpactedNodes']) !== 1 ? 's' : ''})`,
  ];
  const impactByDepth =
    (data['impactByDepth'] as Array<{
      nodes: Array<{ name: string; kind: string; filePath?: string; reasons: string[] }>;
    }>) ?? [];
  if (Number(data['totalImpactedNodes']) === 0) {
    lines.push('  No callers found — safe to modify.');
  } else {
    for (let i = 0; i < impactByDepth.length; i++) {
      const layer = impactByDepth[i];
      if (!layer || layer.nodes.length === 0) continue;
      const label = i === 0 ? 'WILL BREAK' : i === 1 ? 'LIKELY AFFECTED' : 'MAY NEED TESTING';
      lines.push(`\n  d=${i + 1} ${label} (${layer.nodes.length}):`);
      for (const node of layer.nodes.slice(0, 15)) {
        lines.push(
          `    ${String(node.name).padEnd(36)}  ${String(node.kind).padEnd(12)}  ${node.filePath ?? ''}`,
        );
        if (data['_why'] && node.reasons.length > 0) {
          for (const reason of node.reasons) {
            lines.push(`      why: ${reason}`);
          }
        }
      }
      if (layer.nodes.length > 15) {
        lines.push(`    ... and ${layer.nodes.length - 15} more`);
      }
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// nexus analyze
// ---------------------------------------------------------------------------

/**
 * Render `cleo nexus analyze` human output.
 */
export function renderNexusAnalyze(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) return '';
  const isIncremental = !!data['incremental'];
  return (
    `[nexus] Analysis complete${isIncremental ? ' (incremental)' : ''}:\n` +
    `  Project ID: ${str(data['projectId'])}\n` +
    `  Files:      ${str(data['fileCount'])}\n` +
    `  Nodes:      ${str(data['nodeCount'])}\n` +
    `  Relations:  ${str(data['relationCount'])}\n` +
    `  Duration:   ${str(data['durationMs'])}ms`
  );
}

// ---------------------------------------------------------------------------
// nexus projects list
// ---------------------------------------------------------------------------

/**
 * Render `cleo nexus projects list` human output.
 */
export function renderNexusProjectsList(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) return '';
  const list = (data['projects'] as Array<Record<string, unknown>>) ?? [];
  if (list.length === 0) {
    return '[nexus] No projects registered. Run: cleo nexus projects register';
  }
  const lines: string[] = [`[nexus] Registered projects (${list.length}):`, ''];
  for (const p of list) {
    const stats = (p['stats'] as Record<string, unknown>) ?? {};
    const nodes = Number(stats['nodeCount'] ?? 0);
    const rels = Number(stats['relationCount'] ?? 0);
    const indexed = p['lastIndexed'] ? str(p['lastIndexed']).slice(0, 10) : 'never';
    lines.push(
      `  ${str(p['name']).padEnd(28)}  tasks=${num(p['taskCount'], 5)}  nodes=${String(nodes).padStart(6)}  relations=${String(rels).padStart(7)}  indexed=${indexed}`,
    );
    lines.push(`  ${''.padEnd(28)}  path=${str(p['path'])}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// nexus projects register
// ---------------------------------------------------------------------------

/**
 * Render `cleo nexus projects register` human output.
 */
export function renderNexusProjectsRegister(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) return '';
  return `[nexus] Registered: ${str(data['path'])} (hash: ${str(data['hash'])})`;
}

// ---------------------------------------------------------------------------
// nexus projects remove
// ---------------------------------------------------------------------------

/**
 * Render `cleo nexus projects remove` human output.
 */
export function renderNexusProjectsRemove(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) return '';
  return `[nexus] Removed: ${str(data['nameOrHash'] ?? data['removed'])}`;
}

// ---------------------------------------------------------------------------
// nexus projects scan
// ---------------------------------------------------------------------------

/**
 * Render `cleo nexus projects scan` human output.
 */
export function renderNexusProjectsScan(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) return '';
  const roots = (data['roots'] as string[]) ?? [];
  const maxDepth = Number(data['_maxDepth'] ?? 4);
  const tally = (data['tally'] as Record<string, number>) ?? {};
  const unregistered = (data['unregistered'] as string[]) ?? [];
  const registered = (data['registered'] as string[]) ?? [];
  const autoRegistered = (data['autoRegistered'] as string[]) ?? [];
  const autoRegisterErrors =
    (data['autoRegisterErrors'] as Array<{ path: string; error: string }>) ?? [];
  const autoRegister = !!data['_autoRegister'];
  const includeExisting = !!data['_includeExisting'];

  const lines: string[] = [
    `[nexus] Scanning ${roots.length} root(s) up to depth ${maxDepth}:`,
    ...roots.map((r) => `  ${r}`),
    '',
    `[nexus] Scan complete — ${tally['total'] ?? 0} project(s) found (${tally['unregistered'] ?? 0} unregistered, ${tally['registered'] ?? 0} registered)`,
  ];
  if (unregistered.length > 0) {
    lines.push('\n  Unregistered:');
    for (const p of unregistered) lines.push(`    ${p}`);
    if (!autoRegister) {
      lines.push('\n  Tip: run with --auto-register to register all of the above.');
    }
  }
  if (includeExisting && registered.length > 0) {
    lines.push('\n  Already registered:');
    for (const p of registered) lines.push(`    ${p}`);
  }
  if (autoRegister) {
    lines.push(
      `\n  Auto-registered: ${autoRegistered.length} project(s)${autoRegisterErrors.length > 0 ? `, ${autoRegisterErrors.length} failed` : ''}`,
    );
    for (const e of autoRegisterErrors) {
      lines.push(`    FAILED ${e.path}: ${e.error}`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// nexus projects clean
// ---------------------------------------------------------------------------

/**
 * Render `cleo nexus projects clean` human output.
 */
export function renderNexusProjectsClean(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) return '';
  const dryRun = !!data['dryRun'];
  const matched = Number(data['matched'] ?? 0);
  const purged = Number(data['purged'] ?? 0);
  const remaining = Number(data['remaining'] ?? 0);

  if (dryRun) {
    if (matched === 0) return '';
    return `[nexus] Dry-run — ${matched} project(s) would be purged. Rerun without --dry-run to delete.`;
  }
  return `[nexus] Purged ${purged} project(s). ${remaining} project(s) remaining in registry.`;
}

/**
 * Render `cleo nexus projects clean` preview human output (shown before confirmation).
 * Used for the preview phase (always dry-run first).
 */
export function renderNexusProjectsCleanPreview(
  data: Record<string, unknown>,
  _quiet: boolean,
): string {
  const matched = Number(data['matched'] ?? 0);
  const totalCount = Number(data['totalCount'] ?? 0);
  const samplePaths = (data['sample'] as string[]) ?? [];
  const lines: string[] = [
    `[nexus] Clean preview — ${matched} project(s) of ${totalCount} total match criteria:`,
  ];
  if (matched === 0) {
    lines.push('  (no matches)');
  } else {
    for (const p of samplePaths) lines.push(`  ${p}`);
    if (matched > 10) lines.push(`  ... and ${matched - 10} more`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// nexus refresh-bridge
// ---------------------------------------------------------------------------

/**
 * Render `cleo nexus refresh-bridge` human output.
 */
export function renderNexusRefreshBridge(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) return '';
  if (data['written']) {
    return `[nexus] nexus-bridge.md refreshed at ${str(data['path'])}`;
  }
  return `[nexus] nexus-bridge.md unchanged at ${str(data['path'])}`;
}

// ---------------------------------------------------------------------------
// nexus diff
// ---------------------------------------------------------------------------

/**
 * Render `cleo nexus diff` human output.
 */
export function renderNexusDiff(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) return '';
  const changedFiles = (data['changedFiles'] as string[]) ?? [];
  const regressions = (data['regressions'] as string[]) ?? [];
  const lines: string[] = [
    `[nexus] Diff: ${str(data['beforeSha'])}..${str(data['afterSha'])}\n` +
      `  Changed files: ${changedFiles.length > 0 ? changedFiles.join(', ') : 'n/a'}\n` +
      `  Nodes:     before=${str(data['nodesBefore'])}  after=${str(data['nodesAfter'])}  new=+${str(data['newNodes'])}  removed=-${str(data['removedNodes'])}\n` +
      `  Relations: before=${str(data['relationsBefore'])}  after=${str(data['relationsAfter'])}  new=+${str(data['newRelations'])}  removed=-${str(data['removedRelations'])}\n` +
      `  Health:    ${str(data['healthStatus'])}`,
  ];
  if (regressions.length > 0) {
    lines.push('\n  REGRESSIONS:');
    for (const reg of regressions) lines.push(`    - ${reg}`);
  } else {
    lines.push('  No regressions detected.');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// nexus route-map
// ---------------------------------------------------------------------------

/**
 * Render `cleo nexus route-map` human output.
 */
export function renderNexusRouteMap(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) return '';
  const projectId = str(data['_projectId'] ?? '');
  const routes = (data['routes'] as Array<Record<string, unknown>>) ?? [];
  const distinctDeps = (data['distinctDeps'] as string[]) ?? [];
  if (routes.length === 0) {
    return `[nexus] No routes found for project ${projectId}.\n  Run 'cleo nexus analyze' first.`;
  }
  const lines: string[] = [
    `[nexus] Route Map for project ${projectId} (${routes.length} total):`,
    '',
    '| Route ID | Handler | Method | Path | Deps | Callers |',
    '|----------|---------|--------|------|------|----------|',
  ];
  for (const route of routes) {
    const routeMeta = (route['routeMeta'] as Record<string, unknown>) ?? {};
    const method = str(routeMeta['method'], '—');
    const routePath = str(routeMeta['path'], '—');
    const depCount = ((route['fetchedDeps'] as unknown[]) ?? []).length;
    lines.push(
      `| ${str(route['routeId'])} | ${str(route['handlerName'])} | ${method} | ${routePath} | ${depCount} | ${str(route['callerCount'])} |`,
    );
  }
  lines.push('');
  if (distinctDeps.length > 0) {
    lines.push(`External dependencies: ${distinctDeps.join(', ')}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// nexus shape-check
// ---------------------------------------------------------------------------

/**
 * Render `cleo nexus shape-check` human output.
 */
export function renderNexusShapeCheck(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) return '';
  const routeSymbol = str(data['_routeSymbol'] ?? data['handlerId'] ?? '');
  const callers = (data['callers'] as Array<Record<string, unknown>>) ?? [];
  const lines: string[] = [
    `[nexus] Shape Check for route ${routeSymbol}`,
    '',
    `Handler: ${str(data['handlerId'])}`,
    `Declared Shape: ${str(data['declaredShape'])}`,
    `Overall Status: ${str(data['overallStatus'])}`,
    `Recommendation: ${str(data['recommendation'])}`,
    '',
  ];
  if (callers.length === 0) {
    lines.push('No callers found.');
  } else {
    lines.push(
      `Callers (${callers.length} total):`,
      '| Caller | File | Expected Shape | Status |',
      '|--------|------|---------------|---------|',
    );
    for (const caller of callers) {
      lines.push(
        `| ${str(caller['callerName'])} | ${str(caller['callerFile'])} | ${str(caller['expectedShape'])} | ${str(caller['status'])} |`,
      );
    }
    const incompatible = callers.filter((c) => c['status'] !== 'compatible');
    if (incompatible.length > 0) {
      lines.push('\nIncompatibilities:');
      for (const caller of incompatible) {
        lines.push(`  - ${str(caller['callerName'])}: ${str(caller['diagnosis'])}`);
      }
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// nexus full-context
// ---------------------------------------------------------------------------

/**
 * Render `cleo nexus full-context` human output.
 */
export function renderNexusFullContext(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) return '';
  const nexus = data['nexus'] as Record<string, unknown> | null | undefined;
  const brainMemories = (data['brainMemories'] as Array<Record<string, unknown>>) ?? [];
  const tasks = (data['tasks'] as Array<{ taskId: string; weight: number }>) ?? [];
  const sentientProposals =
    (data['sentientProposals'] as Array<{ title: string; weight: number }>) ?? [];
  const conduitThreads =
    (data['conduitThreads'] as Array<{ nodeId: string; weight: number }>) ?? [];
  const plasticityWeight = (data['plasticityWeight'] as {
    totalWeight: number;
    edgeCount: number;
  }) ?? { totalWeight: 0, edgeCount: 0 };
  const durationMs = Number(data['_durationMs'] ?? 0);

  const lines: string[] = [`\n## Living Brain: ${str(data['symbolId'])}`, '', '### NEXUS'];
  if (!nexus) {
    lines.push(`  (no nexus data — run 'cleo nexus analyze' first)`);
  } else {
    const callers = (nexus['callers'] as Array<{ name: string }>) ?? [];
    const callees = (nexus['callees'] as Array<{ name: string }>) ?? [];
    lines.push(`  Kind: ${str(nexus['kind'])}  File: ${str(nexus['filePath'], '—')}`);
    lines.push(
      `  Callers (${callers.length}): ${
        callers
          .map((c) => c.name)
          .slice(0, 10)
          .join(', ') || '—'
      }`,
    );
    lines.push(
      `  Callees (${callees.length}): ${
        callees
          .map((c) => c.name)
          .slice(0, 10)
          .join(', ') || '—'
      }`,
    );
    lines.push(
      `  Plasticity: w=${plasticityWeight.totalWeight.toFixed(2)} edges=${plasticityWeight.edgeCount}`,
    );
  }
  lines.push(`\n### BRAIN memories (${brainMemories.length})`);
  for (const m of brainMemories.slice(0, 10)) {
    lines.push(
      `  [${str(m['nodeType'])}] ${str(m['label']).slice(0, 80)} (edge=${str(m['edgeType'])} w=${Number(m['weight'] ?? 0).toFixed(2)})`,
    );
  }
  if (brainMemories.length === 0) lines.push(`  (none)`);
  lines.push(`\n### TASKS (${tasks.length})`);
  for (const t of tasks.slice(0, 10)) lines.push(`  ${t.taskId}  w=${t.weight.toFixed(2)}`);
  if (tasks.length === 0) lines.push(`  (none)`);
  lines.push(`\n### SENTIENT proposals (${sentientProposals.length})`);
  for (const p of sentientProposals.slice(0, 5))
    lines.push(`  ${p.title.slice(0, 80)} (w=${p.weight.toFixed(2)})`);
  if (sentientProposals.length === 0) lines.push(`  (none)`);
  lines.push(`\n### CONDUIT threads (${conduitThreads.length})`);
  for (const c of conduitThreads.slice(0, 5)) lines.push(`  ${c.nodeId}  w=${c.weight.toFixed(2)}`);
  if (conduitThreads.length === 0) lines.push(`  (none)`);
  lines.push(`\n(${durationMs}ms)`);
  return lines.join('\n');
}

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
// nexus why
// ---------------------------------------------------------------------------

/**
 * Render `cleo nexus why` human output.
 */
export function renderNexusWhy(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) return '';
  const chain = (data['chain'] as Array<Record<string, unknown>>) ?? [];
  const durationMs = Number(data['_durationMs'] ?? 0);

  const lines: string[] = [
    `\n## Code Reasoning: ${str(data['symbolId'])}`,
    '',
    `**Narrative**: ${str(data['narrative'])}`,
    '',
    `### Trace Chain (${chain.length} steps)`,
  ];
  if (chain.length === 0) {
    lines.push(`  (no trace — run 'cleo nexus analyze' and 'cleo memory code-links' first)`);
  } else {
    for (const step of chain) {
      const refs = (step['refs'] as string[]) ?? [];
      const refsStr = refs.length > 0 ? `  refs=[${refs.join(', ')}]` : '';
      lines.push(
        `  [${str(step['type'])}] ${str(step['id'])}: ${str(step['title']).slice(0, 80)}${refsStr}`,
      );
    }
  }
  lines.push(`\n(${durationMs}ms)`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// nexus impact-full
// ---------------------------------------------------------------------------

/**
 * Render `cleo nexus impact-full` human output.
 */
export function renderNexusImpactFull(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) return '';
  const structural = (data['structural'] as Record<string, unknown>) ?? {};
  const openTasks = (data['openTasks'] as Array<Record<string, unknown>>) ?? [];
  const brainRiskNotes = (data['brainRiskNotes'] as Array<Record<string, unknown>>) ?? [];
  const durationMs = Number(data['_durationMs'] ?? 0);

  const lines: string[] = [
    `\n## Full Impact: ${str(data['symbolId'])}`,
    '',
    `**Merged Risk Score**: ${str(data['mergedRiskScore'])}`,
    `**Narrative**: ${str(data['narrative'])}`,
    '',
    '### Structural Blast Radius',
    `  d=1 (will break)=${str(structural['directCallers'])}` +
      `  d=2 (likely affected)=${str(structural['likelyAffected'])}` +
      `  d=3 (may need testing)=${str(structural['mayNeedTesting'])}` +
      `  total=${str(structural['totalAffected'])}` +
      `  risk=${str(structural['riskLevel'])}`,
    '',
    `### Open Tasks (${openTasks.length})`,
  ];
  for (const t of openTasks.slice(0, 10)) {
    lines.push(
      `  ${str(t['taskId'])}  ${str(t['label']).slice(0, 60)}  w=${Number(t['weight'] ?? 0).toFixed(2)}`,
    );
  }
  if (openTasks.length === 0) lines.push(`  (none)`);
  lines.push(`\n### Brain Risk Notes (${brainRiskNotes.length})`);
  for (const n of brainRiskNotes.slice(0, 10)) {
    lines.push(
      `  [${str(n['nodeType'])}] ${str(n['label']).slice(0, 70)}  edge=${str(n['edgeType'])}  w=${Number(n['weight'] ?? 0).toFixed(2)}`,
    );
  }
  if (brainRiskNotes.length === 0) lines.push(`  (none)`);
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
// nexus query (CTE)
// ---------------------------------------------------------------------------

/**
 * Render `cleo nexus query` human output.
 */
export function renderNexusQuery(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) return '';
  const markdown = str(data['_markdown'] ?? '');
  const rowCount = Number(data['row_count'] ?? 0);
  const executionTimeMs = Number(data['execution_time_ms'] ?? 0);
  return `${markdown}\n\n[nexus] ${rowCount} rows in ${executionTimeMs.toFixed(2)}ms`;
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

// ---------------------------------------------------------------------------
// nexus hot-paths
// ---------------------------------------------------------------------------

/**
 * Render `cleo nexus hot-paths` human output.
 */
export function renderNexusHotPaths(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) return '';
  const paths = (data['paths'] as Array<Record<string, unknown>>) ?? [];
  const count = Number(data['count'] ?? 0);
  const note = data['note'] as string | undefined;

  const lines: string[] = [];
  if (note) lines.push(`[nexus] Note: ${note}`);
  if (paths.length === 0) {
    lines.push('[nexus] No hot paths found.');
    return lines.join('\n');
  }
  lines.push(
    '| Source | Target | Edge Type | Weight | Co-Access |\n| --- | --- | --- | --- | --- |',
  );
  for (const p of paths) {
    lines.push(
      `| ${str(p['sourceId'])} | ${str(p['targetId'])} | ${str(p['type'])} | ${Number(p['weight'] ?? 0).toFixed(4)} | ${str(p['coAccessedCount'])} |`,
    );
  }
  lines.push(`\n${count} edge(s) shown.`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// nexus hot-nodes
// ---------------------------------------------------------------------------

/**
 * Render `cleo nexus hot-nodes` human output.
 */
export function renderNexusHotNodes(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) return '';
  const nodes = (data['nodes'] as Array<Record<string, unknown>>) ?? [];
  const count = Number(data['count'] ?? 0);
  const note = data['note'] as string | undefined;

  const lines: string[] = [];
  if (note) lines.push(`[nexus] Note: ${note}`);
  if (nodes.length === 0) {
    lines.push('[nexus] No hot nodes found.');
    return lines.join('\n');
  }
  lines.push('| Symbol | Total Weight | File | Kind |\n| --- | --- | --- | --- |');
  for (const n of nodes) {
    const file = str(n['filePath'], '(unknown)');
    lines.push(
      `| ${str(n['label'])} | ${Number(n['totalWeight'] ?? 0).toFixed(4)} | ${file} | ${str(n['kind'])} |`,
    );
  }
  lines.push(`\n${count} node(s) shown.`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// nexus cold-symbols
// ---------------------------------------------------------------------------

/**
 * Render `cleo nexus cold-symbols` human output.
 */
export function renderNexusColdSymbols(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) return '';
  const symbols = (data['symbols'] as Array<Record<string, unknown>>) ?? [];
  const count = Number(data['count'] ?? 0);
  const thresholdDays = Number(data['thresholdDays'] ?? 30);
  const note = data['note'] as string | undefined;

  const lines: string[] = [];
  if (note) lines.push(`[nexus] Note: ${note}`);
  if (symbols.length === 0) {
    lines.push(`[nexus] No cold symbols found (threshold: ${thresholdDays} days, weight < 0.1).`);
    return lines.join('\n');
  }
  lines.push('| Symbol | Last Accessed | Weight | File |\n| --- | --- | --- | --- |');
  for (const s of symbols) {
    const lastAccessed = str(s['lastAccessed'], '(never)');
    const file = str(s['filePath'], '(unknown)');
    lines.push(
      `| ${str(s['label'])} | ${lastAccessed} | ${Number(s['maxWeight'] ?? 0).toFixed(4)} | ${file} |`,
    );
  }
  lines.push(`\n${count} cold symbol(s) found (threshold: ${thresholdDays} days).`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// nexus search-code (timing only, dispatch handles output)
// ---------------------------------------------------------------------------

/**
 * Render `cleo nexus search-code` human output timing line.
 */
export function renderNexusSearchCode(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) return '';
  const durationMs = Number(data['_durationMs'] ?? 0);
  return `(${durationMs}ms)`;
}

// ---------------------------------------------------------------------------
// nexus export (handled separately — raw file output)
// ---------------------------------------------------------------------------

/**
 * Render `cleo nexus export` confirmation human output.
 */
export function renderNexusExport(data: Record<string, unknown>, quiet: boolean): string {
  if (quiet) return '';
  if (data['outputFile']) {
    return `[nexus] Exported to ${str(data['outputFile'])} (${str(data['nodeCount'])} nodes, ${str(data['edgeCount'])} edges)`;
  }
  // stdout export: raw content is handled separately
  return '';
}
