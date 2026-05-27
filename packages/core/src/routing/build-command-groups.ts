/**
 * Build command groups for `cleo --help` from the CORE capability SSoT.
 *
 * This module is the single source of truth for "which CLI command belongs to
 * which help category." Previously the CLI package contained a hardcoded
 * `COMMAND_GROUPS` array that had to be manually updated when new commands
 * were added. By moving the mapping here, new operations annotated with a
 * `cliCategory` in the capability matrix will automatically appear in the
 * correct group without any CLI-package changes.
 *
 * @task T9815
 * @module
 */

import type { CliCategory } from '@cleocode/contracts';
import { CLI_CATEGORY_ORDER } from '@cleocode/contracts';

// ---------------------------------------------------------------------------
// CLI Command → Category map (SSoT)
//
// Every top-level CLI command that should appear in a named group is listed
// here. Commands absent from this map fall through to the "OTHER" catch-all
// in the help renderer (a safety net for commands added before this map is
// updated).
//
// Ordering within a category matches the existing display order from the
// original hardcoded COMMAND_GROUPS constant, so the rendered output is
// byte-identical for existing commands.
// ---------------------------------------------------------------------------

/**
 * Maps each top-level CLI command name to its help display category.
 *
 * New commands MUST be added here (or their OperationCapability entry must
 * carry a `cliCommand` + `cliCategory` annotation in capability-matrix.ts).
 */
