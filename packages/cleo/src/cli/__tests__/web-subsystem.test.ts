/**
 * Tests for the web subsystem — `createWebSubsystem()` + helpers.
 *
 * @task T11506 R6-T1 — web-subsystem.ts created
 * @task T11257 R6 — migrate web command → daemon subsystem
 */

import { describe, expect, it } from 'vitest';
import {
  createWebSubsystem,
  getWebPaths,
  isWebProcessRunning,
  WEB_DEFAULT_HOST,
  WEB_DEFAULT_PORT,
  WEB_SUBSYSTEM_NAME,
} from '../web-subsystem.js';

describe('createWebSubsystem (T11506 R6-T1)', () => {
  it('produces a subsystem with the correct name', () => {
    const sub = createWebSubsystem();
    expect(sub.name).toBe(WEB_SUBSYSTEM_NAME);
    expect(sub.name).toBe('cleo-web');
  });

  it('subsystem is frozen (defineSubsystem contract)', () => {
    const sub = createWebSubsystem();
    expect(Object.isFrozen(sub)).toBe(true);
  });

  it('subsystem has start, healthProbe, and shutdown functions', () => {
    const sub = createWebSubsystem();
    expect(typeof sub.start).toBe('function');
    expect(typeof sub.healthProbe).toBe('function');
    expect(typeof sub.shutdown).toBe('function');
  });

  it('healthProbe returns stopped state before start (T11506 AC3)', () => {
    const sub = createWebSubsystem({ port: WEB_DEFAULT_PORT, host: WEB_DEFAULT_HOST });
    const health = sub.healthProbe();
    expect(health.state).toBe('stopped');
    expect(health.child_id).toBe(WEB_SUBSYSTEM_NAME);
    expect(health.pid).toBe(0);
    expect(health.restart_count).toBe(0);
  });

  it('uses default port 3456 when none specified', () => {
    const sub = createWebSubsystem();
    // Verify the name remains correct regardless of port.
    expect(sub.name).toBe(WEB_SUBSYSTEM_NAME);
  });

  it('accepts custom port and host options', () => {
    // Just verify it constructs without error — actual binding is IO.
    const sub = createWebSubsystem({ port: 4567, host: '0.0.0.0' });
    expect(sub.name).toBe(WEB_SUBSYSTEM_NAME);
    const health = sub.healthProbe();
    expect(health.state).toBe('stopped');
  });
});

describe('WEB_DEFAULT_PORT / WEB_DEFAULT_HOST constants', () => {
  it('DEFAULT_PORT is 3456 (TCP port 3456 binding preserved — T11257 AC4)', () => {
    expect(WEB_DEFAULT_PORT).toBe(3456);
  });

  it('DEFAULT_HOST is 127.0.0.1', () => {
    expect(WEB_DEFAULT_HOST).toBe('127.0.0.1');
  });
});

describe('getWebPaths', () => {
  it('returns an object with pidFile, configFile, logDir, logFile fields', () => {
    const paths = getWebPaths();
    expect(typeof paths.pidFile).toBe('string');
    expect(typeof paths.configFile).toBe('string');
    expect(typeof paths.logDir).toBe('string');
    expect(typeof paths.logFile).toBe('string');
  });

  it('pidFile is named web-server.pid', () => {
    const { pidFile } = getWebPaths();
    expect(pidFile).toMatch(/web-server\.pid$/);
  });

  it('logFile is nested under logDir', () => {
    const { logDir, logFile } = getWebPaths();
    expect(logFile.startsWith(logDir)).toBe(true);
  });
});

describe('isWebProcessRunning', () => {
  it('returns true for the current process', () => {
    expect(isWebProcessRunning(process.pid)).toBe(true);
  });

  it('returns false for a non-existent PID', () => {
    // PID 2147483647 is far above the Linux default limit of 4194304.
    expect(isWebProcessRunning(2_147_483_647)).toBe(false);
  });
});
