'use strict';
/**
 * Per-platform smoke probe for the cant-napi addon (T12382), run by
 * .github/workflows/cant-napi-build.yml on each triple's own hardware.
 *
 * usage: node cant-native-smoke.cjs <expected-backend: native|wasi> <expected-rev>
 *
 * Loads packages/cant/napi/index.cjs (the napi-rs generated loader) and fails
 * unless the EXPECTED backend served the call (so a native job cannot pass by
 * silently falling back to WASI), the binary carries the expected
 * source-revision stamp, and a real parse + validation round-trips.
 */

const { join } = require('node:path');

const [expectedBackend, expectedRev] = process.argv.slice(2);
const binding = require(join(__dirname, '..', '..', 'napi', 'index.cjs'));

/** @param {boolean} ok @param {string} message */
function check(ok, message) {
  if (!ok) {
    process.stderr.write(`cant-napi smoke FAILED: ${message}\n`);
    process.exit(1);
  }
}

const backend = binding.cantBackend();
check(backend === expectedBackend, `backend is ${backend}, expected ${expectedBackend}`);
const buildInfo = binding.cantBuildInfo();
check(
  !expectedRev || buildInfo === `cant-napi-source-rev:${expectedRev}`,
  `build stamp is ${buildInfo}, expected cant-napi-source-rev:${expectedRev}`,
);

const doc = [
  '---',
  'kind: agent',
  'version: 1',
  '---',
  '',
  'agent smoke-probe:',
  '  role: worker',
  '',
].join('\n');
const parsed = binding.cantParseDocument(doc);
check(parsed.success === true, `parse failed: ${JSON.stringify(parsed.errors)}`);
const validated = binding.cantValidateDocument(doc);
check(
  validated.diagnostics.some((d) => d.ruleId === 'TEAM-003'),
  `expected TEAM-003 (worker without parent), got ${JSON.stringify(validated.diagnostics)}`,
);
const message = binding.cantParse('/done @cleo-core T1234 #shipped');
check(message.directive === 'done', `message parse: ${JSON.stringify(message)}`);

process.stdout.write(
  `cant-napi smoke OK: ${process.platform}-${process.arch} backend=${backend} ${buildInfo}\n`,
);
