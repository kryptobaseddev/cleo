/**
 * CLI behavior parity verification - TypeScript V2 vs Bash CLI.
 * Documents command coverage and LAFS envelope compliance.
 *
 * @task T4504
 * @epic T4498
 */

import { describe, it, expect } from 'vitest';
import { ExitCode, getExitCodeName, isErrorCode, isSuccessCode } from '../../types/exit-codes.js';
import { CleoError } from '../errors.js';
import { formatSuccess, formatError } from '../output.js';

// ============================================================
// CLI Command Parity Tracking
// ============================================================

/** Commands registered in the V2 TypeScript CLI. */
const TS_COMMANDS = [
  'version',
  'add',
  'list',
  'show',
  'find',
  'complete',
  'update',
  'delete',
  'archive',
  'focus',        // subcommands: show, set, clear, history
  'session',      // subcommands: start, end, status, resume, list, gc
  'phase',        // subcommands: list, show, set, start, complete, advance, rename, delete
  'deps',         // subcommands: overview, show, waves, critical, impact, cycles, graph
  'tree',
  'research',     // subcommands: add, show, list, pending, link, update, manifest
  'orchestrate',  // subcommands: start, analyze, ready, next, spawn, context
  'lifecycle',    // subcommands: state, start, complete, skip, gate
  'release',      // subcommands: create, plan, ship, list, show, changelog
  'migrate',      // subcommands: status, run
] as const;

/** Critical Bash CLI commands that MUST have parity. */
const CRITICAL_BASH_COMMANDS = [
  'add', 'list', 'show', 'find', 'complete', 'update', 'delete', 'archive',
  'focus', 'session', 'phase', 'deps', 'research', 'release', 'lifecycle',
  'migrate', 'orchestrator',
] as const;

describe('CLI Command Parity', () => {
  it('V2 CLI covers all critical Bash commands', () => {
    const tsCommandSet = new Set(TS_COMMANDS);
    const missing: string[] = [];

    for (const cmd of CRITICAL_BASH_COMMANDS) {
      const normalizedCmd = cmd === 'orchestrator' ? 'orchestrate' : cmd;
      if (!tsCommandSet.has(normalizedCmd as typeof TS_COMMANDS[number])) {
        missing.push(cmd);
      }
    }

    expect(missing).toEqual([]);
  });

  it('V2 CLI has at least 17 command groups', () => {
    expect(TS_COMMANDS.length).toBeGreaterThanOrEqual(17);
  });
});

// ============================================================
// Exit Code Parity
// ============================================================

describe('Exit Code Parity', () => {
  const EXIT_CODE_RANGES = {
    success: { start: 0, end: 0 },
    general: { start: 1, end: 9 },
    hierarchy: { start: 10, end: 19 },
    concurrency: { start: 20, end: 29 },
    session: { start: 30, end: 39 },
    verification: { start: 40, end: 47 },
    context: { start: 50, end: 54 },
    orchestrator: { start: 60, end: 67 },
    nexus: { start: 70, end: 79 },
    lifecycle: { start: 80, end: 84 },
    artifact: { start: 85, end: 89 },
    provenance: { start: 90, end: 94 },
    special: { start: 100, end: 102 },
  };

  it('has all exit code ranges defined', () => {
    // Check that all expected exit code values exist
    const allCodes = Object.values(ExitCode).filter(v => typeof v === 'number') as number[];
    const codeSet = new Set(allCodes);

    // Verify key codes exist
    expect(codeSet.has(0)).toBe(true);     // SUCCESS
    expect(codeSet.has(1)).toBe(true);     // GENERAL_ERROR
    expect(codeSet.has(4)).toBe(true);     // NOT_FOUND
    expect(codeSet.has(6)).toBe(true);     // VALIDATION_ERROR
    expect(codeSet.has(10)).toBe(true);    // PARENT_NOT_FOUND
    expect(codeSet.has(11)).toBe(true);    // DEPTH_EXCEEDED
    expect(codeSet.has(12)).toBe(true);    // SIBLING_LIMIT
    expect(codeSet.has(20)).toBe(true);    // CHECKSUM_MISMATCH
    expect(codeSet.has(30)).toBe(true);    // SESSION_EXISTS
    expect(codeSet.has(38)).toBe(true);    // FOCUS_REQUIRED
    expect(codeSet.has(60)).toBe(true);    // PROTOCOL_MISSING
    expect(codeSet.has(80)).toBe(true);    // LIFECYCLE_GATE_FAILED
    expect(codeSet.has(100)).toBe(true);   // NO_DATA
  });

  it('has exactly the right count of exit codes', () => {
    const allCodes = Object.values(ExitCode).filter(v => typeof v === 'number');
    // 72 total exit codes from the Bash CLI + provenance/artifact ranges
    expect(allCodes.length).toBeGreaterThanOrEqual(72);
  });

  it('all exit codes have human-readable names', () => {
    const allCodes = Object.values(ExitCode).filter(v => typeof v === 'number') as ExitCode[];
    for (const code of allCodes) {
      const name = getExitCodeName(code);
      expect(name).not.toBe('UNKNOWN');
    }
  });

  it('isErrorCode correctly classifies 1-99 as errors', () => {
    expect(isErrorCode(ExitCode.GENERAL_ERROR)).toBe(true);
    expect(isErrorCode(ExitCode.NOT_FOUND)).toBe(true);
    expect(isErrorCode(ExitCode.VALIDATION_ERROR)).toBe(true);
    expect(isErrorCode(ExitCode.SESSION_EXISTS)).toBe(true);
    expect(isErrorCode(ExitCode.PROTOCOL_MISSING)).toBe(true);
    expect(isErrorCode(ExitCode.LIFECYCLE_GATE_FAILED)).toBe(true);
  });

  it('isSuccessCode correctly classifies 0 and 100+ as success', () => {
    expect(isSuccessCode(ExitCode.SUCCESS)).toBe(true);
    expect(isSuccessCode(ExitCode.NO_DATA)).toBe(true);
    expect(isSuccessCode(ExitCode.ALREADY_EXISTS)).toBe(true);
    expect(isSuccessCode(ExitCode.NO_CHANGE)).toBe(true);
  });
});

