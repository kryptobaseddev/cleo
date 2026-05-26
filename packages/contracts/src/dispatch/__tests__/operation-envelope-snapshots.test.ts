import { describe, expect, it } from 'vitest';
import type { OperationDef } from '../operation-def.js';
import { OPERATIONS } from '../operations-registry.js';

function opId(op: OperationDef): string {
  return `${op.gateway}:${op.domain}:${op.operation}`;
}

function envelopeSnapshot(op: OperationDef | undefined) {
  expect(op).toBeDefined();
  return {
    gateway: op?.gateway,
    domain: op?.domain,
    operation: op?.operation,
    tier: op?.tier,
    idempotent: op?.idempotent,
    sessionRequired: op?.sessionRequired,
    requiredParams: op?.requiredParams ?? [],
    params: (op?.params ?? []).map((param) => ({
      name: param.name,
      type: param.type,
      required: param.required,
      cli: param.cli,
    })),
  };
}

function getOp(
  gateway: OperationDef['gateway'],
  domain: string,
  operation: string,
): OperationDef | undefined {
  return OPERATIONS.find(
    (op) => op.gateway === gateway && op.domain === domain && op.operation === operation,
  );
}

describe('operation envelope registry snapshots (T10615)', () => {
  it('keeps high-risk operation identities unique across gateway/domain/operation', () => {
    const criticalIds = [
      'query:tasks:show',
      'query:tasks:workgraph.audit',
      'mutate:tasks:saga.create',
      'mutate:docs:update',
    ];
    const seen = new Set(OPERATIONS.map(opId));

    expect([...seen].filter((id) => criticalIds.includes(id)).sort()).toEqual(
      [...criticalIds].sort(),
    );
  });

  it('keeps requiredParams aligned with declared params for high-risk envelopes', () => {
    const criticalOps = [
      getOp('query', 'tasks', 'show'),
      getOp('query', 'tasks', 'workgraph.audit'),
      getOp('mutate', 'tasks', 'saga.create'),
      getOp('mutate', 'docs', 'update'),
    ].filter((op): op is OperationDef => op !== undefined);

    const offenders = criticalOps.flatMap((op) => {
      const paramNames = new Set((op.params ?? []).map((param) => param.name));
      return (op.requiredParams ?? [])
        .filter((name) => !paramNames.has(name))
        .map((missing) => `${opId(op)} missing declared param ${missing}`);
    });

    expect(offenders).toEqual([]);
  });

  it('snapshots high-risk operation envelopes consumed by CLI/domain dispatch adapters', () => {
    const snapshots = {
      'query:tasks:show': envelopeSnapshot(getOp('query', 'tasks', 'show')),
      'query:tasks:workgraph.audit': envelopeSnapshot(getOp('query', 'tasks', 'workgraph.audit')),
      'mutate:tasks:saga.create': envelopeSnapshot(getOp('mutate', 'tasks', 'saga.create')),
      'mutate:docs:update': envelopeSnapshot(getOp('mutate', 'docs', 'update')),
    };

    expect(snapshots).toMatchInlineSnapshot(`
      {
        "mutate:docs:update": {
          "domain": "docs",
          "gateway": "mutate",
          "idempotent": false,
          "operation": "update",
          "params": [
            {
              "cli": {
                "positional": true,
              },
              "name": "slug",
              "required": true,
              "type": "string",
            },
            {
              "cli": undefined,
              "name": "file",
              "required": false,
              "type": "string",
            },
            {
              "cli": {
                "flag": "allow-external",
              },
              "name": "allowExternal",
              "required": false,
              "type": "boolean",
            },
            {
              "cli": undefined,
              "name": "content",
              "required": false,
              "type": "string",
            },
            {
              "cli": undefined,
              "name": "message",
              "required": false,
              "type": "string",
            },
            {
              "cli": undefined,
              "name": "status",
              "required": false,
              "type": "string",
            },
            {
              "cli": {
                "flag": "dry-run",
              },
              "name": "dryRun",
              "required": false,
              "type": "boolean",
            },
            {
              "cli": undefined,
              "name": "strict",
              "required": false,
              "type": "boolean",
            },
            {
              "cli": {
                "flag": "attached-by",
              },
              "name": "attachedBy",
              "required": false,
              "type": "string",
            },
          ],
          "requiredParams": [
            "slug",
          ],
          "sessionRequired": false,
          "tier": 1,
        },
        "mutate:tasks:saga.create": {
          "domain": "tasks",
          "gateway": "mutate",
          "idempotent": false,
          "operation": "saga.create",
          "params": [
            {
              "cli": {
                "flag": "title",
              },
              "name": "title",
              "required": true,
              "type": "string",
            },
            {
              "cli": {
                "flag": "description",
                "short": "-d",
              },
              "name": "description",
              "required": false,
              "type": "string",
            },
            {
              "cli": {
                "flag": "acceptance",
              },
              "name": "acceptance",
              "required": false,
              "type": "array",
            },
            {
              "cli": {
                "flag": "dry-run",
              },
              "name": "dryRun",
              "required": false,
              "type": "boolean",
            },
          ],
          "requiredParams": [
            "title",
          ],
          "sessionRequired": false,
          "tier": 0,
        },
        "query:tasks:show": {
          "domain": "tasks",
          "gateway": "query",
          "idempotent": true,
          "operation": "show",
          "params": [
            {
              "cli": {
                "positional": true,
              },
              "name": "taskId",
              "required": true,
              "type": "string",
            },
            {
              "cli": undefined,
              "name": "history",
              "required": false,
              "type": "boolean",
            },
            {
              "cli": undefined,
              "name": "ivtr-history",
              "required": false,
              "type": "boolean",
            },
          ],
          "requiredParams": [
            "taskId",
          ],
          "sessionRequired": false,
          "tier": 0,
        },
        "query:tasks:workgraph.audit": {
          "domain": "tasks",
          "gateway": "query",
          "idempotent": true,
          "operation": "workgraph.audit",
          "params": [
            {
              "cli": {
                "positional": true,
              },
              "name": "rootId",
              "required": true,
              "type": "string",
            },
            {
              "cli": undefined,
              "name": "maxDepth",
              "required": false,
              "type": "number",
            },
            {
              "cli": undefined,
              "name": "includeRelations",
              "required": false,
              "type": "boolean",
            },
            {
              "cli": undefined,
              "name": "cursor",
              "required": false,
              "type": "string",
            },
            {
              "cli": undefined,
              "name": "limit",
              "required": false,
              "type": "number",
            },
          ],
          "requiredParams": [
            "rootId",
          ],
          "sessionRequired": false,
          "tier": 1,
        },
      }
    `);
  });
});
