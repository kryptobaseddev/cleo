/**
 * Tests for the docs-viewer subsystem — `createDocsViewerSubsystem()` + helpers.
 *
 * @task T11508 R7-T1 — docs-viewer-subsystem.ts created
 * @task T11258 R7 — migrate docs-viewer.ts → daemon subsystem
 */

import { describe, expect, it } from 'vitest';
import {
  createDocsViewerSubsystem,
  getViewerPaths,
  isViewerProcessRunning,
  VIEWER_DEFAULT_END_PORT,
  VIEWER_DEFAULT_HOST,
  VIEWER_DEFAULT_PORT,
  VIEWER_SUBSYSTEM_NAME,
} from '../docs-viewer-subsystem.js';

describe('createDocsViewerSubsystem (T11508 R7-T1)', () => {
  it('produces a subsystem with the correct name', () => {
    const sub = createDocsViewerSubsystem();
    expect(sub.name).toBe(VIEWER_SUBSYSTEM_NAME);
    expect(sub.name).toBe('cleo-docs-viewer');
  });

  it('subsystem is frozen (defineSubsystem contract)', () => {
    const sub = createDocsViewerSubsystem();
    expect(Object.isFrozen(sub)).toBe(true);
  });

  it('subsystem has start, healthProbe, and shutdown functions', () => {
    const sub = createDocsViewerSubsystem();
    expect(typeof sub.start).toBe('function');
    expect(typeof sub.healthProbe).toBe('function');
    expect(typeof sub.shutdown).toBe('function');
  });

  it('healthProbe returns stopped state before start (T11508 AC3)', () => {
    const sub = createDocsViewerSubsystem({
      startPort: VIEWER_DEFAULT_PORT,
      host: VIEWER_DEFAULT_HOST,
    });
    const health = sub.healthProbe();
    expect(health.state).toBe('stopped');
    expect(health.child_id).toBe(VIEWER_SUBSYSTEM_NAME);
    expect(health.pid).toBe(0);
    expect(health.restart_count).toBe(0);
  });

  it('uses default port 7777 when none specified', () => {
    const sub = createDocsViewerSubsystem();
    expect(sub.name).toBe(VIEWER_SUBSYSTEM_NAME);
  });

  it('accepts custom port and host options', () => {
    const sub = createDocsViewerSubsystem({ startPort: 8888, host: '0.0.0.0' });
    expect(sub.name).toBe(VIEWER_SUBSYSTEM_NAME);
    const health = sub.healthProbe();
    expect(health.state).toBe('stopped');
  });
});

describe('VIEWER_DEFAULT_PORT / VIEWER_DEFAULT_HOST / VIEWER_DEFAULT_END_PORT constants', () => {
  it('VIEWER_DEFAULT_PORT is 7777 (T11258 AC)', () => {
    expect(VIEWER_DEFAULT_PORT).toBe(7777);
  });

  it('VIEWER_DEFAULT_END_PORT is 7800', () => {
    expect(VIEWER_DEFAULT_END_PORT).toBe(7800);
  });

  it('VIEWER_DEFAULT_HOST is 127.0.0.1', () => {
    expect(VIEWER_DEFAULT_HOST).toBe('127.0.0.1');
  });
});

describe('getViewerPaths', () => {
  it('returns an object with pidFile, logFile, logDir fields', () => {
    const paths = getViewerPaths();
    expect(typeof paths.pidFile).toBe('string');
    expect(typeof paths.logFile).toBe('string');
    expect(typeof paths.logDir).toBe('string');
  });

  it('pidFile is named viewer.pid', () => {
    const { pidFile } = getViewerPaths();
    expect(pidFile).toMatch(/viewer\.pid$/);
  });

  it('logFile is within logDir', () => {
    const { logDir, logFile } = getViewerPaths();
    expect(logFile.startsWith(logDir)).toBe(true);
  });
});

describe('isViewerProcessRunning', () => {
  it('returns true for the current process', () => {
    expect(isViewerProcessRunning(process.pid)).toBe(true);
  });

  it('returns false for a non-existent PID', () => {
    // PID 2147483647 is far above the Linux default limit of 4194304.
    expect(isViewerProcessRunning(2_147_483_647)).toBe(false);
  });
});
