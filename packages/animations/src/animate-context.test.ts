import { describe, expect, it } from 'vitest';
import { createAnimateContext, SILENT_CONTEXT } from './animate-context.js';

describe('createAnimateContext', () => {
  it('enables rendering when format=human, not quiet, isTTY=true, no NO_COLOR', () => {
    const ctx = createAnimateContext({
      flagResolution: { format: 'human', quiet: false },
      isTTY: true,
      noColor: false,
    });
    expect(ctx.enabled).toBe(true);
    expect(ctx.reason).toBe('enabled');
  });

  it('disables rendering when format=json (LAFS default for machine output)', () => {
    const ctx = createAnimateContext({
      flagResolution: { format: 'json', quiet: false },
      isTTY: true,
      noColor: false,
    });
    expect(ctx.enabled).toBe(false);
    expect(ctx.reason).toBe('format-json');
  });

  it('disables rendering when --quiet is set', () => {
    const ctx = createAnimateContext({
      flagResolution: { format: 'human', quiet: true },
      isTTY: true,
      noColor: false,
    });
    expect(ctx.enabled).toBe(false);
    expect(ctx.reason).toBe('quiet');
  });

  it('disables rendering when stdout is not a TTY (piped)', () => {
    const ctx = createAnimateContext({
      flagResolution: { format: 'human', quiet: false },
      isTTY: false,
      noColor: false,
    });
    expect(ctx.enabled).toBe(false);
    expect(ctx.reason).toBe('no-tty');
  });

  it('disables rendering when NO_COLOR is in effect', () => {
    const ctx = createAnimateContext({
      flagResolution: { format: 'human', quiet: false },
      isTTY: true,
      noColor: true,
    });
    expect(ctx.enabled).toBe(false);
    expect(ctx.reason).toBe('no-color');
  });

  it('precedence: format-json beats quiet beats no-tty beats no-color', () => {
    const ctx = createAnimateContext({
      flagResolution: { format: 'json', quiet: true },
      isTTY: false,
      noColor: true,
    });
    expect(ctx.reason).toBe('format-json');
  });

  it('echoes resolved inputs into context.inputs', () => {
    const ctx = createAnimateContext({
      flagResolution: { format: 'human', quiet: false },
      isTTY: true,
      noColor: false,
    });
    expect(ctx.inputs).toEqual({
      format: 'human',
      quiet: false,
      isTTY: true,
      noColor: false,
    });
  });
});

describe('SILENT_CONTEXT', () => {
  it('is permanently disabled', () => {
    expect(SILENT_CONTEXT.enabled).toBe(false);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(SILENT_CONTEXT)).toBe(true);
    expect(Object.isFrozen(SILENT_CONTEXT.inputs)).toBe(true);
  });
});
