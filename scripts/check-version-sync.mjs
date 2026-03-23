import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const PACKAGES_DIR = path.join(ROOT, 'packages');

function parseArgs(argv) {
  const result = { expect: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--expect') {
      result.expect = argv[i + 1] ?? null;
      i += 1;
    }
  }
  return result;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function getWorkspacePackageJsonPaths() {
  const entries = await readdir(PACKAGES_DIR, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    paths.push(path.join(PACKAGES_DIR, entry.name, 'package.json'));
  }
  return paths;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rootPackagePath = path.join(ROOT, 'package.json');
  const rootPackage = await readJson(rootPackagePath);
  const rootVersion = rootPackage.version;

  if (!rootVersion || typeof rootVersion !== 'string') {
    console.error('ERROR: Root package.json is missing a valid version field.');
    process.exit(1);
  }

  if (args.expect && rootVersion !== args.expect) {
    console.error(`ERROR: Root version mismatch. expected=${args.expect} actual=${rootVersion}`);
    process.exit(1);
  }

  const workspacePackagePaths = await getWorkspacePackageJsonPaths();
  const mismatches = [];

  for (const packagePath of workspacePackagePaths) {
    const pkg = await readJson(packagePath);
    if (!pkg.name) continue;
    const pkgVersion = pkg.version;
    if (pkgVersion !== rootVersion) {
      mismatches.push({
        name: pkg.name,
        version: pkgVersion,
        expected: rootVersion,
        file: path.relative(ROOT, packagePath),
      });
    }
  }

  if (mismatches.length > 0) {
    console.error('ERROR: Workspace package version drift detected.');
    for (const mismatch of mismatches) {
      console.error(
        ` - ${mismatch.name}: ${mismatch.version} (expected ${mismatch.expected}) in ${mismatch.file}`,
      );
    }
    process.exit(1);
  }

  console.log(`OK: version sync verified (${rootVersion}) across root + workspace packages.`);
}

await main();
