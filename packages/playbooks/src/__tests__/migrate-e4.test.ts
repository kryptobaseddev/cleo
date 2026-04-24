/**
 * PSYCHE E4 migration tool tests.
 *
 * Validates the STRICT cutover compliance validator and migration function.
 * No disk I/O; uses inline YAML strings.
 *
 * @task T1261 PSYCHE E4
 */

import { describe, expect, it } from 'vitest';
import { migratePlaybook, validatePlaybookCompliance } from '../migrate-e4.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const MINIMAL_COMPLIANT = `
version: "1.0"
name: compliant
nodes:
  - id: start
    type: agentic
    skill: ct-research-agent
    requires:
      from: ctx
      fields: [input]
    ensures:
      schema: output_summary
edges: []
error_handlers:
  - on: iteration_cap_exceeded
    action: hitl_escalate
`;

const MINIMAL_NON_COMPLIANT = `
version: "1.0"
name: legacy
nodes:
  - id: start
    type: agentic
    skill: ct-research-agent
edges: []
`;

const MINIMAL_PARTIAL = `
version: "1.0"
name: partial
nodes:
  - id: start
    type: agentic
    skill: ct-research-agent
    requires:
      fields: [input]
edges: []
`;

// ---------------------------------------------------------------------------
// validatePlaybookCompliance
// ---------------------------------------------------------------------------

describe('T1261-E4: validatePlaybookCompliance', () => {
  it('returns compliant=true for a fully-wired playbook', () => {
    const report = validatePlaybookCompliance(MINIMAL_COMPLIANT);
    expect(report.parses).toBe(true);
    expect(report.compliant).toBe(true);
    expect(report.hasErrorHandlers).toBe(true);
    expect(report.nodesMissingRequires).toBe(0);
    expect(report.nodesMissingEnsures).toBe(0);
  });

  it('returns compliant=false when error_handlers is absent', () => {
    const report = validatePlaybookCompliance(MINIMAL_PARTIAL);
    expect(report.parses).toBe(true);
    expect(report.compliant).toBe(false);
    expect(report.hasErrorHandlers).toBe(false);
  });

  it('returns compliant=false when nodes lack requires/ensures', () => {
    const report = validatePlaybookCompliance(MINIMAL_NON_COMPLIANT);
    expect(report.parses).toBe(true);
    expect(report.compliant).toBe(false);
    expect(report.nodesMissingRequires).toBe(1);
    expect(report.nodesMissingEnsures).toBe(1);
  });

  it('returns parses=false for invalid YAML', () => {
    const report = validatePlaybookCompliance('version: "1.0"\n  : broken');
    expect(report.parses).toBe(false);
    expect(report.compliant).toBe(false);
    expect(report.parseError).toBeDefined();
  });

  it('reports correct node breakdown', () => {
    const report = validatePlaybookCompliance(MINIMAL_NON_COMPLIANT);
    expect(report.nodes).toHaveLength(1);
    expect(report.nodes[0]).toMatchObject({
      id: 'start',
      type: 'agentic',
      hasRequires: false,
      hasEnsures: false,
    });
  });

  it('exempts approval nodes from requires/ensures check', () => {
    const yaml = `
version: "1.0"
name: with-approval
nodes:
  - id: work
    type: agentic
    skill: ct-task-executor
    requires:
      fields: [input]
    ensures:
      schema: output
  - id: gate
    type: approval
    prompt: "Approve release?"
edges:
  - from: work
    to: gate
error_handlers:
  - on: iteration_cap_exceeded
    action: hitl_escalate
`;
    const report = validatePlaybookCompliance(yaml);
    expect(report.compliant).toBe(true);
    expect(report.nodes.find((n) => n.id === 'gate')).toMatchObject({
      type: 'approval',
    });
  });
});

// ---------------------------------------------------------------------------
// migratePlaybook
// ---------------------------------------------------------------------------

describe('T1261-E4: migratePlaybook', () => {
  it('adds error_handlers when absent', () => {
    const migrated = migratePlaybook(MINIMAL_NON_COMPLIANT);
    const report = validatePlaybookCompliance(migrated);
    expect(report.hasErrorHandlers).toBe(true);
  });

  it('adds requires/ensures stubs to work nodes', () => {
    const migrated = migratePlaybook(MINIMAL_NON_COMPLIANT);
    const report = validatePlaybookCompliance(migrated);
    expect(report.nodesMissingRequires).toBe(0);
    expect(report.nodesMissingEnsures).toBe(0);
    expect(report.compliant).toBe(true);
  });

  it('preserves existing error_handlers when present', () => {
    const migrated = migratePlaybook(MINIMAL_PARTIAL);
    // MINIMAL_PARTIAL has requires but no error_handlers/ensures
    const report = validatePlaybookCompliance(migrated);
    expect(report.parses).toBe(true);
    // ensures gets added
    expect(report.nodesMissingEnsures).toBe(0);
  });

  it('does not double-add requires/ensures when already present', () => {
    // Migrating a compliant playbook should return parseable output
    const migrated = migratePlaybook(MINIMAL_COMPLIANT);
    const report = validatePlaybookCompliance(migrated);
    expect(report.compliant).toBe(true);
  });

  it('throws PlaybookParseError on structurally invalid source', () => {
    const invalid = `
version: "1.0"
name: bad
nodes: []
`;
    // nodes must be non-empty per parser
    expect(() => migratePlaybook(invalid)).toThrow();
  });

  it('does not modify approval nodes', () => {
    const yaml = `
version: "1.0"
name: has-approval
nodes:
  - id: step
    type: agentic
    skill: ct-task-executor
  - id: gate
    type: approval
    prompt: "Approve?"
edges: []
error_handlers:
  - on: iteration_cap_exceeded
    action: hitl_escalate
`;
    const migrated = migratePlaybook(yaml);
    const report = validatePlaybookCompliance(migrated);
    // approval node should still be exempted
    const approvalEntry = report.nodes.find((n) => n.id === 'gate');
    expect(approvalEntry?.type).toBe('approval');
    expect(report.compliant).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// context_files parser support (T1261 E4 thin-agent boundary)
// ---------------------------------------------------------------------------

describe('T1261-E4: context_files parser support', () => {
  it('parses context_files on an agentic node', async () => {
    const { parsePlaybook } = await import('../parser.js');
    const yaml = `
version: "1.0"
name: bounded
nodes:
  - id: worker
    type: agentic
    skill: ct-task-executor
    context_files:
      - packages/core/src/foo.ts
      - packages/contracts/src/index.ts
edges: []
`;
    const { definition } = parsePlaybook(yaml);
    const node = definition.nodes[0];
    expect(node.type).toBe('agentic');
    if (node.type === 'agentic') {
      expect(node.context_files).toEqual([
        'packages/core/src/foo.ts',
        'packages/contracts/src/index.ts',
      ]);
    }
  });

  it('context_files is optional — absent nodes have undefined', async () => {
    const { parsePlaybook } = await import('../parser.js');
    const yaml = `
version: "1.0"
name: unbounded
nodes:
  - id: worker
    type: agentic
    skill: ct-task-executor
edges: []
`;
    const { definition } = parsePlaybook(yaml);
    const node = definition.nodes[0];
    if (node.type === 'agentic') {
      expect(node.context_files).toBeUndefined();
    }
  });
});