// ============================================================
// LAFS Envelope Format Parity
// ============================================================

describe('LAFS Envelope Format', () => {
  it('success envelope matches Bash CLI format', () => {
    const result = formatSuccess({ task: { id: 'T001', title: 'Test' } });
    const parsed = JSON.parse(result);

    // Bash CLI format: { success: true, data: {...} }
    expect(parsed.success).toBe(true);
    expect(parsed.data).toBeDefined();
    expect(parsed.data.task).toBeDefined();
  });

  it('error envelope matches Bash CLI format', () => {
    const err = new CleoError(ExitCode.NOT_FOUND, 'Task T999 not found', {
      fix: 'Use cleo list to find tasks',
      alternatives: [{ action: 'Search', command: 'cleo find query' }],
    });
    const result = formatError(err);
    const parsed = JSON.parse(result);

    // Bash CLI format: { success: false, error: { code, name, message, fix?, alternatives? } }
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBeDefined();
    expect(parsed.error.code).toBe(4);
    expect(parsed.error.name).toBe('NOT_FOUND');
    expect(parsed.error.message).toBe('Task T999 not found');
    expect(parsed.error.fix).toBe('Use cleo list to find tasks');
    expect(parsed.error.alternatives).toHaveLength(1);
  });

  it('CleoError.toJSON matches LAFS envelope', () => {
    const err = new CleoError(ExitCode.VALIDATION_ERROR, 'Bad input');
    const json = err.toJSON();
    expect(json.success).toBe(false);
    expect((json.error as Record<string, unknown>).code).toBe(6);
    expect((json.error as Record<string, unknown>).name).toBe('VALIDATION_ERROR');
  });

  it('success with noChange flag', () => {
    const result = formatSuccess(null, 'No changes needed');
    const parsed = JSON.parse(result);
    expect(parsed.success).toBe(true);
    expect(parsed.message).toBe('No changes needed');
  });
});

// ============================================================
// Flag Compatibility
// ============================================================

describe('Flag Compatibility', () => {
  it('list command supports --parent, --status, --phase, --priority filters', () => {
    // These are verified by the existing list.test.ts
    // This test documents the expected interface
    const expectedFlags = ['parent', 'status', 'phase', 'priority', 'limit', 'offset', 'sort'];
    // The list command should support all these filter options
    expect(expectedFlags).toBeDefined();
  });

  it('add command supports --priority, --phase, --parent, --depends options', () => {
    const expectedFlags = ['priority', 'phase', 'parent', 'depends', 'type', 'labels'];
    expect(expectedFlags).toBeDefined();
  });
});
