#!/usr/bin/env node
/**
 * Gate: the HITL ask-tool rule reaches every agent-facing delivery surface (T12483).
 *
 * ## What this prevents
 *
 * The owner rule is that every owner answer, decision, approval or choice goes
 * through the harness ask tool with concrete options, never as prose, and that
 * subagents relay the question to their orchestrator instead of asking. That
 * rule only works if every surface an agent reads carries it. A refactor that
 * drops it from one surface (a template trim, a skill rewrite, a spawn-prompt
 * change) silently teaches that class of agent to ask in prose again, and no
 * test notices because each surface is edited in isolation.
 *
 * ## Surfaces
 *
 *   1. `packages/core/templates/CLEO-INJECTION.md` — injected into every
 *      session in every project (universal protocol step 7).
 *   2. `ct-cleo` and `ct-orchestrator` SKILL.md — the tier-0 skills embedded in
 *      spawn tier 2 and loaded on demand.
 *   3. `packages/core/src/orchestration/spawn-prompt.ts` — the Return Format
 *      Contract, emitted at EVERY spawn tier (0, 1 and 2), carries the subagent
 *      relay line. The gate checks the line's text and that the contract builder
 *      calls it; `spawn-prompt-hitl.test.ts` checks the rendered prompts.
 *
 * Each surface must contain every marker in its list (case-sensitive
 * substrings). Markers are short, stable phrases, not whole sentences, so
 * wording can be tightened without tripping the gate while deleting the rule
 * cannot pass.
 *
 * Usage: node scripts/lint-hitl-rule-delivery.mjs [--check|--strict]
 *
 * @task T12483
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isMain } from './lib/is-main.mjs';

/**
 * Delivery surfaces and the markers each must carry.
 * @type {ReadonlyArray<{ path: string, label: string, markers: readonly string[] }>}
 */
export const SURFACES = [
  {
    path: 'packages/core/templates/CLEO-INJECTION.md',
    label: 'injection template (every session)',
    markers: ['**Ask the owner.**', 'ask tool', 'Never ask in prose', 'hitl.request'],
  },
  {
    path: 'packages/skills/skills/ct-cleo/SKILL.md',
    label: 'ct-cleo skill',
    markers: ['HITL ask tool', 'Subagents never ask the human', 'hitl.request'],
  },
  {
    path: 'packages/skills/skills/ct-orchestrator/SKILL.md',
    label: 'ct-orchestrator skill',
    markers: ['HITL ask tool', 'Subagent relay', 'Subagents never ask the human'],
  },
  {
    path: 'packages/core/src/orchestration/spawn-prompt.ts',
    label: 'spawn prompt return contract (tiers 0-2)',
    markers: ['HITL: never ask the human', 'buildHitlLine(type, askProviderId)'],
  },
];

/**
 * Check every surface under `root`.
 *
 * @param {string} root - Repository root.
 * @param {typeof SURFACES} [surfaces] - Surfaces to check (tests inject their own).
 * @returns {{ path: string, label: string, missing: string[] }[]} One entry per
 *   surface that is unreadable or lacks a marker.
 */
export function findMissing(root, surfaces = SURFACES) {
  const problems = [];
  for (const surface of surfaces) {
    let text;
    try {
      text = readFileSync(resolve(root, surface.path), 'utf8');
    } catch {
      problems.push({ path: surface.path, label: surface.label, missing: ['<file unreadable>'] });
      continue;
    }
    const missing = surface.markers.filter((m) => !text.includes(m));
    if (missing.length > 0) problems.push({ path: surface.path, label: surface.label, missing });
  }
  return problems;
}

/**
 * Run the gate and return the process exit code.
 *
 * @param {string} root - Repository root.
 * @returns {number} 0 when every surface carries the rule, 1 otherwise.
 */
export function runGate(root) {
  const problems = findMissing(root);
  if (problems.length === 0) {
    process.stdout.write(
      `HITL rule present on all ${SURFACES.length} delivery surfaces (T12483).\n`,
    );
    return 0;
  }
  for (const p of problems) {
    process.stderr.write(
      `FAIL ${p.path} (${p.label}) is missing the HITL ask-tool rule: ${p.missing.join(' | ')}\n`,
    );
  }
  process.stderr.write(
    'Restore the owner ask-tool rule on every surface (see CLEO-INJECTION.md universal protocol step 7).\n',
  );
  return 1;
}

if (isMain(import.meta.url)) {
  process.exit(runGate(process.cwd()));
}
