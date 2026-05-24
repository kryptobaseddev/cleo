/**
 * Tests that `cleo update --help` documents the dual-axis urgency surface
 * side-by-side (T9905).
 *
 * Tasks carry TWO orthogonal urgency axes — `--priority` and `--severity` —
 * and operators repeatedly conflate them. The help text for each flag must
 * cross-reference the other so the side-by-side relationship is obvious from
 * the help output alone.
 *
 * @task T9905
 */

import { describe, expect, it } from 'vitest';
import { updateCommand } from '../update.js';

describe('cleo update --help dual-axis documentation (T9905)', () => {
  const args = updateCommand.args as Record<string, { description?: string }>;

  it('--priority description references the severity axis', () => {
    const desc = args['priority']!.description ?? '';
    expect(desc).toMatch(/severity/i);
  });

  it('--severity description references the priority axis', () => {
    const desc = args['severity']!.description ?? '';
    expect(desc).toMatch(/priority/i);
  });

  it('--severity description still names the canonical enum values', () => {
    const desc = args['severity']!.description ?? '';
    expect(desc).toMatch(/P0/);
    expect(desc).toMatch(/P1/);
    expect(desc).toMatch(/P2/);
    expect(desc).toMatch(/P3/);
  });

  it('--priority description still names the canonical enum values', () => {
    const desc = args['priority']!.description ?? '';
    expect(desc).toMatch(/critical/);
    expect(desc).toMatch(/high/);
    expect(desc).toMatch(/medium/);
    expect(desc).toMatch(/low/);
  });
});
