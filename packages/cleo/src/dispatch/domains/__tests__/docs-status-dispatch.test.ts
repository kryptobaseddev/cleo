/**
 * Verify the advertised status command reaches its existing read model through dispatch.
 * Code placed in `packages/cleo/` per Package-Boundary Check — verified against AGENTS.md.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { OPERATIONS } from '@cleocode/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { status, publish, publishPr, exportDoc, auditRead, auditVerify } = vi.hoisted(() => ({
  status: vi.fn(),
  publish: vi.fn(),
  publishPr: vi.fn(),
  exportDoc: vi.fn(),
  auditRead: vi.fn(),
  auditVerify: vi.fn(),
}));
vi.mock('@cleocode/core/internal', () => ({
  getProjectRoot: () => '/fixture/docs-status',
  createDocsReadModel: () => ({ status }),
  publishDocs: publish,
  publishDocsAsPr: publishPr,
  exportDocument: exportDoc,
  readAuditLog: auditRead,
  verifyAuditTrail: auditVerify,
  recordPublication: vi.fn(),
  writeAuditEntry: vi.fn(),
}));

import { Dispatcher } from '../../dispatcher.js';
import { DocsHandler } from '../docs.js';

beforeEach(() => {
  vi.clearAllMocks();
  status.mockReset();
});

describe('docs.status runtime dispatch', () => {
  it('routes the registered query to the existing drift read model', async () => {
    status.mockResolvedValue({ allInSync: false, items: [] });
    const dispatcher = new Dispatcher({ handlers: new Map([['docs', new DocsHandler()]]) });
    const response = await dispatcher.dispatch({
      gateway: 'query',
      domain: 'docs',
      operation: 'status',
      params: {},
    });
    expect(response.success).toBe(true);
    expect(response.data).toEqual({ allInSync: false, items: [] });
    expect(status).toHaveBeenCalledExactlyOnceWith('/fixture/docs-status');
  });

  it('preserves read-model failures instead of reporting clean documentation', async () => {
    status.mockRejectedValue(new Error('fixture publication ledger unavailable'));
    const dispatcher = new Dispatcher({ handlers: new Map([['docs', new DocsHandler()]]) });
    const response = await dispatcher.dispatch({
      gateway: 'query',
      domain: 'docs',
      operation: 'status',
      params: {},
    });
    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('E_INTERNAL');
    expect(response.error?.message).toContain('fixture publication ledger unavailable');
  });
});

describe('docs advertised dispatch parity', () => {
  it('registers every implemented handler operation with its gateway, and every registry operation is supported', () => {
    const supported = new DocsHandler().getSupportedOperations();
    const registered = OPERATIONS.filter((op) => op.domain === 'docs');
    for (const gateway of ['query', 'mutate'] as const) {
      expect(
        registered
          .filter((op) => op.gateway === gateway)
          .map((op) => op.operation)
          .sort(),
      ).toEqual([...supported[gateway]].sort());
    }
  });

  it('all literal docs CLI dispatch calls resolve through the advertised handler surface', () => {
    const commandRoot = new URL('../../../cli/commands/', import.meta.url);
    const files = [
      'docs.ts',
      ...readdirSync(new URL('docs/', commandRoot), { recursive: true })
        .map(String)
        .filter((name) => name.endsWith('.ts'))
        .map((name) => `docs/${name}`),
    ];
    const source = files.map((file) => readFileSync(new URL(file, commandRoot), 'utf8')).join('\n');
    const calls = [
      ...source.matchAll(/dispatchDocsRaw\('(query|mutate)', '([^']+)'/g),
      ...source.matchAll(/dispatchFromCli\(\s*'(query|mutate)',\s*'docs',\s*'([^']+)'/g),
    ];
    expect(calls.length).toBeGreaterThan(10);
    const supported = new DocsHandler().getSupportedOperations();
    for (const [, gateway, operation] of calls) {
      expect(
        OPERATIONS.some(
          (op) => op.domain === 'docs' && op.gateway === gateway && op.operation === operation,
        ),
      ).toBe(true);
      expect(gateway === 'query' ? supported.query : supported.mutate).toContain(operation);
    }
  });

  it('reaches file publication through the registry and records the returned publication', async () => {
    const publication = {
      ownerId: 'T123',
      blobName: 'repair-plan',
      relativePath: 'docs/repair.md',
      blobSha256: 'abc',
    };
    publish.mockResolvedValue(publication);
    const response = await new Dispatcher({
      handlers: new Map([['docs', new DocsHandler()]]),
    }).dispatch({
      gateway: 'mutate',
      domain: 'docs',
      operation: 'publish',
      params: { ownerId: 'T123', toPath: 'docs/repair.md', target: 'file' },
    });
    expect(response.success).toBe(true);
    expect(response.data).toEqual(publication);
    expect(publish).toHaveBeenCalledExactlyOnceWith({
      ownerId: 'T123',
      toPath: 'docs/repair.md',
      projectRoot: '/fixture/docs-status',
      attachmentId: undefined,
    });
    expect(publishPr).not.toHaveBeenCalled();
  });

  it('consolidated PR publication reaches the PR service without attempting file publication', async () => {
    publishPr.mockResolvedValue({ success: false, error: { message: 'fixture missing doc' } });
    const response = await new Dispatcher({
      handlers: new Map([['docs', new DocsHandler()]]),
    }).dispatch({
      gateway: 'mutate',
      domain: 'docs',
      operation: 'publish',
      params: { slugOrId: 'repair-plan', target: 'pr' },
    });
    expect(response.success).toBe(true);
    expect(response.data).toMatchObject({
      success: false,
      error: { message: 'fixture missing doc' },
    });
    expect(publishPr).toHaveBeenCalledExactlyOnceWith({ slugOrId: 'repair-plan' });
    expect(publish).not.toHaveBeenCalled();
  });

  it('advertised document audit reaches the existing integrity and history services', async () => {
    auditVerify.mockReturnValue({ valid: true, entriesChecked: 3 });
    auditRead.mockReturnValue({ entries: [{ slug: 'repair-plan' }] });
    const dispatcher = new Dispatcher({ handlers: new Map([['docs', new DocsHandler()]]) });
    const verified = await dispatcher.dispatch({
      gateway: 'query',
      domain: 'docs',
      operation: 'audit',
      params: { verify: true },
    });
    expect(verified.success).toBe(true);
    expect(verified.data).toEqual({ valid: true, entriesChecked: 3 });
    expect(auditVerify).toHaveBeenCalledExactlyOnceWith('/fixture/docs-status');
    const history = await dispatcher.dispatch({
      gateway: 'query',
      domain: 'docs',
      operation: 'audit',
      params: { slug: 'repair-plan' },
    });
    expect(history.success).toBe(true);
    expect(auditRead).toHaveBeenCalledExactlyOnceWith('/fixture/docs-status', 'repair-plan');
  });

  it('registered llm-output reaches its typed task exporter', async () => {
    exportDoc.mockResolvedValue({ markdown: '# Task', task: { id: 'T123' } });
    const response = await new Dispatcher({
      handlers: new Map([['docs', new DocsHandler()]]),
    }).dispatch({
      gateway: 'query',
      domain: 'docs',
      operation: 'llm-output',
      params: { for: 'T123', mode: 'task-export' },
    });
    expect(response.success).toBe(true);
    expect(exportDoc).toHaveBeenCalledOnce();
  });
});
