/**
 * NEXUS symbol ranking utilities.
 *
 * Priority scores and sort helpers used by `nexus context` and `nexus impact`
 * to prefer callable nodes (function, method, class) over structural nodes
 * (file, folder) that have no `calls` relations.
 *
 * @task T1473
 */

/**
 * Priority score for nexus node kinds when ranking symbol search results.
 *
 * Callable symbols (function, method) rank highest so that `nexus context`
 * and `nexus impact` return meaningful callers/callees instead of
 * file/folder structural nodes which have zero `calls` relations.
 *
 * Lower score = higher priority (sort ascending).
 */
export const NODE_KIND_PRIORITY: Record<string, number> = {
  function: 0,
  method: 1,
  constructor: 2,
  class: 3,
  interface: 4,
  type_alias: 5,
  enum: 6,
  constant: 7,
  property: 8,
  variable: 9,
  static: 10,
  struct: 11,
  trait: 12,
  impl: 13,
  macro: 14,
  // Structural/module nodes come last — they have no `calls` relations
  module: 20,
  namespace: 21,
  record: 22,
  delegate: 23,
  union: 24,
  typedef: 25,
  annotation: 26,
  template: 27,
  route: 28,
  tool: 29,
  section: 30,
  import: 31,
  export: 32,
  type: 33,
  file: 40,
  folder: 41,
};

/**
 * Sort symbol search results so that callable nodes (function, method, class)
 * appear before structural nodes (file, folder). Within the same kind, prefer
 * exact name matches over partial matches.
 *
 * @param nodes - Array of nexus node records to sort.
 * @param symbolName - The query symbol name (for exact-match boost).
 * @returns Sorted copy of the input array.
 *
 * @example
 * const sorted = sortMatchingNodes(allNodes, 'dispatchFromCli');
 */
export function sortMatchingNodes(
  nodes: Array<Record<string, unknown>>,
  symbolName: string,
): Array<Record<string, unknown>> {
  const lowerSymbol = symbolName.toLowerCase();
  return [...nodes].sort((a, b) => {
    const kindA = String(a['kind'] ?? '');
    const kindB = String(b['kind'] ?? '');
    const prioA = NODE_KIND_PRIORITY[kindA] ?? 15;
    const prioB = NODE_KIND_PRIORITY[kindB] ?? 15;
    if (prioA !== prioB) return prioA - prioB;
    // Within same kind: exact name matches before partial matches
    const nameA = String(a['name'] ?? '').toLowerCase();
    const nameB = String(b['name'] ?? '').toLowerCase();
    const exactA = nameA === lowerSymbol ? 0 : 1;
    const exactB = nameB === lowerSymbol ? 0 : 1;
    return exactA - exactB;
  });
}
