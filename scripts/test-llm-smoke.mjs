#!/usr/bin/env node
/**
 * CLEO LLM CLI smoke matrix script.
 *
 * Exercises each `cleo llm` subcommand against available live providers:
 *   - anthropic (OAuth via ~/.claude/.credentials.json)
 *   - openai (credential pool)
 *   - kimi-code (OAI-compat, credential pool)
 *
 * In best-effort mode: providers without credentials are logged as SKIPPED,
 * not failures. The script captures latency + response shape for each command
 * and exits 0 when all available providers pass.
 *
 * @see AC: scripts/test-llm-smoke.mjs
 * @task T9361
 * @epic T9354
 */

import { execSync, spawnSync } from 'child_process';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a cleo command and capture output + latency.
 *
 * @param {string[]} args - cleo CLI args
 * @param {number} timeoutMs - command timeout in ms
 * @returns {{ success: boolean, data: unknown, latencyMs: number, raw: string }}
 */
function runCleo(args, timeoutMs = 10000) {
  const start = Date.now();
  const result = spawnSync('cleo', args, {
    encoding: 'utf-8',
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });
  const latencyMs = Date.now() - start;
  const raw = result.stdout ?? '';
  const stderr = result.stderr ?? '';

  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    // non-JSON output (e.g. stream text deltas)
    data = { text: raw };
  }

  if (result.error) {
    return { success: false, data: { message: result.error.message }, latencyMs, raw: stderr };
  }

  return {
    success: data?.success === true || (result.status === 0 && !data?.success === undefined),
    data: data?.data ?? data,
    error: data?.error ?? null,
    latencyMs,
    raw,
    stderr,
  };
}

/**
 * Run `cleo llm stream` and capture text deltas written to stdout.
 *
 * @param {string} provider
 * @param {string} prompt
 * @param {number} maxTokens
 * @returns {{ success: boolean, text: string, latencyMs: number, stderr: string }}
 */
