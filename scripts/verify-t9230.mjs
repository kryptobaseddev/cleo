#!/usr/bin/env node
/**
 * Acceptance verifier for T9230 — FISE-1 session-end hard gate.
 *
 * Checks:
 * 1. LeadBypassDetectedError exists in @cleocode/contracts (exit code 107)
 * 2. ExitCode.LEAD_BYPASS_DETECTED = 107
 * 3. endSession in @cleocode/core reads session role and checks delegate_task_count
 * 4. The check is present in the compiled dist
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

// 1. Check LeadBypassDetectedError in contracts dist
const contractsDistPath = join(projectRoot, 'packages/contracts/dist/errors.js');
if (!existsSync(contractsDistPath)) {
  fail(`contracts dist not found: ${contractsDistPath}`);
}
const contractsDist = readFileSync(contractsDistPath, 'utf-8');
if (!contractsDist.includes('LeadBypassDetectedError')) {
  fail('LeadBypassDetectedError not found in contracts/dist/errors.js');
}
pass('LeadBypassDetectedError exists in contracts dist');

// 2. Check ExitCode.LEAD_BYPASS_DETECTED in exit-codes dist
const exitCodesPath = join(projectRoot, 'packages/contracts/dist/exit-codes.js');
if (!existsSync(exitCodesPath)) {
  fail(`exit-codes dist not found: ${exitCodesPath}`);
}
const exitCodesDist = readFileSync(exitCodesPath, 'utf-8');
if (!exitCodesDist.includes('LEAD_BYPASS_DETECTED')) {
  fail('ExitCode.LEAD_BYPASS_DETECTED not found in contracts/dist/exit-codes.js');
}
if (!exitCodesDist.includes('107')) {
  fail('ExitCode.LEAD_BYPASS_DETECTED value 107 not found');
}
pass('ExitCode.LEAD_BYPASS_DETECTED = 107 in contracts dist');

// 3. Check hard gate logic in core sessions dist
const coreSessionsDist = join(projectRoot, 'packages/core/dist/sessions/index.js');
if (!existsSync(coreSessionsDist)) {
  fail(`core sessions dist not found: ${coreSessionsDist}`);
}
const sessionsDist = readFileSync(coreSessionsDist, 'utf-8');
if (!sessionsDist.includes('CLEO_AGENT_ROLE') || !sessionsDist.includes('lead')) {
  fail('Lead role check not found in core/dist/sessions/index.js');
}
if (!sessionsDist.includes('LeadBypassDetectedError')) {
  fail('LeadBypassDetectedError throw not found in core/dist/sessions/index.js');
}
if (!sessionsDist.includes('delegate_task') || !sessionsDist.includes('delegateCount')) {
  fail('delegate_task_count check not found in core/dist/sessions/index.js');
}
pass('Hard gate: CLEO_AGENT_ROLE=lead + delegate check in core/dist/sessions/index.js');

// 4. Check override path in sessions dist
if (!sessionsDist.includes('CLEO_OWNER_OVERRIDE')) {
  fail('CLEO_OWNER_OVERRIDE override path not found in sessions dist');
}
if (!sessionsDist.includes('force-bypass.jsonl')) {
  fail('force-bypass.jsonl audit recording not found in sessions dist');
}
pass('Override path with force-bypass.jsonl recording present');

// 5. Check error code name
if (!contractsDist.includes('E_LEAD_BYPASS_DETECTED')) {
  fail('code E_LEAD_BYPASS_DETECTED not found in errors dist');
}
pass('code = E_LEAD_BYPASS_DETECTED');

console.log('\nAll T9230 acceptance checks passed.');
process.exit(0);
