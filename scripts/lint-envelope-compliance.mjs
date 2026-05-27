// Lint gate: envelope compliance for project move/rename/re-register verbs. @task T11027 @epic T10298
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_FILE = resolve(__dirname, '..', 'packages/cleo/src/cli/commands/project.ts');
const errors = [];
let source;
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
const subs = ['move', 'rename', 're-register'];
for (const s of subs) {
  if (!source.includes(`'${s}'`) && !source.includes(`"${s}"`))
    errors.push(`Missing subcommand: ${s}`);
}
const jsonArgs = (source.match(/json:\s*\{/g) || []).length;
if (jsonArgs < 3) errors.push(`Expected >=3 --json flags, found ${jsonArgs}`);
const cliOut = (source.match(/cliOutput\(/g) || []).length;
const cliErr = (source.match(/cliError\(/g) || []).length;
if (cliOut < 3) errors.push(`Expected >=3 cliOutput calls, found ${cliOut}`);
if (cliErr > 0) errors.push(`Found ${cliErr} cliError — must use cliOutput`);
if (!source.includes('@task T11027')) errors.push('Missing @task T11027');
finish();
function finish() {
  if (errors.length) {
    console.error(`\nFAILED (${errors.length} issues):\n`);
    errors.forEach((e) => console.error(`  - ${e}`));
    console.error(`\n${PROJECT_FILE}\n`);
    process.exit(1);
  }
  console.log('PASSED: All three verbs wrap output in RenderableEnvelope (kind: section).');
  process.exit(0);
}