export const CLI_COMMAND_CATEGORIES: Readonly<Record<string, CliCategory>> = {
  // --- Task Management ---
  add: 'Task Management',
  'add-batch': 'Task Management',
  show: 'Task Management',
  find: 'Task Management',
  list: 'Task Management',
  update: 'Task Management',
  complete: 'Task Management',
  delete: 'Task Management',
  cancel: 'Task Management',
  start: 'Task Management',
  stop: 'Task Management',
  current: 'Task Management',
  next: 'Task Management',
  exists: 'Task Management',

  // --- Task Organization ---
  archive: 'Task Organization',
  labels: 'Task Organization',
  promote: 'Task Organization',
  relates: 'Task Organization',
  reorder: 'Task Organization',
  reparent: 'Task Organization',
  deps: 'Task Organization',
  tree: 'Task Organization',
  blockers: 'Task Organization',
  claim: 'Task Organization',
  unclaim: 'Task Organization',
  saga: 'Task Organization',
  req: 'Task Organization',
  pivot: 'Task Organization',

  // --- Sessions & Planning ---
  session: 'Sessions & Planning',
  briefing: 'Sessions & Planning',
  dash: 'Sessions & Planning',
  plan: 'Sessions & Planning',
  safestop: 'Sessions & Planning',
  context: 'Sessions & Planning',
  status: 'Sessions & Planning',
  setup: 'Sessions & Planning',

  // --- Phases & Lifecycle ---
  phase: 'Phases & Lifecycle',
  lifecycle: 'Phases & Lifecycle',
  release: 'Phases & Lifecycle',
  roadmap: 'Phases & Lifecycle',
  chain: 'Phases & Lifecycle',
  playbook: 'Phases & Lifecycle',

  // --- Memory & Notes ---
  memory: 'Memory & Notes',
  brain: 'Memory & Notes',
  'refresh-memory': 'Memory & Notes',
  sticky: 'Memory & Notes',
  reason: 'Memory & Notes',
  manifest: 'Memory & Notes',

  // --- Analysis & Stats ---
  analyze: 'Analysis & Stats',
  stats: 'Analysis & Stats',
  history: 'Analysis & Stats',
  'archive-stats': 'Analysis & Stats',
  complexity: 'Analysis & Stats',
  intelligence: 'Analysis & Stats',
  diagnostics: 'Analysis & Stats',
  telemetry: 'Analysis & Stats',
  cost: 'Analysis & Stats',

  // --- Validation & Compliance ---
  check: 'Validation & Compliance',
  verify: 'Validation & Compliance',
  testing: 'Validation & Compliance',
  compliance: 'Validation & Compliance',
  consensus: 'Validation & Compliance',
  contribution: 'Validation & Compliance',
  decomposition: 'Validation & Compliance',
  backfill: 'Validation & Compliance',
  reconcile: 'Validation & Compliance',
  audit: 'Validation & Compliance',
  provenance: 'Validation & Compliance',

  // --- Code & Documentation ---
  code: 'Code & Documentation',
  docs: 'Code & Documentation',
  'detect-drift': 'Code & Documentation',
  map: 'Code & Documentation',
  graph: 'Code & Documentation',
  'agent-outputs': 'Code & Documentation',
  changeset: 'Code & Documentation',

  // --- Research & Orchestration ---
  research: 'Research & Orchestration',
  orchestrate: 'Research & Orchestration',
  conduit: 'Research & Orchestration',
  orchestrator: 'Research & Orchestration',
  sentient: 'Research & Orchestration',
  event: 'Research & Orchestration',
  tasks: 'Research & Orchestration',

  // --- Import / Export ---
  export: 'Import / Export',
  import: 'Import / Export',
  'export-tasks': 'Import / Export',
  'import-tasks': 'Import / Export',
  snapshot: 'Import / Export',
  inject: 'Import / Export',
  sync: 'Import / Export',

  // --- Collaboration ---
  nexus: 'Collaboration',
  remote: 'Collaboration',
  push: 'Collaboration',
  pull: 'Collaboration',
  checkpoint: 'Collaboration',
  federation: 'Collaboration',

  // --- Agents ---
  agent: 'Agents',
  grade: 'Agents',
  llm: 'Agents',
  auth: 'Agents',
  stream: 'Agents',
  transcript: 'Agents',
  gc: 'Agents',
  daemon: 'Agents',
  worktree: 'Agents',
  curator: 'Agents',

  // --- System & Admin ---
  version: 'System & Admin',
  init: 'System & Admin',
  config: 'System & Admin',
  templates: 'System & Admin',
  admin: 'System & Admin',
  doctor: 'System & Admin',
  'doctor-projects': 'System & Admin',
  upgrade: 'System & Admin',
  'self-update': 'System & Admin',
  ops: 'System & Admin',
  schema: 'System & Admin',
  log: 'System & Admin',
  sequence: 'System & Admin',
  adr: 'System & Admin',
  cant: 'System & Admin',
  token: 'System & Admin',
  otel: 'System & Admin',
  migrate: 'System & Admin',
  detect: 'System & Admin',
  'generate-changelog': 'System & Admin',
  issue: 'System & Admin',
  skills: 'System & Admin',
  skill: 'System & Admin',
  web: 'System & Admin',
  backup: 'System & Admin',
  restore: 'System & Admin',
  caamp: 'System & Admin',
  provider: 'System & Admin',
  adapter: 'System & Admin',
  'install-global': 'System & Admin',
  'agents-v2': 'System & Admin',
  dynamic: 'System & Admin',
  revert: 'System & Admin',
  inspect: 'System & Admin',
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single command group as consumed by the help renderer.
 * Mirrors the `CommandGroup` interface in `help-renderer.ts`.
 */
export interface CommandGroup {
  /** Display name for the group (e.g. "Task Management"). */
  readonly name: string;
  /** Ordered list of CLI command names in this group. */
  readonly commands: readonly string[];
}

// ---------------------------------------------------------------------------
// buildCommandGroups
// ---------------------------------------------------------------------------

/**
 * Build an ordered array of command groups from the CORE command-category map.
 *
 * Commands are grouped by their `cliCategory`. Groups appear in the canonical
 * display order defined by `CLI_CATEGORY_ORDER`. Within each group, commands
 * are ordered by their first appearance in `categoryOverrides` (if provided)
 * then by their position in `CLI_COMMAND_CATEGORIES`.
 *
 * @param registeredCommands - Set of CLI command names that are actually
 *   registered in the current build. Pass the `Object.keys(subCommands)` from
 *   the CLI entry point. Only registered commands are included in the output.
 *   Pass `undefined` to include all commands in the category map (useful for
 *   testing without a live CLI manifest).
 * @param categoryOverrides - Optional per-command category overrides (e.g.
 *   from a capability-matrix OperationCapability annotated with `cliCategory`).
 *   Keys are CLI command names; values are the target category.
 * @returns Ordered array of `CommandGroup` objects ready for the help renderer.
 *   Empty groups are omitted.
 */
export function buildCommandGroups(
  registeredCommands?: ReadonlySet<string> | readonly string[],
  categoryOverrides?: Readonly<Record<string, CliCategory>>,
): CommandGroup[] {
  // Merge base map with any overrides (overrides win).
  const merged: Record<string, CliCategory> = { ...CLI_COMMAND_CATEGORIES };
  if (categoryOverrides) {
    for (const [cmd, cat] of Object.entries(categoryOverrides)) {
      merged[cmd] = cat;
    }
  }

  // Normalise registeredCommands to a Set for O(1) lookup.
  const registeredSet: ReadonlySet<string> | null =
    registeredCommands == null
      ? null
      : registeredCommands instanceof Set
        ? registeredCommands
        : new Set(registeredCommands);

  // Bucket commands by category, preserving insertion order of CLI_COMMAND_CATEGORIES.
  const buckets = new Map<CliCategory, string[]>();
  for (const cat of CLI_CATEGORY_ORDER) {
    buckets.set(cat, []);
  }

  for (const [cmd, cat] of Object.entries(merged)) {
    if (registeredSet !== null && !registeredSet.has(cmd)) continue;
    const bucket = buckets.get(cat);
    if (bucket !== undefined) {
      bucket.push(cmd);
    }
  }

  // Build result — skip empty buckets.
  const result: CommandGroup[] = [];
  for (const [name, commands] of buckets) {
    if (commands.length > 0) {
      result.push({ name, commands });
    }
  }
  return result;
}
