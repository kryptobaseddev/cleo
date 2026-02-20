/**
 * Tests for migration logger (@task T4727)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MigrationLogger,
  createMigrationLogger,
  readMigrationLog,
  logFileExists,
  getLatestMigrationLog,
  type MigrationLogEntry,
} from '../logger.js';

describe('MigrationLogger', () => {
  let tempDir: string;
  let logger: MigrationLogger;

  beforeEach(() => {
    // Create temp directory for test logs
    tempDir = join(tmpdir(), `migration-logger-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    logger = new MigrationLogger(tempDir);
  });

  afterEach(() => {
    // Clean up temp directory
    try {
      if (existsSync(tempDir)) {
        const { rmdirSync } = require('node:fs');
        rmdirSync(tempDir, { recursive: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('initialization', () => {
    it('should create logs directory if it does not exist', () => {
      const logsDir = join(tempDir, 'logs');
      expect(existsSync(logsDir)).toBe(true);
    });

    it('should create a log file with timestamp in name', () => {
      // Log something to create the file
      logger.info('test', 'init', 'Initial log entry');
      
      const logPath = logger.getLogPath();
      expect(logPath).toMatch(/migration-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(-\d{3})?Z?\.jsonl$/);
      expect(existsSync(logPath)).toBe(true);
    });

    it('should return relative log path', () => {
      const relativePath = logger.getRelativeLogPath();
      expect(relativePath).toMatch(/^logs\/migration-.*\.jsonl$/);
    });
  });

  describe('logging methods', () => {
    it('should log info messages', () => {
      logger.info('test-phase', 'test-op', 'Test message', { key: 'value' });

      const entries = logger.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        level: 'info',
        phase: 'test-phase',
        operation: 'test-op',
        message: 'Test message',
        data: { key: 'value' },
      });
      expect(entries[0].timestamp).toBeDefined();
      expect(entries[0].durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should log warn messages', () => {
      logger.warn('test-phase', 'test-warning', 'Warning message');

      const entries = logger.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].level).toBe('warn');
    });

    it('should log error messages', () => {
      logger.error('test-phase', 'test-error', 'Error message', { error: 'details' });

      const entries = logger.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].level).toBe('error');
      expect(entries[0].data).toEqual({ error: 'details' });
    });

    it('should log debug messages', () => {
      logger.debug('test-phase', 'test-debug', 'Debug message');

      const entries = logger.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].level).toBe('debug');
    });
  });

  describe('convenience methods', () => {
    it('should log file operations with sizes', () => {
      const sourceFile = join(tempDir, 'source.txt');
      const targetFile = join(tempDir, 'target.txt');

      // Create test files
      writeFileSync(sourceFile, 'Hello, World!');
      writeFileSync(targetFile, 'Hello, World!');

      logger.logFileOperation('backup', 'backup', sourceFile, targetFile);

      const entries = logger.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].data).toMatchObject({
        sourcePath: 'source.txt',
        targetPath: 'target.txt',
        sourceSize: 13,
        targetSize: 13,
      });
    });

    it('should log validation results', () => {
      logger.logValidation('validation', 'json-source', true, { count: 10 });

      let entries = logger.getEntries();
      expect(entries[0].level).toBe('info');
      expect(entries[0].data).toMatchObject({
        target: 'json-source',
        valid: true,
        count: 10,
      });
    });

    it('should log validation failures as errors', () => {
      logger.logValidation('validation', 'json-source', false, { count: 10 }, ['parse error']);

      let entries = logger.getEntries();
      expect(entries[0].level).toBe('error');
      expect(entries[0].data).toMatchObject({
        valid: false,
        errors: ['parse error'],
      });
    });

    it('should log import progress', () => {
      logger.logImportProgress('import', 'tasks', 50, 100);

      const entries = logger.getEntries();
      expect(entries[0].data).toMatchObject({
        imported: 50,
        total: 100,
        percent: 50,
        remaining: 50,
      });
    });

    it('should log phase transitions', () => {
      logger.phaseStart('validation');
      logger.phaseComplete('validation');

      const entries = logger.getEntries();
      expect(entries).toHaveLength(2);
      expect(entries[0].operation).toBe('start');
      expect(entries[1].operation).toBe('complete');
    });

    it('should log phase failures', () => {
      const error = new Error('Something went wrong');
      logger.phaseFailed('validation', error, { context: 'test' });

      const entries = logger.getEntries();
      expect(entries[0].level).toBe('error');
      expect(entries[0].operation).toBe('failed');
      expect(entries[0].data).toMatchObject({
        error: 'Something went wrong',
        context: 'test',
      });
    });
  });

  describe('log file format', () => {
    it('should write JSONL format to file', () => {
      logger.info('test', 'op1', 'Message 1');
      logger.info('test', 'op2', 'Message 2');

      const logPath = logger.getLogPath();
      const content = readFileSync(logPath, 'utf-8');
      const lines = content.trim().split('\n');

      expect(lines).toHaveLength(2);

      const entry1 = JSON.parse(lines[0]) as MigrationLogEntry;
      expect(entry1.message).toBe('Message 1');

      const entry2 = JSON.parse(lines[1]) as MigrationLogEntry;
      expect(entry2.message).toBe('Message 2');
    });
  });

  describe('query methods', () => {
    beforeEach(() => {
      logger.info('phase1', 'op1', 'Info message');
      logger.warn('phase1', 'op2', 'Warning message');
      logger.error('phase2', 'op3', 'Error message');
      logger.debug('phase2', 'op4', 'Debug message');
    });

    it('should filter entries by level', () => {
      const errors = logger.getEntriesByLevel('error');
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toBe('Error message');

      const warnings = logger.getEntriesByLevel('warn');
      expect(warnings).toHaveLength(1);
    });

    it('should filter entries by phase', () => {
      const phase1Entries = logger.getEntriesByPhase('phase1');
      expect(phase1Entries).toHaveLength(2);

      const phase2Entries = logger.getEntriesByPhase('phase2');
      expect(phase2Entries).toHaveLength(2);
    });

    it('should return summary statistics', () => {
      const summary = logger.getSummary();

      expect(summary.totalEntries).toBe(4);
      expect(summary.errors).toBe(1);
      expect(summary.warnings).toBe(1);
      expect(summary.info).toBe(1);
      expect(summary.debug).toBe(1);
      expect(summary.phases).toContain('phase1');
      expect(summary.phases).toContain('phase2');
      expect(summary.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('duration tracking', () => {
    it('should track duration from initialization', async () => {
      const startTime = Date.now();
      await new Promise(resolve => setTimeout(resolve, 50));

      const duration = logger.getDurationMs();
      expect(duration).toBeGreaterThanOrEqual(50);
    });

    it('should track duration in log entries', async () => {
      logger.info('test', 'op1', 'First');
      await new Promise(resolve => setTimeout(resolve, 50));
      logger.info('test', 'op2', 'Second');

      const entries = logger.getEntries();
      expect(entries[1].durationMs).toBeGreaterThan(entries[0].durationMs);
    });
  });
});

describe('helper functions', () => {
  let tempDir: string;
  let logger: MigrationLogger;

  beforeEach(() => {
    // Use unique timestamp + random to avoid conflicts
    tempDir = join(tmpdir(), `migration-helper-test-${Date.now()}-${Math.random().toString(36).substring(7)}`);
    mkdirSync(tempDir, { recursive: true });
    logger = new MigrationLogger(tempDir);
    logger.info('test', 'op', 'Test');
  });

  afterEach(() => {
    try {
      if (existsSync(tempDir)) {
        const { rmdirSync } = require('node:fs');
        rmdirSync(tempDir, { recursive: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  it('createMigrationLogger should create logger instance', () => {
    const newLogger = createMigrationLogger(tempDir);
    expect(newLogger).toBeInstanceOf(MigrationLogger);
  });

  it('readMigrationLog should parse log file', () => {
    const logPath = logger.getLogPath();
    const entries = readMigrationLog(logPath);

    expect(entries).toHaveLength(1);
    expect(entries[0].message).toBe('Test');
  });

  it('logFileExists should check file readability', () => {
    expect(logFileExists(logger.getLogPath())).toBe(true);
    expect(logFileExists('/nonexistent/file.jsonl')).toBe(false);
  });

  it('getLatestMigrationLog should return most recent log', async () => {
    // Wait to ensure different timestamps
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Create another logger (will have later timestamp)
    const logger2 = new MigrationLogger(tempDir);
    logger2.info('test', 'op2', 'Test 2');

    const latest = getLatestMigrationLog(tempDir);
    expect(latest).toBeDefined();

    const entries = readMigrationLog(latest!);
    expect(entries).toHaveLength(1);
    expect(entries[0].message).toBe('Test 2');
  });
});


