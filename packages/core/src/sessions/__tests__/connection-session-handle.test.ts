/**
 * Connection-scoped session handle registry tests (T11640 · Epic T11638).
 *
 * Asserts the daemon-facing identity surface:
 *  1. bind/unbind/lookup lifecycle on the {connId → sessionId} registry.
 *  2. last-write-wins re-binding and empty-value rejection.
 *  3. AsyncLocalStorage scoping — getCurrentConnectionSessionId resolves the
 *     in-flight connection's session and isolates concurrent scopes.
 *  4. unbind is idempotent and bounds the registry across a connection's life.
 *
 * @task T11640
 * @epic T11638
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  bindConnectionSession,
  connectionRegistrySize,
  getConnectionSessionId,
  getCurrentConnectionSessionId,
  resetConnectionSessionRegistry,
  runWithConnectionHandle,
  unbindConnectionSession,
} from '../connection-session-handle.js';

afterEach(() => {
  resetConnectionSessionRegistry();
});

describe('connection-session-handle — registry lifecycle (T11640)', () => {
  it('binds a connection to a session id and looks it up', () => {
    bindConnectionSession('conn-1', 'ses_1');
    expect(getConnectionSessionId('conn-1')).toBe('ses_1');
    expect(connectionRegistrySize()).toBe(1);
  });

  it('returns null for an unbound connection', () => {
    expect(getConnectionSessionId('missing')).toBeNull();
  });

  it('unbinds a connection and reports whether an entry was removed', () => {
    bindConnectionSession('conn-1', 'ses_1');
    expect(unbindConnectionSession('conn-1')).toBe(true);
    expect(getConnectionSessionId('conn-1')).toBeNull();
    expect(connectionRegistrySize()).toBe(0);
    // Idempotent — unbinding again is a no-op.
    expect(unbindConnectionSession('conn-1')).toBe(false);
  });

  it('re-binding the same connection is last-write-wins', () => {
    bindConnectionSession('conn-1', 'ses_old');
    bindConnectionSession('conn-1', 'ses_new');
    expect(getConnectionSessionId('conn-1')).toBe('ses_new');
    expect(connectionRegistrySize()).toBe(1);
  });

  it('ignores empty connId or sessionId so a blank cannot shadow a real binding', () => {
    bindConnectionSession('', 'ses_1');
    bindConnectionSession('conn-1', '');
    expect(connectionRegistrySize()).toBe(0);

    bindConnectionSession('conn-1', 'ses_real');
    bindConnectionSession('conn-1', '');
    // A subsequent empty value is a no-op — the real binding survives.
    expect(getConnectionSessionId('conn-1')).toBe('ses_real');
  });

  it('tracks independent bindings for distinct connections', () => {
    bindConnectionSession('conn-a', 'ses_a');
    bindConnectionSession('conn-b', 'ses_b');
    expect(getConnectionSessionId('conn-a')).toBe('ses_a');
    expect(getConnectionSessionId('conn-b')).toBe('ses_b');
    expect(connectionRegistrySize()).toBe(2);
  });
});

describe('connection-session-handle — AsyncLocalStorage scoping (T11640)', () => {
  it('resolves null outside any connection-handle scope', () => {
    bindConnectionSession('conn-1', 'ses_1');
    // No runWithConnectionHandle wrapper → no current connection.
    expect(getCurrentConnectionSessionId()).toBeNull();
  });

  it('resolves the in-flight connection session inside the scope', () => {
    bindConnectionSession('conn-1', 'ses_1');
    const resolved = runWithConnectionHandle('conn-1', () => getCurrentConnectionSessionId());
    expect(resolved).toBe('ses_1');
  });

  it('resolves null inside a scope whose connection is unbound', () => {
    const resolved = runWithConnectionHandle('conn-unbound', () => getCurrentConnectionSessionId());
    expect(resolved).toBeNull();
  });

  it('honours a late binding made while a dispatch is already running', () => {
    // Models routeFrame binding the session AFTER runWithConnectionHandle opened
    // the scope for a frame that declared NO session of its own (no per-frame
    // snapshot), so the registry is read on demand, not snapshotted at entry.
    const resolved = runWithConnectionHandle('conn-late', () => {
      bindConnectionSession('conn-late', 'ses_late');
      return getCurrentConnectionSessionId();
    });
    expect(resolved).toBe('ses_late');
  });

  it('prefers the per-frame session snapshot over the registry binding', () => {
    // A frame that declared its own session resolves THAT session even when the
    // connId's registry binding points elsewhere.
    bindConnectionSession('conn-1', 'ses_registry');
    const resolved = runWithConnectionHandle(
      'conn-1',
      () => getCurrentConnectionSessionId(),
      'ses_frame',
    );
    expect(resolved).toBe('ses_frame');
  });

  it('falls back to the registry when the frame declared no session snapshot', () => {
    bindConnectionSession('conn-1', 'ses_registry');
    // undefined snapshot → registry lookup wins (the late-binding/anonymous path).
    const resolved = runWithConnectionHandle(
      'conn-1',
      () => getCurrentConnectionSessionId(),
      undefined,
    );
    expect(resolved).toBe('ses_registry');
  });

  it('isolates two different-session frames pipelined on ONE connId (no bleed)', async () => {
    // Models the RPC server firing two concurrent frames on the same connection
    // with DIFFERENT declared sessions: Frame A starts dispatching, Frame B then
    // re-binds the shared connId (last-write-wins). Frame A must still resolve its
    // OWN session — the per-frame snapshot shields it from B's late re-bind.
    bindConnectionSession('conn-shared', 'ses_A');

    const [a, b] = await Promise.all([
      runWithConnectionHandle(
        'conn-shared',
        async () => {
          // Yield so Frame B can interleave and re-bind the connId mid-flight.
          await Promise.resolve();
          await Promise.resolve();
          return getCurrentConnectionSessionId();
        },
        'ses_A',
      ),
      runWithConnectionHandle(
        'conn-shared',
        async () => {
          // Frame B re-binds the shared connId to its own session.
          bindConnectionSession('conn-shared', 'ses_B');
          await Promise.resolve();
          return getCurrentConnectionSessionId();
        },
        'ses_B',
      ),
    ]);

    expect(a).toBe('ses_A');
    expect(b).toBe('ses_B');
  });

  it('isolates concurrent connection scopes', async () => {
    bindConnectionSession('conn-a', 'ses_a');
    bindConnectionSession('conn-b', 'ses_b');

    const [a, b] = await Promise.all([
      runWithConnectionHandle('conn-a', async () => {
        await Promise.resolve();
        return getCurrentConnectionSessionId();
      }),
      runWithConnectionHandle('conn-b', async () => {
        await Promise.resolve();
        return getCurrentConnectionSessionId();
      }),
    ]);

    expect(a).toBe('ses_a');
    expect(b).toBe('ses_b');
  });

  it('tears the scope down after the callback settles', async () => {
    bindConnectionSession('conn-1', 'ses_1');
    await runWithConnectionHandle('conn-1', async () => {
      await Promise.resolve();
    });
    expect(getCurrentConnectionSessionId()).toBeNull();
  });
});
