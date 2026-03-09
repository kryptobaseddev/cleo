/**
 * Unit tests for the transport factory.
 *
 * @task T5671
 */

import { describe, expect, it } from 'vitest';
import { createTransport } from '../factory.js';
import type { TransportFactoryConfig } from '../factory.js';
import { ClaudeCodeTransport } from '../claude-code-transport.js';
import { SignalDockTransport } from '../signaldock-transport.js';

describe('createTransport', () => {
  it('returns ClaudeCodeTransport when no config is provided', () => {
    const transport = createTransport();
    expect(transport).toBeInstanceOf(ClaudeCodeTransport);
    expect(transport.name).toBe('claude-code');
  });

  it('returns ClaudeCodeTransport when config.enabled is false', () => {
    const config: TransportFactoryConfig = {
      enabled: false,
      mode: 'http',
      endpoint: 'http://localhost:4000',
      agentPrefix: 'cleo-',
      privacyTier: 'private',
    };
    const transport = createTransport(config);
    expect(transport).toBeInstanceOf(ClaudeCodeTransport);
  });

  it('returns SignalDockTransport when config.enabled is true', () => {
    const config: TransportFactoryConfig = {
      enabled: true,
      mode: 'http',
      endpoint: 'http://localhost:4000',
      agentPrefix: 'cleo-',
      privacyTier: 'private',
    };
    const transport = createTransport(config);
    expect(transport).toBeInstanceOf(SignalDockTransport);
    expect(transport.name).toBe('signaldock');
  });

  it('passes config values through to SignalDockTransport', async () => {
    const config: TransportFactoryConfig = {
      enabled: true,
      mode: 'http',
      endpoint: 'http://custom-host:9999',
      agentPrefix: 'myprefix-',
      privacyTier: 'public',
    };
    const transport = createTransport(config);
    expect(transport).toBeInstanceOf(SignalDockTransport);
  });

  it('returns ClaudeCodeTransport when config is undefined', () => {
    const transport = createTransport(undefined);
    expect(transport).toBeInstanceOf(ClaudeCodeTransport);
  });
});
