/**
 * CLI workgraph command group — PM-Core V2 WorkGraph operations.
 *
 * Thin CLI wrappers over @cleocode/core workGraph exports. All business
 * logic lives in packages/core/src/workgraph/.
 *
 * @saga T10538 — SG-PM-CORE-V2
 * @see packages/core/src/workgraph/
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineCommand, showUsage } from 'citty';

const validateCommand = defineCommand({
  meta: {
    name: 'validate',
    description: 'Validate a WorkGraph scaffold JSON payload (dry-run)',
  },
  args: {
    file: {
      type: 'positional',
      description: 'Path to scaffold JSON file',
      required: true,
    },
  },
  async run({ args }) {
    const { validateWorkGraphScaffold } = await import('@cleocode/core/workgraph');
    const { cliOutput } = await import('../renderers/index.js');
    const filePath = resolve(String(args.file));
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch {
      cliOutput(
        { error: `Cannot read file: ${filePath}` },
        { command: 'workgraph', operation: 'validate' },
      );
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      cliOutput(
        { error: `Invalid JSON in ${filePath}` },
        { command: 'workgraph', operation: 'validate' },
      );
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = validateWorkGraphScaffold(payload as any);
    cliOutput(result, { command: 'workgraph', operation: 'validate' });
  },
});

const applyCommand = defineCommand({
  meta: {
    name: 'apply',
    description: 'Atomically apply a WorkGraph scaffold to the task database',
  },
  args: {
    file: {
      type: 'positional',
      description: 'Path to scaffold JSON file',
      required: true,
    },
    'dry-run': {
      type: 'boolean',
      description: 'Validate only, do not write to the database',
      required: false,
    },
  },
  async run({ args }) {
    const { applyWorkGraphScaffold } = await import('@cleocode/core/workgraph');
    const { cliOutput } = await import('../renderers/index.js');
    const filePath = resolve(String(args.file));
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch {
      cliOutput(
        { error: `Cannot read file: ${filePath}` },
        { command: 'workgraph', operation: 'apply' },
      );
      return;
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw);
    } catch {
      cliOutput(
        { error: `Invalid JSON in ${filePath}` },
        { command: 'workgraph', operation: 'apply' },
      );
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await applyWorkGraphScaffold({ ...payload, apply: !args['dry-run'] } as any);
    cliOutput(result, { command: 'workgraph', operation: 'apply' });
  },
});

const planCommand = defineCommand({
  meta: {
    name: 'plan',
    description: 'Generate a planning doc from a Saga WorkGraph',
  },
  args: {
    sagaId: {
      type: 'positional',
      description: 'Saga task ID to generate the plan for',
      required: true,
    },
    audience: {
      type: 'string',
      description: 'Audience: agent (compact) or maintainer (prose)',
      required: false,
      default: 'maintainer',
    },
  },
  async run({ args }) {
    const { generatePlanningDoc } = await import('@cleocode/core/workgraph');
    const { getProjectRoot } = await import('@cleocode/core');
    const { cliOutput } = await import('../renderers/index.js');
    const projectRoot = getProjectRoot();
    const audience = String(args.audience) === 'agent' ? 'agent' : 'maintainer';
    const result = await generatePlanningDoc(projectRoot, {
      sagaId: String(args.sagaId),
      audience: audience as 'agent' | 'maintainer',
    });
    cliOutput(result, { command: 'workgraph', operation: 'plan' });
  },
});

const structureCommand = defineCommand({
  meta: {
    name: 'structure',
    description: 'Validate WorkGraph structure (cycles, depth violations, orphans)',
  },
  async run() {
    const { validateWorkGraphStructure } = await import('@cleocode/core/workgraph');
    const { taskList } = await import('@cleocode/core/internal');
    const { getProjectRoot } = await import('@cleocode/core');
    const { cliOutput } = await import('../renderers/index.js');
    const projectRoot = getProjectRoot();
    const listResult = await taskList(projectRoot, { limit: 5000 });
    const tasks = listResult.success ? (listResult.data?.tasks ?? []) : [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nodes = (tasks as any[]).map((t: any) => ({
      id: String(t.id ?? ''),
      type: (t.type ?? 'task') as 'saga' | 'epic' | 'task' | 'subtask',
      parentId: (t.parentId as string | null) ?? null,
      phase: (t.phase as string | null) ?? null,
    }));
    const result = validateWorkGraphStructure(nodes, {});
    cliOutput(result, { command: 'workgraph', operation: 'structure' });
  },
});

/** Root workgraph command group. */
export const workgraphCommand = defineCommand({
  meta: {
    name: 'workgraph',
    description: 'PM-Core V2 WorkGraph operations — validate, apply, plan, structure',
  },
  subCommands: {
    validate: validateCommand,
    apply: applyCommand,
    plan: planCommand,
    structure: structureCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
