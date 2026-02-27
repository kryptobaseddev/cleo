/**
 * Tests for CLI output with --field and --human flags.
 *
 * Verifies that:
 * - --field extracts a single field value from result data
 * - --fields filters multiple fields from result data
 * - --human uses human-readable renderers instead of JSON envelope
 * - --field + --human applies filter-then-render (LAFS section 5.4.1)
 *
 * @task T4820
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the format-context and field-context modules
vi.mock('../format-context.js', () => ({
  getFormatContext: vi.fn(),
  setFormatContext: vi.fn(),
  isJsonFormat: vi.fn(),
  isHumanFormat: vi.fn(),
  isQuiet: vi.fn(),
}));

vi.mock('../field-context.js', () => ({
  getFieldContext: vi.fn(),
  setFieldContext: vi.fn(),
  resolveFieldContext: vi.fn(),
}));

import { cliOutput } from '../renderers/index.js';
import { getFormatContext } from '../format-context.js';
import { getFieldContext } from '../field-context.js';
import type { FlagResolution } from '@cleocode/lafs-protocol';
import type { FieldExtractionResolution } from '@cleocode/lafs-protocol';

describe('cliOutput flag behavior', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
    vi.clearAllMocks();
  });

  describe('--human flag (format=human)', () => {
    it('uses human renderer for show command', () => {
      vi.mocked(getFormatContext).mockReturnValue({
        format: 'human',
        source: 'flag',
        quiet: false,
      } satisfies FlagResolution);
      vi.mocked(getFieldContext).mockReturnValue({
        mvi: 'standard',
        mviSource: 'default',
        expectsCustomMvi: false,
      } as FieldExtractionResolution);

      cliOutput(
        { id: 'T001', title: 'Test Task', status: 'pending', priority: 'high' },
        { command: 'show' },
      );

      expect(consoleSpy).toHaveBeenCalled();
      const output = consoleSpy.mock.calls[0]?.[0] as string;
      // Human renderer output should contain task info (not JSON envelope)
      expect(output).toBeDefined();
      expect(output).not.toContain('"$schema"');
    });

    it('uses generic renderer for unknown commands', () => {
      vi.mocked(getFormatContext).mockReturnValue({
        format: 'human',
        source: 'flag',
        quiet: false,
      } satisfies FlagResolution);
      vi.mocked(getFieldContext).mockReturnValue({
        mvi: 'standard',
        mviSource: 'default',
        expectsCustomMvi: false,
      } as FieldExtractionResolution);

      cliOutput(
        { key: 'value' },
        { command: 'unknown-command' },
      );

      // Should not throw — falls back to renderGeneric
      expect(consoleSpy).toHaveBeenCalled();
    });
  });

  describe('JSON format (default)', () => {
    it('outputs JSON envelope without field filters', () => {
      vi.mocked(getFormatContext).mockReturnValue({
        format: 'json',
        source: 'default',
        quiet: false,
      } satisfies FlagResolution);
      vi.mocked(getFieldContext).mockReturnValue({
        mvi: 'standard',
        mviSource: 'default',
        expectsCustomMvi: false,
      } as FieldExtractionResolution);

      cliOutput(
        { id: 'T001', title: 'Test' },
        { command: 'show' },
      );

      expect(consoleSpy).toHaveBeenCalled();
      const output = consoleSpy.mock.calls[0]?.[0] as string;
      const parsed = JSON.parse(output);
      expect(parsed.success).toBe(true);
    });
  });

  describe('--field flag (single field extraction)', () => {
    it('extracts a single field and writes to stdout', () => {
      vi.mocked(getFormatContext).mockReturnValue({
        format: 'json',
        source: 'default',
        quiet: false,
      } satisfies FlagResolution);
      vi.mocked(getFieldContext).mockReturnValue({
        field: 'title',
        mvi: 'standard',
        mviSource: 'default',
        expectsCustomMvi: false,
      } as FieldExtractionResolution);

      cliOutput(
        { id: 'T001', title: 'Test Task' },
        { command: 'show' },
      );

      expect(stdoutSpy).toHaveBeenCalledWith('Test Task\n');
    });

    it('extracts nested object field as JSON', () => {
      vi.mocked(getFormatContext).mockReturnValue({
        format: 'json',
        source: 'default',
        quiet: false,
      } satisfies FlagResolution);
      vi.mocked(getFieldContext).mockReturnValue({
        field: 'metadata',
        mvi: 'standard',
        mviSource: 'default',
        expectsCustomMvi: false,
      } as FieldExtractionResolution);

      cliOutput(
        { id: 'T001', metadata: { key: 'value' } },
        { command: 'show' },
      );

      expect(stdoutSpy).toHaveBeenCalledWith('{"key":"value"}\n');
    });
  });

  describe('--field + --human (filter-then-render)', () => {
    it('applies field extraction before human rendering', () => {
      vi.mocked(getFormatContext).mockReturnValue({
        format: 'human',
        source: 'flag',
        quiet: false,
      } satisfies FlagResolution);
      vi.mocked(getFieldContext).mockReturnValue({
        field: 'title',
        mvi: 'standard',
        mviSource: 'default',
        expectsCustomMvi: false,
      } as FieldExtractionResolution);

      cliOutput(
        { id: 'T001', title: 'Test Task', status: 'pending' },
        { command: 'show' },
      );

      // For primitive extracted values, it should print directly
      expect(consoleSpy).toHaveBeenCalledWith('Test Task');
    });
  });
});