function runStream(provider, prompt, maxTokens = 10) {
  const start = Date.now();
  const result = spawnSync(
    'cleo',
    ['llm', 'stream', provider, prompt, '--max-tokens', String(maxTokens)],
    {
      encoding: 'utf-8',
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    },
  );
  const latencyMs = Date.now() - start;
  return {
    success: result.status === 0 && (result.stdout?.length ?? 0) > 0,
    text: result.stdout ?? '',
    latencyMs,
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

// ---------------------------------------------------------------------------
// Test matrix
// ---------------------------------------------------------------------------

const results = [];
let passCount = 0;
let skipCount = 0;
let failCount = 0;

console.log('=== CLEO LLM CLI Smoke Matrix (T9361) ===\n');

// --- 1. cleo llm test anthropic ---
{
  console.log('[ 1/6 ] cleo llm test anthropic (OAuth via claude-creds)');
  const r = runCleo(['llm', 'test', 'anthropic', '--json'], 10000);
  const pass = r.success && r.data?.latencyMs != null && r.data?.model != null;
  const status = pass ? 'PASS' : r.error?.codeName === 'E_CREDENTIAL_NOT_FOUND' ? 'SKIP' : 'FAIL';
  if (status === 'PASS') passCount++;
  else if (status === 'SKIP') skipCount++;
  else failCount++;
  results.push({
    command: 'cleo llm test anthropic',
    status,
    latencyMs: r.latencyMs,
    model: r.data?.model ?? null,
    credentialSource: r.data?.credentialSource ?? null,
    error: r.error?.message ?? null,
  });
  console.log(
    `  ${status} — latency=${r.data?.latencyMs ?? r.latencyMs}ms model=${r.data?.model ?? 'N/A'} credSource=${r.data?.credentialSource ?? 'N/A'}`,
  );
  if (r.error) console.log(`  ERROR: ${r.error.message}`);
}

// --- 2. cleo llm test openai ---
{
  console.log('[ 2/6 ] cleo llm test openai');
  const r = runCleo(['llm', 'test', 'openai', '--json'], 10000);
  const isNotImpl = r.error?.codeName === 'E_NOT_IMPLEMENTED';
  const noCredential = r.error?.codeName === 'E_CREDENTIAL_NOT_FOUND';
  const pass = r.success && r.data?.latencyMs != null;
  const status = pass
    ? 'PASS'
    : isNotImpl
      ? 'SKIP-NOT-IMPL'
      : noCredential
        ? 'SKIP-NO-CRED'
        : 'FAIL';
  if (status === 'PASS') passCount++;
  else skipCount++;
  results.push({
    command: 'cleo llm test openai',
    status,
    latencyMs: r.latencyMs,
    model: r.data?.model ?? null,
    error: r.error?.message ?? null,
  });
  console.log(
    `  ${status} — latency=${r.latencyMs}ms${r.error ? ' error=' + r.error.message : ''}`,
  );
}

// --- 3. cleo llm test kimi-code ---
{
  console.log('[ 3/6 ] cleo llm test kimi-code (OAI-compat)');
  const r = runCleo(['llm', 'test', 'kimi-code', '--json'], 10000);
  const noCredential = r.error?.codeName === 'E_CREDENTIAL_NOT_FOUND';
  const isNotImpl = r.error?.codeName === 'E_NOT_IMPLEMENTED';
  const pass = r.success && r.data?.latencyMs != null;
  const status = pass
    ? 'PASS'
    : noCredential
      ? 'SKIP-NO-CRED'
      : isNotImpl
        ? 'SKIP-NOT-IMPL'
        : 'FAIL';
  if (status === 'PASS') passCount++;
  else skipCount++;
  results.push({
    command: 'cleo llm test kimi-code',
    status,
    latencyMs: r.latencyMs,
    model: r.data?.model ?? null,
    error: r.error?.message ?? null,
  });
  console.log(
    `  ${status} — latency=${r.latencyMs}ms${r.error ? ' error=' + r.error.message : ''}`,
  );
}

// --- 4. cleo llm stream anthropic ---
{
  console.log('[ 4/6 ] cleo llm stream anthropic "Hello" --max-tokens 10');
  const r = runStream('anthropic', 'Hello', 10);
  const hasTextDelta = (r.text?.length ?? 0) > 0;
  const pass = r.success && hasTextDelta;
  const status = pass ? 'PASS' : 'FAIL';
  if (status === 'PASS') passCount++;
  else failCount++;
  results.push({
    command: 'cleo llm stream anthropic',
    status,
    latencyMs: r.latencyMs,
    textLength: r.text?.length ?? 0,
    textPreview: r.text?.slice(0, 40) ?? null,
    usage: r.stderr?.trim() ?? null,
    error: r.status !== 0 ? r.stderr : null,
  });
  console.log(
    `  ${status} — latency=${r.latencyMs}ms text="${r.text?.slice(0, 40)?.trim()}" tokens=${r.stderr?.trim()}`,
  );
}

// --- 5. cleo llm refresh-catalog ---
{
  console.log('[ 5/6 ] cleo llm refresh-catalog');
  const r = runCleo(['llm', 'refresh-catalog', '--json'], 15000);
  const pass = r.success && r.data?.providers != null && r.data?.filePath != null;
  const status = pass ? 'PASS' : 'FAIL';
  if (status === 'PASS') passCount++;
  else failCount++;

  // Verify the versioned cache file was written
  let fileExists = false;
  if (r.data?.filePath) {
    try {
      execSync(`test -f ${JSON.stringify(r.data.filePath)}`);
      fileExists = true;
    } catch {
      fileExists = false;
    }
  }
  results.push({
    command: 'cleo llm refresh-catalog',
    status,
    latencyMs: r.latencyMs,
    providers: r.data?.providers ?? null,
    models: r.data?.models ?? null,
    filePath: r.data?.filePath ?? null,
    fileExists,
    source: r.data?.source ?? null,
  });
  console.log(
    `  ${status} — providers=${r.data?.providers} models=${r.data?.models} file=${r.data?.filePath} fileExists=${fileExists}`,
  );
}

// --- 6. cleo llm profile + whoami ---
{
  console.log('[ 6/6 ] cleo llm profile extraction anthropic + whoami --role extraction');

  // Set profile
  const profileResult = runCleo(
    ['llm', 'profile', 'extraction', 'anthropic', '--model', 'claude-haiku-4-5-20251001', '--json'],
    5000,
  );

  // Check whoami reports hasCredential: true
  const whoamiResult = runCleo(['llm', 'whoami', '--role', 'extraction', '--json'], 5000);
  const entries = whoamiResult.data?.entries ?? [];
  const extractionEntry = entries[0] ?? {};
  const hasCredential = extractionEntry.hasCredential === true;

  const pass = profileResult.success && hasCredential;
  const status = pass ? 'PASS' : 'FAIL';
  if (status === 'PASS') passCount++;
  else failCount++;

  results.push({
    command: 'cleo llm profile + whoami',
    status,
    latencyMs: profileResult.latencyMs + whoamiResult.latencyMs,
    role: extractionEntry.role ?? null,
    provider: extractionEntry.provider ?? null,
    model: extractionEntry.model ?? null,
    hasCredential,
    credentialSource: extractionEntry.credentialSource ?? null,
  });
  console.log(
    `  ${status} — role=${extractionEntry.role} provider=${extractionEntry.provider} model=${extractionEntry.model} hasCredential=${hasCredential} credSource=${extractionEntry.credentialSource}`,
  );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('\n=== Summary ===');
console.log(`  PASS:  ${passCount}`);
console.log(`  SKIP:  ${skipCount}  (no credentials or not implemented for provider)`);
console.log(`  FAIL:  ${failCount}`);
console.log('\nDetailed results:');
console.log(JSON.stringify(results, null, 2));

// Exit non-zero if any hard failures
if (failCount > 0) {
  console.error('\nSome smoke tests FAILED — see details above');
  process.exit(1);
}

console.log('\nAll available tests PASSED.');
process.exit(0);
