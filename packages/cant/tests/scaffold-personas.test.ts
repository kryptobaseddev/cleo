/**
 * Every persona `cleo agent create` scaffolds parses and validates clean in
 * cant-core (T14652). The generators in `packages/core/src/agents/scaffold.ts`
 * once emitted YAML-style block lists for `skills:` and `context_sources:` and
 * an agent-level `on_overflow:`, which the parser rejects (`expected key:
 * value`) and JIT-001 forbids — the defect T14643 fixed in the agent
 * templates — and a `mental_model.max_tokens` above the tier's TIER-002 cap.
 *
 * @task T14652
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AgentRole, generatePersonaCant } from '@cleocode/core/agents/scaffold.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseDocument, validateDocument } from '../src/document';

/** Every role the scaffolder accepts, each with and without a domain. */
const ROLES: ReadonlyArray<{ role: AgentRole; domain?: string }> = [
  { role: 'orchestrator' },
  { role: 'lead' },
  { role: 'lead', domain: 'backend API' },
  { role: 'worker' },
  { role: 'worker', domain: 'frontend UI' },
  { role: 'docs-worker' },
  { role: 'docs-worker', domain: 'API reference' },
];

/** Every tier `cleo agent create --tier` accepts. */
const TIERS = ['low', 'mid', 'high'] as const;

const CASES = ROLES.flatMap((r) => TIERS.map((tier) => ({ ...r, tier })));

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cant-scaffold-personas-'));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('scaffolded persona.cant (T14652)', () => {
  it.each(CASES)('$role, tier $tier (domain: $domain) parses and validates with zero errors', async ({
    role,
    domain,
    tier,
  }) => {
    const name = `test-${role}-${tier}${domain ? '-domain' : ''}`;
    const file = join(dir, `${name}.cant`);
    writeFileSync(
      file,
      generatePersonaCant({ name, role, tier, team: 'test-team', domain }),
      'utf-8',
    );

    const parsed = await parseDocument(file);
    expect(parsed.errors).toEqual([]);
    expect(parsed.success).toBe(true);

    const validated = await validateDocument(file);
    const errors = validated.diagnostics.filter((d) => d.severity === 'error');
    expect(errors).toEqual([]);
    expect(validated.errorCount).toBe(0);
    expect(validated.valid).toBe(true);
  });
});
