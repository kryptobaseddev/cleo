/**
 * Brain graph export functionality — GEXF (Gephi standard) and JSON formats.
 *
 * Exports brain_page_nodes and brain_page_edges as:
 * - GEXF XML: Gephi-compatible graph interchange format with attributes
 * - JSON: Flat array representation for tooling integration
 *
 * @task T626-M6
 * @epic T626
 */

import type { BrainPageEdgeRow, BrainPageNodeRow } from '../store/brain-schema.js';
import { getBrainAccessor } from '../store/brain-accessor.js';

/**
 * GEXF export result with XML content.
 */
export interface BrainExportGexfResult {
  success: boolean;
  format: 'gexf';
  nodeCount: number;
  edgeCount: number;
  content: string;
  generatedAt: string;
}

/**
 * JSON export result with nodes and edges arrays.
 */
export interface BrainExportJsonResult {
  success: boolean;
  format: 'json';
  nodeCount: number;
  edgeCount: number;
  nodes: BrainPageNodeRow[];
  edges: BrainPageEdgeRow[];
  generatedAt: string;
}

export type BrainExportResult = BrainExportGexfResult | BrainExportJsonResult;

/**
 * Export brain graph as GEXF XML (Gephi standard format).
 *
 * Generates a valid GEXF 1.3 document with:
 * - Node elements with attributes (type, quality, label)
 * - Edge elements with weight and provenance
 * - Static, directed graph
 *
 * @param projectRoot - Root directory of the CLEO project
 * @returns GEXF XML export result
 *
 * @example
 * ```ts
 * const result = await exportBrainAsGexf('/path/to/project');
 * console.log(result.content); // Valid XML for import into Gephi
 * ```
 */
