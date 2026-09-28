// Lint gate: envelope compliance for the `cleo project` verbs. @task T11027 @task T12553 @epic T10298
//
// T12553 reversed this gate's failure rule. It used to REQUIRE errors to go
// through `cliOutput` (a success section) and forbid `cliError` — which is how
// `project move` came to print `{"success":true,…"Error: E_MOVE_FAILED"}` and
// then exit 1. The rule now:
//   - success output goes through `cliOutput` (a RenderableEnvelope section for
//     humans, or structured data);
//   - every failure goes through `cliError` (a `success:false` envelope), via
//     the file's `emitEngineFailure` helper, never a success section;
//   - no `process.exit(` — the exit code is set from the engine's error class.
//
// Usage: node scripts/lint-envelope-compliance.mjs [--file <path>]
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fileArg = process.argv.indexOf('--file');
const PROJECT_FILE =
  fileArg !== -1 && process.argv[fileArg + 1]
    ? resolve(process.argv[fileArg + 1])
    : resolve(__dirname, '..', 'packages/cleo/src/cli/commands/project.ts');
const errors = [];
let source = '';
try {
  source = readFileSync(PROJECT_FILE, 'utf-8');
} catch {
  errors.push(`File not found: ${PROJECT_FILE}`);
  finish();
}
if (!source.includes("from '@cleocode/contracts'"))
  errors.push('Missing import from @cleocode/contracts');
if (!source.includes('RenderableEnvelope')) errors.push('Missing RenderableEnvelope type');
if (!source.includes("kind: 'section'")) errors.push('Missing kind: section');
for (const s of ['move', 'reroot', 'rename', 're-register']) {
  if (!source.includes(`'${s}'`) && !source.includes(`"${s}"`))
    errors.push(`Missing subcommand: ${s}`);
}
const jsonArgs = (source.match(/json:\s*\{/g) || []).length;
if (jsonArgs < 4) errors.push(`Expected >=4 --json flags, found ${jsonArgs}`);
if ((source.match(/cliOutput\(/g) || []).length < 3)
  errors.push('Expected >=3 cliOutput calls for success output');

// Failure paths: a success-shaped error section is the T12553 defect.
if (/formatErrorSection|header:\s*`Error:/.test(source))
  errors.push(
    'Failure rendered as a success section (formatErrorSection / "Error:" header) — use cliError',
  );
if ((source.match(/cliError\(/g) || []).length === 0)
  errors.push('No cliError call — failures must emit a success:false envelope');
const exits = (source.match(/process\.exit\(/g) || []).length;
if (exits > 0)
  errors.push(`Found ${exits} process.exit( — set process.exitCode from the error class instead`);
const errorRefs = (source.match(/\bresult\.error\b/g) || []).length;
const routed = (source.match(/emitEngineFailure\(result\.error\b/g) || []).length;
if (errorRefs !== routed)
  errors.push(
    `${errorRefs - routed} result.error use(s) not routed through emitEngineFailure(result.error, …)`,
  );
if (!source.includes('@task T11027')) errors.push('Missing @task T11027');
finish();

function finish() {
  if (errors.length) {
    console.error(`\nFAILED (${errors.length} issues):\n`);
    for (const e of errors) console.error(`  - ${e}`);
    console.error(`\n${PROJECT_FILE}\n`);
    process.exit(1);
  }
  console.log(
    'PASSED: project verbs emit success via cliOutput and every failure via cliError (success:false).',
  );
  process.exit(0);
}
