/**
 * CLI doctor command - system diagnostics.
 * @task T4454
 */

import { Command } from 'commander';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { getAccessor } from '../../store/data-accessor.js';
import { getTodoPath, getConfigPath, getArchivePath, getLogPath, getCleoHome, getCleoDirAbsolute, getProjectRoot } from '../../core/paths.js';
import { stat, access, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';


const execAsync = promisify(execFile);

interface DiagnosticCheck {
  check: string;
  status: 'ok' | 'error' | 'warning';
  message: string;
  details?: Record<string, unknown>;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    const st = await stat(path);
    return st.size;
  } catch {
    return -1;
  }
}

async function commandExists(cmd: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync('which', [cmd]);
    return stdout.trim();
  } catch {
    return null;
  }
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Run system diagnostics and health checks')
    .action(async () => {
      try {
        const checks: DiagnosticCheck[] = [];

        // 1. Check dependencies
        const jqPath = await commandExists('jq');
        checks.push({
          check: 'jq_installed',
          status: jqPath ? 'ok' : 'error',
          message: jqPath ? `jq found: ${jqPath}` : 'jq not found. Install: https://jqlang.github.io/jq/download/',
        });

        const gitPath = await commandExists('git');
        checks.push({
          check: 'git_installed',
          status: gitPath ? 'ok' : 'warning',
          message: gitPath ? `git found: ${gitPath}` : 'git not found (optional)',
        });

        // 2. Check CLEO directories
        const cleoHome = getCleoHome();
        const cleoDir = getCleoDirAbsolute();
        const homeExists = await fileExists(cleoHome);
        checks.push({
          check: 'cleo_home',
          status: homeExists ? 'ok' : 'warning',
          message: homeExists ? `CLEO home: ${cleoHome}` : `CLEO home not found: ${cleoHome}`,
        });

        const dirExists = await fileExists(cleoDir);
        checks.push({
          check: 'project_dir',
          status: dirExists ? 'ok' : 'error',
          message: dirExists ? `Project dir: ${cleoDir}` : `Project dir not found: ${cleoDir}. Run: cleo init`,
        });

        // 3. Check data files
        const todoPath = getTodoPath();
        const todoExists = await fileExists(todoPath);
        const todoSize = await fileSize(todoPath);
        checks.push({
          check: 'todo_file',
          status: todoExists ? 'ok' : 'error',
          message: todoExists
            ? `todo.json: ${todoSize} bytes`
            : `todo.json not found: ${todoPath}`,
        });

        if (todoExists) {
          try {
            const accessor = await getAccessor();
            const data = await accessor.loadTodoFile();
            const taskCount = data.tasks?.length ?? 0;
            const schemaVersion = data._meta?.schemaVersion ?? 'unknown';
            checks.push({
              check: 'todo_data',
              status: 'ok',
              message: `${taskCount} tasks, schema v${schemaVersion}`,
              details: { taskCount, schemaVersion },
            });
          } catch {
            checks.push({
              check: 'todo_data',
              status: 'error',
              message: 'Failed to parse todo.json',
            });
          }
        }

        const configPath = getConfigPath();
        const configExists = await fileExists(configPath);
        checks.push({
          check: 'config_file',
          status: configExists ? 'ok' : 'warning',
          message: configExists ? 'config.json present' : 'config.json not found (using defaults)',
        });

        const archivePath = getArchivePath();
        const archiveExists = await fileExists(archivePath);
        checks.push({
          check: 'archive_file',
          status: 'ok',
          message: archiveExists ? 'archive file present' : 'no archive file (normal for new projects)',
        });

        const logPath = getLogPath();
        const logExists = await fileExists(logPath);
        checks.push({
          check: 'log_file',
          status: logExists ? 'ok' : 'warning',
          message: logExists ? 'log file present' : 'log file not found',
        });

        // 4. Check root .gitignore for .cleo/ blocking
        const projRoot = getProjectRoot();
        const rootGitignorePath = join(projRoot, '.gitignore');
        if (await fileExists(rootGitignorePath)) {
          try {
            const gitignoreContent = await readFile(rootGitignorePath, 'utf-8');
            const blockingLines = gitignoreContent.split('\n').filter(line => {
              const trimmed = line.trim();
              if (trimmed.startsWith('#') || trimmed === '') return false;
              return /^\/?\.cleo\/?(\*)?$/.test(trimmed);
            });
            checks.push({
              check: 'root_gitignore',
              status: blockingLines.length > 0 ? 'warning' : 'ok',
              message: blockingLines.length > 0
                ? `.cleo/ is ignored in root .gitignore. Run 'cleo init' to fix.`
                : 'Root .gitignore does not block .cleo/',
              ...(blockingLines.length > 0 ? { details: { blockingLines } } : {}),
            });
          } catch {
            // Ignore read errors for gitignore check
          }
        }

        // 5. Environment
        checks.push({
          check: 'node_version',
          status: 'ok',
          message: `Node.js ${process.version}`,
        });

        checks.push({
          check: 'platform',
          status: 'ok',
          message: `${process.platform} ${process.arch}`,
        });

        // Summary
        const errorCount = checks.filter((c) => c.status === 'error').length;
        const warningCount = checks.filter((c) => c.status === 'warning').length;
        const healthy = errorCount === 0;

        console.log(formatSuccess({
          healthy,
          errors: errorCount,
          warnings: warningCount,
          checks,
        }));

        if (!healthy) {
          process.exit(ExitCode.VALIDATION_ERROR);
        }
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
