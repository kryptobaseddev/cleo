/**
 * NEXUS GEXF export utilities.
 *
 * Generates GEXF (Gephi Graph Exchange XML Format) from nexus graph nodes and
 * relations. Supports node attributes, edge weights (confidence), and color
 * coding by node kind.
 *
 * @task T1473
 */

/**
 * Escape XML special characters.
 *
 * @param str - Input string to escape.
 * @returns XML-safe string.
 *
 * @example
 * escapeXml('<foo>') // '&lt;foo&gt;'
 */
export function escapeXml(str: string): string {
  return String(str).replace(/[<>"'&]/g, (c) => {
    const map: Record<string, string> = {
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "\'": '&apos;',
      '&': '&amp;',
    };
    return map[c];
  });
}

/**
 * Convert hex color to RGB object.
 *
 * @param hex - Hex color string (e.g. '#3498db' or '3498db').
 * @returns RGB components.
 *
 * @example
 * hexToRgb('#3498db') // { r: 52, g: 152, b: 219 }
 */
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : { r: 127, g: 140, b: 141 };
}

/**
 * Generate GEXF (Gephi Graph Exchange XML Format) from nodes and relations.
 *
 * @param nodes - Array of nexus nodes (plain record objects from DB).
 * @param relations - Array of nexus relations (plain record objects from DB).
 * @returns GEXF XML string ready for Gephi or other graph tools.
 *
 * @example
 * const xml = generateGexf(nodes, relations);
 * writeFileSync('graph.gexf', xml);
 */
export function generateGexf(
  nodes: Array<Record<string, unknown>>,
  relations: Array<Record<string, unknown>>,
): string {
  const nodeById = new Map<string, Record<string, unknown>>();
  for (const n of nodes) {
    nodeById.set(String(n['id']), n);
  }

  const kindColors: Record<string, string> = {
    function: '#3498db',
    method: '#2980b9',
    class: '#e74c3c',
    interface: '#e67e22',
    file: '#95a5a6',
    folder: '#34495e',
    community: '#9b59b6',
    process: '#1abc9c',
    import: '#f39c12',
    default: '#7f8c8d',
  };

  const getNodeColor = (kind: string): string => {
    return kindColors[kind] ?? kindColors['default'];
  };

  let gexf = '<?xml version="1.0" encoding="UTF-8"?>\n';
  gexf +=
    '<gexf xmlns="http://www.gexf.net/1.2draft" xmlns:viz="http://www.gexf.net/1.2draft/viz" version="1.2">\n';
  gexf += '  <meta lastmodifieddate="' + new Date().toISOString().split('T')[0] + '">\n';
  gexf += '    <creator>CLEO nexus export</creator>\n';
  gexf += '    <description>Code intelligence graph from CLEO nexus</description>\n';
  gexf += '  </meta>\n';
  gexf += '  <graph mode="static" defaultedgetype="directed">\n';

  gexf += '    <attributes class="node">\n';
  gexf += '      <attribute id="kind" title="Node Kind" type="string" />\n';
  gexf += '      <attribute id="filePath" title="File Path" type="string" />\n';
  gexf += '      <attribute id="language" title="Language" type="string" />\n';
  gexf += '      <attribute id="startLine" title="Start Line" type="integer" />\n';
  gexf += '      <attribute id="endLine" title="End Line" type="integer" />\n';
  gexf += '      <attribute id="isExported" title="Is Exported" type="boolean" />\n';
  gexf += '      <attribute id="projectId" title="Project ID" type="string" />\n';
  gexf += '    </attributes>\n';
  gexf += '    <attributes class="edge">\n';
  gexf += '      <attribute id="relationType" title="Relation Type" type="string" />\n';
  gexf += '      <attribute id="confidence" title="Confidence" type="double" />\n';
  gexf += '      <attribute id="reason" title="Reason" type="string" />\n';
  gexf += '    </attributes>\n';

  gexf += '    <nodes>\n';
  for (const node of nodes) {
    const nodeId = String(node['id']).replace(/[<>"'&]/g, (c) => {
      const map: Record<string, string> = {
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "\'": '&apos;',
        '&': '&amp;',
      };
      return map[c];
    });
    const label = String(node['label'] ?? node['id']);
    const kind = String(node['kind'] ?? 'unknown');
    const color = getNodeColor(kind);

    gexf += `      <node id="${nodeId}" label="${escapeXml(label)}">\n`;
    gexf += `        <viz:color r="${hexToRgb(color).r}" g="${hexToRgb(color).g}" b="${hexToRgb(color).b}" />\n`;
    gexf += '        <attvalues>\n';
    gexf += `          <attvalue id="kind" value="${escapeXml(kind)}" />\n`;
    if (node['filePath']) {
      gexf += `          <attvalue id="filePath" value="${escapeXml(String(node['filePath']))}" />\n`;
    }
    if (node['language']) {
      gexf += `          <attvalue id="language" value="${escapeXml(String(node['language']))}" />\n`;
    }
    if (node['startLine'] != null) {
      gexf += `          <attvalue id="startLine" value="${node['startLine']}" />\n`;
    }
    if (node['endLine'] != null) {
      gexf += `          <attvalue id="endLine" value="${node['endLine']}" />\n`;
    }
    if (node['isExported'] != null) {
      gexf += `          <attvalue id="isExported" value="${node['isExported'] ? 'true' : 'false'}" />\n`;
    }
    if (node['projectId']) {
      gexf += `          <attvalue id="projectId" value="${escapeXml(String(node['projectId']))}" />\n`;
    }
    gexf += '        </attvalues>\n';
    gexf += '      </node>\n';
  }
  gexf += '    </nodes>\n';

  gexf += '    <edges>\n';
  for (let i = 0; i < relations.length; i++) {
    const rel = relations[i];
    const sourceId = String(rel['sourceId']).replace(/[<>"'&]/g, (c) => {
      const map: Record<string, string> = {
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "\'": '&apos;',
        '&': '&amp;',
      };
      return map[c];
    });
    const targetId = String(rel['targetId']).replace(/[<>"'&]/g, (c) => {
      const map: Record<string, string> = {
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "\'": '&apos;',
        '&': '&amp;',
      };
      return map[c];
    });

    if (!nodeById.has(String(rel['sourceId'])) || !nodeById.has(String(rel['targetId']))) {
      continue;
    }

    const confidence = typeof rel['confidence'] === 'number' ? rel['confidence'] : 1.0;
    const relationType = String(rel['type'] ?? 'unknown');
    const reason = rel['reason'] ? String(rel['reason']) : '';

    gexf += `      <edge id="e${i}" source="${sourceId}" target="${targetId}" weight="${confidence}">\n`;
    gexf += '        <attvalues>\n';
    gexf += `          <attvalue id="relationType" value="${escapeXml(relationType)}" />\n`;
    gexf += `          <attvalue id="confidence" value="${confidence}" />\n`;
    if (reason) {
      gexf += `          <attvalue id="reason" value="${escapeXml(reason)}" />\n`;
    }
    gexf += '        </attvalues>\n';
    gexf += '      </edge>\n';
  }
  gexf += '    </edges>\n';

  gexf += '  </graph>\n';
  gexf += '</gexf>\n';

  return gexf;
}
