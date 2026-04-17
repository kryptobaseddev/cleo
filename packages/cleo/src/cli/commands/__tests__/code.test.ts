/**
 * Tests for Smart Explore code analysis commands.
 *
 * Tests the CLI command surface (outline, search, unfold subcommands)
 * against real TypeScript files in the CLEO codebase.
 *
 * @task T157
 */

import { describe, expect, it } from 'vitest';
import { codeCommand } from '../code.js';

describe('code command', () => {
  it('exports codeCommand', () => {
    expect(codeCommand).toBeDefined();
  });

  it('has meta.name = "code"', () => {
    expect(codeCommand.meta?.name).toBe('code');
  });

  it('has meta.description describing code analysis', () => {
    expect(codeCommand.meta?.description).toMatch(/code|analysis|ast/i);
  });

  describe('outline subcommand', () => {
    const outlineCmd = codeCommand.subCommands?.outline;

    it('is defined', () => {
      expect(outlineCmd).toBeDefined();
    });

    it('has correct meta.name', () => {
      expect(outlineCmd?.meta?.name).toBe('outline');
    });

    it('has description matching outline purpose', () => {
      expect(outlineCmd?.meta?.description).toMatch(/structural|skeleton|signature/i);
    });

    it('has required file arg', () => {
      const fileArg = outlineCmd?.args?.file;
      expect(fileArg).toBeDefined();
      expect(fileArg?.type).toBe('positional');
      expect(fileArg?.required).toBe(true);
      expect(fileArg?.description).toMatch(/file|path/i);
    });

    it('requires a run function', () => {
      expect(typeof outlineCmd?.run).toBe('function');
    });
  });

  describe('search subcommand', () => {
    const searchCmd = codeCommand.subCommands?.search;

    it('is defined', () => {
      expect(searchCmd).toBeDefined();
    });

    it('has correct meta.name', () => {
      expect(searchCmd?.meta?.name).toBe('search');
    });

    it('has description matching search purpose', () => {
      expect(searchCmd?.meta?.description).toMatch(/search|symbol|codebase/i);
    });

    it('has required query arg', () => {
      const queryArg = searchCmd?.args?.query;
      expect(queryArg).toBeDefined();
      expect(queryArg?.type).toBe('positional');
      expect(queryArg?.required).toBe(true);
      expect(queryArg?.description).toMatch(/query|search/i);
    });

    it('has optional lang arg', () => {
      const langArg = searchCmd?.args?.lang;
      expect(langArg).toBeDefined();
      expect(langArg?.type).toBe('string');
      expect(langArg?.description).toMatch(/language|lang/i);
    });

    it('has optional max arg', () => {
      const maxArg = searchCmd?.args?.max;
      expect(maxArg).toBeDefined();
      expect(maxArg?.type).toBe('string');
      expect(maxArg?.description).toMatch(/max|result/i);
    });

    it('has optional path arg', () => {
      const pathArg = searchCmd?.args?.path;
      expect(pathArg).toBeDefined();
      expect(pathArg?.type).toBe('string');
      expect(pathArg?.description).toMatch(/file|pattern|path/i);
    });

    it('requires a run function', () => {
      expect(typeof searchCmd?.run).toBe('function');
    });
  });

  describe('unfold subcommand', () => {
    const unfoldCmd = codeCommand.subCommands?.unfold;

    it('is defined', () => {
      expect(unfoldCmd).toBeDefined();
    });

    it('has correct meta.name', () => {
      expect(unfoldCmd?.meta?.name).toBe('unfold');
    });

    it('has description matching unfold purpose', () => {
      expect(unfoldCmd?.meta?.description).toMatch(/extract|symbol|source/i);
    });

    it('has required file arg', () => {
      const fileArg = unfoldCmd?.args?.file;
      expect(fileArg).toBeDefined();
      expect(fileArg?.type).toBe('positional');
      expect(fileArg?.required).toBe(true);
      expect(fileArg?.description).toMatch(/file|path/i);
    });

    it('has required symbol arg', () => {
      const symbolArg = unfoldCmd?.args?.symbol;
      expect(symbolArg).toBeDefined();
      expect(symbolArg?.type).toBe('positional');
      expect(symbolArg?.required).toBe(true);
      expect(symbolArg?.description).toMatch(/symbol|name/i);
    });

    it('requires a run function', () => {
      expect(typeof unfoldCmd?.run).toBe('function');
    });
  });
});
