/**
 * docs.update dispatch guard: `status` alone is a lifecycle-only change — T12654.
 *
 * The dispatch handler required exactly one of `file`/`content`, so even with
 * the CLI guard relaxed, `cleo docs update <spec> --status accepted` failed
 * with E_INVALID_INPUT. Every status the registry advertises for `--status`
 * (the enum `--help` renders) must pass the guard. With no such slug in the
 * sandbox store the call then fails E_NOT_FOUND — the store answering, which
 * proves the guard let it through.
 *
 * Kept out of the quarantined `docs.test.ts` so CI runs it.
 *
 * @task T12654
 */

import { DOCS_LIFECYCLE_STATUSES } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { OPERATIONS } from '../../registry.js';
import { DocsHandler } from '../docs.js';

const advertisedStatuses =
  OPERATIONS.find((op) => op.domain === 'docs' && op.operation === 'update')?.params?.find(
    (param) => param.name === 'status',
  )?.enum ?? [];

describe('docs.update — status alone (T12654)', () => {
  const handler = new DocsHandler();

  it('advertises every docs lifecycle status for --status', () => {
    expect([...advertisedStatuses]).toEqual([...DOCS_LIFECYCLE_STATUSES]);
  });

  it.each([
    ...advertisedStatuses,
  ])('passes the guard with status %s and no file or content', async (status) => {
    const result = await handler.mutate('update', { slug: 't12654-no-such-slug', status });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_NOT_FOUND');
  });

  it('still rejects no file, no content and no status', async () => {
    const result = await handler.mutate('update', { slug: 't12654-no-such-slug' });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_INVALID_INPUT');
    expect(result.error?.message).toMatch(/--status <status> alone/);
  });

  it('still rejects file and content together', async () => {
    const result = await handler.mutate('update', {
      slug: 't12654-no-such-slug',
      file: '/tmp/x.md',
      content: 'inline',
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_INVALID_INPUT');
    expect(result.error?.message).toMatch(/mutually exclusive/);
  });
});
