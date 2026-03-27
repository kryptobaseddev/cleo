import { describe, it, expect } from 'vitest';
import {
  parseMarkdownSections,
  classifySection,
  extractProperties,
  extractPermissions,
  headingToIdentifier,
  headingToEventName,
  getCaampEvents,
} from '../../src/migrate/markdown-parser';

describe('markdown-parser', () => {
  describe('parseMarkdownSections', () => {
    it('should split content by ## headings', () => {
      const content = `## Section One\nContent here.\n\n## Section Two\nMore content.`;
      const sections = parseMarkdownSections(content);
      expect(sections).toHaveLength(2);
      expect(sections[0]?.heading).toBe('Section One');
      expect(sections[1]?.heading).toBe('Section Two');
    });

    it('should split content by ### headings', () => {
      const content = `### Sub Section\nContent here.`;
      const sections = parseMarkdownSections(content);
      expect(sections).toHaveLength(1);
      expect(sections[0]?.level).toBe(3);
    });

    it('should track line numbers correctly', () => {
      const content = `\n\n## First\nLine 4\nLine 5\n\n## Second\nLine 8`;
      const sections = parseMarkdownSections(content);
      expect(sections[0]?.lineStart).toBe(3); // 1-based
      expect(sections[1]?.lineStart).toBe(7);
    });

    it('should capture body lines excluding heading', () => {
      const content = `## Agent\n- **Model**: opus\n- **Prompt**: hello`;
      const sections = parseMarkdownSections(content);
      expect(sections[0]?.bodyLines).toHaveLength(2);
      expect(sections[0]?.bodyLines[0]).toContain('Model');
    });

    it('should trim trailing blank lines from body', () => {
      const content = `## Test\nContent\n\n\n`;
      const sections = parseMarkdownSections(content);
      expect(sections[0]?.bodyLines).toHaveLength(1);
      expect(sections[0]?.bodyLines[0]).toBe('Content');
    });

    it('should handle empty content', () => {
      const sections = parseMarkdownSections('');
      expect(sections).toHaveLength(0);
    });

    it('should handle content with no headings', () => {
      const content = `Just plain text\nNo headings here`;
      const sections = parseMarkdownSections(content);
      expect(sections).toHaveLength(0);
    });

    it('should ignore # (h1) headings', () => {
      const content = `# Title\n\n## Real Section\nContent`;
      const sections = parseMarkdownSections(content);
      expect(sections).toHaveLength(1);
      expect(sections[0]?.heading).toBe('Real Section');
    });
  });

  describe('classifySection', () => {
    it('should classify agent headings', () => {
      expect(classifySection({
        heading: 'Code Review Agent',
        level: 2, lineStart: 1, lineEnd: 5, bodyLines: [], classification: 'unknown',
      })).toBe('agent');
    });

    it('should classify "Agent: Name" pattern', () => {
      expect(classifySection({
        heading: 'Agent: ops-lead',
        level: 2, lineStart: 1, lineEnd: 5, bodyLines: [], classification: 'unknown',
      })).toBe('agent');
    });

    it('should classify permission headings', () => {
      expect(classifySection({
        heading: 'Permissions',
        level: 2, lineStart: 1, lineEnd: 5, bodyLines: [], classification: 'unknown',
      })).toBe('permissions');
    });

    it('should classify hook headings', () => {
      expect(classifySection({
        heading: 'On Session Start',
        level: 3, lineStart: 1, lineEnd: 5, bodyLines: [], classification: 'unknown',
      })).toBe('hook');
    });

    it('should classify "Hooks" heading', () => {
      expect(classifySection({
        heading: 'Hooks',
        level: 2, lineStart: 1, lineEnd: 5, bodyLines: [], classification: 'unknown',
      })).toBe('hook');
    });

    it('should classify skill headings', () => {
      expect(classifySection({
        heading: 'Skills',
        level: 2, lineStart: 1, lineEnd: 5, bodyLines: [], classification: 'unknown',
      })).toBe('skill');
    });

    it('should classify workflow/procedure headings', () => {
      expect(classifySection({
        heading: 'Deploy Procedure',
        level: 2, lineStart: 1, lineEnd: 5, bodyLines: [], classification: 'unknown',
      })).toBe('workflow');
    });

    it('should classify by content when heading is ambiguous', () => {
      const section = {
        heading: 'Core Lead',
        level: 2, lineStart: 1, lineEnd: 5,
        bodyLines: [
          '- **Model**: opus',
          '- **Prompt**: coordinate operations',
          '- **Skills**: ct-cleo',
        ],
        classification: 'unknown' as const,
      };
      expect(classifySection(section)).toBe('agent');
    });

    it('should return unknown for unrecognized sections', () => {
      expect(classifySection({
        heading: 'Architecture Overview',
        level: 2, lineStart: 1, lineEnd: 5, bodyLines: ['Some text'], classification: 'unknown',
      })).toBe('unknown');
    });
  });

  describe('extractProperties', () => {
    it('should extract bold key-value pairs', () => {
      const lines = [
        '- **Model**: Opus',
        '- **Prompt**: You review code',
      ];
      const props = extractProperties(lines);
      expect(props).toHaveLength(2);
      expect(props[0]?.key).toBe('model');
      expect(props[0]?.value).toBe('Opus');
      expect(props[1]?.key).toBe('prompt');
    });

    it('should extract plain key-value pairs', () => {
      const lines = [
        '- Model: Opus',
        '- Skills: ct-cleo, ct-orchestrator',
      ];
      const props = extractProperties(lines);
      expect(props).toHaveLength(2);
      expect(props[1]?.key).toBe('skills');
    });

    it('should handle asterisk bullets', () => {
      const lines = ['* **Model**: Opus'];
      const props = extractProperties(lines);
      expect(props).toHaveLength(1);
    });

    it('should skip non-property lines', () => {
      const lines = [
        'Some plain text',
        '- **Model**: Opus',
        'More text',
      ];
      const props = extractProperties(lines);
      expect(props).toHaveLength(1);
    });

    it('should handle empty input', () => {
      expect(extractProperties([])).toHaveLength(0);
    });
  });

  describe('extractPermissions', () => {
    it('should extract structured permissions', () => {
      const lines = [
        '- Tasks: read, write',
        '- Session: read',
      ];
      const perms = extractPermissions(lines);
      expect(perms).toHaveLength(2);
      expect(perms[0]?.domain).toBe('tasks');
      expect(perms[0]?.values).toEqual(['read', 'write']);
      expect(perms[1]?.domain).toBe('session');
      expect(perms[1]?.values).toEqual(['read']);
    });

    it('should extract prose-style permissions', () => {
      const lines = ['- Read and write tasks'];
      const perms = extractPermissions(lines);
      expect(perms).toHaveLength(1);
      expect(perms[0]?.domain).toBe('tasks');
      expect(perms[0]?.values).toContain('read');
      expect(perms[0]?.values).toContain('write');
    });

    it('should filter invalid permission values', () => {
      const lines = ['- Tasks: read, admin, write'];
      const perms = extractPermissions(lines);
      expect(perms[0]?.values).toEqual(['read', 'write']);
    });

    it('should handle empty input', () => {
      expect(extractPermissions([])).toHaveLength(0);
    });
  });

  describe('headingToIdentifier', () => {
    it('should convert "Code Review Agent" to "code-review"', () => {
      expect(headingToIdentifier('Code Review Agent')).toBe('code-review');
    });

    it('should convert "Agent: ops-lead" to "ops-lead"', () => {
      expect(headingToIdentifier('Agent: ops-lead')).toBe('ops-lead');
    });

    it('should handle special characters', () => {
      expect(headingToIdentifier('My Agent (v2)')).toBe('my-v2');
    });

    it('should handle already clean identifiers', () => {
      expect(headingToIdentifier('security-scanner')).toBe('security-scanner');
    });
  });

  describe('headingToEventName', () => {
    it('should map "On Session Start" to "SessionStart"', () => {
      expect(headingToEventName('On Session Start')).toBe('SessionStart');
    });

    it('should map "On SessionEnd" to "SessionEnd"', () => {
      expect(headingToEventName('On SessionEnd')).toBe('SessionEnd');
    });

    it('should map "On PreToolUse" to "PreToolUse"', () => {
      expect(headingToEventName('On PreToolUse')).toBe('PreToolUse');
    });

    it('should return null for unrecognized events', () => {
      expect(headingToEventName('On Something Random')).toBeNull();
    });

    it('should return null for generic "Hooks" heading', () => {
      expect(headingToEventName('Hooks')).toBeNull();
    });

    it('should handle "When session starts" variant', () => {
      expect(headingToEventName('When session starts')).toBe('SessionStart');
    });

    it('should handle "When session ends" variant', () => {
      expect(headingToEventName('When session ends')).toBe('SessionEnd');
    });
  });

  describe('getCaampEvents', () => {
    it('should return all 16 CAAMP events', () => {
      const events = getCaampEvents();
      expect(events.size).toBe(16);
      expect(events.has('SessionStart')).toBe(true);
      expect(events.has('ConfigChange')).toBe(true);
    });
  });
});
