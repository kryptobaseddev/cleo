/**
 * Unit tests for canonicalProjectId and helpers (T9149 W5).
 *
 * @task T9149
 */

import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createOperationExecutionContext } from '../../store/background-ops.js';
import { canonicalProjectId, computeLegacyAliases, legacyProjectId } from '../identity.js';

describe('identity (T9149 W5)', () => {
  describe('legacyProjectId', () => {
    it('computes base64url(path).slice(0, 32)', () => {
      const p = '/mnt/projects/cleocode';
      const id = legacyProjectId(p);
      expect(id).toBe(Buffer.from(p).toString('base64url').slice(0, 32));
      expect(id.length).toBeLessThanOrEqual(32);
    });

    it('produces different IDs for different paths', () => {
      const id1 = legacyProjectId('/mnt/projects/cleocode');
      const id2 = legacyProjectId('/workspace/cleocode');
      expect(id1).not.toBe(id2);
    });
  });

  describe('computeLegacyAliases', () => {
    it('returns legacy ID for the given path', () => {
      const aliases = computeLegacyAliases('/mnt/projects/cleocode');
      expect(aliases).toContain(legacyProjectId('/mnt/projects/cleocode'));
    });

    it('includes additional path aliases', () => {
      const aliases = computeLegacyAliases('/mnt/projects/cleocode', ['/workspace/cleocode']);
      expect(aliases).toContain(legacyProjectId('/mnt/projects/cleocode'));
      expect(aliases).toContain(legacyProjectId('/workspace/cleocode'));
    });

    it('deduplicates identical paths', () => {
      const aliases = computeLegacyAliases('/mnt/projects/cleocode', ['/mnt/projects/cleocode']);
      const dupes = aliases.filter((a) => a === legacyProjectId('/mnt/projects/cleocode'));
      expect(dupes).toHaveLength(1);
    });
  });
});

describe('captured identity execution lifetime', () => {
  for (const mode of ['cancel', 'deadline', 'success', 'unavailable'] as const) {
    it(`settles actual Git children with ${mode} provenance`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'cleo-identity-lifetime-'));
      const bin = join(root, 'bin');
      mkdirSync(bin);
      mkdirSync(join(root, '.cleo'));
      writeFileSync(join(root, '.cleo', 'project-info.json'), JSON.stringify({ name: 'fixture' }));
      const pidPath = join(root, 'children.jsonl');
      const gitPath = join(bin, 'git');
      const originalPath = process.env['PATH'];
      const controller = new AbortController();
      const execution = createOperationExecutionContext(
        {
          projectId: 'fixture',
          projectRoot: root,
          actor: 'test',
          operation: 'identity',
          idempotencyKey: mode,
        },
        { budgetMs: mode === 'deadline' ? 500 : 2000, signal: controller.signal },
      );
      const script = `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(pidPath)}, String(process.pid) + ':' + process.argv[2] + String.fromCharCode(10));
${mode === 'cancel' || mode === 'deadline' ? 'setTimeout(() => { process.stdout.write(process.cwd()); }, 1200);' : mode === 'unavailable' ? 'process.exitCode = 128;' : "process.stdout.write(process.argv[2] === 'rev-parse' ? process.cwd() : 'https://example.test/fixture.git');"}
`;
      writeFileSync(gitPath, script);
      chmodSync(gitPath, 0o755);
      process.env['PATH'] = bin;
      const children = (): string[] => readFileSync(pidPath, 'utf8').trim().split('\n');
      try {
        const pending = canonicalProjectId(root, execution);
        // Observe rejection immediately while waiting for the actual child marker.
        const settled = pending.then(
          (value) => ({ status: 'fulfilled' as const, value }),
          (reason: Error) => ({ status: 'rejected' as const, reason }),
        );
        if (mode === 'cancel') {
          await vi.waitFor(() => expect(children()).toHaveLength(2), { timeout: 1000 });
          controller.abort(new Error('caller cancellation'));
        }
        const result = await settled;
        if (mode === 'cancel' || mode === 'deadline') {
          expect(result.status).toBe('rejected');
          if (result.status === 'rejected')
            expect(result.reason).toMatchObject({
              code: mode === 'cancel' ? 'E_OPERATION_CANCELLED' : 'E_OPERATION_DEADLINE',
            });
        } else {
          expect(result.status).toBe('fulfilled');
          if (result.status === 'fulfilled') {
            const remote = mode === 'success' ? 'https://example.test/fixture.git' : '';
            const expected = createHash('sha256')
              .update([root, 'fixture', remote].join('|'))
              .digest('hex')
              .slice(0, 12);
            expect(result.value.id).toBe(expected);
          }
        }
        const ownedChildren = children();
        expect(ownedChildren).toHaveLength(2);
        expect(ownedChildren.map((child) => child.split(':')[1]).sort()).toEqual([
          'remote',
          'rev-parse',
        ]);
        await vi.waitFor(
          () => {
            for (const child of ownedChildren)
              expect(() => process.kill(Number(child.split(':')[0]), 0)).toThrow();
          },
          { timeout: 1000 },
        );
      } finally {
        execution.close();
        if (originalPath === undefined) delete process.env['PATH'];
        else process.env['PATH'] = originalPath;
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
