/**
 * T13834 / T13847: session end's post-end memory steps run inside a
 * best-effort try, so a bad import specifier would skip them silently. Pin
 * that every specifier the session domain uses for them resolves and exports
 * the helper it calls.
 *
 * @task T13847
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(join(__dirname, '..', 'session.ts'), 'utf8');

/** Each `const { name } = await import('specifier')` in the session domain. */
function dynamicImports(name: string): string[] {
  const re = new RegExp(`const \\{ ${name} \\} = await import\\(\\s*'([^']+)'`, 'g');
  return [...SOURCE.matchAll(re)].map((m) => m[1] as string);
}

describe('session end memory helpers (T13847)', () => {
  it.each([
    'persistSessionMemory',
    'refreshMemoryBridge',
  ])('%s is imported from a module that resolves and exports it, not the CORE barrel', async (name) => {
    const specifiers = dynamicImports(name);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier).not.toBe('@cleocode/core/internal');
      const mod = (await import(specifier)) as Record<string, unknown>;
      expect(typeof mod[name], `${specifier} exports ${name}`).toBe('function');
    }
  });
});
