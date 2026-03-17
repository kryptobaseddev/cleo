/**
 * E2E Orchestration test for SignalDock transport.
 *
 * Simulates a multi-agent orchestration workflow:
 * 1. Two agents register (orchestrator + worker)
 * 2. Orchestrator sends task assignment
 * 3. Worker receives assignment
 * 4. Worker sends completion notification
 * 5. Orchestrator receives completion
 * 6. Both deregister
 *
 * Uses ClaudeCodeTransport (in-memory) for deterministic E2E testing
 * without requiring a live daemon. Integration tests cover the real daemon.
 *
 * @task T5671
 */

import { describe, expect, it } from 'vitest';
import { ClaudeCodeTransport } from '../../src/core/signaldock/claude-code-transport.js';
import { createTransport } from '../../src/core/signaldock/factory.js';

describe('SignalDock Orchestration E2E', () => {
  it('completes a full orchestrator-worker task cycle', async () => {
    const transport = new ClaudeCodeTransport();

    // Step 1: Both agents register
    const orchestrator = await transport.register('orchestrator', 'code_dev', 'private');
    const worker = await transport.register('worker', 'code_dev', 'private');

    expect(orchestrator.agentId).toBe('cc-orchestrator');
    expect(worker.agentId).toBe('cc-worker');

    // Step 2: Create a conversation between them
    const conv = await transport.createConversation(
      [orchestrator.agentId, worker.agentId],
      'private',
    );
    expect(conv.id).toBeTruthy();

    // Step 3: Orchestrator sends task assignment
    const assignment = await transport.send(
      orchestrator.agentId,
      worker.agentId,
      JSON.stringify({
        type: 'task_assignment',
        taskId: 'T5671',
        action: 'write-tests',
        payload: { files: ['signaldock-transport.ts'] },
      }),
      conv.id,
    );
    expect(assignment.status).toBe('delivered');

    // Step 4: Worker polls and receives the assignment
    const workerInbox = await transport.poll(worker.agentId);
    expect(workerInbox).toHaveLength(1);
    expect(workerInbox[0].fromAgentId).toBe(orchestrator.agentId);
    const taskPayload = JSON.parse(workerInbox[0].content);
    expect(taskPayload.type).toBe('task_assignment');
    expect(taskPayload.taskId).toBe('T5671');

    // Step 5: Worker sends completion notification
    const completion = await transport.send(
      worker.agentId,
      orchestrator.agentId,
      JSON.stringify({
        type: 'task_complete',
        taskId: 'T5671',
        result: { testsWritten: 15, testsPassed: 15 },
      }),
      conv.id,
    );
    expect(completion.status).toBe('delivered');

    // Step 6: Orchestrator polls and receives completion
    const orchestratorInbox = await transport.poll(orchestrator.agentId);
    expect(orchestratorInbox).toHaveLength(1);
    expect(orchestratorInbox[0].fromAgentId).toBe(worker.agentId);
    const resultPayload = JSON.parse(orchestratorInbox[0].content);
    expect(resultPayload.type).toBe('task_complete');
    expect(resultPayload.result.testsWritten).toBe(15);

    // Step 7: Both deregister
    await transport.deregister(orchestrator.agentId);
    await transport.deregister(worker.agentId);

    // Verify agents are gone
    const orch = await transport.getAgent(orchestrator.agentId);
    const work = await transport.getAgent(worker.agentId);
    expect(orch).toBeNull();
    expect(work).toBeNull();
  });

  it('handles multi-round conversation with heartbeats', async () => {
    const transport = new ClaudeCodeTransport();

    const lead = await transport.register('lead', 'code_dev', 'private');
    const analyst = await transport.register('analyst', 'research', 'private');

    const conv = await transport.createConversation([lead.agentId, analyst.agentId]);

    // Lead sends question
    await transport.send(lead.agentId, analyst.agentId, 'Analyze module X', conv.id);

    // Heartbeats keep presence alive
    await transport.heartbeat(lead.agentId);
    await transport.heartbeat(analyst.agentId);

    // Analyst receives and responds
    const q = await transport.poll(analyst.agentId);
    expect(q).toHaveLength(1);

    await transport.send(analyst.agentId, lead.agentId, 'Module X has 3 issues', conv.id);

    // Lead receives response
    const r = await transport.poll(lead.agentId);
    expect(r).toHaveLength(1);
    expect(r[0].content).toBe('Module X has 3 issues');

    // Lead sends follow-up
    await transport.send(lead.agentId, analyst.agentId, 'Fix issue 1', conv.id);

    // Analyst gets all unread (original + follow-up)
    const all = await transport.poll(analyst.agentId);
    expect(all).toHaveLength(2);

    // Cleanup
    await transport.deregister(lead.agentId);
    await transport.deregister(analyst.agentId);
  });

  it('factory returns ClaudeCodeTransport by default for E2E use', () => {
    const transport = createTransport();
    expect(transport.name).toBe('claude-code');
  });

  it('factory returns SignalDockTransport when enabled', () => {
    const transport = createTransport({
      enabled: true,
      mode: 'http',
      endpoint: 'http://localhost:4000',
      agentPrefix: 'cleo-',
      privacyTier: 'private',
    });
    expect(transport.name).toBe('signaldock');
  });
});
