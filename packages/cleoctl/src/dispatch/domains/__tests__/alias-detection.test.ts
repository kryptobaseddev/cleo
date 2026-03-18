/**
 * Alias Detection Test
 *
 * Verifies that each domain handler's getSupportedOperations() exactly matches
 * the operations registered in the OPERATIONS[] registry for that domain.
 * Any extra operations in the handler that are NOT in the registry are aliases
 * that should be removed.
 *
 * @task T5671
 */

import { describe, expect, it } from 'vitest';

// Mock everything to allow handler instantiation
vi.mock('../../../../../core/src/paths.js', () => ({
  getProjectRoot: vi.fn(() => '/mock/project'),
}));
vi.mock('../../../../../core/src/logger.js', () => ({
  getLogger: vi.fn(() => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  })),
}));

import { vi } from 'vitest';
import { OPERATIONS } from '../../registry.js';
import { AdminHandler } from '../admin.js';
import { CheckHandler } from '../check.js';
import { MemoryHandler } from '../memory.js';
import { NexusHandler } from '../nexus.js';
import { OrchestrateHandler } from '../orchestrate.js';
import { PipelineHandler } from '../pipeline.js';
import { SessionHandler } from '../session.js';
import { StickyHandler } from '../sticky.js';
import { TasksHandler } from '../tasks.js';
import { ToolsHandler } from '../tools.js';

// Build registry lookup: domain -> { query: Set, mutate: Set }
const registryByDomain = new Map<string, { query: Set<string>; mutate: Set<string> }>();
for (const op of OPERATIONS) {
  if (!registryByDomain.has(op.domain)) {
    registryByDomain.set(op.domain, { query: new Set(), mutate: new Set() });
  }
  registryByDomain.get(op.domain)![op.gateway].add(op.operation);
}

const HANDLERS: Array<{
  domain: string;
  handler: { getSupportedOperations(): { query: string[]; mutate: string[] } };
}> = [
  { domain: 'tasks', handler: new TasksHandler() },
  { domain: 'session', handler: new SessionHandler() },
  { domain: 'orchestrate', handler: new OrchestrateHandler() },
  { domain: 'memory', handler: new MemoryHandler() },
  { domain: 'pipeline', handler: new PipelineHandler() },
  { domain: 'check', handler: new CheckHandler() },
  { domain: 'admin', handler: new AdminHandler() },
  { domain: 'tools', handler: new ToolsHandler() },
  { domain: 'nexus', handler: new NexusHandler() },
  { domain: 'sticky', handler: new StickyHandler() },
];

describe('Alias Detection: getSupportedOperations() matches registry exactly', () => {
  for (const { domain, handler } of HANDLERS) {
    describe(`${domain} domain`, () => {
      const supported = handler.getSupportedOperations();
      const registry = registryByDomain.get(domain);

      it('query operations match registry exactly', () => {
        expect(registry, `Domain "${domain}" not found in registry`).toBeDefined();
        const registryOps = [...registry!.query].sort();
        const handlerOps = [...supported.query].sort();

        const extraInHandler = handlerOps.filter((op) => !registry!.query.has(op));
        const missingInHandler = registryOps.filter((op) => !supported.query.includes(op));

        if (extraInHandler.length > 0 || missingInHandler.length > 0) {
          const parts: string[] = [];
          if (extraInHandler.length > 0) {
            parts.push(`Extra ops in handler (aliases to remove): ${extraInHandler.join(', ')}`);
          }
          if (missingInHandler.length > 0) {
            parts.push(`Missing ops in handler (not wired): ${missingInHandler.join(', ')}`);
          }
          expect.fail(`${domain} query mismatch:\n  ${parts.join('\n  ')}`);
        }
      });

      it('mutate operations match registry exactly', () => {
        expect(registry, `Domain "${domain}" not found in registry`).toBeDefined();
        const registryOps = [...registry!.mutate].sort();
        const handlerOps = [...supported.mutate].sort();

        const extraInHandler = handlerOps.filter((op) => !registry!.mutate.has(op));
        const missingInHandler = registryOps.filter((op) => !supported.mutate.includes(op));

        if (extraInHandler.length > 0 || missingInHandler.length > 0) {
          const parts: string[] = [];
          if (extraInHandler.length > 0) {
            parts.push(`Extra ops in handler (aliases to remove): ${extraInHandler.join(', ')}`);
          }
          if (missingInHandler.length > 0) {
            parts.push(`Missing ops in handler (not wired): ${missingInHandler.join(', ')}`);
          }
          expect.fail(`${domain} mutate mismatch:\n  ${parts.join('\n  ')}`);
        }
      });
    });
  }
});
