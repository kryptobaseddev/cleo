"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const markdown_parser_1 = require("../../src/migrate/markdown-parser");
(0, vitest_1.describe)('markdown-parser', () => {
    (0, vitest_1.describe)('parseMarkdownSections', () => {
        (0, vitest_1.it)('should split content by ## headings', () => {
            const content = `## Section One\nContent here.\n\n## Section Two\nMore content.`;
            const sections = (0, markdown_parser_1.parseMarkdownSections)(content);
            (0, vitest_1.expect)(sections).toHaveLength(2);
            (0, vitest_1.expect)(sections[0]?.heading).toBe('Section One');
            (0, vitest_1.expect)(sections[1]?.heading).toBe('Section Two');
        });
        (0, vitest_1.it)('should split content by ### headings', () => {
            const content = `### Sub Section\nContent here.`;
            const sections = (0, markdown_parser_1.parseMarkdownSections)(content);
            (0, vitest_1.expect)(sections).toHaveLength(1);
            (0, vitest_1.expect)(sections[0]?.level).toBe(3);
        });
        (0, vitest_1.it)('should track line numbers correctly', () => {
            const content = `\n\n## First\nLine 4\nLine 5\n\n## Second\nLine 8`;
            const sections = (0, markdown_parser_1.parseMarkdownSections)(content);
            (0, vitest_1.expect)(sections[0]?.lineStart).toBe(3); // 1-based
            (0, vitest_1.expect)(sections[1]?.lineStart).toBe(7);
        });
        (0, vitest_1.it)('should capture body lines excluding heading', () => {
            const content = `## Agent\n- **Model**: opus\n- **Prompt**: hello`;
            const sections = (0, markdown_parser_1.parseMarkdownSections)(content);
            (0, vitest_1.expect)(sections[0]?.bodyLines).toHaveLength(2);
            (0, vitest_1.expect)(sections[0]?.bodyLines[0]).toContain('Model');
        });
        (0, vitest_1.it)('should trim trailing blank lines from body', () => {
            const content = `## Test\nContent\n\n\n`;
            const sections = (0, markdown_parser_1.parseMarkdownSections)(content);
            (0, vitest_1.expect)(sections[0]?.bodyLines).toHaveLength(1);
            (0, vitest_1.expect)(sections[0]?.bodyLines[0]).toBe('Content');
        });
        (0, vitest_1.it)('should handle empty content', () => {
            const sections = (0, markdown_parser_1.parseMarkdownSections)('');
            (0, vitest_1.expect)(sections).toHaveLength(0);
        });
        (0, vitest_1.it)('should handle content with no headings', () => {
            const content = `Just plain text\nNo headings here`;
            const sections = (0, markdown_parser_1.parseMarkdownSections)(content);
            (0, vitest_1.expect)(sections).toHaveLength(0);
        });
        (0, vitest_1.it)('should ignore # (h1) headings', () => {
            const content = `# Title\n\n## Real Section\nContent`;
            const sections = (0, markdown_parser_1.parseMarkdownSections)(content);
            (0, vitest_1.expect)(sections).toHaveLength(1);
            (0, vitest_1.expect)(sections[0]?.heading).toBe('Real Section');
        });
    });
    (0, vitest_1.describe)('classifySection', () => {
        (0, vitest_1.it)('should classify agent headings', () => {
            (0, vitest_1.expect)((0, markdown_parser_1.classifySection)({
                heading: 'Code Review Agent',
                level: 2, lineStart: 1, lineEnd: 5, bodyLines: [], classification: 'unknown',
            })).toBe('agent');
        });
        (0, vitest_1.it)('should classify "Agent: Name" pattern', () => {
            (0, vitest_1.expect)((0, markdown_parser_1.classifySection)({
                heading: 'Agent: ops-lead',
                level: 2, lineStart: 1, lineEnd: 5, bodyLines: [], classification: 'unknown',
            })).toBe('agent');
        });
        (0, vitest_1.it)('should classify permission headings', () => {
            (0, vitest_1.expect)((0, markdown_parser_1.classifySection)({
                heading: 'Permissions',
                level: 2, lineStart: 1, lineEnd: 5, bodyLines: [], classification: 'unknown',
            })).toBe('permissions');
        });
        (0, vitest_1.it)('should classify hook headings', () => {
            (0, vitest_1.expect)((0, markdown_parser_1.classifySection)({
                heading: 'On Session Start',
                level: 3, lineStart: 1, lineEnd: 5, bodyLines: [], classification: 'unknown',
            })).toBe('hook');
        });
        (0, vitest_1.it)('should classify "Hooks" heading', () => {
            (0, vitest_1.expect)((0, markdown_parser_1.classifySection)({
                heading: 'Hooks',
                level: 2, lineStart: 1, lineEnd: 5, bodyLines: [], classification: 'unknown',
            })).toBe('hook');
        });
        (0, vitest_1.it)('should classify skill headings', () => {
            (0, vitest_1.expect)((0, markdown_parser_1.classifySection)({
                heading: 'Skills',
                level: 2, lineStart: 1, lineEnd: 5, bodyLines: [], classification: 'unknown',
            })).toBe('skill');
        });
        (0, vitest_1.it)('should classify workflow/procedure headings', () => {
            (0, vitest_1.expect)((0, markdown_parser_1.classifySection)({
                heading: 'Deploy Procedure',
                level: 2, lineStart: 1, lineEnd: 5, bodyLines: [], classification: 'unknown',
            })).toBe('workflow');
        });
        (0, vitest_1.it)('should classify by content when heading is ambiguous', () => {
            const section = {
                heading: 'Core Lead',
                level: 2, lineStart: 1, lineEnd: 5,
                bodyLines: [
                    '- **Model**: opus',
                    '- **Prompt**: coordinate operations',
                    '- **Skills**: ct-cleo',
                ],
                classification: 'unknown',
            };
            (0, vitest_1.expect)((0, markdown_parser_1.classifySection)(section)).toBe('agent');
        });
        (0, vitest_1.it)('should return unknown for unrecognized sections', () => {
            (0, vitest_1.expect)((0, markdown_parser_1.classifySection)({
                heading: 'Architecture Overview',
                level: 2, lineStart: 1, lineEnd: 5, bodyLines: ['Some text'], classification: 'unknown',
            })).toBe('unknown');
        });
    });
    (0, vitest_1.describe)('extractProperties', () => {
        (0, vitest_1.it)('should extract bold key-value pairs', () => {
            const lines = [
                '- **Model**: Opus',
                '- **Prompt**: You review code',
            ];
            const props = (0, markdown_parser_1.extractProperties)(lines);
            (0, vitest_1.expect)(props).toHaveLength(2);
            (0, vitest_1.expect)(props[0]?.key).toBe('model');
            (0, vitest_1.expect)(props[0]?.value).toBe('Opus');
            (0, vitest_1.expect)(props[1]?.key).toBe('prompt');
        });
        (0, vitest_1.it)('should extract plain key-value pairs', () => {
            const lines = [
                '- Model: Opus',
                '- Skills: ct-cleo, ct-orchestrator',
            ];
            const props = (0, markdown_parser_1.extractProperties)(lines);
            (0, vitest_1.expect)(props).toHaveLength(2);
            (0, vitest_1.expect)(props[1]?.key).toBe('skills');
        });
        (0, vitest_1.it)('should handle asterisk bullets', () => {
            const lines = ['* **Model**: Opus'];
            const props = (0, markdown_parser_1.extractProperties)(lines);
            (0, vitest_1.expect)(props).toHaveLength(1);
        });
        (0, vitest_1.it)('should skip non-property lines', () => {
            const lines = [
                'Some plain text',
                '- **Model**: Opus',
                'More text',
            ];
            const props = (0, markdown_parser_1.extractProperties)(lines);
            (0, vitest_1.expect)(props).toHaveLength(1);
        });
        (0, vitest_1.it)('should handle empty input', () => {
            (0, vitest_1.expect)((0, markdown_parser_1.extractProperties)([])).toHaveLength(0);
        });
    });
    (0, vitest_1.describe)('extractPermissions', () => {
        (0, vitest_1.it)('should extract structured permissions', () => {
            const lines = [
                '- Tasks: read, write',
                '- Session: read',
            ];
            const perms = (0, markdown_parser_1.extractPermissions)(lines);
            (0, vitest_1.expect)(perms).toHaveLength(2);
            (0, vitest_1.expect)(perms[0]?.domain).toBe('tasks');
            (0, vitest_1.expect)(perms[0]?.values).toEqual(['read', 'write']);
            (0, vitest_1.expect)(perms[1]?.domain).toBe('session');
            (0, vitest_1.expect)(perms[1]?.values).toEqual(['read']);
        });
        (0, vitest_1.it)('should extract prose-style permissions', () => {
            const lines = ['- Read and write tasks'];
            const perms = (0, markdown_parser_1.extractPermissions)(lines);
            (0, vitest_1.expect)(perms).toHaveLength(1);
            (0, vitest_1.expect)(perms[0]?.domain).toBe('tasks');
            (0, vitest_1.expect)(perms[0]?.values).toContain('read');
            (0, vitest_1.expect)(perms[0]?.values).toContain('write');
        });
        (0, vitest_1.it)('should filter invalid permission values', () => {
            const lines = ['- Tasks: read, admin, write'];
            const perms = (0, markdown_parser_1.extractPermissions)(lines);
            (0, vitest_1.expect)(perms[0]?.values).toEqual(['read', 'write']);
        });
        (0, vitest_1.it)('should handle empty input', () => {
            (0, vitest_1.expect)((0, markdown_parser_1.extractPermissions)([])).toHaveLength(0);
        });
    });
    (0, vitest_1.describe)('headingToIdentifier', () => {
        (0, vitest_1.it)('should convert "Code Review Agent" to "code-review"', () => {
            (0, vitest_1.expect)((0, markdown_parser_1.headingToIdentifier)('Code Review Agent')).toBe('code-review');
        });
        (0, vitest_1.it)('should convert "Agent: ops-lead" to "ops-lead"', () => {
            (0, vitest_1.expect)((0, markdown_parser_1.headingToIdentifier)('Agent: ops-lead')).toBe('ops-lead');
        });
        (0, vitest_1.it)('should handle special characters', () => {
            (0, vitest_1.expect)((0, markdown_parser_1.headingToIdentifier)('My Agent (v2)')).toBe('my-v2');
        });
        (0, vitest_1.it)('should handle already clean identifiers', () => {
            (0, vitest_1.expect)((0, markdown_parser_1.headingToIdentifier)('security-scanner')).toBe('security-scanner');
        });
    });
    (0, vitest_1.describe)('headingToEventName', () => {
        (0, vitest_1.it)('should map "On Session Start" to "SessionStart"', () => {
            (0, vitest_1.expect)((0, markdown_parser_1.headingToEventName)('On Session Start')).toBe('SessionStart');
        });
        (0, vitest_1.it)('should map "On SessionEnd" to "SessionEnd"', () => {
            (0, vitest_1.expect)((0, markdown_parser_1.headingToEventName)('On SessionEnd')).toBe('SessionEnd');
        });
        (0, vitest_1.it)('should map "On PreToolUse" to "PreToolUse"', () => {
            (0, vitest_1.expect)((0, markdown_parser_1.headingToEventName)('On PreToolUse')).toBe('PreToolUse');
        });
        (0, vitest_1.it)('should return null for unrecognized events', () => {
            (0, vitest_1.expect)((0, markdown_parser_1.headingToEventName)('On Something Random')).toBeNull();
        });
        (0, vitest_1.it)('should return null for generic "Hooks" heading', () => {
            (0, vitest_1.expect)((0, markdown_parser_1.headingToEventName)('Hooks')).toBeNull();
        });
        (0, vitest_1.it)('should handle "When session starts" variant', () => {
            (0, vitest_1.expect)((0, markdown_parser_1.headingToEventName)('When session starts')).toBe('SessionStart');
        });
        (0, vitest_1.it)('should handle "When session ends" variant', () => {
            (0, vitest_1.expect)((0, markdown_parser_1.headingToEventName)('When session ends')).toBe('SessionEnd');
        });
    });
    (0, vitest_1.describe)('getCaampEvents', () => {
        (0, vitest_1.it)('should return all 16 CAAMP events', () => {
            const events = (0, markdown_parser_1.getCaampEvents)();
            (0, vitest_1.expect)(events.size).toBe(16);
            (0, vitest_1.expect)(events.has('SessionStart')).toBe(true);
            (0, vitest_1.expect)(events.has('ConfigChange')).toBe(true);
        });
    });
});
//# sourceMappingURL=markdown-parser.test.js.map