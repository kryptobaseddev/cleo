/**
 * The release candidate gate in release.yml (T13181).
 *
 * A stable tag publishes `<version>-rc.<run number>` to `canary` through OIDC,
 * proves it installable from npm, soaks it in a sandbox, and only then
 * publishes `<version>` to `latest`. The Publish step's shell is run here for
 * real (`bash -eo pipefail`, as GitHub Actions runs it) with fake `pnpm`,
 * `npm`, version sync, post-deploy check and soak, so the ORDER and the
 * blocking are tested, not just described. Each "blocks" case is paired with
 * the passing case it differs from.
 *
 * The workflow guards hold the owner's decision: no npm token, no approval
 * environment, no dist-tag move anywhere.
 *
 * @task T13181
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOWS = path.join(REPO_ROOT, '.github/workflows');
const releaseYaml = parseYaml(readFileSync(path.join(WORKFLOWS, 'release.yml'), 'utf8'));
const publishStep = releaseYaml.jobs.publish.steps.find(
  (s) => s.name === 'Publish packages to npm',
);
const PACKAGES = [...publishStep.run.matchAll(/^\s*publish_pkg ([a-z0-9-]+)\s*$/gm)].map(
  (m) => m[1],
);
const VERSION = '2026.10.5';

/**
 * GitHub Actions runs steps with bash 5; macOS ships bash 3.2, which lacks
 * `mapfile`. A local run gets a minimal `mapfile -t` so the real step text still
 * runs unmodified; CI's bash never defines it.
 */
const BASH3_SHIM = `if ((BASH_VERSINFO[0] < 4)); then mapfile() { [[ "$1" == -t ]] && shift; local __n="$1" __l; eval "$__n=()"; while IFS= read -r __l; do eval "$__n+=(\\"\\$__l\\")"; done; }; fi\n`;
const RC = `${VERSION}-rc.77`;

let dir;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'rc-gate-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Run the Publish step's shell against fakes.
 *
 * @param {object} opts
 * @param {string} opts.rc - RC_VERSION ('' for a prerelease).
 * @param {string} [opts.tag] - TAG.
 * @param {number} [opts.payloadExit] - Exit code of the post-deploy check.
 * @param {number} [opts.soakExit] - Exit code of the soak.
 * @param {string[]} [opts.published] - `pkg@version` already on npm.
 * @returns {{ status: number, log: string[] }}
 */
function runPublish({ rc, tag = 'latest', payloadExit = 0, soakExit = 0, published = [] }) {
  const log = path.join(dir, 'log');
  writeFileSync(log, '');
  mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  copyFileSync(
    path.join(REPO_ROOT, 'scripts/release-publish-waves.sh'),
    path.join(dir, 'scripts/release-publish-waves.sh'),
  );
  const script = (name, body) => {
    const p = path.join(dir, 'scripts', name);
    writeFileSync(p, body);
    chmodSync(p, 0o755);
  };
  script(
    'release-sync-versions.sh',
    `#!/usr/bin/env bash\necho "sync $1" >> ${JSON.stringify(log)}\n`,
  );
  script(
    'execute-payload.mjs',
    `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(log)}, 'payload ' + process.argv.slice(2).join(' ') + '\\n');\nprocess.exit(${payloadExit});\n`,
  );
  script(
    'release-canary-soak.mjs',
    `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(log)}, 'soak ' + process.argv.slice(2).join(' ') + '\\n');\nprocess.exit(${soakExit});\n`,
  );
  for (const pkg of PACKAGES)
    mkdirSync(path.join(dir, 'packages', pkg, 'dist'), { recursive: true });
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  const fake = (name, body) => {
    const p = path.join(bin, name);
    writeFileSync(p, body);
    chmodSync(p, 0o755);
  };
  // pnpm publish: record the package directory and the arguments.
  fake(
    'pnpm',
    `#!/usr/bin/env bash\necho "publish $(basename "$PWD") $*" >> ${JSON.stringify(log)}\n`,
  );
  // npm view @cleocode/<pkg>@<v> version: print <v> only when it is "published".
  fake(
    'npm',
    `#!/usr/bin/env bash\nspec="\${2#@cleocode/}"\nfor p in ${published.map((p) => JSON.stringify(p)).join(' ')}; do [[ "$p" == "$spec" ]] && { echo "\${spec##*@}"; exit 0; }; done\nexit 1\n`,
  );
  const summary = path.join(dir, 'summary.md');
  const r = spawnSync('bash', ['-eo', 'pipefail', '-c', BASH3_SHIM + publishStep.run], {
    cwd: dir,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      VERSION,
      TAG: tag,
      RC_VERSION: rc,
      GITHUB_STEP_SUMMARY: summary,
    },
    encoding: 'utf8',
  });
  return {
    status: r.status ?? -1,
    log: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean),
  };
}

const publishes = (log, tag) =>
  log.filter((l) => l.startsWith('publish ') && l.includes(`--tag ${tag} `));

