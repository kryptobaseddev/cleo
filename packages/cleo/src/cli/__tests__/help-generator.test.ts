/**
 * Tests for the ParamDef-driven help generator.
 *
 * Covers:
 *  - buildOperationHelp: enum values, required indicators, Preconditions section
 *  - applyParamDefsToCommand: positional args, short flags, generated options
 *  - Snapshot tests for tasks.add and tasks.complete to catch future drift
 *
 * @task T339
 * @epic T335
 */

import { describe, expect, it } from 'vitest';
import type { ParamDef } from '../../dispatch/types.js';
import { ShimCommand } from '../commander-shim.js';
import { applyParamDefsToCommand, buildOperationHelp } from '../help-generator.js';

// ---------------------------------------------------------------------------
// Minimal ParamDef fixtures
// ---------------------------------------------------------------------------

const TASKS_ADD_PARAMS: readonly ParamDef[] = [
  {
    name: 'title',
    type: 'string',
    required: true,
    description: 'Task title (3–500 characters)',
    cli: { positional: true },
  },
  {
    name: 'priority',
    type: 'string',
    required: false,
    description: 'Task priority',
    enum: ['low', 'medium', 'high', 'critical'] as const,
    cli: { short: '-p', flag: 'priority' },
  },
  {
    name: 'type',
    type: 'string',
    required: false,
    description: 'Task type',
    enum: ['epic', 'task', 'subtask', 'bug'] as const,
    cli: { short: '-t', flag: 'type' },
  },
  {
    name: 'description',
    type: 'string',
    required: false,
    description: 'Detailed task description (must differ meaningfully from title)',
    cli: { short: '-d', flag: 'description' },
  },
];

const TASKS_COMPLETE_PARAMS: readonly ParamDef[] = [
  {
    name: 'taskId',
    type: 'string',
    required: true,
    description: 'ID of the task to complete',
    cli: { positional: true },
  },
  {
    name: 'force',
    type: 'boolean',
    required: false,
    description: 'Force completion even when children are not done or dependencies unresolved',
    cli: { flag: 'force' },
  },
  {
    name: 'verificationNote',
    type: 'string',
    required: false,
    description: 'Evidence that acceptance criteria were met',
    cli: { flag: 'verification-note' },
  },
];

// ---------------------------------------------------------------------------
// buildOperationHelp — content verification
// ---------------------------------------------------------------------------

describe('buildOperationHelp', () => {
  it('includes enum values for the priority param in tasks.add help', () => {
    const help = buildOperationHelp('tasks.add', 'Create a new task', TASKS_ADD_PARAMS);
    expect(help).toContain('low|medium|high|critical');
  });

  it('includes enum values for the type param in tasks.add help', () => {
    const help = buildOperationHelp('tasks.add', 'Create a new task', TASKS_ADD_PARAMS);
    expect(help).toContain('epic|task|subtask|bug');
  });

  it('marks the title positional arg as (required) in ARGUMENTS section', () => {
    const help = buildOperationHelp('tasks.add', 'Create a new task', TASKS_ADD_PARAMS);
    expect(help).toContain('ARGUMENTS:');
    expect(help).toContain('(required)');
  });

  it('includes the anti-hallucination gate in the Preconditions section for tasks.add', () => {
    const help = buildOperationHelp('tasks.add', 'Create a new task', TASKS_ADD_PARAMS);
    expect(help).toContain('PRECONDITIONS');
    expect(help).toContain('anti-hallucination');
  });

  it('includes the acceptance-criteria gate in the Preconditions section for tasks.add', () => {
    const help = buildOperationHelp('tasks.add', 'Create a new task', TASKS_ADD_PARAMS);
    expect(help).toContain('acceptance-criteria-format');
  });

  it('includes the dependency gate in the Preconditions section for tasks.complete', () => {
    const help = buildOperationHelp(
      'tasks.complete',
      'Mark a task as completed',
      TASKS_COMPLETE_PARAMS,
    );
    expect(help).toContain('PRECONDITIONS');
    expect(help).toContain('dependency-check');
  });

  it('includes the children-completion gate for tasks.complete', () => {
    const help = buildOperationHelp(
      'tasks.complete',
      'Mark a task as completed',
      TASKS_COMPLETE_PARAMS,
    );
    expect(help).toContain('children-completion');
  });

  it('includes the verification-required gate for tasks.complete', () => {
    const help = buildOperationHelp(
      'tasks.complete',
      'Mark a task as completed',
      TASKS_COMPLETE_PARAMS,
    );
    expect(help).toContain('verification-required');
  });

  it('uses <required> and [optional] brackets in the USAGE line', () => {
    const help = buildOperationHelp('tasks.add', 'Create a new task', TASKS_ADD_PARAMS);
    expect(help).toContain('<title>');
    expect(help).not.toContain('[title]');
  });

  it('emits an empty Preconditions section for operations without gate data', () => {
    const help = buildOperationHelp('tasks.list', 'List tasks', []);
    expect(help).not.toContain('PRECONDITIONS');
  });

  it('includes the description prefix', () => {
    const help = buildOperationHelp('tasks.add', 'Create a new task', TASKS_ADD_PARAMS);
    expect(help).toContain('Description: Create a new task');
  });

  it('includes a USAGE line with the CLI operation name', () => {
    const help = buildOperationHelp('tasks.add', 'Create a new task', TASKS_ADD_PARAMS);
    expect(help).toContain('USAGE: cleo add');
  });

  it('includes Examples section for tasks.add', () => {
    const help = buildOperationHelp('tasks.add', 'Create a new task', TASKS_ADD_PARAMS);
    expect(help).toContain('Examples:');
  });

  it('skips hidden params', () => {
    const paramsWithHidden: readonly ParamDef[] = [
      ...TASKS_ADD_PARAMS,
      {
        name: 'internalOnly',
        type: 'string',
        required: false,
        description: 'Should not appear',
        hidden: true,
      },
    ];
    const help = buildOperationHelp('tasks.add', 'Create a new task', paramsWithHidden);
    expect(help).not.toContain('internalOnly');
    expect(help).not.toContain('Should not appear');
  });
});

