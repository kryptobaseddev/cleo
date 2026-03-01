/**
 * Tests for YAML frontmatter parser/writer.
 * @task T5200
 * @epic T4798
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseFrontmatter,
  serializeFrontmatter,
  addFrontmatter,
  buildFrontmatter,
} from '../frontmatter.js';
import type { FrontmatterMetadata } from '../frontmatter.js';

describe('parseFrontmatter', () => {
  it('parses valid frontmatter with all fields', () => {
    const content = `---
epic: T4881
stage: research
task: T5200
created: 2026-02-15
updated: 2026-02-20
---
# Research Notes

Some content here.
`;
    const result = parseFrontmatter(content);

    expect(result.frontmatter).not.toBeNull();
    expect(result.frontmatter!.epic).toBe('T4881');
    expect(result.frontmatter!.stage).toBe('research');
    expect(result.frontmatter!.task).toBe('T5200');
    expect(result.frontmatter!.created).toBe('2026-02-15');
    expect(result.frontmatter!.updated).toBe('2026-02-20');
    expect(result.body).toBe('# Research Notes\n\nSome content here.\n');
  });

  it('returns null frontmatter for content without frontmatter', () => {
    const content = '# Just a heading\n\nSome content.\n';
    const result = parseFrontmatter(content);

    expect(result.frontmatter).toBeNull();
    expect(result.body).toBe(content);
    expect(result.raw).toBe('');
  });

  it('parses frontmatter with related links array', () => {
    const content = `---
epic: T4881
stage: consensus
related:
  - type: research
    path: ../research/T4881_research.md
  - type: task
    id: T5200
---
# Consensus Report
`;
    const result = parseFrontmatter(content);

    expect(result.frontmatter).not.toBeNull();
    expect(result.frontmatter!.related).toHaveLength(2);
    expect(result.frontmatter!.related![0]).toEqual({
      type: 'research',
      path: '../research/T4881_research.md',
    });
    expect(result.frontmatter!.related![1]).toEqual({
      type: 'task',
      id: 'T5200',
    });
  });

  it('preserves body content after frontmatter', () => {
    const bodyContent = '# Title\n\nParagraph 1.\n\nParagraph 2.\n';
    const content = `---
epic: T001
stage: research
---
${bodyContent}`;
    const result = parseFrontmatter(content);

    expect(result.body).toBe(bodyContent);
  });

  it('handles frontmatter with boolean and null values', () => {
    const content = `---
epic: T001
stage: research
draft: true
reviewed: false
---
Content.
`;
    const result = parseFrontmatter(content);
    expect(result.frontmatter!.draft).toBe(true);
    expect(result.frontmatter!.reviewed).toBe(false);
  });
});

describe('serializeFrontmatter', () => {
  it('serializes basic metadata to YAML format', () => {
    const metadata: FrontmatterMetadata = {
      epic: 'T4881',
      stage: 'research',
      created: '2026-02-15',
      updated: '2026-02-20',
    };

    const result = serializeFrontmatter(metadata);

    expect(result).toContain('---\n');
    expect(result).toContain('epic: T4881');
    expect(result).toContain('stage: research');
    expect(result).toContain('created: 2026-02-15');
    expect(result).toContain('updated: 2026-02-20');
  });

  it('serializes with related links array', () => {
    const metadata: FrontmatterMetadata = {
      epic: 'T4881',
      stage: 'consensus',
      related: [
        { type: 'research', path: '../research/' },
        { type: 'task', id: 'T5200' },
      ],
    };

    const result = serializeFrontmatter(metadata);

    expect(result).toContain('related:');
    expect(result).toContain('  - type: research');
    expect(result).toContain('    path: ../research/');
    expect(result).toContain('  - type: task');
    expect(result).toContain('    id: T5200');
  });

  it('starts with --- and ends with ---', () => {
    const metadata: FrontmatterMetadata = {
      epic: 'T001',
      stage: 'research',
    };

    const result = serializeFrontmatter(metadata);

    expect(result.startsWith('---\n')).toBe(true);
    expect(result.trimEnd().endsWith('---')).toBe(true);
  });

  it('orders keys: epic, stage, task first, then dates', () => {
    const metadata: FrontmatterMetadata = {
      epic: 'T001',
      stage: 'research',
      task: 'T002',
      created: '2026-01-01',
      updated: '2026-01-02',
    };

    const result = serializeFrontmatter(metadata);
    const lines = result.split('\n');

    // Find positions of each key
    const epicIdx = lines.findIndex((l) => l.startsWith('epic:'));
    const stageIdx = lines.findIndex((l) => l.startsWith('stage:'));
    const taskIdx = lines.findIndex((l) => l.startsWith('task:'));
    const createdIdx = lines.findIndex((l) => l.startsWith('created:'));
    const updatedIdx = lines.findIndex((l) => l.startsWith('updated:'));

    expect(epicIdx).toBeLessThan(stageIdx);
    expect(stageIdx).toBeLessThan(taskIdx);
    expect(taskIdx).toBeLessThan(createdIdx);
    expect(createdIdx).toBeLessThan(updatedIdx);
  });

  it('quotes strings containing special characters', () => {
    const metadata: FrontmatterMetadata = {
      epic: 'T001',
      stage: 'research',
      note: 'value: with colon' as unknown as string,
    };

    const result = serializeFrontmatter(metadata);
    expect(result).toContain('"value: with colon"');
  });
});

describe('addFrontmatter', () => {
  it('adds frontmatter to content without existing frontmatter', () => {
    const content = '# Research Notes\n\nSome findings.\n';
    const metadata: FrontmatterMetadata = {
      epic: 'T4881',
      stage: 'research',
    };

    const result = addFrontmatter(content, metadata);

    expect(result.startsWith('---\n')).toBe(true);
    expect(result).toContain('epic: T4881');
    expect(result).toContain('# Research Notes');
    expect(result).toContain('Some findings.');
  });

  it('replaces existing frontmatter while preserving body', () => {
    const content = `---
epic: T001
stage: research
---
# Original Body

Content here.
`;
    const newMetadata: FrontmatterMetadata = {
      epic: 'T002',
      stage: 'consensus',
    };

    const result = addFrontmatter(content, newMetadata);

    expect(result).toContain('epic: T002');
    expect(result).toContain('stage: consensus');
    expect(result).not.toContain('epic: T001');
    expect(result).toContain('# Original Body');
    expect(result).toContain('Content here.');
  });
});

describe('buildFrontmatter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds correct metadata object with required fields', () => {
    const metadata = buildFrontmatter('T4881', 'research');

    expect(metadata.epic).toBe('T4881');
    expect(metadata.stage).toBe('research');
    expect(metadata.updated).toBeDefined();
    expect(metadata.created).toBeDefined();
  });

  it('includes task when provided', () => {
    const metadata = buildFrontmatter('T4881', 'research', { task: 'T5200' });

    expect(metadata.task).toBe('T5200');
  });

  it('includes related links when provided', () => {
    const metadata = buildFrontmatter('T4881', 'consensus', {
      related: [{ type: 'research', path: '../research/' }],
    });

    expect(metadata.related).toHaveLength(1);
    expect(metadata.related![0]!.type).toBe('research');
  });

  it('auto-sets updated to current date', () => {
    const metadata = buildFrontmatter('T001', 'research');
    const today = new Date().toISOString().split('T')[0]!;
    expect(metadata.updated).toBe(today);
  });

  it('uses provided created date', () => {
    const metadata = buildFrontmatter('T001', 'research', {
      created: '2026-01-15',
    });
    expect(metadata.created).toBe('2026-01-15');
  });

  it('defaults created to current date if not provided', () => {
    const metadata = buildFrontmatter('T001', 'research');
    const today = new Date().toISOString().split('T')[0]!;
    expect(metadata.created).toBe(today);
  });
});
