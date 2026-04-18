/**
 * Post-build assertion: every bin target declared in package.json MUST have
 * `#!/usr/bin/env node` as its first line and MUST be owner-executable.
 *
 * Exits non-zero (failing the build) if any bin file is missing its shebang
 * or lacks the executable bit. Also applies `chmod +x` so the assertion is
 * idempotent on platforms where tsc does not set execute permissions.
 *
 * Run automatically via the `postbuild` npm lifecycle hook.
 */

import { readFileSync, chmodSync, statSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..");
const SHEBANG = "#!/usr/bin/env node";

/** @type {{ bin?: Record<string, string> }} */
const pkg = JSON.parse(readFileSync(resolve(PKG_ROOT, "package.json"), "utf-8"));

const binEntries = Object.entries(pkg.bin ?? {});

if (binEntries.length === 0) {
  console.log("assert-shebang: no bin targets declared — nothing to check.");
  process.exit(0);
}

let failed = false;

for (const [name, relPath] of binEntries) {
  const absPath = resolve(PKG_ROOT, relPath);

  if (!existsSync(absPath)) {
    console.error(`assert-shebang: MISSING bin target '${name}' → ${absPath}`);
    failed = true;
    continue;
  }

  const content = readFileSync(absPath, "utf-8");
  const firstLine = content.split("\n")[0];

  if (firstLine !== SHEBANG) {
    console.error(
      `assert-shebang: FAIL '${name}' (${relPath}) — first line is: ${JSON.stringify(firstLine)}\n` +
        `  Expected: ${JSON.stringify(SHEBANG)}`
    );
    failed = true;
  } else {
    // Ensure owner-executable bit is set (0o100 = owner execute)
    const stat = statSync(absPath);
    if ((stat.mode & 0o100) === 0) {
      chmodSync(absPath, stat.mode | 0o111);
      console.log(`assert-shebang: chmod +x applied to '${name}' (${relPath})`);
    }
    console.log(`assert-shebang: OK '${name}' (${relPath})`);
  }
}

if (failed) {
  process.exit(1);
}
