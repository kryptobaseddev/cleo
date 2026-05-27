/**
 * Tests for HTTP contract extraction.
 *
 * @task T1065
 */

import type { HttpContract } from '@cleocode/contracts/nexus-contract-ops.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as nexusSchema from '../../store/nexus-schema.js';
import { getNexusDb, resetNexusDbState } from '../../store/nexus-sqlite.js';
import { extractHttpContracts } from './http-extractor.js';

describe('HTTP Contract Extractor', () => {
  beforeEach(async () => {
    resetNexusDbState();
  });

  afterEach(async () => {
    resetNexusDbState();
  });

  it('should extract HTTP contracts from route nodes', async () => {
    const testProjectId = `test-project-http-${Date.now()}-1`;
    const db = await getNexusDb();

    // Insert a test project
    db.insert(nexusSchema.projectRegistry)
      .values({
        projectId: testProjectId,
        projectHash: `test-hash-${Date.now()}-1`,
        projectPath: `/test/project-${Date.now()}-1`,
        name: 'Test Project 1',
        permissions: 'read',
      })
      .run();

    // Insert a route node with HTTP metadata
    const routeNodeId = `${testProjectId}::GET::/api/v1/tasks`;
    db.insert(nexusSchema.nexusNodes)
      .values({
        id: routeNodeId,
        projectId: testProjectId,
        kind: 'route',
        label: 'GET /api/v1/tasks',
        filePath: 'src/api/routes.ts',
        language: 'typescript',
        isExported: true,
        metaJson: JSON.stringify({
          method: 'GET',
          path: '/api/v1/tasks',
          requestSchema: {},
          responseSchema: { id: 'string', title: 'string' },
        }),
      })
      .run();

    // Extract contracts
    const contracts = await extractHttpContracts(testProjectId, `/test/project-${Date.now()}-1`);

    // Verify
    expect(contracts).toHaveLength(1);
    const contract = contracts[0] as HttpContract;
    expect(contract.type).toBe('http');
    expect(contract.method).toBe('GET');
    expect(contract.path).toBe('/api/v1/tasks');
    expect(contract.projectId).toBe(testProjectId);
    expect(contract.confidence).toBeGreaterThan(0.9);
  });

  it('should skip routes without a path', async () => {
    const testProjectId = `test-project-http-${Date.now()}-2`;
    const db = await getNexusDb();

    // Insert a test project
    db.insert(nexusSchema.projectRegistry)
      .values({
        projectId: testProjectId,
        projectHash: `test-hash-${Date.now()}-2`,
        projectPath: `/test/project-${Date.now()}-2`,
        name: 'Test Project 2',
        permissions: 'read',
      })
      .run();

    // Insert a route node without a path (malformed)
    const routeNodeId = `${testProjectId}::malformed`;
    db.insert(nexusSchema.nexusNodes)
      .values({
        id: routeNodeId,
        projectId: testProjectId,
        kind: 'route',
        label: 'Malformed Route',
        filePath: 'src/api/routes.ts',
        language: 'typescript',
        metaJson: JSON.stringify({
          method: 'GET',
          // path missing
        }),
      })
      .run();

    // Extract contracts
    const contracts = await extractHttpContracts(testProjectId, `/test/project-${Date.now()}-2`);

    // Should be empty (malformed route skipped)
    expect(contracts).toHaveLength(0);
  });

  it('should extract multiple HTTP contracts from same project', async () => {
    const testProjectId = `test-project-http-${Date.now()}-3`;
    const db = await getNexusDb();

    // Insert a test project
    db.insert(nexusSchema.projectRegistry)
      .values({
        projectId: testProjectId,
        projectHash: `test-hash-${Date.now()}-3`,
        projectPath: `/test/project-${Date.now()}-3`,
        name: 'Test Project 3',
        permissions: 'read',
      })
      .run();

    // Insert multiple route nodes
    const routes = [
      { method: 'GET', path: '/api/v1/tasks' },
      { method: 'POST', path: '/api/v1/tasks' },
      { method: 'GET', path: '/api/v1/tasks/:id' },
    ];

    for (let i = 0; i < routes.length; i++) {
      const route = routes[i];
      const routeNodeId = `${testProjectId}::${route.method}::${route.path}`;
      db.insert(nexusSchema.nexusNodes)
        .values({
          id: routeNodeId,
          projectId: testProjectId,
          kind: 'route',
          label: `${route.method} ${route.path}`,
          filePath: 'src/api/routes.ts',
          language: 'typescript',
          metaJson: JSON.stringify({
            method: route.method,
            path: route.path,
            responseSchema: {},
          }),
        })
        .run();
    }

    // Extract contracts
    const contracts = await extractHttpContracts(testProjectId, `/test/project-${Date.now()}-3`);

    // Verify
    expect(contracts).toHaveLength(3);
    expect(contracts[0].path).toBe('/api/v1/tasks');
    expect(contracts[1].method).toBe('POST');
    expect(contracts[2].path).toBe('/api/v1/tasks/:id');
  });
});
