/**
 * Regression tests: CleoError fix hints on task-layer throws.
 *
 * Each test invokes a core function with invalid input and asserts that
 * the thrown CleoError carries:
 *   - options.fix   — a non-empty string with a concrete recovery action
 *   - options.details.field — the specific field that failed
 *
 * @task T341
 * @epic T335
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CleoError } from '../../errors.js';
import { createTestDb, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { resetDbState } from '../../store/sqlite.js';
import {
  addTask,
  validateDepends,
  validateLabels,
  validatePhaseFormat,
  validateSize,
  validateStatus,
  validateTaskType,
  validateTitle,
} from '../add.js';
import { findTasks } from '../find.js';
import { showLabelTasks } from '../labels.js';
import { showTask } from '../show.js';

// ---------------------------------------------------------------------------
// Helper: assert a CleoError has fix + details
// ---------------------------------------------------------------------------

function assertErrorHints(
  fn: () => unknown,
  opts: { fixIncludes?: string; detailsField?: string },
): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(CleoError);
  const e = caught as CleoError;
  expect(e.fix).toBeTruthy();
  if (opts.fixIncludes) {
    expect(e.fix).toContain(opts.fixIncludes);
  }
  if (opts.detailsField) {
    expect(e.details).toBeDefined();
    expect(e.details!.field).toBe(opts.detailsField);
  }
}

async function assertAsyncErrorHints(
  fn: () => Promise<unknown>,
  opts: { fixIncludes?: string; detailsField?: string },
): Promise<void> {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(CleoError);
  const e = caught as CleoError;
  expect(e.fix).toBeTruthy();
  if (opts.fixIncludes) {
    expect(e.fix).toContain(opts.fixIncludes);
  }
  if (opts.detailsField) {
    expect(e.details).toBeDefined();
    expect(e.details!.field).toBe(opts.detailsField);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('error-hints: validateTitle', () => {
  it('empty title — fix mentions cleo add, field=title', () => {
    assertErrorHints(() => validateTitle(''), {
      fixIncludes: 'cleo add',
      detailsField: 'title',
    });
  });

  it('whitespace-only title — fix mentions cleo add, field=title', () => {
    assertErrorHints(() => validateTitle('   '), {
      fixIncludes: 'cleo add',
      detailsField: 'title',
    });
  });

  it('title too long — fix mentions 200, field=title, details has expected/actual', () => {
    let caught: unknown;
    try {
      validateTitle('a'.repeat(201));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CleoError);
    const e = caught as CleoError;
    expect(e.fix).toContain('200');
    expect(e.details).toBeDefined();
    expect(e.details!.field).toBe('title');
    expect(e.details!.expected).toBe(200);
    expect(e.details!.actual).toBe(201);
  });
});

describe('error-hints: validateStatus', () => {
  it('invalid status — fix mentions --status, field=status', () => {
    assertErrorHints(() => validateStatus('broken'), {
      fixIncludes: '--status',
      detailsField: 'status',
    });
  });
});

describe('error-hints: validateSize', () => {
  it('invalid size — fix mentions --size, field=size', () => {
    assertErrorHints(() => validateSize('giant'), {
      fixIncludes: '--size',
      detailsField: 'size',
    });
  });
});

describe('error-hints: validateTaskType', () => {
  it('invalid type — fix mentions --type, field=type', () => {
    assertErrorHints(() => validateTaskType('mega-task'), {
      fixIncludes: '--type',
      detailsField: 'type',
    });
  });
});

describe('error-hints: validateLabels', () => {
  it('invalid label — fix mentions pattern, field=labels', () => {
    assertErrorHints(() => validateLabels(['UPPERCASE']), {
      fixIncludes: '^[a-z]',
      detailsField: 'labels',
    });
  });
});

describe('error-hints: validatePhaseFormat', () => {
  it('invalid phase — fix mentions pattern, field=phase', () => {
    assertErrorHints(() => validatePhaseFormat('UPPER_CASE'), {
      fixIncludes: '^[a-z]',
      detailsField: 'phase',
    });
  });
});

describe('error-hints: validateDepends (sync helper)', () => {
  it('invalid dep ID format — fix mentions T### format, field=depends', () => {
    assertErrorHints(() => validateDepends(['invalid'], []), {
      fixIncludes: 'T###',
      detailsField: 'depends',
    });
  });

  it('dep not found — fix mentions cleo find, field=depends', () => {
    assertErrorHints(() => validateDepends(['T999'], []), {
      fixIncludes: 'find',
      detailsField: 'depends',
    });
  });
});

// ---------------------------------------------------------------------------
// Anti-hallucination throw (add.ts line ~436)
// ---------------------------------------------------------------------------

describe('error-hints: anti-hallucination (title === description)', () => {
  let env: TestDbEnv;

  beforeEach(async () => {
    resetDbState();
    env = await createTestDb();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('throws with fix mentioning --desc, field=description', async () => {
    await assertAsyncErrorHints(
      () =>
        addTask(
          {
            title: 'same text',
            description: 'same text',
          },
          env.tempDir,
          env.accessor,
        ),
      { fixIncludes: '--desc', detailsField: 'description' },
    );
  });
});

// ---------------------------------------------------------------------------
// findTasks — query required
// ---------------------------------------------------------------------------

describe('error-hints: findTasks (query required)', () => {
  it('missing query — fix mentions cleo find, field=query', async () => {
    await assertAsyncErrorHints(() => findTasks({}), {
      fixIncludes: 'cleo find',
      detailsField: 'query',
    });
  });
});

// ---------------------------------------------------------------------------
// showTask — task ID required
// ---------------------------------------------------------------------------

describe('error-hints: showTask (id required)', () => {
  it('empty id — fix mentions cleo show, field=taskId', async () => {
    await assertAsyncErrorHints(() => showTask(''), {
      fixIncludes: 'cleo show',
      detailsField: 'taskId',
    });
  });
});

// ---------------------------------------------------------------------------
// showLabelTasks — no tasks with label
// ---------------------------------------------------------------------------

describe('error-hints: showLabelTasks (label not found)', () => {
  let env: TestDbEnv;

  beforeEach(async () => {
    resetDbState();
    env = await createTestDb();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('no tasks with label — fix mentions cleo labels, field=label', async () => {
    await assertAsyncErrorHints(
      () => showLabelTasks('nonexistent-label', env.tempDir, env.accessor),
      { fixIncludes: 'cleo labels', detailsField: 'label' },
    );
  });
});
