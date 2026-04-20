/**
 * Tests for contract matching engine.
 *
 * @task T1065
 */

import type { Contract, HttpContract } from '@cleocode/contracts/nexus-contract-ops.js';
import { describe, expect, it } from 'vitest';
import { matchContracts } from './matcher.js';

describe('Contract Matcher', () => {
  describe('HTTP contract matching', () => {
    it('should match exact HTTP contracts (path + method)', () => {
      const contractA: HttpContract = {
        id: 'http:projectA::/api/tasks::GET',
        projectId: 'projectA',
        type: 'http',
        method: 'GET',
        path: '/api/tasks',
        requestSchemaJson: '{}',
        responseSchemaJson: '{"id":"string","title":"string"}',
        sourceSymbolId: 'src/api/routes.ts::listTasks',
        confidence: 0.95,
      };

      const contractB: HttpContract = {
        id: 'http:projectB::/api/tasks::GET',
        projectId: 'projectB',
        type: 'http',
        method: 'GET',
        path: '/api/tasks',
        requestSchemaJson: '{}',
        responseSchemaJson: '{"id":"string","title":"string"}',
        sourceSymbolId: 'src/routes/tasks.ts::getTasks',
        confidence: 0.95,
      };

      const matches = matchContracts([contractA], [contractB]);

      expect(matches).toHaveLength(1);
      expect(matches[0].level).toBe('exact');
      expect(matches[0].score).toBe(1.0);
      expect(matches[0].compatibility).toBe('compatible');
    });

    it('should match contracts with different path prefixes but same method and final segment', () => {
      const contractA: HttpContract = {
        id: 'http:projectA::/api/v1/tasks::POST',
        projectId: 'projectA',
        type: 'http',
        method: 'POST',
        path: '/api/v1/tasks',
        requestSchemaJson: '{}',
        responseSchemaJson: '{}',
        sourceSymbolId: 'src/api.ts::createTask',
        confidence: 0.95,
      };

      const contractB: HttpContract = {
        id: 'http:projectB::/tasks::POST',
        projectId: 'projectB',
        type: 'http',
        method: 'POST',
        path: '/tasks',
        requestSchemaJson: '{}',
        responseSchemaJson: '{}',
        sourceSymbolId: 'src/routes.ts::create',
        confidence: 0.95,
      };

      const matches = matchContracts([contractA], [contractB]);

      expect(matches).toHaveLength(1);
      expect(matches[0].level).toBe('name');
      expect(matches[0].score).toBeGreaterThan(0.8);
    });

    it('should fuzzy match contracts with similar paths', () => {
      const contractA: HttpContract = {
        id: 'http:projectA::/api/v1/resources::GET',
        projectId: 'projectA',
        type: 'http',
        method: 'GET',
        path: '/api/v1/resources',
        requestSchemaJson: '{}',
        responseSchemaJson: '{}',
        sourceSymbolId: 'src/api.ts::listResources',
        confidence: 0.95,
      };

      const contractB: HttpContract = {
        id: 'http:projectB::/resources::GET',
        projectId: 'projectB',
        type: 'http',
        method: 'GET',
        path: '/resources',
        requestSchemaJson: '{}',
        responseSchemaJson: '{}',
        sourceSymbolId: 'src/routes.ts::getResources',
        confidence: 0.95,
      };

      const matches = matchContracts([contractA], [contractB]);

      // These will match at 'name' level because they share 'resources' segment
      expect(matches).toHaveLength(1);
      expect(matches[0].level).toBe('name');
      expect(matches[0].score).toBeGreaterThan(0.8);
    });
  });

  describe('Cascade matching', () => {
    it('should prefer exact matches over name or fuzzy in cascade', () => {
      // Contract A has one exact match (B1) and one fuzzy match (B2)
      const contractA: HttpContract = {
        id: 'http:projectA::/api/tasks::GET',
        projectId: 'projectA',
        type: 'http',
        method: 'GET',
        path: '/api/tasks',
        requestSchemaJson: '{}',
        responseSchemaJson: '{}',
        sourceSymbolId: 'src/api.ts::listTasks',
        confidence: 0.95,
      };

      const contractB1: HttpContract = {
        id: 'http:projectB::/api/tasks::GET',
        projectId: 'projectB',
        type: 'http',
        method: 'GET',
        path: '/api/tasks',
        requestSchemaJson: '{}',
        responseSchemaJson: '{}',
        sourceSymbolId: 'src/routes.ts::getTasks',
        confidence: 0.95,
      };

      const contractB2: HttpContract = {
        id: 'http:projectB::/api/v1/tasks::GET',
        projectId: 'projectB',
        type: 'http',
        method: 'GET',
        path: '/api/v1/tasks',
        requestSchemaJson: '{}',
        responseSchemaJson: '{}',
        sourceSymbolId: 'src/routes.ts::listTasks',
        confidence: 0.95,
      };

      const matches = matchContracts([contractA], [contractB1, contractB2]);

      // Should match to B1 (exact) not B2 (fuzzy)
      expect(matches).toHaveLength(1);
      expect(matches[0].contractB.id).toBe('http:projectB::/api/tasks::GET');
      expect(matches[0].level).toBe('exact');
    });

    it('should not double-match contracts in cascade', () => {
      // Verify that each contract in B is only matched once
      const contractsA: HttpContract[] = [
        {
          id: 'http:projectA::/api/tasks::GET',
          projectId: 'projectA',
          type: 'http',
          method: 'GET',
          path: '/api/tasks',
          requestSchemaJson: '{}',
          responseSchemaJson: '{}',
          sourceSymbolId: 'src/api.ts::listTasks',
          confidence: 0.95,
        },
        {
          id: 'http:projectA::/api/users::GET',
          projectId: 'projectA',
          type: 'http',
          method: 'GET',
          path: '/api/users',
          requestSchemaJson: '{}',
          responseSchemaJson: '{}',
          sourceSymbolId: 'src/api.ts::listUsers',
          confidence: 0.95,
        },
      ];

      const contractsB: HttpContract[] = [
        {
          id: 'http:projectB::/api/tasks::GET',
          projectId: 'projectB',
          type: 'http',
          method: 'GET',
          path: '/api/tasks',
          requestSchemaJson: '{}',
          responseSchemaJson: '{}',
          sourceSymbolId: 'src/routes.ts::getTasks',
          confidence: 0.95,
        },
      ];

      const matches = matchContracts(contractsA, contractsB);

      // Only one match (exact match)
      expect(matches).toHaveLength(1);
      expect(matches[0].contractA.id).toBe('http:projectA::/api/tasks::GET');
      expect(matches[0].contractB.id).toBe('http:projectB::/api/tasks::GET');
    });
  });

  describe('Different contract types', () => {
    it('should only match contracts of the same type', () => {
      const httpContract: HttpContract = {
        id: 'http:projectA::/api/tasks::GET',
        projectId: 'projectA',
        type: 'http',
        method: 'GET',
        path: '/api/tasks',
        requestSchemaJson: '{}',
        responseSchemaJson: '{}',
        sourceSymbolId: 'src/api.ts::list',
        confidence: 0.95,
      };

      // Topic contract with similar name
      const topicContract: Contract = {
        id: 'topic:projectB::task.created::publish',
        projectId: 'projectB',
        type: 'topic',
        topic: 'task.created',
        direction: 'publish',
        payloadSchemaJson: '{}',
        sourceSymbolId: 'src/events.ts::emitTaskCreated',
        confidence: 0.95,
      };

      const matches = matchContracts([httpContract], [topicContract] as Contract[]);

      // No matches (different types)
      expect(matches).toHaveLength(0);
    });
  });
});
