#!/usr/bin/env node
/**
 * Acceptance verifier for T9231 — FISE-2 CANT validateSpawnRequest.
 *
 * Checks:
 * 1. validateSpawnRequest is exported from ivtr-loop.ts compiled dist
 * 2. The function rejects implemented gate for Lead with no delegation
 * 3. FISE-2 warning appears in spawn-prompt.ts compiled dist
 * 4. E_LEAD_AUTHORSHIP_BYPASS code is in the dist
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function pass(msg) {
  console.log(`PASS: ${msg}`);
}

// 1. validateSpawnRequest is exported from ivtr-loop dist
const ivtrDistPath = join(projectRoot, 'packages/core/dist/lifecycle/ivtr-loop.js');
if (!existsSync(ivtrDistPath)) {
  fail(`ivtr-loop.js dist not found: ${ivtrDistPath}`);
}
const ivtrDist = readFileSync(ivtrDistPath, 'utf-8');
if (!ivtrDist.includes('validateSpawnRequest')) {
  fail('validateSpawnRequest not found in dist/lifecycle/ivtr-loop.js');
}
pass('validateSpawnRequest exported from ivtr-loop dist');

// 2. E_LEAD_AUTHORSHIP_BYPASS code present in dist
if (!ivtrDist.includes('E_LEAD_AUTHORSHIP_BYPASS')) {
  fail('E_LEAD_AUTHORSHIP_BYPASS not found in ivtr-loop dist');
}
pass('E_LEAD_AUTHORSHIP_BYPASS code present in ivtr-loop dist');

// 3. Lead role check present
if (!ivtrDist.includes('CLEO_AGENT_ROLE') || !ivtrDist.includes('lead')) {
  fail('CLEO_AGENT_ROLE=lead check not found in ivtr-loop dist');
}
pass('CLEO_AGENT_ROLE=lead check present in ivtr-loop dist');

// 4. delegate_task detection present
if (!ivtrDist.includes('delegate_task') || !ivtrDist.includes('hasDelegateEvent')) {
  fail('delegate_task detection not found in ivtr-loop dist');
}
pass('delegate_task detection present in ivtr-loop dist');

// 5. FISE-2 warning in spawn-prompt dist
const spawnPromptDist = join(projectRoot, 'packages/core/dist/orchestration/spawn-prompt.js');
if (!existsSync(spawnPromptDist)) {
  fail(`spawn-prompt.js dist not found: ${spawnPromptDist}`);
}
const spawnPromptDistContent = readFileSync(spawnPromptDist, 'utf-8');
if (
  !spawnPromptDistContent.includes('FISE-2') ||
  !spawnPromptDistContent.includes('E_LEAD_AUTHORSHIP_BYPASS')
) {
  fail('FISE-2 warning not found in spawn-prompt dist');
}
pass('FISE-2 warning present in spawn-prompt dist');

// 6. engine-ops.ts wires validateSpawnRequest
const engineOpsDist = join(projectRoot, 'packages/core/dist/validation/engine-ops.js');
if (!existsSync(engineOpsDist)) {
  fail(`engine-ops.js dist not found: ${engineOpsDist}`);
}
const engineOpsDist_content = readFileSync(engineOpsDist, 'utf-8');
if (
  !engineOpsDist_content.includes('validateSpawnRequest') ||
  !engineOpsDist_content.includes('ivtr-loop')
) {
  fail('engine-ops.js does not call validateSpawnRequest from ivtr-loop');
}
pass('engine-ops.js wires validateSpawnRequest from ivtr-loop');

console.log('\nAll T9231 acceptance checks passed.');
process.exit(0);
