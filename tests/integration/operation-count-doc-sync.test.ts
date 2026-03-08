import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getMutateOperationCount } from '../../src/mcp/gateways/mutate.js';
import { getQueryOperationCount } from '../../src/mcp/gateways/query.js';

const queryCount = getQueryOperationCount();
const mutateCount = getMutateOperationCount();
const totalCount = queryCount + mutateCount;

describe('operation-count doc sync', () => {
  it('keeps canonical docs aligned with runtime gateway totals', () => {
    const agents = readFileSync('AGENTS.md', 'utf8');
    const vision = readFileSync('docs/concepts/CLEO-VISION.md', 'utf8');
    const constitution = readFileSync('docs/specs/CLEO-OPERATION-CONSTITUTION.md', 'utf8');

    expect(agents).toContain(`${totalCount} operations across 10 canonical domains`);
    expect(agents).toContain(`${queryCount} query operations`);
    expect(agents).toContain(`${mutateCount} mutate operations`);
    expect(agents).toContain(`All ${totalCount} MCP operations`);

    expect(vision).toContain(
      `${totalCount} MCP operations (${queryCount} query + ${mutateCount} mutate)`,
    );
    expect(vision).toContain(`${totalCount} operations across 10 domains`);

    expect(constitution).toContain(
      `| **Total** | **${queryCount}** | **${mutateCount}** | **${totalCount}** |`,
    );

    const staleDriftPatterns = [
      /All 207 MCP operations/,
      /207 MCP operations \(118 query \+ 89 mutate\)/,
      /207 operations across 10 domains/,
      /\| \*\*Total\*\* \| \*\*126\*\* \| \*\*92\*\* \| \*\*218\*\* \|/,
    ];

    for (const pattern of staleDriftPatterns) {
      expect(agents).not.toMatch(pattern);
      expect(vision).not.toMatch(pattern);
      expect(constitution).not.toMatch(pattern);
    }
  });
});