// ---------------------------------------------------------------------------
// applyParamDefsToCommand — Commander integration
// ---------------------------------------------------------------------------

describe('applyParamDefsToCommand', () => {
  it('registers a required positional argument for params with cli.positional === true', () => {
    const program = new ShimCommand();
    const cmd = program.command('add');
    applyParamDefsToCommand(cmd, TASKS_ADD_PARAMS, 'tasks.add');

    const arg = cmd.registeredArguments.find((a) => a.name === 'title');
    expect(arg).toBeDefined();
    expect(arg!.required).toBe(true);
  });

  it('registers -p, --priority shorthand from cli.short', () => {
    const program = new ShimCommand();
    const cmd = program.command('add');
    applyParamDefsToCommand(cmd, TASKS_ADD_PARAMS, 'tasks.add');

    const opt = cmd.options.find((o) => o.long === '--priority');
    expect(opt).toBeDefined();
  });

  it('surfaces enum values in the option description', () => {
    const program = new ShimCommand();
    const cmd = program.command('add');
    applyParamDefsToCommand(cmd, TASKS_ADD_PARAMS, 'tasks.add');

    // Inspect internal _options for description text (ShimOption not in options getter)
    const shimOpt = (
      cmd as unknown as { _options: Array<{ longName: string; description: string }> }
    )._options.find((o) => o.longName === 'priority');
    expect(shimOpt).toBeDefined();
    expect(shimOpt!.description).toContain('low|medium|high|critical');
  });

  it('registers a boolean flag with no value placeholder', () => {
    const program = new ShimCommand();
    const cmd = program.command('complete');
    applyParamDefsToCommand(cmd, TASKS_COMPLETE_PARAMS, 'tasks.complete');

    const shimOpt = (
      cmd as unknown as { _options: Array<{ longName: string; takesValue: boolean }> }
    )._options.find((o) => o.longName === 'force');
    expect(shimOpt).toBeDefined();
    expect(shimOpt!.takesValue).toBe(false);
  });

  it('skips hidden params when registering options', () => {
    const paramsWithHidden: readonly ParamDef[] = [
      {
        name: 'secret',
        type: 'string',
        required: false,
        description: 'Should be hidden',
        hidden: true,
        cli: { flag: 'secret' },
      },
    ];
    const program = new ShimCommand();
    const cmd = program.command('test');
    applyParamDefsToCommand(cmd, paramsWithHidden, 'tasks.test');

    const shimOpt = (cmd as unknown as { _options: Array<{ longName: string }> })._options.find(
      (o) => o.longName === 'secret',
    );
    expect(shimOpt).toBeUndefined();
  });

  it('registers an optional positional arg with required === false', () => {
    const optionalParam: readonly ParamDef[] = [
      {
        name: 'query',
        type: 'string',
        required: false,
        description: 'Search query',
        cli: { positional: true },
      },
    ];
    const program = new ShimCommand();
    const cmd = program.command('find');
    applyParamDefsToCommand(cmd, optionalParam, 'tasks.find');

    const arg = cmd.registeredArguments.find((a) => a.name === 'query');
    expect(arg).toBeDefined();
    expect(arg!.required).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Snapshot tests — catch future drift in help output
// ---------------------------------------------------------------------------

describe('buildOperationHelp snapshots', () => {
  it('matches snapshot for tasks.add', () => {
    const help = buildOperationHelp('tasks.add', 'Create a new task', TASKS_ADD_PARAMS);
    expect(help).toMatchSnapshot();
  });

  it('matches snapshot for tasks.complete', () => {
    const help = buildOperationHelp(
      'tasks.complete',
      'Mark a task as completed',
      TASKS_COMPLETE_PARAMS,
    );
    expect(help).toMatchSnapshot();
  });
});
