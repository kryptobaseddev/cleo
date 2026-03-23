import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const PACKAGES_DIR = path.join(ROOT, 'packages');
const CALVER_REGEX = /^\d{4}\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function usage() {
  console.error('Usage: node scripts/version-all.mjs --set <version>');
  console.error('Example: node scripts/version-all.mjs --set 2026.3.57');
}

function parseArgs(argv) {
  let setVersion = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--set') {
      setVersion = argv[i + 1] ?? null;
      i += 1;
    }
  }
  return { setVersion };
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function writeJson(filePath, data) {
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function getPackageJsonPaths() {
  const paths = [path.join(ROOT, 'package.json')];
  const entries = await readdir(PACKAGES_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    paths.push(path.join(PACKAGES_DIR, entry.name, 'package.json'));
  }
  return paths;
}

async function main() {
  const { setVersion } = parseArgs(process.argv.slice(2));
  if (!setVersion) {
    usage();
    process.exit(1);
  }
  if (!CALVER_REGEX.test(setVersion)) {
    console.error(
      `ERROR: Invalid version '${setVersion}'. Expected CalVer format YYYY.M.PATCH or YYYY.M.PATCH-suffix`,
    );
    process.exit(1);
  }

  const packageJsonPaths = await getPackageJsonPaths();
  const updated = [];

  for (const packagePath of packageJsonPaths) {
    const pkg = await readJson(packagePath);
    if (!pkg.name || typeof pkg.version !== 'string') continue;
    if (pkg.version === setVersion) continue;
    pkg.version = setVersion;
    await writeJson(packagePath, pkg);
    updated.push(path.relative(ROOT, packagePath));
  }

  if (updated.length === 0) {
    console.log(`No changes. All package versions are already ${setVersion}.`);
    return;
  }

  console.log(`Updated ${updated.length} package.json file(s) to ${setVersion}:`);
  for (const relPath of updated) {
    console.log(` - ${relPath}`);
  }
}

await main();
