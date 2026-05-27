/**
 * Type-level and runtime shape tests for T310 contract types.
 *
 * Validates that `ProjectAgentRef` and `AgentWithProjectOverride` compile
 * correctly and that objects conforming to those shapes behave as expected
 * at runtime.
 *
 * @task T351
 * @epic T310
 */

import { describe, expect, it } from 'vitest';
import type { AgentWithProjectOverride, ProjectAgentRef } from '../agent-registry.js';

describe('T310 contract types', () => {
  it('ProjectAgentRef compiles with minimum required fields', () => {
    const ref: ProjectAgentRef = {
      agentId: 'agent-1',
      attachedAt: '2026-04-08T00:00:00Z',
      role: null,
      capabilitiesOverride: null,
      lastUsedAt: null,
      enabled: 1,
    };
    expect(ref.agentId).toBe('agent-1');
    expect(ref.enabled).toBe(1);
  });

  it('ProjectAgentRef accepts optional fields populated', () => {
    const ref: ProjectAgentRef = {
      agentId: 'agent-2',
      attachedAt: '2026-04-08T00:00:00Z',
      role: 'reviewer',
      capabilitiesOverride: '{"maxTools":5}',
      lastUsedAt: '2026-04-08T01:00:00Z',
      enabled: 0,
    };
    expect(ref.role).toBe('reviewer');
    expect(ref.capabilitiesOverride).toBe('{"maxTools":5}');
  });

  it('ProjectAgentRef enabled=0 represents detached state', () => {
    const ref: ProjectAgentRef = {
      agentId: 'agent-3',
      attachedAt: '2026-04-08T00:00:00Z',
      role: null,
      capabilitiesOverride: null,
      lastUsedAt: null,
      enabled: 0,
    };
    expect(ref.enabled).toBe(0);
  });

  it('AgentWithProjectOverride extends AgentCredential with projectRef block', () => {
    // Uses as unknown as to construct a partial instance for shape verification.
    // This is permitted in tests when verifying structural compatibility only.
    const merged = {
      projectRef: {
        agentId: 'agent-1',
        attachedAt: '2026-04-08T00:00:00Z',
        role: null,
        capabilitiesOverride: null,
        lastUsedAt: null,
        enabled: 1,
      },
    } as unknown as AgentWithProjectOverride;
    expect(merged.projectRef).not.toBeNull();
    expect(merged.projectRef?.agentId).toBe('agent-1');
  });

  it('AgentWithProjectOverride.projectRef can be null (global-only lookup)', () => {
    // Uses as unknown as to construct a partial instance for shape verification.
    const globalOnly = {
      projectRef: null,
    } as unknown as AgentWithProjectOverride;
    expect(globalOnly.projectRef).toBeNull();
  });

  it('AgentWithProjectOverride constructed from full AgentCredential fields', () => {
    const full: AgentWithProjectOverride = {
      agentId: 'cleo-core',
      displayName: 'CLEO Core',
      apiKey: 'sk_live_test',
      apiBaseUrl: 'https://api.signaldock.io',
      privacyTier: 'private',
      capabilities: ['chat', 'tools'],
      skills: ['coding'],
      transportType: 'sse',
      transportConfig: {},
      isActive: true,
      createdAt: '2026-04-08T00:00:00Z',
      updatedAt: '2026-04-08T00:00:00Z',
      projectRef: {
        agentId: 'cleo-core',
        attachedAt: '2026-04-08T00:00:00Z',
        role: 'orchestrator',
        capabilitiesOverride: null,
        lastUsedAt: null,
        enabled: 1,
      },
    };
    expect(full.agentId).toBe('cleo-core');
    expect(full.projectRef?.role).toBe('orchestrator');
    expect(full.isActive).toBe(true);
  });
});
