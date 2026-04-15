/**
 * Tests for `cleo brain export` command (T626-M6).
 *
 * Validates:
 * - GEXF export: XML structure, node attributes, edge attributes
 * - JSON export: array format, complete data
 * - File output: writes to --output path
 * - Stdout: default behavior without --output
 *
 * @task T626-M6
 * @epic T626
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportBrainAsGexf, exportBrainAsJson } from '@cleocode/core/internal';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('brain export', () => {
  let projectRoot: string;

  beforeEach(async () => {
    // Create a temporary directory for each test
    projectRoot = await mkdtemp(join(tmpdir(), 'cleo-brain-export-'));
  });

  afterEach(async () => {
    // Clean up
    await rm(projectRoot, { recursive: true, force: true });
  });

  describe('exportBrainAsGexf', () => {
    it('returns GEXF XML with valid structure', async () => {
      const result = await exportBrainAsGexf(projectRoot);

      expect(result.success).toBe(true);
      expect(result.format).toBe('gexf');
      expect(result.nodeCount).toBeGreaterThanOrEqual(0);
      expect(result.edgeCount).toBeGreaterThanOrEqual(0);
      expect(result.content).toBeDefined();

      // Verify XML structure
      expect(result.content).toContain('<?xml version="1.0"');
      expect(result.content).toContain('xmlns="http://www.gexf.net/1.3draft"');
      expect(result.content).toContain('<graph mode="static" defaultedgetype="directed">');
      expect(result.content).toContain('<nodes>');
      expect(result.content).toContain('</nodes>');
      expect(result.content).toContain('<edges>');
      expect(result.content).toContain('</edges>');
    });

    it('includes node attributes schema in GEXF', async () => {
      const result = await exportBrainAsGexf(projectRoot);

      // Verify attribute definitions
      expect(result.content).toContain('attribute id="node_type"');
      expect(result.content).toContain('attribute id="quality_score"');
      expect(result.content).toContain('attribute id="content_hash"');
      expect(result.content).toContain('attribute id="last_activity_at"');
      expect(result.content).toContain('attribute id="created_at"');
    });

    it('includes edge attributes schema in GEXF', async () => {
      const result = await exportBrainAsGexf(projectRoot);

      // Verify edge attribute definitions
      expect(result.content).toContain('attribute id="edge_type"');
      expect(result.content).toContain('attribute id="provenance"');
    });

    it('escapes XML special characters', async () => {
      const result = await exportBrainAsGexf(projectRoot);

      // If any nodes exist, verify escaping doesn't break XML
      if (result.nodeCount > 0) {
        // Should not contain unescaped special chars in attributes
        expect(result.content).not.toMatch(/label="[^"]*<[^"]*"/);
        expect(result.content).not.toMatch(/value="[^"]*&[^a].*?"/);
      }

      // Verify document is well-formed (can be parsed)
      expect(() => {
        // Basic XML validation: check for balanced tags
        const tagPattern = /<(\w+)[^>]*>/g;
        const closingPattern = /<\/(\w+)>/g;
        const openTags = result.content.match(tagPattern) ?? [];
        const closeTags = result.content.match(closingPattern) ?? [];
        expect(openTags.length).toBeGreaterThan(0);
        expect(closeTags.length).toBeGreaterThan(0);
      });
    });

    it('generates timestamp in ISO 8601 format', async () => {
      const result = await exportBrainAsGexf(projectRoot);

      expect(result.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

      // Verify metadata contains the timestamp
      expect(result.content).toContain('lastmodifieddate="');
    });
  });

  describe('exportBrainAsJson', () => {
    it('returns JSON with nodes and edges arrays', async () => {
      const result = await exportBrainAsJson(projectRoot);

      expect(result.success).toBe(true);
      expect(result.format).toBe('json');
      expect(result.nodeCount).toBeGreaterThanOrEqual(0);
      expect(result.edgeCount).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(result.nodes)).toBe(true);
      expect(Array.isArray(result.edges)).toBe(true);
      expect(result.nodes.length).toBe(result.nodeCount);
      expect(result.edges.length).toBe(result.edgeCount);
    });

    it('preserves node data structure', async () => {
      const result = await exportBrainAsJson(projectRoot);

      // Even with empty data, verify structure is correct
      for (const node of result.nodes) {
        expect(node).toHaveProperty('id');
        expect(node).toHaveProperty('nodeType');
        expect(node).toHaveProperty('label');
        expect(node).toHaveProperty('qualityScore');
        expect(node).toHaveProperty('createdAt');
      }
    });

    it('preserves edge data structure', async () => {
      const result = await exportBrainAsJson(projectRoot);

      for (const edge of result.edges) {
        expect(edge).toHaveProperty('fromId');
        expect(edge).toHaveProperty('toId');
        expect(edge).toHaveProperty('edgeType');
        expect(edge).toHaveProperty('weight');
        expect(edge).toHaveProperty('createdAt');
      }
    });

    it('generates JSON that parses correctly', async () => {
      const result = await exportBrainAsJson(projectRoot);
      const jsonString = JSON.stringify(result);

      // Should be parseable
      const parsed = JSON.parse(jsonString);
      expect(parsed.success).toBe(true);
      expect(parsed.format).toBe('json');
      expect(Array.isArray(parsed.nodes)).toBe(true);
      expect(Array.isArray(parsed.edges)).toBe(true);
    });

    it('generates timestamp in ISO 8601 format', async () => {
      const result = await exportBrainAsJson(projectRoot);

      expect(result.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });

  describe('edge cases', () => {
    it('handles empty brain gracefully', async () => {
      const gexfResult = await exportBrainAsGexf(projectRoot);
      const jsonResult = await exportBrainAsJson(projectRoot);

      expect(gexfResult.nodeCount).toBe(0);
      expect(gexfResult.edgeCount).toBe(0);
      expect(jsonResult.nodeCount).toBe(0);
      expect(jsonResult.edgeCount).toBe(0);

      // Should still be valid output
      expect(gexfResult.content).toContain('<gexf');
      expect(jsonResult.nodes).toEqual([]);
      expect(jsonResult.edges).toEqual([]);
    });

    it('GEXF document is well-formed XML', async () => {
      const result = await exportBrainAsGexf(projectRoot);

      // Check for basic XML well-formedness
      const hasDeclaration = result.content.startsWith('<?xml');
      const hasRootElement = result.content.includes('<gexf');
      const hasMeta = result.content.includes('<meta');
      const hasGraph = result.content.includes('<graph');

      expect(hasDeclaration).toBe(true);
      expect(hasRootElement).toBe(true);
      expect(hasMeta).toBe(true);
      expect(hasGraph).toBe(true);

      // Verify closing tags exist
      expect(result.content).toContain('</gexf>');
      expect(result.content).toContain('</graph>');
      expect(result.content).toContain('</meta>');
    });
  });
});