describe('the Publish step runs the release candidate gate (T13181)', () => {
  it('publishes the candidate to canary, checks and soaks it, then publishes the release to latest', () => {
    const { status, log } = runPublish({ rc: RC });
    expect(status, log.join('\n')).toBe(0);
    expect(PACKAGES.length).toBe(18);
    expect(publishes(log, 'canary')).toHaveLength(18);
    expect(publishes(log, 'latest')).toHaveLength(18);
    const at = (pred) => log.findIndex(pred);
    const order = [
      at((l) => l === `sync ${RC}`),
      at((l) => l.includes('--tag canary ')),
      at((l) => l === `payload --version ${RC} --dist-tag canary --output-dir /tmp/rc-postdeploy`),
      at((l) => l.startsWith(`soak --version ${RC}`)),
      at((l) => l === `sync ${VERSION}`),
      at((l) => l.includes('--tag latest ')),
    ];
    expect(
      order.every((i) => i >= 0),
      log.join('\n'),
    ).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Every phase publishes through OIDC provenance; no token flag anywhere.
    expect(
      log.filter((l) => l.startsWith('publish ')).every((l) => l.includes('--provenance')),
    ).toBe(true);
  });

  it('a candidate that does not install from npm never reaches latest', () => {
    const { status, log } = runPublish({ rc: RC, payloadExit: 1 });
    expect(status).not.toBe(0);
    expect(publishes(log, 'canary')).toHaveLength(18);
    expect(publishes(log, 'latest')).toHaveLength(0);
    expect(log.some((l) => l.startsWith('soak '))).toBe(false);
  });

  it('a candidate that fails the soak never reaches latest', () => {
    const { status, log } = runPublish({ rc: RC, soakExit: 1 });
    expect(status).not.toBe(0);
    expect(publishes(log, 'latest')).toHaveLength(0);
    expect(log).not.toContain(`sync ${VERSION}`);
  });

  it('a re-run after the release published skips the candidate (and every publish)', () => {
    const { status, log } = runPublish({
      rc: RC,
      published: PACKAGES.map((p) => `${p}@${VERSION}`),
    });
    expect(status, log.join('\n')).toBe(0);
    expect(
      log.filter(
        (l) => l.startsWith('publish ') || l.startsWith('payload ') || l.startsWith('soak '),
      ),
    ).toEqual([]);
  });

  it('a re-run with the candidate already on npm skips its publishes but still gates', () => {
    const { status, log } = runPublish({ rc: RC, published: PACKAGES.map((p) => `${p}@${RC}`) });
    expect(status, log.join('\n')).toBe(0);
    expect(publishes(log, 'canary')).toHaveLength(0);
    expect(log.some((l) => l.startsWith('payload '))).toBe(true);
    expect(publishes(log, 'latest')).toHaveLength(18);
  });

  it('a prerelease (no candidate) publishes straight to its own tag', () => {
    const { status, log } = runPublish({ rc: '', tag: 'beta' });
    expect(status, log.join('\n')).toBe(0);
    expect(publishes(log, 'beta')).toHaveLength(18);
    expect(publishes(log, 'canary')).toHaveLength(0);
    expect(log.some((l) => l.startsWith('payload ') || l.startsWith('soak '))).toBe(false);
  });
});

describe('the version step derives the tag and the candidate', () => {
  const step = releaseYaml.jobs['build-verify'].steps.find((s) => s.id === 'version');
  const run = (version) => {
    const out = path.join(dir, `out-${version}`);
    execFileSync('bash', ['-eo', 'pipefail', '-c', step.run], {
      env: { PATH: process.env.PATH, INPUT_VERSION: version, RUN_NUMBER: '77', GITHUB_OUTPUT: out },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const text = readFileSync(out, 'utf8');
    const get = (k) => new RegExp(`^${k}=(.*)$`, 'm').exec(text)?.[1];
    return { tag: get('dist_tag'), rc: get('rc_version') };
  };

  it('a stable version goes to latest behind the candidate <version>-rc.<run number>', () => {
    expect(run(VERSION)).toEqual({ tag: 'latest', rc: RC });
  });

  it('prereleases keep their own tags and have no candidate', () => {
    expect(run(`${VERSION}-beta.1`)).toEqual({ tag: 'beta', rc: '' });
    expect(run(`${VERSION}-alpha.1`)).toEqual({ tag: 'dev', rc: '' });
  });
});

describe('release-sync-versions.sh', () => {
  it('sets every listed manifest that exists, root included, and refuses a non-CalVer version', () => {
    for (const p of ['packages/core', 'packages/cleo']) {
      mkdirSync(path.join(dir, p), { recursive: true });
      writeFileSync(path.join(dir, p, 'package.json'), '{"name":"x","version":"0.0.0"}');
    }
    writeFileSync(path.join(dir, 'package.json'), '{"name":"root","version":"0.0.0"}');
    const sync = path.join(REPO_ROOT, 'scripts/release-sync-versions.sh');
    execFileSync('bash', [sync, RC], { cwd: dir, stdio: 'ignore' });
    for (const p of ['package.json', 'packages/core/package.json', 'packages/cleo/package.json'])
      expect(JSON.parse(readFileSync(path.join(dir, p), 'utf8')).version).toBe(RC);
    expect(spawnSync('bash', [sync, '2026.10.5; rm -rf /'], { cwd: dir }).status).not.toBe(0);
  });
});

describe('workflow guards (owner decision: OIDC only)', () => {
  const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));

  it('no workflow references an npm token, an approval environment for npm, or moves a dist-tag', () => {
    const offenders = files.filter((f) => {
      // Parsed, so comments that explain the absence of a token do not count.
      const code = JSON.stringify(parseYaml(readFileSync(path.join(WORKFLOWS, f), 'utf8')));
      return /NPM_TOKEN|NODE_AUTH_TOKEN|npm-promote|npm dist-tag (?:add|rm|set)/.test(code);
    });
    expect(offenders).toEqual([]);
  });

  it('the token-based promote workflow is gone', () => {
    expect(existsSync(path.join(WORKFLOWS, 'release-promote.yml'))).toBe(false);
  });

  it('Build & Verify syncs versions through the same script Publish uses', () => {
    const sync = releaseYaml.jobs['build-verify'].steps.find(
      (s) => s.name === 'Sync package versions from tag',
    );
    expect(sync.run).toContain('scripts/release-sync-versions.sh');
    expect(publishStep.run).toContain('scripts/release-sync-versions.sh "$RC_VERSION"');
  });
});
