/**
 * W4-7 real-YAML parser tests (no mocks, no fixture files).
 * Uses template-literal YAML strings inline so every expectation is readable
 * in situ and reviewers can trace input → output without chasing fixtures.
 *
 * @task T889 / T904 / W4-7
 */

import { describe, expect, it } from 'vitest';
import { PlaybookParseError, parsePlaybook } from '../parser.js';

describe('W4-7: parsePlaybook', () => {
  describe('happy path', () => {
    it('parses a minimal valid playbook (1 agentic node, 0 edges)', () => {
      const yaml = `
version: "1.0"
name: minimal
nodes:
  - id: start
    type: agentic
    skill: ct-research-agent
`;
      const { definition, sourceHash } = parsePlaybook(yaml);
      expect(definition.version).toBe('1.0');
      expect(definition.name).toBe('minimal');
      expect(definition.nodes).toHaveLength(1);
      expect(definition.nodes[0]).toMatchObject({
        id: 'start',
        type: 'agentic',
        skill: 'ct-research-agent',
      });
      expect(definition.edges).toEqual([]);
      expect(sourceHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('parses a full rcasd-style playbook (5 nodes + edges)', () => {
      const yaml = `
version: "1.0"
name: rcasd
description: Research -> Constraint -> Architect -> Spec -> Decompose
inputs:
  - name: epicId
    required: true
    description: Parent epic id
  - name: scope
    default: global
nodes:
  - id: research
    type: agentic
    skill: ct-research-agent
    role: lead
    inputs:
      topic: "{{inputs.epicId}}"
  - id: constraint
    type: agentic
    agent: ct-validator
    role: worker
    depends:
      - research
  - id: lint
    type: deterministic
    command: pnpm
    args:
      - biome
      - ci
      - .
    timeout_ms: 60000
    depends:
      - constraint
  - id: approve
    type: approval
    prompt: "Approve RCASD plan?"
    policy: conservative
    depends:
      - lint
  - id: decompose
    type: agentic
    skill: ct-epic-architect
    depends:
      - approve
    on_failure:
      max_iterations: 3
      escalate: true
edges:
  - from: research
    to: constraint
    contract:
      requires: ["topic"]
      ensures: ["plan"]
  - from: constraint
    to: lint
  - from: lint
    to: approve
  - from: approve
    to: decompose
error_handlers:
  - on: agentic_timeout
    action: inject_hint
    message: "retry with narrower scope"
  - on: iteration_cap_exceeded
    action: hitl_escalate
`;
      const { definition } = parsePlaybook(yaml);
      expect(definition.nodes).toHaveLength(5);
      expect(definition.edges).toHaveLength(4);
      expect(definition.inputs).toHaveLength(2);
      expect(definition.error_handlers).toHaveLength(2);

      const research = definition.nodes.find((n) => n.id === 'research');
      expect(research?.type).toBe('agentic');
      if (research?.type === 'agentic') {
        expect(research.skill).toBe('ct-research-agent');
        expect(research.role).toBe('lead');
        expect(research.inputs?.topic).toBe('{{inputs.epicId}}');
      }

      const lint = definition.nodes.find((n) => n.id === 'lint');
      expect(lint?.type).toBe('deterministic');
      if (lint?.type === 'deterministic') {
        expect(lint.command).toBe('pnpm');
        expect(lint.args).toEqual(['biome', 'ci', '.']);
        expect(lint.timeout_ms).toBe(60000);
      }

      const approve = definition.nodes.find((n) => n.id === 'approve');
      expect(approve?.type).toBe('approval');
      if (approve?.type === 'approval') {
        expect(approve.prompt).toBe('Approve RCASD plan?');
        expect(approve.policy).toBe('conservative');
      }

      const decompose = definition.nodes.find((n) => n.id === 'decompose');
      expect(decompose?.on_failure?.max_iterations).toBe(3);
      expect(decompose?.on_failure?.escalate).toBe(true);

      const firstEdge = definition.edges[0];
      expect(firstEdge?.contract?.requires).toEqual(['topic']);
      expect(firstEdge?.contract?.ensures).toEqual(['plan']);
    });
  });

  describe('version validation', () => {
    it('rejects missing version', () => {
      const yaml = `
name: nope
nodes:
  - id: a
    type: agentic
    skill: x
`;
      expect(() => parsePlaybook(yaml)).toThrow(PlaybookParseError);
      expect(() => parsePlaybook(yaml)).toThrow(/Unsupported version/);
    });

    it('rejects unsupported version "2.0"', () => {
      const yaml = `
version: "2.0"
name: nope
nodes:
  - id: a
    type: agentic
    skill: x
`;
      expect(() => parsePlaybook(yaml)).toThrow(/Unsupported version: "2\.0"/);
    });
  });

  describe('structural validation', () => {
    it('rejects YAML that is not a top-level map', () => {
      expect(() => parsePlaybook('- just\n- a list\n')).toThrow(/top level/);
    });

    it('rejects YAML syntax errors', () => {
      expect(() => parsePlaybook('version: "1.0"\n  : broken')).toThrow(/YAML syntax error/);
    });

    it('rejects empty name', () => {
      const yaml = `
version: "1.0"
name: ""
nodes:
  - id: a
    type: agentic
    skill: x
`;
      expect(() => parsePlaybook(yaml)).toThrow(/name must be a non-empty string/);
    });

    it('rejects empty nodes array', () => {
      const yaml = `
version: "1.0"
name: x
nodes: []
`;
      expect(() => parsePlaybook(yaml)).toThrow(/nodes must be a non-empty array/);
    });

    it('rejects duplicate node ids', () => {
      const yaml = `
version: "1.0"
name: dup
nodes:
  - id: same
    type: agentic
    skill: a
  - id: same
    type: agentic
    skill: b
`;
      expect(() => parsePlaybook(yaml)).toThrow(/duplicate node id: same/);
    });

    it('rejects edge referencing unknown node (from)', () => {
      const yaml = `
version: "1.0"
name: e1
nodes:
  - id: a
    type: agentic
    skill: x
edges:
  - from: ghost
    to: a
`;
      expect(() => parsePlaybook(yaml)).toThrow(/from references unknown node ghost/);
    });

    it('rejects edge referencing unknown node (to)', () => {
      const yaml = `
version: "1.0"
name: e2
nodes:
  - id: a
    type: agentic
    skill: x
edges:
  - from: a
    to: missing
`;
      expect(() => parsePlaybook(yaml)).toThrow(/to references unknown node missing/);
    });

    it('rejects cycle (A -> B -> A)', () => {
      const yaml = `
version: "1.0"
name: cyc
nodes:
  - id: A
    type: agentic
    skill: x
  - id: B
    type: agentic
    skill: y
edges:
  - from: A
    to: B
  - from: B
    to: A
`;
      expect(() => parsePlaybook(yaml)).toThrow(/cycle/);
    });

    it('rejects cycle via depends self-loop', () => {
      const yaml = `
version: "1.0"
name: cyc2
nodes:
  - id: A
    type: agentic
    skill: x
    depends:
      - B
  - id: B
    type: agentic
    skill: y
    depends:
      - A
`;
      expect(() => parsePlaybook(yaml)).toThrow(/cycle/);
    });
  });

  describe('node-kind validation', () => {
    it('rejects deterministic node missing command', () => {
      const yaml = `
version: "1.0"
name: d1
nodes:
  - id: n
    type: deterministic
    args: [x]
`;
      expect(() => parsePlaybook(yaml)).toThrow(/must have a non-empty 'command'/);
    });

    it('rejects approval node missing prompt', () => {
      const yaml = `
version: "1.0"
name: ap
nodes:
  - id: n
    type: approval
`;
      expect(() => parsePlaybook(yaml)).toThrow(/must have a non-empty 'prompt'/);
    });

    it('rejects agentic node missing both skill and agent', () => {
      const yaml = `
version: "1.0"
name: ag
nodes:
  - id: n
    type: agentic
`;
      expect(() => parsePlaybook(yaml)).toThrow(/must define at least one of 'skill' or 'agent'/);
    });

    it('accepts agentic node with only agent (no skill)', () => {
      const yaml = `
version: "1.0"
name: ag2
nodes:
  - id: n
    type: agentic
    agent: ct-validator
`;
      const { definition } = parsePlaybook(yaml);
      expect(definition.nodes).toHaveLength(1);
    });

    it('rejects unknown node type', () => {
      const yaml = `
version: "1.0"
name: bad
nodes:
  - id: n
    type: whoops
`;
      expect(() => parsePlaybook(yaml)).toThrow(/one of agentic \| deterministic \| approval/);
    });
  });

  describe('bounds checks', () => {
    it('rejects max_iterations > 10', () => {
      const yaml = `
version: "1.0"
name: cap
nodes:
  - id: n
    type: agentic
    skill: x
    on_failure:
      max_iterations: 11
`;
      expect(() => parsePlaybook(yaml)).toThrow(/max_iterations must be 0\.\.10 \(got 11\)/);
    });

    it('rejects max_iterations < 0', () => {
      const yaml = `
version: "1.0"
name: cap2
nodes:
  - id: n
    type: agentic
    skill: x
    on_failure:
      max_iterations: -1
`;
      expect(() => parsePlaybook(yaml)).toThrow(/max_iterations must be 0\.\.10 \(got -1\)/);
    });

    it('accepts max_iterations at the upper bound (10)', () => {
      const yaml = `
version: "1.0"
name: cap3
nodes:
  - id: n
    type: agentic
    skill: x
    on_failure:
      max_iterations: 10
`;
      const { definition } = parsePlaybook(yaml);
      expect(definition.nodes[0]?.on_failure?.max_iterations).toBe(10);
    });

    it('rejects depends pointing to unknown node', () => {
      const yaml = `
version: "1.0"
name: dep
nodes:
  - id: a
    type: agentic
    skill: x
    depends:
      - missing_one
`;
      expect(() => parsePlaybook(yaml)).toThrow(/depends on unknown node missing_one/);
    });
  });

  describe('determinism', () => {
    it('produces deterministic sourceHash (same input -> same hash)', () => {
      const yaml = `
version: "1.0"
name: stable
nodes:
  - id: a
    type: agentic
    skill: x
`;
      const h1 = parsePlaybook(yaml).sourceHash;
      const h2 = parsePlaybook(yaml).sourceHash;
      expect(h1).toBe(h2);
      expect(h1).toMatch(/^[a-f0-9]{64}$/);
    });

    it('produces different sourceHash for different input', () => {
      const a = parsePlaybook(`
version: "1.0"
name: a
nodes:
  - id: n
    type: agentic
    skill: x
`).sourceHash;
      const b = parsePlaybook(`
version: "1.0"
name: b
nodes:
  - id: n
    type: agentic
    skill: x
`).sourceHash;
      expect(a).not.toBe(b);
    });
  });

  describe('PlaybookParseError shape', () => {
    it('carries code + exitCode + field', () => {
      try {
        parsePlaybook(
          'version: "9.9"\nname: x\nnodes:\n  - id: n\n    type: agentic\n    skill: y',
        );
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(PlaybookParseError);
        const e = err as PlaybookParseError;
        expect(e.code).toBe('E_PLAYBOOK_PARSE');
        expect(e.exitCode).toBe(70);
        expect(e.field).toBe('version');
        expect(e.value).toBe('9.9');
      }
    });
  });
});
