/** Independent-process public task creation regression for T12198. */
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { cleoWorkspaceSubpathAliases } from '../../../../../vitest-workspace-resolver.js';

const run = promisify(execFile);
const repository = fileURLToPath(new URL('../../../../../', import.meta.url));

it('persists public creation from independent competing writer processes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cleo-process-durability-'));
  const bundle = join(root, 'writer.mjs');
  const sourceResolver = cleoWorkspaceSubpathAliases()[0]!;
  const env = {
    PATH: process.env.PATH,
    HOME: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'),
    CLEO_HOME: join(root, 'cleo'),
    NEXUS_HOME: join(root, 'nexus'),
    CLEO_DIR: '.cleo',
    NODE_OPTIONS: '--max-old-space-size=384',
  };
  const execute = (project: string, title: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--experimental-import-meta-resolve', bundle, project, title],
        {
          cwd: project,
          env,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      let stderr = '';
      const stop = () => {
        if (!child.pid) return;
        if (process.platform === 'win32') child.kill('SIGKILL');
        else {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH'))
              reject(error);
          }
        }
      };
      const deadline = setTimeout(stop, 30_000);
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.length > 1024 * 1024) stop();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        if (stderr.length > 1024 * 1024) stop();
      });
      child.once('error', (error) => {
        clearTimeout(deadline);
        stop();
        reject(error);
      });
      // Reap descendants even if a successful writer exits without waiting for one.
      child.once('exit', stop);
      child.once('close', (code) => {
        clearTimeout(deadline);
        if (code === 0) resolve(stdout);
        else reject(new Error(`Writer ${title} exited ${code}: ${stderr}`));
      });
    });
  try {
    for (const directory of [
      env.HOME,
      env.XDG_CONFIG_HOME,
      env.XDG_DATA_HOME,
      env.XDG_CACHE_HOME,
      env.CLEO_HOME,
      env.NEXUS_HOME,
    ]) {
      await mkdir(directory, { recursive: true });
    }
    await build({
      stdin: {
        contents: `
          import { createTask } from './packages/core/src/store/tasks-sqlite.ts';
          import { addTask } from './packages/core/src/tasks/add.ts';
          import { awaitBackgroundOps } from './packages/core/src/store/background-ops.ts';
          import { closeDb } from './packages/core/src/store/sqlite.ts';
          const [project, title] = process.argv.slice(2);
          if (title === '--seed') {
            await createTask({ id: 'T001', title: 'Parent', description: 'Seeded parent', status: 'pending', priority: 'medium', type: 'epic', createdAt: new Date().toISOString(), acceptance: ['Parent criterion'] }, project);
          } else {
            const result = await addTask({title, description: 'Process creation '+title, type: 'task', parentId: 'T001', acceptance: [title+' criterion'], depends: ['T001'], forceDuplicate: true}, project);
            process.stdout.write(result.task.id+'\\t'+title+'\\n');
          }
          await awaitBackgroundOps();
          closeDb();
        `,
        resolveDir: repository,
        sourcefile: 'task-process-durability-driver.ts',
        loader: 'ts',
      },
      outfile: bundle,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      logLevel: 'silent',
      plugins: [
        {
          name: 'workspace-source-fixture',
          setup(builder) {
            builder.onResolve({ filter: /^@cleocode\// }, (args) => {
              const mapped = sourceResolver.customResolver(args.path);
              const bare = join(
                repository,
                'packages',
                args.path.slice('@cleocode/'.length),
                'src/index.ts',
              );
              const path = mapped ?? (existsSync(bare) ? bare : undefined);
              if (path) return { path };
            });
            builder.onResolve({ filter: /^[^./]/ }, async (args) => {
              if (args.pluginData === true) return;
              if (args.path.startsWith('node:')) return { path: args.path, external: true };
              const resolved = await builder.resolve(args.path, {
                kind: args.kind,
                resolveDir: args.resolveDir,
                pluginData: true,
              });
              return { ...resolved, external: true };
            });
            builder.onLoad({ filter: /\.ts$/ }, async (args) => ({
              contents: (await readFile(args.path, 'utf8')).replaceAll(
                'import.meta.url',
                JSON.stringify(pathToFileURL(args.path).href),
              ),
              loader: 'ts',
            }));
          },
        },
      ],
    });
    const sourceHash = createHash('sha256')
      .update(await readFile(bundle))
      .digest('hex');
    const projects = [join(root, 'a'), join(root, 'b')];
    for (const project of projects) {
      await mkdir(join(project, '.cleo'), { recursive: true });
      await mkdir(join(project, '.git'));
      await writeFile(
        join(project, '.cleo/config.json'),
        JSON.stringify({
          enforcement: { session: { requiredForMutate: false }, acceptance: { mode: 'off' } },
          lifecycle: { mode: 'off' },
          verification: { enabled: false },
        }),
      );
      await execute(project, '--seed');
    }
    // Four writers total: two per project. Settle every bounded child before cleanup.
    const outcomes = await Promise.allSettled(
      Array.from({ length: 4 }, (_, index) => execute(projects[index % 2]!, `Writer ${index}`)),
    );
    expect(
      outcomes.filter((outcome) => outcome.status === 'rejected'),
      `source bundle ${sourceHash}`,
    ).toEqual([]);
    for (let projectIndex = 0; projectIndex < projects.length; projectIndex++) {
      const project = projects[projectIndex]!;
      const { stdout } = await run(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
        import { DatabaseSync } from 'node:sqlite';
        const db = new DatabaseSync(process.argv[1], {readOnly: true});
        const rows = db.prepare("SELECT t.id, t.title, t.parent_id, t.acceptance_json, ac.text, d.depends_on FROM tasks_tasks t JOIN tasks_task_acceptance_criteria ac ON ac.task_id = t.id JOIN tasks_task_dependencies d ON d.task_id = t.id WHERE t.parent_id = 'T001' ORDER BY t.title").all();
        process.stdout.write(JSON.stringify(rows)); db.close();
      `,
          join(project, '.cleo/cleo.db'),
        ],
        { env, timeout: 10_000, killSignal: 'SIGKILL' },
      );
      const indices = [projectIndex, projectIndex + 2];
      const ids = indices.map((index) => {
        const outcome = outcomes[index]!;
        if (outcome.status !== 'fulfilled') throw outcome.reason;
        const match = /^(T[0-9]+)\tWriter [0-9]+\n$/.exec(outcome.value);
        expect(match, `source bundle ${sourceHash}`).not.toBeNull();
        return match![1]!;
      });
      expect(new Set(ids).size).toBe(2);
      expect(stdout).toBe(
        JSON.stringify(
          indices.map((index, offset) => ({
            id: ids[offset],
            title: `Writer ${index}`,
            parent_id: 'T001',
            acceptance_json: JSON.stringify([`Writer ${index} criterion`]),
            text: `Writer ${index} criterion`,
            depends_on: 'T001',
          })),
        ),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
