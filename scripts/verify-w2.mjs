#!/usr/bin/env node

/**
 * Verifier for T9213: W2 — auto-load ct-lead skill at tier-1 spawns.
 *
 * Source task: T9213
 *
 * AC:
 *   - buildTier2SkillExcerpts generalized to buildTierSkillExcerpts(tier, role)
 *   - tier-1 + role=lead spawn prompt contains both ct-cleo and ct-lead excerpts
 *   - tier-2 + role=orchestrator unchanged from current
 *   - tier-0 unchanged (no excerpts)
 *   - backward-compat: buildTier2SkillExcerpts still callable (deprecated re-export)
 *   - spawn-prompt unit test passes
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const failures = [];

function fail(msg) {
  console.error('FAIL:', msg);
  failures.push(msg);
}

function pass(msg) {
  console.log('PASS:', msg);
}

function readFile(rel) {
  const p = join(REPO_ROOT, rel);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8');
}

const SPAWN_PROMPT_PATH = 'packages/core/src/orchestration/spawn-prompt.ts';
const src = readFile(SPAWN_PROMPT_PATH);

if (!src) {
  console.error(`FATAL: Cannot read ${SPAWN_PROMPT_PATH}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Check 1: buildTierSkillExcerpts function exists with tier + role parameters
// ---------------------------------------------------------------------------
// Accept either (tier: number, role: string) or (tier: SpawnTier, role: string)
const hasTierRoleFn =
  /function buildTierSkillExcerpts\s*\([\s\S]{0,200}tier[\s\S]{0,50}role/.test(src) ||
  /export function buildTierSkillExcerpts\s*\([\s\S]{0,200}tier[\s\S]{0,50}role/.test(src);

if (hasTierRoleFn) {
  pass('buildTierSkillExcerpts(tier, role, ...) function found in spawn-prompt.ts');
} else {
  fail(
    'buildTierSkillExcerpts(tier, role, ...) function NOT found in spawn-prompt.ts — must generalize buildTier2SkillExcerpts',
  );
}

// ---------------------------------------------------------------------------
// Check 2: buildTierSkillExcerpts is exported (verifier calls it directly)
// ---------------------------------------------------------------------------
const isExported =
  src.includes('export function buildTierSkillExcerpts') ||
  src.includes('export { buildTierSkillExcerpts') ||
  // exported via re-export alias block
  /export\s*\{[^}]*buildTierSkillExcerpts[^}]*\}/.test(src);

if (isExported) {
  pass('buildTierSkillExcerpts is exported from spawn-prompt.ts');
} else {
  fail(
    'buildTierSkillExcerpts must be exported from spawn-prompt.ts so callers can use it directly',
  );
}

// ---------------------------------------------------------------------------
// Check 3: tier=1, role=lead branch loads ct-cleo AND ct-lead
// ---------------------------------------------------------------------------
// Find the tier-1/lead conditional branch in the function
const tier1LeadBlock = (() => {
  // Look for the branch that checks tier === 1 && role === 'lead'
  const idx = src.indexOf("tier === 1 && role === 'lead'");
  if (idx === -1) {
    // Also accept role === 'lead' with tier check nearby (different style)
    const altIdx = src.indexOf("role === 'lead'");
    if (altIdx === -1) return null;
    return src.slice(altIdx, altIdx + 500);
  }
  return src.slice(idx, idx + 500);
})();

const hasCtLeadInBranch = tier1LeadBlock?.includes('ct-lead') && tier1LeadBlock.includes('ct-cleo');

if (hasCtLeadInBranch) {
  pass('tier=1/role=lead branch in buildTierSkillExcerpts loads both ct-cleo and ct-lead');
} else {
  // Looser check: does the entire function body reference ct-lead?
  const fnStart = src.indexOf('function buildTierSkillExcerpts');
  const fnSnippet = fnStart >= 0 ? src.slice(fnStart, fnStart + 1500) : '';
  if (fnSnippet.includes('ct-lead') && fnSnippet.includes('ct-cleo')) {
    pass('buildTierSkillExcerpts body references both ct-cleo and ct-lead');
  } else {
    fail(
      "buildTierSkillExcerpts must load 'ct-lead' for tier=1/role=lead (ct-lead not found in function body)",
    );
  }
}

// ---------------------------------------------------------------------------
// Check 4: tier=2, role=orchestrator branch still loads ct-orchestrator
// ---------------------------------------------------------------------------
const hasCtOrchestrator = (() => {
  const fnStart = src.indexOf('function buildTierSkillExcerpts');
  if (fnStart === -1) return false;
  const fnSnippet = src.slice(fnStart, fnStart + 1500);
  return fnSnippet.includes('ct-orchestrator');
})();

if (hasCtOrchestrator) {
  pass('buildTierSkillExcerpts still handles tier=2/role=orchestrator (ct-orchestrator present)');
} else {
  fail('buildTierSkillExcerpts must preserve tier=2/role=orchestrator → ct-orchestrator behavior');
}

// ---------------------------------------------------------------------------
// Check 5: backward-compat — buildTier2SkillExcerpts still present
// ---------------------------------------------------------------------------
const hasLegacyFn =
  src.includes('buildTier2SkillExcerpts') &&
  // Ensure it's still callable — either defined as function or re-export
  (src.includes('function buildTier2SkillExcerpts') ||
    /buildTier2SkillExcerpts\s*=/.test(src) ||
    src.includes('buildTierSkillExcerpts(2'));

if (hasLegacyFn) {
  pass('buildTier2SkillExcerpts backward-compat shim present in spawn-prompt.ts');
} else {
  fail(
    'buildTier2SkillExcerpts must remain callable as a deprecated shim pointing to buildTierSkillExcerpts(2, ...)',
  );
}

// ---------------------------------------------------------------------------
// Check 6: Call site in buildSpawnPrompt passes role for tier-2 case
// ---------------------------------------------------------------------------
// The internal call should use buildTierSkillExcerpts (not the old name) at the tier-2 site
const tier2CallSite = (() => {
  // Find the block where tier 2 skill excerpts are pushed
  const idx = src.indexOf('buildTier2SkillExcerpts(');
  const newIdx = src.indexOf('buildTierSkillExcerpts(');
  // After implementation: new call should exist at the former call site
  return { hasOldCall: idx >= 0, hasNewCall: newIdx >= 0 };
})();

if (tier2CallSite.hasNewCall) {
  pass('buildTierSkillExcerpts is called from within buildSpawnPrompt (call site updated)');
} else if (tier2CallSite.hasOldCall) {
  fail(
    'buildSpawnPrompt still calls old buildTier2SkillExcerpts — update call site to buildTierSkillExcerpts',
  );
} else {
  fail(
    'Neither buildTier2SkillExcerpts nor buildTierSkillExcerpts found at call site in buildSpawnPrompt',
  );
}

// ---------------------------------------------------------------------------
// Check 7: role field on BuildSpawnPromptInput (so callers can pass role)
// ---------------------------------------------------------------------------
const hasRoleOnInput = (() => {
  // Find BuildSpawnPromptInput interface
  const idx = src.indexOf('export interface BuildSpawnPromptInput');
  if (idx === -1) return false;
  // Find the closing brace — scan for the next top-level }
  let depth = 0;
  const start = src.indexOf('{', idx);
  if (start === -1) return false;
  let end = start;
  for (let i = start; i < Math.min(src.length, start + 5000); i++) {
    if (src[i] === '{') depth++;
    if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const interfaceBody = src.slice(start, end + 1);
  return (
    interfaceBody.includes('role') &&
    (interfaceBody.includes("'orchestrator'") ||
      interfaceBody.includes('AgentSpawnCapability') ||
      interfaceBody.includes('string'))
  );
})();

if (hasRoleOnInput) {
  pass('BuildSpawnPromptInput has role field so callers can pass role for tier-routing');
} else {
  fail(
    'BuildSpawnPromptInput must include a role field (optional) for tier-1/lead skill routing (T9213)',
  );
}

// ---------------------------------------------------------------------------
// Final result
// ---------------------------------------------------------------------------
if (failures.length === 0) {
  console.log(
    '\nVERIFIER PASS: T9213 — buildTierSkillExcerpts generalizes tier-1 lead skill auto-load',
  );
  process.exit(0);
} else {
  console.error(`\nVERIFIER FAIL: ${failures.length} check(s) failed — implementation incomplete`);
  process.exit(1);
}