export async function exportBrainAsGexf(projectRoot: string): Promise<BrainExportGexfResult> {
  const accessor = await getBrainAccessor(projectRoot);

  // Fetch all nodes and edges
  // Note: May fail on older schemas without certain columns; in that case, default to empty
  let nodes: BrainPageNodeRow[] = [];
  let edges: BrainPageEdgeRow[] = [];

  try {
    nodes = await accessor.findPageNodes();
    edges = await accessor.findPageEdges();
  } catch (err) {
    // If the graph tables don't exist or are missing columns, return empty export
    // (This can happen on fresh installs or migrations)
    console.warn('Note: brain_page_nodes or brain_page_edges tables may be missing or incomplete');
  }

  // Build GEXF document
  const gexf = buildGexfDocument(nodes, edges);

  return {
    success: true,
    format: 'gexf',
    nodeCount: nodes.length,
    edgeCount: edges.length,
    content: gexf,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Export brain graph as JSON.
 *
 * Outputs nodes and edges as flat arrays for programmatic processing.
 * Suitable for visualization libraries and data integration.
 *
 * @param projectRoot - Root directory of the CLEO project
 * @returns JSON export result with nodes and edges arrays
 *
 * @example
 * ```ts
 * const result = await exportBrainAsJson('/path/to/project');
 * console.log(JSON.stringify(result, null, 2)); // Pretty-printed JSON
 * ```
 */
export async function exportBrainAsJson(projectRoot: string): Promise<BrainExportJsonResult> {
  const accessor = await getBrainAccessor(projectRoot);

  // Fetch all nodes and edges
  // Note: May fail on older schemas without certain columns; in that case, default to empty
  let nodes: BrainPageNodeRow[] = [];
  let edges: BrainPageEdgeRow[] = [];

  try {
    nodes = await accessor.findPageNodes();
    edges = await accessor.findPageEdges();
  } catch (err) {
    // If the graph tables don't exist or are missing columns, return empty export
    // (This can happen on fresh installs or migrations)
    console.warn('Note: brain_page_nodes or brain_page_edges tables may be missing or incomplete');
  }

  return {
    success: true,
    format: 'json',
    nodeCount: nodes.length,
    edgeCount: edges.length,
    nodes,
    edges,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Build a GEXF 1.3 XML document from nodes and edges.
 *
 * GEXF structure:
 * - gexf@xmlns, @version
 * - graph@mode=static, @defaultedgetype=directed
 * - nodes with attvalues (node_type, quality_score, label)
 * - edges with attributes (edge_type, weight, provenance)
 *
 * @param nodes - Array of brain page nodes
 * @param edges - Array of brain page edges
 * @returns Valid GEXF 1.3 XML string
 */
function buildGexfDocument(nodes: BrainPageNodeRow[], edges: BrainPageEdgeRow[]): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gexf xmlns="http://www.gexf.net/1.3draft" version="1.3">',
    '  <meta lastmodifieddate="' + new Date().toISOString() + '">',
    '    <creator>CLEO Brain Export (T626-M6)</creator>',
    '    <description>Living brain knowledge graph (brain_page_nodes + brain_page_edges)</description>',
    '  </meta>',
    '  <graph mode="static" defaultedgetype="directed">',
  ];

  // Define node attributes schema
  lines.push('    <attributes class="node">');
  lines.push('      <attribute id="node_type" title="Node Type" type="string"/>');
  lines.push('      <attribute id="quality_score" title="Quality Score" type="double"/>');
  lines.push('      <attribute id="content_hash" title="Content Hash" type="string"/>');
  lines.push('      <attribute id="last_activity_at" title="Last Activity" type="string"/>');
  lines.push('      <attribute id="created_at" title="Created At" type="string"/>');
  lines.push('    </attributes>');

  // Define edge attributes schema
  lines.push('    <attributes class="edge">');
  lines.push('      <attribute id="edge_type" title="Edge Type" type="string"/>');
  lines.push('      <attribute id="provenance" title="Provenance" type="string"/>');
  lines.push('      <attribute id="created_at" title="Created At" type="string"/>');
  lines.push('    </attributes>');

  // Add nodes
  lines.push('    <nodes>');
  for (const node of nodes) {
    lines.push(`      <node id="${escapeXml(node.id)}" label="${escapeXml(node.label)}">`);
    lines.push('        <attvalues>');
    lines.push(`          <attvalue for="node_type" value="${escapeXml(node.nodeType)}"/>`);
    lines.push(`          <attvalue for="quality_score" value="${node.qualityScore ?? 0.5}"/>`);
    if (node.contentHash) {
      lines.push(`          <attvalue for="content_hash" value="${escapeXml(node.contentHash)}"/>`);
    }
    lines.push(
      `          <attvalue for="last_activity_at" value="${escapeXml(node.lastActivityAt)}"/>`,
    );
    lines.push(`          <attvalue for="created_at" value="${escapeXml(node.createdAt)}"/>`);
    lines.push('        </attvalues>');
    lines.push('      </node>');
  }
  lines.push('    </nodes>');

  // Add edges
  lines.push('    <edges>');
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    const weight = edge.weight ?? 1.0;
    lines.push(
      `      <edge id="${i}" source="${escapeXml(edge.fromId)}" target="${escapeXml(edge.toId)}" weight="${weight}">`,
    );
    lines.push('        <attvalues>');
    lines.push(`          <attvalue for="edge_type" value="${escapeXml(edge.edgeType)}"/>`);
    if (edge.provenance) {
      lines.push(`          <attvalue for="provenance" value="${escapeXml(edge.provenance)}"/>`);
    }
    lines.push(`          <attvalue for="created_at" value="${escapeXml(edge.createdAt)}"/>`);
    lines.push('        </attvalues>');
    lines.push('      </edge>');
  }
  lines.push('    </edges>');

  lines.push('  </graph>');
  lines.push('</gexf>');

  return lines.join('\n');
}

/**
 * Escape XML special characters to prevent injection/parsing errors.
 *
 * @param text - Text to escape
 * @returns XML-safe string
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
